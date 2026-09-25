// Commons World viewer tests: headless Chromium against the synthetic world.
//
//   node --test world/tests/viewer/
//
// Starts its own `python3 -m http.server` on a free port at the repo root, builds the
// synthetic world first if it is missing, and fails if any request leaves localhost.
// Environment:
//   CW_PYTHON  a Python with numpy, for the decoder vectors (default: python3)
//   PLAYWRIGHT_BROWSERS_PATH  where Playwright's Chromium lives, if not the default
// Only the synthetic world (world/out/synthetic, id zz-synthetic) and the fixtures in
// this folder are used: nothing here describes a real place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { HERE, WORLD, REPO, SYN, PYTHON, READY_MS, offenders, origin, newContext, openWorld, mainPage,
         MESH_HELPERS, reencodeChunk } from './harness.mjs';

// ------------------------------------------------------------------------------------------
test('the synthetic world loads with no console errors and becomes ready', { timeout: READY_MS + 30000 }, async () => {
  const { page, log } = await mainPage();
  await page.evaluate(() => window.__cw.frame());
  const errors = await page.evaluate(() => window.__cw.errors);
  assert.deepEqual(log.errors, [], 'page errors');
  assert.deepEqual(log.console, [], 'console errors');
  assert.deepEqual(errors, [], '__cw.errors');
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('every chunk the manifest lists is loaded, per level', async () => {
  const { page, manifest } = await mainPage();
  const stats = await page.evaluate(() => window.__cw.stats());
  for (const level of manifest.levels) {
    assert.equal(stats.chunks[level.name], Object.keys(level.chunks).length, level.name);
  }
  assert.equal(stats.failed, 0);
  assert.ok(stats.triangles > 0 && stats.drawCalls > 0, 'something was drawn');
  assert.equal(stats.buildings, 8);
  assert.equal(stats.trees, manifest.stats.map.trees.trees);
});

test('loading starts with the chunk under the camera (nearest first)', async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(() => ({ order: window.__cw.loadOrder(), pose: window.__cw.camera.pose(),
                                          crs: window.__cw.manifest.crs }));
  const first = r.order[0];
  const e = r.pose.x + r.crs.origin_e, n = r.crs.origin_n - r.pose.z;
  assert.equal(first.level, 'h1');
  assert.equal(first.key, Math.floor(e / 240) + '_' + Math.floor(n / 240));
});

test('the JavaScript CWH1 decoder matches commons_world.codec exactly', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-vectors-'));
  const out = path.join(tmp, 'vectors.json');
  const r = spawnSync(PYTHON, [path.join(HERE, 'make_vectors.py'), '--world', SYN, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'make_vectors.py failed (set CW_PYTHON to a Python with numpy):\n' + r.stderr);
  const vectors = JSON.parse(fs.readFileSync(out, 'ascii'));
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.ok(vectors.chunks.length >= 6);
  const levels = new Set();
  for (const c of vectors.chunks) {
    const got = await page.evaluate(async (c) => {
      const d = await window.__cw.decode(c.file);
      const h = d.header, W = h.width;
      let sum = 0, csum = null, min = Infinity, max = -Infinity;
      for (let i = 0; i < d.v.length; i++) {
        const dm = h.base + d.v[i];
        sum += dm * ((i % 1000) + 1);
        if (dm < min) min = dm;
        if (dm > max) max = dm;
      }
      if (d.classes) { csum = 0; for (let i = 0; i < d.classes.length; i++) csum += d.classes[i] * ((i % 1000) + 1); }
      return {
        header: { version: h.version, flags: h.flags, width: h.width, height: h.height, cellCm: h.cellCm,
                  cornerEdm: h.cornerEdm, cornerNdm: h.cornerNdm, base: h.base, epsg: h.epsg },
        points: c.points.map(([r, q]) => [r, q, h.base + d.v[r * W + q], d.classes ? d.classes[r * W + q] : null]),
        checksum: sum, classChecksum: csum, min_dm: min, max_dm: max
      };
    }, c);
    assert.deepEqual(got.header, c.header, c.level + ' ' + c.key + ' header');
    assert.deepEqual(got.points, c.points, c.level + ' ' + c.key + ' samples');
    assert.equal(got.checksum, c.checksum, c.level + ' ' + c.key + ' height checksum');
    assert.equal(got.classChecksum, c.classChecksum, c.level + ' ' + c.key + ' class checksum');
    assert.equal(got.min_dm, c.min_dm);
    assert.equal(got.max_dm, c.max_dm);
    levels.add(c.level);
  }
  assert.deepEqual([...levels].sort(), ['h1', 'h20', 'h5']);
});

test('block faces are wound outward: a raised block and a pit', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  await page.addScriptTag({ content: MESH_HELPERS });
  const r = await page.evaluate(async () => {
    const W = 242, v = new Uint16Array(W * W).fill(100), classes = new Uint8Array(W * W);
    for (let r = 100; r <= 102; r++) for (let q = 100; q <= 102; q++) v[r * W + q] = 150;   // 15 m block
    for (let r = 150; r <= 152; r++) for (let q = 60; q <= 62; q++) v[r * W + q] = 50;     // 5 m pit
    const header = { width: W, height: W, cell: 1, cellCm: 100, base: 0, apron: true, hasClasses: true };
    const res = await window.__cw.meshRaw({ header, v, classes }, 'blocks',
      { lod: 1, x0: 0, z0: 0, tint: false, edgeAbsent: [false, false, false, false] });
    const m = res.mesh;
    const tris = window.__triNormals(m);
    const bad = tris.filter((t) => t.g[0] * t.n[0] + t.g[1] * t.n[1] + t.g[2] * t.n[2] <= 0).length;
    const quads = window.__quads(m, 0, 0);
    const walls = quads.filter((q) => q.n[1] === 0);
    const centre = (q) => [0, 1, 2].map((k) => (q.p[0][k] + q.p[1][k] + q.p[2][k] + q.p[3][k]) / 4);
    // the raised cells span x, z in [99, 102]; the pit spans x in [59, 62], z in [149, 152]
    const near = (c, x0, x1, z0, z1) => c[0] >= x0 - 1e-6 && c[0] <= x1 + 1e-6 && c[2] >= z0 - 1e-6 && c[2] <= z1 + 1e-6;
    const blockWalls = walls.filter((q) => near(centre(q), 99, 102, 99, 102));
    const pitWalls = walls.filter((q) => near(centre(q), 59, 62, 149, 152));
    const out = (q, cx, cz) => { const c = centre(q); return q.n[0] * (c[0] - cx) + q.n[2] * (c[2] - cz); };
    return {
      triangles: tris.length, badTriangles: bad,
      tops: quads.filter((q) => q.n[1] > 0).length, topsUp: quads.filter((q) => q.n[1] > 0 && q.p.every((p) => p[1] === q.p[0][1])).length,
      blockWalls: blockWalls.length, blockOutward: blockWalls.filter((q) => out(q, 100.5, 100.5) > 0).length,
      blockSpan: blockWalls.map((q) => [Math.min(...q.p.map((p) => p[1])), Math.max(...q.p.map((p) => p[1]))]),
      pitWalls: pitWalls.length, pitInward: pitWalls.filter((q) => out(q, 60.5, 150.5) < 0).length,
      pitSpan: pitWalls.map((q) => [Math.min(...q.p.map((p) => p[1])), Math.max(...q.p.map((p) => p[1]))])
    };
  });
  assert.equal(r.badTriangles, 0, 'every triangle winds the way its normal points');
  assert.equal(r.tops, r.topsUp);
  assert.equal(r.blockWalls, 4, 'one merged wall per side of the raised block');
  assert.equal(r.blockOutward, 4, 'the raised block\'s walls face out of it');
  for (const s of r.blockSpan) assert.deepEqual(s, [10, 15]);
  assert.equal(r.pitWalls, 4, 'one merged wall per side of the pit');
  assert.equal(r.pitInward, 4, 'the pit\'s walls face into the pit, out of the higher ground');
  for (const s of r.pitSpan) assert.deepEqual(s, [5, 10]);
});

test('smooth grid faces up and its skirts face out of the chunk', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const W = 242, v = new Uint16Array(W * W), classes = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) v[r * W + q] = 1000 + Math.round(200 * Math.sin(r / 17) * Math.cos(q / 23));
    const header = { width: W, height: W, cell: 5, cellCm: 500, base: 0, apron: true, hasClasses: true };
    const holes = new Uint8Array(25); holes[12] = 1;   // the middle 240 m square is covered by h1
    const res = await window.__cw.meshRaw({ header, v, classes }, 'smooth', { stride: 2, holeCells: 48, holeGrid: 5, holes, skirt: 20 });
    const tris = window.__triNormals(res.mesh);
    const S = 1200, eps = 1e-3;
    let surface = 0, surfaceUp = 0, skirts = 0, skirtsOut = 0;
    for (const t of tris) {
      const ys = t.v.map((p) => p[1]);
      const vertical = Math.abs(t.g[1]) < 1e-6;
      if (!vertical) { surface++; if (t.g[1] > 0) surfaceUp++; continue; }
      skirts++;
      const xs = t.v.map((p) => p[0]), zs = t.v.map((p) => p[2]);
      const allX = (x) => xs.every((a) => Math.abs(a - x) < eps), allZ = (z) => zs.every((a) => Math.abs(a - z) < eps);
      let want = null;
      if (allX(0)) want = [-1, 0]; else if (allX(S)) want = [1, 0]; else if (allZ(0)) want = [0, -1]; else if (allZ(S)) want = [0, 1];
      else if (allX(480)) want = [1, 0]; else if (allX(720)) want = [-1, 0]; else if (allZ(480)) want = [0, 1]; else if (allZ(720)) want = [0, -1];
      if (want && t.g[0] * want[0] + t.g[2] * want[1] > 0) skirtsOut++;
    }
    return { surface, surfaceUp, skirts, skirtsOut };
  });
  assert.ok(r.surface > 1000);
  assert.equal(r.surfaceUp, r.surface, 'every surface triangle faces up');
  assert.ok(r.skirts > 0);
  assert.equal(r.skirtsOut, r.skirts, 'every skirt faces out of the drawn surface (chunk edge or hole edge)');
});

test('chunk seams are watertight at every mix of block sizes', { timeout: 180000 }, async () => {
  const { page, manifest } = await mainPage();
  const { origin_e: oe, origin_n: on } = manifest.crs;
  const i = Math.floor(oe / 240), j = Math.floor(on / 240);
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  // A is west of B (a seam across x) or north of B (a seam across z); j counts northward
  const candidates = [
    [[i, j], [i + 1, j], 'x'], [[i - 1, j], [i, j], 'x'], [[i + 1, j + 1], [i + 2, j + 1], 'x'],
    [[i, j], [i, j - 1], 'z'], [[i, j + 1], [i, j], 'z'], [[i - 1, j - 1], [i - 1, j - 2], 'z']
  ];
  const pairs = [];
  for (const [a, b, axis] of candidates) {
    const ka = a.join('_'), kb = b.join('_');
    if (h1.chunks[ka] && h1.chunks[kb]) pairs.push([ka, kb, axis]);
  }
  assert.ok(pairs.length >= 4, 'enough neighbouring land chunks to test');
  const combos = [[1, 1], [2, 2], [4, 4], [1, 2], [2, 1], [1, 4], [4, 1], [2, 4], [4, 2]];
  const results = await page.evaluate(async ({ pairs, combos }) => {
    const out = [];
    for (const [ka, kb, axis] of pairs) {
      for (const [la, lb] of combos) {
        const A = await window.__cw.meshChunk('h1', ka, la), B = await window.__cw.meshChunk('h1', kb, lb);
        const qa = window.__quads(A.mesh, A.x0, A.z0), qb = window.__quads(B.mesh, B.x0, B.z0);
        // u runs across the seam, w along it
        const U = axis === 'x' ? 0 : 2, Wd = axis === 'x' ? 2 : 0;
        const seam = axis === 'x' ? A.x0 + 240 : A.z0 + 240;
        const w0 = axis === 'x' ? A.z0 : A.x0;
        const tops = (qs, onSeamSide) => qs.filter((q) => q.n[1] > 0 && q.p.some((p) => Math.abs(p[U] - seam) < 1e-6) &&
          (onSeamSide ? Math.max(...q.p.map((p) => p[U])) <= seam + 1e-6 : Math.min(...q.p.map((p) => p[U])) >= seam - 1e-6));
        const ta = tops(qa, true), tb = tops(qb, false);
        const walls = qa.concat(qb).filter((q) => q.n[1] === 0 && q.p.every((p) => Math.abs(p[U] - seam) < 1e-6));
        const topAt = (list, w) => {
          for (const q of list) {
            const lo = Math.min(...q.p.map((p) => p[Wd])), hi = Math.max(...q.p.map((p) => p[Wd]));
            if (w > lo && w < hi) return q.p[0][1];
          }
          return null;   // sea: the water plane at 0 shows there
        };
        let checked = 0, gaps = [];
        for (let k = 0; k < 240; k++) {
          const w = w0 + k + 0.5;
          const ya = topAt(ta, w), yb = topAt(tb, w);
          if (ya === null && yb === null) continue;
          const a = ya === null ? 0 : ya, b = yb === null ? 0 : yb;
          if (a === b) { checked++; continue; }
          const lo = Math.min(a, b), hi = Math.max(a, b);
          const facing = a < b ? -1 : 1;   // the wall must face the lower side
          const ivs = walls.filter((q) => Math.sign(q.n[U]) === facing &&
              Math.min(...q.p.map((p) => p[Wd])) < w && Math.max(...q.p.map((p) => p[Wd])) > w)
            .map((q) => [Math.min(...q.p.map((p) => p[1])), Math.max(...q.p.map((p) => p[1]))])
            .sort((x, y) => x[0] - y[0]);
          let reach = lo;
          for (const [y0, y1] of ivs) { if (y0 <= reach + 1e-6) reach = Math.max(reach, y1); }
          checked++;
          if (reach < hi - 1e-6) gaps.push({ w, a, b, reach });
        }
        out.push({ ka, kb, axis, la, lb, checked, gaps: gaps.length, first: gaps.slice(0, 3) });
      }
    }
    return out;
  }, { pairs, combos });
  const failing = results.filter((r) => r.gaps > 0);
  assert.deepEqual(failing, [], 'no seam leaves a gap');
  assert.ok(results.every((r) => r.checked > 200), 'each seam was sampled along its length');
});

test('clicking the house, walls or roof, opens the specs panel', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => { window.__cw.camera.start(); window.__cw.specsOpenedBy = null; });
  await page.evaluate(() => window.__cw.frame());
  const p = await page.evaluate(() => window.__cw.houseScreenPoint());
  assert.ok(p && p.visible, 'the house is on screen from the start');
  const target = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, p);
  assert.equal(target, 'view', 'the click lands on the canvas, not on an overlay');
  assert.equal(await page.locator('#specs').isVisible(), false);
  await page.mouse.click(p.x, p.y);
  await page.locator('#specs').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__cw.specsOpenedBy), 'pick');
  const text = await page.locator('#specs').innerText();
  assert.match(text, /Synthetic Road 1/);
  assert.match(text, /3,000,000 NOK/);
  assert.match(text, /approximate/i);
  assert.match(text, /Gult/);
  assert.match(text, /not stated/i);
  // BRA-e, TBA and freehold always have a row: a blank one reads "not stated", not nothing
  assert.match(text, /External area \(BRA-e\)\s+not stated/);
  assert.match(text, /Terrace and balcony \(TBA\)\s+not stated/);
  assert.match(text, /Freehold\s+yes/);
  const { manifest } = await mainPage();
  if (manifest.files && manifest.files.facts) assert.match(text, /Measured facts/);
  else assert.match(text, /not computed yet/i);   // a world without facts.json says so
  assert.doesNotMatch(text, /(^|\s)0 NOK/, 'a blank figure is never shown as 0');
  await page.click('#specs-close');
  assert.equal(await page.locator('#specs').isVisible(), false);
  // the roof too: a click at a point halfway along the measured ridge
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  const ridge = await page.evaluate(() => {
    const h = window.__cw.internals.buildings.house, s = h.shape;
    if (!s || s.parts.length !== 1 || s.parts[0].planes.length !== 2) return null;
    const [p0, p1] = s.parts[0].planes, ring = s.parts[0].ring;
    const y = (p, x, z) => p[2] + p[0] * (x - s.at[0]) + p[1] * (z - s.at[1]);
    const ends = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const da = y(p0, a[0], a[1]) - y(p1, a[0], a[1]), db = y(p0, b[0], b[1]) - y(p1, b[0], b[1]);
      if ((da > 0) === (db > 0)) continue;
      const t = da / (da - db);
      ends.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    if (ends.length !== 2) return null;
    const x = (ends[0][0] + ends[1][0]) / 2, z = (ends[0][1] + ends[1][1]) / 2;
    return { x, z, y: Math.min(y(p0, x, z), y(p1, x, z)) };
  });
  assert.ok(ridge, 'the synthetic house has a measured gable');
  const q = await page.evaluate(async (r) => {
    const THREE = await import('three');
    const { camera, canvas } = { camera: window.__cw.internals.camera, canvas: document.getElementById('view') };
    camera.updateMatrixWorld();
    const p = new THREE.Vector3(r.x, r.y, r.z).project(camera), rect = canvas.getBoundingClientRect();
    document.getElementById('house-label').style.visibility = 'hidden';
    return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height,
             visible: p.z > -1 && p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.95 };
  }, ridge);
  assert.ok(q.visible, 'the ridge is on screen from the start');
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, q), 'view');
  await page.evaluate(() => { window.__cw.specsOpenedBy = null; });
  await page.mouse.click(q.x, q.y);
  await page.locator('#specs').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__cw.lastPick), 'house');
  assert.equal(await page.evaluate(() => window.__cw.specsOpenedBy), 'pick');
  await page.evaluate(() => { document.getElementById('house-label').style.visibility = ''; });
  await page.click('#specs-close');
});

test('a click where a hill hides the house does not open the specs', { timeout: READY_MS + 60000 }, async () => {
  // Own page: a click that picks nothing asks for pointer lock, which would swallow the
  // shared page's later clicks.
  const ctx = await newContext();
  const { page, log } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.settle());
  await page.addScriptTag({ type: 'module', content: "import * as THREE from './vendor/three/three.module.min.js'; window.__THREE = THREE;" });
  await page.waitForFunction(() => !!window.__THREE);
  // A walking spot 150-900 m out whose sight line to the house runs at least 3 m under the
  // drawn ground, and from which the house is the first building on that line.
  const spot = await page.evaluate(() => {
    const T = window.__THREE, I = window.__cw.internals, M = I.manager, h = window.__cw.house;
    const tx = h.centroid[0], tz = h.centroid[1], ty = h.ground + (h.roof - h.ground) * 0.45;
    for (let d = 150; d <= 900; d += 50) for (let a = 0; a < 360; a += 7.5) {
      const r = a * Math.PI / 180, x = tx + Math.sin(r) * d, z = tz - Math.cos(r) * d;
      const g = window.__cw.groundAt(x, z);
      if (!g || g.sea || g.level !== 'h1') continue;
      const ey = g.y + 1.7;
      let over = 0;
      for (let t = 0.03; t < 0.97; t += 0.002) {
        const s = M.surfaceAt(x + (tx - x) * t, z + (tz - z) * t);
        if (s !== null) over = Math.max(over, s - (ey + (ty - ey) * t));
      }
      if (over < 3) continue;
      const o = new T.Vector3(x, ey, z), dir = new T.Vector3(tx, ty, tz).sub(o).normalize();
      const hits = new T.Raycaster(o, dir).intersectObjects([I.buildings.othersMesh, I.buildings.houseMesh], false);
      if (hits.length && hits[0].object === I.buildings.houseMesh) return { x, z, y: ey, over, d };
    }
    return null;
  });
  assert.ok(spot, 'the synthetic hill hides the house from somewhere within 900 m');
  await page.evaluate(({ x, y, z }) => {
    const h = window.__cw.house;
    window.__cw.camera.set({ mode: 'walk', x, z, y, lookAt: [h.centroid[0], h.ground + (h.roof - h.ground) * 0.45, h.centroid[1]] });
  }, spot);
  await page.evaluate(() => window.__cw.settle());
  const p = await page.evaluate(() => window.__cw.houseScreenPoint());
  assert.ok(p.visible, 'the house is in front of the camera, behind the hill');
  // the label is drawn over hills on purpose (a locator); keep it out of the way of the click
  await page.evaluate(() => { document.getElementById('house-label').style.visibility = 'hidden'; });
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, p), 'view');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__cw.lastPick), 'house:hidden', 'the ray hit the house, and the ground in front of it was seen');
  assert.equal(await page.locator('#specs').isVisible(), false, 'the specs stay closed');
  const ring = await page.evaluate(() => ({ id: document.activeElement.id, style: getComputedStyle(document.activeElement).outlineStyle }));
  assert.deepEqual(ring, { id: 'view', style: 'none' }, 'a mouse click focuses the canvas without a focus ring');
  // Control: from the start the same click opens them. The refused click asked for pointer
  // lock, and a locked, moved mouse turns the view, so let go first.
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
  await page.evaluate(() => { window.__cw.camera.start(); window.__cw.specsOpenedBy = null; });
  await page.evaluate(() => window.__cw.settle());
  const q = await page.evaluate(() => window.__cw.houseScreenPoint());
  await page.mouse.click(q.x, q.y);
  await page.locator('#specs').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__cw.lastPick), 'house');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('the canvas shows a focus ring for the keyboard only, inside its edge', { timeout: READY_MS + 30000 }, async () => {
  // Own page: Chromium keeps the Tab starting point at the last element focused, even after
  // blur(), so on the shared page Tab would start after whichever button a test clicked.
  const ctx = await newContext();
  const { page } = await openWorld(ctx);
  await page.keyboard.press('Tab');
  const k = await page.evaluate(() => {
    const a = document.activeElement, cs = getComputedStyle(a);
    return { id: a.id, visible: a.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth, offset: parseFloat(cs.outlineOffset) };
  });
  assert.equal(k.id, 'view', 'the canvas is the first stop in the tab order');
  assert.equal(k.visible, true);
  assert.equal(k.style, 'solid');
  assert.equal(k.width, '2px');
  assert.ok(k.offset < 0, 'drawn inside the edge, where the viewport cannot clip it');
  // (a mouse click shows no ring: checked on its own page in the hidden-house test above)
  await page.close();
});

test('the Specs button opens the same panel', async () => {
  const { page } = await mainPage();
  await page.click('#btn-specs');
  assert.equal(await page.locator('#specs').isVisible(), true);
  assert.equal(await page.getAttribute('#btn-specs', 'aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#specs').isVisible(), false);
});

test('plot tint covers the parcel area to within 1% at each block size', { timeout: 120000 }, async () => {
  const { page, plot, manifest } = await mainPage();
  const area = plot.parcels.reduce((s, p) => s + p.area_polygon_m2, 0);
  // the live view: everything near the start is drawn in 1 m blocks
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  const live = await page.evaluate(() => window.__cw.plotTintCells());
  assert.ok(live.byCell['1'], 'the plot is tinted in 1 m blocks near the house');
  assert.ok(Math.abs(live.byCell['1'].area - area) / area < 0.01, 'live 1 m: ' + live.byCell['1'].area + ' vs ' + area);
  // each block size, meshing every chunk the parcel touches
  const { origin_e: oe, origin_n: on } = manifest.crs;
  const xs = plot.parcels.flatMap((p) => p.ring.map((q) => q[0])), zs = plot.parcels.flatMap((p) => p.ring.map((q) => q[1]));
  const keys = new Set();
  for (const x of [Math.min(...xs), Math.max(...xs)]) for (const z of [Math.min(...zs), Math.max(...zs)]) {
    keys.add(Math.floor((x + oe) / 240) + '_' + Math.floor((on - z) / 240));
  }
  for (const lod of [1, 2, 4]) {
    const got = await page.evaluate(async ({ keys, lod }) => {
      let cells = 0, strong = 0;
      for (const k of keys) {
        const m = await window.__cw.meshChunk('h1', k, lod);
        cells += m.mesh.tint.cells; strong += m.mesh.tint.strong;
      }
      return { cells, strong };
    }, { keys: [...keys], lod });
    const tinted = got.cells * lod * lod;
    const err = Math.abs(tinted - area) / area;
    assert.ok(err < 0.01, lod + ' m blocks: ' + tinted + ' m2 tinted against ' + area + ' m2 (' + (100 * err).toFixed(2) + '%)');
    assert.ok(got.strong > 0 && got.strong < got.cells, 'boundary cells are marked strongly, the rest lightly');
  }
});

test('credits are visible, include three.js, and the (i) button collapses them', async () => {
  const { page } = await mainPage();
  const body = page.locator('#credits-body');
  assert.equal(await body.isVisible(), true);
  const text = await body.innerText();
  assert.match(text, /Synthetic test world/);
  assert.match(text, /three\.js \(MIT\)/);
  const size = await body.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  assert.ok(size >= 11, 'credits font size ' + size);
  await page.click('#credits-toggle');
  assert.equal(await body.isVisible(), false);
  assert.equal(await page.locator('#credits-toggle').isVisible(), true, 'the (i) button stays');
  assert.equal(await page.getAttribute('#credits-toggle', 'aria-expanded'), 'false');
  await page.click('#credits-toggle');
  assert.equal(await body.isVisible(), true);
});

test('the view is not just sky', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.frame());
  await page.evaluate(() => { for (const id of ['bar', 'credits', 'hint', 'status', 'house-label']) document.getElementById(id).style.visibility = 'hidden'; });
  const png = await page.screenshot();
  await page.evaluate(() => { for (const id of ['bar', 'credits', 'hint', 'status', 'house-label']) document.getElementById(id).style.visibility = ''; });
  const r = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, s = 0, s2 = 0, skyish = 0;
    for (let i = 0; i < d.length; i += 16) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++; s += y; s2 += y * y;
      if (d[i + 2] > d[i] + 25 && d[i + 2] > d[i + 1] + 5) skyish++;
    }
    const mean = s / n;
    return { std: Math.sqrt(s2 / n - mean * mean), skyFraction: skyish / n };
  }, png.toString('base64'));
  assert.ok(r.std > 18, 'luminance spread ' + r.std.toFixed(1));
  assert.ok(r.skyFraction < 0.7, 'sky-coloured fraction ' + r.skyFraction.toFixed(2));
});

test('the sun is placed by grid bearing = true azimuth + grid north offset', async () => {
  const { page, manifest } = await mainPage();
  const s = await page.evaluate(() => window.__cw.sun);
  const off = manifest.crs.grid_north_offset_deg;
  assert.ok(Math.abs(s.offset - off) < 1e-9);
  assert.ok(Math.abs(s.gridBearing - (s.trueAzimuth + off)) < 1e-9);
  const b = s.gridBearing * Math.PI / 180, e = s.elevation * Math.PI / 180;
  assert.ok(Math.abs(s.dir[0] - Math.sin(b) * Math.cos(e)) < 1e-9, 'east component');
  assert.ok(Math.abs(s.dir[2] + Math.cos(b) * Math.cos(e)) < 1e-9, 'z is south, so north is -z');
  assert.ok(Math.abs(s.dir[1] - Math.sin(e)) < 1e-9);
});

test('walking: gravity lands on the block top, and W moves forward', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  const start = await page.evaluate(() => window.__cw.camera.get());
  const g = await page.evaluate(({ x, z }) => window.__cw.groundAt(x, z), start);
  assert.equal(g.level, 'h1');
  assert.equal(start.feet, g.y, 'standing on the block top');
  await page.evaluate(({ x, y, z }) => window.__cw.camera.set({ x, y: y + 6, z, mode: 'walk' }), start);
  await page.waitForFunction((gy) => Math.abs(window.__cw.camera.get().feet - gy) < 1e-6, g.y, { timeout: 20000 });
  await page.focus('#view');
  await page.keyboard.down('KeyW');
  await page.waitForFunction((s) => { const c = window.__cw.camera.get(); return Math.hypot(c.x - s.x, c.z - s.z) > 0.5; }, start, { timeout: 20000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyF');
  assert.equal(await page.evaluate(() => window.__cw.camera.get().mode), 'fly');
  assert.equal(await page.getAttribute('#btn-mode', 'aria-pressed'), 'true');
  await page.keyboard.press('KeyF');
  assert.equal(await page.evaluate(() => window.__cw.camera.get().mode), 'walk');
  await page.evaluate(() => window.__cw.camera.start());
});

test('measured facts render from facts.json, with methods as tooltips and details', { timeout: READY_MS + 30000 }, async () => {
  const ctx = await newContext();
  const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'facts.synthetic.json'), 'ascii'));
  fx.plot.bands_deg[fx.plot.bands_deg.length - 1].to = 90;   // as the pipeline writes the last band
  // how sure each summit is: the pipeline's h_basis and summit_offset_m
  fx.access.peaks[0].h_basis = 'highest in the 200 m square; 80 m from the place\'s point, so possibly a neighbouring top';
  fx.access.peaks[0].summit_offset_m = 80;
  fx.access.peaks[1].h_basis = "no distinct top within 30 m of the place's point (the ground rises on past it)";
  const fixture = JSON.stringify(fx);
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    m.files.facts = { file: 'facts.json', bytes: fixture.length, sha256: '' };
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  await ctx.route('**/out/synthetic/facts.json', (route) => route.fulfill({ status: 200, body: fixture, contentType: 'application/json' }));
  const { page, log } = await openWorld(ctx);
  await page.click('#btn-specs');
  const specs = page.locator('#specs');
  const text = await specs.innerText();
  assert.match(text, /Measured facts/);
  assert.match(text, /21 Dec/);
  assert.match(text, /2\.3 h/);          // terrain only, 21 Dec
  assert.match(text, /1\.7 h/);          // with trees, 21 Dec
  assert.match(text, /431 m\u00b2/);     // largest patch under 5 degrees
  assert.match(text, /Synthetic Fjell/);
  assert.match(text, /reaches the summit/);
  assert.match(text, /short of the named point/, 'with no distinct top, the route is to the named point, not a summit');
  assert.doesNotMatch(text, /short of the summit/);
  assert.match(text, /over 20\u00b0/, 'the band that runs to vertical reads "over", not "20-90"');
  assert.match(text, /No distinct top near the name/);
  assert.match(text, /The top measured is 80 m from the place's point, so it may be a neighbouring top/);
  assert.doesNotMatch(text, /90\u00b0/);
  assert.equal(await page.locator('#specs details.method').count(), 3);
  assert.equal(await page.locator('#specs h3[title]').count(), 3);
  assert.equal(await page.locator('#specs ol.bars li').count(), 12);
  const sun = await page.evaluate(() => window.__cw.sun);
  assert.match(sun.source, /facts\.json/);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('an unknown format version is refused with a readable message', { timeout: 60000 }, async () => {
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    m.version = 99;
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  const page = await ctx.newPage();
  await page.goto(origin() + '/world/?w=out/synthetic/');
  await page.locator('#error').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page.locator('#error').innerText(), /version 99/);
  const page2 = await ctx.newPage();
  await page2.goto(origin() + '/world/?w=../../etc/');
  await page2.locator('#error').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page2.locator('#error').innerText(), /not a folder inside world/);
  const page3 = await ctx.newPage();
  await page3.goto(origin() + '/world/?w=out/no-such-world/');
  await page3.locator('#error').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await page3.locator('#error').innerText(), /no manifest\.json/);
  await Promise.all([page.close(), page2.close(), page3.close()]);
});

test('phone viewport, 390 x 844: no sideways scroll, touch controls, pixel ratio capped', { timeout: READY_MS + 30000 }, async () => {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const { page, log } = await openWorld(ctx);
  const r = await page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return !e.hidden && b.width > 0 && b.left >= 0 && b.right <= innerWidth + 0.5 && b.top >= 0 && b.bottom <= innerHeight + 0.5; };
    return {
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth, stick: vis('stick'), specs: vis('btn-specs'), mode: vis('btn-mode'),
      credits: vis('credits-toggle'), creditsFont: parseFloat(getComputedStyle(document.getElementById('credits-body')).fontSize),
      stats: window.__cw.stats(), touch: window.__cw.touch
    };
  });
  assert.ok(r.scrollW <= r.clientW, 'document scrollWidth ' + r.scrollW + ' > ' + r.clientW);
  assert.ok(r.bodyScrollW <= r.clientW);
  assert.equal(r.touch, true);
  assert.ok(r.stick && r.specs && r.mode && r.credits, 'controls inside the viewport');
  assert.ok(r.creditsFont >= 11);
  assert.equal(r.stats.profile, 'phone');
  assert.ok(r.stats.pixelRatio <= 1.5, 'pixel ratio ' + r.stats.pixelRatio);
  // the specs sheet fits the width too
  await page.tap('#btn-specs');
  const sheet = await page.evaluate(() => { const b = document.getElementById('specs').getBoundingClientRect(); return { left: b.left, right: b.right, sw: document.documentElement.scrollWidth }; });
  assert.ok(sheet.left >= 0 && sheet.right <= 390.5 && sheet.sw <= 390);
  // the Up and Down buttons work from the keyboard too, while held
  await page.tap('#specs-close');
  await page.tap('#btn-mode');
  assert.equal(await page.locator('#btn-up').isVisible(), true, 'Up and Down show while flying');
  await page.focus('#btn-up');
  await page.keyboard.down('Enter');
  assert.equal(await page.evaluate(() => window.__cw.internals.controls.buttonsVertical), 1);
  await page.keyboard.up('Enter');
  assert.equal(await page.evaluate(() => window.__cw.internals.controls.buttonsVertical), 0);
  await page.focus('#btn-down');
  await page.keyboard.down('Space');
  assert.equal(await page.evaluate(() => window.__cw.internals.controls.buttonsVertical), -1);
  await page.keyboard.up('Space');
  assert.equal(await page.evaluate(() => window.__cw.internals.controls.buttonsVertical), 0);
  // landscape
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => window.__cw.frame());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('a chunk whose header disagrees with its manifest key is refused, not drawn elsewhere', { timeout: READY_MS + 60000 }, async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const keys = Object.keys(h1.chunks).sort();
  const [a, b] = [keys[0], keys[keys.length - 1]];
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    const l = m.levels.find((x) => x.name === 'h1');
    const fa = l.chunks[a], fb = l.chunks[b];
    l.chunks[a] = fb; l.chunks[b] = fa;          // two chunk files swapped between keys
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  const { page } = await openWorld(ctx);
  const r = await page.evaluate(() => ({ stats: window.__cw.stats(), errors: window.__cw.errors, status: document.getElementById('status').textContent }));
  assert.equal(r.stats.failed, 2, 'both chunks refused');
  assert.equal(r.errors.length, 2);
  for (const e of r.errors) assert.match(e, /header corner[EN]dm is -?\d+, the manifest key says -?\d+/);
  assert.match(r.status, /2 problems/);
  await page.close();
});

test('the title never falls back to the world id; screen readers hear the end of loading, not each chunk', { timeout: READY_MS + 60000 }, async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
  const listing = JSON.parse(fs.readFileSync(path.join(SYN, manifest.files.listing.file), 'ascii'));
  listing.approved_text = {};
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/' + manifest.files.listing.file, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(listing), contentType: 'application/json' }));
  const { page, log } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.frame());
  const r = await page.evaluate(() => {
    const s = document.getElementById('status'), a = document.getElementById('announce');
    return { title: document.getElementById('title').textContent, statusLive: s.getAttribute('aria-live'), statusRole: s.getAttribute('role'),
             live: a.getAttribute('aria-live'), announce: a.textContent, heading: document.getElementById('specs-title').textContent };
  });
  assert.equal(r.title, 'Commons World');
  assert.doesNotMatch(r.title, /zz-synthetic/);
  assert.equal(r.heading, 'Listing');
  assert.equal(r.statusLive, null, 'the chunk counter is not a live region');
  assert.equal(r.statusRole, null);
  assert.equal(r.live, 'polite');
  assert.equal(r.announce, 'The world has loaded.');
  assert.deepEqual(log.errors, []);
  await page.close();
});

// ------------------------------------------------------------------------------------------
// Grounding and seams, found on the first real world (integration, 25 Sept): trees stood on
// their 1 m top over coarse blocks, walls stopped short of the ground downhill of a building,
// and a border wall's depth came from one apron column, which cannot see a drop inside the
// neighbour's 4 m block.

test('trees stand on the drawn surface at every detail, near set included', { timeout: 180000 }, async () => {
  const { page } = await mainPage();
  const check = () => page.evaluate(() => {
    const { trees, manager, camera } = window.__cw.internals;
    const m = camera.matrix.clone();
    let n = 0, off = 0, worst = 0, near = 0;
    const meshes = trees.groups.flatMap((g) => g.meshes).concat(trees.nearMeshes);
    for (const mesh of meshes) for (let k = 0; k < mesh.count; k++) {
      mesh.getMatrixAt(k, m);
      const e = m.elements, top = manager.surfaceAt(e[12], e[14]);
      if (top === null) continue;
      n++;
      if (mesh.name.startsWith('trees:near:')) near++;
      if (Math.abs(e[13] - top) > 1e-3) { off++; worst = Math.max(worst, Math.abs(e[13] - top)); }
    }
    return { n, off, worst, near };
  });
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  const start = await check();
  // next to a tree, so the near set holds some
  const tree = await page.evaluate(() => {
    const T = window.__cw.internals.trees, k = T.groups[0].meshes[0].userData.ids[0];
    return { x: T.tx[k] + 4, z: T.tz[k] + 3 };
  });
  await page.evaluate(({ x, z }) => window.__cw.camera.set({ x, z, mode: 'walk' }), tree);
  await page.evaluate(() => window.__cw.settle());
  const near = await check();
  const cam = await page.evaluate(() => window.__cw.camera.get());
  await page.evaluate(({ x, z }) => window.__cw.camera.set({ x, z, y: 1500, mode: 'fly' }), cam);
  await page.evaluate(() => window.__cw.settle());
  const far = await check();
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  const back = await check();
  assert.ok(start.n > 100, 'trees were checked');
  assert.equal(start.off, 0, 'near the start: ' + JSON.stringify(start));
  assert.ok(near.near > 0, 'the near set was checked too: ' + JSON.stringify(near));
  assert.equal(near.off, 0, 'next to a tree: ' + JSON.stringify(near));
  assert.equal(far.off, 0, 'from 1.5 km up: ' + JSON.stringify(far));
  assert.equal(back.off, 0, 'back at the start: ' + JSON.stringify(back));
});

test('the chunk worker takes border walls down to a neighbour floor, and reports how far', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const W = 242, v = new Uint16Array(W * W).fill(200), classes = new Uint8Array(W * W);   // flat, 20 m
    const header = { width: W, height: W, cell: 1, cellCm: 100, base: 0, apron: true, hasClasses: true };
    const opts = { lod: 4, x0: 0, z0: 0, tint: false, edgeAbsent: [false, false, false, false] };
    const plain = await window.__cw.meshRaw({ header, v: v.slice(), classes }, 'blocks', opts);
    const east = new Int16Array(240).fill(20); east.fill(5, 100, 104);
    const withFloor = await window.__cw.meshRaw({ header, v: v.slice(), classes }, 'blocks',
      Object.assign({}, opts, { floors: [null, east, null, null] }));
    const eastWalls = (m) => {
      const out = [];
      for (let q = 0; q + 3 < m.vertices; q += 4) {
        const xs = [0, 1, 2, 3].map((k) => m.pos[(q + k) * 3]);
        if (m.nor[q * 3] > 0 && xs.every((x) => x === 240)) {
          const zs = [0, 1, 2, 3].map((k) => m.pos[(q + k) * 3 + 2]), ys = [0, 1, 2, 3].map((k) => m.pos[(q + k) * 3 + 1]);
          out.push({ z0: Math.min(...zs), z1: Math.max(...zs), bottom: Math.min(...ys), top: Math.max(...ys) });
        }
      }
      return out;
    };
    const covering = (walls, z) => walls.filter((w) => w.z0 <= z && w.z1 >= z + 1).map((w) => w.bottom);
    return {
      plainBottom: Array.from(plain.mesh.edgeBottom[1].slice(100, 104)), floorBottom: Array.from(withFloor.mesh.edgeBottom[1].slice(100, 104)),
      otherBottom: withFloor.mesh.edgeBottom[1][0], west: withFloor.mesh.edgeBottom[3][100],
      plainWall: covering(eastWalls(plain.mesh), 100), floorWall: covering(eastWalls(withFloor.mesh), 100)
    };
  });
  assert.deepEqual(r.plainBottom, [18, 18, 18, 18], 'without a floor: 2 m below the flat top');
  assert.ok(r.floorBottom.every((b) => b <= 5), 'with a floor of 5 m the wall reaches it: ' + r.floorBottom);
  assert.equal(r.otherBottom, 18, 'only where the floor is low');
  assert.equal(r.west, 18);
  assert.ok(r.plainWall.length && Math.min(...r.plainWall) === 18);
  assert.ok(r.floorWall.length && Math.min(...r.floorWall) <= 5, 'the drawn wall reaches it too');
});

/* A copy of one synthetic h1 chunk with a 15 m pit just inside its west edge: the seam
 * column itself (and so the western neighbour's apron) is untouched, so only the
 * neighbour's 4 m block sees the drop. Re-encoded by the harness's reencodeChunk. */
function pittedChunk(manifest) {
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const { origin_e: oe, origin_n: on } = manifest.crs;
  const i0 = Math.floor(oe / 240), j0 = Math.floor(on / 240);
  let pick = null;
  for (const [key, entry] of Object.entries(h1.chunks)) {
    const [i, j] = key.split('_').map(Number);
    const west = (i - 1) + '_' + j;
    // A (west) nearer the start than B, and both far enough out for 4 m blocks from the start
    if (!h1.chunks[west] || i - 1 !== i0 + 5 || j !== j0) continue;
    if (entry.min < 25 || h1.chunks[west].min < 5) continue;
    pick = { key, west, entry };
    break;
  }
  if (!pick) return null;
  const res = reencodeChunk(manifest, 'h1', pick.key, (dm, W) => {
    for (let r = 101; r <= 104; r++) for (let q = 2; q <= 4; q++) dm[r * W + q] -= 150;   // one 4 m block, not its seam column
  });
  return { key: res.key, west: pick.west, file: res.file, gz: res.gz, min: res.min, max: res.max };
}

test('a drop inside a neighbour\'s 4 m block leaves no gap in the seam, whichever loads first', { timeout: READY_MS + 60000 }, async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
  const pit = pittedChunk(manifest);
  assert.ok(pit, 'the synthetic world has a land chunk pair to use');
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    const h1 = m.levels.find((l) => l.name === 'h1');
    h1.chunks[pit.key] = Object.assign({}, h1.chunks[pit.key], { file: pit.file, bytes: pit.gz.length, min: pit.min, max: pit.max });
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  await ctx.route('**/out/synthetic/' + pit.file, (route) => route.fulfill({ status: 200, body: pit.gz, contentType: 'application/gzip' }));
  const { page, log } = await openWorld(ctx);
  await page.addScriptTag({ content: MESH_HELPERS });
  await page.evaluate(() => window.__cw.settle());
  const r = await page.evaluate(({ a, b }) => {
    const M = window.__cw.internals.manager;
    const A = M.byKey['h1:' + a], B = M.byKey['h1:' + b];
    const live = (c) => {
      const g = c.mesh.geometry;
      return window.__quads({ pos: g.attributes.position.array, nor: g.attributes.normal.array, vertices: g.attributes.position.count }, c.x0, c.z0);
    };
    const qa = live(A), qb = live(B), seam = A.x0 + 240;
    const gaps = [];
    for (let k = 96; k < 112; k++) {
      const z = A.z0 + k + 0.5;
      const topOf = (qs, west) => {
        for (const q of qs) {
          if (q.n[1] <= 0) continue;
          const xs = q.p.map((p) => p[0]), zs = q.p.map((p) => p[2]);
          const touches = west ? Math.max(...xs) === seam : Math.min(...xs) === seam;
          if (touches && Math.min(...zs) < z && Math.max(...zs) > z) return q.p[0][1];
        }
        return 0;
      };
      const ya = topOf(qa, true), yb = topOf(qb, false);
      if (ya === yb) continue;
      const hiQuads = ya > yb ? qa : qb, facing = ya > yb ? 1 : -1;   // the higher side's walls face the lower
      const ivs = hiQuads.filter((q) => q.n[1] === 0 && Math.sign(q.n[0]) === facing && q.p.every((p) => p[0] === seam) &&
        Math.min(...q.p.map((p) => p[2])) < z && Math.max(...q.p.map((p) => p[2])) > z).map((q) => [Math.min(...q.p.map((p) => p[1])), Math.max(...q.p.map((p) => p[1]))]);
      const lo = Math.min(ya, yb);
      const reach = ivs.length ? Math.min(...ivs.map((iv) => iv[0])) : Math.max(ya, yb);
      if (reach > lo) gaps.push({ z: k, west: ya, east: yb, wallReaches: reach });
    }
    return { lods: [A.lod, B.lod], gaps, remeshes: M.dispatchLog.filter((j) => j.kind === 'remesh').map((j) => j.key),
             debts: M.seamDebts(), order: [M.dispatchLog.findIndex((j) => j.key === a && j.kind === 'load'), M.dispatchLog.findIndex((j) => j.key === b && j.kind === 'load')] };
  }, { a: pit.west, b: pit.key });
  assert.deepEqual(r.lods, [4, 4], 'both chunks in 4 m blocks');
  assert.ok(r.order[0] >= 0 && r.order[0] < r.order[1], 'the western chunk was meshed before its neighbour loaded');
  assert.ok(r.remeshes.includes(pit.west), 'so it was re-meshed once the neighbour arrived');
  assert.deepEqual(r.gaps, [], 'no gap where the 4 m block drops');
  assert.deepEqual(r.debts, [], 'no border wall anywhere stops above what its neighbour can draw');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('building walls reach the drawn ground all round, even where the recorded ground is high', { timeout: READY_MS + 60000 }, async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SYN, manifest.files.buildings.file))).toString('utf8'));
  // as on a slope: the median under the footprint 4 m above the ground at its edge (the
  // measured roof, if any, moved up with it)
  const raised = doc.features.find((f) => !f.house);
  raised.ground += 4;
  raised.roof += 4;
  const s = raised.roof_shape;
  if (s && s.parts) {
    for (const part of s.parts) for (const plane of part.planes) plane[2] += 4;
    s.eave += 4;
    s.ridge += 4;
  }
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/' + manifest.files.buildings.file, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(doc), contentType: 'application/json' }));
  const { page, log } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  await page.evaluate(() => window.__cw.settle());
  const check = () => page.evaluate(() => {
    const { buildings, manager } = window.__cw.internals;
    const out = [];
    for (const it of buildings.items) {
      const P = (it.house ? buildings.houseMesh : buildings.othersMesh).geometry.attributes.position.array;
      // the wall bottoms as drawn, in pairs along each wall; the lowest drawn ground 0.3 m
      // either side of every wall
      let bottom = Infinity, ground = Infinity;
      for (let k = 0; k + 1 < it.verts.length; k += 2) {
        const a = it.verts[k], b = it.verts[k + 1];
        const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2];
        bottom = Math.min(bottom, P[a * 3 + 1], P[b * 3 + 1]);
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        const nx = -(bz - az) / len, nz = (bx - ax) / len, steps = Math.max(1, Math.ceil(len * 2));
        for (let st = 0; st <= steps; st++) {
          const x = ax + (bx - ax) * st / steps, z = az + (bz - az) * st / steps;
          for (const side of [0.3, -0.3]) {
            const t = manager.surfaceAt(x + nx * side, z + nz * side);
            if (t !== null) ground = Math.min(ground, t);
          }
        }
      }
      out.push({ id: it.id, walls: it.verts.length / 2, bottom, ground, recordedMinus2: it.ground - 2 });
    }
    return out;
  });
  const near = await check();
  const cam = await page.evaluate(() => window.__cw.camera.get());
  await page.evaluate(({ x, z }) => window.__cw.camera.set({ x, z, y: 1500, mode: 'fly' }), cam);
  await page.evaluate(() => window.__cw.settle());
  const far = await check();
  const hi = near.find((b) => b.id === raised.id);
  assert.ok(near.every((b) => b.walls > 0), 'every building has walls');
  assert.ok(hi.recordedMinus2 > hi.ground, 'the raised building would float on its recorded ground alone');
  assert.deepEqual(near.filter((b) => !(b.bottom <= b.ground)), [], 'every wall reaches the drawn ground');
  assert.deepEqual(far.filter((b) => !(b.bottom <= b.ground)), [], 'and still does from 1.5 km up');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('beyond the blocks, the ground under the camera is the smooth surface as drawn', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  const r = await page.evaluate(() => {
    const { manager: M } = window.__cw.internals;
    // the drawn height, read from the chunk's own triangles (nw, sw, se) and (nw, se, ne)
    const meshY = (c, x, z) => {
      const s = c.lod, step = s * c.level.cell, nv = c.level.samples / s + 1, P = c.mesh.geometry.attributes.position.array;
      const lx = x - c.x0, lz = z - c.z0, b = Math.floor(lx / step), a = Math.floor(lz / step), u = lx / step - b, w = lz / step - a;
      const Y = (i) => P[i * 3 + 1], nw = a * nv + b, ne = nw + 1, sw = nw + nv, se = sw + 1;
      return w >= u ? Y(nw) + w * (Y(sw) - Y(nw)) + u * (Y(se) - Y(sw)) : Y(nw) + u * (Y(ne) - Y(nw)) + w * (Y(se) - Y(ne));
    };
    const out = { h5: { n: 0, worst: 0 }, h20: { n: 0, worst: 0 } };
    for (let k = 0; k < 4000; k++) {
      const ang = k * 2.39996, rad = 1600 + (k % 97) * 95;          // spread over 1.6 to 10.8 km
      const x = rad * Math.cos(ang), z = rad * Math.sin(ang);
      if (M.chunkAt('h1', x, z) || M.isSeaSquare('h1', x, z)) continue;
      let c = M.chunkAt('h5', x, z);
      if (!c && M.isSeaSquare('h5', x, z)) continue;
      if (!c) c = M.chunkAt('h20', x, z);
      if (!c || !c.mesh) continue;
      const g = window.__cw.groundAt(x, z);
      if (!g || g.level !== c.level.name) continue;
      const d = Math.abs(g.y - Math.max(0, meshY(c, x, z)));
      const o = out[c.level.name];
      o.n++;
      o.worst = Math.max(o.worst, d);
    }
    return out;
  });
  assert.ok(r.h5.n > 100 && r.h20.n > 100, JSON.stringify(r));
  assert.ok(r.h5.worst < 1e-3, 'h5: ground differs from the drawn surface by ' + r.h5.worst);
  assert.ok(r.h20.worst < 1e-3, 'h20: ground differs from the drawn surface by ' + r.h20.worst);
});

test('flying never goes under the water, even beyond the edge of the world', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.set({ x: 40000, z: 0, y: -40, mode: 'fly' }));
  await page.evaluate(() => window.__cw.frame());
  const out = await page.evaluate(() => ({ cam: window.__cw.camera.get(), ground: window.__cw.groundAt(40000, 0) }));
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  assert.equal(out.ground, null, 'no ground is known out there');
  assert.ok(out.cam.feet >= 0.3 - 1e-9, 'held above the water: feet at ' + out.cam.feet);
});

test('no request ever left localhost', () => {
  assert.deepEqual(offenders, []);
});

test('the chunk worker imports nothing', () => {
  const src = fs.readFileSync(path.join(WORLD, 'js', 'worker.js'), 'ascii');
  assert.doesNotMatch(src, /^\s*import[\s{*'"]/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /importScripts/);
});

test('the viewer\'s own files are pure ASCII', () => {
  const files = [path.join(WORLD, 'index.html'), path.join(WORLD, 'README.md')];
  for (const dir of [path.join(WORLD, 'js'), HERE, path.join(HERE, 'fixtures')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) files.push(p);
    }
  }
  const bad = [];
  for (const f of files) {
    const b = fs.readFileSync(f);
    const i = b.findIndex((x) => x > 127);
    if (i >= 0) bad.push(path.relative(REPO, f) + ' at byte ' + i);
  }
  assert.deepEqual(bad, []);
});
