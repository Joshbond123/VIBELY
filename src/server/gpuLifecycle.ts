import {notebookStatus} from './kaggleRuntime.js';
import {recordGpuObservation} from './gpuUsage.js';
import {GPU_PROFILES} from './gpuFleetPolicy.js';
import {providerQuota} from './kaggleQuota.js';
import crypto from 'crypto';
import { pool, query } from './db.js';

export const GPU_SERVICES=['minimax_music_3','ltx_2_3_distilled_gguf_q4'];
const booting=new Map<string,Promise<void>>();
export async function gpuEvent(service:string,event:string,detail:any={}) {
  await query('INSERT INTO gpu_events(service_id,event,detail) VALUES($1,$2,$3::jsonb)',[service,event,JSON.stringify(detail)]);
}

async function dispatchWorker(service:string) {
  const profile=GPU_PROFILES.find(p=>p.desired_engine===service)!;
  const quota=await providerQuota(profile);
  if(!quota.quota_verified)throw new Error('GPU activation blocked: provider quota could not be verified');
  if(quota.remaining_seconds<=0)throw new Error(`GPU activation blocked: ${profile.account} weekly provider quota exhausted; resets ${quota.refresh_at}. No cross-account quota fallback.`);
  if(!process.env.GH_PAT) throw new Error('GPU auto-start unavailable: GitHub Actions credential is not configured');
  const res=await fetch('https://api.github.com/repos/Joshbond123/VIBELY/actions/workflows/gpu-workers.yml/dispatches',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${process.env.GH_PAT}`,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'VIBELY-GPU-lifecycle'},body:JSON.stringify({ref:'main',inputs:{worker:service==='minimax_music_3'?'music':'video'}})});
  if(!res.ok) throw new Error(`GPU startup dispatch failed: GitHub HTTP ${res.status}`);
  await gpuEvent(service,'ACTIVATION_REQUESTED',{method:'GitHub Actions -> Kaggle SaveKernel',request_id:crypto.randomUUID()});
}

// Durable leases are created before startup. Browsing/health/captions never call this.
export async function acquireGpu(service:string,jobId:string) {
  if(!GPU_SERVICES.includes(service))throw new Error('Unsupported video/music GPU service');
  const client=await pool!.connect();let start=false;
  try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[service]);
    await client.query('INSERT INTO gpu_sessions(service_id) VALUES($1) ON CONFLICT DO NOTHING',[service]);
    await client.query('INSERT INTO gpu_leases(service_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[service,jobId]);
    const {rows:[row]}=await client.query('SELECT * FROM gpu_sessions WHERE service_id=$1 FOR UPDATE',[service]);
    if(row.state==='ON') {
      const {rows:[endpoint]}=await client.query('SELECT last_heartbeat_at FROM model_endpoints WHERE service_id=$1',[service]);
      const age=Date.now()-new Date(endpoint?.last_heartbeat_at||0).getTime();
      if(!Number.isFinite(age)||age>45000){
        // Generation must reconcile stale state itself, not depend on a prior
        // dashboard visit. A cached ON flag is not proof of live hardware.
        const profile=GPU_PROFILES.find(p=>p.desired_engine===service)!;
        const actual=await notebookStatus(profile);
        const terminal=String(actual.status||'').toLowerCase();
        if(['complete','completed','cancelacknowledged','canceled','cancelled','error','failed'].includes(terminal)){
          await client.query("UPDATE gpu_sessions SET state='OFF',session_status=$2,telemetry=NULL,telemetry_at=NULL WHERE service_id=$1",[service,terminal]);
          await client.query("UPDATE model_endpoints SET status='off',comfyui_ready=FALSE WHERE service_id=$1",[service]);
          row.state='OFF';
        }
      }
    }
    if(['OFF','ERROR'].includes(row.state)) {
      start=true;await client.query("UPDATE gpu_sessions SET state='STARTING',requested_at=NOW(),started_at=NULL,error=NULL,telemetry=NULL,telemetry_at=NULL WHERE service_id=$1",[service]);
    }
    await client.query('COMMIT');
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
  if(start) {
    const pending=dispatchWorker(service).catch(async(e)=>{
      await query("UPDATE gpu_sessions SET state='ERROR',error=$2 WHERE service_id=$1",[service,e.message]);
      await gpuEvent(service,'STARTUP_FAILED',{error:e.message});throw e;
    }).finally(()=>booting.delete(service));
    booting.set(service,pending);await pending;
  } else if(booting.has(service)) await booting.get(service);
}

export async function releaseGpuLease(service:string,jobId:string) {
  await query('DELETE FROM gpu_leases WHERE service_id=$1 AND job_id=$2',[service,jobId]);
  await gpuLifecycleTick();
}

export async function releaseGpuJob(jobId:string) {
  await query('DELETE FROM gpu_leases WHERE job_id=$1',[jobId]);
  await gpuLifecycleTick();
}

export async function acceptGpuHeartbeat(service:string,version:string,started:number,ready:boolean) {
  if(!GPU_SERVICES.includes(service)||version!=='lifecycle-v3') return;
  const [before]=await query<any>('SELECT state FROM gpu_sessions WHERE service_id=$1',[service]);
  await query(`INSERT INTO gpu_sessions(service_id,state,started_at,worker_started_at)
    VALUES($1,$2,to_timestamp($3),$3) ON CONFLICT(service_id) DO UPDATE
    SET state=CASE WHEN gpu_sessions.state='STOPPING' THEN 'STOPPING' ELSE EXCLUDED.state END,
        started_at=EXCLUDED.started_at,worker_started_at=EXCLUDED.worker_started_at,
        requested_at=GREATEST(gpu_sessions.requested_at,EXCLUDED.started_at),error=NULL,session_status=NULL
    WHERE EXCLUDED.worker_started_at>=gpu_sessions.worker_started_at`,[service,ready?'ON':'INITIALIZING',started]);
  if(before?.state!==(ready?'ON':'INITIALIZING') && before?.state!=='STOPPING') await gpuEvent(service,ready?'GPU_READY':'INITIALIZING',{worker_started_at:started});
}

async function deliverReceipt(row:any) {
  const kind=row.service_id==='minimax_music_3'?'music':'video';
  const r=await fetch(`${row.endpoint_url}/v1/${kind}/jobs/${encodeURIComponent(row.remote_job_id)}/acknowledge`,{method:'POST',signal:AbortSignal.timeout(12000),headers:{Authorization:`Bearer ${row.api_key}`,'Content-Type':'application/json'},body:JSON.stringify(row.receipt)});
  if(!r.ok) throw new Error(`Output acknowledgement HTTP ${r.status}`);
  await query('UPDATE gpu_output_receipts SET delivered_at=NOW(),last_error=NULL,attempts=attempts+1 WHERE service_id=$1 AND remote_job_id=$2',[row.service_id,row.remote_job_id]);
  await gpuEvent(row.service_id,'OUTPUT_PERSISTED',{...row.receipt,remote_job_id:row.remote_job_id});
}
export async function acknowledgeGpuOutput(service:string,remoteId:string,receipt:any) {
  const [ep]=await query<any>('SELECT * FROM model_endpoints WHERE service_id=$1',[service]);
  if(!ep?.endpoint_url) throw new Error('Worker endpoint missing during durable output acknowledgement');
  const [row]=await query<any>(`INSERT INTO gpu_output_receipts(service_id,remote_job_id,endpoint_url,api_key,receipt) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(service_id,remote_job_id) DO UPDATE SET receipt=EXCLUDED.receipt RETURNING *`,[service,remoteId,ep.endpoint_url,ep.api_key,JSON.stringify(receipt)]);
  try {await deliverReceipt(row);}catch(e:any) {
    await query('UPDATE gpu_output_receipts SET attempts=attempts+1,last_error=$3 WHERE service_id=$1 AND remote_job_id=$2',[service,remoteId,e.message]);
    await gpuEvent(service,'OUTPUT_ACK_RETRY_PENDING',{remote_job_id:remoteId,error:e.message});
    // Output was already fsynced, decoded and database-persisted. Retry the receipt durably;
    // the worker independently refuses to shut down until this acknowledgement arrives.
  }
}

let ticking=false;
export async function gpuLifecycleTick() {
  if(ticking || !pool)return;ticking=true;
  try {
    const receipts=await query<any>("SELECT * FROM gpu_output_receipts WHERE delivered_at IS NULL AND service_id IN ('minimax_music_3','ltx_2_3_distilled_gguf_q4') ORDER BY created_at LIMIT 10");
    for(const receipt of receipts) {
      try{await deliverReceipt(receipt);}catch(e:any){await query('UPDATE gpu_output_receipts SET attempts=attempts+1,last_error=$3 WHERE service_id=$1 AND remote_job_id=$2',[receipt.service_id,receipt.remote_job_id,e.message]);}
    }
    // Clean only leases whose app job is terminal/missing. Never expire healthy work by age.
    await query(`DELETE FROM gpu_leases l WHERE NOT EXISTS(SELECT 1 FROM video_generations v WHERE v.id=l.job_id AND v.status NOT IN ('completed','failed')) AND NOT EXISTS(SELECT 1 FROM music_tracks m WHERE m.id=l.job_id AND m.status='generating')`);
    for(const service of GPU_SERVICES) {
      const c=await pool.connect();
      try {
        await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[service]);
        const {rows:[state]}=await c.query('SELECT * FROM gpu_sessions WHERE service_id=$1 FOR UPDATE',[service]);
        if(!state){await c.query('COMMIT');continue;}
        const {rows:[leases]}=await c.query('SELECT COUNT(*)::int AS count FROM gpu_leases WHERE service_id=$1',[service]);
        if(['STARTING','INITIALIZING'].includes(state.state)) {
          const profile=GPU_PROFILES.find(p=>p.desired_engine===service)!;
          let k:any;try{k=await notebookStatus(profile);}catch{k={status:'unknown'};}
          {if(['error','failed'].includes(String(k.status).toLowerCase()) && Date.now()-new Date(state.requested_at || state.started_at).getTime()>120000) {
            await c.query("UPDATE gpu_sessions SET state='ERROR',error=$2 WHERE service_id=$1",[service,`Kaggle session failed: ${String(k.failureMessage || k.status).slice(0,500)}`]);
            await c.query("INSERT INTO gpu_events(service_id,event,detail) VALUES($1,'SESSION_FAILED',$2::jsonb)",[service,JSON.stringify({status:k.status})]);
          }}
        }
        if(['STARTING','INITIALIZING'].includes(state.state) && Date.now()-new Date(state.requested_at || state.started_at).getTime()>20*60000) {
          await c.query("UPDATE gpu_sessions SET state='ERROR',error='Kaggle startup deadline exceeded; quota, availability or worker initialization must be checked' WHERE service_id=$1",[service]);
        }
        if(state.state==='ON' && leases.count===0) {
          const {rows:[ep]}=await c.query('SELECT * FROM model_endpoints WHERE service_id=$1',[service]);
          if(ep?.endpoint_url) {
            // The worker independently rejects shutdown with running/queued jobs or unacknowledged outputs.
            const response=await fetch(ep.endpoint_url+'/v1/lifecycle/shutdown',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${ep.api_key}`,'Content-Type':'application/json'},body:JSON.stringify({reason:'all_gpu_leases_completed'})});
            if(response.ok) {
              await c.query("UPDATE gpu_sessions SET state='STOPPING',telemetry=NULL,telemetry_at=NULL WHERE service_id=$1",[service]);
              await c.query("INSERT INTO gpu_events(service_id,event) VALUES($1,'SHUTDOWN_REQUESTED')",[service]);
            } else if(response.status!==409) await c.query('UPDATE gpu_sessions SET error=$2 WHERE service_id=$1',[service,`Shutdown HTTP ${response.status}; not marked OFF`]);
          }
        }
        if(['STOPPING','ERROR'].includes(state.state)) {
          const profile=GPU_PROFILES.find(p=>p.desired_engine===service)!;
          let k:any;try{k=await notebookStatus(profile);}catch{k={status:'unknown'};}
          {const status=String(k.status || '').toLowerCase();
            if(['complete','completed','cancelacknowledged','canceled','cancelled','error','failed'].includes(status)) {
              await c.query("UPDATE gpu_sessions SET state='OFF',last_shutdown_at=NOW(),session_status=$2,telemetry=NULL,telemetry_at=NULL WHERE service_id=$1",[service,status]);
              await c.query("UPDATE model_endpoints SET status='off',comfyui_ready=FALSE WHERE service_id=$1",[service]);
              await c.query("INSERT INTO gpu_events(service_id,event,detail) VALUES($1,'SESSION_TERMINATED',$2::jsonb)",[service,JSON.stringify({kaggle_status:status})]);
            }
          }
        }
        await c.query('COMMIT');
      } catch(e:any) {await c.query('ROLLBACK');console.error('[GPU lifecycle]',service,e.message);} finally {c.release();}
    }
  } finally {ticking=false;}
}

export async function gpuDashboard() {
  const rows=await query<any>(`SELECT s.*,m.username,m.model_name,m.endpoint_url,m.api_key,m.gpu_name,m.extra_meta,(SELECT count(*)::int FROM gpu_leases l WHERE l.service_id=s.service_id) AS leased_jobs FROM gpu_sessions s LEFT JOIN model_endpoints m USING(service_id) WHERE s.service_id IN ('minimax_music_3','ltx_2_3_distilled_gguf_q4') ORDER BY s.service_id`);
  return await Promise.all(rows.map(async(row)=>{
    let live:any=null;let availability='Unknown';
    let legacyActive=false;
    if(row.state==='OFF' && row.endpoint_url && row.extra_meta?.worker_version!=='lifecycle-v3') {
      try{const r=await fetch(row.endpoint_url+'/health',{signal:AbortSignal.timeout(3000)});if(r.ok){const h:any=await r.json();legacyActive=Boolean(h.comfyui_ready);}}catch{}
    }
    if(['ON','INITIALIZING'].includes(row.state) && row.endpoint_url) {
      try {
        const r=await fetch(row.endpoint_url+'/v1/telemetry',{signal:AbortSignal.timeout(4000),headers:{Authorization:`Bearer ${row.api_key}`}});
        if(r.ok){live=await r.json();if(!Array.isArray(live?.gpus)||!live.gpus.length||!Number.isFinite(Number(live.measured_at))||Math.abs(Date.now()/1000-Number(live.measured_at))>60)throw Error('Invalid or stale device telemetry');availability='Available';await recordGpuObservation(row.service_id,String(row.username || '').toLowerCase(),live);await query('UPDATE gpu_sessions SET telemetry=$2::jsonb,telemetry_at=NOW() WHERE service_id=$1',[row.service_id,JSON.stringify(live)]);}
        else availability='Unavailable';
      }catch{live=null;availability='Unavailable';}
    } else if(row.state==='OFF') availability='Not allocated; Kaggle availability checked at startup';
    if(!live && ['ON','INITIALIZING','STOPPING','ERROR'].includes(row.state)) {
      const profile=GPU_PROFILES.find(p=>p.account===String(row.username || '').toLowerCase());
      if(profile?.kernel_ref && process.env[profile.token_env])try {
        let k:any;try{k=await notebookStatus(profile);}catch{k={status:'unknown'};}
        {if(['complete','completed','cancelacknowledged','canceled','cancelled','error','failed'].includes(String(k.status).toLowerCase())){
          const changed=await query<any>(`UPDATE gpu_sessions SET state='OFF',session_status=$2,telemetry=NULL,telemetry_at=NULL WHERE service_id=$1 AND worker_started_at=$3 RETURNING service_id`,[row.service_id,String(k.status),row.worker_started_at]);
          row.state=changed.length?'OFF':'UNKNOWN';availability=changed.length?'Provider confirms session terminated':'Session changed during observation; refresh required';
        }}
      }catch{}
    }
    return {service_id:row.service_id,account:row.username?.toLowerCase() || null,model_name:row.model_name || null,status:legacyActive?'ON':row.state==='ON'?(live?'ON':'UNKNOWN'):row.state==='INITIALIZING'?'STARTING':row.state,availability:legacyActive?'Available (legacy unmanaged)':availability,gpu_name:live?.gpus?.map((g:any)=>g.name).join(', ') || null,telemetry:live,active_jobs:live?.active_jobs ?? null,queued_or_leased_jobs:row.leased_jobs,current_task:live?.current_tasks || [],session_duration_sec:row.started_at && row.state!=='OFF'?Math.max(0,Math.floor((Date.now()-new Date(row.started_at).getTime())/1000)):null,last_shutdown:row.last_shutdown_at,error:legacyActive?'Legacy worker is still active and does not implement safe shutdown. One-time Kaggle session cleanup is required; this is not OFF.':row.error,telemetry_is_live:Boolean(live),session_status:row.session_status};
  }));
}
