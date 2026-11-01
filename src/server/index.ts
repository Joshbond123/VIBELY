import crypto from 'crypto';
import { generateSocialMetadata } from './socialMetadata.js';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbConnected, dbError, initDatabase, query } from './db.js';
import {
  ensurePersistentReferences,
  SCARLETT_CONTENT_SERIES,
  SCARLETT_NEGATIVE_PROMPT,
  SCARLETT_PERMANENT_IDENTITY_PROMPT,
  selectWeightedSeries,
} from './scarlettIdentity.js';
import {
  launchVideoGenerationPipeline,
  probeWorkerHealth,
  startStandaloneMusicTask,
  syncKaggleEndpointsAndHealth,
} from './comfyOrchestrator.js';
import {
  computeNextRunAt,
  runAutomaticVideoDeletionSweep,
  runDueSchedulesTick,
  setAutoDeletePolicy,
  startBackgroundDaemons,
} from './schedulerAndRetention.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = process.env.DATA_DIR || path.join(REPO_ROOT, 'data');

fs.mkdirSync(path.join(DATA_DIR, 'references'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'videos'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'music'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'temp'), { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Persistent media static mounts (Express sendFile supports HTTP Range requests natively for MP4/MP3!)
app.use('/media/references', express.static(path.join(DATA_DIR, 'references'), { maxAge: '7d' }));
app.use('/media/videos', express.static(path.join(DATA_DIR, 'videos')));
app.use('/media/music', express.static(path.join(DATA_DIR, 'music')));

// Health & System Status
app.get('/api/health', async (_req, res) => {
  try {
    const refs = ensurePersistentReferences(DATA_DIR, REPO_ROOT);
    const models = dbConnected ? await query(`SELECT * FROM model_endpoints ORDER BY service_id ASC`) : [];
    const settings = dbConnected ? await query(`SELECT * FROM app_settings`) : [];
    res.json({
      ok: true,
      app: 'VIBELY',
      timestamp: new Date().toISOString(),
      database: { connected: dbConnected, error: dbError || null },
      nvidia_reasoning: {
        configured: Boolean(process.env.NVIDIA_API_KEY),
        primary_model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        fallback_model: 'nvidia/nemotron-3-ultra-550b-a55b',
      },
      comfyui_orchestration: {
        framework: 'ComfyUI + molbal/ComfyUI-GGUF',
        workflows: ['minimax_music3_q4_0_gguf.json', 'minimax_h3_ref2va_multiscene.json'],
      },
      character_references: {
        character: 'Scarlett Monroe',
        count: refs.length,
        all_verified: refs.every((r) => r.verified),
      },
      models: models.map(sanitizeModelRow),
      settings: Object.fromEntries(settings.map((s: any) => [s.key, s.value])),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Dashboard Overview
app.get('/api/overview', async (_req, res) => {
  try {
    const models = await query(`SELECT * FROM model_endpoints ORDER BY service_id ASC`);
    const videos = await query(
      `SELECT * FROM video_generations ORDER BY created_at DESC LIMIT 20`
    );
    const tracks = await query(
      `SELECT * FROM music_tracks ORDER BY created_at DESC LIMIT 12`
    );
    const schedules = await query(
      `SELECT * FROM automation_schedules ORDER BY created_at DESC`
    );
    const settingsRows = await query(`SELECT * FROM app_settings`);
    const settings = Object.fromEntries(settingsRows.map((s: any) => [s.key, s.value]));

    const counts = await query<any>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed' AND deleted_at IS NULL)::int AS active_videos,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_total,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_total,
        COUNT(*) FILTER (WHERE status NOT IN ('completed', 'failed'))::int AS running_total
      FROM video_generations
    `);

    const seriesDist = await query<any>(`
      SELECT content_series, COUNT(*)::int AS count
      FROM video_generations
      WHERE series_id != 'pending'
      GROUP BY content_series
    `);

    res.json({
      ok: true,
      stats: counts[0] || { total: 0, active_videos: 0, completed_total: 0, failed_total: 0, running_total: 0 },
      series_distribution: seriesDist,
      models: models.map(sanitizeModelRow),
      recent_videos: videos.map(formatVideoRow),
      recent_tracks: tracks.map(formatTrackRow),
      schedules: schedules.map(formatScheduleRow),
      settings,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Model Endpoint Heartbeat Registration (called by Kaggle GPU workers)
app.post('/api/models/register', async (req, res) => {
  try {
    const secret = req.header('X-Registry-Secret') || '';
    const expected = process.env.VIBELY_MODEL_REGISTRY_SECRET || '';
    if (expected && secret !== expected) {
      res.status(401).json({ ok: false, error: 'Invalid registry secret' });
      return;
    }

    const {
      service,
      username,
      model_name,
      endpoint_url,
      api_key,
      comfyui_ready,
      dataset_cached,
      storage_sources,
      character_refs,
      gpu_name,
    } = req.body || {};

    if (!service || !endpoint_url) {
      res.status(400).json({ ok: false, error: 'Missing service or endpoint_url' });
      return;
    }

    await query(
      `INSERT INTO model_endpoints
        (service_id, username, model_name, endpoint_url, api_key, status, comfyui_ready, dataset_cached, storage_sources, gpu_name, extra_meta, last_heartbeat_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,NOW(),NOW())
       ON CONFLICT (service_id) DO UPDATE SET
         endpoint_url = EXCLUDED.endpoint_url,
         api_key = CASE WHEN EXCLUDED.api_key != '' THEN EXCLUDED.api_key ELSE model_endpoints.api_key END,
         status = EXCLUDED.status,
         comfyui_ready = EXCLUDED.comfyui_ready,
         dataset_cached = EXCLUDED.dataset_cached,
         storage_sources = EXCLUDED.storage_sources,
         gpu_name = EXCLUDED.gpu_name,
         extra_meta = EXCLUDED.extra_meta,
         last_heartbeat_at = NOW(),
         updated_at = NOW()`,
      [
        service,
        username || '',
        model_name || service,
        String(endpoint_url).replace(/\/$/, ''),
        api_key || '',
        comfyui_ready ? 'online' : 'loading_models',
        Boolean(comfyui_ready),
        Boolean(dataset_cached),
        JSON.stringify(storage_sources || {}),
        String(gpu_name || ''),
        JSON.stringify({ character_refs: character_refs || [] }),
      ]
    );

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/models/sync', async (req, res) => {
  try {
    if (req.body?.service_id && req.body?.endpoint_url) {
      await probeWorkerHealth(req.body.service_id, req.body.endpoint_url);
    }
    const models = await syncKaggleEndpointsAndHealth();
    res.json({ ok: true, models: models.map(sanitizeModelRow) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Video Generation & Library Endpoints
app.get('/api/videos', async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    const rows = await query(
      includeDeleted
        ? `SELECT * FROM video_generations ORDER BY created_at DESC LIMIT 100`
        : `SELECT * FROM video_generations WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ ok: true, videos: rows.map(formatVideoRow) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM video_generations WHERE id = $1`, [req.params.id]);
    if (!rows[0]) {
      res.status(404).json({ ok: false, error: 'Video generation not found' });
      return;
    }
    res.json({ ok: true, video: formatVideoRow(rows[0]) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/videos/generate', async (req, res) => {
  try {
    const forceSeriesId = req.body?.series_id && req.body.series_id !== 'weighted_random' ? String(req.body.series_id) : undefined;
    const genId = await launchVideoGenerationPipeline({
      dataDir: DATA_DIR,
      triggerType: 'manual',
      forceSeriesId,
    });
    const rows = await query(`SELECT * FROM video_generations WHERE id = $1`, [genId]);
    res.json({ ok: true, generation_id: genId, video: formatVideoRow(rows[0]) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/videos/:id/social-metadata', async (req,res) => {
  try {
    const [row]=await query<any>("SELECT status FROM video_generations WHERE id=$1 AND deleted_at IS NULL",[req.params.id]);
    if(!row || row.status!=='completed') {res.status(409).json({ok:false,error:'Completed video required'});return;}
    await generateSocialMetadata(req.params.id,DATA_DIR);
    const [result]=await query<any>('SELECT * FROM video_generations WHERE id=$1',[req.params.id]);
    res.json({ok:true,video:formatVideoRow(result)});
  } catch(e:any) {res.status(502).json({ok:false,error:e.message});}
});

app.delete('/api/videos/:id', async (req, res) => {
  try {
    const rows = await query<any>(`SELECT * FROM video_generations WHERE id = $1`, [req.params.id]);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const videosDir = path.join(DATA_DIR, 'videos');
    for (const fn of [row.video_file_name, row.thumbnail_file_name]) {
      if (fn) {
        const fp = path.join(videosDir, path.basename(fn));
        if (fs.existsSync(fp)) {
          try {
            fs.unlinkSync(fp);
          } catch {}
        }
      }
    }
    await query(
      `UPDATE video_generations
       SET deleted_at = NOW(), video_file_name = '', thumbnail_file_name = '', current_stage = 'Manually deleted by user'
       WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Music Studio Endpoints
app.get('/api/music', async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM music_tracks ORDER BY created_at DESC LIMIT 60`);
    res.json({ ok: true, tracks: rows.map(formatTrackRow) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/music/generate', async (req, res) => {
  try {
    const track = await startStandaloneMusicTask(DATA_DIR, req.body?.theme);
    res.json({ ok: true, track: formatTrackRow(track) });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.delete('/api/music/:id', async (req, res) => {
  try {
    const rows = await query<any>(`SELECT * FROM music_tracks WHERE id = $1`, [req.params.id]);
    if (rows[0]?.file_name) {
      const fp = path.join(DATA_DIR, 'music', path.basename(rows[0].file_name));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await query(`DELETE FROM music_tracks WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Automations & Persistent Scheduling Endpoints
app.get('/api/automations', async (_req, res) => {
  try {
    const schedules = await query(`SELECT * FROM automation_schedules ORDER BY created_at DESC`);
    const scheduledTasks = await query(
      `SELECT * FROM video_generations WHERE trigger_type = 'scheduled' ORDER BY created_at DESC LIMIT 40`
    );
    res.json({
      ok: true,
      schedules: schedules.map(formatScheduleRow),
      scheduled_tasks: scheduledTasks.map(formatVideoRow),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/automations', async (req, res) => {
  try {
    const {
      name = 'Scarlett Daily Drop',
      frequency = 'daily',
      preferred_time = '14:00',
      timezone = 'Africa/Lagos',
      interval_minutes = 1440,
      series_mode = 'weighted_random',
      run_at_iso,
    } = req.body || {};

    const id = 'sch_' + crypto.randomUUID().slice(0, 10);
    const nextRun = run_at_iso
      ? new Date(run_at_iso)
      : computeNextRunAt(frequency, preferred_time, new Date(), Number(interval_minutes || 60));

    await query(
      `INSERT INTO automation_schedules
        (id, name, frequency, preferred_time, timezone, interval_minutes, status, enabled, series_mode, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',TRUE,$7,$8)`,
      [id, name, frequency, preferred_time, timezone, Number(interval_minutes || 1440), series_mode, nextRun.toISOString()]
    );

    const rows = await query(`SELECT * FROM automation_schedules WHERE id = $1`, [id]);
    res.json({ ok: true, schedule: rows[0] });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.patch('/api/automations/:id', async (req, res) => {
  try {
    const { action, frequency, preferred_time, name, interval_minutes, run_at_iso } = req.body || {};
    const rows = await query<any>(`SELECT * FROM automation_schedules WHERE id = $1`, [req.params.id]);
    const current = rows[0];
    if (!current) {
      res.status(404).json({ ok: false, error: 'Schedule not found' });
      return;
    }

    let enabled = current.enabled;
    let status = current.status;
    let nextRun = new Date(current.next_run_at);

    if (action === 'pause') {
      status = 'paused';
      enabled = false;
    } else if (action === 'resume' || action === 'enable') {
      status = 'active';
      enabled = true;
      if (nextRun.getTime() <= Date.now()) {
        nextRun = computeNextRunAt(frequency || current.frequency, preferred_time || current.preferred_time, new Date(), interval_minutes || current.interval_minutes);
      }
    } else if (action === 'disable') {
      status = 'disabled';
      enabled = false;
    }

    if (run_at_iso) {
      nextRun = new Date(run_at_iso);
    } else if (frequency || preferred_time || interval_minutes) {
      nextRun = computeNextRunAt(
        frequency || current.frequency,
        preferred_time || current.preferred_time,
        new Date(),
        Number(interval_minutes || current.interval_minutes)
      );
    }

    await query(
      `UPDATE automation_schedules
       SET name = $2,
           frequency = $3,
           preferred_time = $4,
           interval_minutes = $5,
           status = $6,
           enabled = $7,
           next_run_at = $8,
           updated_at = NOW()
       WHERE id = $1`,
      [
        req.params.id,
        name || current.name,
        frequency || current.frequency,
        preferred_time || current.preferred_time,
        Number(interval_minutes || current.interval_minutes),
        status,
        enabled,
        nextRun.toISOString(),
      ]
    );

    const updated = await query(`SELECT * FROM automation_schedules WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, schedule: updated[0] });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/automations/tick', async (_req, res) => {
  try {
    const count = await runDueSchedulesTick(DATA_DIR);
    res.json({ ok: true, triggered: count });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.delete('/api/automations/:id', async (req, res) => {
  try {
    await query(`DELETE FROM automation_schedules WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Character References & Weighted Series Verification
app.get('/api/character', async (req, res) => {
  try {
    const refs = ensurePersistentReferences(DATA_DIR, REPO_ROOT);
    const sampleRuns = Number(req.query.simulate || 0);
    let simulation: Record<string, number> | undefined;
    if (sampleRuns > 0 && sampleRuns <= 10000) {
      simulation = {};
      for (let i = 0; i < sampleRuns; i++) {
        const s = selectWeightedSeries();
        simulation[s.name] = (simulation[s.name] || 0) + 1;
      }
    }
    res.json({
      ok: true,
      character_name: 'Scarlett Monroe',
      age: 25,
      signature_genre: 'Amapiano + Afrobeats Fusion',
      references: refs,
      content_series: SCARLETT_CONTENT_SERIES,
      permanent_identity_instruction: SCARLETT_PERMANENT_IDENTITY_PROMPT,
      negative_prompt: SCARLETT_NEGATIVE_PROMPT,
      simulation,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Generation History & ComfyUI Workflows
app.get('/api/history', async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM video_generations ORDER BY created_at DESC LIMIT 100`);
    const musicWorkflow = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'comfyui_workflows', 'minimax_music3_q4_0_gguf.json'), 'utf8')
    );
    const videoWorkflow = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'comfyui_workflows', 'minimax_h3_ref2va_multiscene.json'), 'utf8')
    );
    res.json({
      ok: true,
      history: rows.map(formatVideoRow),
      canonical_workflows: {
        music: musicWorkflow,
        video: videoWorkflow,
      },
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Settings & Automatic Video Deletion Controls
app.get('/api/settings', async (_req, res) => {
  try {
    const rows = await query(`SELECT * FROM app_settings`);
    res.json({
      ok: true,
      settings: Object.fromEntries(rows.map((r: any) => [r.key, r.value])),
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.put('/api/settings/auto-delete', async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await setAutoDeletePolicy(enabled, DATA_DIR);
    const rows = await query(`SELECT * FROM app_settings WHERE key = 'auto_delete'`);
    res.json({ ok: true, auto_delete: rows[0]?.value });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/settings/cleanup', async (_req, res) => {
  try {
    const result = await runAutomaticVideoDeletionSweep(DATA_DIR);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/settings/seed-expired-test-artifact', async (req, res) => {
  try {
    const secret = req.headers['x-registry-secret'];
    if (!process.env.VIBELY_MODEL_REGISTRY_SECRET || secret !== process.env.VIBELY_MODEL_REGISTRY_SECRET) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    const testId = 'vid_ret_test_' + crypto.randomUUID().slice(0, 8);
    const videosDir = path.join(DATA_DIR, 'videos');
    const tempDir = path.join(DATA_DIR, 'temp', testId);
    fs.mkdirSync(videosDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    const vFile = `${testId}.mp4`;
    const tFile = `${testId}_thumb.jpg`;
    const staleTmp = path.join(tempDir, 'scratch.tmp');
    fs.writeFileSync(path.join(videosDir, vFile), Buffer.alloc(4096, 0x42));
    fs.writeFileSync(path.join(videosDir, tFile), Buffer.alloc(1024, 0xff));
    fs.writeFileSync(staleTmp, 'stale-temp-artifact');
    const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(tempDir, threeHoursAgo, threeHoursAgo);
    fs.utimesSync(staleTmp, threeHoursAgo, threeHoursAgo);

    await query(
      `INSERT INTO video_generations
        (id, trigger_type, status, current_stage, progress, content_series, series_id, title, video_concept, video_file_name, thumbnail_file_name, duration_sec, auto_delete_enabled, created_at, completed_at, expires_at)
       VALUES ($1, 'manual', 'completed', 'Completed — Ready to Stream', 100, 'THE BOUNCE DANCE', 'bounce_dance', 'Retention Policy 72h Verification Fixture', 'Automated 72h retention verification record', $2, $3, 24.0, TRUE, NOW() - INTERVAL '73 hours', NOW() - INTERVAL '73 hours', NOW() - INTERVAL '1 hour')`,
      [testId, vFile, tFile]
    );
    res.json({ ok: true, test_id: testId, video_file: vFile, thumb_file: tFile });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

function sanitizeModelRow(m: any) {
  if (!m) return null;
  const { api_key, ...rest } = m;
  return { ...rest, auth_configured: Boolean(api_key) };
}

function getFileSizeSafe(fp: string): number {
  try {
    return fs.existsSync(fp) ? fs.statSync(fp).size : 0;
  } catch {
    return 0;
  }
}

function formatScheduleRow(s: any) {
  if (!s) return null;
  return {
    ...s,
    fail_count: Number(s.failed_count ?? s.fail_count ?? 0),
  };
}

function formatVideoRow(r: any) {
  if (!r) return null;
  const videoSize = r.video_file_name
    ? getFileSizeSafe(path.join(DATA_DIR, 'videos', path.basename(r.video_file_name)))
    : 0;
  const scenes = Array.isArray(r.scene_plan)
    ? r.scene_plan.map((sc: any) => ({
        ...sc,
        shot_framing: sc.shot_framing || sc.camera_position_and_movement || '',
        camera_movement: sc.camera_movement || sc.camera_position_and_movement || '',
        transition_to_next: sc.transition_to_next || sc.transition_instruction || '',
      }))
    : [];
  return {
    ...r,
    visual_concept: r.video_concept || r.visual_concept || '',
    storyline: r.script || r.storyline || '',
    script_summary: r.script || '',
    outfit_styling: r.outfit_descriptions || r.outfit_styling || '',
    location_setting: r.location || r.location_setting || '',
    lighting_setup: r.lighting_cinematography || '',
    camera_plan: r.camera_instructions || r.camera_plan || '',
    choreography_summary: r.choreography || r.choreography_summary || '',
    scene_plan: scenes,
    duration_seconds: Number(r.duration_sec ?? r.duration_seconds ?? 0),
    auto_delete_eligible: Boolean(r.auto_delete_enabled ?? r.auto_delete_eligible ?? true),
    file_size_bytes: videoSize,
    video_url: r.video_file_name ? `/media/videos/${r.video_file_name}` : null,
    thumbnail_url: r.thumbnail_file_name ? `/media/videos/${r.thumbnail_file_name}` : null,
  };
}

function formatTrackRow(t: any) {
  if (!t) return null;
  const audioSize = t.file_name
    ? getFileSizeSafe(path.join(DATA_DIR, 'music', path.basename(t.file_name)))
    : 0;
  return {
    ...t,
    music_prompt: t.caption_prompt || t.music_prompt || '',
    duration_seconds: Number(t.duration_sec ?? t.duration_seconds ?? 0),
    file_size_bytes: audioSize,
    audio_url: t.file_name ? `/media/music/${t.file_name}` : null,
  };
}

// Serve built React SPA
const publicDir = path.join(REPO_ROOT, 'dist', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

const PORT = Number(process.env.PORT || 8080);

async function bootstrap() {
  ensurePersistentReferences(DATA_DIR, REPO_ROOT);
  await initDatabase();
  if (dbConnected) {
    startBackgroundDaemons(DATA_DIR);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VIBELY] Platform server listening on 0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('[VIBELY] Fatal startup error:', err);
  process.exit(1);
});
