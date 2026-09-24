// File uploads on the real Worker with an in-memory R2 bucket: type sniffing,
// size caps, ownership checks on submit, private links, clean-up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, api, get, upload, r2, PNG, JPEG, PDF, HTML } from './support.mjs';
import { detectType, cleanFileName, purgePendingUploads } from '../worker/src/files.js';

const form = {
  id: 'f_file01',
  title: 'Beasiswa',
  questions: [
    { id: 'q_name', type: 'short_text', title: 'Nama' },
    { id: 'q_ktm', type: 'file_upload', title: 'Foto KTM', settings: { fileKind: 'image', maxSizeMb: 1, maxFiles: 2 } },
    { id: 'q_cv', type: 'file_upload', title: 'CV', settings: { fileKind: 'document' } },
  ],
};

const up = (env, bytes, { q = 'q_ktm', s = 's_up1', name = 'ktm.png', headers } = {}) =>
  upload(env, `/api/upload?form=${form.id}&question=${q}&session=${s}&name=${encodeURIComponent(name)}`, bytes, headers);

async function setup() {
  const env = makeEnv({ FILES: r2() });
  assert.equal((await api(env, { action: 'saveForm', key: 'secret-key', form })).ok, true);
  return env;
}

test('type is decided by content: renamed HTML is refused, office files need their real format', () => {
  assert.equal(detectType(PNG, 'a.png'), 'image/png');
  assert.equal(detectType(JPEG, 'foto.JPG'), 'image/jpeg');
  assert.equal(detectType(PDF, 'cv.pdf'), 'application/pdf');
  assert.equal(detectType(HTML, 'ktm.png'), null);
  assert.equal(detectType(new TextEncoder().encode('<svg onload="x()"/>'), 'logo.svg'), null);
  const zip = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4]);
  assert.match(detectType(zip, 'cv.docx'), /wordprocessingml/);
  assert.equal(detectType(zip, 'arsip.zip'), null);
  assert.equal(detectType(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0]), 'data.xls'), 'application/vnd.ms-excel');
  assert.equal(detectType(new TextEncoder().encode('nama,kota\nAyu,Bandung'), 'data.csv'), 'text/csv');
  assert.equal(detectType(new Uint8Array([0x61, 0, 0x62, 0x63]), 'data.csv'), null, 'binary is not text');
  const webp = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
  assert.equal(detectType(webp, 'x.webp'), 'image/webp');
  assert.equal(cleanFileName('../../etc/pass<wd>.png'), 'passwd.png');
  assert.equal(cleanFileName('C:\\Users\\a\\KTM%20saya.jpg'), 'KTM saya.jpg');
  assert.equal(cleanFileName(''), 'file');
});

test('uploads are checked against the question, size-capped, and stored privately', async () => {
  const env = await setup();
  const ok = await up(env, PNG);
  const body = await ok.json();
  assert.equal(ok.status, 200, body.error);
  assert.match(body.file.ref, /^u\/f_file01\/[a-f0-9]{32}$/);
  assert.deepEqual([body.file.name, body.file.type, body.file.size], ['ktm.png', 'image/png', PNG.length]);
  assert.equal(env.FILES.objects.get(body.file.ref).httpMetadata.contentType, 'image/png');

  assert.equal((await up(env, HTML)).status, 415, 'HTML named .png');
  assert.equal((await up(env, PDF, { name: 'ktm.pdf' })).status, 415, 'PDF where only images are allowed');
  assert.equal((await up(env, PDF, { q: 'q_cv', name: 'cv.pdf' })).status, 200);
  assert.equal((await up(env, PNG, { q: 'q_name' })).status, 400, 'not a file question');
  assert.equal((await up(env, PNG, { s: 'bad session' })).status, 400);
  const big = new Uint8Array(1024 * 1024 + 1); big.set(PNG);
  assert.equal((await up(env, big)).status, 413);
  assert.equal((await up(env, new Blob([big]).stream(), { headers: { 'Content-Length': '' } })).status, 413, 'streamed without a length');

  const noBucket = makeEnv();
  await api(noBucket, { action: 'saveForm', key: 'secret-key', form });
  const off = await up(noBucket, PNG);
  assert.equal(off.status, 501);
  assert.match((await off.json()).error, /R2/);
});

test('submit keeps only this visit\'s own uploads, with the server\'s name, type and size', async () => {
  const env = await setup();
  const mine = (await (await up(env, PNG, { s: 's_me1', name: 'KTM depan.png' })).json()).file;
  const theirs = (await (await up(env, PNG, { s: 's_other' })).json()).file;

  const forged = await api(env, { action: 'submit', formId: form.id, answers: { q_ktm: [{ ...theirs }] }, meta: { sessionId: 's_me1' } });
  assert.equal(forged.status, 422, 'another visitor\'s file');
  const shape = await api(env, { action: 'submit', formId: form.id, answers: { q_ktm: [{ ref: 'u/f_file01/../secret', name: 'x.png', type: 'image/png', size: 1 }] }, meta: { sessionId: 's_me1' } });
  assert.equal(shape.status, 422);
  const noSession = await api(env, { action: 'submit', formId: form.id, answers: { q_ktm: [mine] }, meta: {} });
  assert.equal(noSession.status, 422);

  const lie = { ...mine, name: 'lain.exe', size: 1 };
  const r = await api(env, { action: 'submit', formId: form.id, answers: { q_name: 'Ayu', q_ktm: [lie] }, meta: { sessionId: 's_me1' } });
  assert.equal(r.ok, true, r.error);
  const stored = JSON.parse(env.DB.raw.prepare('SELECT answers FROM responses').get().answers).q_ktm[0];
  assert.deepEqual(stored, { ref: mine.ref, name: 'KTM depan.png', type: 'image/png', size: PNG.length, url: `https://formflow.test/f/${mine.ref}` });
  assert.equal(env.DB.raw.prepare('SELECT response_id FROM uploads WHERE key = ?').get(mine.ref).response_id, r.responseId);

  // Unattached uploads older than a day are deleted, attached ones stay.
  env.DB.raw.prepare("UPDATE uploads SET created_at = '2020-01-01T00:00:00.000Z'").run();
  assert.equal(await purgePendingUploads(env), 1);
  assert.ok(env.FILES.objects.has(mine.ref));
  assert.ok(!env.FILES.objects.has(theirs.ref));
});

test('files open with a signed link from the dashboard or a team login, never publicly', async () => {
  const env = await setup();
  const file = (await (await up(env, PNG, { s: 's_view1' })).json()).file;
  await api(env, { action: 'submit', formId: form.id, answers: { q_ktm: [file] }, meta: { sessionId: 's_view1' } });

  assert.equal((await get(env, `/f/${file.ref}`)).status, 401, 'no login');
  const res = await api(env, { action: 'getResults', key: 'secret-key', formId: form.id });
  const view = res.responses[0].answers.q_ktm[0].view;
  assert.match(view, /\/f\/u\/f_file01\/[a-f0-9]{32}\?exp=\d+&sig=[\w-]+$/);
  const signed = await get(env, new URL(view).pathname + new URL(view).search);
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(signed.headers.get('Content-Security-Policy'), /sandbox/);
  assert.match(signed.headers.get('Content-Disposition'), /^inline; filename\*=UTF-8''ktm\.png$/);
  assert.match(signed.headers.get('Cache-Control'), /^private/);
  assert.deepEqual(new Uint8Array(await signed.arrayBuffer()), PNG);

  const u = new URL(view);
  assert.equal((await get(env, `${u.pathname}?exp=${u.searchParams.get('exp')}&sig=${'A'.repeat(43)}`)).status, 401, 'tampered signature');
  assert.equal((await get(env, `${u.pathname}?exp=1000&sig=${u.searchParams.get('sig')}`)).status, 401, 'expired');

  // The stable link (in Sheets, CSV, webhooks) works with the team login cookie.
  const owner = await api(env, { action: 'authSetup', key: 'secret-key', name: 'Faiz', email: 'f@contoh.id', password: 'rahasia-panjang' });
  const cookie = owner.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await get(env, `/f/${file.ref}`, { Cookie: cookie })).status, 200);
  assert.equal((await get(env, '/f/u/f_file01/../../m/x', { Cookie: cookie })).status, 404);
});

test('builder images: editors only, raster formats only, served publicly with long caching', async () => {
  const env = await setup();
  const path = `/api/media?form=${form.id}&name=logo.png`;
  assert.equal((await upload(env, path, PNG)).status, 401);
  const owner = await api(env, { action: 'authSetup', key: 'secret-key', name: 'Faiz', email: 'f@contoh.id', password: 'rahasia-panjang' });
  const inv = await api(env, { action: 'teamInvite', token: owner.token, email: 'v@contoh.id', role: 'viewer' });
  const viewer = await api(env, { action: 'inviteAccept', inviteToken: inv.token, name: 'Vi', password: 'sandi-viewer-1' });
  assert.equal((await upload(env, path, PNG, { Authorization: `Bearer ${viewer.token}` })).status, 403);
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await upload(env, path, svg, { Authorization: `Bearer ${owner.token}` })).status, 415);

  const ok = await (await upload(env, path, JPEG, { Authorization: `Bearer ${owner.token}` })).json();
  assert.match(ok.path, /^\/m\/f_file01\/[a-f0-9]{32}\.jpg$/);
  const img = await get(env, ok.path);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/jpeg');
  assert.match(img.headers.get('Cache-Control'), /immutable/);

  // Deleting the form deletes its files.
  await api(env, { action: 'deleteForm', token: owner.token, id: form.id });
  assert.equal(env.FILES.objects.size, 0);
});
