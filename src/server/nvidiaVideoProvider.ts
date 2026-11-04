import fs from 'node:fs';
import path from 'node:path';
import {query} from './db.js';
import {NVIDIA_VIDEO_ENDPOINT,NVIDIA_VIDEO_MODEL,redactStartupError} from './videoEnginePolicy.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export function retryAfterMs(value:string|null,now=Date.now()):number {
 if(!value)return 60000;
 const seconds=Number(value);const ms=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now;
 return Number.isFinite(ms)?Math.max(1000,ms):60000;
}
export function providerFrameCount(wanted:number):number {
 if(!Number.isInteger(wanted)||wanted<1||wanted>196)throw Error('Invalid native segment duration');
 return Math.max(25,4*Math.ceil((wanted-1)/4)+1);
}
export function decodeProviderVideo(body:any):Buffer {
 let encoded=body?.b64_video;
 if(typeof encoded!=='string')throw Error('NVIDIA response did not contain documented b64_video; no substitute will be used');
 encoded=encoded.replace(/^data:video\/mp4;base64,/, '');
 if(encoded.length>128*1024*1024||!encoded.length||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('Invalid NVIDIA video encoding');
 const video=Buffer.from(encoded,'base64');
 if(video.length<12||video.toString('ascii',4,8)!=='ftyp')throw Error('NVIDIA output is not an MP4 container');
 return video;
}
async function limitedBody(response:Response):Promise<string>{
 const reader=response.body?.getReader();if(!reader)throw Error('Empty provider response');
 const chunks:Buffer[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>128*1024*1024){await reader.cancel();throw Error('Provider response exceeded safe limit');}chunks.push(Buffer.from(value));}
 return Buffer.concat(chunks).toString('utf8');
}
async function providerStatus(status:string,http_status:number|null,error?:string){
 await query("INSERT INTO app_settings(key,value) VALUES('nvidia_video_status',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify({model:NVIDIA_VIDEO_MODEL,status,http_status,error,checked_at:new Date().toISOString()})]);
}
export async function nvidiaVideoStatus(){
 const [row]=await query<any>("SELECT value FROM app_settings WHERE key='nvidia_video_status'");
 return {configured:Boolean(process.env.NVIDIA_API_KEY),...(row?.value||{status:'access_unverified',http_status:null}),quality_acceptance:'not_verified'};
}
/** Durable checkpoints precede POST. Unknown POST outcomes are never blindly retried. */
export async function generateNativeSegment(id:string,index:number,prompt:string,inputImage:string,frames:number,original:string,onWait:(s:string)=>Promise<void>){
 const apiKey=process.env.NVIDIA_API_KEY;if(!apiKey)throw Error('NVIDIA_API_KEY is not configured on the server');
 await query("INSERT INTO nvidia_video_segments(generation_id,segment_index,status) VALUES($1,$2,'not_submitted') ON CONFLICT DO NOTHING",[id,index]);
 let [job]=await query<any>('SELECT * FROM nvidia_video_segments WHERE generation_id=$1 AND segment_index=$2',[id,index]);
 if(job.status==='completed'&&job.original_file&&fs.existsSync(job.original_file))return job.original_file;
 if(job.status==='failed')throw Error(job.error||'NVIDIA segment previously failed');
 if(job.status==='submitting'&&!job.request_id)throw Error('Previous NVIDIA submission outcome is unknown. It will not be resubmitted automatically; provider reconciliation is required.');
 const deadline=Date.now()+30*60*1000;
 let requestId:string|null=job.request_id;
 while(Date.now()<deadline){
  const polling=Boolean(requestId);
  if(!polling){
   if(job.status==='rate_limited'&&job.updated_at){const wait=retryAfterMs(job.error, new Date(job.updated_at).getTime())-(Date.now()-new Date(job.updated_at).getTime());if(wait>deadline-Date.now())throw Error('NVIDIA rate limit exceeds this job deadline; retry later');if(wait>0){await onWait('NVIDIA rate limited — honoring Retry-After');await sleep(wait);}}
   if(Number(job.attempts)>=3)throw Error('NVIDIA rate limit persisted after three admitted retry opportunities; retry later');
   await query("UPDATE nvidia_video_segments SET status='submitting',attempts=attempts+1,submitted_at=NOW(),updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2",[id,index]);
  }
  let response:Response;
  try{
   response=await fetch(polling?`https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${encodeURIComponent(requestId!)}`:NVIDIA_VIDEO_ENDPOINT,{method:polling?'GET':'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json',...(!polling?{'Content-Type':'application/json','NVCF-POLL-SECONDS':'5'}:{})},body:polling?undefined:JSON.stringify({model_mode:'image2video',prompt,input_reference:inputImage,resolution:'720_9_16',num_frames:providerFrameCount(frames),num_inference_steps:35,fps:24}),signal:AbortSignal.timeout(polling?60000:12*60*1000)});
  }catch{
   if(polling){await onWait('NVIDIA status temporarily unavailable; resuming existing request, not submitting again');await sleep(10000);continue;}
   await providerStatus('outcome_unknown',null,'Submission timed out or connection failed; no automatic resubmission');
   throw Error('NVIDIA submission outcome unknown after connection failure/timeout; no automatic resubmission. Check the provider before starting another job.');
  }
  const returnedId=response.headers.get('nvcf-reqid');
  if(returnedId&&/^[A-Za-z0-9_-]{1,200}$/.test(returnedId)){requestId=returnedId;await query('UPDATE nvidia_video_segments SET request_id=$3,updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2',[id,index,requestId]);}
  if(response.status===202){
   await response.body?.cancel();if(!requestId)throw Error('NVIDIA accepted generation without a resumable request ID; outcome unknown, not resubmitting');
   await query("UPDATE nvidia_video_segments SET status='submitted',updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2",[id,index]);
   await onWait('NVIDIA accepted generation — waiting for the existing hosted job');await sleep(5000);continue;
  }
  if(response.status===429&&!polling){
   const retry=response.headers.get('retry-after')||'60';await response.body?.cancel();
   await providerStatus('rate_limited',429,'NVIDIA rate limit; Retry-After honored');
   await query("UPDATE nvidia_video_segments SET status='rate_limited',request_id=NULL,error=$3,updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2",[id,index,retry]);
   [job]=await query<any>('SELECT * FROM nvidia_video_segments WHERE generation_id=$1 AND segment_index=$2',[id,index]);requestId=null;continue;
  }
  if(polling&&(response.status===429||response.status>=500)){const wait=retryAfterMs(response.headers.get('retry-after'));await response.body?.cancel();await onWait('NVIDIA status delayed; respecting Retry-After without a duplicate generation');await sleep(Math.min(wait,Math.max(1,deadline-Date.now())));continue;}
  const text=await limitedBody(response);
  if(!response.ok){
   const message=redactStartupError(`NVIDIA video HTTP ${response.status}: ${text.slice(0,700)}${response.status===404?' — hosted endpoint unavailable or this account lacks access. No Kaggle video fallback.':''}`);
   await providerStatus('access_or_provider_error',response.status,message);
   await query("UPDATE nvidia_video_segments SET status='failed',error=$3,updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2",[id,index,message]);throw Error(message);
  }
  let body:any;try{body=JSON.parse(text);}catch{throw Error('NVIDIA returned a non-JSON response; no playable output');}
  const bytes=decodeProviderVideo(body);fs.mkdirSync(path.dirname(original),{recursive:true});
  fs.writeFileSync(original+'.tmp',bytes,{flush:true});fs.renameSync(original+'.tmp',original);
  await query("UPDATE nvidia_video_segments SET status='completed',original_file=$3,error=NULL,updated_at=NOW() WHERE generation_id=$1 AND segment_index=$2",[id,index,original]);
  await providerStatus('generation_returned',response.status);return original;
 }
 throw Error(`NVIDIA generation is still unresolved${requestId?' (request '+requestId+')':''}; no duplicate POST was sent. Provider reconciliation is required.`);
}
