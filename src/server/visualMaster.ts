import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {assertActualVideoDuration} from './videoDuration.js';
const exec=promisify(execFile);
export async function persistVisualMaster(source:string,videosDir:string,generationId:string,minimum:number){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(generationId))throw Error('Unsafe generation identifier');
 await exec('ffmpeg',['-v','error','-i',source,'-f','null','-'],{timeout:120000,maxBuffer:1024*1024});
 const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',source],{timeout:30000});
 const duration=assertActualVideoDuration(Number(stdout.trim()),minimum);
 const bytes=fs.statSync(source).size;if(!bytes)throw Error('Empty visual master');
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
 fs.mkdirSync(videosDir,{recursive:true});
 const file=`${generationId}_visual.mp4`,dest=path.join(videosDir,file),tmp=dest+'.'+crypto.randomUUID()+'.tmp';
 try{
  fs.copyFileSync(source,tmp,fs.constants.COPYFILE_EXCL);
  const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.linkSync(tmp,dest);}catch(e:any){
   if(e.code!=='EEXIST')throw e;
   if(fs.statSync(dest).size!==bytes || crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')!==sha256)throw Error('Refusing to overwrite a different immutable visual master');
  }
  const dir=fs.openSync(videosDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
 }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
 return {generation_id:generationId,artifact_role:'visual_master',file,bytes,sha256,playable:true,duration_sec:duration,quality_acceptance:'not_implied'};
}
