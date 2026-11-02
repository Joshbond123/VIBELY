import pg from 'pg';

const { Pool } = pg;

export let pool: pg.Pool | null = null;
export let dbConnected = false;
export let dbError = '';

export async function initDatabase(): Promise<void> {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    dbConnected = false;
    dbError = 'DATABASE_URL not configured';
    console.warn('[DB] DATABASE_URL not set yet.');
    return;
  }

  pool = new Pool({
    connectionString: connStr,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: connStr.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        await runMigrations(client);
        dbConnected = true;
        dbError = '';
        console.log('[DB] PostgreSQL connected & schema verified.');
        return;
      } finally {
        client.release();
      }
    } catch (err: any) {
      dbError = err?.message || String(err);
      console.warn(`[DB] Connection attempt ${attempt}/8 failed: ${dbError}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

async function runMigrations(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS model_endpoints (
      service_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      model_name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'initializing',
      comfyui_ready BOOLEAN NOT NULL DEFAULT FALSE,
      dataset_cached BOOLEAN NOT NULL DEFAULT FALSE,
      storage_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
      gpu_name TEXT NOT NULL DEFAULT '',
      extra_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_heartbeat_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS music_tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      genre TEXT NOT NULL DEFAULT 'Amapiano + Afrobeats Fusion',
      bpm INTEGER NOT NULL DEFAULT 113,
      musical_key TEXT NOT NULL DEFAULT 'F minor',
      vocal_hook TEXT NOT NULL DEFAULT '',
      caption_prompt TEXT NOT NULL,
      lyrics TEXT NOT NULL,
      song_structure JSONB NOT NULL DEFAULT '[]'::jsonb,
      audio_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb,
      comfyui_prompt_id TEXT NOT NULL DEFAULT '',
      comfyui_workflow JSONB NOT NULL DEFAULT '{}'::jsonb,
      file_name TEXT NOT NULL DEFAULT '',
      duration_sec REAL NOT NULL DEFAULT 30,
      similarity_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS video_generations (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      schedule_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      current_stage TEXT NOT NULL DEFAULT 'Queued',
      progress INTEGER NOT NULL DEFAULT 0,
      content_series TEXT NOT NULL,
      series_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      video_concept TEXT NOT NULL DEFAULT '',
      script TEXT NOT NULL DEFAULT '',
      scene_plan JSONB NOT NULL DEFAULT '[]'::jsonb,
      choreography TEXT NOT NULL DEFAULT '',
      camera_instructions TEXT NOT NULL DEFAULT '',
      outfit_descriptions TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      lighting_cinematography TEXT NOT NULL DEFAULT '',
      expressions_poses TEXT NOT NULL DEFAULT '',
      music_track_id TEXT,
      music_prompt TEXT NOT NULL DEFAULT '',
      lyrics TEXT NOT NULL DEFAULT '',
      vocal_hook TEXT NOT NULL DEFAULT '',
      audio_characteristics JSONB NOT NULL DEFAULT '{}'::jsonb,
      comfyui_workflow JSONB NOT NULL DEFAULT '{}'::jsonb,
      comfyui_prompt_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      similarity_score REAL NOT NULL DEFAULT 0,
      regeneration_attempts INTEGER NOT NULL DEFAULT 0,
      video_file_name TEXT NOT NULL DEFAULT '',
      thumbnail_file_name TEXT NOT NULL DEFAULT '',
      duration_sec REAL NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 480,
      height INTEGER NOT NULL DEFAULT 832,
      fps INTEGER NOT NULL DEFAULT 24,
      auto_delete_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS social_caption TEXT NOT NULL DEFAULT '';
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS hashtags JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS caption_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS caption_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS caption_error TEXT;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS observed_content TEXT NOT NULL DEFAULT '';
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS quality_notes JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS caption_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS stage_timings JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS min_duration_sec REAL NOT NULL DEFAULT 20;
    CREATE TABLE IF NOT EXISTS gpu_sessions (
      service_id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'OFF', requested_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ, worker_started_at DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_shutdown_at TIMESTAMPTZ, session_status TEXT, error TEXT, telemetry JSONB, telemetry_at TIMESTAMPTZ
    );
    INSERT INTO gpu_sessions(service_id) VALUES('minimax_h3_ref2va'),('minimax_music_3') ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS gpu_leases(service_id TEXT NOT NULL,job_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(service_id,job_id));
    CREATE TABLE IF NOT EXISTS gpu_output_receipts(service_id TEXT NOT NULL,remote_job_id TEXT NOT NULL,endpoint_url TEXT NOT NULL,api_key TEXT NOT NULL,receipt JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),delivered_at TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(service_id,remote_job_id));
    CREATE TABLE IF NOT EXISTS gpu_events(id BIGSERIAL PRIMARY KEY,service_id TEXT NOT NULL,event TEXT NOT NULL,detail JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

    CREATE TABLE IF NOT EXISTS automation_schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'daily',
      preferred_time TEXT NOT NULL DEFAULT '12:00',
      timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
      interval_minutes INTEGER NOT NULL DEFAULT 1440,
      status TEXT NOT NULL DEFAULT 'active',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      series_mode TEXT NOT NULL DEFAULT 'weighted_random',
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      last_generation_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_video_gen_created ON video_generations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_video_gen_expires ON video_generations(expires_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON automation_schedules(next_run_at) WHERE enabled = TRUE AND status = 'active';
  `);

  // Seed default settings (Automatic Deletion ENABLED by default = 72h / 3 days!)
  await client.query(`
    INSERT INTO app_settings (key, value)
    VALUES
      ('auto_delete', '{"enabled": true, "retention_hours": 72}'::jsonb),
      ('generation_defaults', '{"duration_min_sec": 20, "duration_max_sec": 40, "target_duration_sec": 26, "aspect_ratio": "9:16", "width": 480, "height": 832, "reasoning_model": "nvidia/nemotron-3-ultra-550b-a55b"}'::jsonb)
    ON CONFLICT (key) DO NOTHING;
  `);

  // Seed the two persistent Kaggle GPU model endpoint rows
  await client.query(
    `
    INSERT INTO model_endpoints (service_id, username, model_name, api_key, status)
    VALUES
      ('minimax_music_3', 'happink', 'MiniMax Music 3 Q4_0 GGUF', $1, 'booting'),
      ('minimax_h3_ref2va', 'Joshbond123', 'MiniMax H3 Ref2VA', $2, 'booting')
    ON CONFLICT (service_id) DO NOTHING;
  `,
    [process.env.MINIMAX_MUSIC3_API_KEY || '', process.env.MINIMAX_H3_API_KEY || '']
  );
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (!pool) {
    throw new Error('PostgreSQL pool is not initialized');
  }
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
