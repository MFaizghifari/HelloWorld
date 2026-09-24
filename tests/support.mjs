// Test doubles shared by the Worker tests: D1 on a real SQLite database
// (node:sqlite) with every migration applied, and an in-memory R2 bucket.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/src/index.js';

export function d1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => { const r = db.prepare(sql).run(...params); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => (/^\s*(SELECT|WITH)/i.test(sql) ? { results: db.prepare(sql).all(...params) } : { results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => s._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

export function r2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
      return { key };
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: new Blob([o.bytes]).stream(), httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null;
    },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
}

export function makeEnv(extra = {}) {
  return { DB: d1(), ADMIN_KEY: 'secret-key', TZ_OFFSET_MINUTES: '0', ...extra };
}

/** POST /api with a JSON body; returns { status, headers, ...body }. */
export async function api(env, body, { ip = '203.0.113.9', waits = [], headers = {} } = {}) {
  const req = new Request('https://formflow.test/api', { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip, ...headers } });
  const res = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  return { status: res.status, headers: res.headers, ...(await res.json()) };
}

export async function get(env, path, headers = {}) {
  return worker.fetch(new Request(`https://formflow.test${path}`, { headers }), env, {});
}

export async function upload(env, path, bytes, headers = {}) {
  const init = { method: 'POST', body: bytes, headers: { 'CF-Connecting-IP': '203.0.113.9', ...headers } };
  if (bytes instanceof ReadableStream) init.duplex = 'half'; // streamed body without Content-Length
  return worker.fetch(new Request(`https://formflow.test${path}`, init), env, {});
}

// Smallest valid files for the type sniffer.
export const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
export const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0]);
export const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
export const HTML = new TextEncoder().encode('<!doctype html><script>alert(document.cookie)</script>');
