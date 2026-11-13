// Routing Middleware: every page and API needs a valid access cookie, except the login page and login/logout APIs.
// Cookie `kpw_auth` = <label b64url>.<expiry unix s>.<HMAC-SHA256 hex of "label.expiry" with AUTH_SECRET>
export const config = { matcher: ['/((?!login|api/login|api/logout|favicon.ico).*)'] };

const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function valid(token, secret) {
  if (!token || !secret) return false;
  const [label, exp, sig] = token.split('.');
  if (!label || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = await hmacHex(secret, `${label}.${exp}`);
  if (want.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export default async function middleware(request) {
  const cookie = request.headers.get('cookie') || '';
  const token = (cookie.match(/(?:^|;\s*)kpw_auth=([^;]+)/) || [])[1];
  if (await valid(token, process.env.AUTH_SECRET)) return; // continue to the page/API
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Perlu login' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const next = encodeURIComponent(url.pathname + url.search);
  return Response.redirect(new URL(`/login?next=${next}`, url), 302);
}
