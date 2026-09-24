// ─── Deployment config ──────────────────────────────────────────────────────
// For production, paste your Google Apps Script Web App URL here so every
// visitor's browser talks to the same backend. The builder's "Pengaturan"
// panel can override this per-browser (handy while testing).
export const DEFAULT_CONFIG = {
  backend: 'local', // 'local' (browser only, demo) | 'sheets' (Google Apps Script → Google Sheets)
  sheetsUrl: '', // e.g. 'https://script.google.com/macros/s/AKfy.../exec'
};

const KEY = 'tf_config';

export function getConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) cfg = { ...cfg, ...saved };
  } catch { /* storage unavailable */ }
  // Share links may carry the backend URL so forms work without editing this file.
  const api = new URLSearchParams(location.search).get('api');
  if (api && /^https:\/\/script\.google(usercontent)?\.com\//.test(api)) {
    cfg = { ...cfg, backend: 'sheets', sheetsUrl: api };
  }
  return cfg;
}

export function saveConfig(partial) {
  const cur = getConfig();
  const next = { ...cur, ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

export function getAdminKey() {
  try { return localStorage.getItem('tf_admin_key') || ''; } catch { return ''; }
}

export function setAdminKey(k) {
  try { localStorage.setItem('tf_admin_key', k); } catch { /* ignore */ }
}
