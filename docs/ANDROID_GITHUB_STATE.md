# Android whole-phone GitHub state engineering — 2026-11-02

## Status: implementation under validation, not production acceptance

The existing public phone has **not** been replaced with the isolated validation AVD. The old production workflow still uses partial guest-file backups; it is **not** converted to whole-AVD storage yet. A verified migration of the currently running runner's AVD is required before enabling a replacement. This document explicitly separates executable implementation from remaining integration.

The user permits the existing Blitz gateway **only as the browser/stream relay**. The new checkpoint modules have no Blitz persistence dependency. No additional provider, database, VPS, or storage service was introduced.

## Root causes verified

* Production workflow selects `google_apis`, creates a new AVD (`force-avd-creation: true`) and disables snapshots. It is a fresh VM on every runner, followed by selected file restoration.
* The old backup copies third-party APK/data/settings but omits the complete Android system account databases, permission manager state, hardware/keystore/encryption environment and VM RAM. Reinstalling APKs with UID remapping is not whole-phone persistence.
* The current public phone's `com.android.vending` path is `/product/app/LicenseChecker/LicenseChecker.apk`. Package presence alone does not prove a functional Play Store. TikTok was not installed at the latest audit.
* The isolated official `google_apis_playstore` AVD actually booted on Actions. Verified paths: `Phonesky/Phonesky.apk`, `PrebuiltGmsCore/PrebuiltGmsCore.apk`, and `GoogleServicesFramework/GoogleServicesFramework.apk`. No authenticated Google/TikTok test has passed there.
* Previous native video startup failed because scrcpy cleanup deleted the shared server JAR before the second server started. Commit b93ad29 disabled per-server cleanup. A later deployed browser test actually decoded H.264, survived a network outage with its last frame intact, and resumed in the **same** Android session.
* Browser transport-open was formerly treated as readiness even without decoded frames. UI now distinguishes waiting, disconnected, stalled/recovering, updating and an observed locked state. Connection state is not proof of app or account persistence.
* JPEG screenshot freshness incorrectly shared the timestamp of H.264 packets. Native packets could make an old JPEG appear fresh. These timestamps are now separate.

## GitHub-native storage comparison

| Mechanism | Decision | Reason |
|---|---|---|
| Dedicated Git branch | Use for tiny control records only | Version history, atomic non-forced ref update, rollback/audit. Do not put raw disks into Git. A branch in a **public** repository is also public. |
| Actions artifacts | Test diagnostics only | Finite retention and storage allowances; not permanent phone storage. Never upload plaintext phone disks or account dumps as artifacts. |
| Actions dependency cache | Optional runtime acceleration only | Subject to retention and eviction; never the authoritative phone backup. Current GitHub supports configurable cache policies; old claims of an immutable universal 10 GB limit are outdated. |
| Git LFS | Not selected | Large changing VM images consume billed storage/bandwidth and retain historical objects. Does not itself provide writer fencing or consistent VM capture. |
| Versioned GitHub Releases | Selected for encrypted payload | Versioned assets outside source Git history. Each asset must be **under 2 GiB**; implementation uses 256 MiB plaintext parts plus small encryption overhead. |
| Encrypted compressed full AVD | Implemented | Preserves userdata/metadata disks, overlays, SD image, config and RAM snapshot together. AES-256-GCM authenticates both manifests and data. |
| Differential/incremental backups | Deferred until full restore passes | Qcow2 overlay chains and cross-release chunk dependencies complicate recovery and garbage collection. No unsupported live-disk delta or untested incremental chain is used. |

**Retention warning:** Releases are not a substitute for monitoring repository/account storage policy. Automatic release garbage collection is deliberately not enabled until restored checkpoints are certified known-good. The current/previous control references provide fallback, but historical unreferenced release assets will need a verified retention policy. Do not run unlimited public-phone rotation on the assumption storage and Actions time are unlimited.

## Executable files

* `android-emulator/avd_checkpoint.py`: captures guest evidence privately, issues Android sync, stops virtual CPUs, confirms stopped status, saves the RAM snapshot, reconfirms pause, copies the complete AVD, resumes the source in a finally block, and only then compresses the stable copy. Refuses missing userdata or running-destination restoration. Full zstd-stream validation, safe archive extraction and SDK revision fingerprint checks. `--hold` exists for a future final fenced handover; it is not wired into production.
* `android-emulator/github_state.py`: Scrypt-derived AES-256-GCM encryption with fresh salt/nonce per part, encrypted manifest, SHA-256 checks, read-back authentication, versioned release publication, dedicated Git state-ref commit point, owner fencing, current/previous fallback and prepared-candidate promotion methods. An upload failure does not replace the committed checkpoint. A stale candidate or owner cannot commit a new state head.
* `android-emulator/validation_roundtrip.py`: actual authenticated GitHub publish/download integration and full archive hash comparison; not a mock storage test.
* `.github/workflows/android-state-validation.yml`: isolated native Google Play AVD, encrypted GitHub roundtrip, complete emulator shutdown, archive restore and native display/file/settings/foreground verification. No gateway connection or public-phone promotion. Unique per-run concurrency group, `cancel-in-progress: false`.
* `tests/test_android_github_state.py` and `tests/test_android_avd_checkpoint.py`: seven local crypto/fault-injection/capture-safety/canonical-evidence tests, explicitly **not** Android acceptance.
* `.github/workflows/android-state-restore.yml`: a separate read-only runner restores an existing encrypted checkpoint; never initializes an empty AVD, writes ownership, or connects to the public gateway. Its cross-runner test has not passed yet.
* `tests/live_display_recovery.mjs`: deployed browser checks of real H.264 decoding, unchanged buffered pixels during outage, honest disconnected state and renewed decoding in the same OS session.

## Commit protocol

1. Only the control record's `owner` may publish.
2. Create uniquely versioned draft release; encrypt every payload and manifest before upload.
3. Check uploaded byte counts and GitHub digest when supplied; read back and authenticate manifest.
4. Publish release only when complete.
5. Build a new Git tree/commit containing only `state.json`, with the observed state head as its parent.
6. Update the state ref **without force**. If another writer advanced it, GitHub rejects the non-fast-forward update. Never rebase/retry a stale owner into success.
7. The previous reference remains available; failed/damaged newest restore falls back to it. Decrypted destination is replaced only after complete checksum/authentication verification.
8. Candidate promotion requires a prepared candidate/checkpoint and successful boot/display/packages/account/settings/userdata/foreground evidence. The public relay is not an ownership database.

A ciphertext release may be orphaned after an interrupted upload/commit. It is not discoverable as the current state and must not be mistaken for a valid committed checkpoint. Mutating APIs are not blindly retried after an ambiguous response.

## Required secrets and permissions

* `EMULATOR_STATE_KEY`: at least 32 cryptographically random characters, kept in Actions Secrets and an operator-controlled recovery copy. Never rotate/delete it without re-encrypting and restore-testing all retained snapshots.
* `GH_PAT`: token permitted to read/write repository contents, Releases and workflow dispatch. Prefer a narrowly scoped GitHub App token or fine-grained PAT restricted to this repository. Contents read/write and Actions read/write are required for the planned cross-workflow controller. The unit/storage test currently only needs contents access.
* Existing relay-only secrets: `EMULATOR_GATEWAY_URL`, `EMULATOR_GATEWAY_SECRET`, `EMULATOR_ACCESS_TOKEN`; existing `BLITZ_API_KEY` is only for maintaining the already-approved relay.
* Workflow `permissions: contents: write`; future successor dispatch also needs `actions: write`. The default GITHUB_TOKEN generally does not trigger successor workflows the same way a PAT/App token does; explicitly verify the chosen token behavior.
* `ANDROID_STATE_BRANCH` isolates validation from production. `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` come from Actions.

The existing source repository is public. Neither a dedicated branch nor public Release makes ciphertext private. Sensitive manifests, file contents and identifiers must remain encrypted; only generation/owner IDs, release IDs and ciphertext hashes are plaintext control metadata. Never commit account dumps, decrypted archives, encryption keys or passwords.

## Safe production handover: integration still required

Target: begin successor preparation near minute 225; nominal ownership rotation at minute 240; never cancel the active workflow to start the candidate. A global concurrency group shared by both long-running jobs would queue B behind A and break overlap; unique run/generation groups plus Git-ref fencing are necessary.

However, a warm B based on an earlier checkpoint does not contain writes made on A while B boots. A final consistent checkpoint and input/write fencing are required before transfer. A full VM image transfer cannot honestly guarantee literal zero interruption. During that interval the relay must retain the last real frame and label it as a held/recovering screen, not as fresh live video. Failed transfer must resume A and leave ownership unchanged. Do not promote based merely on BOOT=1 or a JPEG byte count.

The current production agent only exposes guest ADB RPC and legacy backup/restore operations. It does **not** expose host AVD checkpoint capture. Pushing a source commit cannot change code already running on that runner. Secure migration of its complete AVD is therefore an outstanding blocker; a new clean Play AVD cannot magically inherit its signed-in accounts. Do not reset or terminate it as a migration shortcut.

Other incomplete items: cross-runner exact SDK/emulator packaging, final-delta transfer, measured cutover, successor ownership/relay reconciliation, scheduled recovery, positive Google/TikTok authentication tests, Notes UI rewrite/restore, permissions restoration after full rotation, and full failure-recovery acceptance.

## Verified tests / pending tests

* Local crypto roundtrip, tamper rejection, wrong-key rejection: PASS.
* Injected upload failure preserves old checkpoint: PASS (unit test).
* Corrupt newest manifest falls back to prior checkpoint: PASS (unit test).
* Non-owner writer and stale candidate rejected; incomplete verification does not promote: PASS (unit test).
* Gateway TypeScript build: PASS.
* Deployed actual H.264 decode, buffered-frame retention during outage, reconnect/resumed decode in same session: PASS in `emu_41424314059_c4be3a`.
* Isolated official Google Play Android boot and genuine package paths: PASS in Actions run 41442317701.
* Actions run 41442803421: actual encrypted GitHub roundtrip and complete archive hash comparison PASS; real ciphertext Release 431423502 contains 9 assets totaling 1,956,141,271 bytes. Restored Android boot, non-black display, packages, settings and foreground checks passed. The full test FAILED account/userdata comparisons, so no persistence acceptance was claimed. Transient dumpsys diagnostics were included in the old comparison; canonical grant/account parsing is now being retested rather than assuming those failures were harmless.
* Actions run 41443664480: capture compression failed; host-operation stderr reporting and isolated-runner disk headroom were added. No incomplete checkpoint replaced a valid committed state.
* Latest full-disk acceptance remains pending; do not report PASS until the complete Actions workflow succeeds.
* Gateway-only Actions deployment 41443025516: PASS. Re-executed the three deployed decoding/outage/reconnect assertions after deployment: PASS, same phone session.
* Lock-screen-specific tests: FAILED. The live phone had keyguard disabled. Enabled the real credential-free keyguard without setting a PIN/password; screen-off/wake/decoded-frame/unlock sequence remains inconsistent and is not accepted. A real Android lock-screen JPEG was observed, but that alone is not proof the live lock stream is fixed. Future agent code no longer dismisses keyguard or uses stay-awake; encoder initialization no longer powers on the display as a side effect. Those agent changes are not rolled into the signed-in phone yet.
* Tests A–F in the mission, authenticated Play/TikTok, full 4-hour handover and account/permission persistence: NOT ACCEPTED.

## Platform constraints and primary sources

GitHub-hosted jobs have a six-hour execution ceiling and Actions schedules/queues are not availability SLAs. A current runner cannot be kept alive forever by a software watchdog. GitHub also restricts using hosted Actions for activities unrelated to the repository's software lifecycle and disproportionate serverless/application hosting. These repository CI tests do not establish permission to operate a permanently public phone service. Confirm production usage with GitHub before enabling perpetual rotation.

* https://docs.github.com/en/actions/reference/limits
* https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
* https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
* https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs
* https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
* https://developer.android.com/studio/run/emulator-console
* https://developer.android.com/studio/run/managing-avds

## Latest checkpoint — continuation

Run 41444550365 failed first-boot readiness because ADB was unauthorized, not because a blank emulator was accepted as restored. The pending fix provisions the legitimate ADB host key before the isolated emulator boots and includes that host identity only inside the encrypted whole-AVD archive. An independent runner must restore it before starting its ADB server; weakening adbd authorization is not used. This change still needs native verification.

The same public phone remains connected at the latest check. This is not evidence that its current Google account is restore-protected. The 26-second video is complete but still fails visual acceptance; no improved Gym video or replacement-model inference has been validated. Video quality/camera work remains active after the bounded Android checkpoint test.
