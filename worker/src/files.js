// Uploaded files in R2 (binding FILES).
//
//   POST /api/upload?form=&question=&session=&name=   respondent upload (public, rate-limited)
//   POST /api/media?form=&name=                       form image from the builder (editor+)
//   GET  /f/u/<form>/<id>                             respondent file: signed link or team login
//   GET  /m/<form>/<id>.<ext>                         form image, public
//
// Types are decided by the file's first bytes, never by the name or the
// browser's Content-Type, and SVG/HTML are never accepted, so an upload can
// not run script on this origin.
import { fileRules, allQuestions } from '../../app/js/logic.js';
import { can } from '../../app/js/roles.js';
import { HttpError, json, validId, validSession, randomHex, base64url, clientIp, limit, readCookie, safeEqual } from './http.js';
import { userFromToken, requirePermission, SESSION_COOKIE } from './auth.js';

const MEDIA_MAX = 5 * 1024 * 1024;
const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const SIGNED_TTL_SEC = 3600;
const PENDING_HOURS = 24;

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const starts = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
const OOXML = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OLE = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };

/** MIME type from the file's content (plus the extension to tell ZIP/OLE office files apart), or null. */
export function detectType(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ext = (String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
  if (b.length < 4) return null;
  if (starts(b, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (starts(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return 'image/heic';
    if (/^(mif1|msf1|heif)$/.test(brand)) return 'image/heif';
  }
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (starts(b, [0x50, 0x4B, 0x03, 0x04])) return OOXML[ext] || null;
  if (starts(b, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return OLE[ext] || null;
  if (ext === 'csv' || ext === 'txt') {
    // Plain text: valid UTF-8 without NUL bytes.
    if (b.includes(0)) return null;
    try { new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
    return ext === 'csv' ? 'text/csv' : 'text/plain';
  }
  return null;
}

/** A display name without paths or control characters. */
export function cleanFileName(raw) {
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  s = s.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 120) {
    const ext = (s.match(/(\.[^.]{1,6})$/) || ['', ''])[1];
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || 'file';
}

function needBucket(env) {
  if (!env.FILES) throw new HttpError(501, 'Penyimpanan file belum aktif. Buat bucket R2 "formflow-files" (lihat README), lalu deploy ulang.');
}

/** Reads the request body, stopping as soon as it passes `max` bytes. */
async function readBody(request, max) {
  const tooBig = () => new HttpError(413, `File lebih dari ${Math.round(max / 1024 / 1024)} MB.`);
  if (Number(request.headers.get('Content-Length') || 0) > max) throw tooBig();
  if (!request.body) throw new HttpError(400, 'File kosong.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw tooBig(); }
    chunks.push(value);
  }
  if (!size) throw new HttpError(400, 'File kosong.');
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return buf;
}

// ─── Respondent uploads ─────────────────────────────────────────────────────
export async function handleUpload(request, env, loadForm) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  needBucket(env);
  await limit(env.UPLOAD_LIMITER, `upload:${clientIp(request)}`);
  const url = new URL(request.url);
  const form = await loadForm(env, url.searchParams.get('form'));
  const questionId = String(url.searchParams.get('question') || '').slice(0, 60);
  const sessionId = validSession(url.searchParams.get('session'));
  if (!sessionId) throw new HttpError(400, 'Session tidak valid.');
  const q = allQuestions(form).find((x) => x.id === questionId); // only ids that exist in this form
  if (!q || q.type !== 'file_upload') throw new HttpError(400, 'Pertanyaan ini tidak menerima file.');
  const rules = fileRules(q);
  const name = cleanFileName(url.searchParams.get('name'));
  const bytes = await readBody(request, rules.maxBytes);
  const type = detectType(bytes, name);
  if (!type || !rules.types.includes(type)) throw new HttpError(415, `${name}: jenis file tidak diterima.`);
  // Replacing a file is fine; hundreds of uploads from one visit are not.
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads WHERE form_id = ? AND session_id = ? AND question_id = ?').bind(form.id, sessionId, q.id).first();
  if (Number(used.n) >= rules.maxFiles * 3) throw new HttpError(429, 'Terlalu banyak file untuk pertanyaan ini.');

  const key = `u/${form.id}/${randomHex(16)}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { name, formId: form.id, questionId: q.id, sessionId } });
  await env.DB.prepare(`INSERT INTO uploads (key, form_id, kind, question_id, session_id, name, type, size, created_at)
    VALUES (?, ?, 'answer', ?, ?, ?, ?, ?, ?)`).bind(key, form.id, q.id, sessionId, name, type, bytes.length, new Date().toISOString()).run();
  return json({ ok: true, file: { ref: key, name, type, size: bytes.length } });
}

/**
 * Turns the file answers of a submission into server-checked values: every
 * file must be an upload of this form, question and session. Returns
 * { answers, keys } where keys are to be attached to the response.
 */
export async function resolveFileAnswers(env, form, questions, answers, sessionId, origin) {
  const fileQs = questions.filter((q) => q.type === 'file_upload' && answers[q.id] !== undefined);
  const keys = [];
  if (!fileQs.length) return { answers, keys };
  if (!sessionId) throw new HttpError(422, 'Upload file tidak valid (sesi tidak dikenal).');
  const out = { ...answers };
  for (const q of fileQs) {
    const list = Array.isArray(answers[q.id]) ? answers[q.id] : [];
    const refs = [...new Set(list.map((f) => String(f?.ref || '')))].filter((r) => /^u\/f_[a-z0-9]{4,20}\/[a-f0-9]{32}$/.test(r));
    if (!refs.length || refs.length !== list.length || refs.length > fileRules(q).maxFiles) throw new HttpError(422, `${q.title || q.id}: file tidak valid.`);
    const { results } = await env.DB.prepare(`SELECT key, name, type, size FROM uploads
      WHERE key IN (${refs.map(() => '?').join(',')}) AND form_id = ? AND question_id = ? AND session_id = ? AND kind = 'answer'`)
      .bind(...refs, form.id, q.id, sessionId).all();
    if (results.length !== refs.length) throw new HttpError(422, `${q.title || q.id}: file tidak ditemukan. Unggah ulang.`);
    const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
    out[q.id] = refs.map((k) => ({ ref: k, name: byKey[k].name, type: byKey[k].type, size: byKey[k].size, url: `${origin}/f/${k}` }));
    keys.push(...refs);
  }
  return { answers: out, keys };
}

// ─── Builder images ─────────────────────────────────────────────────────────
export async function handleMedia(request, env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  needBucket(env);
  await requirePermission(env, request, {}, 'forms.edit');
  const url = new URL(request.url);
  const formId = validId(url.searchParams.get('form'));
  const bytes = await readBody(request, MEDIA_MAX);
  const type = detectType(bytes);
  if (!MEDIA_TYPES[type]) throw new HttpError(415, 'Gambar harus JPG, PNG, GIF, atau WebP.');
  const key = `m/${formId}/${randomHex(16)}.${MEDIA_TYPES[type]}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare(`INSERT INTO uploads (key, form_id, kind, name, type, size, created_at)
    VALUES (?, ?, 'media', ?, ?, ?, ?)`).bind(key, formId, cleanFileName(url.searchParams.get('name')), type, bytes.length, new Date().toISOString()).run();
  return json({ ok: true, path: `/${key}` });
}

// ─── Serving ────────────────────────────────────────────────────────────────
// Uploaded content never runs as a page of this origin. (PDFs skip the CSP:
// browsers refuse to show a PDF in a sandboxed document; their built-in viewers
// render outside the page.)
const SANDBOX = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const SAFE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SANDBOX, 'Referrer-Policy': 'no-referrer' };

async function signingKey(env) {
  const secret = env.FILES_SECRET || env.ADMIN_KEY;
  if (!secret) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(`formflow-files:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signature(key, path, exp) {
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${path}|${exp}`)));
}

/** Short-lived link for the dashboard (works without the file cookie). */
export async function signedFileUrl(env, fileUrl) {
  const key = await signingKey(env);
  if (!key) return fileUrl;
  const u = new URL(fileUrl);
  const exp = Math.floor(Date.now() / 1000) + SIGNED_TTL_SEC;
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('sig', await signature(key, u.pathname, exp));
  return u.href;
}

/** Adds `view` (a signed link) to every file answer of the given responses. */
export async function signResponses(env, responses) {
  for (const r of responses) {
    for (const v of Object.values(r.answers || {})) {
      if (!Array.isArray(v)) continue;
      for (const f of v) if (f && typeof f === 'object' && f.url) f.view = await signedFileUrl(env, f.url);
    }
  }
  return responses;
}

function loginPage(status) {
  const html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Masuk dulu</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#060B14">
<h1 style="font-size:22px">File ini hanya untuk tim</h1>
<p>Masuk ke FormFlow dengan akun tim Anda, lalu buka link ini lagi.</p>
<p><a href="/index.html" style="color:#3967BD;font-weight:700">Masuk ke FormFlow →</a></p></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SAFE_HEADERS, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}

async function canOpen(request, env, url) {
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') || '';
  if (exp && sig) {
    const key = await signingKey(env);
    if (key && exp > Date.now() / 1000 && safeEqual(sig, await signature(key, url.pathname, exp))) return true;
  }
  const user = await userFromToken(env, readCookie(request, SESSION_COOKIE));
  return !!user && can(user.role, 'results.view');
}

export async function serveFile(request, env, url) {
  if (!/^\/f\/u\/f_[a-z0-9]{4,20}\/[a-f0-9]{32}$/.test(url.pathname)) return new Response('Not found', { status: 404 });
  if (!env.FILES) return new Response('Not found', { status: 404 });
  if (!await canOpen(request, env, url)) return loginPage(401);
  const obj = await env.FILES.get(url.pathname.slice(3));
  if (!obj) return new Response('File tidak ditemukan.', { status: 404 });
  const type = obj.httpMetadata?.contentType || 'application/octet-stream';
  const name = obj.customMetadata?.name || 'file';
  const pdf = type === 'application/pdf';
  const inline = pdf || /^image\/(jpeg|png|gif|webp)$/.test(type);
  const headers = {
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, max-age=3600',
    ...SAFE_HEADERS,
  };
  if (pdf) delete headers['Content-Security-Policy'];
  return new Response(obj.body, { headers });
}

export async function serveMedia(env, url) {
  if (!/^\/m\/f_[a-z0-9]{4,20}\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(url.pathname) || !env.FILES) return new Response('Not found', { status: 404 });
  const obj = await env.FILES.get(url.pathname.slice(1));
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ...SAFE_HEADERS,
    },
  });
}

// ─── Clean-up ───────────────────────────────────────────────────────────────
async function deleteKeys(env, keys) {
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM uploads WHERE key IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).run();
  }
}

/** Files uploaded during visits that never submitted are deleted after a day. */
export async function purgePendingUploads(env, { now = Date.now() } = {}) {
  if (!env.FILES) return 0;
  const cutoff = new Date(now - PENDING_HOURS * 3_600_000).toISOString();
  const { results } = await env.DB.prepare(`SELECT key FROM uploads WHERE response_id IS NULL AND kind = 'answer' AND created_at < ? LIMIT 1000`).bind(cutoff).all();
  await deleteKeys(env, results.map((r) => r.key));
  return results.length;
}

export async function deleteFormFiles(env, formId) {
  if (!env.FILES) return;
  const { results } = await env.DB.prepare('SELECT key FROM uploads WHERE form_id = ?').bind(formId).all();
  await deleteKeys(env, results.map((r) => r.key));
}
