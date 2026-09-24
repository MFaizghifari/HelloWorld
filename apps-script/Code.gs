/**
 * FormFlow backend — Google Apps Script Web App → Google Sheets.
 *
 * One registry spreadsheet stores form definitions; every form gets its own
 * spreadsheet with two tabs: "Responses" (one row per submission) and
 * "Events" (view / start / abandon / partial / complete, used for funnel analytics)
 * and, for forms with abandonment recovery on, "Belum selesai" (unfinished
 * responses that already contain an email or phone number).
 *
 * Files uploaded by respondents go to a private Google Drive folder per form
 * ("FormFlow Uploads"), shared with the form's sheet editors; the "Uploads"
 * tab tracks them so files of visits that never submit are deleted after a day.
 * Team accounts need the Cloudflare backend; here the admin key is the login.
 *
 * Script Properties (Project Settings → Script properties):
 *   ADMIN_KEY          required. Secret used by the builder & dashboard.
 *   FB_CAPI_TOKEN      optional. Meta Conversions API access token.
 *   FB_TEST_EVENT_CODE optional. Shows CAPI events in Events Manager → Test events.
 *   FB_GRAPH_VERSION   optional. Defaults to v23.0.
 *   DRIVE_FOLDER_ID    optional. Folder where per-form spreadsheets are created.
 *   REGISTRY_ID        set automatically by setup().
 *
 * Run setup() once from the editor, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone).
 */

var MAX_BODY = 100 * 1000; // bytes
var MAX_UPLOAD_BODY = 14 * 1000 * 1000; // a 10 MB file, base64-encoded, plus JSON
var MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Apps Script handles up to ~50 MB, but uploads this big are slow
var MAX_VALUE = 5000; // chars per answer cell
var CHUNK = 45000; // Sheets cell limit is 50,000 chars
var FORM_CACHE_SEC = 600;

// ─── Entry points ──────────────────────────────────────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'getForm') return json_({ ok: true, form: publicForm_(getRecordCached_(p.id).form) });
    if (p.action === 'health') return json_({ ok: true, time: new Date().toISOString() });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > MAX_UPLOAD_BODY) throw new Error('Payload terlalu besar.');
    var body = JSON.parse(raw || '{}');
    if (raw.length > MAX_BODY && body.action !== 'upload' && body.action !== 'media') throw new Error('Payload terlalu besar.');
    switch (body.action) {
      case 'submit': return json_(submit_(body));
      case 'event': return json_(logEvent_(body));
      case 'upload': return json_(upload_(body));
      case 'media': requireAdmin_(body); return json_(media_(body));
      case 'saveForm': requireAdmin_(body); return json_(saveForm_(body.form));
      case 'listForms': requireAdmin_(body); return json_({ ok: true, forms: listForms_() });
      case 'deleteForm': requireAdmin_(body); return json_(deleteForm_(body.id));
      case 'getResults': requireAdmin_(body); return json_(getResults_(body.formId, Number(body.days) || 30));
      default: throw new Error('Unknown action');
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/** Run once from the Apps Script editor. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_KEY')) {
    props.setProperty('ADMIN_KEY', Utilities.getUuid().replace(/-/g, ''));
  }
  registry_();
  Logger.log('Registry: ' + SpreadsheetApp.openById(props.getProperty('REGISTRY_ID')).getUrl());
  Logger.log('ADMIN_KEY: ' + props.getProperty('ADMIN_KEY') + '  ← tempel di Pengaturan builder');
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }

function requireAdmin_(body) {
  var key = prop_('ADMIN_KEY');
  if (!key) throw new Error('ADMIN_KEY belum di-set. Jalankan setup().');
  if (!body.key || !safeEqual_(String(body.key), key)) throw new Error('Admin key salah.');
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function validId_(id) {
  if (!/^[a-z]_[a-z0-9]{4,20}$/.test(String(id || ''))) throw new Error('ID tidak valid.');
  return id;
}

/** Prevent spreadsheet formula injection (=, +, -, @ at the start of a cell). */
function cell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Array]') v = v.map(String).join(', ');
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  var s = String(v).slice(0, MAX_VALUE);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function uncell_(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v.charAt(0) === "'") return v.slice(1);
  return v;
}

function plainTitle_(t) {
  return String(t || '').replace(/\{\{\s*[\w:-]+\s*\}\}/g, '…').replace(/\s+/g, ' ').trim();
}

function sha256_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ─── A/B variants (same rules as app/js/logic.js) ───────────────────────────
var VARIANT_KEYS = ['welcome', 'questions', 'thankyou', 'theme'];

function variantForm_(form, v) {
  var b = v === 'B' && form.variants && form.variants.B;
  if (!b) return form;
  var out = {};
  Object.keys(form).forEach(function (k) { out[k] = form[k]; });
  VARIANT_KEYS.forEach(function (k) { if (b[k] !== undefined) out[k] = b[k]; });
  return out;
}

/** Questions of A, then those only variant B has (for columns and results). */
function allQuestions_(form) {
  var seen = {};
  var out = [];
  var b = (form.variants && form.variants.B && form.variants.B.questions) || [];
  (form.questions || []).concat(b).forEach(function (q) { if (!seen[q.id]) { seen[q.id] = true; out.push(q); } });
  return out;
}

/** "x_id:B" when the tag matches this form's experiment, else ''. */
function variantTag_(form, tag) {
  var parts = String(tag || '').split(':');
  var x = form.experiment;
  if (!x || x.id !== parts[0] || !(form.variants && form.variants.B) || (parts[1] !== 'A' && parts[1] !== 'B')) return '';
  return x.id + ':' + parts[1];
}

function dims_(form, x) {
  x = x || {};
  var device = ['mobile', 'desktop', 'tablet'].indexOf(x.device) === -1 ? '' : x.device;
  var source = String(x.source || '').trim().toLowerCase().replace(/[^\wÀ-ɏ ().-]+/g, '-').slice(0, 40);
  return { device: device, source: source, variant: variantTag_(form, x.variant) };
}

// ─── Registry ───────────────────────────────────────────────────────────────
// Columns: A id | B title | C sheetId | D updatedAt | E.. JSON chunks
function registry_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('REGISTRY_ID');
  if (id) return SpreadsheetApp.openById(id).getSheetByName('Forms');
  var ss = SpreadsheetApp.create('FormFlow — Registry');
  moveToFolder_(ss.getId());
  var sh = ss.getSheets()[0].setName('Forms');
  sh.appendRow(['id', 'title', 'sheetId', 'updatedAt', 'json']);
  sh.setFrozenRows(1);
  props.setProperty('REGISTRY_ID', ss.getId());
  return sh;
}

function findRow_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function readRow_(sh, row) {
  var width = sh.getLastColumn();
  var vals = sh.getRange(row, 1, 1, width).getValues()[0];
  return {
    id: vals[0], title: vals[1], sheetId: vals[2], updatedAt: uncell_(vals[3]),
    form: JSON.parse(vals.slice(4).join('')),
  };
}

function getFormRecord_(id) {
  validId_(id);
  var sh = registry_();
  var row = findRow_(sh, id);
  if (row === -1) throw new Error('Form tidak ditemukan.');
  return readRow_(sh, row);
}

/** Cached { form, sheetId } — every view/event/submit hits this, so avoid reading the registry each time. */
function getRecordCached_(id) {
  validId_(id);
  var cache = CacheService.getScriptCache();
  var hit = cache.get('form_' + id);
  if (hit) return JSON.parse(hit);
  var rec = getFormRecord_(id);
  var small = { form: rec.form, sheetId: rec.sheetId };
  var str = JSON.stringify(small);
  if (str.length < 90000) cache.put('form_' + id, str, FORM_CACHE_SEC); // CacheService max value is 100 KB
  return small;
}

/** Strip anything the public should not see. */
function publicForm_(form) {
  var f = JSON.parse(JSON.stringify(form));
  if (f.integrations) delete f.integrations;
  return f;
}

function listForms_() {
  var sh = registry_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 4).getValues().map(function (r) {
    return { id: r[0], title: r[1], updatedAt: uncell_(r[3]), sheetUrl: r[2] ? 'https://docs.google.com/spreadsheets/d/' + r[2] + '/edit' : '' };
  }).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
}

function saveForm_(form) {
  if (!form || !form.id) throw new Error('Form kosong.');
  validId_(form.id);
  form.updatedAt = new Date().toISOString();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = registry_();
    var row = findRow_(sh, form.id);
    var sheetId = row === -1 ? '' : sh.getRange(row, 3).getValue();
    var ss;
    if (!sheetId) {
      ss = SpreadsheetApp.create('FormFlow — ' + (form.title || form.id));
      moveToFolder_(ss.getId());
      var resp = ss.getSheets()[0].setName('Responses');
      resp.getRange(1, 1, 1, 2).setValues([['Submitted At', 'Response ID']]).setFontWeight('bold');
      resp.setFrozenRows(1);
      var ev = ss.insertSheet('Events');
      ev.appendRow(EVENT_HEADERS);
      ev.setFrozenRows(1);
      sheetId = ss.getId();
    } else {
      ss = SpreadsheetApp.openById(sheetId);
      // Sheets made before per-device / per-source / A/B reports get the new columns.
      ss.getSheetByName('Events').getRange(1, 1, 1, EVENT_HEADERS.length).setValues([EVENT_HEADERS]);
    }
    ensureColumns_(ss.getSheetByName('Responses'), form);
    shareSheet_(ss, form);

    var json = JSON.stringify(form);
    var chunks = [];
    for (var i = 0; i < json.length; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    var values = [form.id, form.title || '', sheetId, form.updatedAt].concat(chunks);
    if (row === -1) row = sh.getLastRow() + 1;
    var oldWidth = sh.getLastColumn();
    if (oldWidth > values.length) sh.getRange(row, values.length + 1, 1, oldWidth - values.length).clearContent();
    // Plain-text format so long JSON never gets interpreted as a formula/number.
    sh.getRange(row, 1, 1, values.length).setNumberFormat('@').setValues([values]);
    CacheService.getScriptCache().remove('form_' + form.id);
    return { ok: true, form: form, sheetUrl: ss.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function deleteForm_(id) {
  validId_(id);
  var sh = registry_();
  var row = findRow_(sh, id);
  if (row !== -1) sh.deleteRow(row); // the spreadsheet itself is kept, as a safety net
  CacheService.getScriptCache().remove('form_' + id);
  return { ok: true };
}

function moveToFolder_(fileId) {
  var folderId = prop_('DRIVE_FOLDER_ID');
  if (!folderId) return;
  try { DriveApp.getFileById(fileId).moveTo(DriveApp.getFolderById(folderId)); } catch (e) { /* keep in root */ }
}

function sheetEditors_(form) {
  return String((form.integrations && form.integrations.sheetEditors) || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); });
}

function shareSheet_(ss, form) {
  var emails = sheetEditors_(form);
  if (!emails.length) return;
  var existing = ss.getEditors().map(function (u) { return u.getEmail().toLowerCase(); });
  var add = emails.filter(function (m) { return existing.indexOf(m) === -1; });
  if (add.length) ss.addEditors(add);
}

// ─── Responses sheet columns ────────────────────────────────────────────────
// Each header cell carries a note "q:<id>", "h:<key>" or "m:<key>" so columns
// survive question renames and reordering in the builder.
var META_COLS = [['durationSec', 'Durasi (detik)'], ['pageUrl', 'Page URL'], ['referrer', 'Referrer'], ['sessionId', 'Session ID'],
  ['device', 'Perangkat'], ['source', 'Sumber'], ['variant', 'Varian A/B']];
var EVENT_HEADERS = ['Timestamp', 'Session ID', 'Type', 'Path', 'Device', 'Source', 'Variant'];
var AUTO_HIDDEN = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];

function columnMap_(sh) {
  var width = Math.max(2, sh.getLastColumn());
  var notes = sh.getRange(1, 1, 1, width).getNotes()[0];
  var map = {};
  notes.forEach(function (n, i) { if (n) map[n] = i + 1; });
  return { map: map, width: width };
}

function ensureColumns_(sh, form) {
  var cm = columnMap_(sh);
  var wanted = [];
  allQuestions_(form).forEach(function (q) { if (q.type !== 'statement') wanted.push(['q:' + q.id, plainTitle_(q.title) || q.id]); });
  AUTO_HIDDEN.concat(form.hiddenFields || []).forEach(function (h) {
    if (wanted.every(function (w) { return w[0] !== 'h:' + h; })) wanted.push(['h:' + h, h]);
  });
  META_COLS.forEach(function (m) { wanted.push(['m:' + m[0], m[1]]); });

  var next = cm.width + 1;
  wanted.forEach(function (w) {
    var col = cm.map[w[0]];
    if (!col) { col = next++; cm.map[w[0]] = col; sh.getRange(1, col).setNote(w[0]); }
    sh.getRange(1, col).setValue(w[1]).setFontWeight('bold'); // keep titles in sync
  });
  return cm.map;
}

// ─── Submissions ────────────────────────────────────────────────────────────
function submit_(body) {
  var rec = getRecordCached_(body.formId);
  var form = rec.form;
  var responseId = 'r_' + Utilities.getUuid().slice(0, 12);
  if (body.hp) return { ok: true, responseId: responseId }; // honeypot hit: pretend success

  var hidden = body.hidden || {};
  var meta = body.meta || {};
  var d = dims_(form, meta);
  meta.device = d.device; meta.source = d.source; meta.variant = d.variant;
  var shown = variantForm_(form, d.variant.split(':')[1]);
  var now = new Date();

  var ss = SpreadsheetApp.openById(rec.sheetId);
  // Only the questions this visitor was shown; file answers must be this visit's own uploads.
  var answers = {};
  var fileIds = [];
  (shown.questions || []).forEach(function (q) {
    var v = (body.answers || {})[q.id];
    if (v === undefined || q.type === 'statement') return;
    if (q.type === 'file_upload') {
      var files = checkUploads_(ss, q, String(meta.sessionId || ''), v);
      files.forEach(function (f) { fileIds.push(f.ref.slice(6)); });
      answers[q.id] = files;
    } else {
      answers[q.id] = v;
    }
  });
  var sh = ss.getSheetByName('Responses');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var cm = columnMap_(sh);
    var needsColumns = allQuestions_(form).some(function (q) { return q.type !== 'statement' && !cm.map['q:' + q.id]; })
      || META_COLS.some(function (m) { return !cm.map['m:' + m[0]]; });
    var map = needsColumns ? ensureColumns_(sh, form) : cm.map;
    var width = Math.max(sh.getLastColumn(), 2);
    var row = new Array(width);
    for (var i = 0; i < width; i++) row[i] = '';
    row[0] = now;
    row[1] = responseId;
    Object.keys(answers).forEach(function (k) { if (map['q:' + k]) row[map['q:' + k] - 1] = cell_(answerText_(answers[k])); });
    Object.keys(hidden).forEach(function (k) { if (map['h:' + k]) row[map['h:' + k] - 1] = cell_(hidden[k]); });
    META_COLS.forEach(function (m) { if (map['m:' + m[0]]) row[map['m:' + m[0]] - 1] = cell_(meta[m[0]]); });
    sh.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  ss.getSheetByName('Events').appendRow([now, cell_(meta.sessionId), 'complete', cell_((meta.path || []).join(',')), d.device, cell_(d.source), d.variant]);
  if (fileIds.length) markUploads_(ss, fileIds, responseId);
  // The finished response replaces its unfinished copy.
  try { deletePartial_(ss, String(meta.sessionId || '')); } catch (err) { console.error(err); }

  // Side effects never fail the submission.
  try { sideEffects_(shown, responseId, now, answers, hidden, meta); } catch (err) { console.error(err); }
  return { ok: true, responseId: responseId };
}

function sideEffects_(form, responseId, now, answers, hidden, meta) {
  var requests = [];
  var tr = form.tracking || {};
  var token = prop_('FB_CAPI_TOKEN');
  if (tr.capi && token && /^\d{10,20}$/.test(tr.fbPixelId || '')) requests.push(capiRequest_(form, token, now, answers, hidden, meta));

  var ig = form.integrations || {};
  if (ig.webhookUrl && /^https:\/\//.test(ig.webhookUrl)) {
    var readable = {};
    (form.questions || []).forEach(function (q) { if (answers[q.id] !== undefined) readable[plainTitle_(q.title) || q.id] = answers[q.id]; });
    requests.push({
      url: ig.webhookUrl, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ formId: form.id, formTitle: form.title, responseId: responseId, submittedAt: now.toISOString(), answers: readable, rawAnswers: answers, hidden: hidden }),
    });
  }
  if (requests.length) {
    UrlFetchApp.fetchAll(requests).forEach(function (res, i) {
      if (res.getResponseCode() >= 300) console.warn('Request ' + i + ' failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 500));
    });
  }

  if (ig.notifyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ig.notifyEmail) && MailApp.getRemainingDailyQuota() > 0) {
    var lines = (form.questions || []).filter(function (q) { return answers[q.id] !== undefined; })
      .map(function (q) { return '• ' + plainTitle_(q.title) + '\n  ' + answerText_(answers[q.id]); });
    MailApp.sendEmail(ig.notifyEmail, 'Jawaban baru: ' + form.title, lines.join('\n\n') + '\n\nResponse ID: ' + responseId);
  }
}

/** Meta Conversions API — https://developers.facebook.com/docs/marketing-api/conversions-api */
function capiRequest_(form, token, now, answers, hidden, meta) {
  var user = { client_user_agent: String(meta.userAgent || '').slice(0, 500) };
  (form.questions || []).forEach(function (q) {
    var v = answers[q.id];
    if (!v) return;
    if (q.type === 'email' && !user.em) user.em = [sha256_(String(v).trim().toLowerCase())];
    if (q.type === 'phone' && !user.ph) {
      var digits = String(v).replace(/\D/g, '');
      if (digits.charAt(0) === '0') digits = '62' + digits.slice(1); // local Indonesian format → E.164 without "+"
      user.ph = [sha256_(digits)];
    }
  });
  if (meta.fbp) user.fbp = String(meta.fbp);
  if (meta.fbc) user.fbc = String(meta.fbc);
  if (meta.sessionId) user.external_id = [sha256_(String(meta.sessionId))];

  var payload = {
    data: [{
      event_name: (form.tracking && form.tracking.fbSubmitEvent) || 'Lead',
      event_time: Math.floor(now.getTime() / 1000),
      event_id: String(meta.eventId || ''), // same id as the browser pixel → deduplicated
      action_source: 'website',
      event_source_url: String(meta.pageUrl || '').slice(0, 1000),
      user_data: user,
      custom_data: { form_id: form.id, form_title: form.title, utm_source: hidden.utm_source || '', utm_campaign: hidden.utm_campaign || '', ab_variant: meta.variant || undefined },
    }],
  };
  var test = prop_('FB_TEST_EVENT_CODE');
  if (test) payload.test_event_code = test;
  var version = prop_('FB_GRAPH_VERSION') || 'v23.0';
  return {
    url: 'https://graph.facebook.com/' + version + '/' + form.tracking.fbPixelId + '/events?access_token=' + encodeURIComponent(token),
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  };
}

// ─── Analytics events ───────────────────────────────────────────────────────
function logEvent_(body) {
  var type = String(body.type || '');
  if (['view', 'start', 'abandon', 'partial'].indexOf(type) === -1) throw new Error('Event tidak valid.');
  var rec = getRecordCached_(body.formId);
  var path = (body.path || []).slice(0, 200).map(String).join(',');
  var d = dims_(rec.form, body);
  var ss = SpreadsheetApp.openById(rec.sheetId);
  // appendRow is a single write; no lock needed for this append-only log.
  ss.getSheetByName('Events').appendRow([new Date(), cell_(String(body.sessionId || '').slice(0, 40)), type, cell_(path), d.device, cell_(d.source), d.variant]);
  if (type === 'abandon' || type === 'partial') upsertPartial_(ss, variantForm_(rec.form, d.variant.split(':')[1]), body);
  return { ok: true };
}

// ─── Unfinished responses ("Belum selesai") ────────────────────────────────
var PARTIAL_DAYS = 30;
var PARTIAL_HEADERS = ['Updated At', 'Session ID', 'Nama', 'Email', 'Telepon', 'Berhenti di', 'Jumlah jawaban', 'utm_source', 'Answers (JSON)', 'Last question ID'];

function partialsSheet_(ss) {
  var sh = ss.getSheetByName('Belum selesai');
  if (!sh) {
    sh = ss.insertSheet('Belum selesai');
    sh.appendRow(PARTIAL_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findSessionRow_(sh, sessionId) {
  var n = sh.getLastRow() - 1;
  if (n < 1 || !sessionId) return -1;
  var ids = sh.getRange(2, 2, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (ids[i][0] === sessionId) return i + 2;
  return -1;
}

/** Same rules as app/js/logic.js contactFrom(): first valid email / phone, first short text as name. */
function contactFrom_(form, answers) {
  var c = { email: '', phone: '', name: '' };
  (form.questions || []).forEach(function (q) {
    var v = answers[q.id];
    if (v === undefined || v === null || v === '') return;
    var s = String(v).trim();
    if (q.type === 'email' && !c.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) c.email = s;
    var digits = s.replace(/\D/g, '');
    if (q.type === 'phone' && !c.phone && digits.length >= 8 && digits.length <= 15) c.phone = s;
    if (q.type === 'short_text' && !c.name) c.name = s.slice(0, 100);
  });
  return c.email || c.phone ? c : null;
}

function cleanPartialAnswers_(form, answers) {
  var out = {};
  (form.questions || []).forEach(function (q) {
    var v = answers[q.id];
    if (q.type === 'statement' || q.type === 'file_upload' || v === undefined || v === null || v === '') return;
    if (Object.prototype.toString.call(v) === '[object Array]') out[q.id] = v.slice(0, 50).map(function (x) { return String(x).slice(0, 500); });
    else out[q.id] = typeof v === 'number' ? v : String(v).slice(0, 2000);
  });
  return out;
}

function upsertPartial_(ss, form, body) {
  if (!(form.recovery && form.recovery.partials) || !body.answers || typeof body.answers !== 'object') return;
  var sessionId = String(body.sessionId || '');
  if (!/^s_[a-z0-9]+$/.test(sessionId)) return;
  var answers = cleanPartialAnswers_(form, body.answers);
  var c = contactFrom_(form, answers);
  if (!c) return;
  var ids = (body.path || []).map(String);
  var lastId = ids.length ? ids[ids.length - 1] : '';
  var lastQ = (form.questions || []).filter(function (q) { return q.id === lastId; })[0];
  var hidden = body.hidden || {};
  var row = [new Date(), sessionId, cell_(c.name), cell_(c.email), cell_(c.phone), cell_(lastQ ? plainTitle_(lastQ.title) : ''),
    Object.keys(answers).length, cell_(hidden.utm_source || ''), JSON.stringify(answers).slice(0, 45000), cell_(lastId)];
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = partialsSheet_(ss);
    var at = findSessionRow_(sh, sessionId);
    if (at === -1) sh.appendRow(row); else sh.getRange(at, 1, 1, row.length).setValues([row]);
  } finally {
    lock.releaseLock();
  }
}

function deletePartial_(ss, sessionId) {
  var sh = ss.getSheetByName('Belum selesai');
  if (!sh || !sessionId) return;
  var at = findSessionRow_(sh, sessionId);
  if (at !== -1) sh.deleteRow(at);
}

function readPartials_(ss) {
  var sh = ss.getSheetByName('Belum selesai');
  if (!sh || sh.getLastRow() < 2) return [];
  var cutoff = Date.now() - PARTIAL_DAYS * 86400000;
  return sh.getRange(2, 1, sh.getLastRow() - 1, PARTIAL_HEADERS.length).getValues()
    .filter(function (r) { return new Date(r[0]).getTime() >= cutoff; })
    .map(function (r) {
      var answers = {};
      try { answers = JSON.parse(r[8] || '{}'); } catch (e) { /* truncated JSON: show contact only */ }
      return {
        sessionId: r[1], updatedAt: new Date(r[0]).toISOString(), answers: answers, hidden: { utm_source: uncell_(r[7]) },
        contact: { name: uncell_(r[2]), email: uncell_(r[3]), phone: uncell_(r[4]) },
        lastQuestion: uncell_(r[9]), lastQuestionTitle: uncell_(r[5]), answeredCount: r[6],
      };
    })
    .sort(function (a, b) { return b.updatedAt.localeCompare(a.updatedAt); })
    .slice(0, 500);
}

// ─── File uploads (Google Drive) ────────────────────────────────────────────
var FILE_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'],
  pdf: ['application/pdf'],
  document: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/csv', 'text/plain'],
};
FILE_TYPES.any = FILE_TYPES.image.concat(FILE_TYPES.document);
var OOXML = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
var OLE = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };
var UPLOAD_HEADERS = ['Uploaded At', 'File ID', 'Session ID', 'Question ID', 'Name', 'Type', 'Size', 'Response ID'];

/** Same content sniffing as worker/src/files.js: the first bytes decide the type, never the name. */
function detectType_(bytes, name) {
  var b = bytes.map(function (x) { return x & 0xff; });
  var ext = ((String(name).toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1]) || '';
  var str = function (from, to) { return String.fromCharCode.apply(null, b.slice(from, to)); };
  var starts = function (sig) { return sig.every(function (x, i) { return b[i] === x; }); };
  if (b.length < 4) return null;
  if (starts([0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (/^GIF8[79]a$/.test(str(0, 6))) return 'image/gif';
  if (str(0, 4) === 'RIFF' && str(8, 12) === 'WEBP') return 'image/webp';
  if (str(4, 8) === 'ftyp') {
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(str(8, 12))) return 'image/heic';
    if (/^(mif1|msf1|heif)$/.test(str(8, 12))) return 'image/heif';
  }
  if (str(0, 5) === '%PDF-') return 'application/pdf';
  if (starts([0x50, 0x4B, 0x03, 0x04])) return OOXML[ext] || null;
  if (starts([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return OLE[ext] || null;
  if ((ext === 'csv' || ext === 'txt') && b.indexOf(0) === -1) return ext === 'csv' ? 'text/csv' : 'text/plain';
  return null;
}

function cleanFileName_(raw) {
  var s = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim();
  return (s || 'file').slice(0, 120);
}

function folder_(name, parentId) {
  var parent = parentId ? DriveApp.getFolderById(parentId) : DriveApp.getRootFolder();
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Private folder per form, shared (view) with the form's sheet editors. */
function uploadsFolder_(form) {
  var root = folder_('FormFlow Uploads', prop_('DRIVE_FOLDER_ID'));
  var f = folder_((form.title || form.id).slice(0, 80) + ' (' + form.id + ')', root.getId());
  var emails = sheetEditors_(form);
  if (emails.length) {
    var have = f.getViewers().concat(f.getEditors()).map(function (u) { return u.getEmail().toLowerCase(); });
    var add = emails.filter(function (m) { return have.indexOf(m) === -1; });
    if (add.length) f.addViewers(add);
  }
  return f;
}

function uploadsSheet_(ss) {
  var sh = ss.getSheetByName('Uploads');
  if (!sh) {
    sh = ss.insertSheet('Uploads');
    sh.appendRow(UPLOAD_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Respondent upload: public, checked against the question's rules and the file's content. */
function upload_(body) {
  var rec = getRecordCached_(body.formId);
  var form = rec.form;
  var sessionId = String(body.sessionId || '');
  if (!/^s_[a-z0-9]+$/.test(sessionId) || sessionId.length > 40) throw new Error('Session tidak valid.');
  var q = allQuestions_(form).filter(function (x) { return x.id === body.questionId; })[0];
  if (!q || q.type !== 'file_upload') throw new Error('Pertanyaan ini tidak menerima file.');
  var s = q.settings || {};
  var kind = FILE_TYPES[s.fileKind] ? s.fileKind : 'any';
  var maxBytes = Math.min(MAX_UPLOAD_BYTES, Math.max(1, Number(s.maxSizeMb) || 10) * 1024 * 1024);
  var maxFiles = Math.min(10, Math.max(1, Math.round(Number(s.maxFiles) || 1)));
  var name = cleanFileName_(body.name);
  var bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length) throw new Error('File kosong.');
  if (bytes.length > maxBytes) throw new Error(name + ': lebih dari ' + Math.round(maxBytes / 1024 / 1024) + ' MB.');
  var type = detectType_(bytes, name);
  if (!type || FILE_TYPES[kind].indexOf(type) === -1) throw new Error(name + ': jenis file tidak diterima.');
  // Replacing a file is fine; hundreds of uploads from one visit are not.
  var cache = CacheService.getScriptCache();
  var countKey = 'up_' + form.id + '_' + sessionId + '_' + q.id;
  var used = Number(cache.get(countKey) || 0);
  if (used >= maxFiles * 3) throw new Error('Terlalu banyak file untuk pertanyaan ini.');
  cache.put(countKey, String(used + 1), 21600);

  var file = uploadsFolder_(form).createFile(Utilities.newBlob(bytes, type, name));
  var ss = SpreadsheetApp.openById(rec.sheetId);
  uploadsSheet_(ss).appendRow([new Date(), file.getId(), sessionId, q.id, cell_(name), type, bytes.length, '']);
  return { ok: true, file: { ref: 'drive:' + file.getId(), name: name, type: type, size: bytes.length, url: file.getUrl() } };
}

/** The file answers of a submission, as recorded by upload_() for this session and question. */
function checkUploads_(ss, q, sessionId, list) {
  if (Object.prototype.toString.call(list) !== '[object Array]' || !list.length) throw new Error((q.title || q.id) + ': file tidak valid.');
  var sh = ss.getSheetByName('Uploads');
  var rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, UPLOAD_HEADERS.length).getValues() : [];
  return list.map(function (f) {
    var id = String((f && f.ref) || '').replace(/^drive:/, '');
    var row = rows.filter(function (r) { return r[1] === id && r[2] === sessionId && r[3] === q.id; })[0];
    if (!row) throw new Error((q.title || q.id) + ': file tidak ditemukan. Unggah ulang.');
    return { ref: 'drive:' + id, name: uncell_(row[4]), type: row[5], size: row[6], url: 'https://drive.google.com/file/d/' + id + '/view' };
  });
}

function markUploads_(ss, fileIds, responseId) {
  var sh = ss.getSheetByName('Uploads');
  if (!sh || sh.getLastRow() < 2) return;
  var ids = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  ids.forEach(function (r, i) { if (fileIds.indexOf(r[0]) !== -1) sh.getRange(i + 2, 8).setValue(responseId); });
}

/** "a.pdf (url), b.png (url)" for sheets, email and CSV. */
function answerText_(v) {
  if (Object.prototype.toString.call(v) !== '[object Array]') return v;
  return v.map(function (x) { return x && typeof x === 'object' ? (x.url ? x.name + ' (' + x.url + ')' : x.name) : String(x); }).join(', ');
}

/** Reverse of answerText_() for file cells, so the dashboard shows file chips. */
function parseFileText_(text) {
  var out = [];
  String(text).replace(/(.+?) \((https:\/\/drive\.google\.com\/file\/d\/([\w-]+)\/view)\)(?:, |$)/g, function (_, name, url, id) {
    out.push({ ref: 'drive:' + id, name: name, url: url });
    return '';
  });
  return out.length ? out : text;
}

/** Builder image: stored in Drive and shared by link, because respondents must see it. */
function media_(body) {
  var name = cleanFileName_(body.name);
  var bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Gambar maksimal 5 MB.');
  var type = detectType_(bytes, name);
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(type) === -1) throw new Error('Gambar harus JPG, PNG, GIF, atau WebP.');
  var file = folder_('FormFlow Media', prop_('DRIVE_FOLDER_ID')).createFile(Utilities.newBlob(bytes, type, name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w2000' };
}

/** Files from visits that never submitted, older than a day, go to the Drive trash. */
function prunePendingUploads_(ss) {
  var sh = ss.getSheetByName('Uploads');
  if (!sh || sh.getLastRow() < 2) return;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, UPLOAD_HEADERS.length).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (!rows[i][7] && new Date(rows[i][0]).getTime() < Date.now() - 86400000) {
      try { DriveApp.getFileById(rows[i][1]).setTrashed(true); } catch (e) { /* already gone */ }
      sh.deleteRow(i + 2);
    }
  }
}

// ─── Dashboard data ─────────────────────────────────────────────────────────
function getResults_(formId, days) {
  var rec = getFormRecord_(formId);
  var ss = SpreadsheetApp.openById(rec.sheetId);
  var since = Date.now() - Math.min(days, 400) * 86400000;

  var sh = ss.getSheetByName('Responses');
  var responses = [];
  if (sh.getLastRow() > 1) {
    var cm = columnMap_(sh);
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, cm.width).getValues();
    var keys = Object.keys(cm.map);
    var fileQ = {};
    allQuestions_(rec.form).forEach(function (q) { if (q.type === 'file_upload') fileQ[q.id] = true; });
    rows.forEach(function (r) {
      var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (isNaN(ts) || ts.getTime() < since) return;
      var out = { submittedAt: ts.toISOString(), responseId: r[1], answers: {}, hidden: {}, meta: {} };
      keys.forEach(function (k) {
        var v = uncell_(r[cm.map[k] - 1]);
        if (v === '' || v === null) return;
        var kind = k.slice(0, 1); var id = k.slice(2);
        if (kind === 'q') out.answers[id] = fileQ[id] ? parseFileText_(String(v)) : v;
        else if (kind === 'h') out.hidden[id] = v;
        else if (kind === 'm') out.meta[id] = v;
      });
      responses.push(out);
    });
  }

  var ev = ss.getSheetByName('Events');
  var events = [];
  if (ev.getLastRow() > 1) {
    ev.getRange(2, 1, ev.getLastRow() - 1, EVENT_HEADERS.length).getValues().forEach(function (r) {
      var ts = r[0] instanceof Date ? r[0] : new Date(r[0]);
      if (isNaN(ts) || ts.getTime() < since) return;
      events.push({
        ts: ts.toISOString(), sessionId: uncell_(r[1]), type: r[2], path: String(uncell_(r[3]) || '').split(',').filter(String),
        device: r[4] || '', source: uncell_(r[5]) || '', variant: r[6] || '',
      });
    });
  }
  return { ok: true, responses: responses, events: events, partials: readPartials_(ss), sheetUrl: ss.getUrl() };
}

/**
 * Maintenance, attach to a daily time trigger: deletes Events rows older than
 * ~13 months, "Belum selesai" rows older than 30 days, and files uploaded
 * during visits that never submitted (after a day). Responses are never touched.
 */
function pruneOldEvents() {
  var keepDays = 400;
  var cutoff = Date.now() - keepDays * 86400000;
  listForms_().forEach(function (f) {
    var rec = getFormRecord_(f.id);
    var ev = SpreadsheetApp.openById(rec.sheetId).getSheetByName('Events');
    var n = ev.getLastRow() - 1;
    if (n < 1) return;
    var ts = ev.getRange(2, 1, n, 1).getValues();
    var old = 0;
    while (old < n && new Date(ts[old][0]).getTime() < cutoff) old++;
    if (old > 0) ev.deleteRows(2, old);
    prunePendingUploads_(SpreadsheetApp.openById(rec.sheetId));
    // Unfinished responses are kept for 30 days at most (data minimisation).
    var ps = SpreadsheetApp.openById(rec.sheetId).getSheetByName('Belum selesai');
    if (!ps || ps.getLastRow() < 2) return;
    var pts = ps.getRange(2, 1, ps.getLastRow() - 1, 1).getValues();
    for (var i = pts.length - 1; i >= 0; i--) {
      if (new Date(pts[i][0]).getTime() < Date.now() - PARTIAL_DAYS * 86400000) ps.deleteRow(i + 2);
    }
  });
}
