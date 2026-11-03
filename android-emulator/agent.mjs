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
const WHOLE_AVD_MIN_INTERVAL_MS = Math.max(10, Number(process.env.WHOLE_AVD_MIN_INTERVAL_MIN || 45)) * 60 * 1000;
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

const pendingLogLines = [];
let logFlushTimer = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] [${SESSION_ID}] ${msg}`);
  // Mirror into the gateway so a stuck 5-hour session can be debugged live
  // instead of waiting for the job log to be published after it ends.
  try {
    pendingLogLines.push(`${new Date().toISOString()} ${msg}`);
    if (pendingLogLines.length > 400) pendingLogLines.shift();
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(async () => {
        logFlushTimer = null;
        if (!GATEWAY_URL || !GATEWAY_SECRET) return;
        const batch = pendingLogLines.splice(0, pendingLogLines.length);
        if (!batch.length) return;
        try {
          await fetch(`${GATEWAY_URL}/api/internal/agent-log`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: SESSION_ID, lines: batch }),
            signal: AbortSignal.timeout(15000),
          });
        } catch { /* logging must never break the phone */ }
      }, 3000);
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
  // Never `adb unroot` here: on this Play image adbd is already unprivileged and
  // `adb unroot` restarts adbd, dropping the transport we are trying to restore.
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
    const sessions = (await adbShell('pm list sessions -a 2>/dev/null | head -40', 15000)).stdout || '';
    if (/\bactive=true\b|\bsealed=true\b|SESSION_/i.test(sessions) && /package:/i.test(sessions)) return 'package_installer_session';
    const inst = (await adbShell('dumpsys package installer 2>/dev/null | grep -iE "sessionId|Session [0-9]|active|staged" | head -20', 15000)).stdout || '';
    if (/active=true|sealed=true|SessionId;i=0/i.test(inst) && !/No sessions/i.test(inst)) return 'package_installer';
    const act = (await adbShell('dumpsys activity activities 2>/dev/null | grep -iE "vending|PackageInstaller|Download" | head -25', 15000)).stdout || '';
    if (/DOWNLOADING|downloading|Installing|INSTALLING|Pending\.{0,3}$/i.test(act)) return 'play_or_installer_ui';
  } catch (_) {}
  return null;
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
    const sessions = (await adbShell('pm list sessions -a 2>/dev/null', 25000)).stdout || '';
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
  try {
    await runStateManager('backup', { reason, hold, force, whole });
  } catch (e) {
    log(`Live persist warning (${reason}): ${e.message}`);
  }
  log(`Live persist done (${reason})`);
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
        return;
      }
      if (!hold) {
        const busy = await isGuestBusyForPersist();
        if (busy) { log(`Whole-AVD capture deferred (guest busy: ${busy}); installs/downloads must not be frozen.`); return; }
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
      try {
        log(`Running real Play Store install test for ${INSTALL_TEST_PACKAGE}...`);
        const { stdout } = await execFileAsync('python3', [path.join(SCRIPTS_DIR, 'play_install_test.py'), '--package', INSTALL_TEST_PACKAGE, '--json', '/tmp/vibely_install_test.json'], {
          timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
        });
        log('INSTALL TEST OUTPUT:\n' + String(stdout).slice(-6000));
      } catch (e) {
        log('INSTALL TEST FAILED: ' + e.message);
        if (e.stdout) log('INSTALL TEST STDOUT:\n' + String(e.stdout).slice(-6000));
      }
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
  let lastChangeFingerprint = '';
  let lastWholeAvdMs = Date.now();
  let lastBlitzWakeMs = Date.now();
  let changePersistInFlight = false;
  let lastSelfHealMs = 0;
  let lastDoctorMs = Date.now();
  let lastActiveSeenMs = Date.now();
  let consecutiveAdbFailures = 0;

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
        consecutiveAdbFailures += 1;
        if (!ok) {
          log(`ADB recovery failed this cycle (${consecutiveAdbFailures} consecutive); will retry next health check`);
        }
        if (consecutiveAdbFailures >= 6) {
          // Never reboot or wipe: re-save state knowledge and let the workflow's
          // supervisor hand the phone to a fresh successor with the same disk.
          log('WATCHDOG: emulator ADB unreachable for 6 cycles; publishing checkpoint and requesting replacement.');
          await livePersist('watchdog-adb-lost', { whole: false, hold: false, force: false }).catch(() => {});
          await dispatchReplacementWorkflow();
          consecutiveAdbFailures = 0;
        }
      } else {
        consecutiveAdbFailures = 0;
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
            log('Phone state stable — whole-AVD persist (rate limited; never mid-install)');
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
