// Backend adapters. Both expose the same async interface so the UI never
// cares where data lives.
import { getConfig, getAdminKey } from './config.js';
import { uid } from './logic.js';

// ─── Local (browser storage) — for demos and offline design work ───────────
const LS = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

const localBackend = {
  name: 'local',
  async listForms() {
    return Object.values(LS.read('tf_forms', {}))
      .map((f) => ({ id: f.id, title: f.title, updatedAt: f.updatedAt, sheetUrl: '' }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },
  async getForm(id) {
    const f = LS.read('tf_forms', {})[id];
    if (!f) throw new Error('Form tidak ditemukan.');
    return f;
  },
  async saveForm(form) {
    const forms = LS.read('tf_forms', {});
    const saved = { ...form, updatedAt: new Date().toISOString() };
    forms[form.id] = saved;
    LS.write('tf_forms', forms);
    return { form: saved, sheetUrl: '' };
  },
  async deleteForm(id) {
    const forms = LS.read('tf_forms', {});
    delete forms[id];
    LS.write('tf_forms', forms);
    localStorage.removeItem(`tf_resp_${id}`);
    localStorage.removeItem(`tf_evt_${id}`);
  },
  async submit(formId, payload) {
    const list = LS.read(`tf_resp_${formId}`, []);
    const responseId = uid('r');
    list.push({ ...payload, responseId, submittedAt: new Date().toISOString() });
    LS.write(`tf_resp_${formId}`, list);
    // The Apps Script backend records this server-side to save a request.
    await this.logEvent(formId, { type: 'complete', sessionId: payload.meta?.sessionId, path: payload.meta?.path || [] });
    return { responseId };
  },
  async logEvent(formId, event) {
    const list = LS.read(`tf_evt_${formId}`, []);
    list.push({ ...event, ts: new Date().toISOString() });
    LS.write(`tf_evt_${formId}`, list.slice(-50000));
  },
  async getResults(formId) {
    return {
      responses: LS.read(`tf_resp_${formId}`, []),
      events: LS.read(`tf_evt_${formId}`, []),
      sheetUrl: '',
    };
  },
};

// ─── Google Sheets via Apps Script Web App ─────────────────────────────────
// POST bodies are sent as text/plain to avoid a CORS preflight, which Apps
// Script web apps do not answer.
function sheetsBackend(url) {
  async function call(action, body = {}, { admin = false } = {}) {
    const payload = { action, ...body };
    if (admin) payload.key = getAdminKey();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const data = await res.json().catch(() => ({ ok: false, error: 'Respons backend tidak valid.' }));
    if (!data.ok) throw new Error(data.error || 'Permintaan gagal.');
    return data;
  }
  return {
    name: 'sheets',
    async listForms() { return (await call('listForms', {}, { admin: true })).forms; },
    async getForm(id) {
      // GET is cacheable and cheaper for the public form view.
      const res = await fetch(`${url}?action=getForm&id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Form tidak ditemukan.');
      return data.form;
    },
    async saveForm(form) {
      const d = await call('saveForm', { form }, { admin: true });
      return { form: d.form, sheetUrl: d.sheetUrl };
    },
    async deleteForm(id) { await call('deleteForm', { id }, { admin: true }); },
    async submit(formId, payload) {
      const d = await call('submit', { formId, ...payload });
      return { responseId: d.responseId };
    },
    async logEvent(formId, event, { beacon = false } = {}) {
      const body = JSON.stringify({ action: 'event', formId, ...event });
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
        return;
      }
      // Fire-and-forget: analytics must never block the respondent.
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: true })
        .catch(() => {});
    },
    async getResults(formId, days = 30) {
      const d = await call('getResults', { formId, days }, { admin: true });
      return { responses: d.responses, events: d.events, sheetUrl: d.sheetUrl };
    },
  };
}

export function getBackend() {
  const cfg = getConfig();
  if (cfg.backend === 'sheets' && cfg.sheetsUrl) return sheetsBackend(cfg.sheetsUrl);
  return localBackend;
}
