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
  lastFrame: Buffer | null;
  lastFrameAt: number;
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

function isUserAuthenticated(req: http.IncomingMessage | Request): boolean {
  if (!ACCESS_TOKEN) return false;
  const auth = req.headers['authorization'] || '';
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const provided = auth.slice(7).trim();
    if (provided && safeCompare(provided, ACCESS_TOKEN)) return true;
  }
  const headerTok = req.headers['x-emulator-token'];
  if (typeof headerTok === 'string' && safeCompare(headerTok.trim(), ACCESS_TOKEN)) return true;

  const urlObj = new URL(req.url || '/', 'http://localhost');
  const qTok = urlObj.searchParams.get('token');
  if (qTok && safeCompare(qTok.trim(), ACCESS_TOKEN)) return true;

  const cookies = parseCookies(req.headers.cookie);
  if (cookies.emu_auth && safeCompare(cookies.emu_auth, signCookieValue(ACCESS_TOKEN))) {
    return true;
  }
  return false;
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
  for (const v of viewerSockets) {
    if (v.readyState === WebSocket.OPEN) {
      v.send(raw);
    }
  }
}

function broadcastViewerFrame(jpegBuf: Buffer) {
  for (const v of viewerSockets) {
    if (v.readyState === WebSocket.OPEN && v.bufferedAmount < 2 * 1024 * 1024) {
      v.send(jpegBuf, { binary: true });
    }
  }
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

    const frameRes = await callAgentRpc(s, 'capture_frame', {}, 25000);
    const frameBuf = frameRes?.jpeg_base64 ? Buffer.from(frameRes.jpeg_base64, 'base64') : null;
    if (!frameBuf || frameBuf.length < 1500) {
      res.status(422).json({ ok: false, error: 'Candidate failed screen capture check' });
      return;
    }

    s.lastFrame = frameBuf;
    s.lastFrameAt = Date.now();
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
    if (!active.lastFrame || Date.now() - active.lastFrameAt > 1500) {
      const r = await callAgentRpc(active, 'capture_frame', {}, 15000);
      if (r?.jpeg_base64) {
        active.lastFrame = Buffer.from(r.jpeg_base64, 'base64');
        active.lastFrameAt = Date.now();
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

function renderWebConsoleHtml(authenticated: boolean): string {
  if (!authenticated) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VIBELY Cloud Android — Remote Access Gateway</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; }
    body { min-height: 100vh; background: radial-gradient(circle at top, #172038 0%, #090d16 70%); color: #f8fafc; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 430px; background: rgba(17, 24, 39, 0.92); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 20px; padding: 34px; box-shadow: 0 25px 60px rgba(0,0,0,0.55); }
    .badge { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: #34d399; background: rgba(16, 185, 129, 0.14); border: 1px solid rgba(16, 185, 129, 0.3); padding: 5px 12px; border-radius: 999px; margin-bottom: 16px; }
    h1 { font-size: 23px; font-weight: 700; margin-bottom: 8px; }
    p { font-size: 13.5px; color: #94a3b8; line-height: 1.5; margin-bottom: 22px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    input { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #334155; background: #0f172a; color: #fff; font-size: 14px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #6366f1; }
    button { width: 100%; padding: 12px 16px; border: none; border-radius: 10px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
    button:hover { opacity: 0.94; }
    .err { color: #f87171; font-size: 13px; margin-top: 12px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● ReactiveCircus Android 14 · android.aivideo.blitz.cloud</div>
    <h1>Android Remote Phone Studio</h1>
    <p>Enter your secure <code>EMULATOR_ACCESS_TOKEN</code> to view and control the persistent Android virtual device.</p>
    <form id="loginForm">
      <label>Access Token</label>
      <input type="password" id="tok" placeholder="Enter EMULATOR_ACCESS_TOKEN..." required autofocus />
      <button type="submit">Connect to Virtual Phone</button>
      <div class="err" id="err"></div>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('tok').value.trim();
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (r.ok) location.reload();
      else document.getElementById('err').textContent = 'Invalid access token.';
    });
  </script>
</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VIBELY Cloud Android 14 — Live Remote Phone</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; }
    body { background: #090d16; color: #f1f5f9; min-height: 100vh; display: flex; flex-direction: column; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 12px 22px; background: #111827; border-bottom: 1px solid #1e293b; flex-wrap: wrap; gap: 10px; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 10px #ef4444; }
    .dot.live { background: #10b981; box-shadow: 0 0 12px #10b981; }
    .pill { font-size: 12px; background: #1e293b; padding: 4px 10px; border-radius: 999px; color: #cbd5e1; border: 1px solid #334155; }
    main { flex: 1; display: grid; grid-template-columns: minmax(340px, 460px) 1fr; gap: 20px; padding: 20px; max-width: 1480px; width: 100%; margin: 0 auto; }
    @media (max-width: 960px) { main { grid-template-columns: 1fr; } }
    .phone-wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .phone-frame { background: #05070c; border: 4px solid #334155; border-radius: 34px; padding: 12px; box-shadow: 0 25px 60px rgba(0,0,0,0.65); position: relative; width: 356px; max-width: 100%; }
    canvas { width: 100%; aspect-ratio: 9 / 20; background: #020617; border-radius: 22px; display: block; cursor: pointer; touch-action: none; }
    .nav-bar { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; width: 356px; max-width: 100%; }
    .btn { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 9px 10px; border-radius: 10px; font-size: 12.5px; font-weight: 600; cursor: pointer; transition: 0.15s; }
    .btn:hover { background: #334155; border-color: #6366f1; }
    .btn.primary { background: #4f46e5; border-color: #6366f1; color: #fff; }
    .panel { background: #111827; border: 1px solid #1e293b; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; gap: 16px; }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    .stat { background: #0b1120; border: 1px solid #1e293b; border-radius: 12px; padding: 12px; }
    .stat .k { font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .stat .v { font-size: 14px; font-weight: 700; margin-top: 4px; color: #f8fafc; word-break: break-all; }
    .row { display: flex; gap: 8px; }
    input[type="text"] { flex: 1; background: #0b1120; border: 1px solid #334155; color: #fff; padding: 9px 12px; border-radius: 9px; font-size: 13px; }
    pre { background: #050811; border: 1px solid #1e293b; border-radius: 10px; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #a7f3d0; max-height: 240px; overflow: auto; white-space: pre-wrap; }
    h2 { font-size: 15px; font-weight: 700; color: #e2e8f0; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
    th { color: #94a3b8; font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="dot" id="connDot"></div>
      <strong>VIBELY Cloud Android 14 (Pixel 6 · KVM)</strong>
      <span class="pill" id="sessBadge">Connecting...</span>
      <span class="pill" id="fpsBadge">0 FPS</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button class="btn primary" onclick="triggerCheckpoint()">Save State Now</button>
      <button class="btn" onclick="logout()">Logout</button>
    </div>
  </header>

  <main>
    <div class="phone-wrap">
      <div class="phone-frame">
        <canvas id="screen" width="540" height="1200"></canvas>
      </div>
      <div class="nav-bar">
        <button class="btn" onclick="sendKey(4)" title="Back">◁ Back</button>
        <button class="btn" onclick="sendKey(3)" title="Home">○ Home</button>
        <button class="btn" onclick="sendKey(187)" title="Recents">□ Apps</button>
        <button class="btn" onclick="sendKey(224)" title="Wake">☀ Wake</button>
        <button class="btn" onclick="sendKey(24)" title="Volume Up">Vol+</button>
        <button class="btn" onclick="downloadScreen()" title="Screenshot">📷</button>
      </div>
      <div class="row" style="width:356px;max-width:100%;">
        <input type="text" id="textInput" placeholder="Type text to send to phone..." onkeydown="if(event.key==='Enter')sendText()" />
        <button class="btn primary" onclick="sendText()">Send</button>
        <button class="btn" onclick="sendKey(66)" title="Enter">⏎</button>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="panel">
        <h2>Live Session, Persistence & 4-Hour Zero-Downtime Rotation</h2>
        <div class="grid2">
          <div class="stat"><div class="k">Active Session ID</div><div class="v" id="stSession">—</div></div>
          <div class="stat"><div class="k">Android / Profile</div><div class="v" id="stModel">—</div></div>
          <div class="stat"><div class="k">Persistent Android ID</div><div class="v" id="stAid">—</div></div>
          <div class="stat"><div class="k">Session Uptime / 4h Cycle</div><div class="v" id="stUptime">—</div></div>
          <div class="stat"><div class="k">Completed Handovers</div><div class="v" id="stRotations">0</div></div>
          <div class="stat"><div class="k">Last Persisted Backup</div><div class="v" id="stBackup">—</div></div>
        </div>
      </div>

      <div class="panel">
        <h2>Quick Actions & APK Installer</h2>
        <div class="row">
          <input type="text" id="urlInput" placeholder="https://example.com" value="https://example.com" />
          <button class="btn primary" onclick="openUrl()">Open URL on Phone</button>
        </div>
        <div class="row" style="align-items:center;">
          <input type="file" id="apkFile" accept=".apk" style="font-size:12px;color:#cbd5e1;" />
          <button class="btn" onclick="installApk()">Upload & Install APK</button>
          <span id="apkStatus" style="font-size:12px;color:#94a3b8;"></span>
        </div>
      </div>

      <div class="panel">
        <h2>Interactive Root ADB Shell</h2>
        <div class="row">
          <input type="text" id="adbCmd" value="getprop ro.build.version.release && pm list packages -3 && ls -la /sdcard/Download" onkeydown="if(event.key==='Enter')runAdb()" />
          <button class="btn primary" onclick="runAdb()">Run ADB</button>
        </div>
        <pre id="adbOut">Ready.</pre>
      </div>

      <div class="panel">
        <h2>Zero-Downtime Rotation History</h2>
        <table>
          <thead><tr><th>UTC Time</th><th>Previous</th><th>Promoted</th><th>State Synced</th><th>Cutover</th></tr></thead>
          <tbody id="rotBody"><tr><td colspan="5">No rotations recorded yet.</td></tr></tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    const canvas = document.getElementById('screen');
    const ctx = canvas.getContext('2d');
    let devWidth = 1080, devHeight = 2400;
    let frames = 0, lastFpsTick = Date.now();
    let pointerDown = null;

    function connectWs() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws/viewer');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        document.getElementById('connDot').classList.add('live');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'session_switched' || msg.type === 'welcome') {
              document.getElementById('sessBadge').textContent = msg.active_session_id || 'Waiting for runner...';
              refreshStatus();
            }
          } catch {}
          return;
        }
        const blob = new Blob([ev.data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          frames++;
          if (Date.now() - lastFpsTick >= 1000) {
            document.getElementById('fpsBadge').textContent = frames + ' FPS';
            frames = 0;
            lastFpsTick = Date.now();
          }
        };
        img.src = url;
      };
      ws.onclose = () => {
        document.getElementById('connDot').classList.remove('live');
        setTimeout(connectWs, 2000);
      };
    }

    function mapCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(devWidth, Math.round(((e.clientX - rect.left) / rect.width) * devWidth)));
      const y = Math.max(0, Math.min(devHeight, Math.round(((e.clientY - rect.top) / rect.height) * devHeight)));
      return { x, y };
    }

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointerDown = { ...mapCoords(e), t: Date.now() };
    });

    canvas.addEventListener('pointerup', async (e) => {
      if (!pointerDown) return;
      const up = mapCoords(e);
      const dt = Date.now() - pointerDown.t;
      const dist = Math.hypot(up.x - pointerDown.x, up.y - pointerDown.y);
      const start = pointerDown;
      pointerDown = null;
      if (dist < 18 && dt < 450) {
        await fetch('/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'tap', x: up.x, y: up.y }) });
      } else {
        await fetch('/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'swipe', x1: start.x, y1: start.y, x2: up.x, y2: up.y, duration_ms: Math.min(1200, Math.max(120, dt)) }) });
      }
    });

    async function sendKey(code) {
      await fetch('/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'keyevent', keycode: code }) });
    }

    async function sendText() {
      const inp = document.getElementById('textInput');
      if (!inp.value) return;
      await fetch('/api/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'text', text: inp.value }) });
      inp.value = '';
    }

    async function openUrl() {
      const u = document.getElementById('urlInput').value.trim();
      if (!u) return;
      await fetch('/api/adb/shell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'am start -a android.intent.action.VIEW -d ' + JSON.stringify(u) }) });
    }

    async function runAdb() {
      const cmd = document.getElementById('adbCmd').value.trim();
      if (!cmd) return;
      document.getElementById('adbOut').textContent = 'Running...';
      const r = await fetch('/api/adb/shell', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
      const d = await r.json();
      document.getElementById('adbOut').textContent = d.ok ? (d.stdout || '') + (d.stderr ? '\\n[stderr]\\n' + d.stderr : '') : ('Error: ' + d.error);
    }

    async function installApk() {
      const f = document.getElementById('apkFile').files[0];
      if (!f) return;
      const st = document.getElementById('apkStatus');
      st.textContent = 'Uploading & installing ' + f.name + '...';
      const buf = await f.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const r = await fetch('/api/adb/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: f.name, apk_base64: btoa(binary) })
      });
      const d = await r.json();
      st.textContent = d.ok ? 'Installed successfully!' : ('Failed: ' + d.error);
      refreshStatus();
    }

    async function triggerCheckpoint() {
      const r = await fetch('/api/checkpoint', { method: 'POST' });
      const d = await r.json();
      alert(d.ok ? 'Emulator state backed up cleanly!' : ('Backup error: ' + d.error));
      refreshStatus();
    }

    function downloadScreen() { window.open('/api/screen.jpg?t=' + Date.now(), '_blank'); }
    async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); }

    async function refreshStatus() {
      try {
        const r = await fetch('/api/status');
        if (!r.ok) return;
        const d = await r.json();
        const emu = d.active_emulator;
        document.getElementById('sessBadge').textContent = emu ? emu.session_id : 'No Active Emulator';
        document.getElementById('stSession').textContent = emu ? (emu.session_id + ' (Run #' + emu.github_run_id + ')') : 'Waiting...';
        const di = emu?.device_info || {};
        if (di.resolution) {
          const m = String(di.resolution).match(/(\\d+)x(\\d+)/);
          if (m) { devWidth = Number(m[1]); devHeight = Number(m[2]); }
        }
        document.getElementById('stModel').textContent = emu ? ('Android ' + (di.androidVersion || '14') + ' · ' + (di.deviceModel || 'Pixel 6') + ' (' + (di.resolution || '1080x2400') + ')') : '—';
        document.getElementById('stAid').textContent = di.androidId || '—';
        document.getElementById('stUptime').textContent = emu ? (Math.floor(emu.uptime_sec / 60) + 'm ' + (emu.uptime_sec % 60) + 's / 240m target') : '—';
        document.getElementById('stRotations').textContent = d.rotation_count + (d.standby_candidates?.length ? (' (+' + d.standby_candidates.length + ' standby booting)') : '');
        document.getElementById('stBackup').textContent = d.persistence?.manifest?.saved_at ? new Date(d.persistence.manifest.saved_at).toLocaleTimeString() : 'Pending initial';

        const rows = (d.rotation_history || []).slice(0, 8);
        if (rows.length) {
          document.getElementById('rotBody').innerHTML = rows.map((x) =>
            '<tr><td>' + x.timestamp.slice(11, 19) + '</td><td>' + (x.previous_session_id || 'initial') + '</td><td>' + x.new_session_id + '</td><td>' + (x.state_synced ? 'Yes' : 'Cold') + '</td><td>' + x.downtime_ms + 'ms</td></tr>'
          ).join('');
        }
      } catch {}
    }

    connectWs();
    refreshStatus();
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>`;
}

// ============================================================================
// HTTP + DUAL WEBSOCKET SERVER (/ws/agent & /ws/viewer)
// ============================================================================

const server = http.createServer(app);
const wssAgent = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const wssViewer = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '/', 'http://localhost');
  if (urlObj.pathname === '/ws/agent') {
    if (!isGatewayAgentAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssAgent.handleUpgrade(req, socket, head, (ws) => {
      wssAgent.emit('connection', ws, req);
    });
  } else if (urlObj.pathname === '/ws/viewer') {
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
    lastFrame: existing ? existing.lastFrame : null,
    lastFrameAt: existing ? existing.lastFrameAt : 0,
    pendingRpc: new Map(),
  };
  sessions.set(sessionId, session);
  console.log(`[Gateway] Agent connected: ${sessionId} (role=${session.role}, runId=${githubRunId})`);

  notifyStreamStateToAgents();

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    session.lastHeartbeatAt = Date.now();
    if (isBinary) {
      // Binary frame packet: 1-byte header 0x01 + JPEG bytes
      const jpeg = data[0] === 0x01 ? data.subarray(1) : data;
      session.lastFrame = Buffer.from(jpeg);
      session.lastFrameAt = Date.now();
      if (session.sessionId === activeSessionId) {
        broadcastViewerFrame(session.lastFrame);
      }
      return;
    }

    try {
      const msg = JSON.parse(data.toString('utf-8'));
      if (msg.type === 'hello' || msg.type === 'heartbeat') {
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

wssViewer.on('connection', (ws: WebSocket) => {
  viewerSockets.add(ws);
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
  if (active?.lastFrame) {
    ws.send(active.lastFrame, { binary: true });
  }

  ws.on('close', () => {
    viewerSockets.delete(ws);
    notifyStreamStateToAgents();
  });
});

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
