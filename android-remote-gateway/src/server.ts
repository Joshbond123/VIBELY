import {phoneUi} from './phoneUi.js';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const PERSIST_DIR = path.join(DATA_DIR, 'persistence');
fs.mkdirSync(PERSIST_DIR, { recursive: true });

const ACCESS_TOKEN = (process.env.EMULATOR_ACCESS_TOKEN || '').trim();
const GATEWAY_SECRET = (process.env.EMULATOR_GATEWAY_SECRET || '').trim();

const COORDINATOR_FILE = path.join(DATA_DIR, 'coordinator.json');
const ROTATION_LOG_FILE = path.join(DATA_DIR, 'rotation-history.json');
const SNAPSHOT_FILE = path.join(PERSIST_DIR, 'latest-state.tar.zst');
const MANIFEST_FILE = path.join(PERSIST_DIR, 'manifest.json');
const IDENTITY_FILE = path.join(PERSIST_DIR, 'device-identity.json');

interface DeviceInfo {
  stream_transport?:string;
  androidVersion?: string;
  sdkInt?: string;
  deviceModel?: string;
  avdName?: string;
  androidId?: string;
  resolution?: string;
  installedPackages?: string[];
  internetVerified?: boolean;
  rotationTargetMinutes?: number;
}

interface AgentSession {
  sessionId: string;
  githubRunId: string;
  githubRunAttempt: string;
  runnerName: string;
  role: 'active' | 'standby' | 'retiring';
  verified: boolean;
  ws: WebSocket;
  deviceInfo: DeviceInfo;
  connectedAt: number;
  promotedAt: number | null;
  lastHeartbeatAt: number;
  videoConfig?: Buffer | null;
  videoGop?: Buffer[];
  lastFrame: Buffer | null;
  lastFrameAt: number;
  lastJpegAt?: number;
  pendingRpc: Map<string, { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>;
}

interface RotationEvent {
  timestamp: string;
  previous_session_id: string | null;
  new_session_id: string;
  new_github_run_id: string;
  state_synced: boolean;
  downtime_ms: number;
  reason: string;
}

const sessions = new Map<string, AgentSession>();
const viewerSockets = new Set<WebSocket>();
const controlSockets=new Set<WebSocket>();
const nativePointerOwners=new Map<number,WebSocket>();
let lastQualityChange=0,qualityTimer:NodeJS.Timeout|undefined;

let activeSessionId: string | null = null;
let rotationCount = 0;
let failedReplacementCount = 0;
let lastFailedCandidate: any = null;
let handoverInProgress = false;

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    }
  } catch {}
  return fallback;
}

function writeJsonAtomic(filePath: string, data: any): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

const persistedCoord = readJsonSafe<{ rotationCount?: number; failedReplacementCount?: number; lastActiveSessionId?: string }>(
  COORDINATOR_FILE,
  {}
);
rotationCount = Number(persistedCoord.rotationCount || 0);
failedReplacementCount = Number(persistedCoord.failedReplacementCount || 0);

function saveCoordinatorState() {
  writeJsonAtomic(COORDINATOR_FILE, {
    rotationCount,
    failedReplacementCount,
    lastActiveSessionId: activeSessionId,
    updatedAt: new Date().toISOString(),
  });
}

function appendRotationEvent(ev: RotationEvent) {
  const hist = readJsonSafe<RotationEvent[]>(ROTATION_LOG_FILE, []);
  hist.unshift(ev);
  writeJsonAtomic(ROTATION_LOG_FILE, hist.slice(0, 100));
}

function signCookieValue(token: string): string {
  return crypto.createHmac('sha256', GATEWAY_SECRET || 'vibely-emu-cookie-key').update(token).digest('hex');
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

// Public shared phone: intentionally no user authentication. Internal agent
// endpoints still require EMULATOR_GATEWAY_SECRET.
function isUserAuthenticated(_req: http.IncomingMessage | Request): boolean {
  return true;
}

function isGatewayAgentAuthenticated(req: http.IncomingMessage | Request): boolean {
  if (!GATEWAY_SECRET) return false;
  const auth = req.headers['authorization'] || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return safeCompare(auth.slice(7).trim(), GATEWAY_SECRET);
  }
  const hdr = req.headers['x-gateway-secret'];
  if (typeof hdr === 'string') {
    return safeCompare(hdr.trim(), GATEWAY_SECRET);
  }
  return false;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getActiveSession(): AgentSession | null {
  if (!activeSessionId) return null;
  const s = sessions.get(activeSessionId);
  if (!s || s.ws.readyState !== WebSocket.OPEN) return null;
  return s;
}

function callAgentRpc(session: AgentSession, action: string, payload: any = {}, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (session.ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`Session ${session.sessionId} WebSocket is not open`));
      return;
    }
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => {
      session.pendingRpc.delete(reqId);
      reject(new Error(`RPC '${action}' timed out after ${timeoutMs}ms on ${session.sessionId}`));
    }, timeoutMs);

    session.pendingRpc.set(reqId, { resolve, reject, timer });
    session.ws.send(JSON.stringify({ type: 'rpc_request', reqId, action, payload }));
  });
}

function notifyStreamStateToAgents() {
  const shouldStream = viewerSockets.size > 0;
  for (const s of sessions.values()) {
    if (s.ws.readyState === WebSocket.OPEN) {
      const activeForThis = s.sessionId === activeSessionId && shouldStream;
      s.ws.send(JSON.stringify({ type: 'stream_control', streaming: activeForThis }));
    }
  }
}

function broadcastViewerJson(msg: any) {
  const raw = JSON.stringify(msg);
  for (const v of new Set([...viewerSockets,...controlSockets])) {
    if (v.readyState === WebSocket.OPEN) {
      v.send(raw);
    }
  }
}

function broadcastViewerFrame(packet:Buffer) {
  const h264=packet[0]===2 && packet.length>=13;
  const flags=h264?packet.readBigUInt64BE(1):0n,isKey=Boolean(flags&(1n<<62n)),isConfig=Boolean(flags&(1n<<63n));
  for(const v of viewerSockets){
    if(v.readyState!==WebSocket.OPEN)continue;
    if(v.bufferedAmount>128*1024){(v as any).needKey=true;continue;}
    if((v as any).needKey && h264 && !isKey && !isConfig)continue;
    if(isKey && (v as any).needKey){const c=getActiveSession()?.videoConfig;if(c)v.send(c,{binary:true});(v as any).needKey=false;}
    v.send(packet,{binary:true});
  }
}
function requestAdaptiveProfile(){
  clearTimeout(qualityTimer);
  const active=getActiveSession();if(!active || !(active.deviceInfo as any).separate_video_channel)return;
  const reports=[...controlSockets].map(v=>(v as any).qos).filter(q=>q && q.visible && Date.now()-q.at<12000);
  const level=reports.reduce((n,q)=>Math.max(n,q.level),0),current=Number((active.deviceInfo as any).stream_profile?.id || 0);
  if(level===current)return;
  const wait=(level>current?4000:15000)-(Date.now()-lastQualityChange);
  if(wait>0){qualityTimer=setTimeout(requestAdaptiveProfile,wait);return;}
  lastQualityChange=Date.now();active.ws.send(JSON.stringify({type:'stream_profile_request',level}));
}
function handleAgentFrame(session:AgentSession,data:Buffer){
 session.lastHeartbeatAt=Date.now();
 if(data[0]===2){
  if(data.length<13)return;session.deviceInfo.stream_transport='scrcpy-h264';const flags=data.readBigUInt64BE(1);
  if(flags&(1n<<63n)){if(session.videoConfig?.equals(data))return;session.videoConfig=Buffer.from(data);session.videoGop=[];}
  else if(flags&(1n<<62n))session.videoGop=[Buffer.from(data)];
  else if(session.videoGop?.length && session.videoGop.length<90)session.videoGop.push(Buffer.from(data));
  session.lastFrameAt=Date.now();if(session.sessionId===activeSessionId)broadcastViewerFrame(data);return;
 }
 const jpeg=data[0]===1?data.subarray(1):data;session.lastFrame=Buffer.from(jpeg);session.lastFrameAt=Date.now();if(session.sessionId===activeSessionId)broadcastViewerFrame(session.lastFrame);
}

const app = express();
app.use(express.json({ limit: '80mb' }));

// Public non-sensitive health endpoint (for Blitz health checks + GitHub Actions pre-flight coordination)
app.get('/api/public/health', (_req: Request, res: Response) => {
  const active = getActiveSession();
  const standbyList = Array.from(sessions.values())
    .filter((s) => s.role === 'standby' && s.ws.readyState === WebSocket.OPEN)
    .map((s) => ({
      session_id: s.sessionId,
      verified: s.verified,
      connected_sec: Math.round((Date.now() - s.connectedAt) / 1000),
    }));

  const manifest = readJsonSafe<any>(MANIFEST_FILE, null);
  res.json({
    ok: true,
    service: 'vibely-android-remote-gateway',
    active_emulator_connected: Boolean(active),
    active_session_id: active ? active.sessionId : null,
    active_github_run_id: active ? active.githubRunId : null,
    active_uptime_sec: active ? Math.round((Date.now() - (active.promotedAt || active.connectedAt)) / 1000) : 0,
    standby_count: standbyList.length,
    standby_sessions: standbyList,
    rotation_count: rotationCount,
    failed_replacement_count: failedReplacementCount,
    has_persisted_snapshot: fs.existsSync(SNAPSHOT_FILE),
    snapshot_saved_at: manifest?.saved_at || null,
  });
});

// Login & Logout endpoints for Web UI
app.post('/api/auth/login', (req: Request, res: Response) => {
  const token = String(req.body?.token || '').trim();
  if (!ACCESS_TOKEN || !token || !safeCompare(token, ACCESS_TOKEN)) {
    res.status(401).json({ ok: false, error: 'Invalid access token' });
    return;
  }
  const sig = signCookieValue(ACCESS_TOKEN);
  res.setHeader('Set-Cookie', `emu_auth=${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', 'emu_auth=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

function requireUserAuth(req: Request, res: Response, next: NextFunction) {
  if (!isUserAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized — valid EMULATOR_ACCESS_TOKEN required' });
    return;
  }
  next();
}

function requireGatewayAuth(req: Request, res: Response, next: NextFunction) {
  if (!isGatewayAgentAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized internal agent request' });
    return;
  }
  next();
}

// ============================================================================
// INTERNAL RUNNER COORDINATION & PERSISTENCE APIs (Bearer EMULATOR_GATEWAY_SECRET)
// ============================================================================

app.get('/api/internal/state/identity', requireGatewayAuth, (_req: Request, res: Response) => {
  if (!fs.existsSync(IDENTITY_FILE)) {
    // Generate deterministic persistent identity on very first boot and persist forever
    const generatedAndroidId = crypto.randomBytes(8).toString('hex');
    writeJsonAtomic(IDENTITY_FILE, {
      android_id: generatedAndroidId,
      adbkey: '',
      adbkey_pub: '',
      created_at: new Date().toISOString(),
    });
  }
  res.json({ ok: true, identity: readJsonSafe(IDENTITY_FILE, {}) });
});

app.put('/api/internal/state/identity', requireGatewayAuth, (req: Request, res: Response) => {
  const current = readJsonSafe<any>(IDENTITY_FILE, {});
  const merged = {
    ...current,
    android_id: req.body?.android_id || current.android_id || crypto.randomBytes(8).toString('hex'),
    adbkey: req.body?.adbkey || current.adbkey || '',
    adbkey_pub: req.body?.adbkey_pub || current.adbkey_pub || '',
    updated_at: new Date().toISOString(),
  };
  writeJsonAtomic(IDENTITY_FILE, merged);
  res.json({ ok: true, identity: merged });
});

app.put('/api/internal/state/snapshot', requireGatewayAuth, (req: Request, res: Response) => {
  const tmpFile = `${SNAPSHOT_FILE}.uploading.${Date.now()}`;
  const out = fs.createWriteStream(tmpFile);
  const hash = crypto.createHash('sha256');
  let bytes = 0;

  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  req.pipe(out);

  out.on('finish', () => {
    try {
      if (bytes < 64) {
        try { fs.unlinkSync(tmpFile); } catch {}
        res.status(400).json({ ok: false, error: 'Empty state snapshot rejected' });
        return;
      }
      fs.renameSync(tmpFile, SNAPSHOT_FILE);
      let metaHeader: any = {};
      if (typeof req.headers['x-state-meta'] === 'string') {
        try {
          metaHeader = JSON.parse(Buffer.from(req.headers['x-state-meta'], 'base64').toString('utf-8'));
        } catch {}
      }
      const manifest = {
        ...metaHeader,
        bytes,
        sha256: hash.digest('hex'),
        saved_at: new Date().toISOString(),
      };
      writeJsonAtomic(MANIFEST_FILE, manifest);
      res.json({ ok: true, manifest });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  out.on('error', (err) => {
    try { fs.unlinkSync(tmpFile); } catch {}
    res.status(500).json({ ok: false, error: err.message });
  });
});

app.get('/api/internal/state/snapshot', requireGatewayAuth, (_req: Request, res: Response) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    res.status(404).json({ ok: false, error: 'No persisted snapshot yet' });
    return;
  }
  const manifest = readJsonSafe<any>(MANIFEST_FILE, {});
  res.setHeader('Content-Type', 'application/zstd');
  res.setHeader('X-State-Meta', Buffer.from(JSON.stringify(manifest)).toString('base64'));
  fs.createReadStream(SNAPSHOT_FILE).pipe(res);
});

app.post('/api/internal/verify-standby/:sessionId', requireGatewayAuth, async (req: Request, res: Response) => {
  try {
    const s = sessions.get(String(req.params.sessionId));
    if (!s || s.ws.readyState !== WebSocket.OPEN) {
      res.status(404).json({ ok: false, error: 'Candidate session not connected to gateway' });
      return;
    }

    const probe = await callAgentRpc(
      s,
      'adb_shell',
      { command: 'echo BOOT=$(getprop sys.boot_completed); echo AID=$(settings get secure android_id); pm path android' },
      25000
    );
    const stdout = String(probe?.stdout || '');
    if (!stdout.includes('BOOT=1') || !stdout.includes('package:')) {
      res.status(422).json({ ok: false, error: `Candidate failed boot/pm check: ${stdout}` });
      return;
    }

    // Never mark an account-less reconstruction READY to replace a signed-in
    // phone. Only compare digests; do not log/return account identifiers.
    const activePhone=getActiveSession();
    if(activePhone && activePhone.sessionId!==s.sessionId){
      const command="dumpsys account | grep -E '^[[:space:]]*Account [{]name=' | sort";
      const [before,after]=await Promise.all([callAgentRpc(activePhone,'adb_shell',{command},25000),callAgentRpc(s,'adb_shell',{command},25000)]);
      const original=String(before?.stdout||'').trim(),candidate=String(after?.stdout||'').trim();
      if(original && crypto.createHash('sha256').update(original).digest('hex')!==crypto.createHash('sha256').update(candidate).digest('hex')){
        s.verified=false;
        res.status(412).json({ok:false,error:'Candidate did not preserve signed-in Android accounts; existing phone preserved. Whole-AVD migration required.'});return;
      }
    }

    const frameRes = await callAgentRpc(s, 'capture_frame', {}, 25000);
    const frameBuf = frameRes?.jpeg_base64 ? Buffer.from(frameRes.jpeg_base64, 'base64') : null;
    if (!frameBuf || frameBuf.length < 1500) {
      res.status(422).json({ ok: false, error: 'Candidate failed screen capture check' });
      return;
    }

    s.lastFrame = frameBuf;
    s.lastJpegAt = Date.now();
    if(s.deviceInfo.stream_transport!=='scrcpy-h264')s.lastFrameAt=s.lastJpegAt;
    s.verified = true;
    if (probe?.deviceInfo) {
      s.deviceInfo = { ...s.deviceInfo, ...probe.deviceInfo };
    }

    res.json({
      ok: true,
      verified: true,
      session_id: s.sessionId,
      frame_bytes: frameBuf.length,
      probe_stdout: stdout.trim(),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/internal/report-failed-candidate', requireGatewayAuth, (req: Request, res: Response) => {
  failedReplacementCount += 1;
  lastFailedCandidate = {
    session_id: req.body?.session_id || 'unknown',
    github_run_id: req.body?.github_run_id || '',
    reason: req.body?.reason || 'Boot/readiness failure',
    active_session_preserved: activeSessionId,
    timestamp: new Date().toISOString(),
  };
  saveCoordinatorState();
  res.json({
    ok: true,
    failed_replacement_count: failedReplacementCount,
    active_session_preserved: activeSessionId,
    last_failed_candidate: lastFailedCandidate,
  });
});

app.post('/api/internal/handover', requireGatewayAuth, async (req: Request, res: Response) => {
  if (handoverInProgress) {
    res.status(409).json({ ok: false, error: 'Another handover is currently in progress' });
    return;
  }
  handoverInProgress = true;
  const tStart = Date.now();
  try {
    const newSessionId = String(req.body?.new_session_id || '');
    const reason = String(req.body?.reason || 'scheduled_4h_rotation');
    const newSession = sessions.get(newSessionId);

    if (!newSession || newSession.ws.readyState !== WebSocket.OPEN) {
      res.status(404).json({ ok: false, error: `New session ${newSessionId} is not connected` });
      return;
    }
    if (!newSession.verified) {
      res.status(412).json({ ok: false, error: `New session ${newSessionId} must pass /verify-standby before handover` });
      return;
    }

    const oldSession = getActiveSession();
    let stateSynced = false;

    // Step 1: If an active emulator is currently running, flush its live delta & apply to newSession BEFORE cutover!
    if (oldSession && oldSession.sessionId !== newSession.sessionId) {
      try {
        console.log(`[Handover] Flushing final live state from active session ${oldSession.sessionId}...`);
        const flushRes = await callAgentRpc(oldSession, 'flush_final_state', {}, 90000);
        if (flushRes?.ok) {
          console.log(`[Handover] Applying live delta state onto standby session ${newSession.sessionId}...`);
          const applyRes = await callAgentRpc(newSession, 'apply_delta_state', {}, 120000);
          stateSynced = Boolean(applyRes?.ok);
        }
      } catch (syncErr: any) {
        console.warn(`[Handover] Live delta sync note (${syncErr?.message}); base snapshot already restored.`);
      }
    } else {
      stateSynced = fs.existsSync(SNAPSHOT_FILE);
    }

    if(oldSession && oldSession.sessionId!==newSession.sessionId && !stateSynced){res.status(503).json({ok:false,error:'Live state synchronization failed; existing Android session preserved'});return;}

    // Step 2: Atomic pointer swap (<1ms downtime!)
    const cutoverStart = Date.now();
    const prevId = oldSession ? oldSession.sessionId : null;
    if (oldSession && oldSession.sessionId !== newSession.sessionId) {
      oldSession.role = 'retiring';
    }
    newSession.role = 'active';
    newSession.promotedAt = Date.now();
    activeSessionId = newSession.sessionId;
    if (prevId && prevId !== newSession.sessionId) {
      rotationCount += 1;
    }
    const cutoverMs = Date.now() - cutoverStart;
    saveCoordinatorState();

    // Refresh device metadata & frame on the newly promoted active session
    try {
      const infoRes = await callAgentRpc(newSession, 'refresh_device_info', {}, 15000);
      if (infoRes?.deviceInfo) {
        newSession.deviceInfo = { ...newSession.deviceInfo, ...infoRes.deviceInfo };
      }
    } catch {}

    const event: RotationEvent = {
      timestamp: new Date().toISOString(),
      previous_session_id: prevId,
      new_session_id: newSession.sessionId,
      new_github_run_id: newSession.githubRunId,
      state_synced: stateSynced,
      downtime_ms: cutoverMs,
      reason,
    };
    appendRotationEvent(event);

    // Step 3: Seamlessly switch all live browser WebSockets to the new session
    notifyStreamStateToAgents();
    broadcastViewerJson({
      type: 'session_switched',
      active_session_id: newSession.sessionId,
      previous_session_id: prevId,
      rotation_count: rotationCount,
      device_info: newSession.deviceInfo,
    });
    if (newSession.lastFrame) {
      broadcastViewerFrame(newSession.lastFrame);
    }

    // Step 4: Instruct the old emulator workflow to retire gracefully ONLY AFTER new session is active!
    if (oldSession && oldSession.sessionId !== newSession.sessionId && oldSession.ws.readyState === WebSocket.OPEN) {
      oldSession.ws.send(
        JSON.stringify({
          type: 'retire_gracefully',
          replaced_by: newSession.sessionId,
          rotation_count: rotationCount,
        })
      );
    }

    console.log(
      `[Handover] Promoted ${newSession.sessionId} (prev=${prevId || 'none'}, stateSynced=${stateSynced}, totalMs=${Date.now() - tStart})`
    );

    res.json({
      ok: true,
      active_session_id: activeSessionId,
      previous_session_id: prevId,
      rotation_count: rotationCount,
      state_synced: stateSynced,
      cutover_ms: cutoverMs,
      total_handover_ms: Date.now() - tStart,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    handoverInProgress = false;
  }
});

// ============================================================================
// AUTHENTICATED REMOTE EMULATOR CONTROL & TELEMETRY APIs
// ============================================================================

app.get('/api/status', requireUserAuth, (_req: Request, res: Response) => {
  const active = getActiveSession();
  const manifest = readJsonSafe<any>(MANIFEST_FILE, null);
  const history = readJsonSafe<RotationEvent[]>(ROTATION_LOG_FILE, []);
  const standby = Array.from(sessions.values())
    .filter((s) => s.sessionId !== activeSessionId && s.ws.readyState === WebSocket.OPEN)
    .map((s) => ({
      session_id: s.sessionId,
      github_run_id: s.githubRunId,
      role: s.role,
      verified: s.verified,
      connected_at: new Date(s.connectedAt).toISOString(),
    }));

  res.json({
    ok: true,
    active_emulator: active
      ? {
          session_id: active.sessionId,
          github_run_id: active.githubRunId,
          runner_name: active.runnerName,
          role: active.role,
          connected_at: new Date(active.connectedAt).toISOString(),
          promoted_at: active.promotedAt ? new Date(active.promotedAt).toISOString() : null,
          uptime_sec: Math.round((Date.now() - (active.promotedAt || active.connectedAt)) / 1000),
          last_heartbeat_at: new Date(active.lastHeartbeatAt).toISOString(),
          device_info: active.deviceInfo,
        }
      : null,
    standby_candidates: standby,
    rotation_count: rotationCount,
    failed_replacement_count: failedReplacementCount,
    last_failed_candidate: lastFailedCandidate,
    persistence: {
      has_snapshot: fs.existsSync(SNAPSHOT_FILE),
      manifest,
    },
    rotation_history: history.slice(0, 20),
  });
});

app.get('/api/screen.jpg', requireUserAuth, async (_req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  try {
    if (!active.lastFrame || Date.now() - (active.lastJpegAt || 0) > 1500) {
      const r = await callAgentRpc(active, 'capture_frame', {}, 15000);
      if (r?.jpeg_base64) {
        active.lastFrame = Buffer.from(r.jpeg_base64, 'base64');
        active.lastJpegAt = Date.now();
        if(active.deviceInfo.stream_transport!=='scrcpy-h264')active.lastFrameAt=active.lastJpegAt;
      }
    }
    if (!active.lastFrame) {
      res.status(500).json({ ok: false, error: 'Failed capturing emulator screen' });
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Emulator-Session', active.sessionId);
    res.send(active.lastFrame);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Recovery transport only: an authenticated operator may thaw/read the EXACT
// original session even after its public active connection drops during capture.
// This never verifies/promotes a standby or changes phone ownership.
app.post('/api/internal/recovery/rpc', requireGatewayAuth, async (req: Request, res: Response) => {
  const id=String(req.body?.session_id || '');
  const session=sessions.get(id);
  if(!session || session.ws.readyState!==WebSocket.OPEN){res.status(503).json({ok:false,error:'Specified recovery session is disconnected'});return;}
  const command=String(req.body?.command || '');
  if(!command || command.length>4096){res.status(400).json({ok:false,error:'Invalid recovery command'});return;}
  try{const out=await callAgentRpc(session,'adb_shell',{command},45000);res.json({ok:true,session_id:id,...out});}
  catch(err:any){res.status(502).json({ok:false,error:err?.message || 'Recovery RPC failed'});}
});

app.post('/api/adb/shell', requireUserAuth, async (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  const command = String(req.body?.command || '').trim();
  if (!command) {
    res.status(400).json({ ok: false, error: 'command is required' });
    return;
  }
  try {
    const out = await callAgentRpc(active, 'adb_shell', { command }, 45000);
    res.json({ ok: true, session_id: active.sessionId, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/input', requireUserAuth, async (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  try {
    const out = await callAgentRpc(active, 'input_event', req.body || {}, 15000);
    res.json({ ok: true, session_id: active.sessionId, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/adb/install', requireUserAuth, async (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  const apkBase64 = String(req.body?.apk_base64 || '');
  const fileName = String(req.body?.file_name || 'uploaded.apk');
  if (!apkBase64) {
    res.status(400).json({ ok: false, error: 'apk_base64 is required' });
    return;
  }
  try {
    const out = await callAgentRpc(active, 'install_apk', { apk_base64: apkBase64, file_name: fileName }, 120000);
    res.json({ ok: true, session_id: active.sessionId, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/files/upload', requireUserAuth, async (req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  try {
    const out = await callAgentRpc(active, 'push_file', req.body || {}, 60000);
    res.json({ ok: true, session_id: active.sessionId, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/checkpoint', requireUserAuth, async (_req: Request, res: Response) => {
  const active = getActiveSession();
  if (!active) {
    res.status(503).json({ ok: false, error: 'No active Android emulator connected' });
    return;
  }
  try {
    const out = await callAgentRpc(active, 'flush_final_state', {}, 120000);
    res.json({ ok: true, session_id: active.sessionId, ...out });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ============================================================================
// WEB REMOTE CONSOLE UI (GET /)
// ============================================================================

app.get('/', (req: Request, res: Response) => {
  // Support one-time ?token=... exchange into HttpOnly cookie + clean URL redirect
  const qToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (qToken && ACCESS_TOKEN && safeCompare(qToken, ACCESS_TOKEN)) {
    const sig = signCookieValue(ACCESS_TOKEN);
    res.setHeader('Set-Cookie', `emu_auth=${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    res.redirect(302, '/');
    return;
  }

  const authed = isUserAuthenticated(req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWebConsoleHtml(authed));
});

function renderWebConsoleHtml(_authenticated: boolean): string { return phoneUi; }

// ============================================================================
// HTTP + DUAL WEBSOCKET SERVER (/ws/agent & /ws/viewer)
// ============================================================================

const server = http.createServer(app);
const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const wssAgentVideo=new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
const wssViewer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  if(urlObj.pathname==='/ws/agent-video'){
    if(!isGatewayAgentAuthenticated(req)){socket.destroy();return;}
    wssAgentVideo.handleUpgrade(req,socket,head,ws=>wssAgentVideo.emit('connection',ws,req));
  } else if (urlObj.pathname === '/ws/agent') {
    if (!isGatewayAgentAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      wssAgent.emit('connection', ws, req);
    });
  } else if ((urlObj.pathname === '/ws/viewer' || urlObj.pathname === '/ws/control')) {
    if (!isUserAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssViewer.handleUpgrade(req, socket, head, (ws) => {
      wssViewer.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wssAgentVideo.on('connection',(ws:WebSocket,req:http.IncomingMessage)=>{
 const id=new URL(req.url || '/','http://localhost').searchParams.get('sessionId') || '';
 const session=sessions.get(id);if(!session){ws.close(4004,'Control session not registered');return;}
 // An authenticated media connection is actual evidence of the separate transport,
 // including legacy agents whose reconnect hello omitted its capability flag.
 (session.deviceInfo as any).separate_video_channel=true;
 ws.on('message',(raw:Buffer,binary:boolean)=>{if(binary && sessions.get(id)===session)handleAgentFrame(session,raw);});
 ws.on('error',()=>{});
});

wssAgent.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  const sessionId = urlObj.searchParams.get('sessionId') || `emu_${crypto.randomUUID().slice(0, 8)}`;
  const githubRunId = urlObj.searchParams.get('runId') || '';
  const githubRunAttempt = urlObj.searchParams.get('runAttempt') || '1';
  const runnerName = urlObj.searchParams.get('runner') || 'github-ubuntu';

  const existing = sessions.get(sessionId);
  const keepActive = activeSessionId === sessionId;

  const session: AgentSession = {
    sessionId,
    githubRunId,
    githubRunAttempt,
    runnerName,
    role: keepActive ? 'active' : 'standby',
    verified: existing ? existing.verified : false,
    ws,
    deviceInfo: existing ? existing.deviceInfo : {},
    connectedAt: existing ? existing.connectedAt : Date.now(),
    promotedAt: existing ? existing.promotedAt : null,
    lastHeartbeatAt: Date.now(),
    videoConfig:existing?.videoConfig,
    videoGop:existing?.videoGop,
    lastFrame: existing ? existing.lastFrame : null,
    lastFrameAt: existing ? existing.lastFrameAt : 0,
    lastJpegAt:existing?.lastJpegAt,
    pendingRpc: new Map(),
  };
  sessions.set(sessionId, session);
  console.log(`[Gateway] Agent connected: ${sessionId} (role=${session.role}, runId=${githubRunId})`);

  notifyStreamStateToAgents();

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    session.lastHeartbeatAt = Date.now();
    if(isBinary){handleAgentFrame(session,data);return;}

    try {
      const msg = JSON.parse(data.toString('utf-8'));
      if(msg.type==='stream_profile'){
        (session.deviceInfo as any).stream_profile=msg.profile;session.videoGop=[];
        if(session.sessionId===activeSessionId)broadcastViewerJson({type:'stream_profile',profile:msg.profile});
      } else if (msg.type === 'hello' || msg.type === 'heartbeat') {
        if (msg.deviceInfo) {
          session.deviceInfo = { ...session.deviceInfo, ...msg.deviceInfo };
        }
      } else if (msg.type === 'rpc_response' && msg.reqId) {
        const pending = session.pendingRpc.get(msg.reqId);
        if (pending) {
          clearTimeout(pending.timer);
          session.pendingRpc.delete(msg.reqId);
          if (msg.error) pending.reject(new Error(String(msg.error)));
          else pending.resolve(msg.result);
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    for (const [, p] of session.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error(`Agent ${sessionId} disconnected`));
    }
    session.pendingRpc.clear();
    if (sessions.get(sessionId)?.ws === ws) {
      sessions.delete(sessionId);
      if (activeSessionId === sessionId) {
        console.log(`[Gateway] Active session ${sessionId} disconnected.`);
        // Auto-failover if a verified standby session is already waiting!
        const readyStandby = Array.from(sessions.values()).find((s) => s.verified && s.ws.readyState === WebSocket.OPEN);
        if (readyStandby) {
          activeSessionId = readyStandby.sessionId;
          readyStandby.role = 'active';
          readyStandby.promotedAt = Date.now();
          rotationCount += 1;
          saveCoordinatorState();
          notifyStreamStateToAgents();
          broadcastViewerJson({
            type: 'session_switched',
            active_session_id: readyStandby.sessionId,
            rotation_count: rotationCount,
            device_info: readyStandby.deviceInfo,
          });
        } else {
          activeSessionId = null;
        }
      }
    }
  });
});

wssViewer.on('connection', (ws: WebSocket,req:http.IncomingMessage) => {
  const controlOnly=(req.url || '').split('?')[0]==='/ws/control';
  (controlOnly?controlSockets:viewerSockets).add(ws);
  const ownedPointers=new Map<number,any>();
  notifyStreamStateToAgents();

  const active = getActiveSession();
  ws.send(
    JSON.stringify({
      type: 'welcome',
      active_session_id: active ? active.sessionId : null,
      rotation_count: rotationCount,
      device_info: active ? active.deviceInfo : null,
    })
  );
  // Wake only the display on an actual viewer visit; never dismiss keyguard or
  // change the user's credential. Screen timeout remains an Android policy.
  if(!controlOnly && active && new URL(req.url || '/', 'http://relay').searchParams.get('wake')!=='0'){callAgentRpc(active,'adb_shell',{command:'input keyevent 224; dumpsys window policy | grep -E "mShowingLockscreen|isStatusBarKeyguard|showing="'},15000).then(r=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'screen_state',locked:/mShowingLockscreen=true|isStatusBarKeyguard=true|showing=true/.test(r.stdout||'')}));}).catch(()=>{});}
  if(!controlOnly && active?.videoConfig){ws.send(active.videoConfig,{binary:true});if(Date.now()-active.lastFrameAt<3000)for(const packet of active.videoGop || [])ws.send(packet,{binary:true});}
  if (!controlOnly && !active?.videoConfig && active?.lastFrame) {
    ws.send(active.lastFrame, { binary: true });
  }

  let inputWindow=Date.now(),inputCount=0;
  ws.on('message',async(raw,isBinary)=>{
    if(isBinary || raw.toString().length>16384)return;
    let requestId:any;
    try {
      const m=JSON.parse(raw.toString());requestId=m.id;
      if(m.type==='ping'){ws.send(JSON.stringify({type:'pong',at:m.at}));return;}
      if(m.type==='qos' && controlOnly){if(Date.now()-((ws as any).qos?.at || 0)<1000)return;(ws as any).qos={level:Math.max(0,Math.min(3,Math.round(Number(m.level)||0))),visible:m.visible!==false,at:Date.now()};requestAdaptiveProfile();return;}
      if(m.type!=='input')return;
      if(Date.now()-inputWindow>1000){inputWindow=Date.now();inputCount=0;}
      if(++inputCount>300)return;
      const active=getActiveSession();if(!active)throw new Error('Android temporarily disconnected');
      if(m.event?.kind==='pointer'){
        const original=m.event.pointerId,p=m.event,owned=ownedPointers.get(original);
        if(p.action==='down'){
          let native=owned?.pointerId;if(native===undefined)native=[0,1,2,3,4,5,6,7,8,9].find(n=>!nativePointerOwners.has(n));
          if(native===undefined)throw new Error('Android touch capacity reached');
          m.event={...p,pointerId:native};nativePointerOwners.set(native,ws);ownedPointers.set(original,m.event);
        }else{
          if(!owned)return;m.event={...p,pointerId:owned.pointerId};
          if(p.action==='up'||p.action==='cancel'){ownedPointers.delete(original);nativePointerOwners.delete(owned.pointerId);}else ownedPointers.set(original,m.event);
        }
      }
      let result:any;
      if(active.deviceInfo.stream_transport==='scrcpy-h264')result=await callAgentRpc(active,'live_input',m.event,5000);
      else if(m.event.kind!=='pointer')result=await callAgentRpc(active,'input_event',m.event,5000);
      else {if(m.event.action==='down')(ws as any).legacyDown=m.event;
        if(m.event.action==='up' && (ws as any).legacyDown){const p=(ws as any).legacyDown;(ws as any).legacyDown=null;const w=Number(active.deviceInfo.resolution?.split('x')[0]||1080),h=Number(active.deviceInfo.resolution?.split('x')[1]||2400);const dist=Math.hypot(p.x-m.event.x,p.y-m.event.y);result=await callAgentRpc(active,'input_event',dist<.02?{kind:'tap',x:Math.round(m.event.x*w),y:Math.round(m.event.y*h)}:{kind:'swipe',x1:Math.round(p.x*w),y1:Math.round(p.y*h),x2:Math.round(m.event.x*w),y2:Math.round(m.event.y*h),duration_ms:220},5000);}}

      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'input_ack',id:m.id,...result}));
    } catch(e:any){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'input_ack',id:requestId,error:e.message}));}
  });
  ws.on('close', () => {
    const active=getActiveSession();if(active)for(const p of ownedPointers.values())callAgentRpc(active,'live_input',{...p,action:'up'},3000).catch(()=>{});
    for(const p of ownedPointers.values())nativePointerOwners.delete(p.pointerId);
    ownedPointers.clear();controlSockets.delete(ws);requestAdaptiveProfile();
    viewerSockets.delete(ws);
    notifyStreamStateToAgents();
  });
});

// Ping the separate idle media transport without generating screen traffic.
setInterval(()=>{for(const ws of wssAgentVideo.clients)if(ws.readyState===WebSocket.OPEN)ws.ping();},20000);

// Ping WebSockets every 20s to keep Cloudflare/Blitz reverse proxies warm
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.ping();
  }
  for (const v of viewerSockets) {
    if (v.readyState === WebSocket.OPEN) v.ping();
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[AndroidRemoteGateway] Listening on 0.0.0.0:${PORT} (DATA_DIR=${DATA_DIR})`);
});
