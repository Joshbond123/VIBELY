import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Film,
  History,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  Loader2,
  Menu,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { api } from './api';
import {
  AutomationSchedule,
  CharacterReference,
  ModelEndpoint,
  MusicTrack,
  NavSection,
  VideoGeneration,
} from './types';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ComponentType<any> }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'generate', label: 'Generate Video', icon: Sparkles },
  { id: 'automations', label: 'Automations', icon: Calendar },
  { id: 'music', label: 'Music Studio', icon: Music2 },
  { id: 'library', label: 'Video Library', icon: Film },
  { id: 'character', label: 'Character References', icon: ImageIcon },
  { id: 'history', label: 'Generation History', icon: History },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelativeOrDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatExpiryBadge(video: VideoGeneration): string {
  if (video.deleted_at) return 'Deleted / Expired';
  if (!video.auto_delete_eligible || !video.expires_at) return 'Retained (Auto-Delete OFF)';
  const diffMs = new Date(video.expires_at).getTime() - Date.now();
  if (diffMs <= 0) return 'Pending 72h Sweep';
  const hrs = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  return `Auto-deletes in ${hrs}h ${mins}m`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    online: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    failed: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    offline: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    paused: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    disabled: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  };
  const cls =
    styles[status] ||
    'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30 animate-pulse';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function App() {
  const [section, setSection] = useState<NavSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Shared platform state
  const [stats, setStats] = useState<any>({
    total: 0,
    active_videos: 0,
    completed_total: 0,
    failed_total: 0,
    running_total: 0,
  });
  const [seriesDist, setSeriesDist] = useState<{ content_series: string; count: number }[]>([]);
  const [models, setModels] = useState<ModelEndpoint[]>([]);
  const [videos, setVideos] = useState<VideoGeneration[]>([]);
  const [historyRows, setHistoryRows] = useState<VideoGeneration[]>([]);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [schedules, setSchedules] = useState<AutomationSchedule[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<VideoGeneration[]>([]);
  const [characterData, setCharacterData] = useState<any>(null);
  const [workflows, setWorkflows] = useState<any>(null);
  const [autoDeleteEnabled, setAutoDeleteEnabled] = useState<boolean>(true);
  const [healthInfo, setHealthInfo] = useState<any>(null);

  // Interactive UI states
  const [selectedSeries, setSelectedSeries] = useState<string>('weighted_random');
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [activeGenId, setActiveGenId] = useState<string | null>(null);
  const [inspectVideo, setInspectVideo] = useState<VideoGeneration | null>(null);

  // Music Studio state
  const [musicTheme, setMusicTheme] = useState('');
  const [generatingMusic, setGeneratingMusic] = useState(false);

  // Automation form state
  const [schedName, setSchedName] = useState('Scarlett Daily Viral Drop');
  const [schedFreq, setSchedFreq] = useState<'daily' | 'twice_daily' | 'every_6h' | 'hourly' | 'interval'>('daily');
  const [schedTime, setSchedTime] = useState('16:00');
  const [schedInterval, setSchedInterval] = useState(180);
  const [creatingSched, setCreatingSched] = useState(false);

  // Settings & Sync state
  const [syncingModels, setSyncingModels] = useState(false);
  const [simResult, setSimResult] = useState<Record<string, number> | null>(null);
  const [historyFilter, setHistoryFilter] = useState('');

  const notify = (type: 'ok' | 'err', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 5000);
  };

  const refreshAll = useCallback(async () => {
    try {
      const [ov, vids, mus, aut, hist, hlth] = await Promise.all([
        api.getOverview(),
        api.getVideos(false),
        api.getMusic(),
        api.getAutomations(),
        api.getHistory(),
        api.getHealth(),
      ]);
      setStats(ov.stats || {});
      setSeriesDist(ov.series_distribution || []);
      setModels(ov.models || []);
      setVideos(vids.videos || []);
      setTracks(mus.tracks || []);
      setSchedules(aut.schedules || []);
      setScheduledTasks(aut.scheduled_tasks || []);
      setHistoryRows(hist.history || []);
      setWorkflows(hist.canonical_workflows || null);
      setHealthInfo(hlth);
      if (ov.settings?.auto_delete) {
        setAutoDeleteEnabled(Boolean(ov.settings.auto_delete.enabled));
      }
      if (!characterData) {
        const ch = await api.getCharacter(0);
        setCharacterData(ch);
      }
    } catch (err: any) {
      console.error('Refresh error:', err);
    } finally {
      setLoading(false);
    }
  }, [characterData]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const hasRunningJobs = useMemo(
    () =>
      historyRows.some(
        (v) => v.status !== 'completed' && v.status !== 'failed'
      ),
    [historyRows]
  );

  // Poll every 4s when jobs are active, otherwise every 15s
  useEffect(() => {
    const interval = setInterval(refreshAll, hasRunningJobs ? 4000 : 15000);
    return () => clearInterval(interval);
  }, [hasRunningJobs, refreshAll]);

  const activeGeneration = useMemo(() => {
    if (activeGenId) {
      const found = historyRows.find((r) => r.id === activeGenId);
      if (found) return found;
    }
    return historyRows.find((r) => r.status !== 'completed' && r.status !== 'failed') || historyRows[0] || null;
  }, [activeGenId, historyRows]);

  const handleGenerateVideo = async () => {
    setGeneratingVideo(true);
    try {
      const res = await api.generateVideo(selectedSeries);
      setActiveGenId(res.generation_id);
      setSection('generate');
      notify('ok', `Started Scarlett Monroe generation (${res.generation_id})`);
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message || 'Failed to start generation');
    } finally {
      setGeneratingVideo(false);
    }
  };

  const handleDeleteVideo = async (id: string) => {
    try {
      await api.deleteVideo(id);
      notify('ok', 'Video file deleted cleanly from library');
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    }
  };

  const handleGenerateMusic = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingMusic(true);
    try {
      const res = await api.generateMusic(musicTheme || undefined);
      setMusicTheme('');
      notify('ok', `Generated "${res.track.title}" via MiniMax Music 3 Q4_0 GGUF`);
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    } finally {
      setGeneratingMusic(false);
    }
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingSched(true);
    try {
      await api.createAutomation({
        name: schedName,
        frequency: schedFreq,
        preferred_time: schedTime,
        interval_minutes: schedInterval,
        timezone: 'Africa/Lagos',
      });
      notify('ok', 'Persistent server-side schedule created');
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    } finally {
      setCreatingSched(false);
    }
  };

  const handleScheduleAction = async (id: string, action: string) => {
    try {
      await api.updateAutomation(id, { action });
      notify('ok', `Schedule ${action}d`);
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    try {
      await api.deleteAutomation(id);
      notify('ok', 'Schedule removed');
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    }
  };

  const handleToggleAutoDelete = async () => {
    const next = !autoDeleteEnabled;
    try {
      await api.setAutoDelete(next);
      setAutoDeleteEnabled(next);
      notify(
        'ok',
        next
          ? 'Automatic 72-hour video deletion turned ON'
          : 'Automatic video deletion turned OFF — videos will be retained indefinitely'
      );
      await refreshAll();
    } catch (err: any) {
      notify('err', err.message);
    }
  };

  const handleSyncModels = async () => {
    setSyncingModels(true);
    try {
      await api.syncModels();
      await refreshAll();
      notify('ok', 'Synced Kaggle GPU endpoints & ComfyUI worker health');
    } catch (err: any) {
      notify('err', err.message);
    } finally {
      setSyncingModels(false);
    }
  };

  const handleSimulateWeights = async () => {
    try {
      const res = await api.getCharacter(1000);
      setSimResult(res.simulation || null);
      notify('ok', 'Simulated 1,000 weighted random series draws');
    } catch (err: any) {
      notify('err', err.message);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col lg:flex-row">
      {/* Mobile Header */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-zinc-800/80 bg-zinc-950/95 sticky top-0 z-30 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center font-bold text-white shadow-lg shadow-fuchsia-500/20">
            V
          </div>
          <div>
            <div className="font-bold tracking-tight text-sm">VIBELY</div>
            <div className="text-[11px] text-zinc-400">Scarlett Monroe AI Studio</div>
          </div>
        </div>
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {/* Sidebar */}
      <aside
        className={`${
          mobileMenuOpen ? 'fixed inset-0 top-14 z-20 block' : 'hidden'
        } lg:block lg:w-64 lg:shrink-0 border-r border-zinc-800/80 bg-zinc-950 flex flex-col`}
      >
        <div className="hidden lg:flex items-center gap-3 px-6 py-5 border-b border-zinc-800/80">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-fuchsia-500 to-violet-600 flex items-center justify-center font-extrabold text-white shadow-lg shadow-fuchsia-500/25">
            V
          </div>
          <div>
            <div className="font-bold tracking-tight text-base">VIBELY</div>
            <div className="text-xs text-zinc-400">Scarlett Monroe Studio</div>
          </div>
        </div>

        <div className="p-3 space-y-1 flex-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSection(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  active
                    ? 'bg-gradient-to-r from-fuchsia-600/20 to-violet-600/15 text-fuchsia-200 border border-fuchsia-500/30'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/80 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className={`w-4 h-4 ${active ? 'text-fuchsia-400' : 'text-zinc-500'}`} />
                  {item.label}
                </span>
                {item.id === 'generate' && hasRunningJobs && (
                  <span className="w-2 h-2 rounded-full bg-fuchsia-400 animate-ping" />
                )}
              </button>
            );
          })}
        </div>

        <div className="p-4 border-t border-zinc-800/80 space-y-2.5 text-xs">
          <div className="flex items-center justify-between text-zinc-400">
            <span>Auto-Delete (72h)</span>
            <span className={autoDeleteEnabled ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'}>
              {autoDeleteEnabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <button
            onClick={handleGenerateVideo}
            disabled={generatingVideo}
            className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 font-semibold text-white shadow-lg shadow-fuchsia-600/20 flex items-center justify-center gap-2 disabled:opacity-50 transition"
          >
            {generatingVideo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Generate Video
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        {toast && (
          <div
            className={`mb-5 px-4 py-3 rounded-xl border flex items-center justify-between text-sm ${
              toast.type === 'ok'
                ? 'bg-emerald-950/70 border-emerald-500/40 text-emerald-200'
                : 'bg-rose-950/70 border-rose-500/40 text-rose-200'
            }`}
          >
            <span>{toast.msg}</span>
            <button onClick={() => setToast(null)} className="text-zinc-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="py-24 flex flex-col items-center justify-center text-zinc-400 gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-fuchsia-400" />
            <p className="text-sm">Loading VIBELY production studio...</p>
          </div>
        ) : (
          <>
            {/* ==================== 1. DASHBOARD ==================== */}
            {section === 'dashboard' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">Production Dashboard</h1>
                    <p className="text-sm text-zinc-400 mt-0.5">
                      Scarlett Monroe — Two-Layer NVIDIA Reasoning + ComfyUI GPU Pipeline
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={handleSyncModels}
                      disabled={syncingModels}
                      className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-medium flex items-center gap-2"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingModels ? 'animate-spin' : ''}`} />
                      Sync GPU Workers
                    </button>
                    <button
                      onClick={handleGenerateVideo}
                      disabled={generatingVideo}
                      className="px-4 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-sm font-semibold flex items-center gap-2 shadow-lg shadow-fuchsia-600/20"
                    >
                      <Sparkles className="w-4 h-4" />
                      Generate Video
                    </button>
                  </div>
                </div>

                {/* KPI Grid */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="p-4 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                    <div className="text-xs text-zinc-400 flex items-center justify-between">
                      <span>Active Library Videos</span>
                      <Film className="w-4 h-4 text-fuchsia-400" />
                    </div>
                    <div className="text-2xl font-bold mt-2">{stats.active_videos || 0}</div>
                    <div className="text-[11px] text-zinc-500 mt-1">20–40s 9:16 Continuous MP4s</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                    <div className="text-xs text-zinc-400 flex items-center justify-between">
                      <span>Total Completed</span>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    </div>
                    <div className="text-2xl font-bold mt-2">{stats.completed_total || 0}</div>
                    <div className="text-[11px] text-zinc-500 mt-1">Tracked in PostgreSQL History</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                    <div className="text-xs text-zinc-400 flex items-center justify-between">
                      <span>Original Songs</span>
                      <Music2 className="w-4 h-4 text-violet-400" />
                    </div>
                    <div className="text-2xl font-bold mt-2">{tracks.length}</div>
                    <div className="text-[11px] text-zinc-500 mt-1">Amapiano + Afrobeats Fusion</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                    <div className="text-xs text-zinc-400 flex items-center justify-between">
                      <span>Active Schedules</span>
                      <Calendar className="w-4 h-4 text-amber-400" />
                    </div>
                    <div className="text-2xl font-bold mt-2">
                      {schedules.filter((s) => s.enabled).length}
                    </div>
                    <div className="text-[11px] text-zinc-500 mt-1">Persistent Server-Side Cron</div>
                  </div>
                </div>

                {/* Two-Layer AI Stack Status */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-fuchsia-400">
                        Layer 1 • Reasoning & Director
                      </span>
                      <StatusBadge status={healthInfo?.nvidia_reasoning?.configured ? 'online' : 'offline'} />
                    </div>
                    <div className="font-semibold text-sm">NVIDIA Nemotron 3 Ultra</div>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Plans Scarlett Monroe scripts, 4-scene continuous master timelines, camera & choreography links, lyrics, and similarity checks.
                    </p>
                  </div>

                  {models.map((m) => (
                    <div
                      key={m.service_id}
                      className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wider text-violet-400">
                          Layer 2 • Kaggle @{m.username}
                        </span>
                        <StatusBadge status={m.comfyui_ready ? 'online' : m.status} />
                      </div>
                      <div className="font-semibold text-sm">{m.model_name}</div>
                      <div className="text-xs text-zinc-400 space-y-1">
                        <div>GPU: {m.gpu_name || 'Kaggle Tesla T4'}</div>
                        <div className="flex items-center gap-2">
                          <span>Persistent Cache:</span>
                          <span className={m.dataset_cached ? 'text-emerald-400' : 'text-amber-400'}>
                            {m.dataset_cached ? 'Mounted / Cached' : 'Provisioning'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Live Running Pipeline Banner */}
                {activeGeneration &&
                  activeGeneration.status !== 'completed' &&
                  activeGeneration.status !== 'failed' && (
                    <div className="p-5 rounded-2xl bg-gradient-to-r from-fuchsia-950/50 to-violet-950/40 border border-fuchsia-500/40 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <Loader2 className="w-4 h-4 animate-spin text-fuchsia-400" />
                          <span className="font-semibold text-sm">
                            Live Pipeline: {activeGeneration.title} ({activeGeneration.content_series})
                          </span>
                        </div>
                        <span className="text-xs font-mono text-fuchsia-300">
                          {activeGeneration.progress}%
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-fuchsia-500 to-violet-500 transition-all duration-500"
                          style={{ width: `${Math.max(5, activeGeneration.progress)}%` }}
                        />
                      </div>
                      <div className="text-xs text-zinc-300">{activeGeneration.current_stage}</div>
                    </div>
                  )}

                {/* Weighted Content Series + Recent Videos */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-4">
                    <h2 className="font-semibold text-sm flex items-center gap-2">
                      <Layers className="w-4 h-4 text-fuchsia-400" />
                      Weighted Content Series
                    </h2>
                    <div className="space-y-3">
                      {(characterData?.content_series || []).map((s: any) => {
                        const actual =
                          seriesDist.find((d) => d.content_series === s.name)?.count || 0;
                        return (
                          <div key={s.id} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-zinc-200">{s.name}</span>
                              <span className="text-zinc-400">
                                Target {s.weightPercent}% • {actual} runs
                              </span>
                            </div>
                            <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className="h-full bg-fuchsia-500 rounded-full"
                                style={{ width: `${s.weightPercent}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="lg:col-span-2 p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-4">
                    <div className="flex items-center justify-between">
                      <h2 className="font-semibold text-sm flex items-center gap-2">
                        <Video className="w-4 h-4 text-fuchsia-400" />
                        Latest Scarlett Monroe Productions
                      </h2>
                      <button
                        onClick={() => setSection('library')}
                        className="text-xs text-fuchsia-400 hover:text-fuchsia-300"
                      >
                        Open Library →
                      </button>
                    </div>
                    {videos.length === 0 ? (
                      <div className="py-10 text-center text-xs text-zinc-500">
                        No completed videos in library yet. Click &ldquo;Generate Video&rdquo; to produce Scarlett Monroe&apos;s next 20–40s reel.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {videos.slice(0, 2).map((v) => (
                          <div
                            key={v.id}
                            className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden flex flex-col"
                          >
                            {v.video_url ? (
                              <video
                                src={v.video_url}
                                poster={v.thumbnail_url || undefined}
                                controls
                                preload="metadata"
                                className="w-full aspect-[9/16] max-h-72 object-cover bg-black"
                              />
                            ) : (
                              <div className="w-full h-44 bg-zinc-900 flex items-center justify-center text-xs text-zinc-500">
                                {v.current_stage}
                              </div>
                            )}
                            <div className="p-3 space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-xs truncate">{v.title}</span>
                                <StatusBadge status={v.status} />
                              </div>
                              <div className="text-[11px] text-zinc-400 flex items-center justify-between">
                                <span>{v.content_series}</span>
                                <span>{v.duration_seconds ? `${v.duration_seconds.toFixed(1)}s` : ''}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 2. GENERATE VIDEO ==================== */}
            {section === 'generate' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">Generate Scarlett Monroe Video</h1>
                  <p className="text-sm text-zinc-400 mt-0.5">
                    Creates an original 20–40s multi-scene photorealistic video with synced Amapiano + Afrobeats Fusion song
                  </p>
                </div>

                <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-xs font-medium text-zinc-300">
                        Content Series Selection Mode
                      </label>
                      <select
                        value={selectedSeries}
                        onChange={(e) => setSelectedSeries(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-fuchsia-500"
                      >
                        <option value="weighted_random">
                          Automatic Weighted Random (35% Hip Movement • 30% Bounce • 20% Bodycon • 15% Gym)
                        </option>
                        {(characterData?.content_series || []).map((s: any) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.weightPercent}% default weight)
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={handleGenerateVideo}
                      disabled={generatingVideo}
                      className="w-full py-2.5 px-5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 font-semibold text-white shadow-lg shadow-fuchsia-600/25 flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {generatingVideo ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      Generate Video
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs text-zinc-400">
                    <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80">
                      <div className="font-semibold text-zinc-200">Character Lock</div>
                      <div>3 Persistent Scarlett Refs</div>
                    </div>
                    <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80">
                      <div className="font-semibold text-zinc-200">Target Duration</div>
                      <div>Strict 20–40 Seconds</div>
                    </div>
                    <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80">
                      <div className="font-semibold text-zinc-200">Audio Engine</div>
                      <div>MiniMax Music 3 Q4_0</div>
                    </div>
                    <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80">
                      <div className="font-semibold text-zinc-200">Video Engine</div>
                      <div>MiniMax H3 Ref2VA</div>
                    </div>
                  </div>
                </div>

                {/* Live / Most Recent Generation Tracker */}
                {activeGeneration && (
                  <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-xs text-fuchsia-400 font-medium">
                          Job {activeGeneration.id} • {activeGeneration.content_series}
                        </div>
                        <h2 className="text-lg font-bold mt-0.5">{activeGeneration.title}</h2>
                      </div>
                      <StatusBadge status={activeGeneration.status} />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-zinc-300">
                        <span>{activeGeneration.current_stage}</span>
                        <span className="font-mono">{activeGeneration.progress}%</span>
                      </div>
                      <div className="w-full h-2.5 rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
                        <div
                          className={`h-full transition-all duration-500 ${
                            activeGeneration.status === 'failed'
                              ? 'bg-rose-500'
                              : activeGeneration.status === 'completed'
                              ? 'bg-emerald-500'
                              : 'bg-gradient-to-r from-fuchsia-500 to-violet-500'
                          }`}
                          style={{ width: `${Math.max(4, activeGeneration.progress)}%` }}
                        />
                      </div>
                    </div>

                    {activeGeneration.error_message && (
                      <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-xs text-rose-200 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{activeGeneration.error_message}</span>
                      </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      <div className="lg:col-span-1">
                        {activeGeneration.video_url ? (
                          <div className="space-y-3">
                            <video
                              src={activeGeneration.video_url}
                              poster={activeGeneration.thumbnail_url || undefined}
                              controls
                              className="w-full aspect-[9/16] rounded-xl bg-black border border-zinc-800 object-cover"
                            />
                            <a
                              href={activeGeneration.video_url}
                              download={activeGeneration.video_file_name}
                              className="w-full py-2 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium flex items-center justify-center gap-2"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Download MP4 ({formatBytes(activeGeneration.file_size_bytes)})
                            </a>
                          </div>
                        ) : (
                          <div className="aspect-[9/16] rounded-xl bg-zinc-950 border border-zinc-800 flex flex-col items-center justify-center p-6 text-center text-xs text-zinc-500 gap-3">
                            {activeGeneration.status !== 'failed' && (
                              <Loader2 className="w-7 h-7 animate-spin text-fuchsia-400" />
                            )}
                            <span>{activeGeneration.current_stage}</span>
                          </div>
                        )}
                      </div>

                      <div className="lg:col-span-2 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
                            <div className="text-zinc-400 font-medium mb-1">Outfit & Styling</div>
                            <div className="text-zinc-200">{activeGeneration.outfit_styling || 'Planning...'}</div>
                          </div>
                          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
                            <div className="text-zinc-400 font-medium mb-1">Location & Lighting</div>
                            <div className="text-zinc-200">{activeGeneration.location_setting || 'Planning...'}</div>
                          </div>
                        </div>

                        {activeGeneration.scene_plan?.length > 0 && (
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                              Seamless Master Timeline ({activeGeneration.duration_seconds}s)
                            </div>
                            <div className="space-y-2">
                              {activeGeneration.scene_plan.map((sc) => (
                                <div
                                  key={sc.scene_number}
                                  className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs space-y-1"
                                >
                                  <div className="flex items-center justify-between font-semibold text-fuchsia-300">
                                    <span>
                                      Scene {sc.scene_number} ({sc.start_sec}s – {sc.end_sec}s)
                                    </span>
                                    <span className="text-zinc-400">{sc.shot_framing}</span>
                                  </div>
                                  <div className="text-zinc-200">{sc.choreography}</div>
                                  <div className="text-[11px] text-zinc-500">
                                    Transition: {sc.transition_to_next}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ==================== 3. AUTOMATIONS ==================== */}
            {section === 'automations' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">Automated Scheduled Generation</h1>
                    <p className="text-sm text-zinc-400 mt-0.5">
                      Persistent server-side background scheduler — executes automatically without any open browser session
                    </p>
                  </div>
                </div>

                <form
                  onSubmit={handleCreateSchedule}
                  className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end"
                >
                  <div className="space-y-1.5 lg:col-span-2">
                    <label className="text-xs font-medium text-zinc-300">Schedule Name</label>
                    <input
                      value={schedName}
                      onChange={(e) => setSchedName(e.target.value)}
                      required
                      className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-zinc-300">Frequency</label>
                    <select
                      value={schedFreq}
                      onChange={(e) => setSchedFreq(e.target.value as any)}
                      className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm"
                    >
                      <option value="daily">Daily</option>
                      <option value="twice_daily">Every 12 Hours</option>
                      <option value="every_6h">Every 6 Hours</option>
                      <option value="hourly">Hourly</option>
                      <option value="interval">Custom Minutes</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    {schedFreq === 'interval' ? (
                      <>
                        <label className="text-xs font-medium text-zinc-300">Interval (Minutes)</label>
                        <input
                          type="number"
                          min={5}
                          value={schedInterval}
                          onChange={(e) => setSchedInterval(Number(e.target.value))}
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm"
                        />
                      </>
                    ) : (
                      <>
                        <label className="text-xs font-medium text-zinc-300">Preferred Time (UTC)</label>
                        <input
                          type="time"
                          value={schedTime}
                          onChange={(e) => setSchedTime(e.target.value)}
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm"
                        />
                      </>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={creatingSched}
                    className="py-2.5 px-4 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Add Schedule
                  </button>
                </form>

                {/* Active & Paused Schedules */}
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300">Configured Schedules</h2>
                  {schedules.length === 0 ? (
                    <div className="p-8 rounded-2xl bg-zinc-900/50 border border-zinc-800 text-center text-xs text-zinc-500">
                      No automated schedules configured yet. Create one above to run Scarlett Monroe reels automatically.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {schedules.map((s) => (
                        <div
                          key={s.id}
                          className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-3"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="font-semibold text-sm">{s.name}</div>
                              <div className="text-xs text-zinc-400">
                                {s.frequency === 'interval'
                                  ? `Every ${s.interval_minutes} min`
                                  : `${s.frequency} • ${s.preferred_time} UTC`}
                              </div>
                            </div>
                            <StatusBadge status={s.status} />
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400 pt-1">
                            <div>
                              <span className="text-zinc-500 block">Next Run</span>
                              <span className="text-zinc-200">{formatRelativeOrDate(s.next_run_at)}</span>
                            </div>
                            <div>
                              <span className="text-zinc-500 block">Runs / Failures</span>
                              <span className="text-zinc-200">
                                {s.run_count} runs • {s.fail_count} failed
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/80">
                            {s.enabled ? (
                              <button
                                onClick={() => handleScheduleAction(s.id, 'pause')}
                                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium flex items-center gap-1.5"
                              >
                                <Pause className="w-3.5 h-3.5" /> Pause
                              </button>
                            ) : (
                              <button
                                onClick={() => handleScheduleAction(s.id, 'resume')}
                                className="px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-xs font-medium flex items-center gap-1.5"
                              >
                                <Play className="w-3.5 h-3.5" /> Resume
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteSchedule(s.id)}
                              className="ml-auto px-3 py-1.5 rounded-lg bg-rose-950/50 hover:bg-rose-900/50 text-rose-300 text-xs flex items-center gap-1.5"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Scheduled Task Execution Log */}
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300">
                    Scheduled Runs (Upcoming, Completed & Failed)
                  </h2>
                  <div className="rounded-2xl bg-zinc-900/70 border border-zinc-800/80 overflow-hidden">
                    {scheduledTasks.length === 0 ? (
                      <div className="p-6 text-center text-xs text-zinc-500">
                        No scheduled tasks have fired yet.
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-800/80">
                        {scheduledTasks.map((t) => (
                          <div
                            key={t.id}
                            className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs"
                          >
                            <div>
                              <div className="font-semibold text-zinc-100">{t.title}</div>
                              <div className="text-zinc-400">
                                {t.content_series} • Triggered {formatRelativeOrDate(t.created_at)}
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-zinc-400">{t.current_stage}</span>
                              <StatusBadge status={t.status} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ==================== 4. MUSIC STUDIO ==================== */}
            {section === 'music' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">Signature Music Studio</h1>
                  <p className="text-sm text-zinc-400 mt-0.5">
                    Original Amapiano + Afrobeats Fusion songs via MiniMax Music 3 Q4_0 GGUF (Kaggle @happink)
                  </p>
                </div>

                <form
                  onSubmit={handleGenerateMusic}
                  className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 flex flex-col sm:flex-row gap-3"
                >
                  <input
                    value={musicTheme}
                    onChange={(e) => setMusicTheme(e.target.value)}
                    placeholder="Optional vibe / hook direction (e.g., Sunset Lagos rooftop log-drum club anthem, 113 BPM)..."
                    className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={generatingMusic}
                    className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shrink-0 disabled:opacity-50"
                  >
                    {generatingMusic ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Music2 className="w-4 h-4" />
                    )}
                    Compose Original Song
                  </button>
                </form>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tracks.map((t) => (
                    <div
                      key={t.id}
                      className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-sm text-zinc-100">{t.title}</div>
                          <div className="text-xs text-fuchsia-400">
                            {t.genre} • {t.bpm} BPM • {t.musical_key} • {t.duration_seconds?.toFixed(1)}s
                          </div>
                        </div>
                        <StatusBadge status={t.status} />
                      </div>

                      {t.audio_url && (
                        <audio controls src={t.audio_url} className="w-full h-10" preload="metadata" />
                      )}

                      <div className="text-xs text-zinc-400 line-clamp-2">{t.music_prompt}</div>

                      <details className="text-xs bg-zinc-950 rounded-xl p-3 border border-zinc-800">
                        <summary className="cursor-pointer font-medium text-zinc-300">
                          Original Vocals, Hook & Song Structure
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap font-sans text-zinc-400 leading-relaxed">
                          {t.lyrics}
                        </pre>
                      </details>

                      <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1">
                        <span>{formatRelativeOrDate(t.created_at)}</span>
                        {t.audio_url && (
                          <a
                            href={t.audio_url}
                            download={t.file_name}
                            className="text-fuchsia-400 hover:text-fuchsia-300 flex items-center gap-1"
                          >
                            <Download className="w-3.5 h-3.5" /> MP3 ({formatBytes(t.file_size_bytes)})
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ==================== 5. VIDEO LIBRARY ==================== */}
            {section === 'library' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">Video Library</h1>
                    <p className="text-sm text-zinc-400 mt-0.5">
                      Retained 20–40s photorealistic Scarlett Monroe videos ({videos.length} active)
                    </p>
                  </div>
                  <button
                    onClick={handleGenerateVideo}
                    disabled={generatingVideo}
                    className="px-4 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-sm font-semibold flex items-center gap-2"
                  >
                    <Sparkles className="w-4 h-4" /> New Video
                  </button>
                </div>

                {videos.length === 0 ? (
                  <div className="p-12 rounded-2xl bg-zinc-900/60 border border-zinc-800 text-center text-sm text-zinc-400">
                    No active videos in library. Click &ldquo;New Video&rdquo; to generate one!
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {videos.map((v) => (
                      <div
                        key={v.id}
                        className="rounded-2xl bg-zinc-900/70 border border-zinc-800/80 overflow-hidden flex flex-col"
                      >
                        {v.video_url ? (
                          <video
                            src={v.video_url}
                            poster={v.thumbnail_url || undefined}
                            controls
                            preload="metadata"
                            className="w-full aspect-[9/16] max-h-96 object-cover bg-black"
                          />
                        ) : (
                          <div className="aspect-[9/16] max-h-72 bg-zinc-950 flex flex-col items-center justify-center p-4 text-xs text-zinc-500 gap-2">
                            {v.status !== 'failed' && <Loader2 className="w-5 h-5 animate-spin text-fuchsia-400" />}
                            <span>{v.current_stage}</span>
                          </div>
                        )}
                        <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                          <div className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-fuchsia-400">
                                {v.content_series}
                              </span>
                              <StatusBadge status={v.status} />
                            </div>
                            <h3 className="font-bold text-sm">{v.title}</h3>
                            <p className="text-xs text-zinc-400 line-clamp-2">{v.visual_concept}</p>
                            {v.status === 'completed' && (
                              <div className="pt-3 space-y-2" data-testid="social-metadata">
                                {v.social_caption ? <>
                                  <p className="text-sm text-zinc-200 whitespace-pre-wrap">{v.social_caption}</p>
                                  <p className="text-xs text-fuchsia-300 break-words">{(v.hashtags || []).join(' ')}</p>
                                  <button className="px-3 py-2 rounded-lg bg-zinc-800 text-xs" onClick={async (e) => {
                                    const button=e.currentTarget;
                                    const text=v.social_caption+'\n\n'+(v.hashtags || []).join(' ');
                                    try { await navigator.clipboard.writeText(text); button.textContent='Copied!'; }
                                    catch { button.textContent='Copy unavailable — select text above'; }
                                  }}>Copy caption &amp; hashtags</button>
                                </> : <p className="text-xs text-zinc-500">{v.caption_status === 'failed' ? 'Caption analysis failed; retry pending.' : 'Analyzing finished video for caption and hashtags…'}</p>}
                              </div>
                            )}
                          </div>

                          <div className="space-y-2 pt-2 border-t border-zinc-800/80 text-xs">
                            <div className="flex items-center justify-between text-zinc-400">
                              <span>Duration: {v.duration_seconds ? `${v.duration_seconds.toFixed(1)}s` : '—'}</span>
                              <span className="text-[11px] text-amber-300">{formatExpiryBadge(v)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setInspectVideo(v)}
                                className="flex-1 py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium"
                              >
                                Inspect Plan
                              </button>
                              {v.video_url && (
                                <a
                                  href={v.video_url}
                                  download={v.video_file_name}
                                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                                  title="Download MP4"
                                >
                                  <Download className="w-4 h-4" />
                                </a>
                              )}
                              <button
                                onClick={() => handleDeleteVideo(v.id)}
                                className="p-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900/60 text-rose-300"
                                title="Delete Video File"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ==================== 6. CHARACTER REFERENCES ==================== */}
            {section === 'character' && characterData && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">
                    Scarlett Monroe — Permanent Character Identity
                  </h1>
                  <p className="text-sm text-zinc-400 mt-0.5">
                    3 downloaded & SHA-256 verified persistent reference image files stored on server & mounted directly in Kaggle GPU workers
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {(characterData.references || []).map((r: CharacterReference) => (
                    <div
                      key={r.id}
                      className="rounded-2xl bg-zinc-900/70 border border-zinc-800/80 overflow-hidden"
                    >
                      <img
                        src={r.publicUrl}
                        alt={r.label}
                        className="w-full h-80 object-cover object-top bg-zinc-950"
                      />
                      <div className="p-4 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-sm">{r.label}</span>
                          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/30">
                            <ShieldCheck className="w-3.5 h-3.5" /> Persistent File
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400">{r.role}</p>
                        <div className="text-[11px] font-mono text-zinc-500 space-y-0.5 pt-1 border-t border-zinc-800">
                          <div>File: {r.filename} ({formatBytes(r.sizeBytes)})</div>
                          <div className="truncate">SHA256: {r.sha256}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Weighted Series Distribution Verification */}
                <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-bold text-base">Weighted Content Series Distribution</h2>
                      <p className="text-xs text-zinc-400">
                        Verify weighted random selection (35% / 30% / 20% / 15%) across 1,000 live draws
                      </p>
                    </div>
                    <button
                      onClick={handleSimulateWeights}
                      className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold"
                    >
                      Run 1,000-Draw Simulation
                    </button>
                  </div>
                  {simResult && (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                      {Object.entries(simResult).map(([name, count]) => (
                        <div key={name} className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
                          <div className="font-semibold text-zinc-200">{name}</div>
                          <div className="text-fuchsia-400 font-mono text-sm mt-1">
                            {((count / 1000) * 100).toFixed(1)}% ({count}/1000)
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Verbatim 12-Section Identity Specification */}
                <details className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                  <summary className="cursor-pointer font-semibold text-sm text-zinc-200">
                    View Locked 12-Part Permanent Character Identity Prompt
                  </summary>
                  <pre className="mt-4 p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed">
                    {characterData.permanent_identity_instruction}
                  </pre>
                </details>
              </div>
            )}

            {/* ==================== 7. GENERATION HISTORY ==================== */}
            {section === 'history' && (
              <div className="space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight">
                      Generation History & Uniqueness Ledger
                    </h1>
                    <p className="text-sm text-zinc-400 mt-0.5">
                      Persistent PostgreSQL audit trail preventing repetitive scripts, outfits, locations, choreography & lyrics
                    </p>
                  </div>
                  <input
                    value={historyFilter}
                    onChange={(e) => setHistoryFilter(e.target.value)}
                    placeholder="Filter by series, title, location..."
                    className="px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-sm w-full sm:w-64"
                  />
                </div>

                <div className="rounded-2xl bg-zinc-900/70 border border-zinc-800/80 overflow-hidden divide-y divide-zinc-800/80">
                  {historyRows
                    .filter((h) =>
                      !historyFilter
                        ? true
                        : `${h.title} ${h.content_series} ${h.location_setting} ${h.outfit_styling}`
                            .toLowerCase()
                            .includes(historyFilter.toLowerCase())
                    )
                    .map((h) => (
                      <div
                        key={h.id}
                        className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-zinc-900/90 transition"
                      >
                        <div className="space-y-1 max-w-2xl">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-sm">{h.title}</span>
                            <StatusBadge status={h.status} />
                            <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                              {h.content_series}
                            </span>
                            <span className="text-[11px] text-zinc-500">({h.trigger_type})</span>
                          </div>
                          <p className="text-xs text-zinc-400 line-clamp-2">{h.visual_concept}</p>
                          <div className="text-[11px] text-zinc-500 flex flex-wrap gap-3">
                            <span>Created: {formatRelativeOrDate(h.created_at)}</span>
                            <span>Duration: {h.duration_seconds ? `${h.duration_seconds.toFixed(1)}s` : '—'}</span>
                            <span>
                              Similarity Score: {(Number(h.similarity_score || 0) * 100).toFixed(1)}% ( Passed )
                            </span>
                            <span>Retention: {formatExpiryBadge(h)}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => setInspectVideo(h)}
                            className="px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium"
                          >
                            Full Metadata & Timeline
                          </button>
                        </div>
                      </div>
                    ))}
                </div>

                {workflows && (
                  <details className="p-5 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                    <summary className="cursor-pointer font-semibold text-sm text-zinc-200">
                      Canonical ComfyUI Layer 2 Workflow Definitions (Music 3 Q4_0 GGUF + MiniMax H3 Ref2VA)
                    </summary>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
                      <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 overflow-x-auto max-h-80">
                        {JSON.stringify(workflows.music, null, 2)}
                      </pre>
                      <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 overflow-x-auto max-h-80">
                        {JSON.stringify(workflows.video, null, 2)}
                      </pre>
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* ==================== 8. SETTINGS ==================== */}
            {section === 'settings' && (
              <div className="space-y-6">
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">Platform Settings & Infrastructure</h1>
                  <p className="text-sm text-zinc-400 mt-0.5">
                    Automatic 72-hour video retention policy, Kaggle GPU model persistence, and Blitz.cloud PostgreSQL status
                  </p>
                </div>

                {/* Automatic Video Deletion Toggle */}
                <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1 max-w-2xl">
                      <div className="flex items-center gap-2.5">
                        <h2 className="font-bold text-base">Automatic Video Deletion (72 Hours)</h2>
                        <span
                          className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            autoDeleteEnabled
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          }`}
                        >
                          {autoDeleteEnabled ? 'ENABLED (Default)' : 'DISABLED'}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        When ON, generated MP4 files, thumbnails, and temporary render artifacts older than 72 hours are automatically deleted while preserving AI models, Scarlett Monroe reference assets, and core PostgreSQL history metadata. When OFF, generated videos remain stored indefinitely until manually deleted.
                      </p>
                    </div>

                    <button
                      onClick={handleToggleAutoDelete}
                      className={`px-5 py-2.5 rounded-xl font-semibold text-sm shrink-0 transition ${
                        autoDeleteEnabled
                          ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                      }`}
                    >
                      {autoDeleteEnabled ? 'Turn Auto-Delete OFF' : 'Turn Auto-Delete ON'}
                    </button>
                  </div>

                  <div className="pt-3 border-t border-zinc-800 flex items-center justify-between text-xs text-zinc-400">
                    <span>Trigger an immediate storage & expired-video cleanup check:</span>
                    <button
                      onClick={async () => {
                        const r = await api.runCleanupSweep();
                        notify(
                          'ok',
                          `Retention sweep finished (${r.deletedCount} expired video(s), ${r.tempFilesRemoved} temp file(s) cleaned)`
                        );
                        await refreshAll();
                      }}
                      className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium"
                    >
                      Run Cleanup Sweep Now
                    </button>
                  </div>
                </div>

                {/* Kaggle GPU Persistent Endpoints */}
                <div className="p-6 rounded-2xl bg-zinc-900/70 border border-zinc-800/80 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="font-bold text-base">Kaggle GPU Model Endpoints & Persistent Storage</h2>
                      <p className="text-xs text-zinc-400">
                        Models check attached Kaggle Datasets & local disk first so valid weights are never re-downloaded
                      </p>
                    </div>
                    <button
                      onClick={handleSyncModels}
                      disabled={syncingModels}
                      className="px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium flex items-center gap-2"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingModels ? 'animate-spin' : ''}`} />
                      Sync Now
                    </button>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {models.map((m) => (
                      <div
                        key={m.service_id}
                        className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-sm text-zinc-100">{m.model_name}</span>
                          <StatusBadge status={m.comfyui_ready ? 'online' : m.status} />
                        </div>
                        <div className="text-zinc-400 space-y-1 font-mono text-[11px]">
                          <div>Kaggle Account: @{m.username}</div>
                          <div>GPU Hardware: {m.gpu_name || 'Kaggle Tesla T4'}</div>
                          <div className="truncate">Endpoint: {m.endpoint_url || 'Discovering tunnel...'}</div>
                          <div>
                            Persistent Dataset Cache: {m.dataset_cached ? 'ACTIVE (No Re-Download)' : 'Building'}
                          </div>
                          <div>Last Heartbeat: {formatRelativeOrDate(m.last_heartbeat_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Inspector Modal */}
      {inspectVideo && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-3xl w-full max-h-[88vh] overflow-y-auto p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs text-fuchsia-400 font-semibold">{inspectVideo.content_series}</div>
                <h3 className="text-lg font-bold">{inspectVideo.title}</h3>
              </div>
              <button
                onClick={() => setInspectVideo(null)}
                className="p-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Storyline & Script</span>
                <span className="text-zinc-200">{inspectVideo.storyline}</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Camera & Continuity Plan</span>
                <span className="text-zinc-200">{inspectVideo.camera_plan}</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Outfit Styling</span>
                <span className="text-zinc-200">{inspectVideo.outfit_styling}</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Location & Lighting</span>
                <span className="text-zinc-200">{inspectVideo.location_setting}</span>
              </div>
            </div>

            {inspectVideo.scene_plan?.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-zinc-300">Scene-by-Scene Master Timeline</div>
                {inspectVideo.scene_plan.map((s) => (
                  <div key={s.scene_number} className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs">
                    <div className="font-semibold text-fuchsia-300">
                      Scene {s.scene_number} ({s.start_sec}s – {s.end_sec}s) • {s.camera_movement}
                    </div>
                    <div className="text-zinc-200 mt-1">{s.choreography}</div>
                  </div>
                ))}
              </div>
            )}

            {inspectVideo.lyrics && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-zinc-300">Synced Amapiano + Afrobeats Lyrics</div>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 whitespace-pre-wrap font-sans">
                  {inspectVideo.lyrics}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
