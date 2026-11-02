# Post-change acceptance — 2 November 2026

## Android display / revised always-awake requirement

The user replaced the earlier fifteen-minute inactivity-lock requirement with always-awake operation. The original session remains `emu_41424314059_c4be3a`; it was not wiped or replaced for the display fix.

Implemented and deployed from committed source:
- Native `svc power stayon true`; `stay_on_while_plugged_in=15`; screen timeout `2147483647` ms. Credentials, PIN/password, and radio settings were not disabled or reset.
- No visible Connecting/Reconnecting/recovery notification overlay.
- Real cached native JPEG embedded in the initial page, plus a same-tab last-real-frame preview. These are held previews, not fabricated live frames.
- JPEG fallback support, alongside the actual H.264/WebCodecs stream.
- Real media stays warm without viewers. Cold-cache encoder recovery changes only the encoder, not Android or its userdata.
- Cached GOP replay is identified as held output; it does not increment the fresh-frame counter. A static Android screen no longer triggers a reconnect solely because its pixels have not changed.

Browser tests passed: actual H.264 decoding after a native swipe; input acknowledgements; real preview visible on reload; no visible connection overlay. One fresh-frame measurement was **2695 ms**, not zero delay. Native input acknowledgements in that run were approximately 366–448 ms. This is one test connection, not an Internet-wide latency guarantee.

An independent UTC wall-clock check observed `mWakefulness=Awake` after **1175 seconds**, with the test client injecting no controls during the interval. Full evidence: `always_awake_wallclock_check.json`. A separate monotonic-timer browser wait was superseded by this independent native check because Arena workspace suspension pauses the local timer; it is not claimed as an additional completed test.

There is no honest guarantee of permanent availability: the original Actions runner is expected to expire around 15:48 UTC. The display changes do not extend its job lifetime.

## State recovery — not yet accepted

The long frozen transfer was explicitly stopped to restore live use. Draft release 431560693 is incomplete and must not be represented as a valid checkpoint.

After the user delegated the method choice, a bounded incremental emergency rescue was dispatched as run **41469967201**, draft release **431616525**. Its live precopy is explicitly UNTRUSTED. Publication requires independent frozen-source block hashes, reconciliation within a maximum 120-second filesystem freeze, thaw confirmation, authenticated GitHub readback, and an authenticated manifest. No snapshot is accepted merely because encrypted assets exist.

An isolated, network-fenced restore is preparing from that release. This is not a public cutover and does not prove Google online authentication. The rescue omits original host configuration/RAM and original host-private ADB key; these limitations must not be hidden. Reconstructed whole-AVD capture is attempted only after a native signed-in restore test passes.

The isolated zero-account A→B→A-stop test **41458767088 passed**, including a write made after B's first boot and fencing of the old writer. That result does not establish current-account migration, Store/TikTok, Notes, production four-hour rotation, or all A–F acceptance criteria.

## New Gym render — completed technically, rejected visually

Files:
- `gym_challenge_motion_v1_review.mp4`: muxed review copy, 26.00 seconds, 720×1280, H.264, 24 fps, AAC stereo.
- `motion_v1_candidate.mp4`: actual recovered visual output.
- `motion_v1_original_score.mp3`: newly generated original score; service reports 26.06 seconds.
- `candidate_all_frame_review/sheet_01.jpg` through `sheet_13.jpg`: all **624 frames**, consecutively labelled, no frames omitted.

The entire visual file and final audiovisual file decoded successfully. The worker acknowledged only a persisted playable file; this was NOT a quality acceptance receipt.

**Visual acceptance: FAIL.** All 624 frames were inspected in ordered contact sheets. Findings:
- Full-body framing is lost early; shoes are clipped through much of the first scene.
- Around 9.5–15.5 seconds the subject drifts into the left edge, often mostly out of frame.
- Similar left-edge cropping recurs around 20–23 seconds.
- The requested continuous centered full-body exercise is not delivered. Complete head/hand/shoe margins and the specified squat mechanics cannot be verified through the cropped sections.
- Cinematic viewpoint variety and unchanged identity across every angle are not demonstrated. The provided identity references were not replaced, but unchanged input references do not guarantee unchanged generated identity.
- Adding a 22-frame guide did not solve the observed failure. It must not be advertised as a validated quality improvement.

No artificial recropping or fabricated replacement frames were used to disguise these failures. The review video is a rejected candidate, not the requested final quality-approved Gym deliverable.

## Measured compute / timing

Actual video-worker job: `vid_4d4bb0e53a31cc8665ab`.
Elapsed worker time: **6038.66 seconds (100.64 minutes)**. The original parent failed on its music timeout while the visual job continued; that failure was not reported as a successful production.

| Actual stage | Scene 1 | Scene 2 | Scene 3 |
|---|---:|---:|---:|
| Sampler node 16 | 1334.52 s | 1827.95 s | 1828.51 s |
| VAE node 17 until output node | 247.81 s | 273.29 s | 273.34 s |

The later scenes took approximately 37% longer in sampling than scene 1 in this run. This is not a controlled causal A/B benchmark; it does not prove the guide alone caused that difference, nor establish an improvement over the rejected baseline.

Live telemetry captured 140 valid video-worker observations:
- Video GPU 0: T4, 15,360 MiB reported memory, peak 14,635 MiB; 117 samples above 10% utilization; peak 100%.
- Video GPU 1: T4, 15,360 MiB reported memory, peak 14,023 MiB; 22 samples above 10% utilization; peak 100%.

GPU 1's VAE work is useful, but these are mostly sequential stages. This is not a claim of concurrent dual-GPU sampling or unified 32 GB VRAM. Sampling gaps and the missing early telemetry interval preclude a complete utilization integral. The music worker is a separate allocation and must not be conflated with the video's two GPUs.

## Remaining unaccepted work

Current-account checkpoint/restore, genuine official-Play Store TikTok installation and state tests, production lossless 225/240-minute rotation, all requested failure tests, and a visually acceptable post-improvement Gym video are not complete. Exact Ref2VA-compatible FunControl research exists, but it has not been installed and benchmarked as a working T4 solution. Documentation is not a substitute for those tests.
