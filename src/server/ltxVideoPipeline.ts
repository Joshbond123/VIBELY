import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {query} from './db.js';
import {notebookStatus} from './kaggleRuntime.js';
import {GPU_PROFILES} from './gpuFleetPolicy.js';
import {generateFullVideoProductionPlan,FullProductionPlan} from './reasoningEngine.js';
import {executeMusicGenerationOnComfyUI} from './comfyOrchestrator.js';
import {releaseGpuJob,releaseGpuLease} from './gpuLifecycle.js';
import {generateSocialMetadata} from './socialMetadata.js';
import {renderLtxSegment,LTX_SERVICE} from './ltxVideoProvider.js';
import {LTX_VIDEO_SPEC,redactStartupError} from './videoEnginePolicy.js';
import {persistVisualMaster} from './visualMaster.js';
import {assertActualVideoDuration} from './videoDuration.js';
const exec=promisify(execFile),active=new Set<string>();
async function stage(id:string,status:string,label:string,progress:number){await query('UPDATE video_generations SET status=$2,current_stage=$3,progress=$4,last_activity_at=NOW() WHERE id=$1',[id,status,label,progress]);}
function background(id:string,dataDir:string,forceSeriesId?:string){
 if(active.has(id))return;active.add(id);
 run(id,dataDir,forceSeriesId).catch(async e=>{
  await query("UPDATE video_generations SET status='failed',current_stage='Generation stopped — see provider error',error_message=$2,last_activity_at=NOW() WHERE id=$1",[id,redactStartupError(e.message)]);
  await query('UPDATE automation_schedules SET failed_count=failed_count+1,updated_at=NOW() WHERE id=(SELECT schedule_id FROM video_generations WHERE id=$1)',[id]);
 }).finally(async()=>{await releaseGpuJob(id).catch(()=>{});active.delete(id);});
}
export async function launchVideoGenerationPipeline(params:{dataDir:string;triggerType:'manual'|'scheduled';scheduleId?:string|null;forceSeriesId?:string}):Promise<string>{
 const id='vid_'+crypto.randomUUID().slice(0,12);
 const [setting]=await query<any>("SELECT value FROM app_settings WHERE key='auto_delete'");
 await query("INSERT INTO video_generations(id,trigger_type,schedule_id,status,current_stage,progress,content_series,series_id,width,height,auto_delete_enabled,min_duration_sec) VALUES($1,$2,$3,'reasoning','Planning the production',5,'Selecting weighted series','pending',720,1280,$4,25)",[id,params.triggerType,params.scheduleId||null,setting?.value?.enabled!==false]);
 background(id,params.dataDir,params.forceSeriesId);return id;
}
/** Explicit UI-requested retry only. Never automatically rerun ambiguous work. */
export async function resumeFailedLtxVideo(id:string,dataDir:string):Promise<string>{
 if(active.has(id))throw Error('This generation is still active');
 const [row]=await query<any>('SELECT * FROM video_generations WHERE id=$1 AND deleted_at IS NULL',[id]);
 const old=row?.comfyui_workflow;
 if(row?.status!=='failed'||old?.engine!==LTX_VIDEO_SPEC.id||!old?.production_plan)
  throw Error('Only failed LTX productions with a saved plan can be resumed');
 if(old.music_starting||old.remote_music_job_id)
  throw Error('Music may already have started; refusing an ambiguous duplicate music request');
 const runtime=await notebookStatus(GPU_PROFILES[0]);
 if(!['COMPLETE','ERROR','CANCELLED','CANCELED'].includes(String(runtime.status||'').toUpperCase()))
  throw Error('Previous video GPU session is not confirmed stopped; retry after provider shutdown');
 const kept:Record<string,any>={},unfinished:string[]=[];
 for(const [key,value] of Object.entries(old.ltx_segments||{})){
  const item=value as any;
  const file=path.join(dataDir,'videos','ltx-originals',id,`segment_${key}.mp4`);
  if(item.persisted&&(!fs.existsSync(file)||fs.statSync(file).size===0))
   throw Error('A previously persisted segment is missing; restore it before resuming to avoid replacing an acknowledged output');
  if(/^\d+$/.test(key)&&item.persisted&&fs.existsSync(file)&&fs.statSync(file).size>0)kept[key]=item;
  else unfinished.push(key);
 }
 const workflow={...old,ltx_segments:kept,retry_history:[...(old.retry_history||[]),{
  requested_at:new Date().toISOString(),user_initiated:true,previous_error:row.error_message,
  retained_segments:Object.keys(kept),retry_unpersisted_segments:unfinished,
  previous_runtime_status:runtime.status}]};
 // Compare-and-set makes simultaneous clicks safe across application instances.
 const updated=await query<any>(`UPDATE video_generations SET status='generating_video',
  current_stage='Resuming saved LTX segments; unfinished segments will be retried',error_message=NULL,
  comfyui_workflow=$2::jsonb,last_activity_at=NOW() WHERE id=$1 AND status='failed' RETURNING id`,[id,JSON.stringify(workflow)]);
 if(!updated.length)throw Error('Another request already resumed this generation');
 background(id,dataDir);return id;
}
async function run(id:string,dataDir:string,forceSeriesId?:string){
 let [row]=await query<any>('SELECT * FROM video_generations WHERE id=$1',[id]);
 let plan:FullProductionPlan=row.comfyui_workflow?.production_plan;
 if(!plan){
  plan=await generateFullVideoProductionPlan({forceSeriesId});
  await query(`UPDATE video_generations SET title=$2,content_series=$3,series_id=$4,video_concept=$5,script=$6,scene_plan=$7::jsonb,choreography=$8,camera_instructions=$9,outfit_descriptions=$10,location=$11,lighting_cinematography=$12,expressions_poses=$13,music_prompt=$14,lyrics=$15,vocal_hook=$16,audio_characteristics=$17::jsonb,similarity_score=$18,regeneration_attempts=$19,comfyui_workflow=$20::jsonb WHERE id=$1`,[id,plan.title,plan.selected_series.name,plan.selected_series.id,plan.video_concept,plan.script,JSON.stringify(plan.scenes),plan.choreography_summary,plan.camera_summary,plan.outfit_descriptions,plan.location,plan.lighting_cinematography,plan.expressions_poses,plan.music.caption_prompt,plan.music.lyrics,plan.music.vocal_hook,JSON.stringify(plan.music.audio_characteristics),plan.similarity_score,plan.regeneration_attempts,JSON.stringify({engine:LTX_VIDEO_SPEC.id,production_plan:plan,conditioning:'LTX image-to-video: first persisted Scarlett reference, then previous segment final frame. All three originals retained; this graph conditions on one initial frame, not three native identity references.'})]);
 }
 const temp=path.join(dataDir,'temp',id),originals=path.join(dataDir,'videos','ltx-originals',id);fs.mkdirSync(temp,{recursive:true});fs.mkdirSync(originals,{recursive:true});
 let reference=path.join(dataDir,'references','scarlett_ref_1.jpg');if(!fs.existsSync(reference))throw Error('Persisted Scarlett reference is missing; identity conditioning cannot proceed');
 const clips:string[]=[];let index=0;
 for(const scene of plan.scenes){
  let remaining=scene.frame_count;
  while(remaining>0){
   const frames=Math.min(121,remaining),current=index++;
   const clip=path.join(temp,`segment_${current}.mp4`),original=path.join(originals,`segment_${current}.mp4`);
   await stage(id,'generating_video',`LTX-2.3: rendering shot ${scene.scene_number}, segment ${current+1} (stage progress, not model ETA)`,20+Math.round(45*(scene.start_sec/plan.total_duration_sec)));
   const image='data:image/'+(reference.endsWith('.png')?'png':'jpeg')+';base64,'+fs.readFileSync(reference).toString('base64');
   await renderLtxSegment(id,current,scene.comfy_prompt,image,frames,original,label=>stage(id,'generating_video',label,25));
   // Preserve model-native audiovisual original; create an H.264 browser derivative, trimming only surplus native frames.
   await exec('ffmpeg',['-y','-v','error','-i',original,'-vf',`fps=24,trim=end_frame=${frames},setpts=PTS-STARTPTS,scale=720:1280:flags=lanczos`,'-an','-c:v','libx264','-crf','17','-preset','fast','-pix_fmt','yuv420p','-movflags','+faststart',clip],{timeout:180000});
   await exec('ffmpeg',['-v','error','-i',clip,'-f','null','-'],{timeout:120000});
   const {stdout}=await exec('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','csv=p=0',clip]);
   if(Number(stdout.trim())!==frames)throw Error('LTX output had fewer real frames than requested; refusing freeze-frame or loop padding');
   clips.push(clip);reference=path.join(temp,`continuity_${current}.png`);
   await exec('ffmpeg',['-y','-v','error','-i',clip,'-vf',`select=eq(n\\,${frames-1})`,'-frames:v','1',reference],{timeout:60000});
   remaining-=frames;
  }
 }
 await stage(id,'post_processing','Saving real visual output before soundtrack finalization',72);
 const manifest=path.join(temp,'concat.txt');fs.writeFileSync(manifest,clips.map(file=>`file '${file}'`).join('\n'));
 const visual=path.join(temp,'visual.mp4');await exec('ffmpeg',['-y','-v','error','-f','concat','-safe','0','-i',manifest,'-c','copy','-movflags','+faststart',visual],{timeout:120000});
 const receipt=await persistVisualMaster(visual,path.join(dataDir,'videos'),id,25);
 await query("UPDATE video_generations SET comfyui_workflow=jsonb_set(comfyui_workflow,'{visual_master}',$2::jsonb,true) WHERE id=$1",[id,JSON.stringify(receipt)]);
 await releaseGpuLease(LTX_SERVICE,id);
 [row]=await query<any>('SELECT * FROM video_generations WHERE id=$1',[id]);
 let music:any;
 if(row.music_track_id){const [track]=await query<any>('SELECT * FROM music_tracks WHERE id=$1',[row.music_track_id]);if(track?.file_name&&fs.existsSync(path.join(dataDir,'music',track.file_name)))music={filePath:path.join(dataDir,'music',track.file_name)};}
 if(!music){
  const remote=row.comfyui_workflow?.remote_music_job_id;
  if(row.comfyui_workflow?.music_starting&&!remote)throw Error('Soundtrack submission outcome unknown; refusing an automatic duplicate music request');
  await stage(id,'generating_music','Existing music GPU is composing the original soundtrack',78);
  await query("UPDATE video_generations SET comfyui_workflow=jsonb_set(comfyui_workflow,'{music_starting}','true'::jsonb,true) WHERE id=$1",[id]);
  music=await executeMusicGenerationOnComfyUI({dataDir,title:plan.music.title,bpm:plan.music.bpm,musicalKey:plan.music.musical_key,vocalHook:plan.music.vocal_hook,songStructure:plan.music.song_structure,captionPrompt:plan.music.caption_prompt,lyrics:plan.music.lyrics,audioCharacteristics:plan.music.audio_characteristics,durationSec:plan.total_duration_sec+0.8,similarityScore:plan.similarity_score,parentVideoGenId:id,existingRemoteJobId:remote});
 }
 await stage(id,'post_processing','Muxing and fully decoding the saved video and soundtrack',92);
 const finalName=id+'.mp4',final=path.join(dataDir,'videos',finalName),thumbnail=id+'.jpg';
 await exec('ffmpeg',['-y','-v','error','-i',visual,'-i',music.filePath,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(plan.total_duration_sec),'-movflags','+faststart',final],{timeout:180000});
 await exec('ffmpeg',['-v','error','-i',final,'-f','null','-'],{timeout:120000});
 const {stdout}=await exec('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',final]);const duration=assertActualVideoDuration(Number(stdout.trim()));
 await exec('ffmpeg',['-y','-v','error','-i',final,'-frames:v','1',path.join(dataDir,'videos',thumbnail)],{timeout:60000});
 await query("UPDATE video_generations SET status='completed',current_stage='Completed — visual quality requires review',progress=100,video_file_name=$2,thumbnail_file_name=$3,duration_sec=$4,completed_at=NOW(),last_activity_at=NOW(),expires_at=CASE WHEN auto_delete_enabled THEN NOW()+INTERVAL '72 hours' ELSE NULL END,error_message=NULL WHERE id=$1",[id,finalName,thumbnail,duration]);
 await query('UPDATE automation_schedules SET success_count=success_count+1,updated_at=NOW() WHERE id=(SELECT schedule_id FROM video_generations WHERE id=$1)',[id]);
 await generateSocialMetadata(id,dataDir).catch(()=>{});
}
export async function recoverLtxGenerations(dataDir:string){
 const rows=await query<any>("SELECT id,comfyui_workflow FROM video_generations WHERE status NOT IN ('completed','failed')");
 for(const row of rows){
  if(active.has(row.id))continue;
  if(row.comfyui_workflow?.engine===LTX_VIDEO_SPEC.id||!row.comfyui_workflow?.engine&&!row.comfyui_workflow?.remote_video_job_id&&!row.comfyui_workflow?.remote_music_job_id)background(row.id,dataDir);
  else await query("UPDATE video_generations SET status='failed',error_message='Retired video renderer: historical files retained; this job will not start a video GPU',current_stage='Retired video job retained' WHERE id=$1",[row.id]);
 }
}
