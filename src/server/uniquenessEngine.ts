import { query } from './db.js';

export interface PlannedContentCandidate {
  title: string;
  videoConcept: string;
  script: string;
  choreography: string;
  outfitDescriptions: string;
  location: string;
  musicPrompt: string;
  lyrics: string;
  vocalHook: string;
}

export interface UniquenessCheckResult {
  isUnique: boolean;
  maxSimilarity: number;
  matchedGenerationId: string | null;
  reasons: string[];
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'scarlett', 'monroe',
  'her', 'she', 'scene', 'camera', 'shot', 'music', 'video', 'amapiano', 'afrobeats',
  'intro', 'verse', 'chorus', 'bridge', 'outro', 'instrumental', 'drop'
]);

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function buildTrigrams(tokens: string[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    set.add(tokens[i]);
    if (i + 1 < tokens.length) set.add(`${tokens[i]}_${tokens[i + 1]}`);
    if (i + 2 < tokens.length) set.add(`${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`);
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) {
    if (b.has(item)) inter++;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

export async function getRecentHistorySummary(limit = 20): Promise<{
  recentLocations: string[];
  recentOutfits: string[];
  recentHooks: string[];
  recentConcepts: string[];
  recentMusicalKeys: string[];
}> {
  try {
    const rows = await query<any>(
      `SELECT title, video_concept, location, outfit_descriptions, vocal_hook, audio_characteristics
       FROM video_generations
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    const tracks = await query<any>(
      `SELECT title, vocal_hook, bpm, musical_key
       FROM music_tracks
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return {
      recentLocations: rows.map((r) => r.location).filter(Boolean).slice(0, 12),
      recentOutfits: rows.map((r) => r.outfit_descriptions).filter(Boolean).slice(0, 12),
      recentHooks: [
        ...rows.map((r) => r.vocal_hook),
        ...tracks.map((t) => t.vocal_hook),
      ].filter(Boolean).slice(0, 15),
      recentConcepts: rows.map((r) => `${r.title}: ${r.video_concept}`).filter(Boolean).slice(0, 12),
      recentMusicalKeys: tracks.map((t) => `${t.bpm} BPM ${t.musical_key}`).filter(Boolean).slice(0, 10),
    };
  } catch {
    return {
      recentLocations: [],
      recentOutfits: [],
      recentHooks: [],
      recentConcepts: [],
      recentMusicalKeys: [],
    };
  }
}

export async function checkContentUniqueness(
  candidate: PlannedContentCandidate,
  threshold = 0.36
): Promise<UniquenessCheckResult> {
  const rows = await query<any>(
    `SELECT id, title, video_concept, script, choreography, outfit_descriptions, location, lyrics, vocal_hook
     FROM video_generations
     ORDER BY created_at DESC
     LIMIT 40`
  );

  const candVisualSet = buildTrigrams(
    tokenize(`${candidate.videoConcept} ${candidate.script} ${candidate.choreography} ${candidate.location} ${candidate.outfitDescriptions}`)
  );
  const candLyricSet = buildTrigrams(tokenize(`${candidate.vocalHook} ${candidate.lyrics}`));
  const normLoc = candidate.location.trim().toLowerCase();
  const normHook = candidate.vocalHook.trim().toLowerCase();

  let maxSim = 0;
  let matchedId: string | null = null;
  const reasons: string[] = [];

  for (const row of rows) {
    const rowVisualSet = buildTrigrams(
      tokenize(`${row.video_concept} ${row.script} ${row.choreography} ${row.location} ${row.outfit_descriptions}`)
    );
    const rowLyricSet = buildTrigrams(tokenize(`${row.vocal_hook} ${row.lyrics}`));

    const visSim = jaccardSimilarity(candVisualSet, rowVisualSet);
    const lyrSim = jaccardSimilarity(candLyricSet, rowLyricSet);
    const combined = visSim * 0.55 + lyrSim * 0.45;

    if (combined > maxSim) {
      maxSim = combined;
      matchedId = row.id;
    }

    if (visSim >= threshold) {
      reasons.push(`Visual concept/choreography too close to generation ${row.id} (${(visSim * 100).toFixed(1)}%)`);
    }
    if (lyrSim >= threshold) {
      reasons.push(`Song lyrics/hook too close to generation ${row.id} (${(lyrSim * 100).toFixed(1)}%)`);
    }
    if (normHook && row.vocal_hook && normHook === String(row.vocal_hook).trim().toLowerCase()) {
      maxSim = Math.max(maxSim, 0.85);
      matchedId = row.id;
      reasons.push(`Exact vocal hook collision with generation ${row.id}`);
    }
    if (normLoc && row.location && normLoc === String(row.location).trim().toLowerCase()) {
      reasons.push(`Exact location repeat with recent generation ${row.id}`);
      maxSim = Math.max(maxSim, threshold + 0.02);
    }
  }

  return {
    isUnique: maxSim < threshold && reasons.length === 0,
    maxSimilarity: Number(maxSim.toFixed(4)),
    matchedGenerationId: matchedId,
    reasons: Array.from(new Set(reasons)).slice(0, 4),
  };
}

export async function checkStandaloneMusicUniqueness(
  lyrics: string,
  vocalHook: string,
  caption: string,
  threshold = 0.34
): Promise<{ isUnique: boolean; maxSimilarity: number }> {
  const tracks = await query<any>(
    `SELECT id, vocal_hook, lyrics, caption_prompt FROM music_tracks ORDER BY created_at DESC LIMIT 40`
  );
  const candSet = buildTrigrams(tokenize(`${vocalHook} ${lyrics}`));
  let maxSim = 0;
  for (const t of tracks) {
    const tSet = buildTrigrams(tokenize(`${t.vocal_hook} ${t.lyrics}`));
    const sim = jaccardSimilarity(candSet, tSet);
    if (sim > maxSim) maxSim = sim;
    if (vocalHook && t.vocal_hook && vocalHook.trim().toLowerCase() === String(t.vocal_hook).trim().toLowerCase()) {
      maxSim = Math.max(maxSim, 0.85);
    }
  }
  return { isUnique: maxSim < threshold, maxSimilarity: Number(maxSim.toFixed(4)) };
}
