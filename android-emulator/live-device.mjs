import net from 'node:net';
import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
// scrcpy 3.3.4 wire protocol. One persistent MediaCodec stream and input socket;
// no screen captures, adb processes, or reconnects per user interaction.
export async function startLiveDevice(onPacket){
 const jar=new URL('./scrcpy-server.jar',import.meta.url).pathname;
 if(!fs.existsSync(jar))throw new Error('Pinned scrcpy server artifact missing');
 await exec('adb',['push',jar,'/data/local/tmp/vibely-scrcpy.jar']);
 await exec('adb',['forward','tcp:27183','localabstract:scrcpy']);
 const server=spawn('adb',['shell','CLASSPATH=/data/local/tmp/vibely-scrcpy.jar','app_process','/','com.genymobile.scrcpy.Server','3.3.4','tunnel_forward=true','audio=false','control=true','video_codec=h264','max_size=1280','max_fps=30','video_bit_rate=3000000','video_codec_options=i-frame-interval=1','send_dummy_byte=false','send_device_meta=false','send_codec_meta=true','send_frame_meta=true','cleanup=true'],{stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',d=>console.log('[Android stream]',String(d).trim()));server.stderr.on('data',d=>console.error('[Android stream]',String(d).trim()));
 async function connect(){for(let i=0;i<30;i++){try{return await new Promise((resolve,reject)=>{const s=net.connect(27183,'127.0.0.1');s.once('connect',()=>resolve(s));s.once('error',reject);});}catch{await delay(300);}}throw new Error('Android streaming socket unavailable');}
 await delay(1000);
 let readyResolve;const ready=new Promise(r=>{readyResolve=r;});
 const video=await connect();const control=await connect();let pending=Buffer.alloc(0),header=false,width=0,height=0,config=null;
 video.on('data',chunk=>{
  pending=Buffer.concat([pending,chunk]);
  if(!header){if(pending.length<12)return;const codec=pending.readUInt32BE(0);if(codec!==0x68323634){console.error('Unexpected Android video codec',codec);video.destroy();return;}width=pending.readUInt32BE(4);height=pending.readUInt32BE(8);pending=pending.subarray(12);header=true;console.log('[Android stream] H264',width,height);}
  while(pending.length>=12){const n=pending.readUInt32BE(8);if(n>16*1024*1024){video.destroy();return;}if(pending.length<12+n)break;const frame=pending.subarray(0,12+n);pending=pending.subarray(12+n);const packet=Buffer.concat([Buffer.from([2]),frame]);if(frame.readBigUInt64BE(0)&(1n<<63n)){config=packet;readyResolve();}onPacket(packet);}
 });
 video.on('error',e=>console.error('[Android video]',e.message));control.on('error',e=>console.error('[Android control]',e.message));
 const pointers=new Map();
 let textSequence=0n;
 function input(p){
  if(control.destroyed)throw new Error('Android control connection is not available');
  if(p.kind==='pointer'){
   if(p.action==='up'||p.action==='cancel')pointers.delete(p.pointerId);else pointers.set(p.pointerId,p);
   const b=Buffer.alloc(32);b[0]=2;b[1]={down:0,up:1,move:2,cancel:1}[p.action]??1;b.writeBigUInt64BE(BigInt(Math.max(0,Math.min(9,Number(p.pointerId)||0))),2);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,Number(p.x)||0))*(width-1)),10);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,Number(p.y)||0))*(height-1)),14);b.writeUInt16BE(width,18);b.writeUInt16BE(height,20);b.writeUInt16BE(b[1]===1?0:0xffff,22);b.writeUInt32BE(0,24);b.writeUInt32BE(0,28);control.write(b);
  }else if(p.kind==='scroll'){
   const b=Buffer.alloc(21);b[0]=3;b.writeInt32BE(Math.round(Math.max(0,Math.min(1,p.x))*(width-1)),1);b.writeInt32BE(Math.round(Math.max(0,Math.min(1,p.y))*(height-1)),5);b.writeUInt16BE(width,9);b.writeUInt16BE(height,11);b.writeInt16BE(Math.round(Math.max(-1,Math.min(1,p.h||0))*32767),13);b.writeInt16BE(Math.round(Math.max(-1,Math.min(1,p.v||0))*32767),15);control.write(b);
  }else if(p.kind==='keyevent'){
   for(const action of [0,1]){const b=Buffer.alloc(14);b[0]=0;b[1]=action;b.writeUInt32BE(Number(p.keycode)||3,2);control.write(b);}
  }else if(p.kind==='text'){
   const text=Buffer.from(String(p.text||'').slice(0,4096));
   if(/^[\x00-\x7f]*$/.test(text.toString())){const b=Buffer.alloc(5+text.length);b[0]=1;b.writeUInt32BE(text.length,1);text.copy(b,5);control.write(b);return;}
   const b=Buffer.alloc(14+text.length);b[0]=9;b.writeBigUInt64BE(++textSequence,1);b[9]=1;b.writeUInt32BE(text.length,10);text.copy(b,14);control.write(b);
  }else throw new Error('Unsupported live input');
 }
 await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Android H264 encoder produced no configuration')),20000))]);
 return {input,release(){for(const p of [...pointers.values()])input({...p,action:'up'});},get config(){return config;},get dimensions(){return {width,height};},close(){video.destroy();control.destroy();server.kill();}};
}
