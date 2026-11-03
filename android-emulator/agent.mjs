  /**
   * A STABLE fingerprint of user-visible phone state.
   *
   * The old version hashed `settings list secure | head -80`, whose first 80 keys
   * include values Android rewrites on its own (notification churn, accessibility
   * bookkeeping, adb timestamps). The fingerprint therefore changed on almost every
   * poll, every debounce ended in "Fingerprint still changing", and a real install
   * or permission grant was never checkpointed. That is why changes could vanish at
   * the next rotation.
   *
   * Only genuinely meaningful, deterministic state is included here.
   */
  const STABLE_SECURE_KEYS = [
    'user_setup_complete', 'device_provisioned', 'adb_enabled', 'ui_night_mode',
    'accessibility_enabled', 'enabled_notification_listeners', 'default_input_method',
  ];
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
      const settingsParts = [];
      for (const key of STABLE_SECURE_KEYS) {
        try {
          const v = (await adbShell(`settings get secure ${key}`, 12000)).stdout.trim();
          settingsParts.push(`${key}=${v}`);
        } catch (_) {}
      }
      return `a=${accounts}||p=${pkgs}||s=${settingsParts.join(';')}`;
    } catch (e) {
      return 'err:' + e.message;
    }
  }

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
// Emergency-only mode: refuse to promote onto a gateway that still has a live
// phone. Normal 4h rotation MUST be able to replace a live source, otherwise
// every rotation is rejected and the old emulator is destroyed with no successor.
const EMERGENCY_EMPTY_ONLY = String(process.env.EMULATOR_EMPTY_GATEWAY_ONLY || 'false').toLowerCase() === 'true';
// Whole-AVD captures pause the virtual CPU (adb emu avd stop) for the duration of
// the disk copy. Doing that on every change froze Play Store downloads mid-install.
// Short enough that a fresh install/download is durable within ~10 minutes, long
// enough that the (short) vCPU pause happens rarely. Every capture is still gated
// on no viewer, no download/install and 2 minutes of quiet.
// A live viewer may delay a capture but never indefinitely (bounds state loss).
const VIEWER_CAPTURE_GRACE_MS = 12 * 60 * 1000;
const WHOLE_AVD_MIN_INTERVAL_MS = Math.max(5, Number(process.env.WHOLE_AVD_MIN_INTERVAL_MIN || 10)) * 60 * 1000;
const INSTALL_TEST_PACKAGE = (process.env.VIBELY_INSTALL_TEST_PACKAGE || '').trim();
// A run only boots when the workflow coordination decided it should, so a booted
// emulator is a legitimate replacement candidate and may take the phone over from
// a live predecessor (the gateway retires the predecessor after cutover).
const FORCE_TAKEOVER = String(process.env.VIBELY_FORCE_TAKEOVER || 'true').toLowerCase() !== 'false';

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

// ---------------------------------------------------------------------------
// Emulator supervision (self-heal). The emulator process can die at any time on a
// cloud runner (host OOM kill, qemu/swiftshader crash, lost KVM). When qemu is
// gone, no amount of `adb reconnect` brings the phone back: the old code retried
// adb six times, burned ~10 minutes and then asked for a whole new runner, so the
// user just saw a frozen/black phone. The AVD disk on this runner is still intact,
// so the correct recovery is to relaunch the emulator from that same disk - which
// restores the exact same phone (apps, accounts, data, settings) in ~60-90s.
// ---------------------------------------------------------------------------
const AVD_NAME = (process.env.VIBELY_AVD_NAME || process.env.AVD_NAME || 'vibely_pixel6_api34').trim();
const AVD_HOME = process.env.ANDROID_AVD_HOME
  || path.join(process.env.HOME || '/root', '.android', 'avd');
const EMULATOR_BIN = [
  process.env.ANDROID_SDK_ROOT,
  process.env.ANDROID_HOME,
  '/usr/local/lib/android/sdk',
].filter(Boolean).map((r) => path.join(r, 'emulator', 'emulator'))
  .find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || 'emulator';
const EMULATOR_RESTART_LOG = '/tmp/vibely-emulator.log';

let emulatorRestartInFlight = false;
let adbRecoveryInFlight = false;
let consecutiveAdbFailures = 0;
let lastChangeFingerprint = '';
let pendingChangeFp = '';
let lastAdbHealthyAt = Date.now();
let lastDutyTickAt = Date.now();
let lastEncodedPacketAt = 0;
let pendingChangeSince = Date.now();
let lastLiveInputAt = 0;

const pendingLogLines = [];
let logFlushTimer = null;

/**
 * Ship buffered agent lines to the gateway. Lines are only removed once the POST
 * succeeded: a gateway restart (which happens every ~100 minutes) used to swallow
 * exactly the evidence needed to debug a failure. Retries on its own timer.
 */
async function flushAgentLog() {
  if (!GATEWAY_URL || !GATEWAY_SECRET || !pendingLogLines.length) return;
  const batch = pendingLogLines.splice(0, Math.min(pendingLogLines.length, 200));
  try {
    const res = await fetch(`${GATEWAY_URL}/api/internal/agent-log`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, lines: batch }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (_) {
    pendingLogLines.unshift(...batch);
    while (pendingLogLines.length > 1200) pendingLogLines.shift();
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => { logFlushTimer = null; void flushAgentLog(); }, 5000);
      logFlushTimer.unref?.();
    }
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] [${SESSION_ID}] ${msg}`);
  // Mirror into the gateway so a stuck 5-hour session can be debugged live
  // instead of waiting for the job log to be published after it ends.
  try {
    pendingLogLines.push(`${new Date().toISOString()} ${msg}`);
    if (pendingLogLines.length > 400) pendingLogLines.shift();
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => { logFlushTimer = null; void flushAgentLog(); }, 3000);
      logFlushTimer.unref?.();
    }
  } catch {}
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

/** Run a host shell command, never throwing; returns combined output. */
async function hostSh(cmd, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', cmd], {
      timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    return `${stdout || ''}${stderr || ''}`;
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

/** Is a qemu emulator process alive on this runner? */
async function qemuPids() {
  const out = await hostSh('pgrep -fa "qemu-system-x86_64" || true', 10000);
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d+\s*$/.test(l) && /qemu-system/.test(l));
}

/** Does adb currently expose a usable emulator transport? */
async function deviceOnline() {
  try {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 8000, killSignal: 'SIGKILL' });
    return /emulator-\d+\s+device\b/.test(stdout || '');
  } catch { return false; }
}

/** Forensics for the next (and this) crash: host memory, OOM kills, emulator log. */
async function captureEmulatorForensics(tag) {
  try {
    const report = {
      tag,
      at: new Date().toISOString(),
      qemu_processes: (await qemuPids()).length,
      free_mb: (await hostSh('free -m | head -3')).trim().slice(0, 600),
      disk: (await hostSh('df -h / /tmp 2>/dev/null | tail -3')).trim().slice(0, 600),
      top_rss: (await hostSh('ps -eo pid,rss,pcpu,etime,comm --sort=-rss | head -8')).trim().slice(0, 900),
      oom_kills: (await hostSh("(sudo -n dmesg 2>/dev/null || dmesg 2>/dev/null) | grep -iE 'killed process|out of memory|oom-kill' | tail -6 || true")).trim().slice(0, 900),
      emulator_log_tail: (await hostSh(`tail -c 1200 "${EMULATOR_RESTART_LOG}" 2>/dev/null || true`)).slice(-1200),
    };
    log('CRASH FORENSICS ' + JSON.stringify(report));
  } catch (e) {
    log('CRASH FORENSICS failed: ' + e.message);
  }
}

/** Cheap adb-only recovery (no 90s wait-for-device that stalls the duty loop). */
async function quickAdbRecovery() {
  try { await execFileAsync('adb', ['kill-server'], { timeout: 12000, killSignal: 'SIGKILL' }); } catch (_) {}
  await sleep(800);
  try { await execFileAsync('adb', ['start-server'], { timeout: 20000, killSignal: 'SIGKILL' }); } catch (_) {}
  await sleep(800);
  for (let i = 0; i < 6; i++) {
    if (await deviceOnline()) {
      const boot = (await adbShell('getprop sys.boot_completed', 15000).catch(() => ({ stdout: '' }))).stdout.trim();
      if (boot.startsWith('1')) return true;
    }
    await sleep(3000);
  }
  return false;
}

/** Recreate the scrcpy control + video channel for the (new) emulator instance. */
async function startLive() {
  liveDevice = await startLiveDevice((packet) => {
    lastEncodedPacketAt = Date.now();
    if (mediaWs?.readyState !== WebSocket.OPEN) return;
    const flags = packet.readBigUInt64BE(1), isConfig = Boolean(flags & (1n << 63n)), isKey = Boolean(flags & (1n << 62n));
    if (isConfig) { mediaWs.send(packet, { binary: true }); return; }
    if (!shouldStreamFrames) { mediaNeedsKey = true; return; }
    if (mediaWs.bufferedAmount > 128 * 1024) { mediaNeedsKey = true; return; }
    if (mediaNeedsKey && !isKey) return;
    if (isKey) mediaNeedsKey = false;
    mediaWs.send(packet, { binary: true });
  }, (profile) => {
    if (wsClient?.readyState === WebSocket.OPEN) wsClient.send(JSON.stringify({ type: 'stream_profile', profile }));
  });
  return liveDevice;
}

/**
 * Attach (or re-attach) the live display + touch channel, retrying until the guest
 * is ready. Right after a boot the scrcpy server can fail to bind its abstract
 * socket ("did not become ready"); a single attempt left the phone booted but with
 * a frozen picture, so this always retries and clears a stale server between tries.
 */
let liveAttachInFlight = false;
async function ensureLiveAttached(reason = 'watchdog') {
  if (liveAttachInFlight) return false;
  liveAttachInFlight = true;
  try {
    if (liveDevice?.ensureHealthy) {
      try {
        const h = await liveDevice.ensureHealthy();
        if (h?.ok) { mediaNeedsKey = true; return true; }
      } catch (_) {}
    }
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        // Stop the previous device object first: its recovery timer would otherwise
        // recreate a scrcpy server on the OLD scid that nobody is connected to, and
        // that orphan would keep the abstract socket and swallow taps.
        try { liveDevice?.close?.(); } catch (_) {}
        liveDevice = undefined;
        await hostSh('adb shell "ps -A -o PID,ARGS | grep genymobile.scrcpy | grep -v grep | awk \'{print $1}\' | while read p; do kill -9 $p 2>/dev/null; done" || true', 15000);
        await sleep(1500);
        await startLive();
        mediaNeedsKey = true;
        // Belt and braces: kill any server that is not one of the two we just made.
        if (liveDevice?.scids) {
          const keep = liveDevice.scids.map((x) => "scid=" + x).join(' -e ');
          await hostSh(`adb shell "ps -A -o PID,ARGS | grep genymobile.scrcpy | grep -v grep | grep -v -e ${keep} | awk '{print \$1}' | while read p; do kill -9 \$p 2>/dev/null; done" || true`, 15000);
        }
        if (wsClient && wsClient.readyState === WebSocket.OPEN && liveDevice?.profile) {
          wsClient.send(JSON.stringify({ type: 'stream_profile', profile: liveDevice.profile }));
        }
        log(`Live display + touch channel attached (${reason}, attempt ${attempt}).`);
        return true;
      } catch (e) {
        log(`Live display attach attempt ${attempt} failed (${reason}): ${e.message}`);
        if (attempt < 6) await sleep(6000);
      }
    }
    log('Live display attach FAILED after 6 attempts; the phone stays reachable via adb and will keep retrying.');
    return false;
  } finally {
    liveAttachInFlight = false;
  }
}

/** The phone is back on its feet: re-apply the Play/permission/realism tuning. */
async function afterBootTuning(where) {
  await prepareDevicePermissions().catch(() => {});
  for (const script of ['device-realism.sh', 'hide-root-emulator.sh']) {
    try {
      const { stdout, stderr } = await execFileAsync('bash', [path.join(SCRIPTS_DIR, script)], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      if (stdout) log(`[${where}] ${script}: ${String(stdout).trim().slice(-600)}`);
      if (stderr) log(`[${where}] ${script} note: ${String(stderr).trim().slice(-300)}`);
    } catch (e) { log(`[${where}] ${script} warning: ${e.message}`); }
  }
  await tunePlayStoreForEmulator().catch((e) => log(`[${where}] Play tune: ${e.message}`));
  await reconcileInstallQueue(where).catch((e) => log(`[${where}] Install reconcile: ${e.message}`));
  await dismissPlayStoreBlockers(where).catch((e) => log(`[${where}] Play blockers: ${e.message}`));
}

/**
 * Relaunch the emulator on THIS runner from the same AVD disk.
 * Zero data loss: the data disk already holds every app, account, setting and
 * download; this is exactly the disk the phone booted from.
 */
async function restartEmulatorLocally(reason = 'adb-lost') {
  if (emulatorRestartInFlight) return false;
  emulatorRestartInFlight = true;
  try {
    log(`EMULATOR SELF-HEAL: relaunching ${AVD_NAME} from its own disk (reason=${reason}; apps/accounts/data are preserved).`);
    await captureEmulatorForensics(reason);

    try { liveDevice?.close?.(); } catch (_) {}
    liveDevice = undefined;

    await hostSh('pkill -9 -f "qemu-system-x86_64" || true', 15000);
    // Free the runner's memory of stale helpers so the relaunch cannot inherit an
    // out-of-memory situation (the usual reason a cloud emulator disappears).
    await hostSh('pkill -9 -f "scrcpy" || true; pkill -9 -f "adb exec-out" || true', 12000);
    await sleep(1500);
    await hostSh('adb kill-server || true', 12000);
    await sleep(800);
    await hostSh('adb start-server || true', 20000);
    // Stale QEMU lock files make the relaunch fail with "AVD is already running".
    await hostSh(`rm -rf "${AVD_HOME}/${AVD_NAME}.avd"/*.lock "${AVD_HOME}/${AVD_NAME}.avd"/hardware-qemu.ini.lock 2>/dev/null || true`, 12000);

    const args = [
      '-avd', AVD_NAME, '-port', '5554', '-no-window', '-no-audio', '-no-boot-anim',
      '-no-snapshot-load', '-no-snapshot-save', '-gpu', 'swiftshader_indirect',
      '-camera-back', 'emulated', '-camera-front', 'emulated',
      '-dns-server', '8.8.8.8,1.1.1.1', '-netdelay', 'none', '-netspeed', 'full',
      '-memory', '6144', '-cores', '4',
      // Same boot properties as the workflow launch, so a self-healed emulator keeps
      // the slow-device timeout scaling and the verify-only install filter.
      '-prop', 'ro.hw_timeout_multiplier=10',
      '-prop', 'pm.dexopt.install=verify',
      '-prop', 'ro.product.model=Pixel_6',
    ];
    let logFd;
    try { logFd = fs.openSync(EMULATOR_RESTART_LOG, 'a'); } catch (_) { logFd = 'ignore'; }
    if (typeof logFd === 'number') {
      try { fs.writeSync(logFd, `\n===== local emulator relaunch ${new Date().toISOString()} reason=${reason} =====\n`); } catch (_) {}
    }
    const child = spawn(EMULATOR_BIN, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ANDROID_AVD_HOME: AVD_HOME, ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || '/usr/local/lib/android/sdk' },
    });
    child.unref();
    log(`EMULATOR SELF-HEAL: spawned ${EMULATOR_BIN} pid=${child.pid} (log: ${EMULATOR_RESTART_LOG}); waiting for Android to boot...`);

    const deadline = Date.now() + 7 * 60 * 1000;
    let booted = false;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (!(await deviceOnline())) continue;
      const boot = (await adbShell('getprop sys.boot_completed', 15000).catch(() => ({ stdout: '' }))).stdout.trim();
      if (boot.startsWith('1')) { booted = true; break; }
    }
    if (!booted) {
      log('EMULATOR SELF-HEAL FAILED: the emulator did not boot within 7 minutes.');
      await captureEmulatorForensics('restart-failed');
      await dispatchReplacementWorkflow().catch((e) => log('Replacement dispatch failed: ' + e.message));
      return false;
    }

    log('EMULATOR SELF-HEAL: Android booted; re-attaching display, control and tuning.');
    await sleep(2500);
    await adbShell('svc power stayon true; input keyevent 224', 20000).catch(() => {});

    shouldStreamFrames = true;
    if (await ensureLiveAttached('self-heal')) {
      log('EMULATOR SELF-HEAL: live display + touch re-attached.');
    }
    await afterBootTuning('self-heal').catch((e) => log('self-heal tuning: ' + e.message));

    consecutiveAdbFailures = 0;
    lastAdbHealthyAt = Date.now();
    lastChangeFingerprint = '';
    pendingChangeFp = '';
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      const di = await collectDeviceInfo().catch(() => ({}));
      try {
        wsClient.send(JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, deviceInfo: { ...di, degraded: false, adbRecovered: true, emulatorRestarted: true } }));
      } catch (_) {}
    }
    await deviceDoctor('post-self-heal').catch(() => {});
    log('EMULATOR SELF-HEAL COMPLETE: the phone is live again with its data intact.');
    return true;
  } catch (e) {
    log('EMULATOR SELF-HEAL error: ' + e.message);
    return false;
  } finally {
    emulatorRestartInFlight = false;
  }
}

async function recoverAdbConnection() {
  log('ADB recovery: full reconnect (fixes stuck screen when emulator-5554 vanishes)');
  try { await execFileAsync('adb', ['reconnect'], { timeout: 15000 , killSignal: 'SIGKILL' }); } catch (_) {}
  try { await execFileAsync('adb', ['disconnect'], { timeout: 10000 , killSignal: 'SIGKILL' }); } catch (_) {}
  try { await execFileAsync('adb', ['kill-server'], { timeout: 15000 , killSignal: 'SIGKILL' }); } catch (_) {}
  await sleep(1200);
  try { await execFileAsync('adb', ['start-server'], { timeout: 20000 , killSignal: 'SIGKILL' }); } catch (_) {}
  await sleep(1500);
  // Emulator console ports commonly used on Actions runners
  for (const endpoint of ['127.0.0.1:5555', '127.0.0.1:5557', 'emulator-5554', '127.0.0.1:5554']) {
    try { await execFileAsync('adb', ['connect', endpoint], { timeout: 8000 , killSignal: 'SIGKILL' }); } catch (_) {}
  }
  try { await execFileAsync('adb', ['reconnect', 'offline'], { timeout: 12000 , killSignal: 'SIGKILL' }); } catch (_) {}
  try { await execFileAsync('adb', ['wait-for-device'], { timeout: 90000 , killSignal: 'SIGKILL' }); } catch (e) { log('wait-for-device: ' + e.message); }
  // Never `adb unroot` here: on this Play image adbd is already unprivileged and
  // `adb unroot` restarts adbd, dropping the transport we are trying to restore.
  try {
    const { stdout } = await execFileAsync('adb', ['devices', '-l'], { timeout: 10000 , killSignal: 'SIGKILL' });
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
      await execFileAsync('adb', ['shell', 'input keyevent 224; input keyevent 82; svc power stayon true'], { timeout: 15000 , killSignal: 'SIGKILL' });
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
    killSignal: 'SIGKILL', // adb ignores SIGTERM; without this a hung shell blocks forever
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: stdout || '', stderr: stderr || '' };
}

/** Detect Play/DownloadManager/PackageInstaller activity.
 * A whole-AVD capture runs `adb emu avd stop` (virtual CPU paused) while the
 * disk image is copied. Freezing the guest in the middle of a Play download is
 * what makes an installation sit at "Downloading/Pending" forever: the
 * DownloadManager socket times out and the queued install session never
 * completes. Any sign of an in-flight download or install must therefore defer
 * the capture, not merely slow it down.
 */
async function isGuestBusyForPersist() {
  try {
    const dl = (await adbShell('dumpsys download 2>/dev/null | head -100', 15000)).stdout || '';
    if (/Status:\s*(190|192|193|194|195|196)/i.test(dl) || /STATUS_(RUNNING|PENDING|PAUSED)/i.test(dl)) return 'download_manager';
    // PackageInstaller sessions (Play Store commits installs through them).
    const sessions = (await adbShell('dumpsys package installer 2>/dev/null | grep -iE "session|active=" | head -30', 15000)).stdout || '';
    if (/\bactive=true\b|\bsealed=true\b/i.test(sessions)) return 'package_installer_session';
    const inst = (await adbShell('dumpsys package installer 2>/dev/null | grep -iE "sessionId|Session [0-9]|active|staged" | head -20', 15000)).stdout || '';
    if (/active=true|sealed=true|SessionId;i=0/i.test(inst) && !/No sessions/i.test(inst)) return 'package_installer';
    // Google Play downloads its APKs itself (no DownloadManager entry, and the
    // installer session only appears at commit time), so a 179MB TikTok transfer
    // looked "idle" and a whole-AVD capture could pause it. Ask the two places
    // Play does report progress: its download notification and its service list.
    const notif = (await adbShell('dumpsys notification --noredact 2>/dev/null | grep -iE "android\\.(title|text)=.*(download|install)" | head -20', 15000)).stdout || '';
    if (/download|install/i.test(notif)) return 'play_transfer_notification';
    const svc = (await adbShell('dumpsys activity services com.android.vending 2>/dev/null | grep -iE "Download|Install" | head -20', 15000)).stdout || '';
    if (/download|install/i.test(svc)) return 'play_download_service';
    const act = (await adbShell('dumpsys activity activities 2>/dev/null | grep -iE "vending|PackageInstaller|Download" | head -25', 15000)).stdout || '';
    if (/DOWNLOADING|downloading|Installing|INSTALLING|Pending\.{0,3}$/i.test(act)) return 'play_or_installer_ui';
    // NOTE: an idle Play Store home/listing screen is NOT a reason to skip a
    // capture. Blocking on it meant a session that ended on the store never
    // persisted anything and lost every install at the next rotation. Only real
    // transfer/install activity (checked above) defers a capture; the pause for a
    // capture is a few seconds and the resume is verified.
  } catch (_) {}
  return null;
}

/**
 * ROOT CAUSE — Google Play "Complete account setup" gate.
 *
 * On this device the store shows a sheet titled "Complete account setup —
 * Add a payment option to complete your account" (Skip / Add card / Add PayPal)
 * and REFUSES to start any download until it is dismissed. Every install from the
 * website therefore sat at "Pending" and never completed — repeatedly, on every
 * rotation, because the sheet reappears.
 *
 * Dismissing it is free and harmless: we tap "Skip" (no payment method, no
 * purchase, no account change). The sheet is also dismissed proactively so a user
 * who taps Install in the store UI gets a download instead of a dead button.
 */
async function uiDumpXml() {
  try {
    await adbShell('uiautomator dump /sdcard/vibely_ui.xml >/dev/null 2>&1', 25000);
    return (await adbShell('cat /sdcard/vibely_ui.xml 2>/dev/null', 25000)).stdout || '';
  } catch { return ''; }
}

function uiFind(xml, pattern) {
  for (const node of xml.match(/<node[^>]*>/g) || []) {
    const text = (node.match(/text="([^"]*)"/) || [])[1] || '';
    const desc = (node.match(/content-desc="([^"]*)"/) || [])[1] || '';
    if (!pattern.test(`${text} ${desc}`)) continue;
    const b = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), label: (text || desc).slice(0, 60) };
  }
  return null;
}

async function dismissPlayStoreBlockers(where = 'periodic') {
  const xml = await uiDumpXml();
  if (!xml) return { ok: false, reason: 'no_ui_dump' };
  const top = (await adbShell('dumpsys activity activities | grep -m1 topResumedActivity', 15000)).stdout || '';
  const isStore = /com\.android\.vending|packageinstaller/i.test(top);

  const gateSheet = /Complete account setup|Add a payment option|Review your account to continue/i.test(xml);
  const skip = uiFind(xml, /^(Skip|Not now|No thanks|Maybe later|Do this later|Close sheet)$/i);
  const ack = uiFind(xml, /^(Got it|OK|Allow|Continue|Accept|Done|Dismiss)$/i);
  const signInWall = /Sign in to your Google Account|Sign in$/i.test(xml) && !/Install/i.test(xml);

  const result = { where, gate_sheet: gateSheet, action: null, is_store: isStore };
  if (signInWall) {
    result.action = 'sign_in_required';
    log('WARNING: Play Store is asking for a Google sign-in; an install cannot proceed until the account is signed in again.');
    return result;
  }
  if (gateSheet && skip) {
    await adbShell(`input tap ${skip.x} ${skip.y}`, 15000);
    result.action = `dismissed_account_setup_gate(${skip.label})`;
    log(`[play-blockers] ${where}: dismissed "Complete account setup" sheet via "${skip.label}" — Play can install again.`);
    await sleep(2500);
    return result;
  }
  if (gateSheet && ack) {
    await adbShell(`input tap ${ack.x} ${ack.y}`, 15000);
    result.action = `advanced_account_setup_gate(${ack.label})`;
    log(`[play-blockers] ${where}: advanced account setup gate via "${ack.label}".`);
    await sleep(2500);
    return result;
  }
  if (ack && isStore) {
    await adbShell(`input tap ${ack.x} ${ack.y}`, 15000);
    result.action = `dismissed_dialog(${ack.label})`;
    return result;
  }
  return result;
}

/** Real-device health/install-path diagnostics. Evidence first, never guesses. */
async function deviceDoctor(reason = 'periodic') {
  const report = {};
  const sh = async (cmd, t = 25000) => { try { return (await adbShell(cmd, t)).stdout.trim(); } catch (e) { return 'ERR:' + e.message; } };
  report.reason = reason;
  report.at = new Date().toISOString();
  report.boot_completed = await sh('getprop sys.boot_completed');
  report.uptime_guest = await sh('cat /proc/uptime');
  report.data_free = await sh("df -h /data | tail -1");
  report.sdcard_free = await sh("df -h /sdcard | tail -1");
  report.low_ram = await sh("cat /proc/meminfo | head -3 | tr '\\n' ' '");
  report.play_version = await sh('dumpsys package com.android.vending | grep -m1 versionName');
  report.gms_version = await sh('dumpsys package com.google.android.gms | grep -m1 versionName');
  report.gsf_present = await sh('pm path com.google.android.gsf');
  report.account_count = await sh("dumpsys account | grep -c 'Account {name=' ");
  report.play_protect = await sh('settings get global package_verifier_enable');
  report.installer_sessions = await sh('pm list sessions -a 2>/dev/null | head -20');
  report.downloads = await sh('dumpsys download 2>/dev/null | grep -E "Status:|Uri:" | head -20');
  report.clock_skew_sec = await sh('echo $(( $(date +%s) - ' + Math.floor(Date.now() / 1000) + ' ))');
  report.device_idle = await sh('dumpsys deviceidle enabled 2>/dev/null | head -2');
  report.top_resumed = await sh('dumpsys activity activities | grep -m1 ResumedActivity');
  report.loadavg = await sh('cat /proc/loadavg');
  report.thermal = await sh('cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -3 | tr "\\n" " "');
  log('DOCTOR ' + JSON.stringify(report));
  return report;
}

/**
 * Reconcile a broken Play/installer queue WITHOUT touching user data.
 * A checkpoint captured mid-install can leave PackageInstaller sessions and
 * DownloadManager rows that can never finish; the store then shows
 * "Installing…/Pending" forever after every boot. Abandon only sessions the
 * system itself reports as inactive/stale, and restart the store only when
 * nothing is downloading.
 */
async function reconcileInstallQueue(where = 'promote') {
  try {
    // Never touch the queue while anything is genuinely in flight.
    const inFlight = await isGuestBusyForPersist();
    if (inFlight) { log(`Install queue reconcile (${where}): guest busy (${inFlight}) — leaving the queue untouched.`); return { busy: inFlight }; }
    // `pm list sessions` is not available on every build; the package service dump
    // always is.
    const sessions = (await adbShell('dumpsys package installer 2>/dev/null | head -80', 25000)).stdout || '';
    const ids = [...sessions.matchAll(/Session \[(\d+)\]/g)].map((m) => m[1]);
    const stale = ids.filter((_, i) => /Session \[\d+\][\s\S]{0,200}?active=false/.test(sessions.split('Session [')[i + 1] || ''));
    for (const id of stale.slice(0, 20)) {
      try { await adbShell(`pm install-abandon ${id}`, 20000); log(`Abandoned stale install session ${id}`); } catch (_) {}
    }
    if (!stale.length) log('Install queue reconcile: no stale PackageInstaller sessions.');
    // Restarting the store drops no account and no app data; it clears a wedged
    // Finsky download worker. Only done when nothing is in flight.
    await adbShell('am force-stop com.android.vending', 15000).catch(() => {});
    await sleep(1500);
    await adbShell('monkey -p com.android.vending -c android.intent.category.LAUNCHER 1', 20000).catch(() => {});
    log(`Install queue reconcile (${where}): Play Store worker restarted cleanly.`);
    return { stale: stale.length, busy: null };
  } catch (e) {
    log('Install queue reconcile warning: ' + e.message);
    return { error: e.message };
  }
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

let lastWholeAvdAt = 0;
let persistLeaseUntil = 0;
let lastGuestChangeAt = Date.now();

/** Suppress whole-AVD captures while a critical live operation runs (e.g. the
 * Play Store install test), because a capture pauses the guest. */
async function withPersistLease(ms, fn) {
  const prev = persistLeaseUntil;
  persistLeaseUntil = Math.max(persistLeaseUntil, Date.now() + ms);
  try {
    return await fn();
  } finally {
    // Release immediately when the critical section ends so the change it made
    // (e.g. a finished Play install) is persisted without waiting for the full lease.
    persistLeaseUntil = prev;
  }
}

async function activeViewerCount() {
  try {
    const r = await fetch(`${GATEWAY_URL}/api/public/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return 0;
    const j = await r.json();
    return Number(j.viewers || 0) + Number(j.control_clients || 0);
  } catch { return 0; }
}

/** Live persistence.
 *
 *  `whole` is the ONLY path that preserves Google sign-in and full app data on a
 *  Play system image (adb is unprivileged there, so per-app tar backups cannot
 *  read /data/user/0).
 *
 *  But a whole-AVD capture pauses the virtual CPU while the multi-gigabyte disk
 *  image is copied, so it must never run while Play Store/DownloadManager has
 *  work in flight and it must not run on every fingerprint change — that is what
 *  froze installs at "Downloading…". Captures are now rate limited (default
 *  45 min) plus a quiet-window check, and a forced capture (rotation) skips only
 *  the rate limit.
 */
async function livePersist(reason = 'periodic', { whole = false, hold = false, force = false } = {}) {
  log(`Live persist start (${reason}, whole=${whole}, hold=${hold}, force=${force})`);
  let captured = false;
  try {
    const out = await runStateManager('backup', { reason, hold, force, whole });
    captured = out !== false;
  } catch (e) {
    log(`Live persist warning (${reason}): ${e.message}`);
  }
  log(`Live persist done (${reason})`);
  // A checkpoint pauses the guest; if it did not come back, bring the phone back
  // immediately instead of waiting for the supervisor to notice.
  if (captured && process.env.GITHUB_AVD_ONLY === 'true' && !(await deviceOnline())) {
    log('Post-capture check: guest is not answering adb - relaunching the emulator now.');
    setTimeout(() => { restartEmulatorLocally('post-capture-guest-dead').catch(() => {}); }, 500);
  }
  return captured;
}

async function runStateManager(mode, opts = {}) {
  const run = async () => {
    if(process.env.GITHUB_AVD_ONLY==='true'){
      // Whole-AVD is authoritative. Restore already happened pre-boot in the workflow.
      if(mode==='restore'){log('Native-verified whole AVD already restored pre-boot; skipping logical restore.');return;}
      const hold = Boolean(opts.hold);
      const force = Boolean(opts.force) || hold;
      if (!force && Date.now() - lastWholeAvdAt < WHOLE_AVD_MIN_INTERVAL_MS) {
        log(`Whole-AVD capture skipped (rate limit: ${Math.round((Date.now()-lastWholeAvdAt)/60000)}m < ${WHOLE_AVD_MIN_INTERVAL_MS/60000}m since last; reason=${opts.reason||mode})`);
        return false;
      }
      if (!hold) {
        if (Date.now() < persistLeaseUntil) {
          log(`Whole-AVD capture deferred (persistence lease active for ${Math.round((persistLeaseUntil - Date.now()) / 1000)}s).`);
          return false;
        }
        const busy = await isGuestBusyForPersist();
        if (busy) { log(`Whole-AVD capture deferred (guest busy: ${busy}); installs/downloads must not be frozen.`); return false; }
        // Do not freeze a phone somebody is actively watching/using -- but a viewer
        // must not block the authoritative capture indefinitely: that is how the
        // TikTok install and every change after 18:00 were lost from the state
        // generation. Once a change has been unpersisted past the grace window we
        // capture anyway (seconds of viewer stutter beats losing installed apps).
        const viewers = await activeViewerCount();
        const pendingMs = pendingChangeSince ? Date.now() - pendingChangeSince : 0;
        if (viewers > 0 && pendingMs < VIEWER_CAPTURE_GRACE_MS) {
          log(`Whole-AVD capture deferred (${viewers} live viewer attached; change pending ${Math.round(pendingMs/1000)}s, forcing at ${Math.round(VIEWER_CAPTURE_GRACE_MS/1000)}s).`);
          return false;
        }
        if (viewers > 0) log(`Whole-AVD capture proceeding despite ${viewers} viewer(s): change unpersisted ${Math.round(pendingMs/60000)}min (grace ${Math.round(VIEWER_CAPTURE_GRACE_MS/60000)}min).`);
        const quietSec = Math.round((Date.now() - lastGuestChangeAt) / 1000);
        if (quietSec < 120) { log(`Whole-AVD capture deferred (guest changed ${quietSec}s ago; need 120s of quiet).`); return false; }
      }
      const started = Date.now();
      const env={...process.env,EMULATOR_SESSION_ID:SESSION_ID,CHECKPOINT_HOLD:hold?'true':'false',AVD_DIR:process.env.AVD_DIR||`${process.env.HOME}/.android/avd/vibely_pixel6_api34.avd`};
      try {
        const {stdout,stderr}=await execFileAsync('python3',[path.join(SCRIPTS_DIR,'github_live_checkpoint.py')],{timeout:1800000,maxBuffer:16*1024*1024,env});
        if(stdout)process.stdout.write(stdout);if(stderr)process.stderr.write(stderr);
        lastWholeAvdAt = Date.now();
        log(`Whole-AVD checkpoint published in ${Math.round((Date.now()-started)/1000)}s (reason=${opts.reason||mode}, hold=${hold}).`);
      } catch (e) {
        log(`Whole-AVD checkpoint failed after ${Math.round((Date.now()-started)/1000)}s: ${e.message}`);
      }
      return;
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
    killSignal: 'SIGKILL',
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

  // `adb root` is unsupported on google_apis_playstore production builds and the
  // attempt restarts adbd. Only try it when the shell is not already root.
  try {
    const who = await adbShell('id', 8000);
    if (!/uid=0/.test(who.stdout || '')) log('Guest adbd is unprivileged (expected on Play images); continuing as shell.');
  } catch (_) {}

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
    case 'live_input': if(!liveDevice)throw new Error('Live Android control is not ready');lastLiveInputAt=Date.now();liveDevice.input(payload);return {injected_at:Date.now()};
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
        const { stdout, stderr } = await execFileAsync('adb', ['install', '-r', '-g', tmpApk], { timeout: 110000 , killSignal: 'SIGKILL' });
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
        await execFileAsync('adb', ['push', tmpLocal, dest], { timeout: 45000 , killSignal: 'SIGKILL' });
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

function connectTunnelWebSocket(deviceInfo, force = false) {
  if (!force && wsClient && wsClient.readyState === WebSocket.OPEN) return Promise.resolve(wsClient);
  if (force && wsClient) {
    // Replace the transport deliberately: detach the auto-reconnect handler so a
    // forced reconnect cannot start a second recovery loop.
    try { wsClient.removeAllListeners('close'); wsClient.close(); } catch {}
    wsClient = null;
  }
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

let postPromotionDone = false;
let installTestStarted = false;

/** Everything that must happen once this emulator owns the active pointer.
 * Deliberately does NOT run a whole-AVD checkpoint: the disk was just restored,
 * and a capture pauses the guest for minutes right when the phone goes live.
 */
async function onPromoted() {
  if (postPromotionDone) return;
  postPromotionDone = true;

  // Soft permission grants + dialog cleanup (never force-stops a user app).
  await prepareDevicePermissions().catch(() => {});

  // Device realism: Pixel-6 hardware identity, sensors, telephony, sleep policy.
  try {
    const realism = path.join(SCRIPTS_DIR, 'device-realism.sh');
    const { stdout, stderr } = await execFileAsync('bash', [realism], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (stdout) log(String(stdout).trim().slice(-2000));
    if (stderr) log('device-realism note: ' + String(stderr).trim().slice(-500));
  } catch (e) { log('device-realism warning: ' + e.message); }

  // Root surface check (Play images are unrooted by design; no adb root here).
  try {
    const hide = path.join(SCRIPTS_DIR, 'hide-root-emulator.sh');
    const { stdout, stderr } = await execFileAsync('bash', [hide], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout) log(String(stdout).trim().slice(-1500));
    if (stderr) log('hide-root note: ' + String(stderr).trim().slice(-400));
  } catch (e) { log('hide-root warning: ' + e.message); }

  // Claim GitHub state ownership so this session can publish checkpoints.
  try {
    const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS_DIR, 'github_state.py'), 'claim', '--owner', SESSION_ID], {
      timeout: 120000, env: { ...process.env, EMULATOR_SESSION_ID: SESSION_ID },
    });
    if (stdout) log('GitHub state claim: ' + String(stdout).trim());
  } catch (e) { log('GitHub state claim warning: ' + e.message); }

  // Play Store download/install path (background, device-idle and storage friendly).
  await tunePlayStoreForEmulator().catch((e) => log('Play tune: ' + e.message));
  await reconcileInstallQueue('promote').catch((e) => log('Install reconcile: ' + e.message));
  // Clear the "Complete account setup / Add a payment option" gate that silently
  // blocks every Play download (the real cause of stuck installations).
  await dismissPlayStoreBlockers('promote').catch((e) => log('Play blockers: ' + e.message));
  await deviceDoctor('post-promotion').catch((e) => log('Doctor: ' + e.message));

  // NOTE: no whole-AVD checkpoint here. The data disk this emulator booted from is
  // already the published checkpoint, and a capture pauses the guest for minutes
  // exactly when the phone becomes available. Captures happen later, driven by
  // rotation (forced) or the rate-limited change/safety schedule.

  // Optional real Play Store install test, run in the background so the duty loop
  // (heartbeats, self-healing, watchdog) is never blocked by UI automation.
  if (INSTALL_TEST_PACKAGE && !installTestStarted) {
    installTestStarted = true;
    (async () => {
      await withPersistLease(30 * 60 * 1000, async () => {
        try {
          log(`Running real Play Store install test for ${INSTALL_TEST_PACKAGE} (whole-AVD captures leased out for 30m)...`);
          const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS_DIR, 'play_install_test.py'), '--package', INSTALL_TEST_PACKAGE, '--json', '/tmp/vibely_install_test.json'], {
            timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
          });
          log('INSTALL TEST OUTPUT:\n' + String(stdout).slice(-6000));
        } catch (e) {
          log('INSTALL TEST FAILED: ' + e.message);
          if (e.stdout) log('INSTALL TEST STDOUT:\n' + String(e.stdout).slice(-6000));
        }
      });
      await reconcileInstallQueue('post-install-test').catch(() => {});
      await livePersist('post-install-test', { whole: true, hold: false, force: true }).catch((e) => log(`Post-test persist: ${e.message}`));
    })().catch((e) => log('Install test top-level: ' + e.message));
  }
}

/** Verify this emulator end-to-end through the public gateway, then promote it.
 *
 * Safe to call repeatedly (boot, gateway restart, duty loop). Returns true once
 * this session owns the active pointer.
 */
async function promoteIntoTunnel(reason = null, { attempts = 4, baseDelayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (!wsClient || wsClient.readyState !== WebSocket.OPEN) await connectTunnelWebSocket(await collectDeviceInfo().catch(() => ({})), true);

      const verResp = await gatewayFetch(`/api/internal/verify-standby/${encodeURIComponent(SESSION_ID)}`, { method: 'POST' });
      const verJson = await verResp.json().catch(() => ({}));
      if (!verResp.ok || !verJson.verified) {
        // A stale/paused guest cannot produce a frame; retry after the current
        // ADB work finishes instead of aborting the whole workflow.
        throw new Error(`verify-standby rejected: ${JSON.stringify(verJson).slice(0, 240)}`);
      }
      log(`Remote standby verification PASSED (${verJson.frame_bytes}B frame over tunnel, attempt ${attempt}).`);

      const hoResp = await gatewayFetch('/api/internal/handover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_session_id: SESSION_ID,
          // Emergency-recovery only. Rotating a live phone MUST be allowed to
          // replace the live source, otherwise every rotation is refused and the
          // old emulator is killed with no successor.
          expect_empty: EMERGENCY_EMPTY_ONLY,
          // The new emulator already restored the authoritative encrypted whole
          // AVD, so the gateway must not block the cutover on a live delta RPC.
          state_source: process.env.GITHUB_AVD_ONLY === 'true' ? 'github-whole-avd' : 'live-delta',
          reason: reason || (RAPID_TEST_CYCLES > 0 ? 'rapid_e2e_rotation_verification' : 'automatic_4h_workflow_rotation'),
        }),
      });
      const hoJson = await hoResp.json().catch(() => ({}));
      if (!hoResp.ok || !hoJson.ok) throw new Error(`handover rejected: ${JSON.stringify(hoJson).slice(0, 240)}`);

      promotedAtMs = Date.now();
      log(`HANDOVER COMPLETE! Active session is now ${SESSION_ID} (cutover=${hoJson.cutover_ms}ms, stateSynced=${hoJson.state_synced}, prev=${hoJson.previous_session_id || 'none'}).`);
      return true;
    } catch (err) {
      log(`Promotion attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) await sleep(baseDelayMs * attempt);
    }
  }
  return false;
}

/** Ask the gateway whether this session is still the active one. */
async function gatewayActiveSessionId() {
  try {
    const r = await fetch(`${GATEWAY_URL}/api/public/health`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return undefined;
    const j = await r.json();
    return j.active_pointer === undefined ? (j.active_session_id || null) : j.active_pointer;
  } catch { return undefined; }
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
        const activeId = await gatewayActiveSessionId();
        if (activeId === undefined) throw new Error('Gateway health unavailable');
        if (activeId && activeId !== SESSION_ID) {
          log(`Another session (${activeId}) is active; retiring this superseded emulator cleanly.`);
          retiring = true;
          try { wsClient?.close(); } catch {}
          process.exit(0);
        }
        if (!activeId) {
          const ok = await promoteIntoTunnel('gateway_restart_recovery', { attempts: 3 });
          if (!ok) throw new Error('Reconnect promotion failed');
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

/**
 * Independent emulator supervisor.
 *
 * Runs on its own timer, outside the duty loop, so a dead emulator is detected and
 * repaired even when the loop itself is stuck in a long await. This is the piece
 * that guarantees the phone comes back instead of hanging until the 6h timeout.
 */
let supervisorStarted = false;
let supervisorBackoffUntil = 0;
let simulationDone = false;
function startEmulatorSupervisor() {
  if (supervisorStarted) return;
  supervisorStarted = true;

  const tick = async () => {
    try {
      if (emulatorRestartInFlight || adbRecoveryInFlight) return;
      if (Date.now() < supervisorBackoffUntil) return;
      const simAfter = Number(process.env.VIBELY_SIMULATE_CRASH_AFTER_SEC || 0);
      if (simAfter > 0 && !simulationDone && promotedAtMs && (Date.now() - promotedAtMs) / 1000 >= simAfter) {
        simulationDone = true;
        log(`SIMULATION: killing the emulator process to prove self-heal (after ${Math.round((Date.now() - promotedAtMs) / 1000)}s of live service).`);
        await hostSh('pkill -9 -f "qemu-system-x86_64" || true', 15000);
        await sleep(3000);
      }
      if (await deviceOnline()) {
        lastAdbHealthyAt = Date.now();
        // The OS is up: make sure the live picture/touch channel is up too.
        // A static Android screen legitimately produces no new H.264 frames, so
        // silence alone is NOT a fault. Only re-attach when a frame is actually
        // expected: a viewer just interacted (input with no picture afterwards),
        // or the device object reports a dead channel.
        if (liveDevice && !liveAttachInFlight) {
          const sinceInput = Date.now() - lastLiveInputAt;
          const sincePacket = Date.now() - lastEncodedPacketAt;
          if (lastLiveInputAt && sinceInput < 20000 && sincePacket > 8000) {
            log(`SUPERVISOR: input ${Math.round(sinceInput / 1000)}s ago but no video for ${Math.round(sincePacket / 1000)}s - re-attaching the display.`);
            ensureLiveAttached('input-without-frame').catch(() => {});
            return;
          }
          try {
            const h = await liveDevice.ensureHealthy();
            if (!h?.ok) { log('SUPERVISOR: live channel unhealthy (' + JSON.stringify(h) + ') - re-attaching.'); ensureLiveAttached('unhealthy').catch(() => {}); return; }
          } catch (_) {}
        }
        // Orphan sweep: scrcpy servers survive client disconnects, and a leftover
        // server keeps the abstract socket and swallows taps. Keep only the newest
        // server pair (wrapper + app_process = the two highest PIDs).
        try {
          const psOut = await hostSh(`adb shell "ps -A -o PID,ARGS | grep genymobile.scrcpy.Server | grep -v grep | awk '{print \$1}' | sort -n"`, 15000);
          const pids = psOut.split(/\n+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
          if (pids.length > 2) {
            const doomed = pids.slice(0, pids.length - 2);
            await hostSh(`adb shell "kill -9 ${doomed.join(' ')}" || true`, 12000);
            log(`Orphan sweep: killed ${doomed.length} stale scrcpy server process(es).`);
          }
        } catch (_) {}
        if (!liveDevice && !liveAttachInFlight) {
          const boot = (await adbShell('getprop sys.boot_completed', 15000).catch(() => ({ stdout: '' }))).stdout.trim();
          if (boot.startsWith('1')) ensureLiveAttached('supervisor').catch(() => {});
        }
        return;
      }
      const deadSec = Math.round((Date.now() - lastAdbHealthyAt) / 1000);
      if (deadSec < 40) return;
      log(`SUPERVISOR: emulator unreachable for ${deadSec}s (duty tick age ${Math.round((Date.now() - lastDutyTickAt) / 1000)}s) - starting self-heal.`);
      adbRecoveryInFlight = true;
      let healed = false;
      try {
        const qemu = await qemuPids();
        if (qemu.length) {
          const ok = await quickAdbRecovery();
          if (ok) { healed = true; lastAdbHealthyAt = Date.now(); log('SUPERVISOR: adb transport recovered.'); return; }
        }
        healed = await restartEmulatorLocally(qemu.length ? 'supervisor-adb-dead' : 'supervisor-qemu-gone');
      } finally {
        adbRecoveryInFlight = false;
        if (healed) { lastAdbHealthyAt = Date.now(); supervisorBackoffUntil = 0; }
        else supervisorBackoffUntil = Date.now() + 5 * 60 * 1000;
      }
    } catch (e) {
      log('SUPERVISOR error: ' + e.message);
    }
  };

  const timer = setInterval(tick, 20000);
  timer.unref?.();
  log('Emulator supervisor started (20s interval; relaunches the same AVD if the phone dies).');
}

process.on('unhandledRejection', (err) => {
  try { log('UNHANDLED REJECTION (kept alive): ' + (err?.message || String(err))); } catch (_) {}
});
process.on('uncaughtException', (err) => {
  try { log('UNCAUGHT EXCEPTION (kept alive): ' + (err?.message || String(err))); } catch (_) {}
});

async function main() {
  if (!GATEWAY_URL || !GATEWAY_SECRET) {
    throw new Error('EMULATOR_GATEWAY_URL and EMULATOR_GATEWAY_SECRET must be set');
  }

  await wakeGatewayOnBlitz();
  await verifyLocalEmulatorReadiness();

  // Pre-load persisted state onto this new emulator while isolated in standby
  await runStateManager('restore');
  const deviceInfo = await collectDeviceInfo();
  await startLive();
  startEmulatorSupervisor();
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

  // Verify + promote, with bounded retries and self-healing.
  // ROOT CAUSE: this used to be a single attempt that threw on any hiccup. The
  // throw killed the emulator workflow, the phone went dark, and the next cron
  // run repeated the same failure 33 times.
  const promoted = await promoteIntoTunnel();
  if (promoted) await onPromoted();
  if (!promoted) {
    await gatewayFetch('/api/internal/report-failed-candidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID,
        github_run_id: RUN_ID,
        reason: 'Standby verification/handover did not complete; staying connected as standby and retrying',
      }),
    }).catch(() => {});
    log('Handover not completed yet — remaining connected as standby; duty loop will keep retrying.');
  }

  // PRIMARY persistence = change-triggered write-through (package/account/settings).
  // Secondary safety net = infrequent whole-AVD only if something was missed.
  const CHANGE_POLL_MS = 20 * 1000;
  const SAFETY_WHOLE_MS = 60 * 60 * 1000; // safety net only; captures pause the guest
  let lastWholeAvdMs = Date.now();
  let lastBlitzWakeMs = Date.now();
  let changePersistInFlight = false;
  let lastSelfHealMs = 0;
  let lastDoctorMs = Date.now();
  let lastPlayGateCheckMs = 0;
  let lastActiveSeenMs = Date.now();

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
      lastDutyTickAt = Date.now();
      const devices = await execFileAsync('adb', ['devices'], { timeout: 10000 , killSignal: 'SIGKILL' }).then(r => r.stdout || '').catch(e => e.message);
      if (!/emulator-\d+\s+device/.test(devices)) {
        consecutiveAdbFailures += 1;
        log(`CRITICAL: adb has no emulator device (${consecutiveAdbFailures} consecutive)`);
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({ type: 'heartbeat', sessionId: SESSION_ID, deviceInfo: { degraded: true, adbRecovered: false, adbDevices: devices, selfHealing: true } }));
        }
        // Recovery never blocks the loop: heartbeats, the log relay and every other
        // duty must keep running while the phone is being brought back.
        if (!adbRecoveryInFlight && !emulatorRestartInFlight) {
          adbRecoveryInFlight = true;
          (async () => {
            const qemu = await qemuPids();
            if (!qemu.length) {
              // The emulator process itself is gone - only a relaunch can fix this.
              log('No qemu process on this runner: adb recovery cannot help, relaunching the emulator.');
              await restartEmulatorLocally('qemu-process-gone');
              return;
            }
            const ok = await quickAdbRecovery();
            if (ok) {
              log('ADB quick recovery succeeded.');
              consecutiveAdbFailures = 0;
              lastAdbHealthyAt = Date.now();
              return;
            }
            log('ADB quick recovery failed while qemu is alive (device offline): relaunching the emulator.');
            await restartEmulatorLocally('adb-transport-dead');
          })()
            .catch((e) => log('Recovery error: ' + e.message))
            .finally(() => { adbRecoveryInFlight = false; });
        }
        if (consecutiveAdbFailures >= 8 && !emulatorRestartInFlight) {
          log('WATCHDOG: still no device after repeated self-heal - requesting a replacement runner.');
          await dispatchReplacementWorkflow().catch(() => {});
          consecutiveAdbFailures = 0;
        }
      } else {
        consecutiveAdbFailures = 0;
        lastAdbHealthyAt = Date.now();
        // Soft-clear stuck system permission dialogs only (never force-stop apps)
        try { await prepareDevicePermissions(); } catch (_) {}

        // Keep display awake - frozen black/last-frame is often a sleeping surface
        try {
          await adbShell('svc power stayon true; input keyevent 224', 12000);
        } catch (_) {}

        // Revive the live display/touch channel if it is missing or degraded
        // (root cause of "stuck screen": picture frozen while the OS is fine).
        if (!liveDevice) {
          if (!liveAttachInFlight) ensureLiveAttached('duty-loop').catch(() => {});
        } else if (lastLiveInputAt && Date.now() - lastLiveInputAt < 20000 &&
                   Date.now() - lastEncodedPacketAt > 8000) {
          log('Input sent but no video frame arrived - re-attaching the display channel.');
          ensureLiveAttached('input-without-frame').catch(() => {});
        } else if (liveDevice.ensureHealthy) {
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

    // 1b. SELF-HEALING OWNERSHIP: if the gateway has no active phone (container
    // restart, reaped session, failed rotation) this emulator re-verifies and
    // promotes itself. Without this the phone stayed dark while the agent sat in
    // the duty loop as an unverified standby until the 4h rotation.
    if (Date.now() - lastSelfHealMs > 60000) {
      lastSelfHealMs = Date.now();
      try {
        const activeId = await gatewayActiveSessionId();
        if (activeId === undefined) {
          log('Self-heal: gateway health unreachable; waking it.');
          await wakeGatewayOnBlitz();
        } else if (activeId === SESSION_ID) {
          lastActiveSeenMs = Date.now();
          if (!promotedAtMs) promotedAtMs = Date.now();
        } else if (!activeId) {
          log(`Self-heal: gateway has no active phone (ours is ${SESSION_ID}); promoting.`);
          if (await promoteIntoTunnel('self_heal_no_active')) await onPromoted();
        } else if (FORCE_TAKEOVER && activeId !== SESSION_ID) {
          // A booted emulator is a legitimate replacement candidate: the workflow
          // coordination already decided this run should own a phone. Without this
          // a rotation deadlocked whenever the predecessor stayed connected.
          log(`Self-heal: ${activeId} currently holds the phone; attempting coordinated takeover.`);
          if (await promoteIntoTunnel('rotation_takeover', { attempts: 2 })) await onPromoted();
        } else {
          // Superseded: stay warm, keep heartbeating, stop streaming.
          log(`Self-heal: another session is active (${activeId}); staying warm as standby.`);
          shouldStreamFrames = false;
        }
      } catch (e) {
        log('Self-heal warning: ' + e.message);
      }
    }

    // 1b2. Keep Google Play installable: the account-setup gate comes back after a
    // restore/re-login, and while it is up every install silently never starts.
    if (Date.now() - lastPlayGateCheckMs > 120000) {
      lastPlayGateCheckMs = Date.now();
      try {
        const top = (await adbShell('dumpsys activity activities | grep -m1 topResumedActivity', 15000)).stdout || '';
        // uiautomator dump() is a heavy accessibility traversal; running it while a
        // 179MB install is expanding is exactly what made the guest look frozen.
        const busyNow = await isGuestBusyForPersist();
        if (/com\.android\.vending|packageinstaller/i.test(top) && !busyNow) {
          await dismissPlayStoreBlockers('duty-loop');
        } else if (busyNow) {
          log(`Play gate check skipped (guest busy: ${busyNow}).`);
        }
      } catch (_) {}
    }

    // 1c. Periodic evidence collection (cheap, non-destructive).
    if (Date.now() - lastDoctorMs > 30 * 60 * 1000) {
      lastDoctorMs = Date.now();
      await deviceDoctor('periodic').catch((e) => log('Doctor: ' + e.message));
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
        lastGuestChangeAt = Date.now();
      } else if (fp !== lastChangeFingerprint && !changePersistInFlight && !wholeAvdSaveInFlight) {
        // Only a *new* change restarts the quiet window; a retry of the same
        // unpersisted change must not, or the 180s quiet gate could never open.
        if (fp !== pendingChangeFp) {
          pendingChangeFp = fp;
          pendingChangeSince = Date.now();
          lastGuestChangeAt = Date.now();
        }
        const busy = await isGuestBusyForPersist();
        if (busy) {
          log('State changed but Play/download busy (' + busy + ') — defer persist');
        } else {
          changePersistInFlight = true;
          (async () => {
            await sleep(90000);
            const busy2 = await isGuestBusyForPersist();
            if (busy2) { log('Still busy after debounce (' + busy2 + ') — retry next cycle'); return; }
            const fp2 = await fingerprintPhoneState();
            const pendingAge = Date.now() - pendingChangeSince;
            if (fp2 !== pendingChangeFp && pendingAge < 10 * 60 * 1000) {
              log('Fingerprint still changing — wait next cycle');
              return;
            }
            if (fp2 !== pendingChangeFp) log('Fingerprint keeps moving but the change is 10+ minutes old — capturing what is on disk now.');
            log('Phone state stable — whole-AVD persist (rate limited; never mid-install)');
            const captured = await livePersist('change-triggered', { whole: true, hold: false });
            if (captured) {
              lastChangeFingerprint = fp2;
              pendingChangeFp = '';
            } else {
              log('Change not persisted yet — will retry on the next cycle.');
            }
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
