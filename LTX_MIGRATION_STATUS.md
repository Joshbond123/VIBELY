# LTX / Music migration — draft, not deployed

Target: LTX-2.3 Distilled Q4_K_M on Temilolo; existing MiniMax Music3 Q4_0 on Joshbond123. No account rotation, runtime weight downloads, mock output, or Android changes.

## Verified locally
- Client/server production build succeeds.
- Worker sources compile; static LTX graph checks pass. These are **not** GPU/UI acceptance tests.
- LTX artifact paths, pinned revisions, byte counts and SHA-256 were checked against public upstream metadata; standalone VAE/connector tensor headers were inspected.
- Private CPU publishers perform full artifact SHA-256 verification before upload.

## Blocking / incomplete
- The supplied Joshbond123 token initially worked but subsequently became inactive according to Kaggle token introspection; quota, private cache and notebook access now fail. Refresh securely before any migration/deployment.
- The first Temilolo CPU publisher exceeded the notebook's 20 GB working filesystem. Corrected CPU-only publishers now split main/audio/video assets (18.46 GB) and Gemma (7.30 GB) into separate private datasets. Their publication/mounting must still be independently verified.
- Joshbond123 CPU publisher returned a completed log and upload proof for all three verified music files before credential failure. Actual owned-dataset availability has NOT been independently verified afterward.
- No new GPU worker started, real render submitted, website UI tested, production migration deployed, old model removed, or retired account connection cleaned up.
- GPU allocation, VRAM fit, model compatibility, visual/identity quality, output playback, cancellation and provider-confirmed automatic shutdown remain unverified.

## Cache mounts required
- `temilolo/ltx-23-distilled-q4-cache`
- `temilolo/ltx-23-gemma-q4-cache`
- `joshbond123/minimax-music-3-q4-0-gguf-cache`

## Before production deployment
1. Verify active owner-bound credentials and dataset visibility/file inventories using the official provider APIs.
2. Review the migration diff and real hardware constraints; preserve current persistent data, three Scarlett reference files and unrelated resources.
3. Configure only the two dedicated server/GitHub credentials and an LTX worker API key. Never put secrets in source.
4. Deploy from GitHub, submit via the actual website UI, inspect real progress/model logs and saved playable media, and independently confirm each batch session terminates.
5. Only after replacement validation, remove the old Temilolo video-model dataset and retire only video/music connections. Do not alter Android or unrelated resources.

This branch is preparation, not a completion claim.
