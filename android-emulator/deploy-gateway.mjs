import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const BLITZ_KEY = (process.env.BLITZ_API_KEY || '').trim();
const ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();
const GATEWAY_SECRET = (process.env.EMULATOR_GATEWAY_SECRET || '').trim();
const GHCR_IMAGE = (process.env.GHCR_IMAGE || 'ghcr.io/joshbond123/vibely-android-gateway').toLowerCase();
const FORCE_REDEPLOY = String(process.env.FORCE_GATEWAY_REDEPLOY || 'false').toLowerCase() === 'true';

if (!BLITZ_KEY || !ACCESS_TOKEN || !GATEWAY_SECRET) {
  console.error('Missing BLITZ_API_KEY, EMULATOR_ACCESS_TOKEN, or EMULATOR_GATEWAY_SECRET');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createBlitzMcpClient(apiKey) {
  const hdrs = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const initResp = await fetch('https://mcp.blitz.cloud/mcp', {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gh-actions-deployer', version: '1.0' } },
    }),
  });
  const sid = initResp.headers.get('mcp-session-id');
  if (sid) hdrs['Mcp-Session-Id'] = sid;

  return async function callTool(name, args = {}) {
    const resp = await fetch('https://mcp.blitz.cloud/mcp', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 100000),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const json = await resp.json();
    const res = json.result || {};
    const texts = (res.content || []).map((c) => c.text).filter(Boolean);
    return { isError: Boolean(res.isError), texts, raw: json };
  };
}

async function isGhcrPubliclyPullable(imageRepo) {
  try {
    const repoPath = imageRepo.replace(/^ghcr\.io\//, '');
    const tokResp = await fetch(`https://ghcr.io/token?scope=repository:${repoPath}:pull`);
    if (!tokResp.ok) return false;
    const { token } = await tokResp.json();
    const manResp = await fetch(`https://ghcr.io/v2/${repoPath}/manifests/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      },
    });
    return manResp.ok;
  } catch {
    return false;
  }
}

async function checkGatewayHealth(url) {
  try {
    const r = await fetch(`${url}/api/public/health`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return false;
    const d = await r.json();
    return d?.ok === true && d?.service === 'vibely-android-remote-gateway';
  } catch {
    return false;
  }
}

function appendGithubOutput(key, val) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${val}\n`);
  }
}

async function main() {
  const mcp = await createBlitzMcpClient(BLITZ_KEY);

  // 1. Check existing apps on aivideo.blitz.cloud (strictly scoped to subLabel 'android' — never touches VIBELY on 'aivideo'!)
  const listRes = await mcp('apps_list', {});
  const apps = listRes.texts
    .map((t) => {
      try { return JSON.parse(t); } catch { return null; }
    })
    .filter(Boolean);

  let existingApp = apps.find(
    (a) => a.name === 'Android Remote Gateway' || (a.url && a.url.includes('android.aivideo.blitz.cloud')) || a.subLabel === 'android'
  );

  if (existingApp && !FORCE_REDEPLOY) {
    const appDetailsRes = await mcp('apps_get', { app: existingApp.id });
    const appDetails = JSON.parse(appDetailsRes.texts[0] || '{}');
    const url = appDetails.url || 'https://android.aivideo.blitz.cloud';
    console.log(`[deploy-gateway] Found existing Blitz app ${existingApp.id} at ${url} (status=${appDetails.status})`);
    if (appDetails.asleep) {
      await mcp('apps_resume', { app: existingApp.id });
      await sleep(12000);
    }
    if (await checkGatewayHealth(url)) {
      console.log(`[deploy-gateway] Gateway at ${url} is healthy and online!`);
      appendGithubOutput('gateway_url', url);
      appendGithubOutput('blitz_app_id', existingApp.id);
      return;
    }
  }

  // 2. Check if GHCR image is anonymously pullable; otherwise use public Node 20 Alpine carrier + volume bootstrap
  const ghcrPublic = await isGhcrPubliclyPullable(GHCR_IMAGE);
  console.log(`[deploy-gateway] GHCR image ${GHCR_IMAGE}:latest anonymous pullable = ${ghcrPublic}`);

  let appObj = existingApp;
  // Build the checked-out GitHub revision, never leave an older volume bundle active.
  let needVolumeBootstrap = true;

  if (!appObj) {
    const deployImg = ghcrPublic ? GHCR_IMAGE : 'louislam/uptime-kuma';
    const deployTag = ghcrPublic ? 'latest' : '1';
    console.log(`[deploy-gateway] Creating Blitz app on aivideo.blitz.cloud (address=android) using image ${deployImg}:${deployTag}...`);
    const depRes = await mcp('apps_deploy_image', {
      image: deployImg,
      tag: deployTag,
      address: 'android',
      name: 'Android Remote Gateway',
      port: 8080,
      autoUpdate: true,
    });
    if (depRes.isError) {
      throw new Error(`apps_deploy_image failed: ${depRes.texts.join(' ')}`);
    }
    appObj = JSON.parse(depRes.texts[0]);
  }

  const appId = appObj.id;
  const appGet = JSON.parse((await mcp('apps_get', { app: appId })).texts[0]);
  const gatewayUrl = appGet.url || 'https://android.aivideo.blitz.cloud';
  console.log(`[deploy-gateway] Provisioned Blitz app id=${appId}, url=${gatewayUrl}`);

  // 3. Configure persistent volume /app/data, port 8080, and disable Blitz HTML error gating for clean API JSON
  await mcp('apps_update', {
    app: appId,
    port: 8080,
    keepFolder: '/app/data',
    gateErrors: false,
  });

  // 4. Configure environment secrets on Blitz
  await mcp('env_set', { app: appId, name: 'PORT', value: '8080' });
  await mcp('env_set', { app: appId, name: 'DATA_DIR', value: '/app/data' });
  await mcp('env_set', { app: appId, name: 'EMULATOR_ACCESS_TOKEN', value: ACCESS_TOKEN });
  await mcp('env_set', { app: appId, name: 'EMULATOR_GATEWAY_SECRET', value: GATEWAY_SECRET });

  // 5. If GHCR defaulted package visibility to private, upload compiled gateway bundle into /app/data/gateway & activate via NODE_OPTIONS
  if (needVolumeBootstrap) {
    console.log('[deploy-gateway] Building & uploading self-contained Node.js gateway bundle to /app/data/gateway...');
    const gwDir = path.resolve(process.cwd(), 'android-remote-gateway');
    execFileSync('npm', ['ci'], { cwd: gwDir, stdio: 'inherit' });
    execFileSync('npm', ['run', 'build'], { cwd: gwDir, stdio: 'inherit' });

    // Deploy the artifact built by this GitHub Actions checkout. No Git operation
    // occurs on the hosting service. Avoid the account-wide pending-upload quota.
    const { gzipSync } = await import('node:zlib');
    const artifact = gzipSync(fs.readFileSync(path.join(gwDir, 'dist', 'server.js'))).toString('base64');
    const shellQuote = (v) => "'" + v.replace(/'/g, "'\\''") + "'";
    async function runArtifactCommand(js) {
      const r=await mcp('apps_run',{app:appId,command:'NODE_OPTIONS= node -e '+shellQuote(js),confirm:true});
      if(r.isError) throw new Error('Artifact install: '+r.texts.join(' '));
      for(const t of r.texts) { try {const j=JSON.parse(t);if(j.exitCode || j.exit_code) throw new Error('Artifact command failed');} catch(e) {if(e.message==='Artifact command failed')throw e;} }
    }
    await runArtifactCommand("require('fs').writeFileSync('/app/data/gateway-artifact.b64','')");
    for(let offset=0;offset<artifact.length;offset+=1300) {
      await runArtifactCommand("require('fs').appendFileSync('/app/data/gateway-artifact.b64','"+artifact.slice(offset,offset+1300)+"')");
      await sleep(3500); // respect host's 20 command/minute limit
    }
    const bootSource=JSON.stringify("await import('/app/data/gateway/dist/server.js');\nawait new Promise(() => {});\n");
    await runArtifactCommand(`const fs=require('fs'),z=require('zlib'),p='/app/data/gateway';fs.mkdirSync(p+'/dist',{recursive:true});fs.writeFileSync(p+'/dist/server.js.next',z.gunzipSync(Buffer.from(fs.readFileSync('/app/data/gateway-artifact.b64','utf8'),'base64')));fs.renameSync(p+'/dist/server.js.next',p+'/dist/server.js');fs.writeFileSync(p+'/package.json',JSON.stringify({type:'module'}));if(!fs.existsSync(p+'/node_modules'))fs.symlinkSync('/app/node_modules',p+'/node_modules','dir');fs.writeFileSync(p+'/boot-hijack.mjs',${bootSource});`);
    console.log('GitHub Actions artifact installed.');

    await mcp('env_set', {
      app: appId,
      name: 'NODE_OPTIONS',
      value: '--import /app/data/gateway/boot-hijack.mjs',
    });
    await mcp('apps_restart', { app: appId, confirm: true });
  }

  // 6. Wait for live /api/public/health HTTP 200 verification
  console.log(`[deploy-gateway] Waiting for ${gatewayUrl}/api/public/health to respond HTTP 200...`);
  let healthy = false;
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    if (await checkGatewayHealth(gatewayUrl)) {
      healthy = true;
      break;
    }
  }
  if (!healthy) {
    const logs = await mcp('logs_tail', { app: appId, lines: 80 });
    throw new Error(`Gateway failed health check at ${gatewayUrl}. Logs: ${logs.texts.join('\n')}`);
  }

  console.log(`[deploy-gateway] SUCCESS! Android Remote Gateway is LIVE at ${gatewayUrl}`);
  appendGithubOutput('gateway_url', gatewayUrl);
  appendGithubOutput('blitz_app_id', appId);
}

main().catch((err) => {
  console.error('[deploy-gateway] ERROR:', err);
  process.exit(1);
});
