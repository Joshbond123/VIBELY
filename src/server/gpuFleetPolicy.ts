/** Documented accounts are configurations, never evidence of allocated hardware. */
export const WEEKLY_SECONDS=30*3600;
export const GPU_PROFILES=[
 {id:'video',role:'video',priority:'dedicated',account:'temilolo',token_env:'KAGGLE_TEMILOLO_TOKEN',kernel_ref:'temilolo/vibely-video-gpu-worker',desired_engine:'ltx_2_3_distilled_gguf_q4',cache_dataset:'temilolo/ltx-23-distilled-q4-cache'},
 {id:'music',role:'music',priority:'dedicated',account:'black797',token_env:'KAGGLE_BLACK797_TOKEN',kernel_ref:'black797/vibely-music-gpu-worker',desired_engine:'minimax_music_3',cache_dataset:'black797/minimax-music-3-q4-0-gguf-cache'},
] as const;
export function overlapSeconds(start:number,end:number,windowStart:number,windowEnd:number){
 if(![start,end,windowStart,windowEnd].every(Number.isFinite)||end<start||windowEnd<windowStart)throw new Error('Invalid usage interval');
 return Math.max(0,Math.min(end,windowEnd)-Math.max(start,windowStart));
}
