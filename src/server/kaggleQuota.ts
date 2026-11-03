import {GPU_PROFILES} from './gpuFleetPolicy.js';
export function parseMcp(text:string):any{
 try{return JSON.parse(text);}catch{
  const data=text.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
  return JSON.parse(data);
 }
}
export function seconds(value:unknown):number{
 if(typeof value!=='string'||!/^\d+(?:\.\d+)?s$/.test(value))throw Error('Invalid provider duration');
 const n=Number(value.slice(0,-1));if(!Number.isFinite(n))throw Error('Invalid duration');return n;
}
export function normalizeQuota(raw:any){
 const q=raw.gpu_quota,total=seconds(q.total_time_allowed),used=seconds(q.time_used),reserved=seconds(q.time_reserved);
 if(!Number.isFinite(Date.parse(raw.quota_refresh_time)) || total<=0)throw Error('Incomplete provider quota');
 return {total_seconds:total,used_seconds:used,reserved_seconds:reserved,remaining_seconds:Math.max(0,total-used-reserved),
  refresh_at:raw.quota_refresh_time,verified_at:new Date().toISOString(),source:'Kaggle official MCP get_accelerator_quota',quota_verified:true};
}
const cache=new Map<string,{at:number,value:any}>(),pending=new Map<string,Promise<any>>();
export async function providerQuota(profile:typeof GPU_PROFILES[number]):Promise<any>{
 const old=cache.get(profile.id);if(old&&Date.now()-old.at<60000)return old.value;
 if(pending.has(profile.id))return pending.get(profile.id);
 const job=(async()=>{
  try{
   const token=process.env[profile.token_env];if(!token)throw Error('Provider credential not configured');
   const headers:Record<string,string>={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
   // No cookie jar: anonymous Kaggle cookies can override bearer authentication.
   const init=await fetch('https://www.kaggle.com/mcp',{method:'POST',headers,signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'vibely-quota-monitor',version:'1'}}})});
   if(!init.ok)throw Error(`Provider initialization HTTP ${init.status}`);
   const session=init.headers.get('mcp-session-id');await init.text();if(session)headers['Mcp-Session-Id']=session;
   const response=await fetch('https://www.kaggle.com/mcp',{method:'POST',headers,signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_accelerator_quota',arguments:{request:{}}}})});
   if(!response.ok)throw Error(`Provider quota HTTP ${response.status}`);
   const envelope=parseMcp(await response.text());if(envelope.error||envelope.result?.isError)throw Error('Provider rejected quota query');
   const text=envelope.result?.content?.find((c:any)=>c.type==='text')?.text;const value=normalizeQuota(JSON.parse(text));cache.set(profile.id,{at:Date.now(),value});return value;
  }catch{return {quota_verified:false,remaining_seconds:null,used_seconds:null,total_seconds:null,source:'Provider quota unavailable',verified_at:null};}
 })().finally(()=>pending.delete(profile.id));pending.set(profile.id,job);return job;
}
