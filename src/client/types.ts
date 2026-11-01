export type NavSection =
  | 'dashboard'
  | 'generate'
  | 'automations'
  | 'music'
  | 'library'
  | 'character'
  | 'history'
  | 'settings';

export interface ModelEndpoint {
  service_id: string;
  username: string;
  model_name: string;
  endpoint_url: string;
  status: string;
  comfyui_ready: boolean;
  dataset_cached: boolean;
  storage_sources: Record<string, string>;
  gpu_name: string;
  last_heartbeat_at: string | null;
  updated_at: string;
}

export interface SceneSegment {
  scene_number: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  shot_framing: string;
  camera_movement: string;
  choreography: string;
  facial_expression: string;
  entry_pose_continuity: string;
  exit_pose_continuity: string;
  transition_to_next: string;
  comfy_scene_prompt: string;
}

export interface VideoGeneration {
  social_caption: string;
  hashtags: string[];
  caption_status: string;
  caption_error: string | null;
  observed_content: string;
  quality_notes: string[];
  stage_timings: {stage: string; at: string; progress: number}[];
  id: string;
  trigger_type: 'manual' | 'scheduled';
  schedule_id: string | null;
  status: 'queued' | 'planning' | 'generating_music' | 'generating_video' | 'rendering_final' | 'completed' | 'failed';
  current_stage: string;
  progress: number;
  content_series: string;
  series_id: string;
  title: string;
  visual_concept: string;
  storyline: string;
  script_summary: string;
  outfit_styling: string;
  location_setting: string;
  lighting_setup: string;
  camera_plan: string;
  choreography_summary: string;
  includes_twerk_showcase: boolean;
  scene_plan: SceneSegment[];
  music_track_id: string | null;
  music_prompt: string;
  lyrics: string;
  audio_characteristics: Record<string, any>;
  duration_seconds: number;
  similarity_score: number;
  regeneration_attempts: number;
  reasoning_model: string;
  video_file_name: string;
  thumbnail_file_name: string;
  video_url: string | null;
  thumbnail_url: string | null;
  file_size_bytes: number;
  auto_delete_eligible: boolean;
  expires_at: string | null;
  deleted_at: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface MusicTrack {
  id: string;
  title: string;
  genre: string;
  bpm: number;
  musical_key: string;
  duration_seconds: number;
  music_prompt: string;
  lyrics: string;
  song_structure: Record<string, string>;
  audio_characteristics: Record<string, any>;
  file_name: string;
  audio_url: string | null;
  file_size_bytes: number;
  status: string;
  created_at: string;
}

export interface AutomationSchedule {
  id: string;
  name: string;
  frequency: 'daily' | 'twice_daily' | 'hourly' | 'every_6h' | 'interval';
  preferred_time: string;
  timezone: string;
  interval_minutes: number;
  status: 'active' | 'paused' | 'disabled';
  enabled: boolean;
  series_mode: string;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  run_count: number;
  fail_count: number;
  created_at: string;
}

export interface CharacterReference {
  id: string;
  filename: string;
  label: string;
  role: string;
  sourceOrigin: string;
  publicUrl: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
}
