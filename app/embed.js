/*
 * FormFlow embed script.
 *   Inline: <div data-formflow-inline="https://…/form.html?id=…" style="height:600px"></div>
 *   Popup:  <button data-formflow="https://…/form.html?id=…">Isi form</button>
 *
 * Why use this instead of a bare <iframe>?
 *  - Forwards the host page's UTM/fbclid params into the form (hidden fields).
 *  - Passes the host's first-party _fbp/_fbc cookies so Conversions API matching works.
 *  - If the host page already runs a Meta Pixel / gtag / GTM, form events are fired
 *    on the host (first-party context) and the iframe skips its own pixel to avoid
 *    double counting.
 */
(function () {
  if (window.__formflowEmbed) return;
  window.__formflowEmbed = true;

  var FORWARD = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  var frames = [];

  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function buildSrc(raw) {
    var url = new URL(raw, location.href);
    var host = new URLSearchParams(location.search);
    FORWARD.forEach(function (k) { if (host.get(k) && !url.searchParams.get(k)) url.searchParams.set(k, host.get(k)); });
    url.searchParams.set('embed', '1');
    // Where visitors of this page came from (origin only), for the form's per-source report.
    var ref = '';
    try { ref = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    if (ref === location.origin) ref = '';
    url.searchParams.set('_ref', ref);
    if (typeof window.fbq === 'function') url.searchParams.set('hostpixel', '1');
    if (cookie('_fbp')) url.searchParams.set('_fbp', cookie('_fbp'));
    if (cookie('_fbc')) url.searchParams.set('_fbc', cookie('_fbc'));
    return url;
  }

  function makeFrame(raw) {
    var url = buildSrc(raw);
    var f = document.createElement('iframe');
    f.src = url.href;
    f.title = 'Form';
    f.allow = 'clipboard-write';
    f.style.cssText = 'width:100%;height:100%;border:0;border-radius:16px;display:block';
    frames.push({ el: f, origin: url.origin });
    return f;
  }

  function mountInline(node) {
    if (node.dataset.ffMounted) return;
    node.dataset.ffMounted = '1';
    if (!node.style.height) node.style.height = '600px';
    node.appendChild(makeFrame(node.getAttribute('data-formflow-inline')));
  }

  function openPopup(raw) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(6,11,20,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:min(900px,100%);height:min(640px,100%);background:#fff;border-radius:16px;overflow:hidden';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Tutup');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:8px;right:8px;z-index:1;width:36px;height:36px;border:0;border-radius:50%;background:rgba(6,11,20,.08);font-size:22px;cursor:pointer';
    function shut() { document.body.removeChild(overlay); document.removeEventListener('keydown', esc); }
    function esc(e) { if (e.key === 'Escape') shut(); }
    close.onclick = shut;
    overlay.onclick = function (e) { if (e.target === overlay) shut(); };
    document.addEventListener('keydown', esc);
    box.appendChild(close);
    box.appendChild(makeFrame(raw));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  var FB_STANDARD = ['Lead', 'CompleteRegistration', 'Contact', 'SubmitApplication', 'Schedule', 'Subscribe', 'StartTrial'];

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'tf-form') return;
    var known = frames.some(function (f) { return f.el.contentWindow === e.source && f.origin === e.origin; });
    if (!known) return;
    var params = d.params || {};
    if (typeof window.fbq === 'function' && d.name !== 'PageView') {
      var opts = params.eventID ? { eventID: params.eventID } : undefined;
      var clean = {};
      Object.keys(params).forEach(function (k) { if (k !== 'eventID') clean[k] = params[k]; });
      window.fbq(FB_STANDARD.indexOf(d.name) >= 0 ? 'track' : 'trackCustom', d.name, clean, opts);
    }
    if (typeof window.gtag === 'function') window.gtag('event', 'formflow_' + d.name.toLowerCase(), params);
    if (Array.isArray(window.dataLayer)) window.dataLayer.push(Object.assign({ event: 'formflow_' + d.name.toLowerCase() }, params));
    document.dispatchEvent(new CustomEvent('formflow:' + d.name, { detail: params }));
  });

  function scan() {
    document.querySelectorAll('[data-formflow-inline]').forEach(mountInline);
    document.querySelectorAll('[data-formflow]').forEach(function (b) {
      if (b.dataset.ffBound) return;
      b.dataset.ffBound = '1';
      b.addEventListener('click', function (e) { e.preventDefault(); openPopup(b.getAttribute('data-formflow')); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
