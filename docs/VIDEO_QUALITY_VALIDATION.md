# Video quality validation — 2026-11-02

## Baseline, not an accepted deliverable

`vid_a9221168-017`, 26 seconds, 624 frames at 24 fps, is playable but rejected.
All 624 frames were inspected in numbered contact sheets. Recurrent problems:
push-in crops feet; later pans put the subject against/outside the left edge;
frontal posing replaces parts of the exercise. Baseline diffusion is 320×576,
upscaled to 720×1280: output dimensions must not be represented as native detail.

## Candidate `ref2va-motion-v1` (not visually accepted yet)

* Match the actual Ref2V Turbo example: Euler/simple, four evaluations. Do not
  blindly double steps on a four-step-distilled adapter. Comfy's supported model
  already defaults to video/audio shifts 12/3; no missing-shift fix is claimed.
* Replace a still-only handoff with 22 actual preceding video frames through
  LoadVideo/GetVideoComponents/MiniMaxH3AddGuide. Render 22 context frames plus
  the new scene, then trim the prefix before concatenation. This is conditioning,
  not duplicated output duration or a crossfade hiding a discontinuity.
* Derive a face-only unaltered crop from reference 3; retain original references
  and use references 1 and 2 for overall identity and body proportions.
* Remove contradictory fixed-axis/all-frontal and hip-bounce instructions;
  request gradual three-quarter-to-side views with constant distance and full
  head-to-shoes framing. This text does not constitute a framing guarantee.
* Assign VAE work to GPU1 alongside text encoding, leaving diffusion on GPU0.
  Actual per-GPU telemetry and elapsed node/scene timings must demonstrate work;
  memory allocation alone is not evidence of useful parallel computation.
* Retain baseline native/output resolution and four steps for a measured A/B
  candidate. Additional 44 context frames over three scenes add real compute;
  timing and quality benefit are unproven until a new generation completes.

Sources inspected:
- https://github.com/ModelTC/Minimax-H3-Turbo/blob/main/example_workflows/video_minimax_h3_ref2v_lightx2v_turbo.json
- https://github.com/ModelTC/Minimax-H3-Turbo (training resolution/steps/shifts)
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy/supported_models.py
- https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_minimax_h3.py
- https://docs.comfy.org/tutorials/video/minimax/minimax-h3-fun-controlnet

FunControl Union documents Ref2VA support and is a stronger motion-control
candidate. Its GGUF + T4 memory/performance and suitable real exercise input
have NOT been validated. It is not installed or silently substituted here.
HunyuanVideo 1.5 step-distilled 480p is researched, not benchmarked or deployed.

## Required live acceptance

New 25–40-second Gym Challenge; decode every frame; inspect every frame for
identity, anatomy, foot contact, motion and centering; verify varied angles.
Report true native resolution, useful per-GPU work, cold start, diffusion,
VAE and total elapsed times. Reject rather than label a playable but visibly
incorrect output as success. Android tasks remain independently active.
