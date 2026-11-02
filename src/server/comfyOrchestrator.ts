import {assertActualVideoDuration} from './videoDuration.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { query } from './db.js';
import {acquireGpu,releaseGpuLease,releaseGpuJob,acknowledgeGpuOutput,gpuEvent} from './gpuLifecycle.js';
import { generateSocialMetadata } from './socialMetadata.js';
import {
  FullProductionPlan,
  generateFullVideoProductionPlan,
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

const KAGGLE_WORKERS = [
  {
    service_id: 'minimax_music_3',
    username: 'happink',
    slug: 'vibely-music-gpu-worker',
    endpointDataset: 'happink/vibely-music3-live-endpoint',
    tokenEnv: 'KAGGLE_HAPPINK_TOKEN',
    urlRegex: /VIBELY_MUSIC_TUNNEL_URL=(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/g,
  },
  {
    service_id: 'minimax_h3_ref2va',
    username: 'joshbond123',
    slug: 'vibely-minimax-h3-ref2va-server',
    endpointDataset: 'joshbond123/vibely-h3-live-endpoint',
    tokenEnv: 'KAGGLE_JOSHBOND_TOKEN',
    urlRegex: /VIBELY_VIDEO_TUNNEL_URL=(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/g,
  },
];

async function readKaggleEndpointDataset(datasetSlug: string, kToken: string): Promise<any | null> {
  const tmpZip = `/tmp/ep_${datasetSlug.replace('/', '_')}_${Date.now()}.zip`;
  try {
    const resp = await workerFetch(`https://www.kaggle.com/api/v1/datasets/download/${datasetSlug}`, {
      headers: { Authorization: `Bearer ${kToken}` },
    });
    if (!resp.ok) return null;
    fs.writeFileSync(tmpZip, Buffer.from(await resp.arrayBuffer()));
    const { stdout } = await execFileAsync('unzip', ['-p', tmpZip, 'endpoint.json']);
    return JSON.parse(stdout);
  } catch {
    return null;
  } finally {
    if (fs.existsSync(tmpZip)) {
      try { fs.unlinkSync(tmpZip); } catch {}
    }
  }
}

let syncingEndpoints=false;
export async function syncKaggleEndpointsAndHealth():Promise<ModelEndpointRecord[]> {
  // Authenticated heartbeat registration is authoritative. Archived endpoint
  // datasets must never overwrite a newer worker or block readiness polling.
  if(!syncingEndpoints){
    syncingEndpoints=true;
    try{
      const current=await query<ModelEndpointRecord>('SELECT * FROM model_endpoints');
      await Promise.all(current.filter(ep=>ep.endpoint_url && ep.comfyui_ready).map(ep=>probeWorkerHealth(ep.service_id,ep.endpoint_url)));
    }finally{syncingEndpoints=false;}
  }
  return query<ModelEndpointRecord>('SELECT * FROM model_endpoints');
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

async function getReadyEndpoint(serviceId:string,jobId:string):Promise<ModelEndpointRecord> {
  if(serviceId==='minimax_h3_ref2va') await updateVideoStage(jobId,'generating_video','Requesting video GPU allocation and ComfyUI initialization',42);
  await acquireGpu(serviceId,jobId);
  const start=Date.now();
  while(Date.now()-start<20*60000) {
    const [ep]=await query<ModelEndpointRecord>('SELECT * FROM model_endpoints WHERE service_id=$1',[serviceId]);
    const [session]=await query<any>('SELECT * FROM gpu_sessions WHERE service_id=$1',[serviceId]);
    if(session?.state==='OFF') await acquireGpu(serviceId,jobId);
    if(session?.state==='ERROR') throw new Error(session.error || 'GPU startup failed');
    if(ep?.comfyui_ready && ep.extra_meta?.worker_version==='lifecycle-v3' && session?.state==='ON') return ep;
    if(serviceId==='minimax_h3_ref2va') await updateVideoStage(jobId,'generating_video',`Video GPU ${session?.state || 'UNKNOWN'} — waiting for model/ComfyUI readiness`,42);
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

async function updateVideoStage(genId: string, status: string, stage: string, progress: number, extraSql = '', extraParams: any[] = []) {
  await query(
    `UPDATE video_generations SET last_activity_at = NOW(), stage_timings = CASE WHEN current_stage <> $3 THEN stage_timings || jsonb_build_array(jsonb_build_object('stage',$3::text,'at',NOW(),'progress',$4::int)) ELSE stage_timings END, status = $2, current_stage = $3, progress = $4 ${extraSql} WHERE id = $1`,
    [genId, status, stage, progress, ...extraParams]
  );
}

export async function launchVideoGenerationPipeline(params: {
  dataDir: string;
  triggerType: 'manual' | 'scheduled';
  scheduleId?: string | null;
  forceSeriesId?: string;
}): Promise<string> {
  const genId = 'vid_' + crypto.randomUUID().slice(0, 12);

  // Read current auto_delete setting
  const setRows = await query<{ value: any }>(`SELECT value FROM app_settings WHERE key = 'auto_delete'`);
  const autoDeleteEnabled = setRows[0]?.value?.enabled !== false;

  await query(
    `INSERT INTO video_generations (id, trigger_type, schedule_id, status, current_stage, progress, content_series, series_id, width, height, auto_delete_enabled, min_duration_sec)
     VALUES ($1, $2, $3, 'reasoning', 'Layer 1: NVIDIA AI Reasoning creating concept & weighted series...', 5, 'Selecting weighted series...', 'pending', 720, 1280, $4, 25)`,
    [genId, params.triggerType, params.scheduleId || null, autoDeleteEnabled]
  );

  await query("UPDATE video_generations SET stage_timings=jsonb_build_array(jsonb_build_object('stage','reasoning','at',NOW(),'progress',5)) WHERE id=$1",[genId]);
  ACTIVE_IN_MEMORY_JOBS.add(genId);
  // Run asynchronous full pipeline in background
  runFullPipelineBg(genId, params.dataDir, autoDeleteEnabled, params.forceSeriesId, params.scheduleId || null)
    .catch(async (err) => {
      console.error(`[Pipeline] Generation ${genId} failed:`, err);
      await query(
        `UPDATE video_generations SET status = 'failed', current_stage = 'Failed', error_message = $2 WHERE id = $1`,
        [genId, err?.message || String(err)]
      );
      if (params.scheduleId) {
        await query(
          `UPDATE automation_schedules SET failed_count = failed_count + 1, updated_at = NOW() WHERE id = $1`,
          [params.scheduleId]
        );
      }
    })
    .finally(async () => {
      await releaseGpuJob(genId);
      ACTIVE_IN_MEMORY_JOBS.delete(genId);
    });

  return genId;
}

async function runFullPipelineBg(
  genId: string,
  dataDir: string,
  autoDeleteEnabled: boolean,
  forceSeriesId?: string,
  scheduleId?: string | null
): Promise<void> {
  // Stage 1-4: NVIDIA Reasoning + Weighted Series + Uniqueness Verification + Scene & Music Planning
  const plan: FullProductionPlan = await generateFullVideoProductionPlan({ forceSeriesId });

  await query(
    `UPDATE video_generations
     SET content_series = $2,
         series_id = $3,
         title = $4,
         video_concept = $5,
         script = $6,
         scene_plan = $7::jsonb,
         choreography = $8,
         camera_instructions = $9,
         outfit_descriptions = $10,
         location = $11,
         lighting_cinematography = $12,
         expressions_poses = $13,
         music_prompt = $14,
         lyrics = $15,
         vocal_hook = $16,
         audio_characteristics = $17::jsonb,
         similarity_score = $18,
         regeneration_attempts = $19,
         status = 'generating_music',
         current_stage = 'Layer 2 (happink): MiniMax Music 3 Q4_0 GGUF synthesizing original Amapiano + Afrobeats track...',
         progress = 22
     WHERE id = $1`,
    [
      genId,
      plan.selected_series.name,
      plan.selected_series.id,
      plan.title,
      plan.video_concept,
      plan.script,
      JSON.stringify(plan.scenes),
      plan.choreography_summary,
      plan.camera_summary,
      plan.outfit_descriptions,
      plan.location,
      plan.lighting_cinematography,
      plan.expressions_poses,
      plan.music.caption_prompt,
      plan.music.lyrics,
      plan.music.vocal_hook,
      JSON.stringify(plan.music.audio_characteristics),
      plan.similarity_score,
      plan.regeneration_attempts,
    ]
  );

  // Stage 5: MiniMax Music 3 Q4_0 GGUF on Kaggle user "happink"
  const musicPromise = executeMusicGenerationOnComfyUI({
    dataDir,
    title: plan.music.title,
    bpm: plan.music.bpm,
    musicalKey: plan.music.musical_key,
    vocalHook: plan.music.vocal_hook,
    songStructure: plan.music.song_structure,
    captionPrompt: plan.music.caption_prompt,
    lyrics: plan.music.lyrics,
    audioCharacteristics: plan.music.audio_characteristics,
    durationSec: plan.total_duration_sec + 0.8,
    similarityScore: plan.similarity_score,
    parentVideoGenId: genId,
  });

  // Independent workers run concurrently. Music is muxed only after visual render.
  // No external audio guide is needed for anatomical reference conditioning.
  musicPromise.catch(()=>{});
  await updateVideoStage(genId,'generating_video','Video GPU rendering; music GPU composing in parallel',42);

  await executeAndFinalizeH3Video({
    genId,
    dataDir,
    scenes: plan.scenes,
    totalDurationSec: plan.total_duration_sec,
    workflowVariant: plan.workflow_variant,
    musicFilePath: "",
    musicComfyPromptId: "",
    musicPromise,
    autoDeleteEnabled,
    scheduleId: scheduleId || null,
  });
}

async function executeAndFinalizeH3Video(opts: {
  genId: string;
  dataDir: string;
  scenes: any[];
  totalDurationSec: number;
  workflowVariant: string;
  musicFilePath: string;
  musicComfyPromptId: string;
  autoDeleteEnabled: boolean;
  scheduleId: string | null;
  existingRemoteVidJobId?: string;
  musicPromise?: Promise<{trackId:string;filePath:string;comfyPromptId:string}>;
}): Promise<void> {
  const { genId, dataDir, scenes, totalDurationSec, workflowVariant, autoDeleteEnabled, scheduleId } = opts;
  let {musicFilePath,musicComfyPromptId}=opts;
  const videoEp = await getReadyEndpoint('minimax_h3_ref2va',genId);
  const videoApiKey = videoEp.api_key || process.env.MINIMAX_H3_API_KEY || '';

  let remoteVidJobId = opts.existingRemoteVidJobId || '';
  if (!remoteVidJobId) {
    const masterAudioB64 = musicFilePath && fs.existsSync(musicFilePath) ? fs.readFileSync(musicFilePath).toString('base64') : undefined;
    const createVidResp = await workerFetch(`${videoEp.endpoint_url}/v1/video/jobs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${videoApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: genId,
        scenes,
        master_audio_base64: masterAudioB64,
        diffusion_width: 320,
        diffusion_height: 576,
        width: 720,
        height: 1280,
        steps: 4,
      }),
    });

    if (!createVidResp.ok) {
      throw new Error(`MiniMax H3 Ref2VA API error (${createVidResp.status}): ${await createVidResp.text()}`);
    }
    const cj: any = await createVidResp.json();
    remoteVidJobId = cj.job_id;
    await gpuEvent('minimax_h3_ref2va','GENERATING',{job_id:genId,remote_job_id:remoteVidJobId});
    await query("UPDATE video_generations SET stage_timings=stage_timings || jsonb_build_array(jsonb_build_object('stage','video_submitted','at',NOW())) WHERE id=$1",[genId]);
    await query(
      `UPDATE video_generations
       SET comfyui_workflow = COALESCE(comfyui_workflow,'{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [
        genId,
        JSON.stringify({
          workflow_variant: workflowVariant,
          music_comfyui_prompt_id: musicComfyPromptId,
          remote_video_job_id: remoteVidJobId,
          scene_count: scenes.length,
        }),
      ]
    );
  }

  let completedVidJob: any = null;
  const vidStart = Date.now();
  let videoPollErrors=0;
  let progressSignature=""; let lastProgressAt=Date.now();
  while (Date.now() - vidStart < 120 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 4000));
    const stResp = await workerFetch(`${videoEp.endpoint_url}/v1/video/jobs/${remoteVidJobId}`, {
      headers: { Authorization: `Bearer ${videoApiKey}` },
    });
    if (!stResp.ok) {
      if (stResp.status===404 || ++videoPollErrors>=10) throw new Error(`Video worker job unavailable: HTTP ${stResp.status}`);
      continue;
    }
    videoPollErrors=0;
    const jd: any = await stResp.json();
    const signature=JSON.stringify([jd.stage,jd.progress,jd.node_id,jd.step,jd.last_progress_at]);
    if(signature!==progressSignature) {progressSignature=signature;lastProgressAt=Date.now();}
    if(Date.now()-lastProgressAt>15*60*1000 && !String(jd.stage).includes('queued')) throw new Error('Video worker stalled: no node, step or stage progress for 15 minutes');
    if (jd.status === 'completed') {
      completedVidJob = jd;
      break;
    }
    if (jd.status === 'failed') {
      throw new Error(`MiniMax H3 Ref2VA ComfyUI failure: ${jd.error || 'Unknown error'}`);
    }
    const mappedPct = Math.min(94, 42 + Math.round((Number(jd.progress || 0) / 100) * 52));
    await updateVideoStage(
      genId,
      'generating_video',
      `ComfyUI: ${String(jd.stage || 'rendering').replace(/_/g, ' ')}${jd.node_id ? ' · node '+jd.node_id : ''}${jd.step_max ? ' · step '+jd.step+'/'+jd.step_max : ''}`,
      mappedPct
    );
  }

  if (!completedVidJob) {
    throw new Error('Timed out waiting for MiniMax H3 Ref2VA multi-scene video render');
  }

  const mp4Resp = await workerFetch(`${videoEp.endpoint_url}/v1/video/jobs/${remoteVidJobId}/video`, {
    headers: { Authorization: `Bearer ${videoApiKey}` },
  });
  if (!mp4Resp.ok) {
    throw new Error(`Failed downloading rendered MP4 (${mp4Resp.status})`);
  }

  const videosDir = path.join(dataDir, 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  const videoFileName = `${genId}.mp4`;
  const videoFilePath = path.join(videosDir, videoFileName);
  await updateVideoStage(genId,'rendering_final','Saving rendered video to persistent storage',96);
  await gpuEvent('minimax_h3_ref2va','SAVING',{job_id:genId});
  fs.writeFileSync(videoFilePath, Buffer.from(await mp4Resp.arrayBuffer()),{flush:true});

  if (opts.musicPromise) {
    await updateVideoStage(genId,'rendering_final','Visual render complete; joining original music and validating output',95);
    const music=await opts.musicPromise;
    musicFilePath=music.filePath;musicComfyPromptId=music.comfyPromptId;
    await query('UPDATE video_generations SET music_track_id=$2 WHERE id=$1',[genId,music.trackId]);
  }
  if (musicFilePath) {
    const muxed=path.join(videosDir,`${genId}_mux.mp4`);
    await execFileAsync('ffmpeg',['-y','-v','error','-i',videoFilePath,'-i',musicFilePath,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-af','apad','-t',String(totalDurationSec),'-movflags','+faststart',muxed],{timeout:120000});
    const fd=fs.openSync(muxed,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(muxed,videoFilePath);
  }
  // Full decode test, not just an HTTP 200 or plausible filename.
  await execFileAsync('ffmpeg',['-v','error','-i',videoFilePath,'-f','null','-'],{timeout:120000,maxBuffer:1024*1024});

  let verifiedDuration = Number(completedVidJob.duration_sec || totalDurationSec);
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoFilePath,
    ]);
    const parsedDur = parseFloat(stdout.trim());
    if (!Number.isFinite(parsedDur) || parsedDur<=0) throw new Error("Invalid ffprobe duration");
    if (parsedDur > 0) {
      verifiedDuration = parsedDur;
    }
  } catch(e:any) {throw new Error('Cannot verify actual rendered duration: '+e.message);}
  const [durationPolicy]=await query<any>('SELECT min_duration_sec FROM video_generations WHERE id=$1',[genId]);
  const minimum=Number(durationPolicy?.min_duration_sec || 20);
  assertActualVideoDuration(verifiedDuration,minimum);

  await execFileAsync('ffmpeg',['-v','error','-i',videoFilePath,'-f','null','-'],{timeout:120000});

  const thumbFileName = `${genId}_thumb.jpg`;
  const thumbFilePath = path.join(videosDir, thumbFileName);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-ss', '1.5', '-i', videoFilePath,
      '-frames:v', '1', '-q:v', '3', thumbFilePath,
    ]);
  } catch {}

  const tempDir = path.join(dataDir, 'temp', genId);
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const expiresAt = autoDeleteEnabled ? new Date(Date.now() + 72 * 3600 * 1000).toISOString() : null;
  const combinedWorkflowMeta = {
    workflow_variant: workflowVariant,
    music_comfyui_prompt_id: musicComfyPromptId,
    video_comfyui_prompt_ids: completedVidJob.comfyui_prompt_ids || [],
    remote_video_job_id: remoteVidJobId,
    character_references: ['scarlett_ref_1.jpg', 'scarlett_identity_face.png (unaltered crop of ref_3)', 'scarlett_ref_2.jpg'],
    quality_profile: completedVidJob.quality_profile || 'legacy',
    sampling: completedVidJob.sampling || null,
    timings: completedVidJob.timings || null,
    scene_count: scenes.length,
    native_resolution: [320,576],
    sampling_steps:4,
    render_metrics:{created_at:completedVidJob.created_at,completed_at:completedVidJob.completed_at,node_events:completedVidJob.node_events || []},
  };

  await query(
    `UPDATE video_generations
     SET status = 'completed',
         current_stage = 'Completed — Ready to Stream',
         progress = 100,
         video_file_name = $2,
         thumbnail_file_name = $3,
         duration_sec = $4,
         width = 720,
         height = 1280,
         comfyui_workflow = $5::jsonb,
         comfyui_prompt_ids = $6::jsonb,
         expires_at = $7,
         completed_at = NOW(),
         last_activity_at = NOW(),
         stage_timings=stage_timings || jsonb_build_array(jsonb_build_object('stage','completed','at',NOW(),'progress',100))
     WHERE id = $1`,
    [
      genId,
      videoFileName,
      fs.existsSync(thumbFilePath) ? thumbFileName : '',
      verifiedDuration,
      JSON.stringify(combinedWorkflowMeta),
      JSON.stringify(completedVidJob.comfyui_prompt_ids || []),
      expiresAt,
    ]
  );

  const playback=await workerFetch(`https://aivideo.aivideo.blitz.cloud/media/videos/${videoFileName}`,{headers:{Range:'bytes=0-4095'}});
  if(!playback.ok) throw new Error(`Saved video is not publicly accessible: ${playback.status}`);
  const remotePrefix=Buffer.from(await playback.arrayBuffer()).subarray(0,4096);
  if(!remotePrefix.equals(fs.readFileSync(videoFilePath).subarray(0,4096))) throw new Error('Persistent playback bytes mismatch');
  await acknowledgeGpuOutput('minimax_h3_ref2va',remoteVidJobId,{sha256:crypto.createHash('sha256').update(fs.readFileSync(videoFilePath)).digest('hex'),bytes:fs.statSync(videoFilePath).size,playable:true,file:videoFileName});
  await releaseGpuJob(genId);
  await generateSocialMetadata(genId, dataDir).catch((e) => console.error('[Post-render captions]', genId, e.message));

  if (scheduleId) {
    await query(
      `UPDATE automation_schedules SET completed_count = completed_count + 1, last_generation_id = $2, updated_at = NOW() WHERE id = $1`,
      [scheduleId, genId]
    );
  }
}

export async function recoverInFlightGenerations(dataDir: string): Promise<void> {
  // Creation time is not a liveness signal: a queued render may be old but healthy.
  const inflight = await query<any>(
    `SELECT * FROM video_generations WHERE status IN ('reasoning','generating_music','generating_video','rendering_final')`
  );
  for (const row of inflight) {
    if (ACTIVE_IN_MEMORY_JOBS.has(row.id)) continue;
    if (row.status==='reasoning') {
      if(Date.now()-new Date(row.last_activity_at).getTime()>10*60*1000) await query("UPDATE video_generations SET status='failed',error_message='Planning interrupted before worker submission; please retry' WHERE id=$1",[row.id]);
      continue;
    }
    ACTIVE_IN_MEMORY_JOBS.add(row.id);
    (async () => {
      try {
        const wf = row.comfyui_workflow || {};
        const scenes = Array.isArray(row.scene_plan) ? row.scene_plan : [];
        const totalDur = scenes.reduce((a: number, s: any) => a + Number(s.duration_sec || 7.5), 0) || 23;
        let musicFilePath = '';
        let musicComfyPromptId = wf.music_comfyui_prompt_id || '';

        if (!row.music_track_id && row.music_prompt) {
          const mRes = await executeMusicGenerationOnComfyUI({
            dataDir,
            title: row.title || 'Scarlett Fusion',
            bpm: 112,
            musicalKey: 'F minor',
            vocalHook: row.vocal_hook || '',
            songStructure: ['[Intro]', '[Verse]', '[Chorus]', '[Instrumental]', '[Bridge]', '[Outro]'],
            captionPrompt: row.music_prompt || '',
            lyrics: row.lyrics || '',
            audioCharacteristics: row.audio_characteristics || {},
            durationSec: totalDur + 0.8,
            similarityScore: Number(row.similarity_score || 0),
            parentVideoGenId: row.id,
            existingRemoteJobId: wf.remote_music_job_id,
          });
          musicFilePath = mRes.filePath;
          musicComfyPromptId = mRes.comfyPromptId;
          await updateVideoStage(
            row.id,
            'generating_video',
            'Layer 2 (Joshbond123): ComfyUI + MiniMax H3 Ref2VA rendering seamless multi-scene Scarlett Monroe video...',
            42,
            ', music_track_id = $5',
            [mRes.trackId]
          );
        } else if (row.music_track_id) {
          const tr = await query<any>(`SELECT * FROM music_tracks WHERE id = $1`, [row.music_track_id]);
          if (tr[0]?.file_name) {
            musicFilePath = path.join(dataDir, 'music', path.basename(tr[0].file_name));
            musicComfyPromptId = musicComfyPromptId || tr[0].comfyui_prompt_id || '';
          }
        }

        await executeAndFinalizeH3Video({
          genId: row.id,
          dataDir,
          scenes,
          totalDurationSec: totalDur,
          workflowVariant: wf.workflow_variant || 'comfyui_h3_ref2va_continuous_choreo',
          musicFilePath,
          musicComfyPromptId,
          autoDeleteEnabled: Boolean(row.auto_delete_enabled),
          scheduleId: row.schedule_id || null,
          existingRemoteVidJobId: wf.remote_video_job_id || undefined,
        });
        console.log(`[Recovery] Successfully recovered & finalized generation ${row.id}`);
      } catch (err: any) {
        console.error(`[Recovery] Generation ${row.id} failed:`, err);
        await query(
          `UPDATE video_generations SET status = 'failed', current_stage = 'Failed', error_message = $2 WHERE id = $1`,
          [row.id, err?.message || String(err)]
        );
      } finally {
        await releaseGpuJob(row.id);
        ACTIVE_IN_MEMORY_JOBS.delete(row.id);
      }
    })();
  }

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
