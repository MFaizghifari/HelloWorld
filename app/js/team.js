// Team accounts in the builder: the sign-in / setup / invitation screen, the
// account menu in the top bar, and the "Tim" dialog (members, invitations,
// roles, activity). Roles are enforced by the Worker; this only presents them.
import { el } from './dom.js';
import { icon } from './icons.js';
import { ROLES, can, assignableRoles, canManage, initials, PASSWORD_MIN } from './roles.js';

const fmtDate = (iso) => new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });

export function ago(iso) {
  if (!iso) return 'belum pernah';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 2) return 'baru saja';
  if (min < 60) return `${min} menit lalu`;
  if (min < 1440) return `${Math.round(min / 60)} jam lalu`;
  if (min < 43200) return `${Math.round(min / 1440)} hari lalu`;
  return fmtDate(iso);
}

const roleLabel = (r) => ROLES[r]?.label || r;

/** One line per activity entry, written from the team's side ("Rina menerbitkan …"). */
const ACTIVITY = {
  'team.setup': () => 'membuat akun pemilik',
  'team.invite': (t, d) => `mengundang ${t} sebagai ${roleLabel(d)}`,
  'team.invite_revoke': (t) => `membatalkan undangan untuk ${t}`,
  'team.join': (t, d) => `bergabung sebagai ${roleLabel(d)}`,
  'team.role': (t, d) => `mengubah peran ${t} (${d.split(' → ').map(roleLabel).join(' → ')})`,
  'team.remove': (t) => `mengeluarkan ${t} dari tim`,
  'team.owner': (t) => `memindahkan kepemilikan ke ${t}`,
  'account.password': () => 'mengganti kata sandinya',
  'account.reset': () => 'mengatur ulang kata sandinya lewat link reset',
  'account.reset_link': (t) => `membuat link reset kata sandi untuk ${t}`,
  'form.create': (t) => `membuat form “${t}”`,
  'form.publish': (t) => `menerbitkan “${t}”`,
  'form.delete': (t) => `menghapus form “${t}”`,
  'experiment.start': (t) => `memulai uji A/B di “${t}”`,
  'experiment.pause': (t) => `menjeda uji A/B di “${t}”`,
  'experiment.end': (t, d) => `mengakhiri uji A/B di “${t}”${/pemenang/.test(d) ? ` (${d.split('·').pop().trim()})` : ''}`,
};

export function activityText(a) {
  const f = ACTIVITY[a.action];
  return f ? f(a.target || '', a.detail || '') : a.action;
}

function avatar(user, size = '') {
  return el('span', { class: `avatar ${size}`, 'aria-hidden': 'true', text: initials(user?.name, user?.email) });
}

function linkBox(url, { note, whatsappText } = {}, copyText) {
  const input = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Link', onclick: (e) => e.target.select() });
  return el('div', { class: 'link-box' },
    el('div', { class: 'row' }, input,
      el('button', { class: 'btn small', type: 'button', onclick: () => copyText(url, 'Link disalin ✓') }, icon('copy', { size: 14 }), 'Salin'),
      whatsappText ? el('a', { class: 'btn-wa', href: `https://wa.me/?text=${encodeURIComponent(`${whatsappText}\n${url}`)}`, target: '_blank', rel: 'noopener' }, icon('whatsapp', { size: 14 }), 'Kirim lewat WA') : null),
    note ? el('p', { class: 'muted small', text: note }) : null);
}

/**
 * @param ctx { getBackend(), toast, confirmDialog, copyText, demo }
 */
export function createTeamUI(ctx) {
  const { toast, confirmDialog, copyText } = ctx;
  const backend = () => ctx.getBackend();
  const appUrl = () => `${location.origin}${location.pathname}`;

  // ─── Sign-in screen (Cloudflare only) ────────────────────────────────────
  /** Resolves with the signed-in user; shows the screen until then. */
  function signIn({ reason = '' } = {}) {
    return new Promise((resolve) => {
      const host = document.getElementById('auth');
      const hash = new URLSearchParams(location.hash.slice(1));
      const link = hash.get('join') || hash.get('reset');
      const done = (user) => {
        host.hidden = true;
        host.replaceChildren();
        if (link) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ } }
        resolve(user);
      };
      const card = (title, lede, form) => {
        host.replaceChildren(el('div', { class: 'auth-card' },
          el('div', { class: 'auth-brand' }, el('span', { class: 'tb-logo', text: 'F' }), el('span', { text: 'FormFlow' })),
          el('h1', { text: title }),
          lede ? el('p', { class: 'auth-lede', text: lede }) : null,
          form));
        host.hidden = false;
        host.querySelector('input:not([readonly])')?.focus();
      };
      const fieldRow = (label, attrs, hint) => el('label', { class: 'field' }, el('span', { text: label }), el('input', attrs), hint ? el('small', { text: hint }) : null);
      const errorLine = () => el('p', { class: 'auth-error', role: 'alert', hidden: true });
      const submitting = (form, busy, label) => {
        const b = form.querySelector('button[type=submit]');
        b.disabled = busy;
        b.textContent = busy ? 'Memproses…' : label;
      };
      const handle = (form, label, run) => form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = form.querySelector('.auth-error');
        err.hidden = true;
        submitting(form, true, label);
        try { done(await run(Object.fromEntries(new FormData(form)))); } catch (x) {
          err.textContent = x.message; err.hidden = false;
          submitting(form, false, label);
        }
      });

      const showLogin = () => {
        const form = el('form', { class: 'auth-form' },
          reason ? el('p', { class: 'auth-note', text: reason }) : null,
          fieldRow('Email', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
          fieldRow('Kata sandi', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
          errorLine(),
          el('button', { class: 'btn', type: 'submit', text: 'Masuk' }),
          el('button', { class: 'link-btn', type: 'button', onclick: showForgot, text: 'Lupa kata sandi?' }));
        handle(form, 'Masuk', (v) => backend().login(v.email, v.password));
        card('Masuk ke FormFlow', 'Pakai akun tim Anda.', form);
      };

      const showForgot = () => {
        const out = el('div');
        const form = el('form', { class: 'auth-form' },
          el('p', { class: 'auth-note', text: 'FormFlow tidak mengirim email. Minta admin tim membuat link reset di menu Tim → anggota → Link reset kata sandi.' }),
          el('p', { class: 'muted small', text: 'Pemilik yang lupa kata sandi: pakai admin key (secret ADMIN_KEY di Worker) untuk membuat link reset sendiri.' }),
          fieldRow('Admin key', { name: 'key', type: 'password', autocomplete: 'off', required: true }),
          fieldRow('Email akun', { name: 'email', type: 'email', required: true }),
          errorLine(),
          el('button', { class: 'btn', type: 'submit', text: 'Buat link reset' }),
          el('button', { class: 'link-btn', type: 'button', onclick: showLogin, text: 'Kembali ke halaman masuk' }),
          out);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = form.querySelector('.auth-error');
          err.hidden = true;
          try {
            const v = Object.fromEntries(new FormData(form));
            const r = await backend().recoverWithKey(v.key, v.email);
            location.hash = `reset=${r.token}`;
            showLink();
          } catch (x) { err.textContent = x.message; err.hidden = false; }
        });
        card('Lupa kata sandi', '', form);
      };

      const showSetup = () => {
        const form = el('form', { class: 'auth-form' },
          fieldRow('Admin key', { name: 'key', type: 'password', autocomplete: 'off', required: true }, 'Secret ADMIN_KEY yang Anda isi saat deploy Worker. Hanya diminta sekali ini.'),
          fieldRow('Nama', { name: 'name', autocomplete: 'name', required: true }),
          fieldRow('Email', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
          fieldRow('Kata sandi', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, required: true }, `Minimal ${PASSWORD_MIN} karakter. Kalimat panjang lebih aman daripada kata acak yang pendek.`),
          errorLine(),
          el('button', { class: 'btn', type: 'submit', text: 'Buat akun pemilik' }));
        handle(form, 'Buat akun pemilik', (v) => backend().setup(v));
        card('Buat akun pemilik', 'Belum ada akun di FormFlow ini. Akun pertama menjadi Pemilik, lalu Anda bisa mengundang tim.', form);
      };

      const showLink = async () => {
        const h = new URLSearchParams(location.hash.slice(1));
        const token = h.get('join') || h.get('reset');
        let info;
        try { info = await backend().inviteInfo(token); } catch (x) {
          const form = el('form', { class: 'auth-form' }, el('p', { class: 'auth-error', text: x.message }),
            el('button', { class: 'btn', type: 'button', onclick: () => { try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ } showLogin(); }, text: 'Ke halaman masuk' }));
          card('Link tidak bisa dipakai', '', form);
          return;
        }
        const reset = info.kind === 'reset';
        const label = reset ? 'Simpan & masuk' : 'Gabung & masuk';
        const form = el('form', { class: 'auth-form' },
          fieldRow('Email', { value: info.email, readonly: true, autocomplete: 'username' }),
          reset ? null : fieldRow('Nama', { name: 'name', autocomplete: 'name', required: true }),
          fieldRow(reset ? 'Kata sandi baru' : 'Kata sandi', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN, required: true }, `Minimal ${PASSWORD_MIN} karakter.`),
          errorLine(),
          el('button', { class: 'btn', type: 'submit', text: label }));
        handle(form, label, (v) => backend().acceptInvite(token, v));
        card(reset ? `Kata sandi baru${info.name ? ` untuk ${info.name}` : ''}` : 'Gabung ke tim FormFlow',
          reset ? 'Setelah disimpan, sesi di perangkat lain akan keluar.' : `Anda diundang sebagai ${roleLabel(info.role)}: ${ROLES[info.role]?.desc || ''}`, form);
      };

      if (link) { showLink(); return; }
      backend().authStatus().then((s) => (s.needsSetup ? showSetup() : showLogin()), () => showLogin());
    });
  }

  // ─── Account menu ─────────────────────────────────────────────────────────
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  function outside(e) { if (menu && !menu.contains(e.target) && !e.target.closest('#account')) closeMenu(); }

  /**
   * @param user        signed-in (or simulated) member
   * @param onViewAs    demo only: switch the simulated role
   * @param onSignOut   Cloudflare only
   */
  function mountAccount(user, { onViewAs, onSignOut } = {}) {
    const btn = document.getElementById('account');
    btn.hidden = !user;
    if (!user) return;
    btn.replaceChildren(avatar(user));
    btn.title = `${user.name || user.email} · ${roleLabel(user.role)}`;
    btn.onclick = () => {
      if (menu) { closeMenu(); return; }
      const b = backend();
      menu = el('div', { class: 'menu account-menu', role: 'menu' },
        el('div', { class: 'menu-head' }, avatar(user, 'lg'),
          el('div', {}, el('strong', { text: user.name || 'Tanpa nama' }), el('small', { text: user.email || '' }), el('span', { class: 'role-chip', text: roleLabel(user.role) }))),
        onViewAs ? el('div', { class: 'menu-section' },
          el('small', { text: 'Lihat builder sebagai (simulasi)' }),
          el('div', { class: 'seg seg-sm' }, Object.keys(ROLES).map((r) => el('button', {
            type: 'button', class: r === user.role ? 'active' : '', onclick: () => { closeMenu(); onViewAs(r); },
          }, roleLabel(r))))) : null,
        can(user.role, 'team.manage') ? el('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { closeMenu(); openTeam(user); } }, icon('users', { size: 16 }), 'Kelola tim') : null,
        b.updateAccount && !user.system ? el('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { closeMenu(); openAccount(user); } }, icon('key', { size: 16 }), 'Ubah nama / kata sandi') : null,
        onSignOut ? el('button', { class: 'menu-item', type: 'button', role: 'menuitem', onclick: () => { closeMenu(); onSignOut(); } }, icon('logout', { size: 16 }), 'Keluar') : null);
      document.body.append(menu);
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 8}px`;
      menu.style.right = `${Math.max(8, innerWidth - r.right)}px`;
      document.addEventListener('pointerdown', outside, true);
      menu.querySelector('button')?.focus();
      menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); btn.focus(); } });
    };
  }

  function openAccount(user) {
    const dlg = document.getElementById('accountDialog');
    const err = el('p', { class: 'auth-error', role: 'alert', hidden: true });
    const form = el('form', { method: 'dialog' },
      el('h2', { text: 'Akun Anda' }),
      el('label', { class: 'field' }, el('span', { text: 'Nama' }), el('input', { name: 'name', value: user.name || '', required: true })),
      el('p', { class: 'muted small', text: 'Isi dua kolom di bawah hanya jika ingin mengganti kata sandi. Perangkat lain akan keluar.' }),
      el('label', { class: 'field' }, el('span', { text: 'Kata sandi saat ini' }), el('input', { name: 'currentPassword', type: 'password', autocomplete: 'current-password' })),
      el('label', { class: 'field' }, el('span', { text: 'Kata sandi baru' }), el('input', { name: 'newPassword', type: 'password', autocomplete: 'new-password', minlength: PASSWORD_MIN })),
      err,
      el('div', { class: 'row end' },
        el('button', { class: 'btn-ghost', type: 'button', onclick: () => dlg.close(), text: 'Batal' }),
        el('button', { class: 'btn', type: 'submit', text: 'Simpan' })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const fields = { name: v.name };
      if (v.newPassword) Object.assign(fields, { currentPassword: v.currentPassword, newPassword: v.newPassword });
      try {
        const u = await backend().updateAccount(fields);
        Object.assign(user, u);
        mountAccount(user, lastMountOpts);
        dlg.close();
        toast(v.newPassword ? 'Kata sandi diganti ✓' : 'Tersimpan ✓');
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    });
    dlg.replaceChildren(form);
    dlg.showModal();
  }

  // ─── Team dialog ──────────────────────────────────────────────────────────
  let lastMountOpts = {};
  const mountAccountRemember = (user, opts = {}) => { lastMountOpts = opts; mountAccount(user, opts); };

  async function openTeam(user) {
    const dlg = document.getElementById('teamDialog');
    const body = el('div', { class: 'team-body' }, el('p', { class: 'muted', text: 'Memuat…' }));
    dlg.replaceChildren(
      el('div', { class: 'modal-head' }, el('h2', { text: 'Tim' }), el('span', { class: 'team-count muted' }),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: () => dlg.close() }, icon('close', { size: 18 }))),
      body);
    if (!dlg.open) dlg.showModal();
    await drawTeam(user, body, dlg, { flash: null });
  }

  /** view.flash = the link just created (invitation or reset), shown until the dialog closes. */
  async function drawTeam(user, body, dlg, view) {
    const b = backend();
    let data;
    try { data = await b.teamList(); } catch (x) { body.replaceChildren(el('p', { class: 'auth-error', text: x.message })); return; }
    const simulated = b.team === 'simulated';
    const redraw = () => drawTeam(user, body, dlg, view);
    const act = async (run, ok) => { try { await run(); if (ok) toast(ok); redraw(); } catch (x) { toast(x.message, 'bad'); } };
    dlg.querySelector('.team-count').textContent = `${data.members.length} anggota`;

    // Invite
    const email = el('input', { type: 'email', placeholder: 'nama@belajarlagi.id', 'aria-label': 'Email anggota baru', required: true });
    const roles = assignableRoles(user.role);
    const role = el('select', { 'aria-label': 'Peran' }, roles.map((r) => el('option', { value: r, selected: r === 'editor', text: roleLabel(r) })));
    const invite = el('form', { class: 'invite-row' }, email, role, el('button', { class: 'btn', type: 'submit' }, icon('plus', { size: 14 }), 'Buat link undangan'));
    invite.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await b.teamInvite(email.value, role.value);
        view.flash = el('div', {},
          el('p', { class: 'small', text: `Link undangan untuk ${r.invite?.email || email.value} (${roleLabel(role.value)}):` }),
          linkBox(`${appUrl()}#join=${r.token}`, {
            note: simulated
              ? 'Simulasi: di pratinjau ini link undangan hanya contoh. Setelah FormFlow di-deploy ke Cloudflare, link ini membuat akun sungguhan.'
              : 'Berlaku 7 hari, sekali pakai. FormFlow tidak mengirim email, jadi kirim link ini sendiri. Link tidak bisa dilihat lagi setelah jendela ini ditutup.',
            whatsappText: `Halo, Anda diundang ke tim FormFlow sebagai ${roleLabel(role.value)}. Buat akun di link ini:`,
          }, copyText));
        redraw();
      } catch (x) { toast(x.message, 'bad'); }
    });

    const memberRow = (m) => {
      const mine = m.id === data.me?.id;
      const manageable = !mine && canManage(user.role, m.role);
      const roleCell = manageable
        ? el('select', { class: 'pill-select', 'aria-label': `Peran ${m.name}`, onchange: (e) => act(() => b.teamSetRole(m.id, e.target.value), 'Peran diubah ✓') },
          [...new Set([m.role, ...roles])].map((r) => el('option', { value: r, selected: r === m.role, text: roleLabel(r) })))
        : el('span', { class: 'role-chip', text: roleLabel(m.role) });
      const actions = [];
      if (manageable) {
        actions.push(el('button', {
          class: 'btn-ghost small', type: 'button',
          onclick: () => act(async () => {
            const r = await b.teamResetLink(m.id);
            view.flash = el('div', {},
              el('p', { class: 'small', text: `Link reset kata sandi untuk ${m.name || m.email} (berlaku ${r.hours} jam, sekali pakai):` }),
              linkBox(`${appUrl()}#reset=${r.token}`, { whatsappText: 'Link untuk mengatur ulang kata sandi FormFlow Anda:', note: simulated ? 'Simulasi: link ini hanya contoh.' : '' }, copyText));
          }),
        }, icon('key', { size: 14 }), 'Link reset'));
        actions.push(el('button', {
          class: 'icon-btn sm danger', type: 'button', title: 'Keluarkan dari tim', 'aria-label': `Keluarkan ${m.name}`,
          onclick: async () => {
            if (!await confirmDialog(`Keluarkan ${m.name || m.email}?`, 'Akses dan semua sesi masuknya langsung berakhir. Form dan jawaban yang dibuatnya tetap ada.', { okLabel: 'Keluarkan', danger: true })) return;
            act(() => b.teamRemove(m.id), 'Anggota dikeluarkan');
          },
        }, icon('trash', { size: 14 })));
      }
      if (user.role === 'owner' && !mine && b.transferOwner) {
        actions.push(el('button', {
          class: 'link-btn', type: 'button', text: 'Jadikan pemilik',
          onclick: async () => {
            if (!await confirmDialog(`Jadikan ${m.name} pemilik?`, 'Anda akan menjadi Admin. Hanya pemilik baru yang bisa mengembalikannya.', { okLabel: 'Pindahkan' })) return;
            act(() => b.transferOwner(m.id), 'Kepemilikan dipindahkan');
          },
        }));
      }
      return el('li', { class: 'member' }, avatar(m),
        el('div', { class: 'member-text' },
          el('strong', {}, m.name || '(tanpa nama)', mine && m.name !== 'Anda' ? el('span', { class: 'muted', text: ' · Anda' }) : null),
          el('small', { text: m.email }),
          el('small', { class: 'muted', text: m.locked ? 'Terkunci 15 menit (salah kata sandi 5 kali)' : `Aktif ${ago(m.lastSeenAt)}` })),
        roleCell,
        el('div', { class: 'member-actions' }, actions));
    };

    const invites = data.invites.length ? el('section', { class: 'team-section' },
      el('h3', { text: `Undangan terbuka · ${data.invites.length}` }),
      el('ul', { class: 'invite-list' }, data.invites.map((i) => el('li', {},
        el('span', { class: 'avatar ghost', text: initials('', i.email) }),
        el('div', { class: 'member-text' }, el('strong', { text: i.email }), el('small', { class: 'muted', text: `${roleLabel(i.role)} · berlaku sampai ${fmtDate(i.expiresAt)}` })),
        el('button', { class: 'btn-ghost small', type: 'button', onclick: () => act(() => b.teamRevokeInvite(i.id), 'Undangan dibatalkan'), text: 'Batalkan' }))))) : null;

    const matrix = el('table', { class: 'role-matrix' },
      el('thead', {}, el('tr', {}, el('th', { text: '' }), ...Object.keys(ROLES).map((r) => el('th', { text: roleLabel(r) })))),
      el('tbody', {}, [
        ['Lihat hasil, jawaban & file', 'results.view'],
        ['Buat, edit & terbitkan form', 'forms.edit'],
        ['Undang & atur anggota', 'team.manage'],
      ].map(([label, perm]) => el('tr', {}, el('th', { scope: 'row', text: label }),
        ...Object.keys(ROLES).map((r) => el('td', { 'aria-label': can(r, perm) ? 'ya' : 'tidak' }, can(r, perm) ? icon('check', { size: 16 }) : el('span', { class: 'muted', text: '–' })))))));

    body.replaceChildren(...[ // replaceChildren(null) would print "null"
      simulated ? el('p', { class: 'res-note' }, el('span', { class: 'tag', text: 'Simulasi' }), 'Di pratinjau ini tim disimpan di browser Anda. Login dan undangan sungguhan aktif di backend Cloudflare.') : null,
      el('section', { class: 'team-section' }, el('h3', { text: 'Undang anggota' }), invite, view.flash ? el('div', { class: 'invite-out' }, view.flash) : null),
      el('section', { class: 'team-section' }, el('h3', { text: 'Anggota' }), el('ul', { class: 'member-list' }, data.members.map(memberRow))),
      invites,
      el('details', { class: 'team-section roles-info' }, el('summary', { text: 'Apa saja yang bisa dilakukan tiap peran?' }), matrix),
      el('section', { class: 'team-section' }, el('h3', { text: 'Aktivitas terakhir' }),
        data.activity.length
          ? el('ol', { class: 'activity' }, data.activity.slice(0, 20).map((a) => el('li', {},
            el('span', {}, el('strong', { text: a.actor }), ` ${activityText(a)}`),
            el('time', { datetime: a.ts, title: new Date(a.ts).toLocaleString('id-ID'), text: ago(a.ts) }))))
          : el('p', { class: 'muted small', text: 'Belum ada aktivitas.' })),
    ].filter(Boolean));
  }

  return { signIn, mountAccount: mountAccountRemember, openTeam, closeMenu };
}
