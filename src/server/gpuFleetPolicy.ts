/** Documented accounts are configurations, never evidence of allocated hardware. */
export const WEEKLY_SECONDS=30*3600;
export const ROTATION_SECONDS=30*60;
export const GPU_PROFILES=[
 {id:'video-primary',role:'video',priority:'primary',account:'temilolo',token_env:'KAGGLE_TEMILOLO_TOKEN',kernel_ref:null,desired_engine:'wan_animate_2_distilled_14b',cache_dataset:'temilolo/vibely-wan-animate2-distilled-q5-cache'},
 {id:'video-backup',role:'video',priority:'backup',account:'joshbond123',token_env:'KAGGLE_JOSHBOND_TOKEN',kernel_ref:'joshbond123/vibely-minimax-h3-ref2va-server',desired_engine:'wan_animate_2_distilled_14b',cache_dataset:'joshbond123/vibely-wan-animate2-distilled-q5-cache'},
 {id:'music-primary',role:'music',priority:'primary',account:'black797',token_env:'KAGGLE_BLACK797_TOKEN',kernel_ref:null,desired_engine:'minimax_music_3',cache_dataset:null},
 {id:'music-backup',role:'music',priority:'backup',account:'happink',token_env:'KAGGLE_HAPPINK_TOKEN',kernel_ref:'happink/vibely-music-gpu-worker',desired_engine:'minimax_music_3',cache_dataset:'happink/minimax-music-3-q4-0-gguf-cache'},
] as const;
export interface RotationInput {
 activeSeconds:number; activeJobs:number; pendingReceipts:number; queuedJobs:number;
 providerQuotaExhausted:boolean; currentSessionTerminated:boolean;
 candidates:Array<{id:string;available:boolean;remainingSeconds:number|null;quotaVerifiedAt:number|null;modelVerified:boolean}>;
 now:number;
}
export function planRotation(s:RotationInput){
 // Multiple accounts must not be used to route around an exhausted provider quota.
 if(s.providerQuotaExhausted)return {action:'BLOCKED_PROVIDER_QUOTA',next:null};
 if(s.activeSeconds<ROTATION_SECONDS)return {action:'CONTINUE',next:null};
 if(s.activeJobs>0 || s.pendingReceipts>0)return {action:'DRAIN_AT_SAFE_BOUNDARY',next:null};
 if(!s.currentSessionTerminated)return {action:'STOP_AND_CONFIRM_TERMINATION',next:null};
 if(!s.queuedJobs)return {action:'REMAIN_OFF_NO_WORK',next:null};
 const eligible=s.candidates.filter(c=>c.available && c.modelVerified && c.remainingSeconds!==null && c.remainingSeconds>0 && c.quotaVerifiedAt!==null && c.quotaVerifiedAt<=s.now && s.now-c.quotaVerifiedAt<=300)
  .sort((a,b)=>b.remainingSeconds!-a.remainingSeconds! || a.id.localeCompare(b.id));
 return eligible.length?{action:'START_NEXT',next:eligible[0].id}:{action:'BLOCKED_NO_VERIFIED_CAPACITY',next:null};
}
export function overlapSeconds(start:number,end:number,windowStart:number,windowEnd:number){
 if(![start,end,windowStart,windowEnd].every(Number.isFinite)||end<start||windowEnd<windowStart)throw new Error('Invalid usage interval');
 return Math.max(0,Math.min(end,windowEnd)-Math.max(start,windowStart));
}
