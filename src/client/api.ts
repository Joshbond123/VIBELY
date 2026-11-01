async function request<T = any>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  getOverview: () => request('/api/overview'),
  getHealth: () => request('/api/health'),
  syncModels: (payload?: { service_id?: string; endpoint_url?: string }) =>
    request('/api/models/sync', { method: 'POST', body: JSON.stringify(payload || {}) }),

  getVideos: (includeDeleted = false) =>
    request(`/api/videos?includeDeleted=${includeDeleted ? 'true' : 'false'}`),
  getVideo: (id: string) => request(`/api/videos/${id}`),
  generateVideo: (series_id?: string) =>
    request('/api/videos/generate', {
      method: 'POST',
      body: JSON.stringify({ series_id: series_id || 'weighted_random' }),
    }),
  deleteVideo: (id: string) => request(`/api/videos/${id}`, { method: 'DELETE' }),

  getMusic: () => request('/api/music'),
  generateMusic: (theme?: string) =>
    request('/api/music/generate', { method: 'POST', body: JSON.stringify({ theme }) }),
  deleteMusic: (id: string) => request(`/api/music/${id}`, { method: 'DELETE' }),

  getAutomations: () => request('/api/automations'),
  createAutomation: (payload: Record<string, any>) =>
    request('/api/automations', { method: 'POST', body: JSON.stringify(payload) }),
  updateAutomation: (id: string, payload: Record<string, any>) =>
    request(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteAutomation: (id: string) => request(`/api/automations/${id}`, { method: 'DELETE' }),
  tickAutomations: () => request('/api/automations/tick', { method: 'POST' }),

  getCharacter: (simulate = 0) =>
    request(`/api/character${simulate ? `?simulate=${simulate}` : ''}`),
  getHistory: () => request('/api/history'),

  getSettings: () => request('/api/settings'),
  setAutoDelete: (enabled: boolean) =>
    request('/api/settings/auto-delete', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
  runCleanupSweep: () => request('/api/settings/cleanup', { method: 'POST' }),
};
