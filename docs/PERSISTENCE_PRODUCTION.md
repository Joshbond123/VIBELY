# Production Android persistence (GitHub-native) — 2026-11-02

## What was wrong
- Production workflow used `google_apis` (no real Play Store), `force-avd-creation: true`, and `-no-snapshot`.
- Every rotation booted a blank phone; only partial guest files were restored via `state-manager.sh`.
- Whole-AVD modules (`avd_checkpoint.py`, `github_state.py`) existed but were not wired into the live path.

## Architecture (GitHub only)
| Layer | Mechanism |
|---|---|
| Control plane | Git branch `android-state-v1` (tiny CAS JSON: current/previous/pending) |
| Payload | Versioned GitHub Release assets, AES-256-GCM encrypted 256 MiB parts |
| Capture | `avd_checkpoint.py` — pause VCPUs, RAM snapshot, copy full AVD, resume source |
| Publish | `github_state.py publish` — never promotes incomplete; previous retained |
| Restore | `restore-whole-avd.sh` before emulator boot; `force-avd-creation` only if no userdata |
| Image | Official `system-images;android-34;google_apis_playstore;x86_64` |
| Partial hot backup | Existing `state-manager.sh` every 10m (APK/data/settings) still runs |
| Rotation | Agent saves whole-AVD (hold) → dispatches successor → gateway handover → old exits |

## Required secrets (already present)
- `EMULATOR_STATE_KEY` (≥32 chars, encrypts snapshots)
- `GH_PAT` (contents + release write)
- `EMULATOR_GATEWAY_URL`, `EMULATOR_GATEWAY_SECRET`, `EMULATOR_ACCESS_TOKEN`
- `BLITZ_API_KEY`, `BLITZ_ANDROID_APP`

## Rotation sequence
1. Active session runs; 10m partial backups + ~hourly whole-AVD publish.
2. At `ROTATION_MINUTES` (default 240): hold-capture whole-AVD → dispatch replacement workflow.
3. Replacement restores checkpoint (or first-boot Play image) → boots → verifies → gateway handover.
4. Only after successful external verification does the previous session retire.
5. Concurrent writers conflict on `android-state-v1` CAS; incomplete never becomes `current`.

## Short-interval test
Dispatch with `rotation_minutes: "20"` and `force_rotate: "true"`.

## Still honest limitations
- First boot after this change has **no** whole-AVD checkpoint yet → blank Play Store phone until Google account is signed in and a checkpoint is published.
- Guest-disk-only rescues remain NOT full AVD; do not treat them as account restoration proof.
- Actions runner time and Release storage are finite; monitor storage.
