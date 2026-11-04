# VIBELY — Scarlett Monroe Studio

Video: **NVIDIA Cosmos3 Nano hosted API only** (`nvidia/cosmos3-nano`).
Music: the existing **MiniMax Music 3 Q4_0 GGUF** ComfyUI worker on Kaggle remains unchanged.
Reasoning: NVIDIA Nemotron, separate from the actual video generator.

## Important current blocker
On November 4, 2026 the documented NVIDIA video endpoint returned HTTP 404 with this account's key. The published NVIDIA Cloud Function also returned function-not-found-for-account, while the same key worked for Nemotron chat. No successful NVIDIA video or visual-quality acceptance is claimed. Configured credentials are **not** proof of video access. The application reports actual provider failures and never falls back to a Kaggle video GPU or sample output.

Official contract: https://build.nvidia.com/nvidia/cosmos3-nano/modelcard

## Runtime
- Set `NVIDIA_API_KEY` as a **server-side environment variable**, never in client code.
- Preserve the existing music environment, model dataset, worker credentials and registry secret.
- Persistent `DATA_DIR` and PostgreSQL retain references, history, job checkpoints and media.
- The music deployment workflow accepts **music only**. Retired video workers cannot register.
- Dashboard monitoring is music-only, using provider quota and real telemetry; unverified values stay unknown. Existing primary/backup music profiles are retained; no quota-bypass account cycling is introduced.

## Video jobs
Requests run asynchronously with durable segment/submission checkpoints. NVIDIA 429 responses honor Retry-After; resumable accepted requests are polled without duplicate generation POSTs. Unknown submission outcomes stop for reconciliation rather than silently resubmitting. Four planned shots are subdivided within the model's native 197-frame limit; no loop, freeze-frame padding or arbitrary time stretching. The original watermarked VP9-in-MP4 outputs are preserved alongside H.264 browser derivatives. Full decoding, frame counts and duration are validated before final completion. Watermark robustness after transcoding is not guaranteed; original files are retained.

All three original Scarlett reference files are preserved. The documented native image-to-video API accepts **one** image per request: the first full-body reference initially, then the preceding shot's final frame. This is not three-image simultaneous conditioning and does not guarantee identity, anatomy or coordinated motion. Native 720p output is not 4K footage.

The established scheduling, series, music library, reference verification, social metadata, authentication and retention controls are preserved. No Android resources are modified by this migration.

```sh
npm ci
npm run build
npm start
```

Unit checks (not substitutes for actual provider/UI generation):
```sh
node tests/video_engine_policy.mjs
node --import tsx tests/video_duration_policy.mjs
python -m unittest discover -s tests -p test_gpu_safety.py
```
