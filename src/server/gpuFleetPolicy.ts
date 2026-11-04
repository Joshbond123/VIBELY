/** Documented accounts are configurations, never evidence of allocated hardware. */
export const WEEKLY_SECONDS=30*3600;
export const GPU_PROFILES=[
 {id:'music-primary',role:'music',priority:'primary',account:'black797',token_env:'KAGGLE_BLACK797_TOKEN',kernel_ref:null,desired_engine:'minimax_music_3',cache_dataset:null},
 {id:'music-backup',role:'music',priority:'backup',account:'happink',token_env:'KAGGLE_HAPPINK_TOKEN',kernel_ref:'happink/vibely-music-gpu-worker',desired_engine:'minimax_music_3',cache_dataset:'happink/minimax-music-3-q4-0-gguf-cache'},
] as const;
export function overlapSeconds(start:number,end:number,windowStart:number,windowEnd:number){
 if(![start,end,windowStart,windowEnd].every(Number.isFinite)||end<start||windowEnd<windowStart)throw new Error('Invalid usage interval');
 return Math.max(0,Math.min(end,windowEnd)-Math.max(start,windowStart));
}
