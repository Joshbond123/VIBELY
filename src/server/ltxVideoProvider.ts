import fs from 'node:fs';
import crypto from 'node:crypto';
import {query} from './db.js';
import {getReadyEndpoint,ModelEndpointRecord} from './comfyOrchestrator.js';
import {acknowledgeGpuOutput} from './gpuLifecycle.js';
export const LTX_SERVICE='ltx_2_3_distilled_gguf_q4';
export async function ltxVideoStatus(){
 const [row]=await query<any>('SELECT state,error,session_status FROM gpu_sessions WHERE service_id=$1',[LTX_SERVICE]);
 return {status:row?.state||'UNKNOWN',account:'temilolo',on_demand:true,configured:Boolean(process.env.KAGGLE_TEMILOLO_TOKEN&&process.env.GH_PAT),error:row?.error||null,visual_acceptance:'not_verified'};
}
export async function renderLtxSegment(id:string,index:number,prompt:string,image:string,frames:number,dest:string,progress:(label:string)=>Promise<void>){
 const jid=`${id}_s${index}`;
 const record=await query<any>('SELECT comfyui_workflow FROM video_generations WHERE id=$1',[id]);
 const known=record[0]?.comfyui_workflow?.ltx_segments?.[String(index)];
 if(known?.persisted&&fs.existsSync(dest))return;
 let ep:ModelEndpointRecord;
 if(known){
  // Never start replacement hardware just to poll an old, ambiguous job.
  const [session]=await query<any>('SELECT state FROM gpu_sessions WHERE service_id=$1',[LTX_SERVICE]);
  const [existing]=await query<ModelEndpointRecord>('SELECT * FROM model_endpoints WHERE service_id=$1',[LTX_SERVICE]);
  if(session?.state!=='ON'||!existing?.comfyui_ready||existing.endpoint_url!==known.endpoint)
   throw Error('Prior LTX segment was not persisted and its original runtime is unavailable; explicit saved-segment resume is required');
  ep=existing;
 }else ep=await getReadyEndpoint(LTX_SERVICE,id);
 const headers={Authorization:`Bearer ${ep.api_key}`,'Content-Type':'application/json'};
 // Write an intention before submitting. Unknown POST outcomes are never retried.
 if(!known){
  await query(`UPDATE video_generations SET comfyui_workflow=jsonb_set(comfyui_workflow,'{ltx_segments}',COALESCE(comfyui_workflow->'ltx_segments','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb),true) WHERE id=$1`,[id,String(index),JSON.stringify({job_id:jid,endpoint:ep.endpoint_url,submitted_at:new Date().toISOString()})]);
  const r=await fetch(ep.endpoint_url+'/v1/video/jobs',{method:'POST',headers,signal:AbortSignal.timeout(30000),body:JSON.stringify({job_id:jid,prompt,reference_base64:image.split(',').pop(),frames,width:736,height:1280,seed:42+index})});
  if(!r.ok)throw Error(`LTX job submission HTTP ${r.status}`);
 }else if(known.endpoint!==ep.endpoint_url)throw Error('LTX runtime changed before output persistence; refusing an automatic duplicate render');
 let done:any;const deadline=Date.now()+42*60000;
 try{
  while(Date.now()<deadline){
   const [local]=await query<any>('SELECT status FROM video_generations WHERE id=$1',[id]);
   if(!local||['failed','cancelled'].includes(local.status))throw Error('Video request cancelled or interrupted');
   const r=await fetch(`${ep.endpoint_url}/v1/video/jobs/${jid}`,{headers,signal:AbortSignal.timeout(20000)});
   if(!r.ok)throw Error(`LTX job status HTTP ${r.status}; no replacement render submitted`);
   const j:any=await r.json();
   if(j.status==='failed')throw Error(j.error||'LTX model execution failed');
   if(j.status==='completed'){done=j;break;}
   await progress(j.sampling_steps?`LTX shot ${index+1}: measured sampling step ${j.sampling_step}/${j.sampling_steps}`:`LTX shot ${index+1}: ${j.stage||j.status}`);
   await new Promise(r=>setTimeout(r,3000));
  }
  if(!done)throw Error('LTX segment deadline exceeded');
  const r=await fetch(`${ep.endpoint_url}/v1/video/jobs/${jid}/video`,{headers,signal:AbortSignal.timeout(180000)});
  if(!r.ok)throw Error(`LTX output download HTTP ${r.status}`);
  const bytes=Buffer.from(await r.arrayBuffer()),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==done.bytes||sha256!==done.sha256)throw Error('LTX output integrity mismatch');
  const tmp=dest+'.partial';fs.writeFileSync(tmp,bytes);const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,dest);
  // Decode before the receipt, not merely an HTTP-success assertion.
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  await promisify(execFile)('ffmpeg',['-v','error','-i',dest,'-f','null','-'],{timeout:120000});
  await query(`UPDATE video_generations SET comfyui_workflow=jsonb_set(comfyui_workflow,ARRAY['ltx_segments',$2::text,'persisted'],'true'::jsonb,true) WHERE id=$1`,[id,String(index)]);
  await acknowledgeGpuOutput(LTX_SERVICE,jid,{bytes:bytes.length,sha256,playable:true,file:dest});
 }catch(e){
  await fetch(`${ep.endpoint_url}/v1/video/jobs/${jid}/cancel`,{method:'POST',headers,signal:AbortSignal.timeout(10000)}).catch(()=>{});throw e;
 }
}
