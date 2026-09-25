// Commons World viewer tests: buildings drawn from measured roofs, and trees, on the
// synthetic world (world/out/synthetic). Run with the other viewer tests:
//
//   node --test --test-concurrency=1 world/tests/viewer/*.test.mjs
//
// The shared harness (harness.mjs) serves the repo root, builds the synthetic world if it
// is missing, and refuses any request that leaves localhost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SYN, READY_MS, offenders, newContext, openWorld, mainPage } from './harness.mjs';

const manifest = () => JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));
const buildingsDoc = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SYN, manifest().files.buildings.file))).toString('utf8'));

async function shared() {
  const main = await mainPage();
  await main.page.evaluate(() => window.__cw.internals.buildings.ready);
  return main;
}

// The roof of a one-part roof_shape at (x, z), from its planes.
const PLANES_JS = `
  window.__roofOf = function (shape, x, z) {
    let y = Infinity;
    for (const [sx, sz, y0] of shape.parts[0].planes) y = Math.min(y, y0 + sx * (x - shape.at[0]) + sz * (z - shape.at[1]));
    return y;
  };
  window.__triNormal = function (P, a, b, c) {
    const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], L = Math.hypot(...n);
    return [n[0] / L, n[1] / L, n[2] / L, L / 2];
  };
`;

// ------------------------------------------------------------------------------------------
test('buildings are closed and face out', { timeout: READY_MS + 60000 }, async () => {
  const { page } = await shared();
  await page.addScriptTag({ content: PLANES_JS });
  const r = await page.evaluate(async () => {
    const THREE = await import('three');
    const { buildings: B, footprints: F } = window.__cw.internals;
    const out = [];
    for (const it of B.items) {
      const m = B.meshFor(it.id, { overhang: 0 });
      const P = m.pos, I = m.idx, res = { id: it.id, uvPairs: m.uv.length / 2 === P.length / 3 };
      let roofDown = 0, tilted = 0;
      for (let t = 0; t < I.length / 3; t++) {
        const n = window.__triNormal(P, I[3 * t], I[3 * t + 1], I[3 * t + 2]);
        const top = m.groups[t] === 1 || (m.groups[t] === 2 && Math.abs(n[1]) > 0.5);
        if (top) { if (!(n[1] > 0)) roofDown++; } else if (Math.abs(n[1]) > 1e-6) tilted++;
      }
      Object.assign(res, { roofDown, tilted });
      // the outline, from the wall bottoms in order, closed with a bottom cap
      const ring = [];
      for (let k = 0; k < m.wallBottom.length; k += 2) {
        const v = m.wallBottom[k], p = [P[3 * v], P[3 * v + 2]], l = ring[ring.length - 1];
        if (!l || Math.hypot(l[0] - p[0], l[1] - p[1]) > 1e-6) ring.push(p);
      }
      if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6) ring.pop();
      const bottom = P[3 * m.wallBottom[0] + 1];
      const pos = P.slice(), idx = I.slice(), v0 = pos.length / 3;
      for (const p of ring) pos.push(p[0], bottom, p[1]);
      for (const t of THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), [])) {
        const a = ring[t[0]], b = ring[t[1]], c = ring[t[2]];
        const ny = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        if (ny <= 0) idx.push(v0 + t[0], v0 + t[1], v0 + t[2]); else idx.push(v0 + t[0], v0 + t[2], v0 + t[1]);
      }
      // weld at 0.1 mm; every directed edge left over must be covered, point for point, by
      // collinear edges running the other way (a vertex lying on an edge is closed geometry)
      const key = (v) => pos[3 * v].toFixed(4) + ',' + pos[3 * v + 1].toFixed(4) + ',' + pos[3 * v + 2].toFixed(4);
      const weld = new Map(), id = [], first = [];
      for (let v = 0; v < pos.length / 3; v++) {
        const k = key(v);
        if (!weld.has(k)) { weld.set(k, weld.size); first.push([pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]); }
        id.push(weld.get(k));
      }
      const edges = new Map();
      let vol = 0;
      for (let t = 0; t < idx.length / 3; t++) {
        const a = id[idx[3 * t]], b = id[idx[3 * t + 1]], c = id[idx[3 * t + 2]];
        if (a === b || b === c || a === c) continue;
        for (const [u, w] of [[a, b], [b, c], [c, a]]) edges.set(u + '>' + w, (edges.get(u + '>' + w) || 0) + 1);
        const A = idx[3 * t], B2 = idx[3 * t + 1], C = idx[3 * t + 2];
        const ax = pos[3 * A], ay = pos[3 * A + 1], az = pos[3 * A + 2], bx = pos[3 * B2], by = pos[3 * B2 + 1], bz = pos[3 * B2 + 2];
        const cx = pos[3 * C], cy = pos[3 * C + 1], cz = pos[3 * C + 2];
        vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      }
      const rest = [];
      for (const [e, n] of edges) {
        const [u, w] = e.split('>');
        const back = edges.get(w + '>' + u) || 0;
        for (let k = 0; k < n - Math.min(n, back); k++) rest.push([first[Number(u)], first[Number(w)]]);
      }
      let open = 0;
      for (const [a, b] of rest) {
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(...d), u = d.map((x) => x / L);
        const cover = [];
        for (const [c, e] of rest) {
          const off = (p) => { const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]; const t = w[0] * u[0] + w[1] * u[1] + w[2] * u[2]; return [t, Math.hypot(w[0] - t * u[0], w[1] - t * u[1], w[2] - t * u[2])]; };
          const [tc, dc] = off(c), [te, de] = off(e);
          if (dc > 2e-4 || de > 2e-4 || !(tc > te)) continue;
          cover.push([te, tc]);
        }
        cover.sort((x, y) => x[0] - y[0]);
        let reach = 0;
        for (const [s0, s1] of cover) { if (s0 > reach + 2e-4) break; reach = Math.max(reach, s1); }
        if (reach < L - 2e-4) open++;
      }
      // the volume against a 0.1 m integral of the drawn roof over the outline
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      let num = 0;
      for (let x = Math.min(...xs) + 0.05; x < Math.max(...xs); x += 0.1) {
        for (let z = Math.min(...zs) + 0.05; z < Math.max(...zs); z += 0.1) {
          const y = F.roofAt(x, z);
          if (y !== null) num += (y - bottom) * 0.01;
        }
      }
      Object.assign(res, { open, vol, volErr: Math.abs(vol - num) / num });
      out.push(res);
    }
    return out;
  });
  assert.equal(r.length, 8);
  for (const b of r) {
    assert.ok(b.uvPairs, 'one uv pair per vertex: ' + JSON.stringify(b));
    assert.equal(b.open, 0, 'closed: ' + JSON.stringify(b));
    assert.ok(b.vol > 0, 'faces out: ' + JSON.stringify(b));
    assert.ok(b.volErr < 0.01, 'volume: ' + JSON.stringify(b));
    assert.equal(b.roofDown, 0, 'roofs face up: ' + JSON.stringify(b));
    assert.equal(b.tilted, 0, 'walls are vertical: ' + JSON.stringify(b));
  }
});

test('the listing house draws nothing made up', { timeout: 60000 }, async () => {
  const { page } = await shared();
  await page.addScriptTag({ content: PLANES_JS });
  const feature = buildingsDoc().features.find((f) => f.house);
  assert.equal(feature.roof_shape.model, 'gable');
  const r = await page.evaluate((f) => {
    const B = window.__cw.internals.buildings;
    const m = B.meshFor(f.id);                     // as drawn: the house's own constants
    const bottoms = new Set(m.wallBottom), P = m.pos, ring = f.ring;
    const onRing = (x, z) => ring.some((a, i) => {
      const b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      const t = ((x - a[0]) * dx + (z - a[1]) * dz) / (L * L);
      return t >= -1e-9 && t <= 1 + 1e-9 && Math.abs((x - a[0]) * dz - (z - a[1]) * dx) / L < 1e-6;
    });
    let tops = 0, offRing = 0, offRoof = 0, trim = 0;
    for (let t = 0; t < m.groups.length; t++) {
      if (m.groups[t] === 2) trim++;
      if (m.groups[t] !== 0) continue;
      for (let k = 0; k < 3; k++) {
        const v = m.idx[3 * t + k];
        if (bottoms.has(v)) continue;
        tops++;
        if (!onRing(P[3 * v], P[3 * v + 2])) offRing++;
        if (Math.abs(P[3 * v + 1] - window.__roofOf(f.roof_shape, P[3 * v], P[3 * v + 2])) > 1e-4) offRoof++;
      }
    }
    return { tops, offRing, offRoof, trim, roofMap: B.houseMesh.material[1].map, wallMap: !!B.houseMesh.material[0].map,
             outline: B.house.ring, shape: B.house.shape && B.house.shape.model };
  }, feature);
  assert.ok(r.tops > 0);
  assert.equal(r.offRing, 0, 'the walls stand on the traced ring: no drawn eave');
  assert.equal(r.offRoof, 0, 'and meet the measured roof');
  assert.equal(r.trim, 0, 'no fascia');
  assert.equal(r.roofMap, null, 'a plain roof');
  assert.ok(r.wallMap, 'the walls keep the cladding');
  assert.deepEqual(r.outline, feature.ring, 'the drawn outline is the traced ring');
  assert.equal(r.shape, 'gable');
});

test('wall tops meet the roof', { timeout: 60000 }, async () => {
  const { page } = await shared();
  await page.addScriptTag({ content: PLANES_JS });
  const features = buildingsDoc().features.filter((f) => f.roof_shape && f.roof_shape.parts && f.roof_shape.parts.length === 1);
  assert.ok(features.length >= 6);
  const r = await page.evaluate((fs) => {
    const B = window.__cw.internals.buildings;
    const out = [];
    for (const f of fs) {
      const m = B.meshFor(f.id);                   // at the live overhang
      const bottoms = new Set(m.wallBottom), P = m.pos;
      let wallOff = 0, roofOff = 0, walls = 0;
      for (let t = 0; t < m.groups.length; t++) {
        for (let k = 0; k < 3; k++) {
          const v = m.idx[3 * t + k], y = window.__roofOf(f.roof_shape, P[3 * v], P[3 * v + 2]);
          if (m.groups[t] === 0 && !bottoms.has(v)) { walls++; if (Math.abs(P[3 * v + 1] - y) > 1e-4) wallOff++; }
          if (m.groups[t] === 1 && Math.abs(P[3 * v + 1] - y) > 1e-6) roofOff++;
        }
      }
      out.push({ id: f.id, walls, wallOff, roofOff });
    }
    return out;
  }, features);
  for (const b of r) {
    assert.ok(b.walls > 0);
    assert.equal(b.wallOff, 0, JSON.stringify(b));
    assert.equal(b.roofOff, 0, JSON.stringify(b));
  }
});

test('the drawn roof is the measured roof', { timeout: 60000 }, async () => {
  const { page } = await shared();
  await page.addScriptTag({ content: PLANES_JS });
  const f = buildingsDoc().features.find((x) => x.house);
  const r = await page.evaluate((f) => {
    const B = window.__cw.internals.buildings;
    const m = B.meshFor(f.id), P = m.pos;
    let top = -Infinity, pitchOff = 0, bearingOff = 0, faces = 0;
    const bd = (a, b) => { const d = Math.abs(((a - b) % 180 + 180) % 180); return Math.min(d, 180 - d); };
    for (let t = 0; t < m.groups.length; t++) {
      if (m.groups[t] !== 1) continue;
      const n = window.__triNormal(P, m.idx[3 * t], m.idx[3 * t + 1], m.idx[3 * t + 2]);
      if (n[3] < 1e-6) continue;
      faces++;
      const pitch = Math.acos(n[1]) * 180 / Math.PI;
      // the face's level line, square to its normal, runs along the ridge; its grid
      // bearing is measured clockwise from -z
      const dx = -n[2], dz = n[0];
      const b = Math.atan2(dx, -dz) * 180 / Math.PI;
      if (Math.abs(pitch - f.roof_shape.pitch) > 0.5) pitchOff++;
      if (bd(b, f.roof_shape.ridge_bearing) > 0.5) bearingOff++;
    }
    for (let t = 0; t < m.groups.length; t++) for (let k = 0; k < 3; k++) {
      const v = m.idx[3 * t + k];
      if (m.groups[t] === 1) top = Math.max(top, P[3 * v + 1]);
    }
    return { faces, pitchOff, bearingOff, top };
  }, f);
  assert.ok(r.faces > 0);
  assert.equal(r.pitchOff, 0, 'every roof face slopes at the measured pitch');
  assert.equal(r.bearingOff, 0, 'and runs along the measured ridge');
  assert.ok(Math.abs(r.top - f.roof_shape.ridge) <= 0.01, 'the drawn ridge is the measured one: ' + r.top);
});

test('old and malformed files still draw', { timeout: READY_MS + 120000 }, async () => {
  const doc = buildingsDoc();
  const file = manifest().files.buildings.file;
  // without roof_shape: today's prisms
  const plain = JSON.parse(JSON.stringify(doc));
  for (const f of plain.features) delete f.roof_shape;
  let ctx = await newContext();
  await ctx.route('**/out/synthetic/' + file, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(plain), contentType: 'application/json' }));
  let { page, log } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  const prisms = await page.evaluate((fs) => {
    const B = window.__cw.internals.buildings, out = [];
    for (const f of fs) {
      const m = B.meshFor(f.id), P = m.pos, top = Math.max(f.roof, f.ground + 2);
      const corners = new Set(f.ring.map((p) => p[0].toFixed(3) + ',' + p[1].toFixed(3)));
      const seen = new Set();
      let stray = 0, topOff = 0;
      const bottoms = new Set(m.wallBottom);
      for (let t = 0; t < m.groups.length; t++) {
        if (m.groups[t] !== 0) continue;
        for (let k = 0; k < 3; k++) {
          const v = m.idx[3 * t + k], c = P[3 * v].toFixed(3) + ',' + P[3 * v + 2].toFixed(3);
          if (!corners.has(c)) stray++;
          seen.add(c);
          if (!bottoms.has(v) && Math.abs(P[3 * v + 1] - top) > 1e-6) topOff++;
        }
      }
      out.push({ id: f.id, stray, topOff, missing: [...corners].filter((c) => !seen.has(c)).length });
    }
    return { out, info: B.info(), errors: window.__cw.errors };
  }, plain.features);
  for (const b of prisms.out) assert.deepEqual([b.stray, b.topOff, b.missing], [0, 0, 0], JSON.stringify(b));
  assert.equal(prisms.info.fallback, 8);
  assert.equal(prisms.info.malformed, 0);
  assert.deepEqual(prisms.errors, []);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(log.console, []);
  await page.close();
  // one malformed shape: that building flat, the others as measured
  const bad = JSON.parse(JSON.stringify(doc));
  const victim = bad.features.find((f) => !f.house && f.roof_shape.model === 'gable');
  victim.roof_shape.parts[0].planes[0][0] = null;
  ctx = await newContext();
  await ctx.route('**/out/synthetic/' + file, (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(bad), contentType: 'application/json' }));
  ({ page, log } = await openWorld(ctx));
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  const r = await page.evaluate((id) => {
    const B = window.__cw.internals.buildings;
    const flatTop = (i) => { const m = B.meshFor(i); return m.groups.filter((g) => g === 1).length === 0 && m.groups.filter((g) => g === 2).length > 0; };
    return { info: B.info(), victimFlat: flatTop(id), othersFlat: B.items.filter((it) => it.id !== id && flatTop(it.id)).length,
             errors: window.__cw.errors };
  }, victim.id);
  assert.equal(r.info.malformed, 1);
  assert.ok(r.victimFlat, 'the malformed building is drawn as the flat prism');
  assert.equal(r.othersFlat, 0, 'no other building is');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(log.errors, []);
  // a version the viewer does not read
  const v2 = await page.evaluate(async () => {
    const m = await import('./js/objects.js');
    let message = null;
    const features = m.buildingFeatures({ version: 2, features: [{ id: 1 }] }, (e) => { message = e.message; });
    return { features, message, none: m.buildingFeatures(null, () => { message = 'called'; }) };
  });
  assert.deepEqual(v2.features, []);
  assert.match(v2.message, /version 2/);
  assert.deepEqual(v2.none, []);
  await page.close();
});

test('the house has no openings', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const f = buildingsDoc().features.find((x) => x.house);
  const r = await page.evaluate((f) => {
    const B = window.__cw.internals.buildings, g = B.houseMesh.geometry;
    // predicted walls: one quad per outline edge, plus one wherever a crease crosses it
    const s = f.roof_shape, [p0, p1] = s.parts[0].planes, ring = f.ring;
    const d = (x, z) => (p0[2] + p0[0] * (x - s.at[0]) + p0[1] * (z - s.at[1])) - (p1[2] + p1[0] * (x - s.at[0]) + p1[1] * (z - s.at[1]));
    let quads = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], da = d(a[0], a[1]), db = d(b[0], b[1]);
      quads += 1 + ((da > 1e-6 && db < -1e-6) || (da < -1e-6 && db > 1e-6) ? 1 : 0);
    }
    return { groups: g.groups.map((x) => x.materialIndex), materials: B.houseMesh.material.length,
             walls: g.groups.find((x) => x.materialIndex === 0).count / 3, predicted: 2 * quads };
  }, f);
  assert.deepEqual(r.groups, [0, 1, 2]);
  assert.equal(r.materials, 3);
  assert.equal(r.walls, r.predicted, 'no triangle beyond the walls the outline and ridge call for');
});

test('neighbours arrive after the house', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const r = await page.evaluate(async () => {
    const m = await import('./js/objects.js');
    const { manifest } = window.__cw;
    const doc = await m.fetchJSON('out/synthetic/' + manifest.files.buildings.file);
    const b = m.buildBuildings(m.buildingFeatures(doc));
    const now = { house: b.houseMesh.geometry.index.count, others: b.othersMesh.geometry.index.count,
                  count: b.count, items: b.items.length };
    const before = Array.from(b.houseMesh.geometry.attributes.position.array);
    await b.ready;
    const expected = b.items.filter((it) => !it.house).reduce((s, it) => s + b.meshFor(it.id).idx.length, 0);
    const after = { others: b.othersMesh.geometry.index.count, expected,
                    houseSame: JSON.stringify(before) === JSON.stringify(Array.from(b.houseMesh.geometry.attributes.position.array)) };
    b.dispose();
    return { now, after };
  });
  assert.ok(r.now.house > 0, 'the house is drawn at once');
  assert.equal(r.now.others, 0, 'the neighbours are not yet');
  assert.equal(r.now.count, 8);
  assert.equal(r.now.items, 8);
  assert.equal(r.after.others, r.after.expected, 'then every neighbour is');
  assert.ok(r.after.houseSame, 'and the house is untouched');
});

test('walking on a sloped roof', { timeout: 60000 }, async () => {
  const { page } = await shared();
  await page.addScriptTag({ content: PLANES_JS });
  const f = buildingsDoc().features.find((x) => x.house);
  // a point a third of the way from the centroid to the first ring vertex: on a roof face
  const spot = await page.evaluate((f) => {
    const h = window.__cw.house, v = f.ring[0];
    const x = h.centroid[0] + (v[0] - h.centroid[0]) / 3, z = h.centroid[1] + (v[1] - h.centroid[1]) / 3;
    const roof = window.__cw.internals.footprints.roofAt(x, z);
    return { x, z, roof, planes: window.__roofOf(f.roof_shape, x, z) };
  }, f);
  assert.ok(Math.abs(spot.roof - spot.planes) < 1e-9, 'roofAt is the measured planes');
  assert.ok(Math.abs(spot.roof - f.roof) > 0.05, 'which differ from the flat roof');
  await page.evaluate(({ x, z, roof }) => window.__cw.camera.set({ mode: 'walk', x, z, y: roof + 3 + 1.7 }), spot);
  await page.waitForFunction((y) => Math.abs(window.__cw.camera.get().feet - y) < 1e-6, spot.roof, { timeout: 20000 });
  await page.evaluate(() => window.__cw.camera.start());
});

test('every building carries its ground for the sun', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const r = await page.evaluate(() => {
    const B = window.__cw.internals.buildings, out = { meshes: [], wrong: 0, checked: 0 };
    for (const mesh of [B.othersMesh, B.houseMesh]) {
      const a = mesh.geometry.attributes.cwGround;
      out.meshes.push(!!a && a.itemSize === 1 && a.count === mesh.geometry.attributes.position.count);
    }
    for (const it of B.items) {
      const a = (it.house ? B.houseMesh : B.othersMesh).geometry.attributes.cwGround;
      for (const v of it.verts) { out.checked++; if (Math.abs(a.getX(v) - it.ground) > 1e-4) out.wrong++; }
    }
    return out;
  });
  assert.deepEqual(r.meshes, [true, true]);
  assert.ok(r.checked > 0);
  assert.equal(r.wrong, 0);
});

test('near set conserves trees', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const r = await page.evaluate(async () => {
    const { trees: T, camera } = window.__cw.internals;
    const k = T.groups[0].meshes[0].userData.ids[0];
    const tree = { x: T.tx[k], y: T.ty[k], z: T.tz[k] };
    const scaleOf = (mesh, i) => { const e = mesh.instanceMatrix.array; return Math.abs(e[i * 16]) + Math.abs(e[i * 16 + 5]) + Math.abs(e[i * 16 + 10]); };
    const visibleCount = () => {
      let n = 0;
      for (const g of T.groups) for (const mesh of g.meshes) for (let i = 0; i < mesh.count; i++) if (scaleOf(mesh, i) > 0) n++;
      for (const mesh of T.nearMeshes) n += mesh.count;
      return n;
    };
    const chunkMesh = T.groups.flatMap((g) => g.meshes).find((m) => Array.from(m.userData.ids).includes(k));
    const slot = Array.from(chunkMesh.userData.ids).indexOf(k);
    T.update({ x: tree.x + 3, y: tree.y + 1.7, z: tree.z + 2 });
    const near = { inSet: T.nearSet().ids.includes(k), scale: scaleOf(chunkMesh, slot), visible: visibleCount() };
    T.update({ x: tree.x + 3000, y: tree.y + 500, z: tree.z });
    const away = { inSet: T.nearSet().ids.includes(k), scale: scaleOf(chunkMesh, slot), visible: visibleCount(), count: T.nearSet().count };
    T.update(camera.position);
    return { near, away, total: window.__cw.stats().trees };
  });
  assert.ok(r.near.inSet, 'the tree is in the near set');
  assert.equal(r.near.scale, 0, 'and hidden in its chunk mesh');
  assert.equal(r.near.visible, r.total, 'every tree is drawn exactly once');
  assert.ok(!r.away.inSet && r.away.scale > 0, 'moving away restores it');
  assert.equal(r.away.visible, r.total);
});

test('tree shapes are tied to the measured crown', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const radii = await page.evaluate(async () => (await import('./js/treegeo.js')).treeGeometryRadii());
  assert.equal(radii.length, 6);
  for (const r of radii) assert.ok(Math.abs(r.radiusAtHalf - 1) <= 0.02, JSON.stringify(r));
  const tris = Object.fromEntries(radii.map((r) => [r.look + ':' + r.lod, r.triangles]));
  assert.deepEqual(tris, { 'conifer:near': 108, 'conifer:mid': 26, 'conifer:far': 5, 'broad:near': 174, 'broad:mid': 32, 'broad:far': 8 });
});

test('the tree look rule is deterministic', { timeout: 60000 }, async () => {
  const { page } = await shared();
  // recomputed here from trees.bin, independently of the viewer
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(SYN, manifest().files.trees.file)));
  const hash2 = (x, z) => {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul((z | 0) + 0x9e3779b9, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const count = raw.readUInt32LE(8), want = { conifer: 0, broad: 0 };
  for (let k = 0, o = 12; k < count; k++, o += 8) {
    // crown / height in the file's own units (0.1 m, 0.25 m): < 0.15 is 8 c < 3 h, > 0.30 is 4 c > 3 h
    const x = raw.readInt16LE(o), z = raw.readInt16LE(o + 2), hq = raw[o + 6], cq = raw[o + 7];
    const tall = Math.max(0, Math.min(1, (hq * 0.25 - 12) / 10));
    const conifer = 8 * cq < 3 * hq ? true : 4 * cq > 3 * hq ? false : hash2(x, z) < 0.55 + 0.3 * tall;
    want[conifer ? 'conifer' : 'broad']++;
  }
  const got = await page.evaluate(() => window.__cw.internals.trees.lookCounts());
  assert.deepEqual(got, want);
  assert.equal(got.conifer + got.broad, count);
});

test('trees do not flicker at the LOD boundary', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const r = await page.evaluate(() => {
    const { trees: T, camera } = window.__cw.internals;
    const g = T.groups[0], edge = T.profile.treesNear;
    const at = (d) => ({ x: g.x0 + g.side + d, y: 200, z: g.z0 + g.side / 2 });
    const geo = () => g.meshes.map((m) => m.geometry.uuid).join(',');
    T.update(at(edge - 15));                   // clearly inside: the mid level
    T.update(at(edge - 5));
    const start = geo();
    const seen = [];
    for (let i = 0; i < 4; i++) { T.update(at(edge + 5)); seen.push(geo()); T.update(at(edge - 5)); seen.push(geo()); }
    T.update(at(edge + 15));
    const beyond = geo();
    T.update(camera.position);
    return { start, seen, beyond };
  });
  assert.ok(r.seen.every((u) => u === r.start), 'moving 10 m back and forth across the edge swaps nothing');
  assert.notEqual(r.beyond, r.start, 'well past the edge the far level is drawn');
});

test('tree budget', { timeout: READY_MS + 60000 }, async () => {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const { page } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  assert.equal(await page.evaluate(() => window.__cw.stats().profile), 'phone');
  await page.evaluate(() => window.__cw.camera.start());
  await page.evaluate(() => window.__cw.settle());
  const v = await page.evaluate(() => window.__cw.visible());
  assert.ok(v.trees <= 3000, 'trees: ' + v.trees);
  assert.ok(v.buildings <= 1500, 'buildings: ' + v.buildings);
  await page.close();
});

test('shadow focus limits casters', { timeout: READY_MS + 60000 }, async () => {
  const ctx = await newContext();
  const { page, log } = await openWorld(ctx);
  await page.evaluate(() => window.__cw.internals.buildings.ready);
  const r = await page.evaluate(async () => {
    const THREE = await import('three');
    const { renderer, scene, buildings: B, trees: T } = window.__cw.internals;
    const h = window.__cw.house;
    const was = { enabled: renderer.shadowMap.enabled, auto: renderer.shadowMap.autoUpdate };
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = true;
    light.position.set(h.centroid[0] + 60, h.ground + 80, h.centroid[1] + 40);
    light.target.position.set(h.centroid[0], h.ground, h.centroid[1]);
    Object.assign(light.shadow.camera, { left: -300, right: 300, top: 300, bottom: -300, near: 1, far: 1000 });
    light.shadow.camera.updateProjectionMatrix();
    scene.add(light, light.target);
    const rect = { x0: h.centroid[0] - 30, z0: h.centroid[1] - 30, x1: h.centroid[0] + 30, z1: h.centroid[1] + 30 };
    B.setShadowFocus(rect);
    const drawn = { house: 0, others: 0 };
    for (const [name, mesh] of [['house', B.houseMesh], ['others', B.othersMesh]]) {
      const orig = mesh.onBeforeShadow;
      mesh.onBeforeShadow = function (r, o, cam, sc, geometry, depth, group) {
        orig.call(this, r, o, cam, sc, geometry, depth, group);
        const end = Math.min(geometry.drawRange.start + geometry.drawRange.count, group.start + group.count);
        drawn[name] += Math.max(0, end - Math.max(geometry.drawRange.start, group.start)) / 3;
      };
      mesh.userData.spy = orig;
    }
    renderer.shadowMap.needsUpdate = true;
    await window.__cw.frame();
    const focus = B.shadowFocus();
    const meets = (b) => b[0] <= rect.x1 && b[2] >= rect.x0 && b[1] <= rect.z1 && b[3] >= rect.z0;
    const expected = B.items.filter((it) => meets(it.box)).reduce((s, it) => s + B.meshFor(it.id).idx.length / 3, 0);
    const within = ['house', 'others'].every((k) => focus[k].inFocus.every((n, g) => n <= focus[k].counts[g]));
    const inFocusTotal = ['house', 'others'].reduce((s, k) => s + focus[k].inFocus.reduce((a, b) => a + b, 0) / 3, 0);
    const treeChanged = T.setShadowFocus(rect);
    const trees = T.groups.map((g) => ({ meets: g.x0 <= rect.x1 && g.x0 + g.side >= rect.x0 && g.z0 <= rect.z1 && g.z0 + g.side >= rect.z0,
                                        cast: g.meshes.every((m) => m.castShadow) }));
    for (const mesh of [B.houseMesh, B.othersMesh]) mesh.onBeforeShadow = mesh.userData.spy;
    B.setShadowFocus(null);
    T.setShadowFocus(null);
    scene.remove(light, light.target);
    light.dispose();
    renderer.shadowMap.enabled = was.enabled;
    renderer.shadowMap.autoUpdate = was.auto;
    await window.__cw.frame();
    return { drawn, expected, within, inFocusTotal, treeChanged, trees, all: B.items.length, allTris: B.items.reduce((s, it) => s + B.meshFor(it.id).idx.length / 3, 0) };
  });
  assert.ok(r.within, 'the in-focus count of each group is at most its size');
  assert.equal(r.drawn.house + r.drawn.others, r.inFocusTotal, 'the shadow pass drew the buildings in focus');
  assert.equal(r.inFocusTotal, r.expected, 'which are the buildings meeting the rect');
  assert.ok(r.expected > 0 && r.expected < r.allTris, 'some, not all: ' + JSON.stringify([r.expected, r.allTris]));
  assert.ok(r.trees.every((t) => t.meets === t.cast), 'only tree chunks meeting the rect cast');
  assert.deepEqual(log.errors, []);
  await page.close();
});

test('materials never mix sun-shade kinds', { timeout: 60000 }, async () => {
  const { page } = await shared();
  const r = await page.evaluate(() => {
    const kinds = new Map(), clash = [];
    window.__cw.internals.scene.traverse((o) => {
      if (!o.isMesh) return;
      const kind = o.userData.cwHag || (o.isInstancedMesh ? 'instance' : o.geometry && o.geometry.attributes.cwGround ? 'attribute' : 'zero');
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (kinds.has(m.uuid) && kinds.get(m.uuid) !== kind) clash.push(o.name + ': ' + kinds.get(m.uuid) + ' and ' + kind);
        kinds.set(m.uuid, kind);
      }
    });
    return { clash, n: kinds.size };
  });
  assert.ok(r.n > 3);
  assert.deepEqual(r.clash, []);
});

test('no request ever left localhost', () => {
  assert.deepEqual(offenders, []);
});
