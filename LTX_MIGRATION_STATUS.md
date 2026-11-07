# Temilolo LTX / black797 Music3 migration

Active targets are Temilolo for LTX-2.3 Distilled GGUF Q4_K_M and black797 for the existing MiniMax Music3 Q4_0 model. Joshbond123 is no longer a video/music profile. Android and unrelated persistent data remain unchanged.

Verified:
- Production source is on GitHub main; client/server builds and static graph checks pass.
- Both credentials are active and owner-matched; provider quotas were checked separately, not pooled or rotated.
- Temilolo's two private model datasets contain all five pinned assets (25.76 GB total).
- black797's existing private music dataset was mounted in a CPU-only, internet-disabled verifier. All three file sizes and full SHA-256 hashes match the pinned model manifest.
- A real video request was submitted through the website UI. The first Kaggle GPU session verified/staged LTX files and initialized the pinned real ComfyUI node graph, but no endpoint registered and no video was produced. That attempt was explicitly failed, its lease released, and the provider subsequently confirmed the session COMPLETE / GPU OFF.

In progress:
- Tunnel transport correction, diagnostic logging and retry through the actual UI.
- Actual model inference, saved playable output, visual/identity review and successful shutdown after output persistence remain unverified.
- The old Temilolo video dataset is retained until replacement validation; unrelated datasets must not be deleted.

No mock output, simulated generation or completion claim is used. A ready node graph or cache verification is not an end-to-end render test.
