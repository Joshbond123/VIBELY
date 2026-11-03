# GPU dashboard and fleet work — 3 November 2026

## Acceptance status: partial, not complete

The dashboard/quota integration, documented account inventory, durable observation ledger, immediate lease-release shutdown trigger and safe-boundary rotation policy have been implemented. This is **not** a claim that Wan-Animate-2 is installed or that real 30-minute GPU rotation has passed.

## Documentation and real provider observations

Updated Drive document `VIBELY` was read. Its roles are:

| Role | Account | Actual provider used | Actual provider remaining |
|---|---|---:|---:|
| Video primary | temilolo | 0 h | 30 h |
| Video backup | joshbond123 | 33.79796058 h | 0 h |
| Music primary | black797 | 0 h | 30 h |
| Music backup | happink | 28.45738562 h | 1.54261438 h |

Balances above came from Kaggle's **official MCP `get_accelerator_quota`**, called with `{"request":{}}`, not inferred from app runtime. Provider total is 30 h per account. Reported next reset: **2026-11-07T00:00:00Z**. Separate account balances are not represented as one shared 120-hour entitlement.

Read-only notebook listing authenticated all four accounts. No files, packages or notebooks were blindly deleted. A Kaggle account is not a dedicated physical GPU; actual accelerator names can only be verified from an allocated session. The new accounts have no verified VIBELY worker installation. Existing unrelated/private notebooks were not treated as disposable.

## Implemented behavior

- Four documented account cards, labelled video/music and primary/backup.
- Account-selectable weekly balance bar using real total, used, reserved and remaining quota.
- Actual provider reset timestamp and measurement timestamp.
- Hardware names from fresh worker `nvidia-smi` telemetry only; unallocated or unverified hardware is labelled honestly.
- Five-second worker refresh, sixty-second cached provider-quota refresh, overlapping fetch protection and no-store responses.
- Stale telemetry is not shown as fresh ON status. A terminated provider session can correct stale ON state to OFF.
- Unknown/unprovisioned status is not fabricated as an ON/OFF measurement.
- Persistent PostgreSQL usage intervals, deduplicated under a row lock. Gaps longer than 90 seconds are not billed as observed time. Provider usage remains separate from app-observed intervals.
- Lease release immediately invokes the existing safety-gated lifecycle tick; worker shutdown still refuses running/queued jobs or unacknowledged outputs. OFF requires provider confirmation.
- Provider quota is checked before existing worker startup. Unknown or exhausted quota fails closed; exhaustion does not automatically route into another account.
- A tested rotation decision policy drains at the 30-minute threshold, waits for active work and output receipts, requires confirmed shutdown, avoids starting idle resources, excludes unverified/stale quota/model configurations, and prefers verified remaining capacity.
- The rotation decision policy is **not an activated account-switching scheduler**. Workers and checkpoint support have not been validated; wiring it into dispatch as if those resources existed would be placeholder functionality.
- Full-body/locked-camera instructions and early musical-hook requirements were strengthened in the existing reasoning plan. This is a prompt-level change only, **not measured motion/audio improvement**.

## Existing music model and Android

No music model weights, model type, music worker dependencies or music worker inference implementation were changed. No new music generation has been accepted in this iteration. Android files were not edited. A separate Git worktree was used because unrelated work was present in the original checkout.

## Not implemented or not verified

1. GPU environment cleanup, new dependency installation and physical hardware inspection.
2. Complete Wan-Animate-2 renderer adapter, driving-motion input library and actual checkpoint installation.
3. Removal of the currently working legacy video model; no destructive removal occurred before validating its replacement.
4. Identical working Wan installations on both video accounts.
5. Persistent complete model caches on the new accounts and a proven no-download restart/switch cycle.
6. Live primary-to-backup switching and actual thirty-minute rotation.
7. Cross-session diffusion checkpointing. Arbitrary mid-denoise shutdown cannot be described as lossless migration.
8. New video/music generation and frame/audio acceptance.
9. A global atomic admission/reservation mechanism that proves a hard thirty-hour fleet-wide ceiling. The present provider-startup check is not such a proof.

The exhausted video-backup account cannot be used to validate both video installations now. Alternative accounts must not be used to circumvent provider quota. A safe rotation switches at a completed/persisted task boundary, potentially later than thirty minutes for one long task; exact mid-task thirty-minute migration requires tested model checkpointing.

## Tests

- Full client/server build: passed.
- Rotation-policy and quota-parser unit tests: passed. These use policy inputs, not real hardware activation.
- Existing engine-policy regression: passed.
- Existing immutable-cache tests: five passed.
- Actual Node provider client authenticated and read real quota for all four accounts: passed.
- No GPU was allocated by these quota or dashboard checks.

Live deployment/UI verification is recorded in the shared workspace's final verification evidence. A successful build is not GPU or model acceptance.

## Follow-up implementation

The video GPU no longer waits for the independent music promise before it can be released. The backend now fully decodes, checks duration, atomically preserves and fsyncs an immutable visual master, records its durable receipt, and releases the video lease before waiting for music. Worker receipt delivery still gates shutdown. A visual-only recovery endpoint distinguishes that asset from a final production. Existing explicit deletion and retention policies also remove its paired master.

A test with the real previously generated (rejected) 26-second video passed full decoding, duration/hash checks, idempotent persistence, path validation and invalid-file rejection. This is **not** a new generated or visually accepted video, nor a live GPU-shutdown test.

The exact 12,741,204,960-byte Wan Q5 diffusion artifact was downloaded and SHA256-verified in private **CPU-only** kernels for both video accounts. Initial dataset publication failed because Kaggle returns HTTP 403 for an absent private dataset. The source was corrected to use a create-only operation; recovery publication reuses the already verified saved artifact rather than downloading it again from Hugging Face. Publication status must be confirmed separately. The cache contains only the diffusion checkpoint, not a complete installed encoder/VAE/renderer stack.

## Persistent diffusion checkpoint publication

Both account-owned private datasets now report **ready**, version **1**, with the exact **12,741,204,960-byte** GGUF and artifact lock:

- `temilolo/vibely-wan-animate2-distilled-q5-cache`
- `joshbond123/vibely-wan-animate2-distilled-q5-cache`

The corrected transport uses bounded byte ranges, retries only failed ranges, checks exact range lengths and verifies the entire SHA256 before publication. It refused a truncated transfer rather than accepting a partial checkpoint. Both datasets are private; no Scarlett reference or generation history was published.

Fresh CPU sessions with internet **disabled** were submitted to attach and rehash those persistent datasets without Hugging Face downloads. Their final read-back results are recorded separately; submission alone is not acceptance. This does not claim GPU restart/switch testing or a complete installed text-encoder/VAE/inference stack.
