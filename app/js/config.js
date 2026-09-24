// ─── Deployment config ──────────────────────────────────────────────────────
// Priority (highest first):
//   1. ?api= in a share link (only Google Apps Script URLs or this same origin)
//   2. The builder's "Pengaturan" panel (stored in this browser only)
//   3. window.FORMFLOW_CONFIG — injected by the Cloudflare Worker via /formflow-config.js
//   4. DEFAULT_CONFIG below — edit this when hosting the static files elsewhere
export const DEFAULT_CONFIG = {
  backend: 'local', // 'local' (browser only, demo) | 'sheets' (Apps Script) | 'cloud' (Cloudflare Worker + D1)
  sheetsUrl: '', // e.g. 'https://script.google.com/macros/s/AKfy.../exec'
  apiUrl: '', // Cloudflare Worker API, e.g. '/api' or 'https://formflow.example.workers.dev/api'
};

const KEY = 'tf_config';

export function serverConfig() {
  const c = typeof window !== 'undefined' ? window.FORMFLOW_CONFIG : null;
  return c && typeof c === 'object' ? c : {};
}

function sameOrigin(url) {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
}

export function getConfig() {
  let cfg = { ...DEFAULT_CONFIG, ...serverConfig() };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) cfg = { ...cfg, ...saved };
  } catch { /* storage unavailable */ }
  // Share links may carry the backend URL so forms work without editing this file.
  // Only Apps Script or same-origin URLs are accepted, so a crafted link cannot
  // render someone else's form (and collect answers) on this domain.
  const api = new URLSearchParams(location.search).get('api');
  if (api && /^https:\/\/script\.google(usercontent)?\.com\//.test(api)) {
    cfg = { ...cfg, backend: 'sheets', sheetsUrl: api };
  } else if (api && sameOrigin(api)) {
    cfg = { ...cfg, backend: 'cloud', apiUrl: api };
  }
  return cfg;
}

export function saveConfig(partial) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { /* ignore */ }
  const next = { ...saved, ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return getConfig();
}

export function getAdminKey() {
  try { return localStorage.getItem('tf_admin_key') || ''; } catch { return ''; }
}

export function setAdminKey(k) {
  try { localStorage.setItem('tf_admin_key', k); } catch { /* ignore */ }
}
