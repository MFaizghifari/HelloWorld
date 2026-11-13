// POST /api/login {code}  ->  sets the kpw_auth cookie and sends a Slack alert naming who opened the dashboard.
// Env: ACCESS_CODES = JSON {"<code>": "<label>"}, AUTH_SECRET, SLACK_WEBHOOK_URL (optional), SLACK_MENTION (optional, e.g. "<@U123>")
const crypto = require('crypto');

const SESSION_HOURS = 12;

function codes() {
  try { return JSON.parse(process.env.ACCESS_CODES || '{}'); } catch { return {}; }
}

function sign(label) {
  const l = Buffer.from(label).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const sig = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(`${l}.${exp}`).digest('hex');
  return `${l}.${exp}.${sig}`;
}

function device(ua = '') {
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'perangkat lain';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser lain';
  return `${br} di ${os}`;
}

async function notify(label, req) {
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  const h = req.headers;
  const city = decodeURIComponent(h['x-vercel-ip-city'] || '') || 'kota tidak diketahui';
  const country = h['x-vercel-ip-country'] || '';
  const when = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
  const text = `${process.env.SLACK_MENTION ? process.env.SLACK_MENTION + ' ' : ''}🔓 *${label}* membuka dashboard Monitoring & Social Listening KPw BI\n` +
    `${when} WIB · ${city}${country ? ', ' + country : ''} · ${device(h['user-agent'])}`;
  try {
    await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) { console.error('slack', e.message); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST saja' });
  if (!process.env.AUTH_SECRET) return res.status(500).json({ error: 'AUTH_SECRET belum diatur' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const code = String(body.code || '').trim().toLowerCase();
  const label = codes()[code];
  if (!label) {
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    console.log('login gagal', req.headers['x-vercel-ip-city'] || '', (req.headers['user-agent'] || '').slice(0, 60));
    return res.status(401).json({ error: 'Kode akses tidak dikenali' });
  }
  res.setHeader('Set-Cookie', `kpw_auth=${sign(label)}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Lax`);
  console.log('login', label);
  await notify(label, req);
  res.status(200).json({ ok: true });
};
