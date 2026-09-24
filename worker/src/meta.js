// Meta Conversions API — https://developers.facebook.com/docs/marketing-api/conversions-api
// The browser pixel sends the same event_id, so Meta deduplicates the pair.

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Local Indonesian numbers (08…) become E.164 digits without "+" (628…), as Meta requires a country code. */
export function normalizePhone(v, defaultCountry = '62') {
  let d = String(v).replace(/\D/g, '');
  if (d.startsWith('0')) d = defaultCountry + d.slice(1);
  return d;
}

export async function capiPayload(form, { answers, hidden, meta, ip, now, testCode }) {
  const user = { client_user_agent: String(meta.userAgent || '').slice(0, 500) };
  if (ip) user.client_ip_address = ip;
  for (const q of form.questions || []) {
    const v = answers[q.id];
    if (!v) continue;
    if (q.type === 'email' && !user.em) user.em = [await sha256(String(v).trim().toLowerCase())];
    if (q.type === 'phone' && !user.ph) user.ph = [await sha256(normalizePhone(v))];
  }
  if (meta.fbp) user.fbp = String(meta.fbp);
  if (meta.fbc) user.fbc = String(meta.fbc);
  if (meta.sessionId) user.external_id = [await sha256(String(meta.sessionId))];
  const payload = {
    data: [{
      event_name: form.tracking?.fbSubmitEvent || 'Lead',
      event_time: Math.floor(now.getTime() / 1000),
      event_id: String(meta.eventId || ''),
      action_source: 'website',
      event_source_url: String(meta.pageUrl || '').slice(0, 1000),
      user_data: user,
      custom_data: {
        form_id: form.id, form_title: form.title, utm_source: hidden.utm_source || '', utm_campaign: hidden.utm_campaign || '',
        // "x_ab12cd:B" while an A/B test runs, so Ads Manager can report conversions per variant.
        ...(meta.variant ? { ab_variant: String(meta.variant) } : {}),
      },
    }],
  };
  if (testCode) payload.test_event_code = testCode;
  return payload;
}

export async function sendCapi(env, form, ctx) {
  const pixel = form.tracking?.fbPixelId;
  if (!form.tracking?.capi || !env.FB_CAPI_TOKEN || !/^\d{10,20}$/.test(pixel || '')) return null;
  const payload = await capiPayload(form, { ...ctx, testCode: env.FB_TEST_EVENT_CODE });
  const version = env.FB_GRAPH_VERSION || 'v23.0';
  const res = await (ctx.fetchImpl || fetch)(`https://graph.facebook.com/${version}/${pixel}/events?access_token=${encodeURIComponent(env.FB_CAPI_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) console.warn('CAPI failed', res.status, (await res.text()).slice(0, 300));
  return res.status;
}
