// Builds a self-contained preview of the builder for a claude.ai Artifact:
//   node tools/build-preview.mjs [outDir]
// The Artifact host wraps the page in its own <html>/<head>/<body>, blocks
// non-Google-Fonts stylesheets from other hosts, and has no backend, so the
// preview runs on browser storage with labelled example data (demo mode).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'app');
const out = process.argv[2] || join(root, 'dist', 'preview');

rmSync(out, { recursive: true, force: true });
for (const dir of ['css', 'js']) {
  mkdirSync(join(out, dir), { recursive: true });
  // form.js and dashboard.js are the standalone pages' entry points; the preview uses the builder's tabs instead.
  for (const f of readdirSync(join(app, dir)).filter((x) => !['form.js', 'dashboard.js'].includes(x))) copyFileSync(join(app, dir, f), join(out, dir, f));
}

const html = readFileSync(join(app, 'index.html'), 'utf8');
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
const stylesheets = [...head.matchAll(/<link rel="stylesheet" href="(css\/[^"]+)">/g)].map((m) => `<link rel="stylesheet" href="${m[1]}">`);

const page = [
  '<title>FormFlow Builder</title>',
  // Satoshi (Fontshare) is blocked by the Artifact CSP; DM Sans is the nearest Google Fonts fallback.
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">',
  ...stylesheets,
  '<style>html, body { height: 100%; } body { background: #FCFCFC; font-family: \'Satoshi\', \'DM Sans\', system-ui, sans-serif; } .builder { height: 100%; }</style>',
  '<script>window.FORMFLOW_CONFIG = { backend: \'local\', demo: true };</script>',
  body
    .replace(/\s*<!-- Served by the Cloudflare Worker[^>]*-->\s*<script src="formflow-config.js"><\/script>/, '\n')
    .trim(),
].join('\n');

writeFileSync(join(out, 'index.html'), `${page}\n`);
const files = readdirSync(join(out, 'css')).map((f) => `css/${f}`).concat(readdirSync(join(out, 'js')).map((f) => `js/${f}`));
writeFileSync(join(out, 'files.json'), JSON.stringify(Object.fromEntries(files.map((f) => [f, join(out, f)])), null, 2));
console.log(`Preview written to ${out} (${files.length} supporting files)`);
