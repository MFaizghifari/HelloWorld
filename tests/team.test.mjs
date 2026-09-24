// Team accounts on the real Worker + SQLite: setup, login, invitations,
// roles enforced server-side, resets, lockout, activity log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, api } from './support.mjs';
import { can, allowedTabs } from '../app/js/roles.js';

const form = { id: 'f_team01', title: 'Kelas', questions: [{ id: 'q_name', type: 'short_text', title: 'Nama' }] };

async function owner(env) {
  const r = await api(env, { action: 'authSetup', key: 'secret-key', name: 'Faiz', email: 'Owner@Contoh.id', password: 'rahasia-panjang' });
  assert.equal(r.ok, true, r.error);
  return r.token;
}

async function join(env, token, email, role, password = 'sandi-anggota-1') {
  const inv = await api(env, { action: 'teamInvite', token, email, role });
  assert.equal(inv.ok, true, inv.error);
  const acc = await api(env, { action: 'inviteAccept', inviteToken: inv.token, name: `Tim ${role}`, password });
  assert.equal(acc.ok, true, acc.error);
  return acc;
}

test('owner setup needs the admin key, happens once, and sets an HttpOnly file cookie', async () => {
  const env = makeEnv();
  assert.equal((await api(env, { action: 'authStatus' })).needsSetup, true);
  const wrong = await api(env, { action: 'authSetup', key: 'nope', name: 'X', email: 'x@contoh.id', password: 'rahasia-panjang' });
  assert.equal(wrong.status, 401);
  const short = await api(env, { action: 'authSetup', key: 'secret-key', name: 'X', email: 'x@contoh.id', password: 'pendek' });
  assert.equal(short.status, 400);

  const r = await api(env, { action: 'authSetup', key: 'secret-key', name: 'Faiz', email: 'Owner@Contoh.id', password: 'rahasia-panjang' });
  assert.equal(r.user.role, 'owner');
  assert.equal(r.user.email, 'owner@contoh.id', 'emails are stored lower-case');
  const cookie = r.headers.get('Set-Cookie');
  assert.match(cookie, /^ff_session=[\w-]{43}; Path=\/f\/; HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await api(env, { action: 'authStatus' })).needsSetup, false);
  assert.equal((await api(env, { action: 'authSetup', key: 'secret-key', name: 'B', email: 'b@contoh.id', password: 'rahasia-panjang' })).status, 409);

  // Only hashes are stored.
  const raw = JSON.stringify(env.DB.raw.prepare('SELECT * FROM auth_sessions').all()) + JSON.stringify(env.DB.raw.prepare('SELECT pass_hash FROM users').all());
  assert.ok(!raw.includes(r.token), 'token stored hashed');
  assert.ok(!raw.includes('rahasia-panjang'), 'password stored hashed');
  assert.match(env.DB.raw.prepare('SELECT pass_hash FROM users').get().pass_hash, /^pbkdf2-sha256\$100000\$/);
});

test('login: generic errors, lockout after 5 wrong passwords, logout ends the session', async () => {
  const env = makeEnv();
  await owner(env);
  const unknown = await api(env, { action: 'authLogin', email: 'siapa@contoh.id', password: 'rahasia-panjang' });
  const wrong = await api(env, { action: 'authLogin', email: 'owner@contoh.id', password: 'salah-sekali' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.error, unknown.error, 'unknown email and wrong password look the same');

  const ok = await api(env, { action: 'authLogin', email: ' OWNER@contoh.id ', password: 'rahasia-panjang' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal((await api(env, { action: 'authMe', token: ok.token })).user.name, 'Faiz');

  for (let i = 0; i < 5; i++) await api(env, { action: 'authLogin', email: 'owner@contoh.id', password: `salah-${i}-xx` });
  const locked = await api(env, { action: 'authLogin', email: 'owner@contoh.id', password: 'rahasia-panjang' });
  assert.equal(locked.status, 401, 'correct password refused while locked');
  env.DB.raw.prepare("UPDATE users SET locked_until = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await api(env, { action: 'authLogin', email: 'owner@contoh.id', password: 'rahasia-panjang' })).ok, true, 'unlocked after 15 minutes');

  const out = await api(env, { action: 'authLogout', token: ok.token });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await api(env, { action: 'authMe', token: ok.token })).status, 401);
});

test('roles are enforced by the server, not just hidden in the UI', async () => {
  const env = makeEnv();
  const ownerToken = await owner(env);
  const editor = await join(env, ownerToken, 'editor@contoh.id', 'editor');
  const viewer = await join(env, ownerToken, 'viewer@contoh.id', 'viewer');
  const admin = await join(env, ownerToken, 'admin@contoh.id', 'admin');

  assert.equal((await api(env, { action: 'saveForm', token: editor.token, form })).ok, true);
  assert.equal((await api(env, { action: 'teamList', token: editor.token })).status, 403, 'editor cannot manage the team');
  assert.equal((await api(env, { action: 'teamInvite', token: editor.token, email: 'x@contoh.id', role: 'viewer' })).status, 403);

  assert.equal((await api(env, { action: 'listForms', token: viewer.token })).forms.length, 1);
  assert.equal((await api(env, { action: 'getResults', token: viewer.token, formId: form.id })).ok, true);
  const denied = await api(env, { action: 'saveForm', token: viewer.token, form });
  assert.equal(denied.status, 403);
  assert.match(denied.error, /Pembaca/);
  assert.equal((await api(env, { action: 'deleteForm', token: viewer.token, id: form.id })).status, 403);
  assert.equal((await api(env, { action: 'listForms' })).status, 401, 'no credentials');
  assert.equal((await api(env, { action: 'listForms', token: 'x'.repeat(43) })).status, 401, 'unknown token');

  // Admins manage members but never the owner, and nobody hands out "owner" by invitation.
  const team = await api(env, { action: 'teamList', token: admin.token });
  const ownerId = team.members.find((m) => m.role === 'owner').id;
  assert.equal((await api(env, { action: 'teamSetRole', token: admin.token, userId: ownerId, role: 'viewer' })).status, 403);
  assert.equal((await api(env, { action: 'teamRemove', token: admin.token, userId: ownerId })).status, 403);
  assert.equal((await api(env, { action: 'teamInvite', token: admin.token, email: 'o@contoh.id', role: 'owner' })).status, 400);

  // Demoting takes effect on the member's existing session.
  assert.equal((await api(env, { action: 'teamSetRole', token: admin.token, userId: editor.user.id, role: 'viewer' })).ok, true);
  assert.equal((await api(env, { action: 'saveForm', token: editor.token, form })).status, 403);
  // Removing ends their sessions.
  assert.equal((await api(env, { action: 'teamRemove', token: admin.token, userId: editor.user.id })).ok, true);
  assert.equal((await api(env, { action: 'authMe', token: editor.token })).status, 401);

  // The ADMIN_KEY secret still works for automation, as the owner.
  assert.equal((await api(env, { action: 'saveForm', key: 'secret-key', form })).ok, true);

  const log = (await api(env, { action: 'teamList', token: ownerToken })).activity.map((a) => a.action);
  for (const a of ['team.setup', 'team.invite', 'team.join', 'form.create', 'form.publish', 'team.role', 'team.remove']) assert.ok(log.includes(a), a);
  const who = (await api(env, { action: 'teamList', token: ownerToken })).activity.find((a) => a.action === 'form.create');
  assert.equal(who.actor, 'Tim editor', 'activity names the member who did it');
});

test('invitation and reset links are single-use and expire; resets sign out other devices', async () => {
  const env = makeEnv();
  const ownerToken = await owner(env);
  const inv = await api(env, { action: 'teamInvite', token: ownerToken, email: 'baru@contoh.id', role: 'editor' });
  const info = await api(env, { action: 'inviteInfo', inviteToken: inv.token });
  assert.deepEqual([info.kind, info.email, info.role], ['invite', 'baru@contoh.id', 'editor']);
  const first = await api(env, { action: 'inviteAccept', inviteToken: inv.token, name: 'Baru', password: 'sandi-baru-123' });
  assert.equal(first.ok, true, first.error);
  assert.equal((await api(env, { action: 'inviteAccept', inviteToken: inv.token, name: 'Lagi', password: 'sandi-baru-123' })).status, 404, 'used once');
  assert.equal((await api(env, { action: 'teamInvite', token: ownerToken, email: 'baru@contoh.id', role: 'viewer' })).status, 409, 'already a member');

  const old = await api(env, { action: 'teamInvite', token: ownerToken, email: 'lama@contoh.id', role: 'viewer' });
  env.DB.raw.prepare("UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE email = 'lama@contoh.id'").run();
  assert.equal((await api(env, { action: 'inviteInfo', inviteToken: old.token })).status, 410);

  // Password reset link made by the owner for the member.
  const reset = await api(env, { action: 'teamResetLink', token: ownerToken, userId: first.user.id });
  assert.equal((await api(env, { action: 'inviteInfo', inviteToken: reset.token })).name, 'Baru');
  const done = await api(env, { action: 'inviteAccept', inviteToken: reset.token, password: 'sandi-ganti-456' });
  assert.equal(done.ok, true, done.error);
  assert.equal((await api(env, { action: 'authMe', token: first.token })).status, 401, 'old session ended');
  assert.equal((await api(env, { action: 'authLogin', email: 'baru@contoh.id', password: 'sandi-ganti-456' })).ok, true);

  // The owner's own reset link needs the admin key (account recovery).
  const admin = await join(env, ownerToken, 'adm@contoh.id', 'admin');
  const team = await api(env, { action: 'teamList', token: ownerToken });
  const ownerId = team.members.find((m) => m.role === 'owner').id;
  assert.equal((await api(env, { action: 'teamResetLink', token: admin.token, userId: ownerId })).status, 403);
  assert.equal((await api(env, { action: 'teamResetLink', key: 'secret-key', email: 'owner@contoh.id' })).ok, true);
});

test('changing your own password keeps this session and ends the others', async () => {
  const env = makeEnv();
  const a = await owner(env);
  const b = (await api(env, { action: 'authLogin', email: 'owner@contoh.id', password: 'rahasia-panjang' })).token;
  assert.equal((await api(env, { action: 'accountUpdate', token: a, currentPassword: 'salah-salah', newPassword: 'baru-sekali-99' })).status, 400);
  assert.equal((await api(env, { action: 'accountUpdate', token: a, currentPassword: 'rahasia-panjang', newPassword: 'baru-sekali-99', name: 'Faiz G' })).user.name, 'Faiz G');
  assert.equal((await api(env, { action: 'authMe', token: a })).ok, true);
  assert.equal((await api(env, { action: 'authMe', token: b })).status, 401);
});

test('role helpers used by the builder', () => {
  assert.equal(can('viewer', 'results.view'), true);
  assert.equal(can('viewer', 'forms.edit'), false);
  assert.equal(can('editor', 'team.manage'), false);
  assert.equal(can('admin', 'team.manage'), true);
  assert.deepEqual(allowedTabs('viewer'), ['share', 'ab', 'results']);
});
