// Zentrales API-Client Modul für Admin-UI
// Alle Calls gehen gegen die admin-api via Caddy (/api/*)
// X-Admin-Key wird von Caddy via header_up injiziert (aus $ADMIN_API_KEY)

const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const api = {
  health:   ()          => apiFetch('/health'),
  stats:    ()          => apiFetch('/stats'),

  keys: {
    list:   ()          => apiFetch('/keys'),
    create: (data)      => apiFetch('/keys', { method: 'POST', body: data }),
    revoke: (id)        => apiFetch(`/keys/${id}`, { method: 'DELETE' }),
  },

  episodes: {
    list:   (params)    => apiFetch('/episodes?' + new URLSearchParams(params)),
    delete: (id)        => apiFetch(`/episodes/${id}`, { method: 'DELETE' }),
  },

  rules: {
    list:    ()         => apiFetch('/rules'),
    confirm: (id)       => apiFetch(`/rules/${id}/confirm`, { method: 'POST' }),
    delete:  (id)       => apiFetch(`/rules/${id}`, { method: 'DELETE' }),
  },

  logs:     (params)    => apiFetch('/logs?' + new URLSearchParams(params)),
  backup:   ()          => apiFetch('/backup', { method: 'POST' }),
  gc:       ()          => apiFetch('/gc',     { method: 'POST' }),
};

function formatDate(val) {
  if (!val) return '—';
  // Support both ISO strings (memcp) and unix timestamps (legacy)
  const d = typeof val === 'string' ? new Date(val) : new Date(val * 1000);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('In Zwischenablage kopiert');
  });
}

function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;bottom:24px;right:24px;background:${type==='error'?'#f04747':'#22d47e'};color:white;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.4);font-weight:500`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
