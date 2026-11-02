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
export async function startLiveDevice(onPacket,onStatus=()=>{}){
 const jar=new URL('./scrcpy-server.jar',import.meta.url).pathname;
 if(!fs.existsSync(jar))throw new Error('Pinned scrcpy server artifact missing');
 await exec('adb',['push',jar,'/data/local/tmp/vibely-scrcpy.jar']);
 const size=(await exec('adb',['shell','wm','size'])).stdout.match(/\d+x\d+/g)?.at(-1)?.split('x').map(Number)||[1080,2400];
 let stopped=false,control,controlServer,video,videoServer,config=null,width=0,height=0,requested=0,current=-1,switching=null,videoGeneration=0,recoverTimer;
 const pointers=new Map();let textSequence=0n;
 let controlRecovering=false;
 // scrcpy cleanup unlinks its own abstract sockets; keep forwards clean on relaunch.
 async function launch(scid,port,args){
  await exec('adb',['forward','--remove','tcp:'+port]).catch(()=>{});
  const server=spawn('adb',['shell','CLASSPATH=/data/local/tmp/vibely-scrcpy.jar','app_process','/','com.genymobile.scrcpy.Server','2.4','tunnel_forward=true','audio=false','cleanup=true','raw_stream=true','scid='+scid,...args],{stdio:['ignore','pipe','pipe']});
  server.stderr.on('data',d=>console.error('[scrcpy '+scid+']',d.toString().trim()));
  for(let i=0;i<50;i++){
   try{const socket=await new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>resolve(s));s.once('error',reject);});return {server,socket};}catch{await delay(200);}
  }
  server.kill();throw new Error('Native scrcpy socket unavailable: '+scid);
 }
 async function startControl(){
  try{control?.destroy();}catch{}
  try{controlServer?.kill();}catch{}
  control=null;
  await exec('adb',['shell','pkill','-f','[s]cid=00000a11']).catch(()=>{});
  await exec('adb',['forward','--remove','tcp:27183']).catch(()=>{});
  await delay(300);
  const c=await launch('00000a11',27183,['video=false','control=true','clipboard_autosync=false']);
  control=c.socket;controlServer=c.server;
  control.on('data',()=>{});
  control.on('error',e=>console.error('[control]',e.message));
  control.once('close',()=>{
    pointers.clear();control=null;
    if(stopped||controlRecovering)return;
    controlRecovering=true;
    (async()=>{
      try{
        for(let attempt=0;!stopped&&attempt<40;attempt++){
          await delay(Math.min(4000,300*2**Math.min(attempt,5)));
          try{await startControl();console.log('[control recovery] restored after attempt',attempt);return;}
          catch(e){console.error('[control recovery]',e.message);}
        }
      } finally { controlRecovering=false; }
    })();
  });
 }
 async function startVideo(level){
  const generation=++videoGeneration,p=STREAM_PROFILES[level];
  try{video?.destroy();}catch{}
  try{videoServer?.kill();}catch{}
  config=null;
  await exec('adb',['shell','pkill','-f','[s]cid=00000a12']).catch(()=>{});
  await exec('adb',['forward','--remove','tcp:27184']).catch(()=>{});
  await delay(200);
  const c=await launch('00000a12',27184,['video=true','control=false','video_codec=h264','max_size='+p.maxSize,'max_fps='+p.fps,'video_bit_rate='+p.bitrate,'video_codec_options=i-frame-interval=1,repeat-previous-frame-after:long=1000000','send_codec_meta=true','send_frame_meta=true']);
  if(stopped||generation!==videoGeneration){c.socket.destroy();c.server.kill();return;}
  video=c.socket;videoServer=c.server;let pending=Buffer.alloc(0),header=false;
  const ready=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Encoder configuration timeout')),15000);
   video.on('data',chunk=>{
    pending=Buffer.concat([pending,chunk]);
    if(!header){if(pending.length<12)return;if(pending.readUInt32BE(0)!==0x68323634){video.destroy();return;}width=pending.readUInt32BE(4);height=pending.readUInt32BE(8);pending=pending.subarray(12);header=true;}
    while(pending.length>=12){
      const n=pending.readUInt32BE(8); if(pending.length<12+n)break;
      const frame=pending.subarray(0,12+n);pending=pending.subarray(12+n);
      const packet=Buffer.concat([Buffer.from([2]),frame]);
      if(frame.readBigUInt64BE(0)&(1n<<63n)){config=packet;current=level;clearTimeout(timer);resolve();onStatus({...p,width,height,encoder_generation:generation});}
      try{onPacket(packet);}catch{}
    }
   });
   video.once('error',e=>{clearTimeout(timer);reject(e);});
  });
  video.once('close',()=>{if(!stopped && generation===videoGeneration && current>=0){current=-1;clearTimeout(recoverTimer);recoverTimer=setTimeout(()=>setProfile(requested).catch(e=>console.error('[video recovery]',e.message)),1000);}});
  await ready;
 }
 async function setProfile(level){
  level=Math.max(0,Math.min(STREAM_PROFILES.length-1,Number(level)||0));
  requested=level;
  if(switching)return switching;
  switching=(async()=>{
    try{await startVideo(level);}finally{switching=null;}
  })();
  return switching;
 }
 function extent(p){return [width||size[0]||1080,height||size[1]||2400];}
 async function ensureHealthy(){
  if(stopped)return {ok:false,reason:'stopped'};
  let controlOk=Boolean(control&&!control.destroyed);
  if(!controlOk && !controlRecovering){
    try{await startControl();controlOk=Boolean(control&&!control.destroyed);}
    catch(e){return {ok:false,reason:'control:'+e.message,controlOk:false,videoOk:false};}
  }
  let videoOk=Boolean(video&&!video.destroyed&&config);
  if(!videoOk){
    try{await setProfile(Math.max(0,current>=0?current:requested||0));videoOk=Boolean(video&&!video.destroyed);}
    catch(e){return {ok:false,reason:'video:'+e.message,controlOk,videoOk:false};}
  }
  return {ok:controlOk&&videoOk,controlOk,videoOk};
 }
 function input(p){
  // When scrcpy control is down: kick recovery + adb fallback. Never throw (throws freeze the UI path).
  if(!control||control.destroyed){
   if(!controlRecovering){ensureHealthy().catch(e=>console.error('[ensureHealthy]',e.message));}
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
  }else if(p.kind==='keyevent'||p.kind==='key'){
   for(const action of [0,1]){const b=Buffer.alloc(14);b[0]=0;b[1]=action;b.writeUInt32BE(Number(p.keycode)||3,2);control.write(b);}
  }else if(p.kind==='text'){
   const text=Buffer.from(String(p.text||'').slice(0,4096));
   if(/^[\x00-\x7f]*$/.test(text.toString())){const b=Buffer.alloc(5+text.length);b[0]=1;b.writeUInt32BE(text.length,1);text.copy(b,5);control.write(b);return;}
   const b=Buffer.alloc(14+text.length);b[0]=9;b.writeBigUInt64BE(++textSequence,1);b[9]=1;b.writeUInt32BE(text.length,10);text.copy(b,14);control.write(b);
  }else throw new Error('Unsupported native input');
 }
 await startControl();await setProfile(0);
 return {
  input,setProfile,ensureHealthy,
  release(){for(const p of [...pointers.values()])input({...p,action:'up'});},
  get config(){return config;},
  get dimensions(){return {width,height};},
  get profile(){return {...STREAM_PROFILES[Math.max(0,current)],width,height,encoder_generation:videoGeneration};},
  close(){stopped=true;clearTimeout(recoverTimer);videoGeneration++;try{video?.destroy();}catch{}try{control?.destroy();}catch{}try{videoServer?.kill();}catch{}try{controlServer?.kill();}catch{}}
 };
}
