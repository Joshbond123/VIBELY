import {providerQuota} from './kaggleQuota.js';
import {query,pool} from './db.js';
import {GPU_PROFILES,WEEKLY_SECONDS} from './gpuFleetPolicy.js';
/** Only authenticated telemetry with an actual device can create usage evidence.
 * No extrapolation through outages; provider quota remains unknown without provider evidence.
 */
export async function recordGpuObservation(service:string,account:string,telemetry:any){
 const measured=Number(telemetry?.measured_at),start=Number(telemetry?.session_started_at);
 if(!GPU_PROFILES.some(p=>p.account===account)||!telemetry?.gpus?.length||!Number.isFinite(measured)||!Number.isFinite(start)||start<=0||start>measured||Math.abs(Date.now()/1000-measured)>60)return;
 const c=await pool!.connect();
 try {
  await c.query('BEGIN');
  await c.query(`INSERT INTO gpu_usage_observations(account,service_id,worker_started_at,first_seen,last_seen,gpu_names)
   VALUES($1,$2,$3,to_timestamp($4),to_timestamp($4),$5::jsonb) ON CONFLICT DO NOTHING`,[account,service,start,measured,JSON.stringify(telemetry.gpus.map((g:any)=>String(g.name)))]);
  const {rows:[before]}=await c.query(`SELECT EXTRACT(EPOCH FROM last_seen)::double precision AS last FROM gpu_usage_observations
   WHERE account=$1 AND service_id=$2 AND worker_started_at=$3 FOR UPDATE`,[account,service,start]);
  const gap=measured-Number(before.last);
  // Never invent usage during an unobserved outage or count concurrent polls twice.
  if(gap>0 && gap<=90)await c.query(`INSERT INTO gpu_usage_intervals(account,service_id,worker_started_at,start_at,end_at)
   VALUES($1,$2,$3,to_timestamp($4),to_timestamp($5)) ON CONFLICT DO NOTHING`,[account,service,start,before.last,measured]);
  await c.query(`UPDATE gpu_usage_observations SET last_seen=GREATEST(last_seen,to_timestamp($4)),gpu_names=$5::jsonb
   WHERE account=$1 AND service_id=$2 AND worker_started_at=$3`,[account,service,start,measured,JSON.stringify(telemetry.gpus.map((g:any)=>String(g.name)))]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}

}
export async function gpuFleetDashboard(workers:any[]){
 const rows=await query<any>(`SELECT account,
 SUM(GREATEST(0,EXTRACT(EPOCH FROM LEAST(end_at,NOW())-GREATEST(start_at,NOW()-interval '7 days'))))::double precision AS observed_seconds,
 MIN(start_at) AS tracking_started_at,MAX(end_at) AS last_seen
 FROM gpu_usage_intervals WHERE end_at>NOW()-interval '7 days' GROUP BY account`);
 const fleet=await Promise.all(GPU_PROFILES.map(async profile=>{
  const provider=await providerQuota(profile);
  const usage=rows.find(r=>r.account===profile.account);
  const worker=workers.find(w=>w.account===profile.account);
  const tracked=Number(usage?.observed_seconds || 0);
  return {...profile,token_env:undefined,kernel_ref:undefined,
   status:worker?.status || 'NOT_PROVISIONED',gpu_name:worker?.gpu_name || null,
   telemetry_is_live:worker?.telemetry_is_live || false,worker:worker || null,
   weekly:{total_seconds:WEEKLY_SECONDS,observed_seconds:tracked,used_seconds:provider.used_seconds,remaining_seconds:provider.remaining_seconds,provider_used_seconds:provider.used_seconds,
    provider_remaining_seconds:provider.remaining_seconds,reserved_seconds:provider.reserved_seconds,provider_total_seconds:provider.total_seconds,quota_verified:provider.quota_verified,provider_source:provider.source,verified_at:provider.verified_at,refresh_at:provider.refresh_at,basis:'Observed connected intervals only (maximum 90-second observation gap); excludes pre-tracking/provider usage. Not a provider quota balance.',
    window:'rolling 7 days; provider reset time unverified',tracking_started_at:usage?.tracking_started_at || null,last_seen:usage?.last_seen || null},
   provisioning:worker?'registered legacy worker':'No verified worker or model installation',
   credential_configured:Boolean(process.env[profile.token_env])};
 }));
 return {fleet,allocation:{total_seconds:WEEKLY_SECONDS,observed_seconds:fleet.reduce((n,p)=>n+p.weekly.observed_seconds,0),remaining_seconds:null,
  provider_quota_verified:fleet.every(p=>p.weekly.quota_verified),rotation_seconds:1800,rotation_enabled:false,rotation_mode:'disabled pending worker/model provisioning and live switching validation',
  reason:'Provider balances are verified per account, not pooled. Application-observed time is a separate incomplete ledger, not an exact fleet-wide provider balance.'}};
}
