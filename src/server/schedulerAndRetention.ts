import {launchVideoGenerationPipeline,recoverNvidiaGenerations} from './nvidiaVideoPipeline.js';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { query } from './db.js';
import { gpuLifecycleTick } from './gpuLifecycle.js';
import { recoverSocialMetadata } from './socialMetadata.js';
import { syncKaggleEndpointsAndHealth, recoverInFlightGenerations } from './comfyOrchestrator.js';

let schedulerRunning = false;
let socialRecoveryStarted=false;

export function computeNextRunAt(frequency: string, preferredTime: string, fromDate = new Date(), customMinutes = 60): Date {
  const [hhStr, mmStr] = (preferredTime || '12:00').split(':');
  const hh = Math.min(23, Math.max(0, parseInt(hhStr || '12', 10) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(mmStr || '0', 10) || 0));

  if (frequency === 'hourly') {
    return new Date(fromDate.getTime() + 3600 * 1000);
  }
  if (frequency === 'every_6_hours' || frequency === 'every_6h') {
    return new Date(fromDate.getTime() + 6 * 3600 * 1000);
  }
  if (frequency === 'every_12_hours') {
    return new Date(fromDate.getTime() + 12 * 3600 * 1000);
  }
  if (frequency === 'custom_interval' || frequency === 'interval') {
    const mins = Math.max(1, customMinutes || 60);
    return new Date(fromDate.getTime() + mins * 60 * 1000);
  }
  if (frequency === 'once') {
    const target = new Date(fromDate);
    target.setUTCHours(hh, mm, 0, 0);
    if (target.getTime() <= fromDate.getTime()) {
      // If preferred HH:MM is within the next few minutes or user passed exact upcoming minute, allow immediate next minute if close, else tomorrow
      target.setUTCDate(target.getUTCDate() + 1);
    }
    return target;
  }

  // daily, twice_daily, weekly (interpreted in Africa/Lagos UTC+1 by subtracting 1h to UTC)
  const utcHour = (hh - 1 + 24) % 24;
  const candidate = new Date(fromDate);
  candidate.setUTCHours(utcHour, mm, 0, 0);

  if (frequency === 'twice_daily') {
    const secondUtcHour = (utcHour + 12) % 24;
    const cand2 = new Date(fromDate);
    cand2.setUTCHours(secondUtcHour, mm, 0, 0);
    const future = [candidate, cand2]
      .map((d) => (d.getTime() <= fromDate.getTime() ? new Date(d.getTime() + 24 * 3600 * 1000) : d))
      .sort((a, b) => a.getTime() - b.getTime());
    return future[0];
  }

  if (candidate.getTime() <= fromDate.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + (frequency === 'weekly' ? 7 : 1));
  }
  return candidate;
}

export async function runDueSchedulesTick(dataDir: string): Promise<number> {
  if (schedulerRunning) return 0;
  schedulerRunning = true;
  let triggered = 0;
  try {
    const dueRows = await query<any>(
      `SELECT * FROM automation_schedules
       WHERE enabled = TRUE AND status = 'active' AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       LIMIT 3`
    );

    for (const sched of dueRows) {
      triggered++;
      const isOnce = sched.frequency === 'once';
      const nextRun = isOnce
        ? new Date(Date.now() + 365 * 24 * 3600 * 1000)
        : computeNextRunAt(sched.frequency, sched.preferred_time, new Date(), sched.interval_minutes);

      await query(
        `UPDATE automation_schedules
         SET last_run_at = NOW(),
             next_run_at = $2,
             run_count = run_count + 1,
             enabled = $3,
             status = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [sched.id, nextRun.toISOString(), !isOnce, isOnce ? 'completed_once' : 'active']
      );

      const forceSeriesId = sched.series_mode && sched.series_mode !== 'weighted_random' ? sched.series_mode : undefined;
      const genId = await launchVideoGenerationPipeline({
        dataDir,
        triggerType: 'scheduled',
        scheduleId: sched.id,
        forceSeriesId,
      });

      await query(`UPDATE automation_schedules SET last_generation_id = $2 WHERE id = $1`, [sched.id, genId]);
      console.log(`[Scheduler] Triggered scheduled generation ${genId} for schedule "${sched.name}" (${sched.id})`);
    }
  } catch (err: any) {
    console.warn('[Scheduler] Tick warning:', err?.message || err);
  } finally {
    schedulerRunning = false;
  }
  return triggered;
}

export async function runAutomaticVideoDeletionSweep(dataDir: string): Promise<{
  autoDeleteEnabled: boolean;
  expiredVideosDeleted: number;
  tempFilesCleaned: number;
}> {
  let expiredVideosDeleted = 0;
  let tempFilesCleaned = 0;

  // Always clean stale temporary artifacts (>2h old) in /app/data/temp without touching references/models!
  const tempRoot = path.join(dataDir, 'temp');
  if (fs.existsSync(tempRoot)) {
    const cutoff = Date.now() - 2 * 3600 * 1000;
    for (const entry of fs.readdirSync(tempRoot)) {
      const full = path.join(tempRoot, entry);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          tempFilesCleaned++;
        }
      } catch {}
    }
  }

  const setRows = await query<{ value: any }>(`SELECT value FROM app_settings WHERE key = 'auto_delete'`);
  const autoDeleteEnabled = setRows[0]?.value?.enabled !== false;
  if (!autoDeleteEnabled) {
    return { autoDeleteEnabled: false, expiredVideosDeleted: 0, tempFilesCleaned };
  }

  const expiredRows = await query<any>(
    `SELECT id, video_file_name, thumbnail_file_name
     FROM video_generations
     WHERE deleted_at IS NULL
       AND status = 'completed'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`
  );

  for (const row of expiredRows) {
    const videosDir = path.join(dataDir, 'videos');
    for (const fn of [row.video_file_name, row.thumbnail_file_name, `${row.id}_visual.mp4`]) {
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
       SET deleted_at = NOW(),
           video_file_name = '',
           thumbnail_file_name = '',
           current_stage = 'Auto-deleted after 72h retention policy'
       WHERE id = $1`,
      [row.id]
    );
    expiredVideosDeleted++;
  }

  return {
    autoDeleteEnabled: true,
    expiredVideosDeleted,
    tempFilesCleaned,
    deletedCount: expiredVideosDeleted,
    tempFilesRemoved: tempFilesCleaned,
  } as any;
}

export async function setAutoDeletePolicy(enabled: boolean, dataDir: string) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('auto_delete', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify({ enabled, retention_hours: 72 })]
  );

  if (!enabled) {
    // Preserve all existing non-deleted videos until manually deleted
    await query(
      `UPDATE video_generations
       SET auto_delete_enabled = FALSE, expires_at = NULL
       WHERE deleted_at IS NULL`
    );
  } else {
    // Re-enable 72-hour expiration window from creation timestamp (or minimum 5m grace if already older unless sweep runs)
    await query(
      `UPDATE video_generations
       SET auto_delete_enabled = TRUE,
           expires_at = COALESCE(completed_at, created_at) + INTERVAL '72 hours'
       WHERE deleted_at IS NULL AND status = 'completed'`
    );
    await runAutomaticVideoDeletionSweep(dataDir);
  }
}

export function startBackgroundDaemons(dataDir: string): void {
  if(!socialRecoveryStarted) {
    socialRecoveryStarted=true;
    setInterval(()=>{gpuLifecycleTick().catch(e=>console.error('[GPU lifecycle]',e.message));},15000);
    setInterval(()=>{recoverSocialMetadata(dataDir).catch(e=>console.error('[Caption retry]',e.message));},120000);
  }

  // Poll due schedules every 20 seconds (persistent DB-backed, independent of browser sessions)
  cron.schedule('*/20 * * * * *', () => {
    runDueSchedulesTick(dataDir).catch(() => {});
  });

  // Run 72-hour automatic deletion & temp cleanup every 2 minutes
  cron.schedule('*/2 * * * *', () => {
    runAutomaticVideoDeletionSweep(dataDir).catch(() => {});
  });

  // Sync Kaggle GPU endpoints & recover any container-interrupted in-flight jobs every 60 seconds
  cron.schedule('* * * * *', () => {
    syncKaggleEndpointsAndHealth().catch(() => {});
    recoverInFlightGenerations(dataDir).catch(() => {});
    recoverNvidiaGenerations(dataDir).catch(() => {});
  });

  // Immediate startup check
  setTimeout(() => {
    syncKaggleEndpointsAndHealth().catch(() => {});
    recoverInFlightGenerations(dataDir).catch(() => {});
    recoverNvidiaGenerations(dataDir).catch(() => {});
    runDueSchedulesTick(dataDir).catch(() => {});
    runAutomaticVideoDeletionSweep(dataDir).catch(() => {});
  }, 3000);
}
