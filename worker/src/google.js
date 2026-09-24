// Google Sheets mirror via a service account (OAuth 2.0 JWT bearer flow).
// https://developers.google.com/identity/protocols/oauth2/service-account

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
let cachedToken = null; // { token, exp } — lives as long as the isolate

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToBytes(pem) {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export function hasGoogleCredentials(env) {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
}

export async function googleToken(env, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(env.GOOGLE_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google auth: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

/** Accepts a full Google Sheets URL or a bare spreadsheet id. */
export function parseSheetId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

async function sheetsCall(env, fetchImpl, sheetId, path, method, body) {
  const token = await googleToken(env, fetchImpl);
  const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error.message; } catch { /* keep raw */ }
    throw new Error(`Sheets ${res.status}: ${msg}`);
  }
  return res.json();
}

// valueInputOption=RAW stores text as-is, so answers like "=IMPORTXML(...)" are never evaluated as formulas.
export function writeHeader(env, fetchImpl, sheetId, titles) {
  return sheetsCall(env, fetchImpl, sheetId, '/values/A1?valueInputOption=RAW', 'PUT', { values: [titles] });
}

export function appendRows(env, fetchImpl, sheetId, rows) {
  return sheetsCall(env, fetchImpl, sheetId, '/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', 'POST', { values: rows });
}
