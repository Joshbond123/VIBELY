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
