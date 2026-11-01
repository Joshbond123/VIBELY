import crypto from 'crypto';
import { pool, query } from './db.js';

export const GPU_SERVICES=['minimax_h3_ref2va','minimax_music_3'];
const booting=new Map<string,Promise<void>>();
export async function gpuEvent(service:string,event:string,detail:any={}) {
  await query('INSERT INTO gpu_events(service_id,event,detail) VALUES($1,$2,$3::jsonb)',[service,event,JSON.stringify(detail)]);
}

async function dispatchWorker(service:string) {
  if(!process.env.GH_PAT) throw new Error('GPU auto-start unavailable: GitHub Actions credential is not configured');
  const res=await fetch('https://api.github.com/repos/Joshbond123/VIBELY/actions/workflows/gpu-workers.yml/dispatches',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${process.env.GH_PAT}`,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'VIBELY-GPU-lifecycle'},body:JSON.stringify({ref:'main',inputs:{worker:service==='minimax_h3_ref2va'?'video':'music'}})});
  if(!res.ok) throw new Error(`GPU startup dispatch failed: GitHub HTTP ${res.status}`);
  await gpuEvent(service,'ACTIVATION_REQUESTED',{method:'GitHub Actions -> Kaggle SaveKernel',request_id:crypto.randomUUID()});
}

// Durable leases are created before startup. Browsing/health/captions never call this.
export async function acquireGpu(service:string,jobId:string) {
  const client=await pool!.connect();let start=false;
  try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[service]);
    await client.query('INSERT INTO gpu_sessions(service_id) VALUES($1) ON CONFLICT DO NOTHING',[service]);
    await client.query('INSERT INTO gpu_leases(service_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[service,jobId]);
    const {rows:[row]}=await client.query('SELECT * FROM gpu_sessions WHERE service_id=$1 FOR UPDATE',[service]);
    if(['OFF','ERROR'].includes(row.state)) {
      start=true;await client.query("UPDATE gpu_sessions SET state='STARTING',requested_at=NOW(),error=NULL,telemetry=NULL,telemetry_at=NULL WHERE service_id=$1",[service]);
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

export async function releaseGpuJob(jobId:string) {
  await query('DELETE FROM gpu_leases WHERE job_id=$1',[jobId]);
}

export async function acceptGpuHeartbeat(service:string,version:string,started:number,ready:boolean) {
  if(version!=='lifecycle-v3') return;
  const [before]=await query<any>('SELECT state FROM gpu_sessions WHERE service_id=$1',[service]);
  await query(`INSERT INTO gpu_sessions(service_id,state,started_at,worker_started_at)
    VALUES($1,$2,to_timestamp($3),$3) ON CONFLICT(service_id) DO UPDATE
    SET state=CASE WHEN gpu_sessions.state='STOPPING' THEN 'STOPPING' ELSE EXCLUDED.state END,
        started_at=EXCLUDED.started_at,worker_started_at=EXCLUDED.worker_started_at
    WHERE EXCLUDED.worker_started_at>=gpu_sessions.worker_started_at`,[service,ready?'ON':'INITIALIZING',started]);
  if(before?.state!==(ready?'ON':'INITIALIZING') && before?.state!=='STOPPING') await gpuEvent(service,ready?'GPU_READY':'INITIALIZING',{worker_started_at:started});
}

export async function acknowledgeGpuOutput(service:string,remoteId:string,receipt:any) {
  const [ep]=await query<any>('SELECT * FROM model_endpoints WHERE service_id=$1',[service]);
  if(!ep?.endpoint_url) throw new Error('Worker endpoint missing during durable output acknowledgement');
  const kind=service==='minimax_h3_ref2va'?'video':'music';
  const r=await fetch(`${ep.endpoint_url}/v1/${kind}/jobs/${encodeURIComponent(remoteId)}/acknowledge`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${ep.api_key}`,'Content-Type':'application/json'},body:JSON.stringify(receipt)});
  if(!r.ok) throw new Error(`Output acknowledgement failed: HTTP ${r.status}`);
  await gpuEvent(service,'OUTPUT_PERSISTED',receipt);
}

let ticking=false;
export async function gpuLifecycleTick() {
  if(ticking || !pool)return;ticking=true;
  try {
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
          const user=service==='minimax_h3_ref2va'?'joshbond123':'happink';
          const slug=service==='minimax_h3_ref2va'?'vibely-minimax-h3-ref2va-server':'vibely-minimax-music-3-q4-0-gguf-server';
          const token=process.env[service==='minimax_h3_ref2va'?'KAGGLE_JOSHBOND_TOKEN':'KAGGLE_HAPPINK_TOKEN'];
          const r=await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${user}&kernelSlug=${slug}`,{signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${token || ''}`}});
          if(r.ok){const k:any=await r.json();if(['error','failed'].includes(String(k.status).toLowerCase()) && Date.now()-new Date(state.requested_at || state.started_at).getTime()>120000) {
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
        if(state.state==='STOPPING') {
          const user=service==='minimax_h3_ref2va'?'joshbond123':'happink';
          const slug=service==='minimax_h3_ref2va'?'vibely-minimax-h3-ref2va-server':'vibely-minimax-music-3-q4-0-gguf-server';
          const token=process.env[service==='minimax_h3_ref2va'?'KAGGLE_JOSHBOND_TOKEN':'KAGGLE_HAPPINK_TOKEN'];
          const r=await fetch(`https://www.kaggle.com/api/v1/kernels/status?userName=${user}&kernelSlug=${slug}`,{signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token || ''}`}});
          if(r.ok) {
            const k:any=await r.json();const status=String(k.status || '').toLowerCase();
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
  const rows=await query<any>(`SELECT s.*,m.endpoint_url,m.api_key,m.gpu_name,m.extra_meta,(SELECT count(*)::int FROM gpu_leases l WHERE l.service_id=s.service_id) AS leased_jobs FROM gpu_sessions s LEFT JOIN model_endpoints m USING(service_id) ORDER BY s.service_id`);
  return await Promise.all(rows.map(async(row)=>{
    let live:any=null;let availability='Unknown';
    let legacyActive=false;
    if(row.state==='OFF' && row.endpoint_url && row.extra_meta?.worker_version!=='lifecycle-v3') {
      try{const r=await fetch(row.endpoint_url+'/health',{signal:AbortSignal.timeout(3000)});if(r.ok){const h:any=await r.json();legacyActive=Boolean(h.comfyui_ready);}}catch{}
    }
    if(['ON','INITIALIZING'].includes(row.state) && row.endpoint_url) {
      try {
        const r=await fetch(row.endpoint_url+'/v1/telemetry',{signal:AbortSignal.timeout(4000),headers:{Authorization:`Bearer ${row.api_key}`}});
        if(r.ok){live=await r.json();availability='Available';await query('UPDATE gpu_sessions SET telemetry=$2::jsonb,telemetry_at=NOW() WHERE service_id=$1',[row.service_id,JSON.stringify(live)]);}
        else availability='Unavailable';
      }catch{availability='Unavailable';}
    } else if(row.state==='OFF') availability='Not allocated; Kaggle availability checked at startup';
    return {service_id:row.service_id,status:legacyActive?'ON':row.state==='ON'?'ON':row.state==='INITIALIZING'?'STARTING':row.state,availability:legacyActive?'Available (legacy unmanaged)':availability,gpu_name:live?.gpus?.map((g:any)=>g.name).join(', ') || row.gpu_name || null,telemetry:live,active_jobs:live?.active_jobs ?? null,queued_or_leased_jobs:row.leased_jobs,current_task:live?.current_tasks || [],session_duration_sec:row.started_at && row.state!=='OFF'?Math.max(0,Math.floor((Date.now()-new Date(row.started_at).getTime())/1000)):null,last_shutdown:row.last_shutdown_at,error:legacyActive?'Legacy worker is still active and does not implement safe shutdown. One-time Kaggle session cleanup is required; this is not OFF.':row.error,telemetry_is_live:Boolean(live),session_status:row.session_status};
  }));
}
