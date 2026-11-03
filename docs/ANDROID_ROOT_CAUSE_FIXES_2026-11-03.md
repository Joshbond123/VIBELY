# Android phone — root-cause analysis and permanent fixes (2026-11-03)

Everything below is derived from real evidence collected from the production system
(`android.aivideo.blitz.cloud` + GitHub Actions runs), not from guesses.

## Evidence collected

| Source | Observation |
| --- | --- |
| `GET /api/public/health` | `active_emulator_connected=false`, `standby_count=1` (unverified, 500 s+), `failed_replacement_count=33`, `rotation_count=21` |
| Gateway container log (`apps logs_tail`) | repeating cycle `Agent connected → [Handover] Promoted (prev=none) → Active session disconnected → Agent connected …`, plus repeated container restarts (`Listening on 0.0.0.0:8080`) |
| `GET /api/status` rotation history | `previous_session_id: null` on every event, alternating `automatic_4h_workflow_rotation` and `gateway_restart_recovery` |
| Run 41595739607 (07:25 UTC) | `[FATAL] Error: Handover failed: {"ok":false,"error":"Working source preserved; emergency recovery requires an empty gateway"}` → `##[error]The process '/usr/bin/sh' failed with exit code 1` → emulator killed |
| Run 41595739607 failure hook | `active_session_preserved: emu_41592200120_6110a6` — a session belonging to run 41592200120 which had been **cancelled 37 minutes earlier** (zombie socket, never reaped) |
| Run 41594826542 (07:13 UTC) | `FileNotFoundError: /usr/local/lib/android/sdk/emulator/source.properties` in `avd_checkpoint.sdk_evidence()` → whole job aborted before the emulator ever booted (commit 48202b9) |
| Working tree | `notifyStreamStateToAgents()` hard-coded `shouldStream = true` |
| Working tree | `agent.mjs` sent `expect_empty: GITHUB_AVD_ONLY==='true'`, and the workflow always sets `GITHUB_AVD_ONLY: 'true'` |

## Root causes (and the fix for each)

### RC1 — Every rotation was rejected by the gateway (`expect_empty`)
`agent.mjs` asked the gateway to promote into an *empty* gateway
(`expect_empty: true`) on every single rotation, because it tied that flag to
`GITHUB_AVD_ONLY`. The gateway correctly refuses (`409 Working source preserved`)
when a live phone exists — which is exactly the situation during a 4-hour
rotation. The successor therefore could never take over, threw a `FATAL`, and the
workflow killed the only emulator that was running.

**Fix:** `expect_empty` is now driven by a dedicated `EMULATOR_EMPTY_GATEWAY_ONLY`
environment variable (emergency recovery only). Normal rotation always promotes.
`agent.mjs` also sends `state_source: github-whole-avd` so the gateway knows the
successor already restored the authoritative disk.

### RC2 — Dead agent sessions were never reaped (the "black screen" loop)
The gateway removed a session only when the WebSocket emitted `close`. Behind the
Cloudflare → Blitz hop that event often never arrives for a cancelled workflow, so
`activeSessionId` kept pointing at a dead emulator: viewers were routed to nothing
(black screen) and the next rotation was refused as "working source preserved".
The session map also grew without bound, which inflated gateway memory and caused
container restarts (`Listening …` appearing repeatedly in the log).

**Fix (gateway):**
* protocol-level `pong` + 15 s heartbeat tracking (`SESSION_SILENCE_MS = 75 s`);
* a 15 s reaper that terminates silent sockets, deletes the session and fails over
  to a verified standby;
* `getActiveSession()` ignores sessions older than the silence window;
* session table capped (`MAX_SESSIONS = 4`, oldest standby evicted);
* the persisted `lastActiveSessionId` is now **restored** on boot (it was written
  but never read), so a container restart no longer demotes a healthy phone;
* `uncaughtException` / `unhandledRejection` handlers so a stray error cannot kill
  the relay.

### RC3 — Successor failures killed the phone instead of self-healing
Any verify/handover hiccup threw out of `main()` → `process.exit(1)` → runner gone
→ phone dark until cron. 33 failed replacements.

**Fix (agent):** `promoteIntoTunnel()` retries verification + handover, is safe to
call repeatedly, and never exits on failure. The duty loop now runs a **self-heal
beacon every 60 s**: if the gateway has no active phone, this emulator re-verifies
and promotes itself; if another session is active it stays warm as standby; and an
ADB watchdog (6 failed recovery cycles) publishes a checkpoint and requests a
successor instead of rebooting or wiping anything.

### RC4 — Play Store installs were frozen by checkpoints (the actual "stuck install")
`avd_checkpoint.capture()` pauses the virtual CPU (`adb emu avd stop`) and copies
the multi-gigabyte AVD. The change-triggered persistence ran on *every* phone
fingerprint change, including right after an install started/completed, and the
busy check only looked at two legacy `dumpsys download` status codes.

**Fix:**
* `GuestBusy` is now a **hard** block inside `capture()` (DownloadManager status,
  `pm list sessions -a`, PackageInstaller dump);
* whole-AVD captures are rate limited (default 45 min), skipped while busy, and
  only forced for rotation / explicit checkpoint;
* RAM snapshots are no longer captured, copied, archived **or loaded** — a
  snapshot taken mid-install carried a frozen `PackageInstaller`/`DownloadManager`
  state that could never complete, which is why "Installing…" came back after
  every rotation. Every rotation now cold-boots from the crash-consistent disk
  (captured with the vCPU paused), so accounts, apps, app data, permissions and
  downloads are all present with no stale in-flight work;
* `reconcileInstallQueue()` abandons only sessions the system itself reports as
  `active=false`, and restarts the store worker only when nothing is downloading.

### RC5 — The runner was saturated by an always-on software H.264 encoder
`notifyStreamStateToAgents()` had `const shouldStream = true`, so the emulator ran
a swiftshader H.264 encoder at 1280 px / 30 fps for the entire 4-hour session even
with **nobody watching**. On a 4-vCPU runner that starves `com.android.vending`
and `DownloadManager` — installs hang, UI appears frozen, and the workflow burns
its time budget.

**Fix:** stream only while a display or control client is attached (plus a 20 s
linger); the page still gets an instant picture because the last GOP is replayed
from the gateway cache.

### RC6 — Restore aborted on harmless emulator/system-image drift
`avd_checkpoint.extract()` raised
`System-image/emulator version changed; explicit migration required` whenever the
`emulator/source.properties` hashes differed from the checkpoint. `ubuntu-latest`
bumps the emulator package regularly, so the phone would simply never come back
after a runner-image update.

**Fix:** family/API/arch mismatch is still fatal; exact build-hash drift is now a
logged warning. `sdk_evidence()` is additionally hardened against unreadable or
missing files (the 07:13 run died on exactly that).

### RC7 — `adb root` / `adb unroot` churn on a production Play image
`google_apis_playstore` images are production builds: `adb root` always fails and
restarts adbd (1–3 s transport drop), and `adb unroot` in `recoverAdbConnection()`
dropped the very transport it was trying to recover. Both were called on every
promotion and recovery cycle.

**Fix:** removed. The scripts now detect unprivileged adbd once and tune with
shell-only settings.

### RC8 — Keep-awake workflow was the most expensive job in the repo
It installed Playwright + Chromium every 10 minutes (~8 runner-minutes each) just
to keep the Blitz container hot.

**Fix:** a plain keep-alive request (plus an authenticated Blitz resume if the
gateway is unreachable), with the phone's real state reported in the job summary.

## Verification plan (real, not simulated)

1. `android-emulator.yml` (rotation) → new gateway image deployed, successor boots
   from the persisted disk, verifies over the tunnel, takes over.
2. `android-phone-tests.yml` → waits for the live phone, then performs a **real
   Google Play Store install** of a package that is not installed (opens the store
   listing, presses the real *Install* button, waits for `pm path` to report the
   APK), launches the app, grants runtime permissions, records app-data size.
3. The same workflow dispatches a **workflow rotation**, waits for the new
   session, then re-verifies package + version + app data + granted permissions +
   Google account on the replacement emulator.
4. Evidence JSON, screenshots and the session log are uploaded as artifacts.

---

## RC9 — Google Play refused to start any install: the "Complete account setup" gate

**Evidence (live phone, 09:38Z).** Tapping *Install* on a real Play listing opened
`com.android.vending/com.google.android.finsky.billing.acquire.SheetUiBuilderHostActivity`:

```
Complete account setup
replyraven001@gmail.com
Add a payment option to complete your account. You won't be charged unless you make a purchase.
[Add card] [+ more] [Add PayPal] [Redeem code]   [Skip]
```

While that sheet is up the store **accepts the Install tap and never starts the
download** — the install sits at *Pending* forever, on every attempt, on every
rotation, which is exactly the reported "installations get stuck repeatedly and
never complete". No cache clear, no restart, no system image change can fix it.

**Fix.** `dismissPlayStoreBlockers()` in the agent detects the gate and other Play
dialogs and taps **Skip** (no payment method is added, nothing is purchased, the
account is untouched). It runs after every promotion and every 2 minutes while the
store is in the foreground. `play_install_test.py` detects the gate, records it as
evidence, dismisses it, re-taps Install if the gate swallowed the tap, and fails
fast with a clear reason if Play is asking for a Google sign-in.

**Result (proof).** Immediately after tapping Skip the download jumped to 29% and
`org.wikipedia` finished installing through the real store:

```
09:39:40  pm path org.wikipedia -> package:/data/app/~~0y_1foIg-.../org.wikipedia-...
          versionName=50614-r-2026-10-20   firstInstallTime=2026-11-03 09:39:40
```

A later automated in-session test installed it unattended in 79 s
(`[install] {"installed": true, "waited_s": 79.0}`, app launched, pid 9005), and
the package was still present on a **fresh runner** afterwards
(`preflight: package_installed: true`) — i.e. the install survived a full rotation.

## RC10 — Checkpoints froze the phone while it was in use

The first change-triggered checkpoint fired two minutes after the phone went live
and paused the vCPU for ~3 minutes *while a Play install test was running* — the
guest clock lost 6 minutes and every adb call hung. That is indistinguishable from
"the phone hangs" for a user.

**Fix.** A capture now requires **all** of: no persistence lease, nothing in
DownloadManager/PackageInstaller, no Play Store in the foreground, no attached
viewer, and 180 s of guest quiescence. The install test holds a lease so automation
can never be frozen, and the lease is released the moment the test ends so the
install is persisted immediately. Verified live:

```
09:51:09  State changed but Play/download busy (play_store_foreground) — defer persist
09:52:13  Whole-AVD capture deferred (guest busy: play_store_foreground)
```

## RC11 — A dead emulator was never restarted (the permanent hang)

**Evidence (live phone, 11:43Z).**

```
11:43:42  Adaptive encoder: adb forward ...: device offline
11:43:43  CRITICAL: adb has no emulator device — running recoverAdbConnection()
11:47:34  CRITICAL: adb has no emulator device (3 consecutive)
11:49:22  CRITICAL: adb has no emulator device (4 consecutive)   <- still dead
```

`adb devices` was empty: the qemu process itself was gone. The agent answered with
`adb kill-server / reconnect / wait-for-device`, which **cannot resurrect a process
that is not running**. Each cycle burned ~100 s inside the duty loop, it took six
cycles (~10 min) before a replacement runner was even requested, and the gateway
kept the dead session as its active pointer, so the web phone showed a frozen
picture indefinitely. This is the "phone gets stuck and never comes back" bug.

**Fix.** The AVD disk on the runner still contains every app, account, setting and
download, so the phone is relaunched **from that same disk on that same runner**:

* `restartEmulatorLocally()` — forensics, SIGKILL leftovers, clear stale QEMU
  locks, spawn the identical AVD/emulator options, wait for boot, re-attach
  display+touch, re-apply Play/permission/realism tuning, re-announce health.
* An independent **supervisor** (20 s timer) does this even if the duty loop is
  stuck in a long await; a replacement runner is requested only if a local
  relaunch fails.
* Recovery no longer blocks the duty loop; `adb` children are killed with SIGKILL
  (adb ignores SIGTERM, so `execFile` timeouts never fired and one hung `adb` could
  freeze the whole agent); `unhandledRejection`/`uncaughtException` are logged
  instead of terminating the agent; the log relay retries instead of dropping
  evidence during a gateway restart.
* Checkpoint pause shortened (only state-bearing files) and the resume is verified;
  a guest that fails to resume triggers an immediate relaunch.

**Result (proof, deliberate crash on the live phone).**

```
12:03:38  SIMULATION: killing the emulator process to prove self-heal
12:04:03  ADB quick recovery failed while qemu is alive (device offline): relaunching
12:04:07  EMULATOR SELF-HEAL: spawned /usr/local/lib/android/sdk/emulator/emulator pid=6888
12:04:37  EMULATOR SELF-HEAL: Android booted
12:05:07  DOCTOR post-self-heal: boot_completed=1, data 1.9G used / 5.6G free
12:05:08  EMULATOR SELF-HEAL COMPLETE: the phone is live again with its data intact.
```

**90 seconds** from a killed emulator to a booted phone with all data, same session,
no userdata wipe, no workflow replacement. `GET /api/screen.jpg` returned the live
Play Store UI straight afterwards.

**Follow-up found by that test:** the scrcpy channel failed to bind on its first
attempt right after boot, leaving a healthy phone with a frozen picture.
`ensureLiveAttached()` now kills a stale server and retries the attach up to six
times with backoff, re-requesting a key frame; the self-heal, the duty loop and the
supervisor all call it.
