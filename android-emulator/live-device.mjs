import net from 'node:net';
import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
export const STREAM_PROFILES=[
 {id:0,name:'Clear',maxSize:1280,fps:30,bitrate:3000000},
 {id:1,name:'Balanced',maxSize:960,fps:20,bitrate:900000},
 {id:2,name:'Low bandwidth',maxSize:640,fps:12,bitrate:280000},
 {id:3,name:'Very low bandwidth',maxSize:480,fps:8,bitrate:110000}
];
// Separate native control and encoder processes. Encoder adaptation/recovery must
// never restart Android, its apps, or the control channel.
/**
 * Kill scrcpy servers inside the guest without relying on `pkill`.
 *
 * Android's toybox does not reliably provide `pkill`; the old cleanup
 * (`adb shell pkill -f '[s]cid=00000a11'`) silently did nothing. The orphaned
 * app_process kept the abstract socket name @scrcpy_00000a11, so every later
 * attempt to bind the SAME hard-coded scid failed with
 * "Android abstract socket did not become ready" - the phone stayed booted but
 * with a frozen picture and no touch control after a self-heal.
 */
async function killGuestScrcpyServers(onlyScid = '') {
 const filter = onlyScid ? " | grep 'scid=" + onlyScid + "'" : '';
 const cmd = "ps -A -o PID,ARGS | grep genymobile.scrcpy | grep -v grep" + filter +
  " | awk '{print $1}' | while read p; do kill -9 $p 2>/dev/null; done; echo swept";
 const out = await exec('adb', ['shell', cmd]).catch(() => ({ stdout: '' }));
 return String(out.stdout || '').includes('swept');
}

/** Kill every scrcpy server that is NOT one of ours (stale orphans swallow input). */
async function killForeignScrcpyServers(keepScids = []) {
 if (!keepScids.length) return false;
 const keep = keepScids.map((s) => "scid=" + s).join(' -e ');
 const cmd = "ps -A -o PID,ARGS | grep genymobile.scrcpy | grep -v grep | grep -v -e " + keep +
  " | awk '{print $1}' | while read p; do kill -9 $p 2>/dev/null; done; echo swept";
 const out = await exec('adb', ['shell', cmd]).catch(() => ({ stdout: '' }));
 return String(out.stdout || '').includes('swept');
}

let attachGeneration = 0;
/** A fresh 8-hex-digit scid base per attach, so a stale orphan can never block us. */
function nextScidBase() {
 attachGeneration += 1;
 const stamp = Math.floor(Date.now() / 1000) & 0xfffff;
 return ((stamp << 4) | (attachGeneration & 0xf)).toString(16).padStart(8, '0');
}

export async function startLiveDevice(onPacket,onStatus=()=>{}){
 const jar=new URL('./scrcpy-server.jar',import.meta.url).pathname;
 if(!fs.existsSync(jar))throw new Error('Pinned scrcpy server artifact missing');
 const killed=await killGuestScrcpyServers();
 if(killed)console.log('[scrcpy] cleared '+killed+' stale server process(es) before attach');
 const scidBase=nextScidBase();
 const scidControl=scidBase.slice(0,6)+'11';
 const scidVideo=scidBase.slice(0,6)+'12';
 await exec('adb',['push',jar,'/data/local/tmp/vibely-scrcpy.jar']);
 const size=(await exec('adb',['shell','wm','size'])).stdout.match(/\d+x\d+/g)?.at(-1)?.split('x').map(Number)||[1080,2400];
 let stopped=false,control,controlServer,video,videoServer,config=null,width=0,height=0,requested=0,current=-1,switching=null,videoGeneration=0,recoverTimer;
 const pointers=new Map();let textSequence=0n;
 // scrcpy cleanup unlinks its own JAR. Both channels and recovery share this
 // pinned artifact, so ownership/cleanup belongs to the agent, not either server.
 async function launch(scid,port,options){
  await exec('adb',['forward','tcp:'+port,'localabstract:scrcpy_'+scid]);
  const server=spawn('adb',['shell','CLASSPATH=/data/local/tmp/vibely-scrcpy.jar','app_process','/','com.genymobile.scrcpy.Server','3.3.4','scid='+scid,'tunnel_forward=true','audio=false','send_dummy_byte=false','send_device_meta=false','cleanup=false','power_on=false',...options],{stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',d=>console.log('[scrcpy '+scid+']',String(d).trim()));server.stderr.on('data',d=>console.error('[scrcpy '+scid+']',String(d).trim()));
  // An adb forward accepts TCP even BEFORE its Android socket exists. A TCP
  // connect alone is not readiness and can prematurely close the encoder.
  let bound=false;
  for(let i=0;i<150;i++){
   const unix=await exec('adb',['shell','cat','/proc/net/unix']).catch(()=>({stdout:''}));
   if(unix.stdout.includes('scrcpy_'+scid)){bound=true;break;}
   if(server.exitCode!==null)break;
   await delay(200);
  }
  if(!bound){
   const diagnostic=await exec('adb',['shell','logcat','-d','-t','160','-s','AndroidRuntime:E','libc:F','DEBUG:F']).catch(()=>({stdout:''}));
   console.error('[native startup diagnostic]',diagnostic.stdout);
   // Kill the guest-side server too: leaving it alive would keep the abstract
   // socket name occupied and poison every later attempt.
   try{await exec('adb',['shell','kill','-9',String(server.pid||'')]).catch(()=>{});}catch(_){}
   await killGuestScrcpyServers(scid);
   server.kill();throw new Error('Android abstract socket did not become ready: '+scid+'; exit='+server.exitCode);
  }
  for(let i=0;i<40;i++){
   try{const socket=await new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>resolve(s));s.once('error',reject);});return {server,socket};}catch{await delay(200);}
  }
  server.kill();throw new Error('Native scrcpy socket unavailable: '+scid);
 }
 async function startControl(){
  // Hard-reset any prior control server so recovery cannot wedge on a half-open abstract socket.
  try{control?.destroy();}catch{}
  try{controlServer?.kill();}catch{}
  // Stale servers were already cleared when this device object was created; a
 // per-channel kill here would also take down the other channel.
  await exec('adb',['forward','--remove','tcp:27183']).catch(()=>{});
  await delay(250);
  const c=await launch(scidControl,27183,['video=false','control=true','clipboard_autosync=false']);control=c.socket;controlServer=c.server;
  // Drain clipboard acknowledgement messages even though browser input is one-way.
  control.on('data',()=>{});control.on('error',e=>console.error('[control]',e.message));
  control.once('close',()=>{pointers.clear();control=null;if(stopped||controlRecovering)return;controlRecovering=true;(async()=>{try{for(let attempt=0;!stopped&&attempt<40;attempt++){await delay(Math.min(4000,300*2**Math.min(attempt,5)));try{await startControl();console.log('[control recovery] restored after attempt',attempt);return;}catch(e){console.error('[control recovery]',e.message);}}}finally{controlRecovering=false;}})();});
 }
 async function startVideo(level){
  const generation=++videoGeneration,p=STREAM_PROFILES[level];
  video?.destroy();videoServer?.kill();config=null;
 
  const c=await launch(scidVideo,27184,['video=true','control=false','video_codec=h264','max_size='+p.maxSize,'max_fps='+p.fps,'video_bit_rate='+p.bitrate,'video_codec_options=i-frame-interval=1,repeat-previous-frame-after:long=1000000','send_codec_meta=true','send_frame_meta=true']);
  if(stopped||generation!==videoGeneration){c.socket.destroy();c.server.kill();return;}
  video=c.socket;videoServer=c.server;let pending=Buffer.alloc(0),header=false;
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Encoder configuration timeout')),15000);
   video.on('data',chunk=>{
    pending=Buffer.concat([pending,chunk]);
    if(!header){if(pending.length<12)return;if(pending.readUInt32BE(0)!==0x68323634){video.destroy();return;}width=pending.readUInt32BE(4);height=pending.readUInt32BE(8);pending=pending.subarray(12);header=true;}
    while(pending.length>=12){const n=pending.readUInt32BE(8);if(n>16*1024*1024){video.destroy();return;}if(pending.length<12+n)break;const frame=pending.subarray(0,12+n);pending=pending.subarray(12+n);const packet=Buffer.concat([Buffer.from([2]),frame]);
     if(frame.readBigUInt64BE(0)&(1n<<63n)){config=packet;current=level;clearTimeout(timer);resolve();onStatus({...p,width,height,encoder_generation:generation});}
     onPacket(packet);
    }
   });
  });
  video.on('error',e=>console.error('[video]',e.message));
  video.once('close',()=>{if(!stopped && generation===videoGeneration && current>=0){current=-1;clearTimeout(recoverTimer);recoverTimer=setTimeout(()=>setProfile(requested).catch(e=>console.error('[video recovery]',e.message)),1000);}});
  await ready;
 }
 function setProfile(level){
  requested=Math.max(0,Math.min(STREAM_PROFILES.length-1,Math.round(Number(level)||0)));
  if(switching)return switching;
  switching=(async()=>{while(!stopped && current!==requested)await startVideo(requested);})().finally(()=>{switching=null;});return switching;
 }
 function extent(p){const landscape=p.landscape===undefined?width>height:Boolean(p.landscape);const naturalLandscape=size[0]>size[1];return landscape===naturalLandscape?size:[size[1],size[0]];}
 let controlRecovering=false;
 async function ensureHealthy(){
  if(stopped) return {ok:false,reason:'stopped'};
  let controlOk=Boolean(control&&!control.destroyed);
  if(!controlOk && !controlRecovering){
    try{ await startControl(); controlOk=Boolean(control&&!control.destroyed); }
    catch(e){ return {ok:false,reason:'control:'+e.message,controlOk:false,videoOk:false}; }
  }
  let videoOk=Boolean(video&&!video.destroyed&&config);
  if(!videoOk){
    try{ await setProfile(Math.max(0, current>=0?current:requested||0)); videoOk=Boolean(video&&!video.destroyed); }
    catch(e){ return {ok:false,reason:'video:'+e.message,controlOk,videoOk:false}; }
  }
  return {ok:controlOk&&videoOk, controlOk, videoOk};
 }
 function input(p){
  // When scrcpy control is down: recover + adb fallback. Never throw (throws freeze the browser UI path).
  if(!control||control.destroyed){
   if(!controlRecovering){ ensureHealthy().catch(e=>console.error('[ensureHealthy]',e.message)); }
   if(p.kind==='keyevent'||p.kind==='key'){
    const code=String(Number(p.keycode)||3);
    exec('adb',['shell','input','keyevent',code]).catch(e=>console.error('[adb key fallback]',e.message));
    return;
   }
   if(p.kind==='pointer'){
    const [w,h]=extent(p);
    const x=Math.round(Math.max(0,Math.min(1,Number(p.x)||0))*(w-1));
    const y=Math.round(Math.max(0,Math.min(1,Number(p.y)||0))*(h-1));
    if(p.action==='down'||p.action==='up'){
      exec('adb',['shell','input','tap',String(x),String(y)]).catch(e=>console.error('[adb tap fallback]',e.message));
    }
    return;
   }
   return;
  }
  const [w,h]=extent(p);
  if(p.kind==='pointer'){
   if(p.action==='up'||p.action==='cancel')pointers.delete(p.pointerId);else pointers.set(p.pointerId,p);
   const b=Buffer.alloc(32);b[0]=2;b[1]={down:0,up:1,move:2,cancel:1}[p.action]??1;b.writeBigUInt64BE(BigInt(Math.max(0,Math.min(9,Number(p.pointerId)||0))),2);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,Number(p.x)||0))*(w-1)),10);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,Number(p.y)||0))*(h-1)),14);b.writeUInt16BE(w,18);b.writeUInt16BE(h,20);b.writeUInt16BE(b[1]===1?0:0xffff,22);control.write(b);
  }else if(p.kind==='scroll'){
   const b=Buffer.alloc(21);b[0]=3;b.writeInt32BE(Math.round(Math.max(0,Math.min(1,p.x))*(w-1)),1);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,p.y))*(h-1)),5);b.writeUInt16BE(w,9);b.writeUInt16BE(h,11);b.writeInt16BE(Math.round(Math.max(-1,Math.min(1,p.h||0))*32767),13);b.writeInt16BE(Math.round(Math.max(-1,Math.min(1,p.v||0))*32767),15);control.write(b);
  }else if(p.kind==='keyevent'){
   for(const action of [0,1]){const b=Buffer.alloc(14);b[0]=0;b[1]=action;b.writeUInt32BE(Number(p.keycode)||3,2);control.write(b);}
  }else if(p.kind==='text'){
   const text=Buffer.from(String(p.text||'').slice(0,4096));
   if(/^[\x00-\x7f]*$/.test(text.toString())){const b=Buffer.alloc(5+text.length);b[0]=1;b.writeUInt32BE(text.length,1);text.copy(b,5);control.write(b);return;}
   const b=Buffer.alloc(14+text.length);b[0]=9;b.writeBigUInt64BE(++textSequence,1);b[9]=1;b.writeUInt32BE(text.length,10);text.copy(b,14);control.write(b);
  }else throw new Error('Unsupported native input');
 }
 await startControl();await setProfile(0);
 return {scids:[scidControl,scidVideo],stop(){stopped=true;},input,setProfile,ensureHealthy,release(){for(const p of [...pointers.values()])input({...p,action:'up'});},get config(){return config;},get dimensions(){return {width,height};},get profile(){return {...STREAM_PROFILES[Math.max(0,current)],width,height,encoder_generation:videoGeneration};},close(){stopped=true;clearTimeout(recoverTimer);videoGeneration++;try{video?.destroy();}catch{}try{control?.destroy();}catch{}try{videoServer?.kill();}catch{}try{controlServer?.kill();}catch{}}};
}
