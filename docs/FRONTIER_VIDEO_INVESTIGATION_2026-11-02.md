# VIBELY frontier-video investigation — 2 November 2026

## Status: NOT COMPLETE — GPU validation and new-video acceptance blocked

This is a technical investigation and implementation-status report, **not a claim that VIBELY has been transformed into a frontier-quality generator**. No new Scarlett video was generated during this investigation. No replacement model has passed a Kaggle compatibility benchmark or visual acceptance. The existing video engine has not been silently replaced with an untested model.

**Hard blocker:** GitHub Actions run **41489720772**, dispatched to audit the video account's hardware, failed at Kaggle SaveKernel with:

> Kaggle rejected worker startup: Maximum weekly GPU quota of 30.00 hours reached.

The audit did not obtain a new GPU allocation. The account's existing kernel subsequently reported `complete`; authenticated source read-back confirmed it was **not overwritten by the rejected hardware probe**. No alternate account was used to circumvent the quota, and no paid external video generation was purchased.

**Scope:** Work in this investigation was restricted to the VIBELY video application, workers, research, tests, and documentation. Android functionality was not modified or investigated for this request.

---

## 1. Executive findings

1. The latest previously completed visual candidate remains **rejected**. Its 624 frames were previously inspected in ordered contact sheets. A playable file is not evidence of acceptable realism.
2. That candidate generated at **320×576**, then scaled to **720×1280**. It does not contain native 720p detail.
3. The recorded visual-worker time was **6,038.657 seconds: 100.64 minutes for 26 seconds of output**. This is a measured earlier result, not a new benchmark.
4. The video worker broadly patches text-encoder and GGUF computation to **FP32**, and launches the VAE with `--fp32-vae`. These are important performance suspects. Removing them without finite-output and visual tests is unsafe: the existing comments describe FP16 overflow problems.
5. Existing multi-GPU placement is **stage placement**: diffusion on GPU0; text encoding and VAE on GPU1. It is not demonstrated tensor parallelism, sequence parallelism, or simultaneous two-GPU diffusion.
6. The strongest research candidate for this mission is **Wan-Animate-2 14B Distilled**, the August 2026 second-generation model. Its direct driving-video conditioning is especially relevant to human motion and identity. This is a **selected experimental target, not an approved production replacement**.
7. Its official A800 results do not establish two-T4 compatibility. A pinned community Q5 conversion exists, but file size alone cannot establish activation memory, numerical stability, speed, or quality.
8. The correct next generation test needs a rights-cleared, normal-speed **real driving performance**, the existing Scarlett references, actual GPU telemetry, and frame-by-frame inspection. A synthetic or arbitrary demo must not be substituted for that test.
9. Safe source changes now prevent explicit requests for an unvalidated engine from silently producing output using the legacy model, and provide a path for immediate GPU-startup failure reporting.

## 2. Hardware evidence and its limits

### Most recent live application observation

The video application's `/api/gpu` response at approximately **17:16 UTC** reported:

| Resource | Observation |
|---|---|
| GPU0 | Tesla T4, 15,360 MiB total; 6,885 MiB allocated; utilization 0% at that instant |
| GPU1 | Tesla T4, 15,360 MiB total; 13,161 MiB allocated; utilization 0% at that instant |
| Active video jobs | 0 |
| Current tasks | Empty |

Subsequent direct tunnel requests failed, and authenticated Kaggle status reported the worker complete. The observation above is **not a statement that GPUs remain available**.

### Earlier same-project runtime logs

`kaggle_diagnostics/joshbond123/comfyui_h3.log` reports:

- `Total VRAM 14912 MB, total RAM 30720 MB`
- `RAM limited by cgroup to 30720 MB (host has 32099 MB)`
- Tesla T4 device initialization for both GPUs.

These are existing runtime observations. They are **not a fresh successful measurement from the rejected probe**. The cgroup limit, rather than the host's total RAM, is the relevant CPU-offload ceiling.

### Constraints that must be respected

- Each device has its own VRAM. The two totals cannot be treated as one contiguous allocation.
- Tesla T4 is a Turing-generation device. Hardware-native BF16, FP8, and NVFP4 acceleration from newer architectures must not be assumed.
- An FP8 checkpoint that is cast back to FP16 for computation is not hardware FP8 inference.
- GPU peer access, effective transfer bandwidth, exact topology, and usable activation headroom were **not newly measured**. The committed hardware probe collects those fields once GPU allocation is available.
- A CPU-offloaded model can fit VRAM yet exceed the approximately 30 GiB process-memory limit, or run extremely slowly through weight transfers.
- A successful model load is not sufficient; the complete reference encode → text encode → denoise → VAE decode → export path must run.

## 3. Current-model research and source discipline

Primary sources were checked on 2 November 2026. Vendor claims, official example configurations, community reports, and this project's actual measurements are kept separate. There is no invented cross-model score or benchmark.

| Candidate | Correct variant and relevant capabilities | Compatibility/performance evidence | Decision |
|---|---|---|---|
| **Wan-Animate-2 14B Distilled** | August 2026 release; character image + direct driving video + text; viewpoint control; 10-step Euler, guidance 1.0. Not the September 2025 Wan-Animate model. | Official examples target 8×A800 at 720p and report testing 2×A800 at 480p. Community GGUF conversions exist. No local two-T4 run completed. | **Selected experimental target**, subject to compatibility and visual gates. |
| Wan-Animate-2 Base | Same application family, higher-step reference for quality comparison. | Official Diffusers example uses 40 steps. Larger runtime cost; no local benchmark. | Quality comparator if distilled output fails, not presumed deployable. |
| **LTX-2.5 22B Distilled** | Current LTX release with native audio-video, image conditioning, two-stage inference and reference/control extensions. Uses **Gemma 4**, not the LTX-2.3 Gemma 3 setup. | Official BF16 components are too large to assume residency on either T4. Official FP8/offload paths and community GGUFs exist. NVFP4 recipes for RTX 50-series/GB10 are not T4 recipes. | Strong general-purpose alternative; reference-adapter and memory/runtime validation required. |
| LTX-2.3 | Earlier 22B generation, with community two-T4 block-splitting work. | The retrieved Kaggle/T4-specific extension targets **2.3**. Its claims cannot be transferred to 2.5. | Do not choose merely because an older variant has an easier recipe. |
| **HunyuanVideo-1.5 8.3B, 480p I2V step-distilled** | First-party image-to-video, 8 or 12 steps recommended; 480p/720p model family and separate SR components. | Official minimum is 14 GB **with offloading**. Official default dtype is BF16; sparse-attention path requires H-series. The published 4090 latency is not a T4 latency. | Most credible documented lower-memory fallback, but still unverified locally. Not selected merely for smaller size. |
| Wan2.2 I2V/T2V A14B | General cinematic image/text video; two timestep experts, not a single 14B-file assumption. | Official large-model configurations require substantial VRAM; quantized/offloaded community routes differ. | Strong alternative, but less direct motion specification than Animate-2 for this mission. |
| Wan2.2 TI2V-5B | Efficient general image/text video with a different VAE and memory profile. | Consumer-GPU implementation documented. | Useful smaller fallback, not the preferred quality ceiling. |
| **Wan-Dancer 14B** | July 2026 hierarchical music-to-dance system; directly relevant to music-aligned choreography. | Distinct global/local stages and additional weights; not equivalent to Animate-2. No local full-system benchmark. | Strong specialist, but not one general engine for walking, exercise, and lifestyle. |
| **MiniMax H3 Ref2VA** | Existing multi-reference audio/video model; official architecture is 33B, with substantial AdaLN branches whose outputs may be precomputed. Core, text encoder, VAEs and turbo adapter must all be budgeted. | Actual project result: 100.64-minute rejected 26-second render. Official serving examples use four GPUs. | Retain only as the disclosed legacy path while a replacement is validated; not an accepted solution. |
| Kandinsky 6.0 Pro / Lite | 29B Pro and 3B Lite synchronized audio-video family; distinct distilled checkpoints. | Current Diffusers/source support exists, but memory and T4 behavior were not measured here. | Pro not proven feasible; Lite not chosen solely for easy fit. |
| MAGI-2 Preview | 114B MoE, approximately 6B active/token, 10-second two-stage audio/video generation. | Official reference implementation requires eight Hopper GPUs. Active parameters do not remove storage/residency requirements for the remaining experts. | Not a credible target for this two-T4 / approximately 30 GiB-RAM environment. |
| LongCat-Video / Avatar 1.5 | Video continuation and specialized audio-driven avatar variants. | Separate model families and inference paths; no local benchmark. Avatar evidence does not prove full-body fitness quality. | Research alternatives, not selected. |
| Mochi 1 / CogVideoX / older SVD | Established open baselines. | Older capability ceiling and differing identity/control support. | Not promoted as the latest 2026 frontier solution. |

Closed-model leaderboards were reviewed as a reference for the commercial quality ceiling. Hosted commercial availability is **not** downloadable model availability or Kaggle compatibility. Different leaderboard task versions/audio conditions were not combined into a single ranking. No claim is made that a locally untested open model matches the latest commercial systems.

## 4. Single selected experimental model and rationale

**Wan-Animate-2 14B Distilled** is the selected target for the first real benchmark.

Why it is the best match to the stated mission, rather than simply the easiest installation:

- Walking, exercise, dancing, hand gestures and fabric motion should be grounded in a real performance, rather than entrusted entirely to prose.
- Animate-2 directly conditions on the driving video, avoiding an intermediate skeleton/pose-estimation stage that can discard expression and hand information.
- It separates target-character appearance from driving motion and offers text-driven viewpoint control.
- Distilled inference has a documented model-specific schedule: **10 steps, Euler, guidance 1.0**. It is not legitimate to attach an arbitrary four-step adapter from another model.
- Its Apache-2.0 release is operationally simpler than territorial community-license restrictions, subject to checking every redistributed dependency and input asset.

Important limitations:

- It is not an arbitrary text-only motion generator. The service needs an appropriate driving video. Prompt text alone cannot guarantee the requested physical performance.
- It does not establish native music synchronization merely because it accepts motion video. Beat synchronization must be present in the driving performance and verified against the final soundtrack.
- One reference image is the documented direct identity input. Multiple Scarlett references must not be falsely described as native multi-reference conditioning unless a tested adapter actually supplies them. Existing images must be retained for reference selection and identity review.
- Body identity, foot contact, breast/soft-tissue motion, clothing and hair remain **evaluation targets**, not guaranteed capabilities.
- Full-body reference/framing and full-body driving footage are necessary for evaluating feet and weight transfer. A medium-shot demo cannot establish these properties.

### Pinned trial artifact

The Hugging Face API was used to verify this exact community conversion:

- Repository: `realrebelai/Wan-Animate-2_GGUFs`
- Revision: `46b287218ffe4223cfedba0c06e36db356d34ff9`
- File: `Distilled/Wan-Animate-2-14B-TURBO-Q5_K_M.gguf`
- Exact bytes: **12,741,204,960**
- SHA256: `c43e655ea8e76420630526291c75359c7fd4114efb592b07f67c0d99ab51296f`

The official Distilled Diffusers revision observed was `59e4141466bcb1bf9733eca1bc78be6891c9fbdf`.

**This is not a fit or quality claim.** Community quantization, model recognition by the GGUF loader, reference/pose branch support, intermediate dtypes, activation memory and decoder behavior must all be tested. Q6 or higher precision should be compared if the measured memory budget permits. Extreme quantization is not the default escape hatch.

## 5. Sixteen-dimensional assessment of the selected candidate

| Requirement | Current evidence and remaining test |
|---|---|
| Human photorealism | Official human demonstrations are promising; no Scarlett result exists from this candidate. |
| Facial identity | Character-reference conditioning is designed for identity; verify face crops throughout turning and occlusion. |
| Anatomy | Direct human driving footage is a useful control, not an anatomical guarantee. Review all frames. |
| Natural movement | Driving-video conditioning is the key architectural advantage; timing must remain unchanged. |
| Walking/dancing | Require full-body, normal-speed, rights-cleared motion references and separate acceptance clips. |
| Clothing/fabric | Condition on reference clothing and maintain it; check seams, stretch, folds and garment persistence. |
| Hair | Check strand consistency, inertia, occlusion and silhouette changes; not separately benchmarked. |
| Camera | Text-driven viewpoint control documented; use a locked-camera baseline before testing angle changes. |
| Environment | Fresh-background generation documented; assess object permanence, perspective, reflections and shadows. |
| Temporal consistency | Test continuation, occlusions and transitions; no guarantee from a still-image similarity score. |
| Reference conditioning | Native character image plus driving video; do not mislabel as arbitrary multi-reference input. |
| Resolution/fps | Official examples export 24 fps. Actual native resolution must be recorded, not inferred from the final container. |
| Generation speed | **Unknown on these T4s.** Official A800/other-GPU results are not transferable measurements. |
| Memory | Exact trial weight size known; end-to-end activation, encoder, VAE and host peaks unknown. |
| Multi-GPU | Official parallel configurations exist for larger GPUs; T4 implementation and benefit unverified. |
| Kaggle feasibility | Credible research target, **not yet proven**; allocation attempt blocked by weekly quota. |

## 6. Real demonstration review boundaries

One official Wan-Animate-2 dance demonstration was downloaded **for research only**. Eight ordered frames covering its first 3.5 seconds were inspected. The composite showed a reference portrait, driving performance and generated result. The sampled output had plausible facial expression and upper-body gesture correspondence, but the medium framing did not expose feet or full-body exercise mechanics.

The promotional composite encoded at **25 fps**, 1700×1500, about 11.54 seconds. These are properties of the demonstration asset, **not a native model benchmark**. This demo is not Scarlett, is not a VIBELY generation, was not substituted into the library, and does not satisfy mandatory acceptance.

## 7. Existing VIBELY architecture

Current flow:

1. Website submits a video job.
2. `reasoningEngine.ts` requests a structured creative plan from NVIDIA-hosted reasoning models.
3. Existing planning selects the content series, scenes, music plan and captions/hashtags workflow.
4. `comfyOrchestrator.ts` acquires durable GPU leases and requests Kaggle worker startup through GitHub Actions.
5. The video worker prepares cached MiniMax H3 models, the quantized Qwen text encoder, reference images and VAEs, and starts ComfyUI.
6. Three scenes render sequentially. Later scenes receive a 22-frame temporal guide.
7. Rendered scenes are trimmed, resized, concatenated, joined with separately generated music, decoded/validated, and saved to application storage.
8. Persistence receipts, GPU lifecycle state, generation history and social metadata are maintained by the backend.

Existing useful pieces should be retained: durable generation IDs/history, leases, references, video library, captions and hashtags, Comfy orchestration, progress/stage reporting, and output persistence. A renderer replacement should be behind a versioned adapter, not a destructive application rewrite.

## 8. Why the existing output is unrealistic

### Directly observed defects

Previously inspected 624-frame output failed for framing/feet visibility, subject drift toward/outside the frame edge, inadequate full-body coverage, and posing replacing portions of the intended exercise. These defects prevent accepting the claimed motion/physics improvement.

### Code and architecture findings

- Native 320×576 generation cannot recover missing facial, fabric and environmental detail merely through Lanczos scaling.
- Existing prose asks for complex body/camera behavior without a real exercise-driving performance.
- Some camera instructions requested changing angles within a continuous sequence while also requesting fixed distance/axis and seamless pose continuity. These constraints need a coherent shot plan, not more competing adjectives.
- A face crop helps allocate reference pixels to the face; it does not prove stable identity under large pose changes.
- Reusing preceding generated frames can carry defects forward. A temporal guide is not ground truth for correct motion.
- Prior acceptance conflated playability with quality. This report and the new policy explicitly separate them.

No unsupported claim is made that one source-code finding explains every visual defect.

## 9. Performance investigation

### Earlier measured visual-worker result

| Scene | Worker inference seconds | Total scene seconds | Rendered frames | Guide frames | Output frames |
|---|---:|---:|---:|---:|---:|
| 1 | 1653.970 | 1663.067 | 209 | 0 | 208 |
| 2 | 2176.131 | 2184.576 | 243 | 22 | 208 |
| 3 | 2176.123 | 2184.287 | 243 | 22 | 208 |

Total worker processing: **6038.657 seconds**. Final output: **624 frames, 26 seconds, 24 fps**. Generated frame count: 695, including context and frame-grid padding that was not in the final video.

Existing node observations separately recorded approximately 1334.52 / 1827.95 / 1828.51 seconds in sampling and 247.81 / 273.29 / 273.34 seconds in VAE work. These explain why encoding/network micro-optimizations alone cannot plausibly remove the bulk of the latency. They are earlier observations, not a new controlled profiling run.

### Partial GPU observations

Of 140 usable telemetry snapshots in the earlier partial observation window:

| GPU | Snapshots with utilization >0 | Peak utilization | Peak allocated memory |
|---|---:|---:|---:|
| 0 | 117 | 100% | 14635 MiB |
| 1 | 22 | 100% | 14023 MiB |

This is **not complete-run average utilization** and does not prove a speedup. It does show useful but largely stage-separated work, rather than two equally active diffusion devices.

### Bottlenecks and evidence quality

| Area | Finding | Status |
|---|---|---|
| Numeric precision | Broad FP32 overrides and FP32 VAE are visible in source. | Confirmed configuration; exact causal speed penalty unmeasured. |
| Diffusion and VAE | Earlier node timings account for most wall time. | Measured earlier. |
| Frame overhead | 695 generated versus 624 delivered frames. | Confirmed; visual value of context requires controlled testing. |
| GPU placement | Text/VAE placement on GPU1 does not shard diffusion. | Confirmed source behavior; no acceleration claim. |
| Quantization | GGUF may dequantize/cast during execution; file size is not compute precision. | Must profile actual kernels and finite outputs. |
| Cache/downloads | Existing runtime reported dataset-cached model files. | No proof repeated downloads caused the 100-minute warm render. |
| CPU memory/offload | Earlier cgroup limit approximately 30 GiB; large encoders and staging compete. | Capacity observed; swap/page-fault contribution unmeasured. |
| Encoding | Existing code copies video during audio mux, with separate normalization/assembly stages. | No evidence encoding dominates diffusion. |
| Startup errors | GitHub 204 dispatch could precede a failed Kaggle SaveKernel and a long readiness wait. | Actual quota failure reproduced; reporting path implemented. |
| Output lifecycle | A music failure can prevent normal final output acknowledgement after visual work completes. | Source-level risk to investigate; not claimed fixed here. |
| Long-running jobs | Existing per-stage deadlines do not constitute model-specific progress prediction. | Further work required. |

### Before/after table

| Metric | Earlier rejected candidate | New replacement |
|---|---|---|
| Total visual-worker time | 100.64 minutes | **Not measured** |
| Model-loading time | Not isolated in this evidence | **Not measured** |
| Inference | Per-scene values above | **Not measured** |
| Rendering/mux | Not isolated reliably | **Not measured** |
| Native resolution | 320×576 | **Not generated** |
| Encoded output | 720×1280, 24 fps, 26 seconds | **Not generated** |
| Visual acceptance | Failed | **Not tested** |
| Measured multi-GPU speedup | None established | **None established** |

## 10. Proposed replacement pipeline — not activated

1. **Versioned model adapter:** require actual checkpoint identity/revision in worker health and output provenance. Reject silent fallback.
2. **Hardware gate:** capture both GPUs, system/cgroup RAM, P2P/topology and available disk before loading any candidate.
3. **Pinned cache:** content-addressed, exact-size/SHA256 verified weights in a persistent Kaggle dataset. Preserve Scarlett references separately. Do not overwrite the legacy cache.
4. **Character input:** preserve all original Scarlett assets; select a full-body identity reference appropriate to the shot. Record which original image or tested derivative was used.
5. **Motion library:** rights-cleared, normal-speed clips for walking, squats/recovery, dance, turns and phone pickup/put-down. Record license, fps, timestamps, duration and camera angle. No unlabelled borrowed demo assets.
6. **Shot planning:** locked camera by default. Multiple camera angles require intentional, continuity-aware cuts, not continuous unmotivated orbits. Full-body mechanics shots must retain head, hands, shoes and floor contact.
7. **Inference:** start with the exact distilled schedule and a legal native frame grid. Compare precision and offload strategies without changing the task, seed, motion input and resolution simultaneously.
8. **Multi-GPU trial:** first prove correct device placement. Distinguish donor memory from computation on GPU1. Then compare one versus two GPUs under the same settings and report latency, aggregate GPU-seconds and peak memory.
9. **Continuation:** follow tested model-specific continuation/trim semantics. The documented Wan workflow uses legal `4n+1` lengths and removes continuation overlap; do not transplant H3's `17n+5` grid.
10. **Music:** use a driving performance aligned to the selected musical beat grid. Do not stretch footage to hide slow movement. Music timing is independent of inference wall time.
11. **Decode/refinement:** use tiled VAE when tested; reserve VAE memory rather than relying on optimistic weight-only budgets. No upscaler/interpolator is assumed to repair anatomy or identity.
12. **Persistence:** decode and persist the visual master before a later music failure can strand it; maintain an honest distinction between a recovered visual-only asset and a completed final production. This lifecycle correction still needs implementation/testing.
13. **Quality gate:** inspect every output frame before promoting a candidate. Playback success, face similarity and pose scores are screening evidence only.

## 11. Prompt/reasoning-engine requirements

The project already uses a substantial hosted NVIDIA reasoning model with structured scene output. Replacing its name without an actual provider/capability test would not be a meaningful upgrade. The next implementation should strengthen its machine-validated production contract.

For every production, validate all sixteen requested fields: concept, storyline, identity, scenes, movement, body physics, camera position, camera movement, camera angle, lighting, environment, clothing, music synchronization, transitions, negative-prompt policy, and actual technical settings.

The contract must additionally bind:

- Existing Scarlett reference identifiers, not an invented replacement identity.
- A licensed motion-reference identifier and exact clip time range.
- Natural-speed timing, weight transfer, heel/toe contact and balance criteria.
- Consistent garment state and environmental anchor objects across connected shots.
- A locked-camera default and an explicit reason for any camera movement.
- An occasional handheld shot only where a suitable motion reference shows a believable grip, arm posture, perspective transition and return of the phone. Random selection must not silently fabricate unsupported motion.
- Actual model capability flags, rather than generic promises.

**Negative prompts:** Wan-Animate-2 Distilled uses guidance 1.0/no CFG in the official example. Do not claim that a conventional negative prompt is actively suppressing defects in that configuration. Positive instructions, motion conditioning and rejection criteria remain relevant; negative conditioning must follow the specific model/variant.

This full production-contract/reasoning upgrade has **not been integrated or visually validated** in this iteration. Prompt changes alone would not satisfy this mission.

## 12. MiniMax H3 retention assessment

MiniMax H3 should not be retained as the assumed final solution solely because the project already downloads it. The actual current quantized/FP32 configuration has failed both latency and visual acceptance.

Its official community license excludes the United States, EU, UK and Republic of Korea from the applicable territory, and includes other conditions. The user's location is not sufficient to establish the execution/distribution territory of Kaggle-hosted inference and generated works. Deployment/distribution geography and permissions need review; this report does not assert that a particular current session violated the license.

Keep the current implementation/history as a disclosed legacy baseline during validation. Do not delete references, library entries or model provenance to conceal the failed baseline. Promote a replacement only after an actual successful run and visual review.

## 13. Implemented source changes

### Hardware audit

`workers/hardware_probe.py` collects GPU names/memory, compute capability, CUDA/PyTorch details, peer-access flags, topology, CPU count, host memory and disk state without loading a model or printing credentials. `workers/deploy.py` and the GitHub worker workflow accept a one-shot `probe` mode.

**Execution:** dispatched; rejected by Kaggle weekly quota. There is no probe result masquerading as a successful allocation.

### Explicit engine identity and readiness

`src/server/videoEnginePolicy.ts` records the exact experimental model/artifact and marks it **inactive, not runtime validated, not visually tested**. `/api/video-engine/readiness` discloses that state.

An explicit request for the unvalidated candidate or an unknown engine is rejected before generation. An unknown request must not silently run MiniMax H3 and be reported as another model.

### GPU-startup failure propagation

The deployment script redacts known secret values and reports normal video/music startup failures to an authenticated `/api/gpu/startup-failed` route. The route is service-checked and time-bounded; an older attempt cannot overwrite a later requested session or an already-ready worker. Probe errors do not mutate production GPU state.

A readiness loop also stops on a terminated failed startup with a stored error instead of silently resubmitting that failure indefinitely.

### Pinned artifact verification

`workers/verified_model_cache.py` requires an immutable revision, safe path, exact byte length and SHA256. It rejects truncated and same-size corrupted weights. It is a tested component for the replacement path, **not a claim that the existing MiniMax loader has already been migrated to it**.

### Genuine website benchmark harness

`tools/benchmark_deployed_video.py` is a resumable, single-submission harness. It refuses inactive models, uses the website's actual generation API, records real progress/GPU snapshots, downloads actual output and performs a complete decode. An uncertain POST is not automatically retried. A decoded video remains `REQUIRES_EVERY_FRAME_REVIEW`, never automatically quality-approved.

It has **not generated a new video** because the selected candidate is unvalidated/inactive and GPU allocation is unavailable.

## 14. Tests and deployment status

Local tests executed:

- Client and server build: passed.
- Video-engine policy tests: passed.
- Five pinned-cache tests: passed, including same-size corruption and immutable-revision/path guards.
- Three existing worker-workflow regression tests: passed.
- Python compilation and Git whitespace checks: passed.

These are structural/software checks, not generation-quality or two-GPU compatibility tests.

Source commits already pushed:

- `6fed191` — Kaggle video hardware audit and probe deployment mode.
- `685b142` — unvalidated-engine guard, candidate policy, startup-failure reporting, pinned asset verification and tests.

Additional benchmark/guard/documentation changes are recorded by the subsequent video-only commit. The accompanying deployment evidence file records the live API checks; a pushed commit or successful build alone does not establish deployment or generation success.

## 15. Mandatory new-video test status

**Not performed.** The hardware-probe allocation failed before model benchmarking. No new model output was substituted with an official demo, an existing library video, or a mock response.

| Acceptance target | Result |
|---|---|
| Consistent Scarlett facial identity | Not tested on selected candidate |
| Photoreal skin/human appearance | Not tested |
| Correct anatomy/body proportions | Not tested |
| Natural walking/foot contact | Not tested |
| Rhythm-synchronized dancing | Not tested |
| Fitness mechanics/secondary physics | Not tested |
| Clothing/environment consistency | Not tested |
| Stationary/professional camera | Not tested |
| Temporal consistency/natural timing | Not tested |
| New final video smooth/playable | No new final video |
| GPU0/GPU1 utilization and peaks | Earlier baseline observations only; no new benchmark |
| Loading/inference/render/total times | New measurements unavailable |

## 16. Required validation sequence when resources are available

1. Re-run the one-shot hardware audit, without assuming a repeated session has the same GPUs/RAM.
2. Validate model recognition, references and driving branch before spending time on a full clip. In particular, confirm that the GGUF loader actually passes the Animate-2 motion branch rather than accepting a file while ignoring the video.
3. Run a short native-resolution test at the correct 10-step/CFG-1 settings. Reject NaN/Inf output and geometry/identity failures.
4. Compare Q5/Q6 or higher precision where feasible, attention backends supported on SM75, and memory placement. Do not assume FlashAttention-2, Hopper sparse attention, FP8 or NVFP4 paths work on T4.
5. Compare stage placement and actual distributed computation. Record useful per-GPU work, latency, GPU-seconds, RAM, VRAM and transfer overhead. Donor VRAM alone is not a speedup.
6. Generate a new Scarlett test **through the deployed website**. Use explicit engine selection and verify worker checkpoint provenance.
7. Record cold and warm runs separately; isolate text encode, denoise, VAE and assembly where instrumentation supports them.
8. Decode every frame; inspect ordered full-frame and face/body-detail views. Evaluate gait, planted feet, joints, hands, clothing, hair, shadows and background continuity. Check motion against the driving performance and soundtrack timing.
9. Correct identified defects and generate another actual test if the first fails. Do not recycle the same output as a new result.
10. Only then activate a replacement and claim a measured before/after improvement. If two T4s cannot meet acceptable quality/latency, state the hardware ceiling rather than promise commercial parity.

## 17. Primary and supporting sources

1. [Wan-Animate-2 official repository](https://github.com/Wan-Video/Wan-Animate-2) — architecture, releases, official hardware examples and distilled settings.
2. [Wan-Animate-2 official model card](https://huggingface.co/Wan-AI/Wan2.2-Animate-2-14B) and [paper](https://arxiv.org/abs/2608.06009).
3. [Official project demonstrations](https://humanaigc.github.io/wan-animate-2/).
4. [ComfyUI Wan Animate 2 documentation](https://docs.comfy.org/tutorials/video/wan/wan-animate-2) — workflow, frame grid and continuation behavior.
5. [Community conversion repository](https://huggingface.co/realrebelai/Wan-Animate-2_GGUFs) — exact pinned trial file, not an official quality benchmark.
6. [Wan2.2 official repository](https://github.com/Wan-Video/Wan2.2).
7. [Wan-Dancer official repository](https://github.com/Wan-Video/Wan-Dancer).
8. [LTX official repository](https://github.com/Lightricks/LTX-2) and [LTX-2.5 weights](https://huggingface.co/Lightricks/LTX-2.5).
9. [HunyuanVideo-1.5 official repository](https://github.com/Tencent-Hunyuan/HunyuanVideo-1.5) — 14 GB offload qualification, exact model variants and step-distilled schedule.
10. [MiniMax H3 official repository](https://github.com/MiniMax-AI/MiniMax-H3) and [official license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
11. [MAGI-2 Preview official repository](https://github.com/SandAI-org/MAGI-2-preview).
12. [Kandinsky 6 repository](https://github.com/KozlovKY/kandinsky-6).
13. [LongCat-Video repository](https://github.com/meituan-longcat/LongCat-Video).
14. [Artificial Analysis image-to-video leaderboard](https://artificialanalysis.ai/video/leaderboard/image-to-video) — commercial comparison context; not a two-T4 benchmark.
15. [WanGP](https://github.com/deepbeepmeep/WanGP) — relevant low-memory implementation research, not proof of this deployment.
16. [Community LTX-2.3 two-T4 extension](https://github.com/THE-ANGEL-AI/ComfyUI-LTX2-MultiGPU) — variant-specific evidence that must not be relabelled LTX-2.5 support.

## 18. Bottom line

The investigation identified a substantially better architectural direction for motion control, a precisely pinned experimental checkpoint, specific latency/quality failure mechanisms, and safe readiness/error-handling improvements. It did **not** complete the requested renderer replacement, structured prompt-engine rebuild, two-GPU optimization, or mandatory new Scarlett generation and frame-by-frame acceptance.

The project must remain labelled **incomplete / blocked on GPU validation**, not “frontier-quality completed.”
