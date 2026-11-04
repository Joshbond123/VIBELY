import {planVideoFrames} from './videoDuration.js';
import crypto from 'crypto';
import {
  ContentSeriesSpec,
  SCARLETT_CONTENT_SERIES,
  SCARLETT_NEGATIVE_PROMPT,
  SCARLETT_PERMANENT_IDENTITY_PROMPT,
  selectWeightedSeries,
} from './scarlettIdentity.js';
import {
  checkContentUniqueness,
  checkStandaloneMusicUniqueness,
  getRecentHistorySummary,
} from './uniquenessEngine.js';

export interface SceneProductionSpec {
  scene_number: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  frame_count: number;
  story_beat: string;
  character_position_and_movement: string;
  choreography: string;
  camera_position_and_movement: string;
  environment_and_lighting: string;
  outfit_state: string;
  music_beat_sync: string;
  entry_pose: string;
  exit_pose: string;
  transition_instruction: string;
  comfy_prompt: string;
}

export interface MusicPlanSpec {
  title: string;
  genre: string;
  bpm: number;
  musical_key: string;
  vocal_hook: string;
  song_structure: string[];
  caption_prompt: string;
  lyrics: string;
  audio_characteristics: {
    log_drum_pattern: string;
    afrobeats_percussion: string;
    vocal_style: string;
    drop_timestamp_sec: number;
    energy_curve: string;
  };
}

export interface FullProductionPlan {
  reasoning_model_used: string;
  selected_series: ContentSeriesSpec;
  workflow_variant: string;
  include_twerk_variation: boolean;
  title: string;
  video_concept: string;
  script: string;
  total_duration_sec: number;
  location: string;
  outfit_descriptions: string;
  lighting_cinematography: string;
  expressions_poses: string;
  choreography_summary: string;
  camera_summary: string;
  scenes: SceneProductionSpec[];
  music: MusicPlanSpec;
  similarity_score: number;
  regeneration_attempts: number;
}

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const REASONING_MODELS: Array<{ id: string; disableThinkingTokenBudget: boolean }> = [
  { id: 'nvidia/nemotron-3.5-super-vl-120b-a12b', disableThinkingTokenBudget: true },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', disableThinkingTokenBudget: true },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b', disableThinkingTokenBudget: false },
  { id: 'meta/llama-3.2-90b-vision-instruct', disableThinkingTokenBudget: false },
];

const CURATED_LOCATIONS = [
  'Golden-hour infinity rooftop terrace overlooking Lagos Atlantic Ocean skyline with warm glass reflections',
  'Sunlit Mediterranean white-stone villa poolside courtyard with swaying palms and travertine marble',
  'Penthouse floor-to-ceiling glass loft at twilight with warm tungsten architectural cove lighting',
  'Private luxury yacht aft deck moored in turquoise marina water under crisp afternoon sunlight',
  'High-fashion minimalist architectural gallery studio with warm travertine arches and sculpted key light',
  'Boutique marble-and-brass private fitness penthouse with panoramic skyline windows',
  'Tropical resort teak cabana walkway lined with lush bird-of-paradise foliage at sunset',
  'Modern Milanese designer dressing suite with backlit fluted glass mirrors and velvet banquette',
  'Palm-lined Miami Beach oceanfront balcony with soft sea breeze and pastel sky glow',
  'Sun-drenched desert modernist courtyard with terracotta walls and sparkling plunge pool',
];

const MUSICAL_KEYS = [
  'F minor', 'G minor', 'C minor', 'D minor', 'A minor', 'E flat major', 'B flat minor', 'F sharp minor'
];

async function callNvidiaReasoningJSON(systemPrompt: string, userPrompt: string, temperature = 0.85): Promise<{ parsed: any; modelUsed: string }> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error('NVIDIA_API_KEY is missing from environment');
  }

  let lastErr = '';
  for (const entry of REASONING_MODELS) {
    const model = entry.id;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90_000);
      const reqBody: Record<string, any> = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: 6144,
      };
      if (entry.disableThinkingTokenBudget) {
        reqBody.chat_template_kwargs = { enable_thinking: false };
      }
      const resp = await fetch(NVIDIA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}: ${await resp.text()}`;
        continue;
      }

      const data: any = await resp.json();
      const msg = data?.choices?.[0]?.message || {};
      const rawContent = msg.content || msg.reasoning_content || '';
      const jsonStr = extractJsonObject(rawContent);
      const parsed = JSON.parse(jsonStr);
      return { parsed, modelUsed: model };
    } catch (err: any) {
      lastErr = `${model}: ${err?.message || String(err)}`;
    }
  }
  throw new Error(`All NVIDIA reasoning models failed. Last error: ${lastErr}`);
}

function extractJsonObject(raw: string): string {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new Error('No JSON object returned by reasoning model');
  }
  return cleaned.slice(first, last + 1);
}

export async function generateFullVideoProductionPlan(options?: {
  forceSeriesId?: string;
  targetDurationSec?: number;
}): Promise<FullProductionPlan> {
  const selectedSeries = options?.forceSeriesId
    ? SCARLETT_CONTENT_SERIES.find((s) => s.id === options.forceSeriesId) || selectWeightedSeries()
    : selectWeightedSeries();

  // 26s uses the four-shot NVIDIA hosted timeline without arbitrary time-stretching.
  const targetTotal = Math.min(40, Math.max(25, options?.targetDurationSec ?? 26));
  const includeTwerk = selectedSeries.allowTwerkAccent && crypto.randomInt(0, 100) < 38;
  const history = await getRecentHistorySummary(20);

  const suggestedSeedLoc = CURATED_LOCATIONS[crypto.randomInt(0, CURATED_LOCATIONS.length)];
  const suggestedBpm = 109 + crypto.randomInt(0, 9); // 109..117 BPM sweet spot for Amapiano + Afrobeats Fusion
  const suggestedKey = MUSICAL_KEYS[crypto.randomInt(0, MUSICAL_KEYS.length)];

  let attempts = 0;
  let extraRejectionFeedback = '';
  let lastPlan: FullProductionPlan | null = null;

  while (attempts < 3) {
    attempts++;
    const systemPrompt = `You are VIBELY Layer-1 Creative Director & AI Cinematographer coordinating ComfyUI, MiniMax Music 3 Q4_0 GGUF, and NVIDIA Cosmos3 Nano hosted video.
You MUST obey Scarlett Monroe's Permanent Identity Directive strictly:
${SCARLETT_PERMANENT_IDENTITY_PROMPT}

CRITICAL PRODUCTION RULES:
1. Total video duration MUST equal ${targetTotal} seconds (between 25 and 40 seconds), split across EXACTLY 4 connected, continuous scenes whose durations sum to ${targetTotal} seconds (e.g. 4 scenes of ${(targetTotal / 4).toFixed(1)}s each).
2. Every scene MUST follow seamlessly from the previous scene: Scene N's entry_pose MUST match Scene (N-1)'s exit_pose, maintaining exact facial identity, platinum-blonde hair, icy-blue eyes, hourglass body proportions, lighting, and location${selectedSeries.outfitTransition ? ' (except at the planned beat-matched outfit transition from stylish casual wear into a glamorous figure-hugging bodycon dress in Scene 2)' : ' and exact outfit continuity across all 4 scenes'}.
3. Music MUST be an original, non-copyrighted AMAPIANO + AFROBEATS FUSION song (${suggestedBpm} BPM, ${suggestedKey}) featuring catchy female vocals, infectious Amapiano log drums, crisp Afrobeats percussion, deep punchy bass, and all 6 required sections: [Intro], [Verse] with distinctive vocal hook, [Chorus] catchy & repetitive, [Instrumental] dance-friendly break, [Bridge]/[Drop] energetic musical drop, and [Outro] satisfying ending.
4. For gym_challenge choose ONE simple continuous exercise progression (standing setup -> controlled squats -> standing recovery), at normal speed, with fixed focal length and constant camera distance. Frame the complete head, hands and both shoes, with headroom and floor margin. Keep the pelvis at horizontal center throughout. Default to one locked-off front three-quarter full-body camera for the continuous performance. Use side or other angles only at a motivated, planned cut; do not orbit or move the camera merely to change angles. No moving to a different bench, no push-ins, no pans that move Scarlett off-center, no abrupt scale changes. Keep lighting and outfit descriptions identical in every scene. Avoid exaggerated anatomy and bounce language: reproduce the reference proportions without amplification.
5. Dance sequences must coordinate head, shoulders, arms, spine, waist, hips, knees, ankles and feet. Use a memorable short repeatable dance hook, clear planted-foot weight transfers, controlled transitions and normal-speed movement. Keep hands, head and shoes in frame with visible floor contact. Soft-tissue motion is a restrained secondary response to acceleration, gravity and garment support, never independent exaggerated oscillation. Preserve reference identity and proportions. Default to a stationary camera. These are production instructions, not a claim of guaranteed physical realism.
6. Start the musical identity and a memorable vocal or instrumental hook within the first two seconds; no long ambient intro or silence. Reprise a distinctive short rhythmic motif suitable for copying as a dance challenge. Arrange transitions on the same BPM/beat grid used by the choreography. Do not promise virality or perfect synchronization without audio/video measurement.
7. Reply ONLY with a single valid JSON object matching the exact schema requested. No markdown prose outside JSON.`;

    const userPrompt = `Create a brand-new, ultra-photorealistic Scarlett Monroe production for Content Series: "${selectedSeries.name}" (${selectedSeries.description}).
Series signature elements: ${selectedSeries.signatureElements.join('; ')}.
${includeTwerk ? 'Choreography variation: Tastefully weave realistic, physically grounded twerking-inspired hip/glute bounce accents synchronized to the log-drum drop while preserving natural human biomechanics.' : 'Choreography variation: Focus on smooth feminine hip/body movement, natural secondary physics, and confident camera interaction.'}

STRICT UNIQUENESS CONSTRAINTS — DO NOT REPEAT ANY OF THESE PREVIOUS GENERATIONS:
- Avoid recent locations: ${history.recentLocations.join(' | ') || 'None yet'}
- Avoid recent outfits: ${history.recentOutfits.join(' | ') || 'None yet'}
- Avoid recent vocal hooks/titles: ${history.recentHooks.join(' | ') || 'None yet'}
- Avoid recent concepts: ${history.recentConcepts.join(' | ') || 'None yet'}
${extraRejectionFeedback ? `\nURGENT UNIQUENESS REJECTION TO FIX NOW: ${extraRejectionFeedback}` : ''}

Inspiration seed (adapt creatively into a completely fresh setting): Tempo ${suggestedBpm} BPM, Key ${suggestedKey}, Fresh environment idea near "${suggestedSeedLoc}" (invent a distinct specific environment if that one was used).

Return JSON with this exact structure:
{
  "title": "Short catchy video title",
  "workflow_variant": "${selectedSeries.outfitTransition ? 'nvidia_cosmos3_nano_image2video' : 'nvidia_cosmos3_nano_image2video'}",
  "video_concept": "2-3 sentences describing the unified storyline and visual hook",
  "script": "Complete spoken/performed beat-by-beat narrative & action script across the ${targetTotal}s timeline",
  "location": "Detailed ultra-photorealistic environment description",
  "outfit_descriptions": "Detailed realistic fabric, cut, color, texture, and accessories description",
  "lighting_cinematography": "Detailed natural/cinematic lighting, shadows, lens, and camera style",
  "expressions_poses": "Detailed natural facial expressions, eye contact, smiles, and signature poses",
  "choreography_summary": "Detailed biomechanical dance/fitness movement plan with natural weight transfer and realistic secondary motion",
  "camera_summary": "Master camera movement progression across all 4 scenes",
  "scenes": [
    {
      "scene_number": 1,
      "start_sec": 0,
      "end_sec": ${Number((targetTotal * 0.25).toFixed(1))},
      "duration_sec": ${Number((targetTotal * 0.25).toFixed(1))},
      "story_beat": "Engaging opening & hook",
      "character_position_and_movement": "Detailed body mechanics, realistic bust/hip physics, foot placement",
      "choreography": "Exact beat-synced movement in Scene 1",
      "camera_position_and_movement": "Exact framing and smooth camera motion",
      "environment_and_lighting": "Consistent environment and light direction",
      "outfit_state": "Exact garment worn in Scene 1",
      "music_beat_sync": "Synced to [Intro] and opening vocal hook",
      "entry_pose": "Starting body posture and camera gaze",
      "exit_pose": "Exact ending posture of Scene 1 (must match Scene 2 entry_pose)",
      "transition_instruction": "Seamless continuous tracking motion into Scene 2",
      "comfy_prompt": "Rich 80-120 word ultra-photorealistic live-action prompt describing Scarlett Monroe (25yo platinum-blonde hair, icy-blue eyes, full hourglass figure, realistic skin pores and fabric tension), her exact outfit, environment, camera motion, and natural dance/fitness movement for this scene."
    }
  ],
  "music": {
    "title": "Original song title",
    "genre": "Amapiano + Afrobeats Fusion",
    "bpm": ${suggestedBpm},
    "musical_key": "${suggestedKey}",
    "vocal_hook": "Distinctive memorable 1-line vocal hook",
    "song_structure": ["[Intro]", "[Verse]", "[Chorus]", "[Instrumental]", "[Bridge]", "[Outro]"],
    "caption_prompt": "Global Metadata: Amapiano + Afrobeats Fusion, ${suggestedBpm} BPM, ${suggestedKey}...\\nVocal Details: Catchy confident female lead vocals...\\nArrangement: Infectious Amapiano log drums, Afrobeats shakers, deep sub-bass, warm chords, energetic drop...",
    "lyrics": "[Intro]\\n...\\n\\n[Verse]\\n...\\n\\n[Chorus]\\n...\\n\\n[Instrumental]\\n\\n[Bridge]\\n...\\n\\n[Chorus]\\n...\\n\\n[Outro]\\n...",
    "audio_characteristics": {
      "log_drum_pattern": "Syncopated deep South African log-drum bounce",
      "afrobeats_percussion": "Crisp Lagos shakers, woodblock clave, and rimshot groove",
      "vocal_style": "Glamorous rhythmic female lead with airy stacked harmonies",
      "drop_timestamp_sec": ${Number((targetTotal * 0.5).toFixed(1))},
      "energy_curve": "Warm rhythmic intro -> infectious hook -> high-energy log-drum drop -> smooth outro"
    }
  }
}
Ensure "scenes" has ALL 4 connected scenes (scene_number 1, 2, 3, 4) covering 0s to ${targetTotal}s with zero gaps!`;

    const { parsed, modelUsed } = await callNvidiaReasoningJSON(
      systemPrompt,
      userPrompt,
      Math.min(1.0, 0.82 + (attempts - 1) * 0.08)
    );

    const normalizedScenes = normalizeSceneTimeline(parsed.scenes || [], targetTotal, parsed);
    const totalDur = Number(
      normalizedScenes.reduce((acc, s) => acc + s.frame_count, 0) / 24
    );

    const candidatePlan: FullProductionPlan = {
      reasoning_model_used: modelUsed,
      selected_series: selectedSeries,
      workflow_variant: parsed.workflow_variant || 'nvidia_cosmos3_nano_image2video',
      include_twerk_variation: includeTwerk,
      title: String(parsed.title || `${selectedSeries.name} — Scarlett Original`),
      video_concept: String(parsed.video_concept || ''),
      script: String(parsed.script || ''),
      total_duration_sec: totalDur,
      location: String(parsed.location || suggestedSeedLoc),
      outfit_descriptions: String(parsed.outfit_descriptions || ''),
      lighting_cinematography: String(parsed.lighting_cinematography || ''),
      expressions_poses: String(parsed.expressions_poses || ''),
      choreography_summary: String(parsed.choreography_summary || ''),
      camera_summary: String(parsed.camera_summary || ''),
      scenes: normalizedScenes,
      music: {
        title: String(parsed?.music?.title || 'Log Drum Glow'),
        genre: 'Amapiano + Afrobeats Fusion',
        bpm: Number(parsed?.music?.bpm || suggestedBpm),
        musical_key: String(parsed?.music?.musical_key || suggestedKey),
        vocal_hook: String(parsed?.music?.vocal_hook || ''),
        song_structure: Array.isArray(parsed?.music?.song_structure)
          ? parsed.music.song_structure
          : ['[Intro]', '[Verse]', '[Chorus]', '[Instrumental]', '[Bridge]', '[Outro]'],
        caption_prompt: String(parsed?.music?.caption_prompt || ''),
        lyrics: ensureStructuredLyrics(String(parsed?.music?.lyrics || ''), String(parsed?.music?.vocal_hook || '')),
        audio_characteristics: {
          log_drum_pattern: String(parsed?.music?.audio_characteristics?.log_drum_pattern || 'Syncopated Amapiano log drum'),
          afrobeats_percussion: String(parsed?.music?.audio_characteristics?.afrobeats_percussion || 'Afrobeats shakers & rimshots'),
          vocal_style: String(parsed?.music?.audio_characteristics?.vocal_style || 'Confident female lead vocals'),
          drop_timestamp_sec: Number(parsed?.music?.audio_characteristics?.drop_timestamp_sec || totalDur / 2),
          energy_curve: String(parsed?.music?.audio_characteristics?.energy_curve || 'Progressive dance build & drop'),
        },
      },
      similarity_score: 0,
      regeneration_attempts: attempts - 1,
    };

    const uniq = await checkContentUniqueness({
      title: candidatePlan.title,
      videoConcept: candidatePlan.video_concept,
      script: candidatePlan.script,
      choreography: candidatePlan.choreography_summary,
      outfitDescriptions: candidatePlan.outfit_descriptions,
      location: candidatePlan.location,
      musicPrompt: candidatePlan.music.caption_prompt,
      lyrics: candidatePlan.music.lyrics,
      vocalHook: candidatePlan.music.vocal_hook,
    });

    candidatePlan.similarity_score = uniq.maxSimilarity;
    lastPlan = candidatePlan;

    if (uniq.isUnique) {
      return candidatePlan;
    }
    extraRejectionFeedback = `Previous draft had similarity ${(uniq.maxSimilarity * 100).toFixed(1)}% (${uniq.reasons.join('; ')}). Invent a completely different setting, outfit color/cut, dance sequence, song title, vocal hook, and lyrics!`;
  }

  return lastPlan!;
}

export async function generateStandaloneMusicPlan(customTheme?: string): Promise<MusicPlanSpec & { similarity_score: number; reasoning_model_used: string }> {
  const history = await getRecentHistorySummary(20);
  const bpm = 108 + crypto.randomInt(0, 10);
  const key = MUSICAL_KEYS[crypto.randomInt(0, MUSICAL_KEYS.length)];

  let attempts = 0;
  let feedback = '';
  let best: any = null;

  while (attempts < 3) {
    attempts++;
    const sys = `You are Scarlett Monroe's executive Amapiano + Afrobeats Fusion music producer creating original TikTok/Reels anthems for MiniMax Music 3 Q4_0 GGUF in ComfyUI. Reply ONLY with valid JSON.`;
    const usr = `Compose a 100% original, infectious AMAPIANO + AFROBEATS FUSION song (${bpm} BPM, ${key})${customTheme ? ` inspired by theme: "${customTheme}"` : ''}.
Must include catchy female vocals, signature South African Amapiano log drums, West African Afrobeats percussion, deep punchy bass, memorable vocal hook, repetitive chorus, dance-friendly instrumental section, energetic drop, and satisfying ending.
Introduce the signature vocal or instrumental hook within 0-2 seconds; no silence, long spoken setup or ambient-only intro. Use a distinctive short, easy-to-remember rhythmic motif and a repeatable chorus with clear eight-count dance phrasing. Align the planned drop and transitions to the stated tempo. Use original lyrics, avoid imitating a named artist, and do not claim guaranteed virality or measured beat accuracy.
Do NOT repeat these previous hooks/keys: ${history.recentHooks.join(' | ') || 'None'}.
${feedback}

Return JSON:
{
  "title": "Unique song title",
  "genre": "Amapiano + Afrobeats Fusion",
  "bpm": ${bpm},
  "musical_key": "${key}",
  "vocal_hook": "Memorable 1-line vocal hook",
  "song_structure": ["[Intro]", "[Verse]", "[Chorus]", "[Instrumental]", "[Bridge]", "[Chorus]", "[Outro]"],
  "caption_prompt": "Global Metadata: Amapiano + Afrobeats Fusion, ${bpm} BPM, ${key}...\\nVocal Details: ...\\nArrangement: ...",
  "lyrics": "[Intro]\\n...\\n\\n[Verse]\\n...\\n\\n[Chorus]\\n...\\n\\n[Instrumental]\\n\\n[Bridge]\\n...\\n\\n[Chorus]\\n...\\n\\n[Outro]\\n...",
  "audio_characteristics": {
    "log_drum_pattern": "...",
    "afrobeats_percussion": "...",
    "vocal_style": "...",
    "drop_timestamp_sec": 14,
    "energy_curve": "..."
  }
}`;
    const { parsed, modelUsed } = await callNvidiaReasoningJSON(sys, usr, 0.88);
    const lyrics = ensureStructuredLyrics(String(parsed.lyrics || ''), String(parsed.vocal_hook || ''));
    const uniq = await checkStandaloneMusicUniqueness(lyrics, String(parsed.vocal_hook || ''), String(parsed.caption_prompt || ''));
    best = {
      title: String(parsed.title || 'Midnight Log Drum'),
      genre: 'Amapiano + Afrobeats Fusion',
      bpm: Number(parsed.bpm || bpm),
      musical_key: String(parsed.musical_key || key),
      vocal_hook: String(parsed.vocal_hook || ''),
      song_structure: Array.isArray(parsed.song_structure)
        ? parsed.song_structure
        : ['[Intro]', '[Verse]', '[Chorus]', '[Instrumental]', '[Bridge]', '[Outro]'],
      caption_prompt: String(parsed.caption_prompt || ''),
      lyrics,
      audio_characteristics: {
        log_drum_pattern: String(parsed?.audio_characteristics?.log_drum_pattern || 'Deep syncopated Amapiano log drums'),
        afrobeats_percussion: String(parsed?.audio_characteristics?.afrobeats_percussion || 'Polyrhythmic shakers and rimshots'),
        vocal_style: String(parsed?.audio_characteristics?.vocal_style || 'Bright confident female lead vocals'),
        drop_timestamp_sec: Number(parsed?.audio_characteristics?.drop_timestamp_sec || 14),
        energy_curve: String(parsed?.audio_characteristics?.energy_curve || 'Hook -> Chorus -> Log-Drum Drop -> Smooth Outro'),
      },
      similarity_score: uniq.maxSimilarity,
      reasoning_model_used: modelUsed,
    };
    if (uniq.isUnique) return best;
    feedback = `Draft collided with past lyrics (${(uniq.maxSimilarity * 100).toFixed(1)}%). Write completely different lyrics, imagery, and vocal hook!`;
  }
  return best;
}

function normalizeSceneTimeline(rawScenes: any[], targetTotalSec: number, root: any): SceneProductionSpec[] {
  const count = 4;
  const frameCounts=planVideoFrames(targetTotalSec,count);
  const out: SceneProductionSpec[] = [];
  let cursor = 0;

  for (let i = 0; i < count; i++) {
    const src = rawScenes[i] || {};
    const frames=frameCounts[i];
    const dur=frames/24;
    const start=cursor;
    const end=cursor+dur;
    cursor = end;

    const prevExit = i > 0 ? out[i - 1].exit_pose : 'Confident standing model stance facing camera with soft hip angle';
    const entryPose = i>0 ? prevExit : String(src.entry_pose || prevExit);
    const exitPose = String(src.exit_pose || 'Balanced feminine three-quarter dance stance with warm eye contact');
    const basePrompt = String(
      src.comfy_prompt ||
        `Ultra-photorealistic 4K live-action footage of Scarlett Monroe, 25-year-old glamorous influencer with long platinum-blonde hair, icy-blue eyes, realistic skin pores, and hourglass figure in ${root.outfit_descriptions || 'a figure-hugging luxury outfit'} at ${root.location || 'a sunlit luxury terrace'}. ${src.choreography || root.choreography_summary || 'Smooth rhythmic dance choreography synchronized to the music'}. ${src.camera_position_and_movement || 'Smooth gimbal tracking shot'}. Natural human biomechanics, realistic fabric physics, cinematic lighting. Avoid: ${SCARLETT_NEGATIVE_PROMPT}.`
    );

    out.push({
      scene_number: i + 1,
      start_sec: start,
      end_sec: end,
      duration_sec: dur,
      frame_count: frames,
      story_beat: String(src.story_beat || `Scene ${i + 1}`),
      character_position_and_movement: String(src.character_position_and_movement || 'Natural fluid full-body movement with realistic weight transfer'),
      choreography: String(src.choreography || root.choreography_summary || 'Rhythmic beat-locked choreography'),
      camera_position_and_movement: String(src.camera_position_and_movement || 'Smooth continuous 24fps gimbal framing'),
      environment_and_lighting: String(src.environment_and_lighting || root.location || ''),
      outfit_state: String(src.outfit_state || root.outfit_descriptions || ''),
      music_beat_sync: String(src.music_beat_sync || `Locked to ${start}s-${end}s master beat`),
      entry_pose: entryPose,
      exit_pose: exitPose,
      transition_instruction: String(src.transition_instruction || 'Continuous motion-matched camera flow'),
      comfy_prompt: `${basePrompt} Continuity constraints: start in ${entryPose}; end in ${exitPose}. Use identical outfit: ${root.outfit_descriptions}. Identical environment and light: ${root.location}; ${root.lighting_cinematography}. Same reference-defined skeletal dimensions and body volume in every frame. Normal speed, no size fluctuations.`,
    });
  }
  return out;
}

function ensureStructuredLyrics(lyrics: string, hook: string): string {
  let clean = (lyrics || '').trim();
  if (!clean.includes('[Intro]')) {
    clean = `[Intro]\n${hook || 'Feel the rhythm rise tonight'}\n\n` + clean;
  }
  if (!clean.includes('[Chorus]')) {
    clean += `\n\n[Chorus]\n${hook || 'Move with the log drum, let it glow'}\n`;
  }
  if (!clean.includes('[Instrumental]')) {
    clean += `\n\n[Instrumental]\n`;
  }
  if (!clean.includes('[Outro]')) {
    clean += `\n\n[Outro]\n${hook || 'Vibely till the morning light'}`;
  }
  return clean;
}
