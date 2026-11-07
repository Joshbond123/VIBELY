import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query } from './db.js';
import {acquireGpu,releaseGpuLease,releaseGpuJob,acknowledgeGpuOutput,gpuEvent} from './gpuLifecycle.js';
import { generateSocialMetadata } from './socialMetadata.js';
import {
  generateStandaloneMusicPlan,
} from './reasoningEngine.js';

const execFileAsync = promisify(execFile);

async function workerFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const attempts = !options.method || options.method === 'GET' ? 4 : 1;
  for (let i=0;i<attempts;i++) {
    try {
      const response=await fetch(url,{...options,signal:options.signal || AbortSignal.timeout(30000)});
      if (response.status>=500 && i+1<attempts) { await response.body?.cancel(); throw new Error(`Temporary HTTP ${response.status}`); }
      return response;
    } catch(e) { if(i+1===attempts) throw e; await new Promise(r=>setTimeout(r,Math.min(8000,1000*2**i))); }
  }
  throw new Error('Request retries exhausted');
}


export interface ModelEndpointRecord {
  service_id: string;
  username: string;
  model_name: string;
  endpoint_url: string;
  api_key: string;
  status: string;
  comfyui_ready: boolean;
  dataset_cached: boolean;
  storage_sources: any;
  gpu_name: string;
  extra_meta: any;
  last_heartbeat_at: string | null;
  updated_at: string;
}

let syncingEndpoints=false;
export async function syncKaggleEndpointsAndHealth():Promise<ModelEndpointRecord[]> {
  // Authenticated heartbeat registration is authoritative. Archived endpoint
  // datasets must never overwrite a newer worker or block readiness polling.
  if(!syncingEndpoints){
    syncingEndpoints=true;
    try{
      const current=await query<ModelEndpointRecord>("SELECT * FROM model_endpoints WHERE service_id IN ('minimax_music_3','ltx_2_3_distilled_gguf_q4')");
      await Promise.all(current.filter(ep=>ep.endpoint_url && ep.comfyui_ready).map(ep=>probeWorkerHealth(ep.service_id,ep.endpoint_url)));
    }finally{syncingEndpoints=false;}
  }
  return query<ModelEndpointRecord>("SELECT * FROM model_endpoints WHERE service_id IN ('minimax_music_3','ltx_2_3_distilled_gguf_q4')");
}

export async function probeWorkerHealth(serviceId: string, baseUrl: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const h: any = await resp.json();
    if (!h?.ok) return false;
    const [registered]=await query<any>('SELECT extra_meta FROM model_endpoints WHERE service_id=$1',[serviceId]);
    if(registered?.extra_meta?.worker_version==='lifecycle-v3' && h.worker_version!=='lifecycle-v3') return false;
    if(Number(registered?.extra_meta?.worker_started_at || 0)>Number(h.worker_started_at || 0)) return false;

    await query(
      `UPDATE model_endpoints
       SET endpoint_url = $2,
           status = $3,
           comfyui_ready = $4,
           dataset_cached = $5,
           storage_sources = $6::jsonb,
           gpu_name = $7,
           extra_meta = model_endpoints.extra_meta || $8::jsonb,
           last_heartbeat_at = NOW(),
           updated_at = NOW()
       WHERE service_id = $1`,
      [
        serviceId,
        baseUrl.replace(/\/$/, ''),
        h.comfyui_ready ? 'online' : h.stage || 'initializing',
        Boolean(h.comfyui_ready),
        Boolean(h.dataset_cached),
        JSON.stringify(h.storage_sources || {}),
        String(h.gpu || ''),
        JSON.stringify({ worker_version: h.worker_version || null, worker_started_at:h.worker_started_at || 0, stage: h.stage, uptime_sec: h.uptime_sec, character_refs: h.character_refs || [], last_error: h.last_error || '' }),
      ]
    );
    return true;
  } catch {
    return false;
  }
}

export async function getReadyEndpoint(serviceId:string,jobId:string):Promise<ModelEndpointRecord> {
  if(!['minimax_music_3','ltx_2_3_distilled_gguf_q4'].includes(serviceId))throw new Error('Unsupported video/music service');
  await acquireGpu(serviceId,jobId);
  const start=Date.now();
  while(Date.now()-start<20*60000) {
    const [local]=await query<any>(`SELECT status FROM video_generations WHERE id=$1 UNION ALL SELECT status FROM music_tracks WHERE id=$1 LIMIT 1`,[jobId]);
    if(local && ['completed','failed','cancelled'].includes(local.status))throw new Error('Generation was cancelled or became terminal during GPU startup');
    const [ep]=await query<ModelEndpointRecord>('SELECT * FROM model_endpoints WHERE service_id=$1',[serviceId]);
    const [session]=await query<any>('SELECT * FROM gpu_sessions WHERE service_id=$1',[serviceId]);
    // A terminated failed startup must not silently re-dispatch in this same wait loop.
    if(session?.state==='OFF' && session?.error) throw new Error(session.error);
    if(session?.state==='OFF') await acquireGpu(serviceId,jobId);
    if(session?.state==='ERROR') throw new Error(session.error || 'GPU startup failed');
    if(ep?.comfyui_ready && ep.extra_meta?.worker_version==='lifecycle-v3' && session?.state==='ON') return ep;

    await new Promise(r=>setTimeout(r,2000));
  }
  throw new Error(`GPU startup deadline exceeded for ${serviceId}; check Kaggle quota and session availability`);
}

const ACTIVE_IN_MEMORY_JOBS = new Set<string>();

export async function executeMusicGenerationOnComfyUI(params: {
  dataDir: string;
  title: string;
  bpm: number;
  musicalKey: string;
  vocalHook: string;
  songStructure: string[];
  captionPrompt: string;
  lyrics: string;
  audioCharacteristics: any;
  durationSec: number;
  similarityScore: number;
  parentVideoGenId?: string;
  existingRemoteJobId?: string;
  precreatedTrackId?: string;
}): Promise<{ trackId: string; fileName: string; filePath: string; durationSec: number; comfyPromptId: string; workflow: any }> {
  const trackId = params.precreatedTrackId || ('trk_' + crypto.randomUUID().slice(0, 12));
  const ep = await getReadyEndpoint('minimax_music_3',params.parentVideoGenId || trackId);
  const apiKey = ep.api_key || process.env.MINIMAX_MUSIC3_API_KEY || '';

  let remoteJobId = params.existingRemoteJobId || '';
  if (!remoteJobId) {
    const createResp = await workerFetch(`${ep.endpoint_url}/v1/music/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: params.parentVideoGenId || trackId,
        caption: params.captionPrompt,
        lyrics: params.lyrics,
        duration_sec: params.durationSec,
        steps: 10,
        cfg_scale: 1.5,
        top_k: 50,
      }),
    });

    if (!createResp.ok) {
      throw new Error(`MiniMax Music 3 API error (${createResp.status}): ${await createResp.text()}`);
    }
    const cj: any = await createResp.json();
    remoteJobId = cj.job_id;
    await gpuEvent('minimax_music_3','GENERATING',{job_id:params.parentVideoGenId || trackId,remote_job_id:remoteJobId});
    if(params.parentVideoGenId) await query("UPDATE video_generations SET stage_timings=stage_timings || jsonb_build_array(jsonb_build_object('stage','music_submitted','at',NOW())) WHERE id=$1",[params.parentVideoGenId]);
    if (params.parentVideoGenId) {
      await query(
        `UPDATE video_generations SET comfyui_workflow = jsonb_set(COALESCE(comfyui_workflow, '{}'::jsonb), '{remote_music_job_id}', to_jsonb($2::text), true) WHERE id = $1`,
        [params.parentVideoGenId, remoteJobId]
      );
    }
    if (params.precreatedTrackId) {
      await query(
        `UPDATE music_tracks SET comfyui_workflow = jsonb_set(COALESCE(comfyui_workflow, '{}'::jsonb), '{remote_music_job_id}', to_jsonb($2::text), true) WHERE id = $1`,
        [params.precreatedTrackId, remoteJobId]
      );
    }
  }

  let completedJob: any = null;
  const started = Date.now();
  let musicPollErrors = 0;
  while (Date.now() - started < 20 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    const stResp = await workerFetch(`${ep.endpoint_url}/v1/music/jobs/${remoteJobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!stResp.ok) {
      if (stResp.status===404 || ++musicPollErrors>=10) throw new Error(`Music worker job unavailable: HTTP ${stResp.status}`);
      continue;
    }
    musicPollErrors=0;
    if (params.parentVideoGenId) await query('UPDATE video_generations SET last_activity_at=NOW() WHERE id=$1',[params.parentVideoGenId]);
    const jobData: any = await stResp.json();
    if (jobData.status === 'completed') {
      completedJob = jobData;
      break;
    }
    if (jobData.status === 'failed') {
      throw new Error(`MiniMax Music 3 ComfyUI failure: ${jobData.error || 'Unknown error'}`);
    }
  }

  if (!completedJob) {
    throw new Error('Timed out waiting for MiniMax Music 3 Q4_0 GGUF generation');
  }

  const audioResp = await workerFetch(`${ep.endpoint_url}/v1/music/jobs/${remoteJobId}/audio`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!audioResp.ok) {
    throw new Error(`Failed downloading generated MP3 (${audioResp.status})`);
  }

  const musicDir = path.join(params.dataDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  const fileName = `${trackId}.mp3`;
  const filePath = path.join(musicDir, fileName);
  const arrayBuf = await audioResp.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(arrayBuf),{flush:true});

  await execFileAsync('ffmpeg',['-v','error','-i',filePath,'-f','null','-'],{timeout:60000});
  const actualDuration = Number(completedJob.duration_sec || params.durationSec);
  const comfyPromptId = String(completedJob.comfyui_prompt_id || '');
  const workflow = completedJob.workflow_used || {};

  if (params.precreatedTrackId) {
    await query(
      `UPDATE music_tracks
       SET title = $2, bpm = $3, musical_key = $4, vocal_hook = $5, caption_prompt = $6, lyrics = $7,
           song_structure = $8::jsonb, audio_characteristics = $9::jsonb, comfyui_prompt_id = $10,
           comfyui_workflow = $11::jsonb, file_name = $12, duration_sec = $13, similarity_score = $14,
           status = 'completed', error_message = NULL
       WHERE id = $1`,
      [
        trackId,
        params.title,
        params.bpm,
        params.musicalKey,
        params.vocalHook,
        params.captionPrompt,
        params.lyrics,
        JSON.stringify(params.songStructure),
        JSON.stringify(params.audioCharacteristics || {}),
        comfyPromptId,
        JSON.stringify(workflow),
        fileName,
        actualDuration,
        params.similarityScore,
      ]
    );
  } else {
    await query(
      `INSERT INTO music_tracks
        (id, title, genre, bpm, musical_key, vocal_hook, caption_prompt, lyrics, song_structure, audio_characteristics, comfyui_prompt_id, comfyui_workflow, file_name, duration_sec, similarity_score, status)
       VALUES ($1,$2,'Amapiano + Afrobeats Fusion',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14,'completed')`,
      [
        trackId,
        params.title,
        params.bpm,
        params.musicalKey,
        params.vocalHook,
        params.captionPrompt,
        params.lyrics,
        JSON.stringify(params.songStructure),
        JSON.stringify(params.audioCharacteristics || {}),
        comfyPromptId,
        JSON.stringify(workflow),
        fileName,
        actualDuration,
        params.similarityScore,
      ]
    );
  }

  if (params.parentVideoGenId) await query("UPDATE video_generations SET music_track_id=$2, stage_timings=stage_timings || jsonb_build_array(jsonb_build_object('stage','music_completed','at',NOW())) WHERE id=$1",[params.parentVideoGenId,trackId]);

  await acknowledgeGpuOutput('minimax_music_3',remoteJobId,{sha256:crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),bytes:fs.statSync(filePath).size,playable:true,file:fileName});
  await releaseGpuLease('minimax_music_3',params.parentVideoGenId || params.precreatedTrackId || trackId);
  return { trackId, fileName, filePath, durationSec: actualDuration, comfyPromptId, workflow };
}

export async function startStandaloneMusicTask(dataDir: string, customTheme?: string, requestedDurationSec?: number) {
  const trackId = 'trk_' + crypto.randomUUID().slice(0, 12);
  await query(
    `INSERT INTO music_tracks
      (id, title, genre, bpm, musical_key, vocal_hook, caption_prompt, lyrics, duration_sec, status)
     VALUES ($1,$2,'Amapiano + Afrobeats Fusion',114,'F minor','','Synthesizing concept via NVIDIA Nemotron...','Generating lyrics...',24,'generating')`,
    [trackId, customTheme ? String(customTheme).slice(0, 60) : 'Original Fusion Track (Generating...)']
  );

  ACTIVE_IN_MEMORY_JOBS.add(trackId);
  (async () => {
    try {
      const plan = await generateStandaloneMusicPlan(customTheme);
      const targetDur = Number.isFinite(requestedDurationSec) ? Math.max(20, Math.min(180, Number(requestedDurationSec))) : 22 + crypto.randomInt(0, 4);
      await query(
        `UPDATE music_tracks SET title = $2, bpm = $3, musical_key = $4, vocal_hook = $5, caption_prompt = $6, lyrics = $7, song_structure = $8::jsonb, audio_characteristics = $9::jsonb, similarity_score = $10 WHERE id = $1`,
        [trackId, plan.title, plan.bpm, plan.musical_key, plan.vocal_hook, plan.caption_prompt, plan.lyrics, JSON.stringify(plan.song_structure), JSON.stringify(plan.audio_characteristics || {}), plan.similarity_score]
      );
      await executeMusicGenerationOnComfyUI({
        dataDir,
        title: plan.title,
        bpm: plan.bpm,
        musicalKey: plan.musical_key,
        vocalHook: plan.vocal_hook,
        songStructure: plan.song_structure,
        captionPrompt: plan.caption_prompt,
        lyrics: plan.lyrics,
        audioCharacteristics: plan.audio_characteristics,
        durationSec: targetDur,
        similarityScore: plan.similarity_score,
        precreatedTrackId: trackId,
      });
    } catch (err: any) {
      await query(`UPDATE music_tracks SET status = 'failed', error_message = $2 WHERE id = $1`, [trackId, err?.message || String(err)]);
    } finally {
      await releaseGpuJob(trackId);
      ACTIVE_IN_MEMORY_JOBS.delete(trackId);
    }
  })();

  const rows = await query(`SELECT * FROM music_tracks WHERE id = $1`, [trackId]);
  return rows[0];
}

export async function recoverInFlightGenerations(dataDir: string): Promise<void> {
  // Also recover any in-flight standalone music tracks
  const inflightMusic = await query<any>(
    `SELECT * FROM music_tracks WHERE status = 'generating'`
  );
  for (const mrow of inflightMusic) {
    if (ACTIVE_IN_MEMORY_JOBS.has(mrow.id)) continue;
    const rjid = mrow.comfyui_workflow?.remote_music_job_id;
    if (!rjid) {
      if(Date.now()-new Date(mrow.created_at).getTime()>10*60*1000) await query("UPDATE music_tracks SET status='failed',error_message='Music planning interrupted before worker submission; please retry' WHERE id=$1",[mrow.id]);
      continue;
    }
    ACTIVE_IN_MEMORY_JOBS.add(mrow.id);
    (async () => {
      try {
        await executeMusicGenerationOnComfyUI({
          dataDir,
          title: mrow.title || 'Recovered Track',
          bpm: Number(mrow.bpm || 114),
          musicalKey: mrow.musical_key || 'F minor',
          vocalHook: mrow.vocal_hook || '',
          songStructure: Array.isArray(mrow.song_structure) ? mrow.song_structure : [],
          captionPrompt: mrow.caption_prompt || '',
          lyrics: mrow.lyrics || '',
          audioCharacteristics: mrow.audio_characteristics || {},
          durationSec: Number(mrow.duration_sec || 24),
          similarityScore: Number(mrow.similarity_score || 0),
          existingRemoteJobId: rjid,
          precreatedTrackId: mrow.id,
        });
      } catch (err: any) {
        await query(`UPDATE music_tracks SET status = 'failed', error_message = $2 WHERE id = $1`, [mrow.id, err?.message || String(err)]);
      } finally {
        await releaseGpuJob(mrow.id);
        ACTIVE_IN_MEMORY_JOBS.delete(mrow.id);
      }
    })();
  }
}
