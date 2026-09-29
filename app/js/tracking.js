// Facebook Pixel, GA4 and GTM integration for the respondent page.
// IDs are validated with strict patterns before being injected into the page.

export const ID_PATTERNS = {
  fbPixelId: /^\d{10,20}$/,
  ga4Id: /^G-[A-Z0-9]{4,15}$/,
  gtmId: /^GTM-[A-Z0-9]{4,10}$/,
};

export const FB_STANDARD_EVENTS = [
  'Lead', 'CompleteRegistration', 'Contact', 'SubmitApplication', 'Schedule', 'Subscribe', 'StartTrial',
];

function loadScript(src) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

export function newEventId(prefix) {
  const rnd = crypto.getRandomValues(new Uint32Array(2)).join('');
  return `${prefix}.${Date.now()}.${rnd}`;
}

function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Facebook click/browser ids for Conversions API matching.
 * _fbc is rebuilt from ?fbclid= when the cookie is not set yet
 * (format documented by Meta: fb.1.<timestamp_ms>.<fbclid>).
 */
export function fbIdentifiers() {
  const q = new URLSearchParams(location.search);
  const fbclid = q.get('fbclid');
  // embed.js passes the host page's first-party cookies via _fbp/_fbc params.
  const fbp = q.get('_fbp') || readCookie('_fbp');
  const fbc = q.get('_fbc') || readCookie('_fbc') || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : '');
  return { fbp: /^fb\.\d\.\d+\.\d+$/.test(fbp) ? fbp : '', fbc: /^fb\.\d\.\d+\..+$/.test(fbc) ? fbc.slice(0, 500) : '' };
}

export function createTracker(tracking = {}, { formId, formTitle, variant = '' } = {}) {
  const t = { ...tracking };
  const inIframe = window.parent !== window;
  // When embed.js reports the host already runs a pixel, events are fired there instead.
  const hostPixel = inIframe && new URLSearchParams(location.search).get('hostpixel') === '1';
  const pixel = !hostPixel && ID_PATTERNS.fbPixelId.test(t.fbPixelId || '') ? t.fbPixelId : null;
  const ga4 = ID_PATTERNS.ga4Id.test(t.ga4Id || '') ? t.ga4Id : null;
  const gtm = ID_PATTERNS.gtmId.test(t.gtmId || '') ? t.gtmId : null;

  if (pixel) {
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', pixel);
  }
  if (ga4) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ga4, { send_page_view: true });
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${ga4}`);
  }
  if (gtm) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    loadScript(`https://www.googletagmanager.com/gtm.js?id=${gtm}`);
  }

  // ab_variant ("x_ab12cd:B") lets Ads Manager / GA4 report conversions per A/B variant.
  const base = { form_id: formId, form_title: formTitle, ...(variant ? { ab_variant: variant } : {}) };

  function toParent(name, params) {
    // Lets embed.js on the host page fire its own pixel (first-party cookies).
    if (inIframe) window.parent.postMessage({ source: 'tf-form', name, params: { ...base, ...params } }, '*');
  }

  return {
    pixelId: pixel,
    pageView() {
      if (pixel) window.fbq('track', 'PageView');
      toParent('PageView', {});
    },
    start() {
      if (pixel) window.fbq('trackCustom', 'FormStart', base);
      if (ga4) window.gtag('event', 'form_start', base);
      if (gtm) window.dataLayer.push({ event: 'form_start', ...base });
      toParent('FormStart', {});
    },
    /** Contact details entered (not yet submitted): the audience to retarget. */
    contact() {
      if (pixel) window.fbq('trackCustom', 'FormContact', base);
      if (ga4) window.gtag('event', 'form_contact', base);
      if (gtm) window.dataLayer.push({ event: 'form_contact', ...base });
      toParent('FormContact', {});
    },
    step(question, index) {
      if (!t.stepEvents) return;
      const p = { ...base, question_id: question.id, question_title: question.title, step: index + 1 };
      if (pixel) window.fbq('trackCustom', 'FormStep', p);
      if (ga4) window.gtag('event', 'form_step', p);
      if (gtm) window.dataLayer.push({ event: 'form_step', ...p });
      toParent('FormStep', p);
    },
    /** eventId is shared with the server-side Conversions API call for deduplication. */
    submit(eventId, extra = {}) {
      const name = t.fbSubmitEvent || 'Lead';
      const p = { ...base, ...extra };
      if (pixel) {
        const fn = FB_STANDARD_EVENTS.includes(name) ? 'track' : 'trackCustom';
        window.fbq(fn, name, p, { eventID: eventId });
      }
      if (ga4) window.gtag('event', 'generate_lead', p);
      if (gtm) window.dataLayer.push({ event: 'form_submit', ...p });
      toParent(name, { ...p, eventID: eventId });
    },
  };
}
