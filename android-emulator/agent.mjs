import {startLiveDevice} from './live-device.mjs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import WebSocket from 'ws';

const execFileAsync = promisify(execFile);
let liveDevice;

const GATEWAY_URL = (process.env.EMULATOR_GATEWAY_URL || '').replace(/\/$/, '');
const GATEWAY_SECRET = (process.env.EMULATOR_GATEWAY_SECRET || '').trim();
const ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();
const BLITZ_API_KEY = (process.env.BLITZ_API_KEY || '').trim();
const BLITZ_ANDROID_APP = (process.env.BLITZ_ANDROID_APP || 'android').trim();
const GH_PAT = (process.env.GH_PAT || '').trim();
const REPO = process.env.GITHUB_REPOSITORY || 'Joshbond123/VIBELY';
const RUN_ID = process.env.GITHUB_RUN_ID || String(Date.now());
const RUN_ATTEMPT = process.env.GITHUB_RUN_ATTEMPT || '1';
const RUNNER_NAME = process.env.RUNNER_NAME || 'github-actions-ubuntu';

const ROTATION_MINUTES = Math.max(2, Number(process.env.ROTATION_MINUTES || 240));
const RAPID_TEST_CYCLES = Math.max(0, Number(process.env.RAPID_TEST_CYCLES || 0));
const SIMULATE_BOOT_FAILURE = String(process.env.SIMULATE_BOOT_FAILURE || 'false').toLowerCase() === 'true';

const SESSION_ID = process.env.GITHUB_AVD_ONLY==='true' && process.env.EMULATOR_SESSION_ID ? process.env.EMULATOR_SESSION_ID : `emu_${RUN_ID}_${crypto.randomBytes(3).toString('hex')}`;
process.env.EMULATOR_SESSION_ID = SESSION_ID;

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
const STATE_SCRIPT = path.join(SCRIPTS_DIR, 'state-manager.sh');

let wsClient = null;
let mediaWs=null,mediaTimer,mediaRetry=0,mediaNeedsKey=true;
let shouldStreamFrames = false;
let streamLoopRunning = false;
let retiring = false;
let promotedAtMs = 0;
let replacementDispatchedAt = 0;
let replacementRetries = 0;
let stateOpLock = Promise.resolve();
let reconnecting = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [${SESSION_ID}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wakeGatewayOnBlitz() {
  // Resume only an unreachable gateway: resuming an already running app can
  // restart its container and disconnect every active/standby tunnel.
  try {
    const health = await fetch(`${GATEWAY_URL}/api/public/health`, { signal: AbortSignal.timeout(8000) });
    if (health.ok) return;
  } catch {}
  if (!BLITZ_API_KEY) return;
  try {
    const hdrs = {
      Authorization: `Bearer ${BLITZ_API_KEY}`,
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
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'emu-agent', version: '1.0' } },
      }),
    });
    const sid = initResp.headers.get('mcp-session-id');
    if (sid) hdrs['Mcp-Session-Id'] = sid;
    await fetch('https://mcp.blitz.cloud/mcp', {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'apps_resume', arguments: { app: BLITZ_ANDROID_APP } },
      }),
    });
  } catch (err) {
    log(`Blitz resume note: ${err.message}`);
  }
}

async function gatewayFetch(urlPath, opts = {}, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(`${GATEWAY_URL}${urlPath}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${GATEWAY_SECRET}`,
          ...(opts.headers || {}),
        },
      });
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        log(`Gateway returned ${resp.status} on ${urlPath}; waking Blitz container...`);
        await wakeGatewayOnBlitz();
        await sleep(8000);
        continue;
      }
      return resp;
    } catch (err) {
      if (i === retries - 1) throw err;
      await wakeGatewayOnBlitz();
      await sleep(5000);
    }
  }
  throw new Error(`Gateway unreachable at ${GATEWAY_URL}${urlPath}`);
}


async function prepareDevicePermissions() {
  // Soft grants only. NEVER force-stop any user app (Gmail/VPN/TikTok) —
  // force-stop was the stuck-loop that bounced users home mid-login.
  const packages = [
    'com.google.android.gm',
    'com.android.vending',
    'com.google.android.gms',
    'com.android.chrome',
    'ch.protonvpn.android',
    'com.zhiliaoapp.musically',
    'com.ss.android.ugc.trill',
  ];
  for (const pkg of packages) {
    for (const perm of [
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
      'android.permission.FOREGROUND_SERVICE',
    ]) {
      try { await adbShell(`pm grant ${pkg} ${perm}`, 12000); } catch (_) {}
    }
    try { await adbShell(`cmd appops set ${pkg} POST_NOTIFICATION allow`, 12000); } catch (_) {}
  }
  // Only dismiss system permissioncontroller dialogs (never the app itself)
  try {
    const { stdout } = await adbShell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", 12000);
    if (/permissioncontroller|packageinstaller|PermissionController/i.test(stdout || '')) {
      log('System permission dialog focused — soft BACK once (not force-stop)');
      await adbShell('input keyevent 4', 8000).catch(() => {});
    }
  } catch (_) {}
}

async function recoverAdbConnection() {
  log('ADB recovery: full reconnect (fixes stuck screen when emulator-5554 vanishes)');
  try { await execFileAsync('adb', ['reconnect'], { timeout: 15000 }); } catch (_) {}
  try { await execFileAsync('adb', ['disconnect'], { timeout: 10000 }); } catch (_) {}
  try { await execFileAsync('adb', ['kill-server'], { timeout: 15000 }); } catch (_) {}
  await sleep(1200);
  try { await execFileAsync('adb', ['start-server'], { timeout: 20000 }); } catch (_) {}
  await sleep(1500);
  // Emulator console ports commonly used on Actions runners
  for (const endpoint of ['127.0.0.1:5555', '127.0.0.1:5557', 'emulator-5554', '127.0.0.1:5554']) {
    try { await execFileAsync('adb', ['connect', endpoint], { timeout: 8000 }); } catch (_) {}
  }
  try { await execFileAsync('adb', ['reconnect', 'offline'], { timeout: 12000 }); } catch (_) {}
  try { await execFileAsync('adb', ['wait-for-device'], { timeout: 90000 }); } catch (e) { log('wait-for-device: ' + e.message); }
  // Prefer device state; do not leave adb as root (looks rooted + can desync serial)
  try { await execFileAsync('adb', ['unroot'], { timeout: 10000 }); } catch (_) {}
  await sleep(800);
  try {
    const { stdout } = await execFileAsync('adb', ['devices', '-l'], { timeout: 10000 });
    log('ADB devices after recovery: ' + String(stdout).trim());
    const ok = /emulator-\d+\s+device|\d+\.\d+\.\d+\.\d+:\d+\s+device/.test(stdout || '');
    if (ok && liveDevice?.ensureHealthy) {
      try {
        const h = await liveDevice.ensureHealthy();
        log('Post-ADB scrcpy ensureHealthy: ' + JSON.stringify(h));
      } catch (e) { log('ensureHealthy after ADB: ' + e.message); }
    }
    // Wake display so stream is not a frozen black/last frame
    try {
      await execFileAsync('adb', ['shell', 'input keyevent 224; input keyevent 82; svc power stayon true'], { timeout: 15000 });
    } catch (_) {}
    return ok;
  } catch (e) {
    log('ADB devices failed: ' + e.message);
    return false;
  }
}

async function adbShell(cmd, timeout = 30000) {
  const { stdout, stderr } = await execFileAsync('adb', ['shell', cmd], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: stdout || '', stderr: stderr || '' };
}

/** Detect Play/DownloadManager activity. Capture uses `avd stop` and freezes installs. */
async function isGuestBusyForPersist() {
  try {
    const dl = (await adbShell('dumpsys download 2>/dev/null | head -100', 15000)).stdout || '';
    if (/Status:\s*(190|192)|STATUS_RUNNING|STATUS_PENDING/i.test(dl)) return 'download_manager';
    const act = (await adbShell('dumpsys activity activities 2>/dev/null | grep -iE "vending|PackageInstaller|Download" | head -25', 15000)).stdout || '';
    if (/DOWNLOADING|downloading|Installing|INSTALLING/i.test(act)) return 'play_or_installer_ui';
  } catch (_) {}
  return null;
}

async function tunePlayStoreForEmulator() {
  const cmds = [
    'svc power stayon true',
    'settings put global stay_on_while_plugged_in 7',
    'settings put system screen_off_timeout 2147483647',
    'settings put global package_verifier_enable 0',
    'settings put global verifier_verify_adb_installs 0',
    'cmd connectivity airplane-mode disable',
    'svc wifi enable',
    'cmd appops set com.android.vending RUN_IN_BACKGROUND allow',
    'cmd appops set com.android.vending RUN_ANY_IN_BACKGROUND allow',
    'cmd appops set com.google.android.gms RUN_IN_BACKGROUND allow',
    'cmd appops set com.google.android.gms RUN_ANY_IN_BACKGROUND allow',
    'cmd appops set com.android.providers.downloads RUN_IN_BACKGROUND allow',
    'dumpsys deviceidle whitelist +com.android.vending',
    'dumpsys deviceidle whitelist +com.google.android.gms',
    'dumpsys deviceidle whitelist +com.android.providers.downloads',
    'dumpsys deviceidle whitelist +com.google.android.gsf',
    'cmd deviceidle disable',
  ];
  for (const c of cmds) {
    try { await adbShell(c, 12000); } catch (_) {}
  }
  log('Play Store install-path tuning applied (accounts/data preserved)');
}

let adoptedRecoveryCheckpoint=false;

// Serialize whole-AVD checkpoints so live saves never overlap/corrupt each other
let wholeAvdSaveInFlight = null;
async function saveWholeAvd(hold = false) {
  if (wholeAvdSaveInFlight) {
    log('Whole-AVD checkpoint already in progress; waiting for it to finish...');
    try { await wholeAvdSaveInFlight; } catch (_) {}
    if (!hold) return; // skip non-hold duplicate; hold (rotation) always runs after
  }
  if (!hold) {
    const busy = await isGuestBusyForPersist();
    if (busy) {
      log('Deferring whole-AVD capture — guest busy: ' + busy);
      return;
    }
  }
  const run = async () => {
    try {
      const env = { ...process.env, CHECKPOINT_HOLD: hold ? 'true' : 'false', EMULATOR_SESSION_ID: SESSION_ID };
      const { stdout, stderr } = await execFileAsync('bash', [path.join(SCRIPTS_DIR, 'save-whole-avd.sh')], {
        timeout: 25 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
        env,
      });
      if (stdout) log(String(stdout).trim().slice(-1500));
      if (stderr) log('save-whole-avd note: ' + String(stderr).trim().slice(-800));
      log('Whole-AVD checkpoint attempt finished (hold=' + hold + ').');
    } catch (e) {
      log('Whole-AVD checkpoint warning: ' + e.message);
    } finally {
      wholeAvdSaveInFlight = null;
    }
  };
  wholeAvdSaveInFlight = run();
  return wholeAvdSaveInFlight;
}

/** Live persistence: logical backup + optional full AVD image (never blocks duty loop forever). */
async function livePersist(reason = 'periodic', { whole = false, hold = false } = {}) {
  log(`Live persist start (${reason}, whole=${whole}, hold=${hold})`);
  try {
    await runStateManager('backup');
  } catch (e) {
    log(`Live logical backup warning (${reason}): ${e.message}`);
  }
  if (whole || hold) {
    await saveWholeAvd(hold).catch((e) => log(`Live whole-AVD warning (${reason}): ${e.message}`));
  }
  log(`Live persist done (${reason})`);
}

async function runStateManager(mode) {
  const run = async () => {
    if(process.env.GITHUB_AVD_ONLY==='true'){
      // Whole-AVD is authoritative. Restore already happened pre-boot in the workflow.
      if(mode==='restore'){log('Native-verified whole AVD already restored pre-boot; skipping logical restore.');return;}
      // ROOT-CAUSE FIX: never skip the first backup. Previous code "adopted" the
      // old checkpoint and returned without publishing, so installs/login after
      // promotion never became the GitHub current pointer.
      const env={...process.env,EMULATOR_SESSION_ID:SESSION_ID,AVD_DIR:process.env.AVD_DIR||`${process.env.HOME}/.android/avd/vibely_pixel6_api34.avd`};
      const {stdout,stderr}=await execFileAsync('python3',[path.join(SCRIPTS_DIR,'github_live_checkpoint.py')],{timeout:1800000,maxBuffer:16*1024*1024,env});
      if(stdout)process.stdout.write(stdout);if(stderr)process.stderr.write(stderr);return;
    }
    const { stdout, stderr } = await execFileAsync('bash', [STATE_SCRIPT, mode], {
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, EMULATOR_SESSION_ID: SESSION_ID },
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  };
  stateOpLock = stateOpLock.then(run, run);
  return stateOpLock;
}

async function captureJpegFrame() {
  const { stdout } = await execFileAsync('adb', ['exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    timeout: 12000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!stdout || stdout.length < 512) {
    throw new Error(`screencap returned empty buffer (${stdout ? stdout.length : 0} bytes)`);
  }
  const jpg = await sharp(stdout).resize({ width: 540 }).jpeg({ quality: 74, mozjpeg: true }).toBuffer();
  if (!jpg || jpg.length < 800) {
    throw new Error(`JPEG encode returned invalid buffer (${jpg ? jpg.length : 0} bytes)`);
  }
  return jpg;
}

async function collectDeviceInfo() {
  const { stdout } = await adbShell(
    'echo VER=$(getprop ro.build.version.release); ' +
      'echo SDK=$(getprop ro.build.version.sdk); ' +
      'echo MOD=$(getprop ro.product.model); ' +
      'echo AID=$(settings get secure android_id); ' +
      'echo RES=$(wm size | tail -n1); ' +
      'pm list packages -3'
  );
  const lines = stdout.split(/\r?\n/);
  const info = {
    avdName: 'vibely_pixel6_api34',
    internetVerified: true,
    rotationTargetMinutes: ROTATION_MINUTES,
    installedPackages: [],
  };
  for (const l of lines) {
    if (l.startsWith('VER=')) info.androidVersion = l.slice(4).trim();
    else if (l.startsWith('SDK=')) info.sdkInt = l.slice(4).trim();
    else if (l.startsWith('MOD=')) info.deviceModel = l.slice(4).trim();
    else if (l.startsWith('AID=')) info.androidId = l.slice(4).trim();
    else if (l.startsWith('RES=')) {
      const m = l.match(/(\d+x\d+)/);
      info.resolution = m ? m[1] : '1080x2400';
    } else if (l.startsWith('package:')) {
      info.installedPackages.push(l.slice(8).trim());
    }
  }
  if(liveDevice){info.stream_transport='scrcpy-h264';info.separate_video_channel=true;info.stream_profile=liveDevice.profile;}
  return info;
}

async function verifyLocalEmulatorReadiness() {
  log('Verifying local Android emulator boot, ADB root, package manager, internet, and framebuffer...');

  if (SIMULATE_BOOT_FAILURE) {
    log('SIMULATE_BOOT_FAILURE=true requested — simulating replacement emulator initialization failure!');
    await gatewayFetch('/api/internal/report-failed-candidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID,
        github_run_id: RUN_ID,
        reason: 'Simulated initialization failure (Test #7 fault-injection check)',
      }),
    }).catch(() => {});
    process.exit(1);
  }

  // Wait up to 90s for full Android system & package service readiness
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const { stdout } = await adbShell('echo BOOT=$(getprop sys.boot_completed); pm path android');
      if (stdout.includes('BOOT=1') && stdout.includes('package:')) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(3000);
  }
  if (!ready) {
    throw new Error('Emulator did not reach sys.boot_completed=1 + PackageManager readiness');
  }

  await execFileAsync('adb', ['root'], { timeout: 15000 }).catch(() => {});
  await sleep(1500);
  await execFileAsync('adb', ['wait-for-device'], { timeout: 15000 });

  // User explicitly selected always-awake operation. Preserve credentials/radios;
  // do not dismiss keyguard or change the user's PIN/password.
  await adbShell('svc power stayon true; settings put system screen_off_timeout 2147483647; input keyevent 224');

  // Verify real DNS + outbound TCP/HTTP internet connectivity inside Android guest OS
  // (Note: Azure SDN drops raw ICMP ping & AOSP/google_apis ships toybox nc rather than curl)
  let netVerified = false;
  let lastNetOut = '';
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const netCheck = await adbShell(
        "(printf 'HEAD /generate_204 HTTP/1.1\\r\\nHost: connectivitycheck.gstatic.com\\r\\nConnection: close\\r\\n\\r\\n' | toybox nc -w 8 connectivitycheck.gstatic.com 80 || " +
          "printf 'HEAD / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n' | toybox nc -w 8 example.com 80)",
        20000
      );
      lastNetOut = `${netCheck.stdout} ${netCheck.stderr}`.trim();
      if (/HTTP\/1\.[01]\s+(204|200|301|302)/i.test(netCheck.stdout)) {
        netVerified = true;
        break;
      }
    } catch (e) {
      lastNetOut = e.message;
    }
    await sleep(3000);
  }
  if (!netVerified) {
    throw new Error(`Android guest internet check failed: ${lastNetOut}`);
  }

  const frame = await captureJpegFrame();
  log(`Local verification PASSED (internet=OK, screen_jpeg=${frame.length} bytes).`);
}

function escapeAndroidInputText(str) {
  return String(str)
    .replace(/ /g, '%s')
    .replace(/([&|;<>()`$"\\'*?~#])/g, '\\$1');
}

async function handleGatewayRpc(action, payload) {
  switch (action) {
    case 'live_input': if(!liveDevice)throw new Error('Live Android control is not ready');liveDevice.input(payload);return {injected_at:Date.now()};
    case 'release_input': liveDevice?.release();return {ok:true};
    case 'adb_shell': {
      const { stdout, stderr } = await adbShell(String(payload?.command || 'echo ok'), 40000);
      const deviceInfo = await collectDeviceInfo().catch(() => null);
      return { stdout, stderr, deviceInfo };
    }
    case 'capture_frame': {
      const jpg = await captureJpegFrame();
      return { jpeg_base64: jpg.toString('base64'), bytes: jpg.length };
    }
    case 'input_event': {
      const kind = payload?.kind;
      if (kind === 'tap') {
        await adbShell(`input tap ${Math.round(Number(payload.x || 0))} ${Math.round(Number(payload.y || 0))}`);
      } else if (kind === 'swipe') {
        await adbShell(
          `input swipe ${Math.round(Number(payload.x1 || 0))} ${Math.round(Number(payload.y1 || 0))} ${Math.round(Number(payload.x2 || 0))} ${Math.round(Number(payload.y2 || 0))} ${Math.round(Number(payload.duration_ms || 250))}`
        );
      } else if (kind === 'keyevent') {
        await adbShell(`input keyevent ${Math.round(Number(payload.keycode || 3))}`);
      } else if (kind === 'text') {
        await adbShell(`input text "${escapeAndroidInputText(payload.text || '')}"`);
      }
      return { ok: true };
    }
    case 'install_apk': {
      const tmpApk = `/tmp/install_${Date.now()}_${path.basename(payload.file_name || 'app.apk')}`;
      fs.writeFileSync(tmpApk, Buffer.from(payload.apk_base64, 'base64'));
      try {
        const { stdout, stderr } = await execFileAsync('adb', ['install', '-r', '-g', tmpApk], { timeout: 110000 });
        const deviceInfo = await collectDeviceInfo().catch(() => ({}));
        return { ok: true, stdout, stderr, deviceInfo };
      } finally {
        try { fs.unlinkSync(tmpApk); } catch {}
      }
    }
    case 'push_file': {
      const dest = String(payload?.remote_path || '/sdcard/Download/uploaded.bin');
      const tmpLocal = `/tmp/push_${Date.now()}.bin`;
      fs.writeFileSync(tmpLocal, Buffer.from(payload.content_base64 || '', 'base64'));
      try {
        await execFileAsync('adb', ['push', tmpLocal, dest], { timeout: 45000 });
        return { ok: true, remote_path: dest };
      } finally {
        try { fs.unlinkSync(tmpLocal); } catch {}
      }
    }
    case 'flush_final_state': {
      await runStateManager('backup');
      return { ok: true, backed_up_at: new Date().toISOString() };
    }
    case 'apply_delta_state': {
      await runStateManager('restore');
      const deviceInfo = await collectDeviceInfo();
      return { ok: true, deviceInfo };
    }
    case 'refresh_device_info': {
      const deviceInfo = await collectDeviceInfo();
      return { ok: true, deviceInfo };
    }
    default:
      throw new Error(`Unsupported RPC action: ${action}`);
  }
}

function connectMediaTunnel(){
 clearTimeout(mediaTimer);
 if(retiring || !wsClient || wsClient.readyState!==WebSocket.OPEN || mediaWs?.readyState===WebSocket.OPEN || mediaWs?.readyState===WebSocket.CONNECTING)return;
 const url=GATEWAY_URL.replace(/^http/,'ws')+'/ws/agent-video?sessionId='+encodeURIComponent(SESSION_ID);
 const socket=new WebSocket(url,{headers:{Authorization:'Bearer '+GATEWAY_SECRET},handshakeTimeout:15000});mediaWs=socket;
 socket.on('open',()=>{mediaRetry=0;mediaNeedsKey=true;if(liveDevice?.config)socket.send(liveDevice.config,{binary:true});});
 socket.on('error',()=>{});
 socket.on('close',()=>{if(mediaWs===socket)mediaWs=null;if(!retiring)mediaTimer=setTimeout(connectMediaTunnel,Math.min(8000,400*2**mediaRetry++)+Math.random()*200);});
}

function connectTunnelWebSocket(deviceInfo) {
  return new Promise((resolve, reject) => {
    const wsProto = GATEWAY_URL.startsWith('https://') ? 'wss://' : 'ws://';
    const hostPart = GATEWAY_URL.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}${hostPart}/ws/agent?sessionId=${encodeURIComponent(SESSION_ID)}&runId=${encodeURIComponent(RUN_ID)}&runAttempt=${encodeURIComponent(RUN_ATTEMPT)}&runner=${encodeURIComponent(RUNNER_NAME)}`;

    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}` },
      handshakeTimeout: 20000,
    });

    let opened = false;
    ws.on('open', () => {
      opened = true;
      wsClient = ws;
      ws.send(JSON.stringify({ type: 'hello', sessionId: SESSION_ID, deviceInfo }));
      connectMediaTunnel();
      log(`Connected reverse WebSocket tunnel to ${GATEWAY_URL}`);
      resolve(ws);
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf-8'));
        if(msg.type==='stream_profile_request'){
          liveDevice?.setProfile(msg.level).catch(e=>log('Adaptive encoder: '+e.message));
        } else if (msg.type === 'stream_control') {
          shouldStreamFrames = Boolean(msg.streaming); // H264 stays warm for instant refresh; no per-viewer encoder reset.
        } else if (msg.type === 'rpc_request' && msg.reqId) {
          try {
            const result = await handleGatewayRpc(msg.action, msg.payload);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'rpc_response', reqId: msg.reqId, result }));
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'rpc_response', reqId: msg.reqId, error: err.message || String(err) }));
            }
          }
        } else if (msg.type === 'retire_gracefully') {
          log(`Received RETIRE_GRACEFULLY from gateway (replaced by ${msg.replaced_by}, rotation #${msg.rotation_count}). Shutting down cleanly!`);
          retiring = true;
          shouldStreamFrames = false;
          setTimeout(() => {
            try { ws.close(); } catch {}
            process.exit(0);
          }, 1500);
        }
      } catch {}
    });

    ws.on('close', () => {
      mediaWs?.close();
      liveDevice?.release();
      if (wsClient === ws) wsClient = null;
      if (!retiring && opened && !reconnecting) {
        reconnecting = true;
        reconnectTunnel(deviceInfo).finally(() => { reconnecting = false; });
      }
    });

    ws.on('error', (err) => {
      if (!opened) reject(err);
    });
  });
}

async function dispatchReplacementWorkflow() {
  if (!GH_PAT) {
    log('GH_PAT not set; relying on GitHub Actions cron schedule for rotation.');
    return false;
  }
  const nextRapidCycles = RAPID_TEST_CYCLES > 0 ? String(RAPID_TEST_CYCLES - 1) : '0';
  const nextRotationMinutes = RAPID_TEST_CYCLES > 0 ? String(ROTATION_MINUTES) : '240';

  log(`Dispatching successor Android Emulator workflow (next rotation_minutes=${nextRotationMinutes}, rapid_test_cycles=${nextRapidCycles})...`);
  const resp = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/android-emulator.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'vibely-emulator-rotator',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        rotation_minutes: nextRotationMinutes,
        rapid_test_cycles: nextRapidCycles,
        force_rotate: 'true',
        simulate_boot_failure: 'false',
      },
    }),
  });

  if (resp.status === 204 || resp.ok) {
    replacementDispatchedAt = Date.now();
    log('Successor workflow dispatched successfully! Keeping current emulator LIVE until successor verifies & promotes.');
    return true;
  }
  log(`Failed dispatching successor workflow (${resp.status}): ${await resp.text()}`);
  return false;
}

async function checkDispatchedSuccessorHealth() {
  if (!replacementDispatchedAt || !GH_PAT || retiring) return;
  const waitedSec = (Date.now() - replacementDispatchedAt) / 1000;
  if (waitedSec < 45) return;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/android-emulator.yml/runs?per_page=5`,
      {
        headers: {
          Authorization: `Bearer ${GH_PAT}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'vibely-emulator-rotator',
        },
      }
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const newerRuns = (data.workflow_runs || []).filter(
      (r) => String(r.id) !== String(RUN_ID) && new Date(r.created_at).getTime() >= replacementDispatchedAt - 30000
    );

    if (newerRuns.length > 0) {
      const latest = newerRuns[0];
      if (latest.status === 'completed' && latest.conclusion !== 'success' && !retiring) {
        replacementRetries += 1;
        log(
          `Successor run #${latest.id} failed (${latest.conclusion})! Active emulator remains uninterrupted; dispatching retry #${replacementRetries}...`
        );
        replacementDispatchedAt = 0;
        if (replacementRetries <= 5) {
          await sleep(10000);
          await dispatchReplacementWorkflow();
        }
        return;
      }
    }

    // Also retry if >18 minutes passed without handover completing
    if (waitedSec > 18 * 60 && replacementRetries <= 5) {
      replacementRetries += 1;
      log(`Successor handover exceeded 18m; keeping active emulator alive and dispatching retry #${replacementRetries}...`);
      replacementDispatchedAt = 0;
      await dispatchReplacementWorkflow();
    }
  } catch (err) {
    log(`Successor monitor warning: ${err.message}`);
  }
}

async function reconnectTunnel(deviceInfo) {
  let attempt = 0;
  while (!retiring) {
    try {
      await sleep(Math.min(30000, 2000 * 2 ** Math.min(attempt++, 4)));
      await wakeGatewayOnBlitz();
      if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
        await connectTunnelWebSocket(await collectDeviceInfo().catch(() => deviceInfo));
      }
      // An already promoted runner must reclaim an EMPTY gateway after restart.
      // Never displace a successor which has already become active.
      if (promotedAtMs) {
        const health = await fetch(`${GATEWAY_URL}/api/public/health`, { signal: AbortSignal.timeout(10000) });
        if (!health.ok) throw new Error(`Health ${health.status}`);
        const state = await health.json();
        if (state.active_session_id && state.active_session_id !== SESSION_ID) {
          retiring = true;
          wsClient?.close();
          process.exit(0);
        }
        if (!state.active_session_id) {
          const verified = await gatewayFetch(`/api/internal/verify-standby/${encodeURIComponent(SESSION_ID)}`, { method: 'POST' });
          if (!verified.ok || !(await verified.json()).verified) throw new Error('Reconnect verification failed');
          const promoted = await gatewayFetch('/api/internal/handover', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_session_id: SESSION_ID, reason: 'gateway_restart_recovery' }),
          });
          if (!promoted.ok || !(await promoted.json()).ok) throw new Error('Reconnect promotion failed');
        }
      }
      if (wsClient?.readyState !== WebSocket.OPEN) throw new Error('Tunnel closed during recovery');
      log('Tunnel recovery complete.');
      return;
    } catch (err) {
      log(`Tunnel recovery attempt ${attempt} failed: ${err.message}; retrying indefinitely.`);
    }
  }
}

async function main() {
  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    throw new Error('EMULATOR_GATEWAY_URL and EMULATOR_GATEWAY_SECRET must be set');
  }

  await wakeGatewayOnBlitz();
  await verifyLocalEmulatorReadiness();

  // Pre-load persisted state onto this new emulator while isolated in standby
  await runStateManager('restore');
  const deviceInfo = await collectDeviceInfo();
  liveDevice=await startLiveDevice(packet=>{
    if(mediaWs?.readyState!==WebSocket.OPEN)return;
    const flags=packet.readBigUInt64BE(1),isConfig=Boolean(flags&(1n<<63n)),isKey=Boolean(flags&(1n<<62n));
    if(isConfig){mediaWs.send(packet,{binary:true});return;}
    if(!shouldStreamFrames){mediaNeedsKey=true;return;}
    if(mediaWs.bufferedAmount>128*1024){mediaNeedsKey=true;return;}
    if(mediaNeedsKey&&!isKey)return;
    if(isKey)mediaNeedsKey=false;
    mediaWs.send(packet,{binary:true});
  },profile=>{
    if(wsClient?.readyState===WebSocket.OPEN)wsClient.send(JSON.stringify({type:'stream_profile',profile}));
  });
  deviceInfo.stream_profile=liveDevice.profile;
  deviceInfo.separate_video_channel=true;
  deviceInfo.stream_transport='scrcpy-h264';

  // Connect tunnel to android.aivideo.blitz.cloud as non-conflicting standby candidate
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await connectTunnelWebSocket(deviceInfo);
      break;
    } catch (err) {
      if (attempt === 6) throw err;
      log(`Tunnel connect attempt ${attempt} failed (${err.message}); waking gateway & retrying...`);
      await wakeGatewayOnBlitz();
      await sleep(7000);
    }
  }

  // Verify end-to-end tunnel reachability through android.aivideo.blitz.cloud BEFORE promoting!
  log('Running remote standby verification via android.aivideo.blitz.cloud...');
  const verResp = await gatewayFetch(`/api/internal/verify-standby/${encodeURIComponent(SESSION_ID)}`, {
    method: 'POST',
  });
  const verJson = await verResp.json();
  if (!verResp.ok || !verJson.verified) {
    await gatewayFetch('/api/internal/report-failed-candidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID,
        github_run_id: RUN_ID,
        reason: `Standby remote verification failed: ${JSON.stringify(verJson)}`,
      }),
    }).catch(() => {});
    throw new Error(`Remote standby verification failed: ${JSON.stringify(verJson)}`);
  }
  log(`Remote standby verification PASSED (${verJson.frame_bytes}B screen frame verified over tunnel).`);

  // Execute coordinated zero-downtime handover (flushes OLD final delta -> restores onto NEW -> swaps active pointer -> retires OLD)
  log('Executing atomic zero-downtime handover on android.aivideo.blitz.cloud...');
  const hoResp = await gatewayFetch('/api/internal/handover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      new_session_id: SESSION_ID,
      expect_empty: process.env.GITHUB_AVD_ONLY==='true',
      reason: RAPID_TEST_CYCLES > 0 ? 'rapid_e2e_rotation_verification' : 'automatic_4h_workflow_rotation',
    }),
  });
  const hoJson = await hoResp.json();
  if (!hoResp.ok || !hoJson.ok) {
    throw new Error(`Handover failed: ${JSON.stringify(hoJson)}`);
  }
  promotedAtMs = Date.now();
  log(`HANDOVER COMPLETE! Active session is now ${SESSION_ID} (cutover=${hoJson.cutover_ms}ms, stateSynced=${hoJson.state_synced}).`);

  // Verify external user-facing endpoint serves this exact emulator
  if (ACCESS_TOKEN) {
    const extCheck = await fetch(`${GATEWAY_URL}/api/status`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const extData = await extCheck.json();
    if (!extCheck.ok || extData?.active_emulator?.session_id !== SESSION_ID) {
      throw new Error(`Post-handover external status mismatch: ${JSON.stringify(extData)}`);
    }
    log('Verified external android.aivideo.blitz.cloud user endpoint is live and routed to this emulator!');
  }

  // Clear stuck permission dialogs and grant notification perms before user interaction
  await prepareDevicePermissions();
  // Device realism: Pixel-6-aligned props, sensors, telephony
  try {
    const realism = path.join(SCRIPTS_DIR, 'device-realism.sh');
    const { stdout, stderr } = await execFileAsync('bash', [realism], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (stdout) log(String(stdout).trim().slice(-2000));
    if (stderr) log('device-realism note: ' + String(stderr).trim().slice(-500));
  } catch (e) {
    log('device-realism warning: ' + e.message);
  }
  // Hide root signals + drop adb root (no Magisk — phone must not look rooted)
  try {
    const hide = path.join(SCRIPTS_DIR, 'hide-root-emulator.sh');
    const { stdout, stderr } = await execFileAsync('bash', [hide], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout) log(String(stdout).trim().slice(-1500));
    if (stderr) log('hide-root note: ' + String(stderr).trim().slice(-400));
  } catch (e) {
    log('hide-root warning: ' + e.message);
  }
  // Claim GitHub state ownership so this session can publish checkpoints (fixes fenced writer after rotation)
  try {
    const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS_DIR, 'github_state.py'), 'claim', '--owner', SESSION_ID], {
      timeout: 120000, env: { ...process.env, EMULATOR_SESSION_ID: SESSION_ID },
    });
    if (stdout) log('GitHub state claim: ' + String(stdout).trim());
  } catch (e) {
    log('GitHub state claim warning: ' + e.message);
  }

  // Immediate verified whole-AVD after promotion (must actually publish — no adopt-and-skip)
  await tunePlayStoreForEmulator().catch((e) => log('Play tune: ' + e.message));
  {
    const busy = await isGuestBusyForPersist();
    if (busy) log('Skipping immediate post-promotion whole-AVD; guest busy: ' + busy);
    else await livePersist('post-promotion', { whole: true, hold: false }).catch((e) => log(`Initial persist note: ${e.message}`));
  }

  // PRIMARY persistence = change-triggered write-through (package/account/settings).
  // Secondary safety net = infrequent whole-AVD only if something was missed.
  const CHANGE_POLL_MS = 20 * 1000;
  const SAFETY_WHOLE_MS = 30 * 60 * 1000; // safety only, not primary
  let lastChangeFingerprint = '';
  let lastWholeAvdMs = Date.now();
  let lastBlitzWakeMs = Date.now();
  let changePersistInFlight = false;

  async function fingerprintPhoneState() {
    try {
      const pkgs = (await adbShell('pm list packages -3', 20000)).stdout.trim().split(/\n+/).filter(Boolean).sort().join('|');
      let accounts = '0';
      try {
        const acc = (await adbShell('dumpsys account', 25000)).stdout;
        const m = acc.match(/Accounts:\s*(\d+)/);
        accounts = m ? m[1] : '0';
        const names = [...acc.matchAll(/Account \{name=([^,]+)/g)].map((x) => x[1]).sort().join(',');
        if (names) accounts += ':' + names;
      } catch (_) {}
      let settings = '';
      try {
        settings = (await adbShell('settings list secure | head -80', 15000)).stdout.trim();
      } catch (_) {}
      return `a=${accounts}||p=${pkgs}||s=${settings.length}:${settings.slice(0, 400)}`;
    } catch (e) {
      return 'err:' + e.message;
    }
  }

  while (!retiring) {
    await sleep(15000);
    if (retiring) break;

    const activeMinutes = (Date.now() - promotedAtMs) / 60000;

    // 1. Local ADB & system health check + heartbeat
    try {
      const devices = await execFileAsync('adb', ['devices'], { timeout: 10000 }).then(r => r.stdout || '').catch(e => e.message);
      if (!/emulator-\d+\s+device/.test(devices)) {
        log('CRITICAL: adb has no emulator device — running recoverAdbConnection()');
        const ok = await recoverAdbConnection();
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, deviceInfo: { degraded: !ok, adbRecovered: ok, adbDevices: devices } }));
        }
        if (!ok) {
          log('ADB recovery failed this cycle; will retry next health check');
        }
      } else {
        // Soft-clear stuck system permission dialogs only (never force-stop apps)
        try { await prepareDevicePermissions(); } catch (_) {}

        // Keep display awake — frozen black/last-frame is often a sleeping surface
        try {
          await adbShell('svc power stayon true; input keyevent 224', 12000);
        } catch (_) {}

        // Revive scrcpy control/video if either channel died (root cause of "stuck screen")
        if (liveDevice?.ensureHealthy) {
          try {
            const h = await liveDevice.ensureHealthy();
            if (!h.ok) log('scrcpy ensureHealthy degraded: ' + JSON.stringify(h));
          } catch (e) {
            log('ensureHealthy warning: ' + e.message);
          }
        }

        const { stdout } = await adbShell('getprop sys.boot_completed');
        if (!stdout.trim().startsWith('1')) {
          log('Warning: sys.boot_completed not 1 during health check');
        }
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          const di = await collectDeviceInfo();
          try {
            if (liveDevice) {
              di.control_alive = true;
              di.stream_profile = liveDevice.profile;
            }
          } catch (_) {}
          wsClient.send(JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, deviceInfo: di }));
        }
      }
    } catch (err) {
      log(`Health check warning: ${err.message}`);
    }

    // 2. Proactive Blitz.cloud resume every 10m so android.aivideo.blitz.cloud (15m sleep tier) never sleeps
    if (Date.now() - lastBlitzWakeMs >= 10 * 60 * 1000) {
      lastBlitzWakeMs = Date.now();
      await wakeGatewayOnBlitz();
    }

    // 3. PRIMARY: change-triggered write-through (install/uninstall/login/settings)
    try {
      const fp = await fingerprintPhoneState();
      if (!lastChangeFingerprint) {
        lastChangeFingerprint = fp;
      } else if (fp !== lastChangeFingerprint && !changePersistInFlight && !wholeAvdSaveInFlight) {
        const busy = await isGuestBusyForPersist();
        if (busy) {
          log('State changed but Play/download busy (' + busy + ') — defer persist');
        } else {
          const pendingFp = fp;
          lastChangeFingerprint = fp;
          changePersistInFlight = true;
          (async () => {
            await sleep(90000);
            const busy2 = await isGuestBusyForPersist();
            if (busy2) { log('Still busy after debounce (' + busy2 + ') — skip'); return; }
            const fp2 = await fingerprintPhoneState();
            if (fp2 !== pendingFp) { log('Fingerprint still changing — wait next cycle'); lastChangeFingerprint = fp2; return; }
            log('Phone state stable — whole-AVD persist');
            await livePersist('change-triggered', { whole: true, hold: false });
          })()
            .catch((e) => log(`Change-triggered persist warning: ${e.message}`))
            .finally(() => { changePersistInFlight = false; lastWholeAvdMs = Date.now(); });
        }
      }
    } catch (e) {
      log('Change fingerprint warning: ' + e.message);
    }

    // 3b. SAFETY NET only (not primary): whole-AVD if no change-triggered save for 30m
    if (Date.now() - lastWholeAvdMs >= SAFETY_WHOLE_MS && !wholeAvdSaveInFlight && !changePersistInFlight) {
      lastWholeAvdMs = Date.now();
      livePersist('safety-30m-whole', { whole: true, hold: false }).catch((e) => log(`Safety whole warning: ${e.message}`));
    }

    // 4. Trigger 4-hour replacement workflow when rotation target is reached
    if (activeMinutes >= ROTATION_MINUTES && replacementDispatchedAt === 0) {
      await livePersist('pre-rotation', { whole: true, hold: true });
      await dispatchReplacementWorkflow();
    }

    // 5. Monitor dispatched successor & auto-retry if successor fails initialization!
    if (replacementDispatchedAt > 0) {
      await checkDispatchedSuccessorHealth();
    }

    // Hard safety ceiling at 345 minutes (15m before GitHub Actions' 360m hard job limit)
    if (activeMinutes >= 345) {
      log('Approaching GitHub Actions 6h runner ceiling (345m); performing final state backup before exit.');
      await livePersist('pre-exit-ceiling', { whole: true, hold: true });
      break;
    }
  }
}

main().catch(async (err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
