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

import { test, beforeEach } from 'node:test';
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

// The retired block-winding test (TT1 in terrain.test.mjs replaces it) used to put the mesh
// helpers on the shared page; the smooth-grid test below still reads them. (A before() hook
// would run ahead of the harness's, before there is a browser.)
beforeEach(async (t) => {
  if (!t.name.startsWith('smooth grid faces up')) return;
  const { page } = await mainPage();
  await page.addScriptTag({ content: MESH_HELPERS });
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

test('h1 chunk seams are covered at every mix of tolerances', { timeout: 240000 }, async () => {
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
  const results = await page.evaluate(async ({ pairs }) => {
    const M = window.__cw.internals.manager, px = M.px(), out = [];
    // The seam line's drawn surface (surface edges on it) and the skirts that face the other
    // chunk, per mesh; at each metre along the seam the higher side's skirts must reach from
    // its surface down to the lower side's (or to the water at 0).
    const profile = (R, U, Wd, seam, facing) => {
      const P = R.mesh.pos, I = R.mesh.idx, segs = [], skirts = [];
      const V = (k) => [P[k * 3] + R.x0, P[k * 3 + 1], P[k * 3 + 2] + R.z0];
      for (let t = 0; t < I.length; t += 3) {
        const a = V(I[t]), b = V(I[t + 1]), c = V(I[t + 2]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const onSeam = [a, b, c].filter((p) => Math.abs(p[U] - seam) < 1e-4);
        if (Math.abs(g[1]) > 1e-9) { if (onSeam.length === 2) segs.push(onSeam); }
        else if (onSeam.length === 3 && Math.sign(g[U]) === facing) skirts.push([a, b, c]);
      }
      const top = (wv) => {
        for (const [p, q] of segs) {
          const lo = Math.min(p[Wd], q[Wd]), hi = Math.max(p[Wd], q[Wd]);
          if (wv >= lo && wv <= hi) return p[1] + (q[1] - p[1]) * (wv - p[Wd]) / (q[Wd] - p[Wd]);
        }
        return null;
      };
      const spans = (wv) => {
        const res = [];
        for (const tri of skirts) {
          const ys = [];
          for (let e = 0; e < 3; e++) {
            const p = tri[e], q = tri[(e + 1) % 3];
            if (p[Wd] === q[Wd]) { if (Math.abs(p[Wd] - wv) < 1e-9) ys.push(p[1], q[1]); continue; }
            const f = (wv - p[Wd]) / (q[Wd] - p[Wd]);
            if (f >= -1e-9 && f <= 1 + 1e-9) ys.push(p[1] + (q[1] - p[1]) * f);
          }
          if (ys.length) res.push([Math.min(...ys), Math.max(...ys)]);
        }
        return res;
      };
      return { top, spans };
    };
    for (const [ka, kb, axis] of pairs) {
      const ca = M.byKey['h1:' + ka];
      const U = axis === 'x' ? 0 : 2, Wd = axis === 'x' ? 2 : 0;
      const seam = axis === 'x' ? ca.x0 + 240 : ca.z0 + 240, w0 = axis === 'x' ? ca.z0 : ca.x0;
      const mid = axis === 'x' ? [seam, ca.z0 + 120] : [ca.x0 + 120, seam];
      const gy = M.surfaceAt(mid[0], mid[1]);
      // on the seam at eye height; 400 m across it and 60 m up; 1.5 km along it and 300 m up
      const cams = [[mid[0], gy + 1.7, mid[1]],
                    axis === 'x' ? [mid[0] + 400, gy + 60, mid[1]] : [mid[0], gy + 60, mid[1] + 400],
                    axis === 'x' ? [mid[0], gy + 300, mid[1] - 1500] : [mid[0] - 1500, gy + 300, mid[1]]];
      for (let ia = 0; ia < 3; ia++) for (let ib = 0; ib < 3; ib++) {
        const A = await M.meshChunk('h1', ka, { cam: cams[ia], px }), B = await M.meshChunk('h1', kb, { cam: cams[ib], px });
        const pa = profile(A, U, Wd, seam, 1), pb = profile(B, U, Wd, seam, -1);
        let checked = 0;
        const gaps = [];
        for (let k = 0; k < 240; k++) {
          const wv = w0 + k + 0.5;
          const ya = pa.top(wv), yb = pb.top(wv);
          if (ya === null && yb === null) continue;
          checked++;
          const a = ya === null ? 0 : ya, b = yb === null ? 0 : yb;   // no surface: the water at 0
          const hi = Math.max(a, b), lo = Math.max(0, Math.min(a, b));
          if (hi <= lo + 1e-6) continue;
          let reach = hi;
          const ivs = (a > b ? pa : pb).spans(wv);
          for (let moved = true; moved;) {
            moved = false;
            for (const [y0, y1] of ivs) if (y1 >= reach - 1e-5 && y0 < reach - 1e-9) { reach = y0; moved = true; }
          }
          if (reach > lo + 1e-5) gaps.push({ w: wv, a, b, reach });
        }
        out.push({ ka, kb, axis, cams: [ia, ib], checked, gaps: gaps.length, first: gaps.slice(0, 3) });
      }
    }
    return out;
  }, { pairs });
  const failing = results.filter((r) => r.gaps > 0);
  assert.deepEqual(failing, [], 'no seam leaves a gap');
  assert.ok(results.every((r) => r.checked >= 200), 'each seam was sampled along its length');
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

test('the plot is marked on the ground: area within 1% and a boundary line', { timeout: 180000 }, async (t) => {
  const { page, plot } = await mainPage();
  const area = plot.parcels.reduce((s, p) => s + p.area_polygon_m2, 0);
  const mark = await page.evaluate(() => window.__cw.internals.manager.plotMark());
  assert.ok(Math.abs(mark.area - area) / area < 0.01, 'marked ' + mark.area + ' m2 against ' + area + ' m2');
  assert.ok(mark.lineArea > 0 && mark.lineArea < 0.15 * mark.area, 'a boundary line: ' + JSON.stringify(mark));
  // top-down over the parcel's centroid, with buildings, trees and the fence out of the way
  const xs = plot.parcels.flatMap((p) => p.ring.map((q) => q[0])), zs = plot.parcels.flatMap((p) => p.ring.map((q) => q[1]));
  let cx = 0, cz = 0, a2 = 0;
  for (const p of plot.parcels) {
    const r = p.ring;
    for (let k = 0, m = r.length - 1; k < r.length; m = k++) {
      const f = r[m][0] * r[k][1] - r[k][0] * r[m][1];
      a2 += f; cx += (r[m][0] + r[k][0]) * f; cz += (r[m][1] + r[k][1]) * f;
    }
  }
  cx /= 3 * a2; cz /= 3 * a2;
  const out = [Math.max(...xs) + 30, cz];
  // a point on the boundary: the middle of the parcels' longest edge
  let edge = null;
  for (const p of plot.parcels) {
    const q = p.ring;
    for (let k = 0, m = q.length - 1; k < q.length; m = k++) {
      const len = Math.hypot(q[k][0] - q[m][0], q[k][1] - q[m][1]);
      if (!edge || len > edge.len) edge = { len, x: (q[k][0] + q[m][0]) / 2, z: (q[k][1] + q[m][1]) / 2 };
    }
  }
  // Each point is read with the plot mark drawn and again with it switched off (its box
  // emptied), so the difference is the mark itself and not the land cover under it.
  const r = await page.evaluate(async ({ cx, cz, out, edge }) => {
    const I = window.__cw.internals, cw = window.__cw, { SHARED } = await import('/world/js/terrainmat.js');
    const hide = [I.buildings && I.buildings.group, I.trees && I.trees.group, I.fence && I.fence.mesh].filter(Boolean);
    const was = hide.map((o) => o.visible);
    const g = I.manager.surfaceAt(cx, cz);
    cw.camera.set({ mode: 'fly', x: cx, z: cz, y: g + 160, yaw: 0, pitch: -Math.PI / 2 + 0.001 });
    if (!String(cw.settle).includes('forceSnapshots')) I.manager.forceSnapshots(I.camera.position);   // SPEC 3.9
    await cw.settle();
    if (cw.sunIdle) await cw.sunIdle();
    hide.forEach((o) => { o.visible = false; });
    await cw.frame();
    const gl = I.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    // the warmest (largest R - B) pixel within n pixels of the point
    const at = (x, z, n) => {
      const v = I.camera.position.clone().set(x, I.manager.surfaceAt(x, z), z).project(I.camera);
      const px = Math.round((v.x + 1) / 2 * (w - 1)), py = Math.round((v.y + 1) / 2 * (h - 1)), s = 2 * n + 1;
      const b = new Uint8Array(s * s * 4);
      gl.readPixels(px - n, py - n, s, s, gl.RGBA, gl.UNSIGNED_BYTE, b);
      let best = null;
      for (let k = 0; k < s * s; k++) if (!best || b[k * 4] - b[k * 4 + 2] > best[0] - best[2]) best = [b[k * 4], b[k * 4 + 1], b[k * 4 + 2]];
      return best;
    };
    const read = () => {
      I.renderer.render(I.scene, I.camera);
      return { inside: at(cx, cz, 0), outside: at(out[0], out[1], 0), line: at(edge.x, edge.z, 1) };
    };
    const box = SHARED.cwTPlotBox.value.clone();
    const withMark = read();
    SHARED.cwTPlotBox.value.set(1, 1, 0, 0);
    let without;
    try { without = read(); } finally { SHARED.cwTPlotBox.value.copy(box); }
    hide.forEach((o, k) => { o.visible = was[k]; });
    cw.camera.start();
    await cw.settle();
    return { withMark, without };
  }, { cx, cz, out, edge });
  // Warmth (R - B) is compared as a share of the brightness under it, so the checks hold
  // whatever the light: a brighter or dimmer sun scales both alike. The line mixes 80 %
  // toward a strong red and the wash 35 % toward a pale tan, so at the boundary the mark
  // must warm the ground well beyond what the wash alone does inside.
  const warm = (p) => p[0] - p[2], bright = (p) => (p[0] + p[1] + p[2]) / 3, at = JSON.stringify(r);
  const gain = (k) => (warm(r.withMark[k]) - warm(r.without[k])) / bright(r.without[k]);
  const wash = gain('inside'), line = gain('line'), shares = ' (shares: wash ' + wash.toFixed(3) + ', line ' + line.toFixed(3) + ') ';
  t.diagnostic('warmth gained, as a share of the brightness:' + shares);
  assert.ok(warm(r.withMark.inside) > warm(r.withMark.outside), 'the parcel is warmer than the ground 30 m outside: ' + at);
  assert.ok(wash > 0.05, 'the wash warms the parcel' + shares + at);
  assert.deepEqual(r.withMark.outside, r.without.outside, 'and nothing 30 m outside it: ' + at);
  assert.ok(line > 0.15 && line > 1.5 * wash, 'the boundary line is drawn' + shares + at);
  assert.ok((warm(r.withMark.line) - warm(r.withMark.inside)) / bright(r.withMark.inside) > 0.2, 'stronger than the wash: ' + at);
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

test('walking: gravity lands on the drawn ground, W moves forward, and downhill stays grounded', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  const start = await page.evaluate(() => window.__cw.camera.get());
  const g = await page.evaluate(({ x, z }) => window.__cw.groundAt(x, z), start);
  assert.equal(g.level, 'h1');
  assert.equal(start.feet, g.y, 'standing on the drawn ground');
  await page.evaluate(({ x, y, z }) => window.__cw.camera.set({ x, y: y + 6, z, mode: 'walk' }), start);
  await page.waitForFunction(({ x, z }) => Math.abs(window.__cw.camera.get().feet - window.__cw.groundAt(x, z).y) < 1e-6, start, { timeout: 20000 });
  await page.focus('#view');
  await page.keyboard.down('KeyW');
  await page.waitForFunction((s) => { const c = window.__cw.camera.get(); return Math.hypot(c.x - s.x, c.z - s.z) > 0.5; }, start, { timeout: 20000 });
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyF');
  assert.equal(await page.evaluate(() => window.__cw.camera.get().mode), 'fly');
  assert.equal(await page.getAttribute('#btn-mode', 'aria-pressed'), 'true');
  await page.keyboard.press('KeyF');
  assert.equal(await page.evaluate(() => window.__cw.camera.get().mode), 'walk');
  // Downhill: a stretch of drawn ground in h1 that falls steadily (8 to 30 degrees) for 6 m,
  // clear of buildings and above the water. Hold W for 1 s down it.
  const spot = await page.evaluate(() => {
    const cw = window.__cw, h = cw.house;
    for (let d = 20; d <= 700; d += 10) for (let a = 0; a < 360; a += 15) {
      const r = a * Math.PI / 180, x = h.centroid[0] + Math.sin(r) * d, z = h.centroid[1] - Math.cos(r) * d;
      for (let yaw = 0; yaw < 360; yaw += 45) {
        const y = yaw * Math.PI / 180, dx = -Math.sin(y), dz = -Math.cos(y);
        let ok = true, prev = null, drop = 0;
        for (let s = 0; s <= 6 && ok; s += 0.5) {
          const q = cw.groundAt(x + dx * s, z + dz * s);
          if (!q || q.level !== 'h1' || q.sea || q.y < 1) { ok = false; break; }
          if (prev !== null) { const f = prev - q.y; if (f < 0.5 * Math.tan(8 * Math.PI / 180) || f > 0.5 * Math.tan(30 * Math.PI / 180)) ok = false; drop += f; }
          prev = q.y;
        }
        if (ok) return { x, z, yaw: y, drop };
      }
    }
    return null;
  });
  assert.ok(spot, 'the synthetic world has a steady downhill stretch');
  await page.evaluate(({ x, z, yaw }) => window.__cw.camera.set({ mode: 'walk', x, z, y: window.__cw.groundAt(x, z).y + 1.7, yaw, pitch: -0.2 }), spot);
  await page.waitForFunction(({ x, z }) => Math.abs(window.__cw.camera.get().feet - window.__cw.groundAt(x, z).y) < 1e-6 &&
                             window.__cw.internals.controls.onGround, spot, { timeout: 20000 });
  await page.evaluate(() => {
    const c = window.__cw.internals.controls, rec = window.__cwOnGround = { on: 0, n: 0, run: true };
    const tick = () => { if (!rec.run) return; rec.n++; if (c.onGround) rec.on++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.focus('#view');
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1000);
  // a software renderer can draw only a few frames a second: keep going until 2 m are walked
  await page.waitForFunction((s) => { const c = window.__cw.camera.get(); return Math.hypot(c.x - s.x, c.z - s.z) > 2; }, spot, { timeout: 30000 });
  await page.keyboard.up('KeyW');
  const rec = await page.evaluate(() => { const r = window.__cwOnGround; r.run = false; return { on: r.on, n: r.n, cam: window.__cw.camera.get() }; });
  assert.ok(rec.n >= 3 && rec.on / rec.n >= 0.9, 'on the ground in ' + rec.on + ' of ' + rec.n + ' frames');
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
      // either side of every wall. `bottom` is the HIGHEST wall bottom: all round means
      // every wall, not just the lowest
      let bottom = -Infinity, ground = Infinity;
      for (let k = 0; k + 1 < it.verts.length; k += 2) {
        const a = it.verts[k], b = it.verts[k + 1];
        const ax = P[a * 3], az = P[a * 3 + 2], bx = P[b * 3], bz = P[b * 3 + 2];
        bottom = Math.max(bottom, P[a * 3 + 1], P[b * 3 + 1]);
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
  // reground() says how much it moved, which is what redraws shadows: the raised building,
  // offered ground 1 m lower, is lowered (walls and their boards), and a repeat moves
  // nothing; a chunk's trees stood 0.5 m higher and back are counted both ways
  const rg = await page.evaluate((id) => {
    const { buildings: B, trees: T, manager } = window.__cw.internals;
    const it = B.items.find((x) => x.id === id), was = it.bottom, box = it.box;
    const low = () => was - 1 + 0.25, touches = (b) => b === box;
    const lowered = B.reground(low, touches), again = B.reground(low, touches);
    const geo = B.othersMesh.geometry, P = geo.attributes.position.array, U = geo.attributes.uv.array;
    const walls = it.verts.every((v) => P[v * 3 + 1] === Math.fround(was - 1) && Math.abs(U[v * 2 + 1] - (was - 1) / 1.6) < 1e-4);
    const c = window.__cw.house.centroid;
    const dist = (h) => Math.hypot(Math.max(h.x0 - c[0], 0, c[0] - h.x0 - h.side), Math.max(h.z0 - c[1], 0, c[1] - h.z0 - h.side));
    const g = T.groups.reduce((a, h) => (dist(h) < dist(a) ? h : a));   // the trees nearest the house
    const up = T.reground(g.key, (x, z) => { const y = manager.surfaceAt(x, z); return y === null ? null : y + 0.5; });
    const down = T.reground(g.key, (x, z) => manager.surfaceAt(x, z));
    const still = T.reground(g.key, (x, z) => manager.surfaceAt(x, z));
    return { lowered, again, walls, up, down, still };
  }, raised.id);
  assert.deepEqual([rg.lowered, rg.again], [1, 0], 'buildings.reground: ' + JSON.stringify(rg));
  assert.ok(rg.walls, 'the walls went down, boards and all');
  assert.ok(rg.up > 0 && rg.down === rg.up && rg.still === 0, 'trees.reground: ' + JSON.stringify(rg));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
});

test('the ground under the camera is the surface as drawn, h1 included', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  const check = () => page.evaluate(() => {
    const { manager: M } = window.__cw.internals;
    // h5 and h20: the drawn height, read from the chunk's own triangles (nw, sw, se) and (nw, se, ne)
    const meshY = (c, x, z) => {
      const s = c.lod, step = s * c.level.cell, nv = c.level.samples / s + 1, P = c.mesh.geometry.attributes.position.array;
      const lx = x - c.x0, lz = z - c.z0, b = Math.floor(lx / step), a = Math.floor(lz / step), u = lx / step - b, w = lz / step - a;
      const Y = (i) => P[i * 3 + 1], nw = a * nv + b, ne = nw + 1, sw = nw + nv, se = sw + 1;
      return w >= u ? Y(nw) + w * (Y(sw) - Y(nw)) + u * (Y(se) - Y(sw)) : Y(nw) + u * (Y(ne) - Y(nw)) + w * (Y(se) - Y(ne));
    };
    const out = { h5: { n: 0, worst: 0 }, h20: { n: 0, worst: 0 }, h1: { n: 0, water: 0, worst: 0, missing: 0 } };
    for (let k = 0; k < 4000; k++) {
      const ang = k * 2.39996, rad = 1600 + (k % 97) * 95;          // spread over 1.6 to 10.8 km
      const x = rad * Math.cos(ang), z = rad * Math.sin(ang);
      if (M.chunkAt('h1', x, z) || M.isSeaSquare('h1', x, z)) continue;
      let c = M.chunkAt('h5', x, z);
      if (!c && M.isSeaSquare('h5', x, z)) continue;
      if (!c) c = M.chunkAt('h20', x, z);
      if (!c || !c.mesh) continue;
      const g = M.groundAt(x, z);
      if (!g || g.level !== c.level.name) continue;
      const d = Math.abs(g.y - Math.max(0, meshY(c, x, z)));
      const o = out[c.level.name];
      o.n++;
      o.worst = Math.max(o.worst, d);
    }
    // h1: 4,000 points in land chunks; brute force the non-vertical triangle of the installed
    // geometry that holds each one (float32 positions, barycentric)
    const h1 = M.chunks.filter((c) => c.level.name === 'h1' && c.mesh && c.data);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let k = 0; k < 4000; k++) {
      const c = h1[k % h1.length], lx = rnd() * 240, lz = rnd() * 240;
      const g = M.groundAt(c.x0 + lx, c.z0 + lz);
      if (!g || g.level !== 'h1') { out.h1.missing++; continue; }
      const P = c.mesh.geometry.attributes.position.array, I = c.mesh.geometry.index.array;
      let s = null;
      for (let t = 0; t < I.length && s === null; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, e = I[t + 2] * 3;
        const ax = P[a], az = P[a + 2], bx = P[b], bz = P[b + 2], ex = P[e], ez = P[e + 2];
        const d = (bz - ez) * (ax - ex) + (ex - bx) * (az - ez);
        if (Math.abs(d) < 1e-9) continue;                               // vertical: a skirt
        const wa = ((bz - ez) * (lx - ex) + (ex - bx) * (lz - ez)) / d, wb = ((ez - az) * (lx - ex) + (ax - ex) * (lz - ez)) / d;
        if (wa < -1e-9 || wb < -1e-9 || wa + wb > 1 + 1e-9) continue;
        s = wa * P[a + 1] + wb * P[b + 1] + (1 - wa - wb) * P[e + 1];
      }
      out.h1.n++;
      if (s === null) { out.h1.water++; if (!(g.sea && g.y === 0)) out.h1.worst = Infinity; continue; }  // a dropped sea triangle
      out.h1.worst = Math.max(out.h1.worst, Math.abs(g.y - Math.max(0, s)));
    }
    return out;
  });
  const settleHere = () => page.evaluate(async () => {
    // SPEC 3.9: every h1 chunk re-meshed for this camera, by settle() itself once it does so
    if (!String(window.__cw.settle).includes('forceSnapshots')) window.__cw.internals.manager.forceSnapshots(window.__cw.internals.camera.position);
    await window.__cw.settle();
  });
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere();
  const near = await check();
  const cam = await page.evaluate(() => window.__cw.camera.get());
  await page.evaluate(({ x, z }) => window.__cw.camera.set({ x, z, y: 1500, mode: 'fly' }), cam);
  await settleHere();
  const far = await check();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere();
  for (const [name, r] of [['start', near], ['1.5 km up', far]]) {
    assert.ok(r.h5.n > 100 && r.h20.n > 100 && r.h1.n >= 3900, name + ': ' + JSON.stringify(r));
    assert.ok(r.h5.worst < 1e-3, name + ', h5: ground differs from the drawn surface by ' + r.h5.worst);
    assert.ok(r.h20.worst < 1e-3, name + ', h20: ground differs from the drawn surface by ' + r.h20.worst);
    assert.ok(r.h1.worst < 1e-3, name + ', h1: ground differs from the drawn surface by ' + r.h1.worst);
  }
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
