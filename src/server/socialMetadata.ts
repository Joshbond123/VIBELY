import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query } from './db.js';
const exec = promisify(execFile);
const active = new Set<string>();

// Deliberately accepts only a rendered local video, never a proposed script.
export async function generateSocialMetadata(id: string, dataDir: string): Promise<void> {
  if (active.has(id)) return;
  active.add(id);
  try {
    const [video] = await query<any>('SELECT * FROM video_generations WHERE id = $1', [id]);
    if (!video?.video_file_name) throw new Error('A rendered video is required for captions');
    const file = path.join(dataDir, 'videos', path.basename(video.video_file_name));
    if (!fs.existsSync(file)) throw new Error('Rendered video file not found');
    await query("UPDATE video_generations SET caption_status='generating', caption_attempts=caption_attempts+1 WHERE id=$1", [id]);
    const frames: any[] = [];
    const temp = fs.mkdtempSync(path.join(dataDir, 'temp', 'social-'));
    try {
      for (const [i, fraction] of [0.02, 0.25, 0.5, 0.75, 0.96].entries()) {
        const out = path.join(temp, `${i}.jpg`);
        await exec('ffmpeg', ['-y','-v','error','-ss', String(Number(video.duration_sec) * fraction), '-i', file, '-frames:v','1','-vf','scale=448:-2','-q:v','4',out], {timeout: 30000});
        frames.push({ type: 'image_url', image_url: {url: `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`} });
      }
    } finally { fs.rmSync(temp, {recursive:true,force:true}); }
    const recent = await query<any>("SELECT social_caption FROM video_generations WHERE social_caption<>'' AND id<>$1 ORDER BY completed_at DESC LIMIT 20", [id]);
    const content = [{type:'text',text: `These are chronological frames from a FINISHED video, not a storyboard. Describe only visible activity, outfit, and environment. Do not assert exact exercise form, audio beat synchronization, location, or perfect anatomy unless observable. Series: ${video.content_series}. Music metadata (not visible evidence): ${video.music_prompt}. Return ONLY JSON: {"caption":"one unique short natural social caption, maximum 300 characters","hashtags":["#relevant", "#TikTok", "#InstagramReels"],"observed_content":"factual description of these frames", "quality_notes":["visible defects or uncertainty"]}. Use 6-10 relevant hashtags; no unsupported body/fitness claims. Avoid these previous captions: ${JSON.stringify(recent.map(x=>x.social_caption))}`}, ...frames];
    let result: any; let modelUsed=''; let lastError='';
    for (const model of ['nvidia/nemotron-3.5-super-vl-120b-a12b','meta/llama-3.2-90b-vision-instruct']) {
      try {
        const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {method:'POST', signal:AbortSignal.timeout(90000), headers:{Authorization:`Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type':'application/json'}, body:JSON.stringify({model,messages:[{role:'user',content}],temperature:0.5,max_tokens:1200,stream:false})});
        if (!res.ok) throw new Error(`Vision metadata API ${res.status}`);
        const data: any = await res.json();
        const text = String(data.choices?.[0]?.message?.content || '');
        result = JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
        if (typeof result.caption!=='string' || !result.caption.trim() || !Array.isArray(result.hashtags) || !result.observed_content) throw new Error('Invalid vision metadata');
        if (recent.some(x=>x.social_caption.trim().toLowerCase()===result.caption.trim().toLowerCase())) throw new Error('Duplicate caption rejected');
        modelUsed=model;break;
      } catch(e:any) {lastError=e.message;result=null;}
    }
    if (!result) throw new Error(lastError || 'No vision model available');
    const tags=[...new Set<string>(result.hashtags.map((t:any)=>'#'+String(t).replace(/[^\p{L}\p{N}_]/gu,'')))].filter(x=>x.length>1).slice(0,12);
    if (tags.length<4) throw new Error('Insufficient relevant hashtags');
    await query(`UPDATE video_generations SET social_caption=$2, hashtags=$3::jsonb, caption_status='completed', caption_error=NULL, observed_content=$4, quality_notes=$5::jsonb, caption_model=$6 WHERE id=$1`,[id,result.caption.trim().slice(0,500),JSON.stringify(tags),result.observed_content,JSON.stringify(result.quality_notes || []),modelUsed]);
  } catch(e:any) {
    await query("UPDATE video_generations SET caption_status='failed',caption_error=$2 WHERE id=$1",[id,e.message]);
    throw e;
  } finally {active.delete(id);}
}

export async function recoverSocialMetadata(dataDir: string) {
  const rows=await query<any>("SELECT id FROM video_generations WHERE status='completed' AND deleted_at IS NULL AND caption_status IN ('pending','failed','generating') AND caption_attempts<3 ORDER BY completed_at DESC LIMIT 1");
  for(const row of rows) await generateSocialMetadata(row.id,dataDir).catch(e=>console.error('[Social metadata]',row.id,e.message));
}
