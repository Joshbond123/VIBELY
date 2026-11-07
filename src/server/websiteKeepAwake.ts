/** Website-only, low-cost heartbeat; Actions remains the external wake fallback.
 * No GPU APIs, emulator settings or generation functions are accessed here.
 * This cannot override hosting-plan restrictions or guarantee uninterrupted uptime.
 */
const APP='66184937-3da8-4df4-88af-eb475f889a43';
const URL='https://aivideo.aivideo.prod.page';
function parseRpc(text:string):any {
 try{return JSON.parse(text);}catch{return JSON.parse(text.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n'));}
}
export async function websiteHeartbeat(key:string,request:typeof fetch=fetch):Promise<void>{
 const headers:Record<string,string>={Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
 const rpc=async(method:string,params:any,id:number)=>{
  const r=await request('https://mcp.blitz.cloud/mcp',{method:'POST',headers,signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  if(!r.ok)throw Error('Website control-plane heartbeat rejected');
  const session=r.headers.get('mcp-session-id');if(session)headers['Mcp-Session-Id']=session;
  const body=parseRpc(await r.text());if(body.error||body.result?.isError)throw Error('Website control-plane resume rejected');
 };
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'vibely-website-heartbeat',version:'1'}},1);
 await rpc('tools/call',{name:'apps_resume',arguments:{app:APP}},2);
 // Request the actual website document as well as health; never start a generation.
 const page=await request(URL+'/?website_keep_awake=1',{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'VIBELY-Website-KeepAwake/1'}});
 if(!page.ok)throw Error('Website document heartbeat failed');await page.arrayBuffer();
}
export function startWebsiteKeepAwake(){
 const key=process.env.BLITZ_WEBSITE_API_KEY;
 if(!key){console.warn('[Website keep-awake] Internal heartbeat not configured; external workflow only');return;}
 let busy=false;
 const tick=async()=>{
  if(busy)return;busy=true;
  try{await websiteHeartbeat(key);console.log('[Website keep-awake] Website-only resume and document heartbeat succeeded');}
  catch{console.warn('[Website keep-awake] Heartbeat failed; external workflow remains the wake fallback');}
  finally{busy=false;}
 };
 setTimeout(()=>void tick(),10000).unref();
 setInterval(()=>void tick(),3*60*1000).unref();
}
