/** Website document heartbeat only. No control-plane resume from inside the app:
 * resuming an already-live app can disrupt the process performing the request.
 * The separate Actions workflow resumes only when the website is unreachable.
 * No GPU, emulator APIs or credentials are used by this timer.
 */
const URL='https://aivideo.aivideo.prod.page';
export async function websiteHeartbeat(request:typeof fetch=fetch):Promise<void>{
 const page=await request(URL+'/?website_keep_awake=1',{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'VIBELY-Website-KeepAwake/1'}});
 if(!page.ok)throw Error('Website document heartbeat failed');
 await page.arrayBuffer();
}
export function startWebsiteKeepAwake(){
 let busy=false;
 const tick=async()=>{
  if(busy)return;busy=true;
  try{await websiteHeartbeat();console.log('[Website keep-awake] Website document heartbeat succeeded');}
  catch{console.warn('[Website keep-awake] Document heartbeat failed; external workflow remains the wake fallback');}
  finally{busy=false;}
 };
 setTimeout(()=>void tick(),10000).unref();
 setInterval(()=>void tick(),3*60*1000).unref();
}
