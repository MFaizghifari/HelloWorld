// Team accounts: email + password, single-use invitation / reset links,
// roles (app/js/roles.js), and the activity log.
//
// Passwords: PBKDF2-HMAC-SHA256, 100,000 iterations (the most Workers'
// WebCrypto is documented to accept), random 16-byte salt. The iteration
// count is stored with each hash and old hashes are upgraded at login.
// Tokens: 32 random bytes; only their SHA-256 is stored in D1.
import { ROLES, can, assignableRoles, canManage, passwordProblem } from '../../app/js/roles.js';
import { HttpError, json, safeEqual, uid, base64url, sha256hex, clientIp, limit } from './http.js';

export const PBKDF2_ITERATIONS = 100_000;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const SESSION_COOKIE = 'ff_session';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Any well-formed hash: unknown emails are checked against it so they take as long to reject as wrong passwords.
const DUMMY_HASH = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
// The ADMIN_KEY secret acts as the owner: for the first setup, automation and account recovery.
const SYSTEM = Object.freeze({ id: null, name: 'Admin key', email: '', role: 'owner', system: true });

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(String(password), salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  const iterations = Number(parts[1]);
  if (parts[0] !== 'pbkdf2-sha256' || parts.length !== 4 || !Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  const got = await pbkdf2(String(password), unb64(parts[2]), iterations);
  const want = unb64(parts[3]);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

const newToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 200 || !EMAIL_RE.test(e)) throw new HttpError(400, 'Email tidak valid.');
  return e;
}

function cleanName(v) {
  const n = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!n) throw new HttpError(400, 'Nama wajib diisi.');
  return n;
}

function checkPassword(v) {
  const problem = passwordProblem(v);
  if (problem) throw new HttpError(400, problem);
  return String(v);
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, system: !!u.system };
}

export function sessionCookie(token, request) {
  // Path=/f/: the cookie only opens uploaded files (stable links in Sheets, CSV, webhooks).
  // API calls carry the token in the request body instead, so /api has no CSRF surface.
  // Secure on https (always in production); plain http is local development only.
  const secure = !request || new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${token || ''}; Path=/f/; HttpOnly;${secure} SameSite=Lax; Max-Age=${token ? SESSION_DAYS * 86400 : 0}`;
}

async function createSession(env, userId) {
  const token = newToken();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(token), userId, new Date().toISOString(), daysFromNow(SESSION_DAYS)).run();
  return token;
}

async function signedIn(env, request, user) {
  const token = await createSession(env, user.id);
  return json({ ok: true, token, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, request) });
}

/** The signed-in member for a session token, or null. */
export async function userFromToken(env, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const row = await env.DB.prepare(`SELECT u.id, u.email, u.name, u.role, u.last_seen_at, s.expires_at
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(await sha256hex(token)).first();
  if (!row || row.expires_at < new Date().toISOString()) return null;
  // At most one write per hour per member for "last active".
  if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Who is calling: a team member (session token) or the ADMIN_KEY holder. */
export async function actorFor(env, request, body = {}) {
  const token = String(body.token || bearer(request) || '');
  if (body.key !== undefined || (token && env.ADMIN_KEY && safeEqual(token, env.ADMIN_KEY))) {
    if (!env.ADMIN_KEY) throw new HttpError(500, 'ADMIN_KEY belum di-set (wrangler secret put ADMIN_KEY).');
    // The admin key is a permanent owner credential: guesses are rate-limited like logins.
    await limit(env.AUTH_LIMITER, `key:${clientIp(request)}`);
    if (!safeEqual(String(body.key ?? token), env.ADMIN_KEY)) throw new HttpError(401, 'Admin key salah.');
    return SYSTEM;
  }
  if (!token) throw new HttpError(401, 'Silakan masuk dulu.');
  const user = await userFromToken(env, token);
  if (!user) throw new HttpError(401, 'Sesi berakhir. Silakan masuk lagi.');
  return user;
}

export async function requirePermission(env, request, body, permission) {
  const actor = await actorFor(env, request, body);
  if (!can(actor.role, permission)) throw new HttpError(403, `Peran ${ROLES[actor.role]?.label || actor.role} tidak punya akses untuk ini.`);
  return actor;
}

export async function audit(env, actor, action, target = '', detail = '') {
  await env.DB.prepare('INSERT INTO audit_log (ts, actor, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), String(actor?.name || actor?.email || 'Sistem').slice(0, 80), actor?.id || null, action,
      String(target).slice(0, 200), String(detail).slice(0, 300)).run();
}

// ─── Public actions ─────────────────────────────────────────────────────────
export async function authStatus(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return { ok: true, needsSetup: !Number(row.n), adminKeyConfigured: !!env.ADMIN_KEY };
}

/** Creates the owner account. Needs the ADMIN_KEY secret and works only while no account exists. */
export async function authSetup(env, request, body) {
  await limit(env.AUTH_LIMITER, `setup:${clientIp(request)}`);
  if (!env.ADMIN_KEY) throw new HttpError(500, 'ADMIN_KEY belum di-set (wrangler secret put ADMIN_KEY).');
  if (!safeEqual(String(body.key || ''), env.ADMIN_KEY)) throw new HttpError(401, 'Admin key salah.');
  const email = cleanEmail(body.email);
  const name = cleanName(body.name);
  const hash = await hashPassword(checkPassword(body.password));
  const id = uid('u');
  // Conditional insert: two setups racing each other cannot both create an owner.
  const r = await env.DB.prepare(`INSERT INTO users (id, email, name, role, pass_hash, created_at)
    SELECT ?, ?, ?, 'owner', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`).bind(id, email, name, hash, new Date().toISOString()).run();
  if (!r.meta.changes) throw new HttpError(409, 'Akun pemilik sudah ada. Silakan masuk.');
  const user = { id, email, name, role: 'owner' };
  await audit(env, user, 'team.setup', email);
  return signedIn(env, request, user);
}

export async function authLogin(env, request, body) {
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  await limit(env.AUTH_LIMITER, `login:${clientIp(request)}`);
  await limit(env.AUTH_LIMITER, `login:${email}`);
  const row = email ? await env.DB.prepare('SELECT id, email, name, role, pass_hash, failed_logins, locked_until FROM users WHERE email = ?').bind(email).first() : null;
  const locked = row?.locked_until && row.locked_until > new Date().toISOString();
  const ok = await verifyPassword(String(body.password || '').slice(0, 1000), locked || !row ? DUMMY_HASH : row.pass_hash);
  if (!row || locked || !ok) {
    // One atomic statement (parallel guesses cannot overwrite each other's count); it also
    // runs, matching nothing, for unknown or locked accounts so timing reveals nothing.
    await env.DB.prepare(`UPDATE users SET
        locked_until = CASE WHEN failed_logins + 1 >= ?2 THEN ?3 ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= ?2 THEN 0 ELSE failed_logins + 1 END
      WHERE id = ?1`).bind(row && !locked ? row.id : 'u_none', MAX_FAILED, new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()).run();
    // Same answer for unknown email, wrong password and a locked account (no account enumeration).
    throw new HttpError(401, `Email atau kata sandi salah. Setelah ${MAX_FAILED} kali salah, akun dikunci ${LOCK_MINUTES} menit.`);
  }
  const upgrade = !row.pass_hash.startsWith(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`);
  await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, pass_hash = ? WHERE id = ?')
    .bind(upgrade ? await hashPassword(String(body.password)) : row.pass_hash, row.id).run();
  return signedIn(env, request, row);
}

export async function authLogout(env, request, body) {
  const token = String(body.token || bearer(request) || '');
  if (token && token.length <= 100) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request) });
}

export async function authMe(env, request, body) {
  const me = await actorFor(env, request, body);
  // Re-issues the file cookie, e.g. after the browser cleared it.
  return json({ ok: true, user: publicUser(me) }, 200, me.system ? {} : { 'Set-Cookie': sessionCookie(String(body.token || bearer(request)), request) });
}

async function findInvite(env, token) {
  if (!token || typeof token !== 'string' || token.length > 100) throw new HttpError(404, 'Link tidak valid atau sudah dipakai.');
  const inv = await env.DB.prepare('SELECT * FROM invites WHERE token_hash = ?').bind(await sha256hex(token)).first();
  if (!inv) throw new HttpError(404, 'Link tidak valid atau sudah dipakai.');
  if (inv.expires_at < new Date().toISOString()) throw new HttpError(410, 'Link ini sudah kedaluwarsa. Minta link baru ke admin tim.');
  return inv;
}

/**
 * A link is only as good as its creator's rights right now: the creator must
 * still be a member who may give that role (invite) or manage that member at
 * their current role (reset). Links made with the admin key are always valid.
 */
async function checkLinkStillAllowed(env, inv) {
  if (inv.created_by === 'system') return;
  const creator = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(inv.created_by).first();
  let allowed = !!creator;
  if (allowed && inv.kind === 'invite') allowed = assignableRoles(creator.role).includes(inv.role);
  if (allowed && inv.kind === 'reset') {
    const target = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(inv.user_id).first();
    allowed = !!target && (inv.created_by === inv.user_id || canManage(creator.role, target.role));
  }
  if (!allowed) {
    await env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(inv.id).run();
    throw new HttpError(410, 'Link ini tidak berlaku lagi karena peran pembuatnya berubah. Minta link baru ke admin tim.');
  }
}

/** Links made by or for a member stop working when their role or membership changes. */
function revokeLinks(env, userId) {
  return env.DB.prepare('DELETE FROM invites WHERE created_by = ?1 OR user_id = ?1').bind(userId);
}

export async function inviteInfo(env, request, body) {
  await limit(env.AUTH_LIMITER, `invite:${clientIp(request)}`);
  const inv = await findInvite(env, body.inviteToken);
  await checkLinkStillAllowed(env, inv);
  const user = inv.kind === 'reset' ? await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(inv.user_id).first() : null;
  return { ok: true, kind: inv.kind, email: inv.email, role: inv.role, name: user?.name || '' };
}

/** Joins the team (invite) or sets a new password (reset), then signs in. Each link works once. */
export async function inviteAccept(env, request, body) {
  await limit(env.AUTH_LIMITER, `invite:${clientIp(request)}`);
  const inv = await findInvite(env, body.inviteToken);
  await checkLinkStillAllowed(env, inv);
  const hash = await hashPassword(checkPassword(body.password));
  const name = inv.kind === 'invite' ? cleanName(body.name) : '';
  // Whoever deletes the row owns the single use.
  const del = await env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(inv.id).run();
  if (!del.meta.changes) throw new HttpError(404, 'Link tidak valid atau sudah dipakai.');
  if (inv.kind === 'reset') {
    const u = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(inv.user_id).first();
    if (!u) throw new HttpError(404, 'Akun ini sudah dihapus dari tim.');
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(hash, u.id),
      env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(u.id), // sign out everywhere else
    ]);
    await audit(env, u, 'account.reset', u.email);
    return signedIn(env, request, u);
  }
  const id = uid('u');
  const r = await env.DB.prepare(`INSERT INTO users (id, email, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO NOTHING`).bind(id, inv.email, name, inv.role, hash, new Date().toISOString()).run();
  if (!r.meta.changes) throw new HttpError(409, 'Email ini sudah terdaftar. Silakan masuk.');
  const user = { id, email: inv.email, name, role: inv.role };
  await audit(env, user, 'team.join', inv.email, ROLES[inv.role]?.label || inv.role);
  return signedIn(env, request, user);
}

// ─── Signed-in actions ──────────────────────────────────────────────────────
export async function accountUpdate(env, request, body) {
  const me = await actorFor(env, request, body);
  if (me.system) throw new HttpError(400, 'Masuk dengan akun tim untuk mengubah profil.');
  if (body.name !== undefined) await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(cleanName(body.name), me.id).run();
  if (body.newPassword !== undefined) {
    const row = await env.DB.prepare('SELECT pass_hash FROM users WHERE id = ?').bind(me.id).first();
    // 400, not 401: a typo here must not look like an expired session to the builder.
    if (!await verifyPassword(String(body.currentPassword || ''), row.pass_hash)) throw new HttpError(400, 'Kata sandi saat ini salah.');
    const hash = await hashPassword(checkPassword(body.newPassword));
    const current = await sha256hex(String(body.token || bearer(request)));
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(hash, me.id),
      env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').bind(me.id, current),
      env.DB.prepare("DELETE FROM invites WHERE user_id = ? AND kind = 'reset'").bind(me.id),
    ]);
    await audit(env, me, 'account.password', me.email);
  }
  const u = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(me.id).first();
  return { ok: true, user: publicUser(u) };
}

export async function teamList(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const now = new Date().toISOString();
  const [users, invites, log] = await env.DB.batch([
    env.DB.prepare('SELECT id, email, name, role, created_at, last_seen_at, locked_until FROM users ORDER BY created_at'),
    env.DB.prepare('SELECT id, kind, email, role, created_at, expires_at FROM invites WHERE expires_at > ? ORDER BY created_at DESC').bind(now),
    env.DB.prepare('SELECT ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT 50'),
  ]);
  return {
    ok: true,
    me: publicUser(me),
    members: users.results.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at, lastSeenAt: u.last_seen_at, locked: !!(u.locked_until && u.locked_until > now) })),
    invites: invites.results.map((i) => ({ id: i.id, kind: i.kind, email: i.email, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at })),
    activity: log.results,
  };
}

export async function teamInvite(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const email = cleanEmail(body.email);
  const role = String(body.role || '');
  if (!assignableRoles(me.role).includes(role)) throw new HttpError(400, 'Peran tidak valid.');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) throw new HttpError(409, 'Email ini sudah menjadi anggota tim.');
  const token = newToken();
  const invite = { id: uid('i'), email, role, expiresAt: daysFromNow(INVITE_DAYS) };
  // One open invitation per email: a new link replaces the old one.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE email = ? AND kind = 'invite'").bind(email),
    env.DB.prepare('INSERT INTO invites (id, token_hash, kind, email, role, created_by, created_at, expires_at) VALUES (?, ?, \'invite\', ?, ?, ?, ?, ?)')
      .bind(invite.id, await sha256hex(token), email, role, me.id || 'system', new Date().toISOString(), invite.expiresAt),
  ]);
  await audit(env, me, 'team.invite', email, ROLES[role].label);
  return { ok: true, invite, token };
}

export async function teamRevokeInvite(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const inv = await env.DB.prepare('SELECT email FROM invites WHERE id = ?').bind(String(body.id || '')).first();
  if (!inv) throw new HttpError(404, 'Undangan tidak ditemukan.');
  await env.DB.prepare('DELETE FROM invites WHERE id = ?').bind(String(body.id)).run();
  await audit(env, me, 'team.invite_revoke', inv.email);
  return { ok: true };
}

async function memberFor(env, body) {
  const u = body.userId
    ? await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(String(body.userId)).first()
    : await env.DB.prepare('SELECT id, email, name, role FROM users WHERE email = ?').bind(String(body.email || '').trim().toLowerCase()).first();
  if (!u) throw new HttpError(404, 'Anggota tidak ditemukan.');
  return u;
}

export async function teamSetRole(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const target = await memberFor(env, body);
  const role = String(body.role || '');
  if (target.id === me.id) throw new HttpError(400, 'Peran sendiri tidak bisa diubah.');
  if (!canManage(me.role, target.role) || !assignableRoles(me.role).includes(role)) throw new HttpError(403, 'Anda tidak bisa memberi peran ini.');
  await env.DB.batch([env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, target.id), revokeLinks(env, target.id)]);
  await audit(env, me, 'team.role', target.email, `${ROLES[target.role].label} → ${ROLES[role].label}`);
  return { ok: true };
}

export async function teamRemove(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const target = await memberFor(env, body);
  if (target.id === me.id) throw new HttpError(400, 'Anda tidak bisa menghapus akun sendiri.');
  if (!canManage(me.role, target.role)) throw new HttpError(403, 'Pemilik tidak bisa dihapus. Pindahkan kepemilikan dulu.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(target.id),
    revokeLinks(env, target.id),
  ]);
  await audit(env, me, 'team.remove', target.email);
  return { ok: true };
}

/**
 * Password reset link, valid for 24 hours. There is no email sending, so the
 * admin passes the link on (e.g. by WhatsApp). The owner's link can only be
 * made with the ADMIN_KEY secret.
 */
export async function teamResetLink(env, request, body) {
  const me = await requirePermission(env, request, body, 'team.manage');
  const target = await memberFor(env, body);
  if (!me.system && target.id !== me.id && !canManage(me.role, target.role)) throw new HttpError(403, 'Link reset pemilik hanya bisa dibuat dengan admin key.');
  const token = newToken();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE user_id = ? AND kind = 'reset'").bind(target.id),
    env.DB.prepare("INSERT INTO invites (id, token_hash, kind, email, role, user_id, created_by, created_at, expires_at) VALUES (?, ?, 'reset', ?, ?, ?, ?, ?, ?)")
      .bind(uid('i'), await sha256hex(token), target.email, target.role, target.id, me.id || 'system', new Date().toISOString(), new Date(Date.now() + RESET_HOURS * 3_600_000).toISOString()),
  ]);
  await audit(env, me, 'account.reset_link', target.email);
  return { ok: true, token, email: target.email, hours: RESET_HOURS };
}

export async function teamTransferOwner(env, request, body) {
  const me = await actorFor(env, request, body);
  if (me.role !== 'owner') throw new HttpError(403, 'Hanya pemilik yang bisa memindahkan kepemilikan.');
  const target = await memberFor(env, body);
  if (target.id === me.id) return { ok: true };
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET role = 'admin' WHERE role = 'owner'"),
    env.DB.prepare("UPDATE users SET role = 'owner' WHERE id = ?").bind(target.id),
    revokeLinks(env, target.id),
    ...(me.id ? [revokeLinks(env, me.id)] : []),
  ]);
  await audit(env, me, 'team.owner', target.email);
  return { ok: true };
}

/** Expired sessions and links, and activity older than ~13 months. */
export async function purgeAuth(env) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM invites WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM audit_log WHERE ts < ?').bind(new Date(Date.now() - 400 * 86_400_000).toISOString()),
  ]);
}
