// Where a visitor comes from and what they use, for the per-device and
// per-source breakdowns. Pure functions: the respondent page, the Worker and
// the tests all classify the same way.

export const DEVICES = { mobile: 'Ponsel', desktop: 'Desktop', tablet: 'Tablet' };
export const DIRECT = '(langsung)';

/**
 * 'mobile' | 'tablet' | 'desktop' from a user agent string.
 * iPadOS 13+ identifies as desktop Safari, so the page also passes its touch points.
 */
export function deviceOf(ua = '', { touchPoints = 0 } = {}) {
  const s = String(ua || '');
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobi)/i.test(s)) return 'tablet';
  if (/Macintosh/.test(s) && Number(touchPoints) > 1) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini|IEMobile/i.test(s)) return 'mobile';
  return 'desktop';
}

export function validDevice(d) {
  return Object.hasOwn(DEVICES, d) ? d : '';
}

// utm_source spellings people use for the same place.
const ALIASES = {
  fb: 'facebook', 'facebook.com': 'facebook', 'fb.com': 'facebook', meta: 'facebook',
  ig: 'instagram', insta: 'instagram', 'instagram.com': 'instagram',
  wa: 'whatsapp', 'whatsapp.com': 'whatsapp', 'wa.me': 'whatsapp',
  tt: 'tiktok', 'tiktok.com': 'tiktok',
  yt: 'youtube', 'youtube.com': 'youtube',
  twitter: 'x', 'x.com': 'x', 'twitter.com': 'x',
  'google.com': 'google', 'google.co.id': 'google',
};

const REFERRERS = [
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)threads\.net$/, 'threads'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'x'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'linkedin'],
  [/(^|\.)google(\.[a-z]{2,3}){1,2}$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)t\.me$|(^|\.)telegram\.org$/, 'telegram'],
];

/**
 * Traffic source: utm_source when the link has one, else the ad click id,
 * else the referring site, else "(langsung)".
 * Meta appends fbclid to links opened from both Facebook and Instagram, so a
 * bare fbclid is reported as "meta".
 */
export function sourceOf(params = {}, referrer = '') {
  const utm = String(params.utm_source || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
  if (utm) return ALIASES[utm] || utm;
  if (params.fbclid) return 'meta';
  if (params.gclid) return 'google';
  if (params.ttclid) return 'tiktok';
  let host = '';
  try { host = new URL(String(referrer || '')).hostname.toLowerCase().replace(/^www\.|^m\.|^l\.|^lm\./, ''); } catch { /* not a URL */ }
  if (!host) return DIRECT;
  for (const [re, name] of REFERRERS) if (re.test(host)) return name;
  return host.slice(0, 40);
}

/** Same rules the server applies to a source sent by the browser. */
export function cleanSource(s) {
  return String(s || '').trim().toLowerCase().replace(/[^\p{L}\p{N} ()._-]+/gu, '-').slice(0, 40);
}
