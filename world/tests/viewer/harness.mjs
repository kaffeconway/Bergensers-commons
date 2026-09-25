// Commons World viewer tests: the shared harness. Imported by every *.test.mjs in this
// folder; its own name does not match *.test.mjs, so `node --test` never runs it alone.
//
// Importing it registers, on the importing file's root: a `before` that builds the
// synthetic world if it is missing, starts `python3 -m http.server` on a free port at the
// repo root and launches Chromium; and an `after` that closes every context, the browser
// and the server. Every context from newContext() refuses any request that leaves
// localhost and records it in `offenders`.
// Only the synthetic world (world/out/synthetic, id zz-synthetic) and the fixtures in this
// folder are used: nothing here describes a real place.

import { before, after } from 'node:test';
import { createRequire } from 'node:module';
import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORLD = path.resolve(HERE, '..', '..');
export const REPO = path.resolve(WORLD, '..');
export const SYN = path.join(WORLD, 'out', 'synthetic');
export const PYTHON = process.env.CW_PYTHON || process.env.PYTHON || 'python3';
export const LAUNCH_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-webgl'];
export const READY_MS = 240000;

// Console messages no test counts, in log.console or log.warnings. Chromium prints the
// ReadPixels stall as a performance note whenever a test reads pixels back.
export const IGNORED_CONSOLE = [/GPU stall due to ReadPixels/];

export function loadPlaywright() {
  const tries = [() => createRequire(import.meta.url)('playwright')];
  try {
    const root = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (root) tries.push(() => createRequire(path.join(root, 'noop.js'))('playwright'));
  } catch (e) { /* no npm: fine */ }
  tries.push(() => createRequire('/opt/node22/lib/node_modules/')('playwright'));
  for (const t of tries) { try { return t(); } catch (e) { /* next */ } }
  throw new Error('Playwright is not installed (npm i -g playwright, then npx playwright install chromium)');
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

export async function waitForServer(url, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch (e) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('http.server did not come up at ' + url);
}

let pw, browser, server, port, originUrl;
export const offenders = [];       // any request that left localhost
const contexts = [];

// The server's origin, 'http://127.0.0.1:<port>'. Set once `before` has run.
export function origin() { return originUrl; }

export async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...opts });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(originUrl + '/') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    offenders.push(u);
    return route.abort();
  });
  ctx.on('request', (r) => {
    const u = r.url();
    if (!(u.startsWith(originUrl + '/') || u.startsWith('data:') || u.startsWith('blob:'))) offenders.push(u);
  });
  contexts.push(ctx);
  return ctx;
}

// Console errors (log.console), console warnings (log.warnings) and uncaught page errors
// (log.errors). IGNORED_CONSOLE filters the first two.
export function watch(page) {
  const log = { console: [], warnings: [], errors: [] };
  const ignored = (text) => IGNORED_CONSOLE.some((re) => re.test(text));
  page.on('console', (m) => {
    const type = m.type();
    if (type !== 'error' && type !== 'warning') return;
    const text = m.text();
    if (ignored(text)) return;
    (type === 'error' ? log.console : log.warnings).push(text);
  });
  page.on('pageerror', (e) => log.errors.push(e.message));
  return log;
}

export async function openWorld(ctx, query = '?w=out/synthetic/') {
  const page = await ctx.newPage();
  const log = watch(page);
  await page.goto(originUrl + '/world/' + query);
  await page.waitForFunction(() => window.__cw && window.__cw.ready, null, { timeout: READY_MS });
  return { page, log };
}

before(async () => {
  if (!fs.existsSync(path.join(SYN, 'manifest.json'))) {
    const r = spawnSync(PYTHON, ['-m', 'commons_world', 'synthetic'], { cwd: path.join(WORLD, 'pipeline'), stdio: 'inherit' });
    if (r.status !== 0) throw new Error('could not build the synthetic world with ' + PYTHON);
  }
  pw = loadPlaywright();
  port = await freePort();
  originUrl = 'http://127.0.0.1:' + port;
  server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', REPO],
                 { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForServer(originUrl + '/world/index.html');
  browser = await pw.chromium.launch({ args: LAUNCH_ARGS });
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  if (browser) await browser.close();
  if (server) server.kill();
});

// One page on the synthetic world, shared by the tests that only read it.
let main = null;
export async function mainPage() {
  if (!main) {
    const ctx = await newContext();
    main = await openWorld(ctx);
    main.manifest = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
    main.plot = JSON.parse(fs.readFileSync(path.join(SYN, 'plot.json'), 'ascii'));
  }
  return main;
}

// Mesh analysis helpers, run inside the page on arrays the worker returned.
export const MESH_HELPERS = `
  window.__quads = function (m, ox, oz) {
    const out = [];
    for (let v = 0; v + 3 < m.vertices; v += 4) {
      const p = [];
      for (let k = 0; k < 4; k++) p.push([m.pos[(v + k) * 3] + ox, m.pos[(v + k) * 3 + 1], m.pos[(v + k) * 3 + 2] + oz]);
      out.push({ p, n: [m.nor[v * 3], m.nor[v * 3 + 1], m.nor[v * 3 + 2]] });
    }
    return out;
  };
  window.__triNormals = function (m) {
    const out = [];
    for (let t = 0; t < m.idx.length; t += 3) {
      const a = m.idx[t], b = m.idx[t + 1], c = m.idx[t + 2];
      const P = (i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
      const A = P(a), B = P(b), C = P(c);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      out.push({ g: [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]],
                 n: [m.nor[a * 3], m.nor[a * 3 + 1], m.nor[a * 3 + 2]], v: [A, B, C] });
    }
    return out;
  };
`;

/* A copy of one synthetic chunk, `level` and `key` as in the manifest, with its heights
 * edited, re-encoded exactly as FORMAT.md section 3 says.
 * `edit(dm, W, header)` gets every height sample as absolute decimetres, row-major from the
 * north-west (the apron included), and changes them in place; W is the row length and
 * `header` is {width, height, cellCm, flags, base}. The class band and the rest of the
 * header are kept; the base becomes the new minimum. Serve the result by routing the
 * manifest entry to `file` (with `bytes: gz.length`, `min`, `max`) and `file` to `gz`.
 * Returns {key, file, gz, min, max}, min and max in metres. */
export function reencodeChunk(manifest, level, key, edit) {
  const lv = manifest.levels.find((l) => l.name === level);
  const entry = lv && lv.chunks[key];
  if (!entry) throw new Error('no ' + level + ' chunk ' + key + ' in the manifest');
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(SYN, entry.file)));
  if (raw.toString('ascii', 0, 4) !== 'CWH1') throw new Error(entry.file + ' is not CWH1');
  const flags = raw.readUInt8(5), W = raw.readUInt16LE(6), H = raw.readUInt16LE(8);
  const cellCm = raw.readUInt16LE(10), base = raw.readInt32LE(20), n = W * H;
  const predicted = (flags & 1) !== 0;
  const v = new Int32Array(n);
  for (let t = 0; t < n; t++) v[t] = raw.readUInt16LE(32 + 2 * t);
  if (predicted) {
    for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {      // undo the planar predictor
      const t = r * W + q;
      const pred = (q ? v[t - 1] : 0) + (r ? v[t - W] : 0) - (q && r ? v[t - W - 1] : 0);
      v[t] = (v[t] + pred) & 0xffff;
    }
  }
  const dm = Array.from(v, (x) => x + base);
  edit(dm, W, { width: W, height: H, cellCm, flags, base });
  let nb = Infinity, top = -Infinity;
  for (const x of dm) { if (x < nb) nb = x; if (x > top) top = x; }
  if (!Number.isInteger(nb) || !Number.isInteger(top)) throw new Error('edited heights must be whole decimetres');
  if (top - nb > 65535) throw new Error('edited heights span more than 6553.5 m');
  const w = dm.map((x) => x - nb);
  const out = Buffer.from(raw);
  out.writeInt32LE(nb, 20);
  for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) {
    const t = r * W + q;
    const pred = predicted ? (q ? w[t - 1] : 0) + (r ? w[t - W] : 0) - (q && r ? w[t - W - 1] : 0) : 0;
    out.writeUInt16LE(((w[t] - pred) % 65536 + 65536) % 65536, 32 + 2 * t);
  }
  const hash8 = crypto.createHash('sha256').update(out).digest('hex').slice(0, 8);
  const file = level + '/' + key + '.' + hash8 + '.cwh.gz';
  const gz = zlib.gzipSync(out, { level: 9 });
  return { key, file, gz, min: nb / 10, max: top / 10 };
}
