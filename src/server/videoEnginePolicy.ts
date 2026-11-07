/** One hosted generator; no local renderer or GPU fallback. */
export const NVIDIA_VIDEO_MODEL='nvidia/cosmos3-nano';
export const NVIDIA_VIDEO_ENDPOINT='https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano';
export const NVIDIA_VIDEO_SPEC={id:NVIDIA_VIDEO_MODEL,name:'NVIDIA Cosmos3 Nano',provider:'NVIDIA hosted API',endpoint:NVIDIA_VIDEO_ENDPOINT,modes:['text2video','image2video'],resolution:'720_9_16',fps:24,steps:35,maximum_frames:197,visual_acceptance:'not_verified',sources:['https://build.nvidia.com/nvidia/cosmos3-nano/modelcard']};
export const LTX_VIDEO_SPEC={id:'ltx_2_3_distilled_gguf_q4',name:'LTX-2.3 Distilled GGUF Q4_K_M',provider:'Kaggle · Temilolo',fps:24,steps:8,maximum_frames:121,visual_acceptance:'not_verified',on_demand:true};
export function validateRequestedVideoEngine(requested:unknown):string|null {
 return requested==null||requested===LTX_VIDEO_SPEC.id?null:'Video now uses LTX-2.3 Distilled GGUF Q4 on Temilolo. This historical engine is retired.';
}
export function redactStartupError(error:unknown):string {
 return String(error||'Provider request failed').replace(/(?:KGAT_|hf_|nvapi-|ghp_|github_pat_)[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]').replace(/for account[^\n.]*/gi,'for account [REDACTED]').replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g,'$1?[REDACTED]').slice(0,1000);
}
