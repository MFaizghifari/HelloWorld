// Backend adapters. All three expose the same async interface so the UI never
// cares where data lives:
//   forms:     listForms, getForm, saveForm, deleteForm
//   answers:   submit, logEvent, getResults, getExperiment, exportAll?
//   files:     uploadFile (respondents), uploadMedia (builder images), fileLink
//   accounts:  session, login, setup, logout, team*, …  (see `team`)
// `team` says how accounts work: 'real' (Cloudflare), 'simulated' (browser
// storage, demo) or false (Apps Script: one admin key).
import { getConfig, getAdminKey } from './config.js';
import { uid, partialsEnabled, contactFrom, cleanPartialAnswers, PARTIAL_RETENTION_DAYS, fileProblem } from './logic.js';
import { experimentDays } from './stats.js';

// ─── Local (browser storage) — for demos and offline design work ───────────
const LS = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) {
      throw new Error('Penyimpanan browser tidak tersedia (mode privat atau penyimpanan penuh).');
    }
  },
};

/** Uploaded files in local mode live in IndexedDB (localStorage is too small for images). */
const IDB = {
  db: null,
  open() {
    this.db ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('formflow', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const out = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(out?.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  put(key, value) { return this.run('readwrite', (s) => s.put(value, key)); },
  get(key) { return this.run('readonly', (s) => s.get(key)); },
  deleteWhere(test) {
    return this.run('readwrite', (s) => {
      s.openCursor().onsuccess = (e) => { const c = e.target.result; if (!c) return; if (test(c.value)) c.delete(); c.continue(); };
    });
  },
};

const localLinks = new Map(); // ref → object URL, made once per page

/** Shrinks a builder image to at most 1600 px so it fits in browser storage (local mode only). */
async function downscale(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
}

// Team accounts in local mode are a simulation (no passwords, one browser),
// so the team screens can be tried out before deploying.
const TEAM_KEY = 'tf_team';
function localTeam() {
  const t = LS.read(TEAM_KEY, null);
  if (t?.members?.length) return t;
  const me = { id: 'u_local', name: 'Anda', email: 'anda@contoh.id', role: 'owner', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
  return { me: me.id, members: [me], invites: [], activity: [] };
}
function saveTeam(t) { LS.write(TEAM_KEY, t); }
function logLocal(t, action, target, detail = '') {
  const me = t.members.find((m) => m.id === t.me);
  t.activity.unshift({ ts: new Date().toISOString(), actor: me?.name || 'Anda', action, target, detail });
  t.activity = t.activity.slice(0, 50);
}
function activity(action, target, detail) {
  try { const t = localTeam(); logLocal(t, action, target, detail); saveTeam(t); } catch { /* storage unavailable */ }
}

const localBackend = {
  name: 'local',
  team: 'simulated',
  files: true,
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
    const before = forms[form.id];
    const saved = { ...form, updatedAt: new Date().toISOString() };
    forms[form.id] = saved;
    LS.write('tf_forms', forms);
    activity(before ? 'form.publish' : 'form.create', form.title || form.id);
    if (form.experiment?.status !== before?.experiment?.status && form.experiment?.status === 'running') activity('experiment.start', form.title || form.id);
    return { form: saved, sheetUrl: '' };
  },
  async deleteForm(id) {
    const forms = LS.read('tf_forms', {});
    const title = forms[id]?.title;
    delete forms[id];
    LS.write('tf_forms', forms);
    try { ['resp', 'evt', 'part'].forEach((k) => localStorage.removeItem(`tf_${k}_${id}`)); } catch { /* storage unavailable */ }
    try { await IDB.deleteWhere((v) => v?.formId === id); } catch { /* no IndexedDB */ }
    activity('form.delete', title || id);
  },
  async submit(formId, payload) {
    const list = LS.read(`tf_resp_${formId}`, []);
    const responseId = uid('r');
    list.push({ ...payload, responseId, submittedAt: new Date().toISOString() });
    LS.write(`tf_resp_${formId}`, list);
    // A finished response replaces its unfinished copy.
    const sid = payload.meta?.sessionId;
    const parts = LS.read(`tf_part_${formId}`, {});
    if (sid && parts[sid]) { delete parts[sid]; LS.write(`tf_part_${formId}`, parts); }
    // The Apps Script backend records this server-side to save a request.
    const { device, source, variant } = payload.meta || {};
    await this.logEvent(formId, { type: 'complete', sessionId: sid, path: payload.meta?.path || [], device, source, variant });
    return { responseId };
  },
  async logEvent(formId, event) {
    const { answers, hidden, ...evt } = event;
    const list = LS.read(`tf_evt_${formId}`, []);
    list.push({ ...evt, ts: new Date().toISOString() });
    LS.write(`tf_evt_${formId}`, list.slice(-50000));
    if (answers) savePartialLocal(formId, event);
  },
  async getResults(formId) {
    const cutoff = Date.now() - PARTIAL_RETENTION_DAYS * 86400000;
    const partials = Object.values(LS.read(`tf_part_${formId}`, {}))
      .filter((p) => new Date(p.updatedAt).getTime() >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      responses: LS.read(`tf_resp_${formId}`, []),
      events: LS.read(`tf_evt_${formId}`, []),
      partials,
      sheetUrl: '',
    };
  },
  async getExperiment(formId, experimentId) {
    return experimentDays(LS.read(`tf_resp_${formId}`, []), LS.read(`tf_evt_${formId}`, []), experimentId);
  },
  async uploadFile(formId, { question, sessionId, file, onProgress }) {
    const problem = fileProblem(question, file);
    if (problem) throw new Error(problem);
    // A short visible progress run, like a real upload.
    for (const p of [0.35, 0.7, 1]) { onProgress?.(p); await new Promise((r) => setTimeout(r, 120)); }
    const ref = `idb:${uid('f')}`;
    await IDB.put(ref, { blob: file, name: file.name, type: file.type, size: file.size, formId, sessionId, questionId: question.id });
    return { ref, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
  },
  async uploadMedia(_formId, file) {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) throw new Error('Gambar harus JPG, PNG, GIF, atau WebP.');
    return { url: await downscale(file) };
  },
  async fileLink(f) {
    if (f.view || f.url) return f.view || f.url;
    if (!String(f.ref || '').startsWith('idb:')) return '';
    if (!localLinks.has(f.ref)) {
      const rec = await IDB.get(f.ref).catch(() => null);
      localLinks.set(f.ref, rec?.blob ? URL.createObjectURL(rec.blob) : '');
    }
    return localLinks.get(f.ref);
  },
  // ─── Simulated team ───────────────────────────────────────────────────────
  async session() {
    const t = localTeam();
    const me = t.members.find((m) => m.id === t.me) || t.members[0];
    return { user: { ...me, role: t.viewAs || me.role }, simulated: true };
  },
  /** Demo only: see the builder as another role. */
  async viewAs(role) { const t = localTeam(); t.viewAs = role === 'owner' ? undefined : role; saveTeam(t); },
  async teamList() {
    const t = localTeam();
    return { me: t.members.find((m) => m.id === t.me), members: t.members, invites: t.invites, activity: t.activity };
  },
  async teamInvite(email, role) {
    const t = localTeam();
    const e = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new Error('Email tidak valid.');
    if (t.members.some((m) => m.email === e)) throw new Error('Email ini sudah menjadi anggota tim.');
    t.invites = t.invites.filter((i) => i.email !== e);
    const invite = { id: uid('i'), email: e, role, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
    t.invites.unshift(invite);
    logLocal(t, 'team.invite', e, role);
    saveTeam(t);
    return { invite, token: `contoh-${invite.id}` };
  },
  async teamRevokeInvite(id) {
    const t = localTeam();
    const inv = t.invites.find((i) => i.id === id);
    t.invites = t.invites.filter((i) => i.id !== id);
    if (inv) logLocal(t, 'team.invite_revoke', inv.email);
    saveTeam(t);
  },
  async teamSetRole(userId, role) {
    const t = localTeam();
    const m = t.members.find((x) => x.id === userId);
    if (!m || m.role === 'owner') throw new Error('Peran pemilik tidak bisa diubah.');
    logLocal(t, 'team.role', m.email, `${m.role} → ${role}`);
    m.role = role;
    saveTeam(t);
  },
  async teamRemove(userId) {
    const t = localTeam();
    const m = t.members.find((x) => x.id === userId);
    if (!m || m.role === 'owner') throw new Error('Pemilik tidak bisa dihapus.');
    t.members = t.members.filter((x) => x.id !== userId);
    logLocal(t, 'team.remove', m.email);
    saveTeam(t);
  },
  async teamResetLink(userId) {
    const t = localTeam();
    const m = t.members.find((x) => x.id === userId);
    logLocal(t, 'account.reset_link', m?.email || '');
    saveTeam(t);
    return { token: `contoh-reset-${userId}`, email: m?.email, hours: 24 };
  },
};

/** Same rules as the servers: only when the form opts in and a valid contact is known. */
function savePartialLocal(formId, { sessionId, answers, hidden = {}, path = [] }) {
  const form = LS.read('tf_forms', {})[formId];
  if (!form || !partialsEnabled(form) || !sessionId) return;
  const clean = cleanPartialAnswers(form, answers);
  const contact = contactFrom(form, clean);
  if (!contact) return;
  const parts = LS.read(`tf_part_${formId}`, {});
  parts[sessionId] = {
    sessionId, updatedAt: new Date().toISOString(), answers: clean, hidden, contact,
    lastQuestion: path[path.length - 1] || '', answeredCount: Object.keys(clean).length,
  };
  LS.write(`tf_part_${formId}`, parts);
}

// ─── Remote backends (Google Apps Script, Cloudflare Worker) ───────────────
// Both speak the same JSON protocol. POST bodies are sent as text/plain to
// avoid a CORS preflight, which Apps Script web apps do not answer.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION_KEY = 'tf_session';

export function getSessionToken() {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}
export function setSessionToken(t) {
  try { if (t) localStorage.setItem(SESSION_KEY, t); else localStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ }
}

/** POST with upload progress (fetch cannot report it). */
function xhrPost(url, body, { headers = {}, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let data;
      try { data = JSON.parse(x.responseText); } catch { data = { ok: false, error: `Upload gagal (HTTP ${x.status}).` }; }
      if (!data.ok) reject(new Error(data.error || 'Upload gagal.')); else resolve(data);
    };
    x.onerror = () => reject(new Error('Koneksi terputus saat mengunggah. Coba lagi.'));
    x.send(body);
  });
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function httpBackend(url, name) {
  const cloud = name === 'cloud';
  // Only the Worker deduplicates submissions (one per session), so only it gets
  // automatic retries; retrying Apps Script could create duplicate rows.
  const retries = cloud ? 3 : 0;
  const base = new URL(url, location.href);
  const sub = (path) => `${base.origin}${base.pathname.replace(/\/?$/, '')}/${path}`;

  async function call(action, body = {}, { admin = false, retry = 0 } = {}) {
    const payload = { action, ...body };
    // Cloudflare: the signed-in member's session. Apps Script: the admin key.
    if (admin) { if (cloud) payload.token ??= getSessionToken(); else payload.key = getAdminKey(); }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload),
          redirect: 'follow',
        });
      } catch (err) {
        if (attempt < retry) { await sleep(1000 * 2 ** attempt); continue; }
        throw new Error('Koneksi gagal. Periksa internet Anda.');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retry) { await sleep(1000 * 2 ** attempt); continue; }
      const data = await res.json().catch(() => ({ ok: false, error: `Respons backend tidak valid (HTTP ${res.status}).` }));
      if (!data.ok) {
        // The builder listens for this and shows the sign-in screen.
        if (cloud && admin && res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('formflow:signed-out', { detail: data.error }));
        const err = new Error(data.error || 'Permintaan gagal.');
        err.status = res.status;
        throw err;
      }
      return data;
    }
  }

  const backend = {
    name,
    team: cloud ? 'real' : false,
    files: true,
    async listForms() { return (await call('listForms', {}, { admin: true })).forms; },
    async getForm(id) {
      // GET is cacheable and cheaper for the public form view.
      const sep = url.includes('?') ? '&' : '?';
      const res = await fetch(`${url}${sep}action=getForm&id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({ ok: false, error: `Backend tidak merespons dengan benar (HTTP ${res.status}).` }));
      if (!data.ok) throw new Error(data.error || 'Form tidak ditemukan.');
      return data.form;
    },
    async saveForm(form) {
      const d = await call('saveForm', { form }, { admin: true });
      return { form: d.form, sheetUrl: d.sheetUrl };
    },
    async deleteForm(id) { await call('deleteForm', { id }, { admin: true }); },
    async submit(formId, payload) {
      const d = await call('submit', { formId, ...payload }, { retry: retries });
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
    /**
     * Apps Script returns raw rows ({responses, events}); the Worker returns
     * pre-computed {stats} plus the latest 100 responses.
     */
    async getResults(formId, days = 30) {
      const d = await call('getResults', { formId, days }, { admin: true });
      return { responses: d.responses, events: d.events || [], partials: d.partials || [], stats: d.stats || null, totalResponses: d.totalResponses, sheetUrl: d.sheetUrl, sheetStatus: d.sheetStatus || '' };
    },
    async getExperiment(formId, experimentId, { startedAt } = {}) {
      if (cloud) return (await call('getExperiment', { formId, experimentId }, { admin: true })).days;
      const days = Math.min(400, Math.ceil((Date.now() - new Date(startedAt || Date.now()).getTime()) / 86400000) + 1);
      const d = await call('getResults', { formId, days }, { admin: true });
      return experimentDays(d.responses || [], d.events || [], experimentId);
    },
    async uploadFile(formId, { question, sessionId, file, onProgress }) {
      const problem = fileProblem(question, file);
      if (problem) throw new Error(problem);
      if (cloud) {
        const q = new URLSearchParams({ form: formId, question: question.id, session: sessionId, name: file.name });
        return (await xhrPost(`${sub('upload')}?${q}`, file, { onProgress })).file;
      }
      // Apps Script reads JSON only: the file travels base64-encoded and lands in Google Drive.
      const data = await toBase64(file);
      const body = JSON.stringify({ action: 'upload', formId, questionId: question.id, sessionId, name: file.name, type: file.type, data });
      return (await xhrPost(url, body, { headers: { 'Content-Type': 'text/plain;charset=utf-8' }, onProgress })).file;
    },
    async uploadMedia(formId, file) {
      if (cloud) {
        const q = new URLSearchParams({ form: formId, name: file.name });
        const res = await fetch(`${sub('media')}?${q}`, { method: 'POST', body: file, headers: { Authorization: `Bearer ${getSessionToken()}` } });
        const d = await res.json().catch(() => ({ ok: false, error: `Upload gagal (HTTP ${res.status}).` }));
        if (!d.ok) throw new Error(d.error || 'Upload gagal.');
        return { url: new URL(d.path, base).href };
      }
      const data = await toBase64(file);
      return { url: (await call('media', { formId, name: file.name, type: file.type, data }, { admin: true })).url };
    },
    async fileLink(f) { return f.view || f.url || ''; },
  };

  if (cloud) {
    Object.assign(backend, {
      async exportAll(formId, onProgress) {
        const all = [];
        let after = null;
        do {
          const d = await call('exportResponses', { formId, after, limit: 2000 }, { admin: true });
          all.push(...d.responses);
          after = d.next;
          onProgress?.(all.length);
        } while (after);
        return all;
      },
      async info() { return call('info', {}, { admin: true }); },
      async syncNow() { return call('syncSheets', {}, { admin: true }); },
      // ─── Accounts ───────────────────────────────────────────────────────────
      async authStatus() { return call('authStatus'); },
      async session() {
        if (!getSessionToken()) return null;
        try { return { user: (await call('authMe', {}, { admin: true })).user }; } catch (err) {
          if (err.status === 401) { setSessionToken(''); return null; }
          throw err;
        }
      },
      async login(email, password) { const d = await call('authLogin', { email, password }); setSessionToken(d.token); return d.user; },
      async setup(fields) { const d = await call('authSetup', fields); setSessionToken(d.token); return d.user; },
      async logout() { try { await call('authLogout', {}, { admin: true }); } finally { setSessionToken(''); } },
      async inviteInfo(inviteToken) { return call('inviteInfo', { inviteToken }); },
      async acceptInvite(inviteToken, fields) { const d = await call('inviteAccept', { inviteToken, ...fields }); setSessionToken(d.token); return d.user; },
      async updateAccount(fields) { return (await call('accountUpdate', fields, { admin: true })).user; },
      async teamList() { return call('teamList', {}, { admin: true }); },
      async teamInvite(email, role) { return call('teamInvite', { email, role }, { admin: true }); },
      async teamRevokeInvite(id) { return call('teamRevokeInvite', { id }, { admin: true }); },
      async teamSetRole(userId, role) { return call('teamSetRole', { userId, role }, { admin: true }); },
      async teamRemove(userId) { return call('teamRemove', { userId }, { admin: true }); },
      async teamResetLink(userId) { return call('teamResetLink', { userId }, { admin: true }); },
      /** Account recovery with the ADMIN_KEY secret (e.g. the owner forgot the password). */
      async recoverWithKey(key, email) { return call('teamResetLink', { key, email }); },
      async transferOwner(userId) { return call('teamTransferOwner', { userId }, { admin: true }); },
    });
  }
  return backend;
}

export function getBackend() {
  const cfg = getConfig();
  if (cfg.backend === 'cloud' && cfg.apiUrl) return httpBackend(cfg.apiUrl, 'cloud');
  if (cfg.backend === 'sheets' && cfg.sheetsUrl) return httpBackend(cfg.sheetsUrl, 'sheets');
  return localBackend;
}
