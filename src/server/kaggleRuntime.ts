import {parseMcp} from './kaggleQuota.js';
import {GPU_PROFILES} from './gpuFleetPolicy.js';
export async function notebookStatus(profile:typeof GPU_PROFILES[number]):Promise<any>{
 const token=process.env[profile.token_env];if(!token)throw Error('Provider credential missing');
 const headers:Record<string,string>={Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
 const init=await fetch('https://www.kaggle.com/mcp',{method:'POST',headers,signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'vibely-runtime-status',version:'1'}}})});
 if(!init.ok)throw Error(`Provider initialization HTTP ${init.status}`);
 const session=init.headers.get('mcp-session-id');await init.text();if(session)headers['Mcp-Session-Id']=session;
 const [userName,kernelSlug]=profile.kernel_ref.split('/');
 const r=await fetch('https://www.kaggle.com/mcp',{method:'POST',headers,signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_notebook_session_status',arguments:{request:{userName,kernelSlug}}}})});
 if(!r.ok)throw Error(`Provider status HTTP ${r.status}`);
 const e=parseMcp(await r.text());if(e.error||e.result?.isError)throw Error('Provider status unavailable; not evidence of GPU OFF');
 const body=e.result?.content?.find((x:any)=>x.type==='text')?.text;return JSON.parse(body);
}
