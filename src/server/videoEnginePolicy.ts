/** A researched candidate is not an operational or quality-approved model. */
export const LEGACY_VIDEO_ENGINE = 'minimax_h3_ref2va';
export const FRONTIER_VIDEO_CANDIDATE = {
  id: 'wan_animate_2_distilled_14b',
  name: 'Wan-Animate-2 14B Distilled',
  official_checkpoint: 'Wan-AI/Wan2.2-Animate-2-14B-Distilled-Diffusers',
  official_revision: '59e4141466bcb1bf9733eca1bc78be6891c9fbdf',
  quantized_trial: {
    repo: 'realrebelai/Wan-Animate-2_GGUFs',
    revision: '46b287218ffe4223cfedba0c06e36db356d34ff9',
    file: 'Distilled/Wan-Animate-2-14B-TURBO-Q5_K_M.gguf',
    bytes: 12741204960,
    sha256: 'c43e655ea8e76420630526291c75359c7fd4114efb592b07f67c0d99ab51296f',
    quality_and_runtime_validated: false,
  },
  runtime_validated: false,
  visual_acceptance: 'not_tested',
  activated: false,
  steps: 10,
  guidance_scale: 1,
  sampler: 'euler',
  fps: 24,
  requires_driving_video: true,
  negative_prompt_effective: false,
  multi_gpu_acceleration_measured: false,
  reason_inactive: 'Requires a successful Kaggle compatibility benchmark and new Scarlett frame-by-frame acceptance test. Research and weight size are not runtime proof.',
  sources: ['https://github.com/Wan-Video/Wan-Animate-2', 'https://docs.comfy.org/tutorials/video/wan/wan-animate-2'],
} as const;

export function validateRequestedVideoEngine(requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === LEGACY_VIDEO_ENGINE) return null;
  if (requested === FRONTIER_VIDEO_CANDIDATE.id) return FRONTIER_VIDEO_CANDIDATE.reason_inactive;
  return 'Unknown video generation engine; refusing silent fallback to a different model.';
}

export function redactStartupError(error: unknown): string {
  return String(error || 'GPU worker startup failed')
    .replace(/(?:KGAT_|hf_|nvapi-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1000);
}
