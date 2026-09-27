// Commons World viewer tests: the h1 ground (an adaptive TIN per chunk, its textured
// material, and walking on it). Headless Chromium against the synthetic world only.
//
//   node --test --test-concurrency=1 world/tests/viewer/terrain.test.mjs
//
// The shared harness (harness.mjs) starts the server and the browser, and refuses any
// request that leaves localhost. settle() brings every h1 chunk's mesh to the current camera
// (forceSnapshots, SPEC 3.9), so a test's meshes do not depend on the path earlier tests
// took; every test on a shared page restores what it changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SYN, READY_MS, offenders, newContext, openWorld, mainPage, reencodeChunk, watch, origin } from './harness.mjs';

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
// Console warnings that mean GL refused what it was asked (as sun.test.mjs): SPEC 6.3 names
// PCFSoftShadowMap and GL_INVALID, and Chromium words a refused call "WebGL: INVALID_...".
const GL_WARNING = /PCFSoftShadowMap|INVALID|WebGL:/i;
const glWarnings = (log) => log.warnings.filter((w) => GL_WARNING.test(w));
// TT14's tolerance is the TIN's own promise, not a figure measured on one world. A point at
// distance r from the camera is drawn within tau = max(tmin, px K r) of the 1 m surface, and a
// height error tau at horizontal distance d moves its angle from the eye by at most tau / d. So
// a point at least tmin / (px K) away is off by at most px K (px CSS pixels: 0.096 deg on the
// laptop page, 0.27 deg in the phone context), and a nearer one by at most tmin / d. A ray's
// highest point may move to another sample, so each ray is bounded by the worse of the two
// maxima, the drawn one and the reference one, both marched from one eye. When that eye is dy
// metres from the camera the meshes were made for, px K grows by at most a factor 1 + dy / d.
function horizonBound(r, k) {
  const e = (d) => (d > 0 ? Math.max(r.px * r.K * (1 + Math.abs(r.dy) / d), r.tmin / d) : Infinity) * 180 / Math.PI;
  return Math.max(e(r.distDrawn[k]), e(r.distRef[k]));
}
// The drawn and the reference horizon at (x, z), marched out to maxM from one eye: the camera
// the h1 meshes there were made for, or (eye given) that many metres above the drawn ground, as
// the facts' horizon is measured; with the tolerance settings of those meshes.
function horizonsAt(page, x, z, maxM, eye = null) {
  return page.evaluate(({ x, z, maxM, eye }) => {
    const M = window.__cw.internals.manager, t = M.chunkAt('h1', x, z).tolInfo;
    const eyeY = eye === null ? t.cam[1] : M.surfaceAt(x, z) + eye;
    const distDrawn = new Float64Array(720), distRef = new Float64Array(720);
    const drawn = M.drawnHorizon(x, z, { surface: 'drawn', eyeY, maxM, dist: distDrawn });
    const ref = M.drawnHorizon(x, z, { surface: 'reference', eyeY, maxM, dist: distRef });
    return { drawn: Array.from(drawn), ref: Array.from(ref), distDrawn: Array.from(distDrawn), distRef: Array.from(distRef),
             cam: t.cam, dy: t.cam[1] - eyeY, px: t.px, K: t.K, tmin: t.tmin, live: { px: M.px(), K: M.K, tmin: M.tin.tmin } };
  }, { x, z, maxM, eye });
}
// The distance from (x, z) to the world's farthest corner, from the manifest's squares (land
// chunks and sea squares of every level).
function farCorner(manifest, x, z) {
  const { origin_e: oe, origin_n: on } = manifest.crs;
  let far = 0;
  for (const lv of manifest.levels) {
    const side = lv.cell * lv.chunk_samples;
    for (const key of Object.keys(lv.chunks).concat(lv.sea || [])) {
      const [i, j] = key.split('_').map(Number);
      const x0 = i * side - oe, z0 = -((j + 1) * side - on);
      for (const [cx, cz] of [[x0, z0], [x0 + side, z0], [x0, z0 + side], [x0 + side, z0 + side]]) far = Math.max(far, Math.hypot(cx - x, cz - z));
    }
  }
  return far;
}

// One phone-context page on the synthetic world, shared by the phone halves of the tests.
let phone = null;
async function phonePage() {
  if (!phone) {
    const ctx = await newContext(PHONE);
    phone = await openWorld(ctx);
  }
  return phone;
}

// Re-mesh every h1 chunk for the camera where it is, and wait for the page to go idle.
function settleHere(page) {
  return page.evaluate(async () => {
    const ok = await window.__cw.settle(300000);
    if (window.__cw.sunIdle) await window.__cw.sunIdle();
    return ok;
  });
}

const manifestOf = () => JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'ascii'));

// A synthetic 1 m chunk (242 x 242 with its apron): sine hills, a 6 m pit on the east
// edge and a sea bay in the south-west. Built in the page.
const FIELD = `
  window.__cwField = function () {
    const W = 242, v = new Uint16Array(W * W), classes = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) {
      const t = r * W + q;
      let dm = 400 + Math.round(120 * Math.sin(r / 17) * Math.cos(q / 23) + 40 * Math.sin((r + q) / 9));
      if (r >= 100 && r <= 130 && q >= 226) dm -= 60;
      if (Math.hypot(r - 241, q) < 70) { dm = 0; classes[t] = 5; }
      v[t] = dm;
    }
    return { header: { width: W, height: W, cell: 1, cellCm: 100, base: 0, apron: true, hasClasses: true }, v, classes };
  };
  // A low coast: ground a few metres up, cut by ripples into islets and inlets, falling to
  // the sea westward, with a lake in the south-west corner.
  window.__cwCoast = function () {
    const W = 242, base = -50, v = new Uint16Array(W * W), classes = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) {
      const t = r * W + q, dm = 40 + 30 * Math.sin(r / 5) + 20 * Math.cos(q / 3) - 0.6 * q;
      if (dm <= 0) classes[t] = 5;
      if (r > 200 && q < 60) classes[t] = 4;
      v[t] = Math.max(0, Math.round(dm - base));
    }
    return { header: { width: W, height: W, cell: 1, cellCm: 100, base, apron: true, hasClasses: true }, v, classes };
  };
`;

// Seam analysis, as in viewer test 7: the drawn surface along the seam line and the skirts
// that face the other chunk. mesh {pos, idx}, x0, z0; U the axis across the seam.
const SEAM = `
  window.__cwSeamGaps = function (A, B, axis) {
    const U = axis === 'x' ? 0 : 2, Wd = axis === 'x' ? 2 : 0;
    const seam = axis === 'x' ? A.x0 + 240 : A.z0 + 240, w0 = axis === 'x' ? A.z0 : A.x0;
    const profile = (R, facing) => {
      const P = R.pos, I = R.idx, segs = [], skirts = [];
      const V = (k) => [P[k * 3] + R.x0, P[k * 3 + 1], P[k * 3 + 2] + R.z0];
      for (let t = 0; t < I.length; t += 3) {
        const a = V(I[t]), b = V(I[t + 1]), c = V(I[t + 2]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const on = [a, b, c].filter((p) => Math.abs(p[U] - seam) < 1e-4);
        if (Math.abs(g[1]) > 1e-9) { if (on.length === 2) segs.push(on); }
        else if (on.length === 3 && Math.sign(g[U]) === facing) skirts.push([a, b, c]);
      }
      const top = (wv) => {
        for (const [p, q] of segs) {
          if (wv >= Math.min(p[Wd], q[Wd]) && wv <= Math.max(p[Wd], q[Wd])) return p[1] + (q[1] - p[1]) * (wv - p[Wd]) / (q[Wd] - p[Wd]);
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
    const pa = profile(A, 1), pb = profile(B, -1);
    let checked = 0;
    const gaps = [];
    for (let k = 0; k < 240; k++) {
      const wv = w0 + k + 0.5, ya = pa.top(wv), yb = pb.top(wv);
      if (ya === null && yb === null) continue;
      checked++;
      const a = ya === null ? 0 : ya, b = yb === null ? 0 : yb;
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
    return { checked, gaps };
  };
  window.__cwLive = function (c) {
    const g = c.mesh.geometry;
    return { pos: g.attributes.position.array, idx: g.index.array, x0: c.x0, z0: c.z0 };
  };
`;

/* The see-through check. The sky is hidden, the fog pushed out, and the clear colour and the
 * water plane both drawn magenta: the water plane (at 0 m, under the whole view) would
 * otherwise show through any crack in the land, and a crack would never reach the clear
 * colour. A magenta pixel is a crack when its ray escapes (never meets the water within the
 * water plane's 12 km) or meets the water where the drawn ground is land (above 0.1 m): to
 * get there it went through the ground. Magenta over the sea is the sea. */
const MAGENTA = `
  window.__cwMagenta = function () {
    const I = window.__cw.internals, R = I.renderer, cam = I.camera;
    const clear = R.getClearColor(I.scene.fog.color.clone()), alpha = R.getClearAlpha();
    const fog = [I.scene.fog.near, I.scene.fog.far], waterMat = I.water.material;
    const magenta = waterMat.clone();
    magenta.color.setHex(0xff00ff); magenta.emissive.setHex(0xff00ff); magenta.specular.setHex(0x000000);
    I.water.material = magenta;
    I.sky.visible = false;
    I.scene.fog.near = 1e9; I.scene.fog.far = 2e9;
    R.setClearColor(0xff00ff, 1);
    cam.updateMatrixWorld();
    R.render(I.scene, cam);
    const gl = R.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    I.water.material = waterMat;
    magenta.dispose();
    I.sky.visible = true;
    I.scene.fog.near = fog[0]; I.scene.fog.far = fog[1];
    R.setClearColor(clear, alpha);
    let water = 0, cracks = 0;
    const where = [], v = cam.position.clone(), o = cam.position.clone();
    for (let k = 0; k < w * h; k++) {
      if (!(px[k * 4] > 240 && px[k * 4 + 1] < 20 && px[k * 4 + 2] > 240)) continue;
      const x = k % w, y = Math.floor(k / w);
      v.set((x + 0.5) / w * 2 - 1, (y + 0.5) / h * 2 - 1, 0.5).unproject(cam).sub(o).normalize();
      let crack = v.y >= 0;
      if (!crack) {
        const t = -o.y / v.y, qx = o.x + v.x * t, qz = o.z + v.z * t;
        if (Math.hypot(qx - o.x, qz - o.z) > 11900) crack = true;
        else { const s = I.manager.surfaceAt(qx, qz); crack = s !== null && s > 0.1; }
      }
      if (crack) { cracks++; if (where.length < 4) where.push([x, h - 1 - y]); } else water++;
    }
    return { cracks, water, where, held: I.manager.tinStats().held };
  };
`;

// ------------------------------------------------------------------------------------------
test('h1 TIN faces up and its skirts face out', { timeout: READY_MS + 60000 }, async () => {
  const { page } = await mainPage();
  await page.addScriptTag({ content: FIELD });
  const r = await page.evaluate(async () => {
    const { cornerHeight } = await import('/world/js/chunks.js');
    const field = window.__cwField();
    const borders = [{ kind: 'h1' }, { kind: 'sea' }, { kind: 'outer', floor: null }, { kind: 'h1' }];
    const res = await window.__cw.meshRaw(field, 'tin', { tau: 0.25, borders, keepDropped: true });
    const m = res.mesh, P = m.pos, I = m.idx, corner = res.corner;
    const out = { surface: 0, up: 0, skirts: 0, outward: 0, degenerate: 0, shallow: [], unskirted: [], seaHigh: 0 };
    const skirtAt = new Map();          // side:along -> [top, bottom]
    const sideOf = (vs) => {
      if (vs.every((p) => p[0] === 0)) return 3;
      if (vs.every((p) => p[0] === 240)) return 1;
      if (vs.every((p) => p[2] === 0)) return 0;
      if (vs.every((p) => p[2] === 240)) return 2;
      return -1;
    };
    const along = (s, p) => (s === 0 || s === 2 ? p[0] : p[2]);
    const skirtTris = [[], [], [], []];
    for (let t = 0; t < I.length; t += 3) {
      const v = [I[t], I[t + 1], I[t + 2]].map((k) => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
      const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      if (Math.hypot(g[0], g[1], g[2]) < 1e-9) { out.degenerate++; continue; }
      if (g[1] !== 0) { out.surface++; if (g[1] > 0) out.up++; continue; }
      out.skirts++;
      const s = sideOf(v);
      const want = [[0, -1], [1, 0], [0, 1], [-1, 0]][s] || [0, 0];
      if (g[0] * want[0] + g[2] * want[1] > 0) out.outward++;
      if (s < 0) continue;
      skirtTris[s].push(v);
      for (const p of v) {
        const key = s + ':' + along(s, p), e = skirtAt.get(key) || [-Infinity, Infinity];
        skirtAt.set(key, [Math.max(e[0], p[1]), Math.min(e[1], p[1])]);
      }
    }
    // every border segment between used surface vertices, unless both ends are sea, has a skirt
    // at least as deep as the rule: N and W 'h1' 0.5 + 3 tau, E 'sea' down to -3 m or lower,
    // S 'outer' (no floor) 16 + 3 tau
    const used = [new Set(), new Set(), new Set(), new Set()];
    for (let k = 0; k < corner.length; k++) {
      if (corner[k] < 0) continue;
      const a = Math.floor(corner[k] / 241), b = corner[k] % 241;
      if (a === 0) used[0].add(b); if (b === 240) used[1].add(a); if (a === 240) used[2].add(b); if (b === 0) used[3].add(a);
    }
    const cornerAt = (s, k) => (s === 0 ? [0, k] : s === 1 ? [k, 240] : s === 2 ? [240, k] : [k, 0]);
    let segments = 0;
    for (let s = 0; s < 4; s++) {
      const list = [...used[s]].sort((x, y) => x - y);
      for (let j = 1; j < list.length; j++) {
        const [a0, b0] = cornerAt(s, list[j - 1]), [a1, b1] = cornerAt(s, list[j]);
        const c0 = cornerHeight(field, a0, b0), c1 = cornerHeight(field, a1, b1);
        if (c0.sea && c1.sea) continue;
        segments++;
        const mid = (list[j - 1] + list[j]) / 2;
        const covers = skirtTris[s].some((v) => Math.min(...v.map((p) => along(s, p))) <= mid && Math.max(...v.map((p) => along(s, p))) >= mid);
        if (!covers) { out.unskirted.push([s, list[j - 1], list[j]]); continue; }
        for (const [k, c] of [[list[j - 1], c0], [list[j], c1]]) {
          const e = skirtAt.get(s + ':' + k);
          const top = c.y, bottom = e ? e[1] : Infinity;
          const need = s === 1 ? Math.min(top - 1.25, -3) : s === 2 ? top - 16.75 : top - 1.25;
          if (!(bottom <= need + 1e-4)) out.shallow.push([s, k, top, bottom]);
          if (s === 1 && !(bottom <= -3 + 1e-6)) out.seaHigh++;
        }
      }
    }
    out.segments = segments;
    out.triangles = m.triangles;
    out.shallow = out.shallow.slice(0, 5);
    out.unskirted = out.unskirted.slice(0, 5);
    return out;
  });
  assert.ok(r.surface > 450 && r.skirts > 0 && r.segments > 40, JSON.stringify(r));
  assert.equal(r.degenerate, 0, 'no degenerate triangle');
  assert.equal(r.up, r.surface, 'every surface triangle faces up');
  assert.equal(r.outward, r.skirts, 'every skirt faces out of the chunk');
  assert.deepEqual(r.unskirted, [], 'every land border segment has a skirt');
  assert.deepEqual(r.shallow, [], 'every skirt is at least as deep as its rule');
  assert.equal(r.seaHigh, 0, 'sea-facing skirts reach -3 m or lower');
});

test('h1 TIN stays within tolerance and has no T-junctions, with either error map', { timeout: 240000 }, async (t) => {
  const { page } = await mainPage();
  await page.addScriptTag({ content: FIELD });
  const runs = await page.evaluate(async () => {
    const { cornerHeight, tinLeaf } = await import('/world/js/chunks.js');
    const NV = 241, K = 0.00237;
    // the hills with the pit and the bay, and the low coast (where clamping at the water and
    // all-sea triangles decide the error maps); graded cameras over the pit, and on, above
    // and beside the coast (chunk-local)
    const fields = [
      { name: 'hills', data: window.__cwField(), cases: [{ tau: 0.1 }, { tau: 0.5 }, { tau: 2 }, { px: 2, K, tmin: 0.05, cam: [236, 60, 115] }] },
      { name: 'coast', data: window.__cwCoast(), cases: [{ tau: 0.05 }, { tau: 0.5 }, { tau: 3 }, { px: 2, K, tmin: 0.05, cam: [10, 5, 10] },
        { px: 1, K, tmin: 0.05, cam: [-300, 400, 120] }, { px: 2, K, tmin: 0.05, cam: [120, 80, 250] }] }
    ];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const out = [];
    for (const { name, data: field, cases } of fields) {
      const hC = new Float64Array(NV * NV), sea = new Uint8Array(NV * NV);
      let yVis = 0;
      for (let a = 0; a < NV; a++) for (let b = 0; b < NV; b++) {
        const c = cornerHeight(field, a, b);
        hC[a * NV + b] = c.y; sea[a * NV + b] = c.sea ? 1 : 0;
        yVis = Math.max(yVis, c.y);
      }
      const vis = (h) => (h > 0 ? h : 0);
      for (const tol of cases) {
        const tris = {}, cam = tol.cam;
        for (const errors of ['exact', 'bound']) {
          const res = await window.__cw.meshRaw(field, 'tin', Object.assign({ errors, keepDropped: true }, tol));
          const m = res.mesh, I = m.idx, corner = res.corner;
          const leaves = [];
          for (let t = 0; t < I.length; t += 3) {
            const k = [corner[I[t]], corner[I[t + 1]], corner[I[t + 2]]];
            if (k.some((x) => x < 0)) continue;          // a skirt
            leaves.push([k, false]);
          }
          for (let t = 0; t < res.dropped.length; t += 3) leaves.push([[res.dropped[t], res.dropped[t + 1], res.dropped[t + 2]], true]);
          // rasterise every leaf over the corners: the drawn height there (water at 0 under a
          // dropped leaf) and any disagreement between leaves at a shared corner
          const drawn = new Float64Array(NV * NV).fill(NaN);
          let disagree = 0;
          const bary = (k, x, z) => {
            const [A, B, C] = k.map((i) => [i % NV, Math.floor(i / NV)]);
            const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
            const wa = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (z - C[1])) / d;
            const wb = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (z - C[1])) / d;
            return [wa, wb, 1 - wa - wb];
          };
          for (const [k, dropped] of leaves) {
            const xs = k.map((i) => i % NV), zs = k.map((i) => Math.floor(i / NV));
            for (let z = Math.min(...zs); z <= Math.max(...zs); z++) for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
              const w = bary(k, x, z);
              if (w.some((q) => q < -1e-9)) continue;
              const s = dropped ? 0 : w[0] * hC[k[0]] + w[1] * hC[k[1]] + w[2] * hC[k[2]], p = z * NV + x;
              if (!Number.isNaN(drawn[p])) disagree = Math.max(disagree, Math.abs(vis(drawn[p]) - vis(s)));
              drawn[p] = s;
            }
          }
          let worst = -Infinity, uncovered = 0;
          const dy = tol.cam ? Math.max(0, tol.cam[1] - yVis) : 0;
          for (let p = 0; p < NV * NV; p++) {
            if (Number.isNaN(drawn[p])) { uncovered++; continue; }
            const x = p % NV, z = Math.floor(p / NV);
            const tau = tol.tau !== undefined ? tol.tau : Math.max(tol.tmin, tol.px * tol.K * Math.hypot(Math.hypot(x - cam[0], z - cam[2]), dy));
            worst = Math.max(worst, Math.abs(vis(hC[p]) - vis(drawn[p])) - tau);
          }
          // every interior edge is shared by exactly two leaves, a border edge by one
          const edges = new Map();
          for (const [k] of leaves) for (let e = 0; e < 3; e++) {
            const a = k[e], b = k[(e + 1) % 3], key = Math.min(a, b) + ':' + Math.max(a, b);
            edges.set(key, (edges.get(key) || 0) + 1);
          }
          let badEdges = 0;
          for (const [key, n] of edges) {
            const [a, b] = key.split(':').map(Number);
            const ax = a % NV, az = Math.floor(a / NV), bx = b % NV, bz = Math.floor(b / NV);
            const border = (ax === bx && (ax === 0 || ax === 240)) || (az === bz && (az === 0 || az === 240));
            if (n !== (border ? 1 : 2)) badEdges++;
          }
          // the split-bit descent finds the same height as a brute-force search (over the leaves
          // of the point's tile: a leaf never crosses a tile)
          const byTile = new Map();
          for (const leaf of leaves) {
            const xs = leaf[0].map((i) => i % NV), zs = leaf[0].map((i) => Math.floor(i / NV));
            const key = Math.min(14, Math.floor((xs[0] + xs[1] + xs[2]) / 48)) + ':' + Math.min(14, Math.floor((zs[0] + zs[1] + zs[2]) / 48));
            if (!byTile.has(key)) byTile.set(key, []);
            byTile.get(key).push(leaf);
          }
          let locWorst = 0;
          for (let k = 0; k < 2000; k++) {
            const x = rnd() * 240, z = rnd() * 240, tx = Math.min(14, Math.floor(x / 16)), tz = Math.min(14, Math.floor(z / 16));
            const L = tinLeaf(res.split, tz * 15 + tx, x - 16 * tx, z - 16 * tz);
            const kk = [[L[0], L[1]], [L[2], L[3]], [L[4], L[5]]].map(([u, v]) => (16 * tz + v) * NV + 16 * tx + u);
            const wd = bary(kk, x, z), allSea = kk.every((i) => sea[i]);
            const sd = allSea ? 0 : vis(wd[0] * hC[kk[0]] + wd[1] * hC[kk[1]] + wd[2] * hC[kk[2]]);
            let sb = null;
            for (const [k2, dropped] of byTile.get(tx + ':' + tz) || []) {
              const w = bary(k2, x, z);
              if (w.some((q) => q < -1e-9)) continue;
              sb = dropped ? 0 : vis(w[0] * hC[k2[0]] + w[1] * hC[k2[1]] + w[2] * hC[k2[2]]);
              break;
            }
            locWorst = Math.max(locWorst, sb === null ? Infinity : Math.abs(sd - sb));
          }
          tris[errors] = m.surfaceTriangles;
          out.push({ tol: name + ' ' + JSON.stringify(tol), errors, triangles: m.surfaceTriangles, worstOverTau: worst, uncovered, disagree, badEdges, locWorst });
        }
        out.push({ tol: name + ' ' + JSON.stringify(tol), boundAtLeastExact: tris.bound >= tris.exact });
      }
    }
    return out;
  });
  t.diagnostic(runs.filter((r) => r.errors).map((r) => r.tol + ' ' + r.errors + ': ' + r.triangles + ' triangles').join('; '));
  for (const r of runs) {
    if (r.boundAtLeastExact !== undefined) { assert.ok(r.boundAtLeastExact, 'the bound draws at least as many triangles: ' + r.tol); continue; }
    const at = r.tol + ' ' + r.errors + ': ' + JSON.stringify(r);
    assert.ok(r.worstOverTau <= 1e-4, 'within tau(d) of every corner: ' + at);
    assert.equal(r.uncovered, 0, 'every corner is covered: ' + at);
    assert.ok(r.disagree <= 1e-6, 'no two leaves disagree at a shared corner: ' + at);
    assert.equal(r.badEdges, 0, 'every interior edge is shared by exactly two triangles: ' + at);
    assert.ok(r.locWorst <= 1e-6, 'the split-bit descent matches brute force: ' + at);
  }
});

test('a cliff on a chunk edge is covered from both sides', { timeout: 2 * READY_MS + 120000 }, async () => {
  const manifest = manifestOf();
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const { origin_e: oe, origin_n: on } = manifest.crs;
  const i0 = Math.floor(oe / 240), j0 = Math.floor(on / 240);
  // A and its east neighbour B, both land and well above the sea, near the start
  let pick = null;
  for (const [di, dj] of [[0, 1], [1, 1], [-1, 1], [0, -1], [1, 0], [-2, 0], [1, -1], [-1, -1]]) {
    const a = (i0 + di) + '_' + (j0 + dj), b = (i0 + di + 1) + '_' + (j0 + dj);
    if (h1.chunks[a] && h1.chunks[b] && h1.chunks[a].min > 5 && h1.chunks[b].min > 20) { pick = { a, b }; break; }
  }
  assert.ok(pick, 'a pair of land chunks to put the cliff between');
  // A 12 m drop at the seam, written into both files so their aprons agree: B's first six
  // columns, and A's apron column (B's first), rows 20-220 only, so no other chunk's apron
  // sees the change.
  const A = reencodeChunk(manifest, 'h1', pick.a, (dm, W) => { for (let r = 20; r <= 220; r++) dm[r * W + 241] -= 120; });
  const B = reencodeChunk(manifest, 'h1', pick.b, (dm, W) => { for (let r = 20; r <= 220; r++) for (let q = 1; q <= 6; q++) dm[r * W + q] -= 120; });
  const results = [];
  for (const late of [pick.a, pick.b]) {
    const ctx = await newContext();
    const served = [];
    await ctx.route('**/out/synthetic/manifest.json', async (route) => {
      const res = await route.fetch();
      const m = await res.json();
      const l = m.levels.find((x) => x.name === 'h1');
      for (const f of [A, B]) l.chunks[f.key] = Object.assign({}, l.chunks[f.key], { file: f.file, bytes: f.gz.length, min: f.min, max: f.max });
      await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
    });
    for (const f of [A, B]) {
      await ctx.route('**/out/synthetic/' + f.file, async (route) => {
        if (f.key === late) await new Promise((r) => setTimeout(r, 4000));   // this one arrives last
        served.push(f.key);
        await route.fulfill({ status: 200, body: f.gz, contentType: 'application/gzip' });
      });
    }
    const { page, log } = await openWorld(ctx);
    await page.addScriptTag({ content: SEAM });
    for (const where of ['near', 'far']) {
      await page.evaluate(({ a, where }) => {
        const M = window.__cw.internals.manager, c = M.byKey['h1:' + a];
        const x = c.x0 + 240, z = c.z0 + 120, g = M.surfaceAt(x - 3, z);
        if (where === 'near') window.__cw.camera.set({ mode: 'walk', x: x - 3, z, y: g + 1.7, yaw: -Math.PI / 2, pitch: -0.2 });
        else window.__cw.camera.set({ mode: 'fly', x: x - 1500, z, y: g + 300, yaw: -Math.PI / 2, pitch: -0.2 });
      }, { a: pick.a, where });
      await settleHere(page);
      const r = await page.evaluate(({ a, b }) => {
        const M = window.__cw.internals.manager;
        return window.__cwSeamGaps(window.__cwLive(M.byKey['h1:' + a]), window.__cwLive(M.byKey['h1:' + b]), 'x');
      }, pick);
      results.push({ late, where, served: served.slice(), checked: r.checked, gaps: r.gaps.slice(0, 3), n: r.gaps.length });
    }
    assert.deepEqual(log.errors, []);
    assert.deepEqual(glWarnings(log), [], 'GL warnings');
    assert.deepEqual(log.console, []);
    await page.close();
  }
  for (const r of results) {
    assert.equal(r.served[r.served.length - 1], r.late, 'the delayed chunk arrived last: ' + JSON.stringify(r));
    assert.ok(r.checked >= 200, 'the seam was sampled along its length: ' + JSON.stringify(r));
    assert.equal(r.n, 0, 'no gap at the cliff: ' + JSON.stringify(r));
  }
});

test('land cover lands in the right place', { timeout: 180000 }, async () => {
  const { page } = await mainPage();
  // world/pipeline/tests/test_synthetic_build.py CLASS_POINTS, h1 only: (x east, n north, class).
  // Each is read at the sample centre that test picks (the west and north of two equidistant).
  const points = [
    [922, 320, 1], [945, 300, 0], [900, 300, 12], [-335, -700, 3], [750, -250, 2], [900, -800, 4], [-1300, 0, 5],
    [-100, 100, 6], [1300, 200, 13], [110, 500, 7], [122, 500, 8], [550, 800, 9], [1325, -850, 4], [5, -8, 12],
    [900, -1120, 7], [1100, 400, 0], [-680, 0, 0]
  ];
  const got = await page.evaluate((pts) => pts.map(([x, n]) => window.__cw.internals.manager.materialAt(x - 0.5, -n - 0.5)), points);
  points.forEach(([x, n, cls], k) => {
    assert.ok(got[k], 'a class at ' + x + ', ' + n);
    assert.equal(got[k].cls, cls, 'class at ' + x + ', ' + n);
    assert.equal(got[k].level, 'h1');
    assert.ok(got[k].rock >= 0 && got[k].rock <= 1);
  });
  // The pixels: close-ups of the road and the forest floor, trees and buildings hidden, and
  // the sun's direct light at zero, so a slope that faces the sun does not decide the
  // comparison (on this world the forest point faces it a little more squarely than the road).
  // (Its intensity, not its visibility: a hidden light compiles other programs.) The mean
  // over a patch: 1.6 m of road from 6 m up, 12 m of forest floor from 20 m up.
  const colours = await page.evaluate(async () => {
    const I = window.__cw.internals, cw = window.__cw;
    const hide = [I.buildings && I.buildings.group, I.trees && I.trees.group].filter(Boolean);
    const suns = [];
    I.scene.traverse((o) => { if (o.isDirectionalLight) suns.push([o, o.intensity]); });
    const was = hide.map((o) => o.visible);
    const patch = async (x, z, up, n) => {
      const g = I.manager.surfaceAt(x, z);
      cw.camera.set({ mode: 'fly', x, z, y: g + up, yaw: 0, pitch: -Math.PI / 2 + 0.001 });
      await cw.settle(300000);
      if (cw.sunIdle) await cw.sunIdle();
      hide.forEach((o) => { o.visible = false; });
      suns.forEach(([o]) => { o.intensity = 0; });
      I.renderer.render(I.scene, I.camera);
      const gl = I.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(n * n * 4);
      gl.readPixels(Math.floor(w / 2 - n / 2), Math.floor(h / 2 - n / 2), n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
      hide.forEach((o, k) => { o.visible = was[k]; });
      suns.forEach(([o, v]) => { o.intensity = v; });
      const m = [0, 0, 0];
      for (let k = 0; k < n * n; k++) for (let c = 0; c < 3; c++) m[c] += px[k * 4 + c] / (n * n);
      return m;
    };
    const road = await patch(110 - 0.5, -500 - 0.5, 6, 160), forest = await patch(922 - 0.5, -320 - 0.5, 20, 360);
    cw.camera.start();
    await cw.settle(300000);
    return { road, forest };
  });
  const sat = (c) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const diff = Math.hypot(colours.road[0] - colours.forest[0], colours.road[1] - colours.forest[1], colours.road[2] - colours.forest[2]);
  const at = JSON.stringify(colours);
  assert.ok(sat(colours.road) < sat(colours.forest), 'the road is greyer than the forest floor: ' + at);
  assert.ok(lum(colours.forest) < lum(colours.road), 'the forest floor is darker than the road: ' + at);
  assert.ok(diff > 20, 'they differ by ' + diff.toFixed(1) + ': ' + at);
});

test('the far palette is one table', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const { TERRAIN_PALETTE, farColourLinear } = await import('/world/js/terrainmat.js');
    const src = await (await fetch('/world/js/worker.js')).text();
    const list = (name) => new RegExp('\\bvar\\s+' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(src)[1]
      .split(',').map((x) => Number(x.trim()));
    const FAR = list('FAR'), ONSET = list('ONSET');
    // an h5 vertex about 1.5 km out, on land: the colour the worker gave it, and the far
    // colour computed here from the same corner (its class by majority, its normal)
    const M = window.__cw.internals.manager, cam = window.__cw.internals.camera.position;
    const PRI = [12, 7, 8, 9, 4, 6, 13, 3, 1, 2, 10, 11, 0, 5];
    const checked = [];
    for (const c of M.chunks) {
      if (c.level.name !== 'h5' || !c.mesh || !c.data || checked.length >= 40) continue;
      const g = c.mesh.geometry, P = g.attributes.position.array, C = g.attributes.color.array;
      const s = c.lod, W = c.data.header.width, nv = 240 / s + 1, cell = c.data.header.cell;
      for (let a = 0; a < nv && checked.length < 40; a += 7) for (let b = 0; b < nv && checked.length < 40; b += 7) {
        const i = a * nv + b, x = P[i * 3] + c.x0, z = P[i * 3 + 2] + c.z0;
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d < 1400 || d > 1700 || P[i * 3 + 1] < 1) continue;
        const t0 = a * s * W + b * s, ts = [t0, t0 + 1, t0 + W, t0 + W + 1], hs = [], counts = new Array(16).fill(0);
        let sea = 0;
        for (const t of ts) {
          const dm = c.data.header.base + c.data.v[t], k = c.data.classes ? c.data.classes[t] : 0;
          hs.push(dm / 10);
          if (k === 5 || (dm <= 0 && k !== 4)) sea++; else counts[k]++;
        }
        if (sea) continue;
        let cls = 0, best = 0;
        for (const k of PRI) if (counts[k] > best) { best = counts[k]; cls = k; }
        const gx = ((hs[1] + hs[3]) - (hs[0] + hs[2])) / (2 * cell), gz = ((hs[2] + hs[3]) - (hs[0] + hs[1])) / (2 * cell);
        const want = farColourLinear(cls, 1 / Math.sqrt(gx * gx + 1 + gz * gz));
        checked.push({ cls, d: Math.max(...want.map((v, k) => Math.abs(v - C[i * 3 + k] / 255))) });
      }
    }
    return { FAR, ONSET, pal: TERRAIN_PALETTE.map((p) => [p.far, p.onset]), checked };
  });
  assert.equal(r.FAR.length, r.pal.length, 'one far colour per palette entry');
  r.pal.forEach(([far, onset], k) => {
    assert.equal(r.FAR[k], far, 'far colour of entry ' + k);
    if (k < r.ONSET.length) assert.equal(r.ONSET[k], onset, 'rock onset of entry ' + k);
  });
  assert.equal(r.ONSET.length, 14, 'an onset for every class code');
  assert.ok(r.checked.length >= 10, 'h5 vertices 1.5 km out were checked: ' + r.checked.length);
  const worst = Math.max(...r.checked.map((c) => c.d));
  assert.ok(worst <= 2 / 255, 'h5 vertex colours are the far colour, worst ' + (worst * 255).toFixed(2) + '/255');
});

test('one terrain program, with lights and shadows intact, on both tiers', { timeout: READY_MS + 300000 }, async () => {
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page, log } = await get();
    await page.evaluate(() => window.__cw.camera.start());
    await settleHere(page);
    const loop = async () => {
      for (const d of [800, 1400, 0]) {
        await page.evaluate((d) => {
          const p = window.__cw.camera.pose(), g = window.__cw.groundAt(p.x, p.z);
          if (d === 0) window.__cw.camera.start();
          else window.__cw.camera.set({ mode: 'fly', x: p.x + d, z: p.z - d / 2, y: (g ? g.y : 0) + 150 + d / 4, pitch: -0.3 });
        }, d);
        await settleHere(page);
      }
      return page.evaluate(() => window.__cw.internals.renderer.info.programs.length);
    };
    const warm = await loop();
    const again = await loop();
    const r = await page.evaluate(() => {
      const M = window.__cw.internals.manager, R = window.__cw.internals.renderer;
      const mats = M.chunks.filter((c) => c.level.name === 'h1' && c.mesh).map((c) => c.mesh.material);
      return {
        h1: mats.length, lambert: mats.filter((m) => m.isMeshLambertMaterial).length,
        keys: [...new Set(mats.map((m) => m.customProgramCacheKey()))],
        live: R.info.programs.filter((p) => p.usedTimes > 0).map((p) => p.cacheKey),
        info: M.terrainInfo(), shared: new Set(mats).size
      };
    });
    const tier = 'cwT1-' + name;
    assert.ok(r.h1 > 0 && r.lambert === r.h1, name + ': every h1 material is a MeshLambertMaterial');
    assert.equal(r.shared, r.h1, name + ': one material per chunk');
    // one key shared by every h1 material; it starts with the tier's (the sun's patch appends
    // its own part to it, SPEC 3.6)
    assert.equal(r.keys.length, 1, name + ': one cache key: ' + JSON.stringify(r.keys));
    assert.ok(r.keys[0].startsWith(tier), name + ': the key starts with ' + tier + ': ' + JSON.stringify(r.keys));
    assert.equal(r.live.filter((k) => k.includes(tier)).length, 1, name + ': exactly one live terrain program');
    assert.equal(r.live.filter((k) => k.includes('cwT1-')).length, 1, name + ': and no other tier');
    assert.ok(r.info.textures >= 2 * r.h1 && r.info.textures <= 2 * r.h1 + 2, name + ': ' + JSON.stringify(r.info));
    assert.equal(r.info.programs, 1);
    assert.equal(again, warm, name + ': the program count does not grow flying out and back');
    assert.deepEqual(log.errors, [], name + ': page errors');
    assert.deepEqual(log.console, [], name + ': console errors');
    assert.deepEqual(log.warnings, [], name + ': console warnings');
  }
});

test('moving re-meshes only what it must, and returns to the same mesh', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const first = await page.evaluate(() => window.__cw.internals.manager.chunks.filter((c) => c.level.name === 'h1')
    .map((c) => [c.key, c.mesh.userData.triangles]));
  const before = await page.evaluate(() => window.__cw.loadOrder().length);
  // A 64 m walk along the start's view, 2 m at a time, letting the page update as it goes,
  // then waiting (without settle(), which re-meshes every chunk) until the last job is in.
  // Every h1 mesh job is recorded as it is sent, with the camera it reads: a chunk is sent a
  // second job only once the camera has moved on from the first by the refresh rule,
  // max(16 m, a quarter of the distance), so no chunk is ever meshed twice for one move.
  const walk = await page.evaluate(async () => {
    const cw = window.__cw, M = cw.internals.manager, s = cw.camera.get(), dx = -Math.sin(s.yaw), dz = -Math.cos(s.yaw);
    const last = new Map(), close = [], run = M._run;
    for (const c of M.chunks) if (c.level.name === 'h1' && c.tolInfo && c.tolInfo.cam) last.set(c.key, c.tolInfo.cam.slice());
    M._run = function (job) {
      const c = job.c;
      if (c.level.name === 'h1' && job.kind === 'mesh') {
        const cam = [M.cam.x, M.cam.y, M.cam.z], prev = last.get(c.key);
        const rule = Math.max(M.tin.snapMin, M.tin.snapFrac * M.distance(c, M.cam));
        if (!c.forceStale && prev && Math.hypot(cam[0] - prev[0], cam[1] - prev[1], cam[2] - prev[2]) < 0.9 * rule) {
          close.push({ key: c.key, moved: Math.hypot(cam[0] - prev[0], cam[1] - prev[1], cam[2] - prev[2]), rule });
        }
        last.set(c.key, cam);
      }
      return run.call(this, job);
    };
    try {
      for (let m = 2; m <= 64; m += 2) {
        const x = s.x + dx * m, z = s.z + dz * m, g = M.surfaceAt(x, z);
        cw.camera.set({ mode: 'walk', x, z, y: g + 1.7 });
        await cw.frame();
        await new Promise((r) => setTimeout(r, 260));
        await cw.frame();
      }
      M.update(cw.internals.camera.position);
      const t0 = performance.now();
      while (M.queue.length + M.inflight > 0 && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 50));
    } finally {
      M._run = run;
    }
    return { close: close.slice(0, 5), n: close.length, idle: M.queue.length + M.inflight === 0 };
  });
  const jobs = await page.evaluate((n) => window.__cw.loadOrder().slice(n).filter((j) => j.level === 'h1'), before);
  assert.ok(walk.idle, 'the walk\'s jobs finished');
  assert.ok(jobs.length < 40, jobs.length + ' h1 mesh jobs for a 64 m walk');
  assert.ok(jobs.every((j) => j.kind === 'mesh'), 'only mesh jobs: ' + [...new Set(jobs.map((j) => j.kind))]);
  assert.equal(walk.n, 0, 'a chunk re-meshed before the camera moved on by the refresh rule: ' + JSON.stringify(walk.close));
  // Back at the start: forceSnapshots re-meshes exactly the chunks whose mesh was made for
  // another camera, and a second call at the same camera re-meshes nothing.
  const snap = await page.evaluate(async () => {
    const cw = window.__cw, I = cw.internals, M = I.manager;
    cw.camera.start();
    const p = I.camera.position.clone();
    const elsewhere = M.chunks.filter((c) => c.level.name === 'h1' && c.status === 'ready' &&
      !(c.tolInfo.cam[0] === p.x && c.tolInfo.cam[1] === p.y && c.tolInfo.cam[2] === p.z)).length;
    const n0 = cw.loadOrder().length;
    M.forceSnapshots(p);
    const firstCall = cw.loadOrder().length - n0 + M.queue.length;
    const t0 = performance.now();
    while (M.queue.length + M.inflight > 0 && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 50));
    const n1 = cw.loadOrder().length;
    M.forceSnapshots(p);
    return { elsewhere, firstCall, secondCall: cw.loadOrder().length - n1 + M.queue.length };
  });
  assert.ok(snap.elsewhere > 0, 'the walk re-meshed some chunks: ' + JSON.stringify(snap));
  assert.equal(snap.firstCall, snap.elsewhere, 'forceSnapshots re-meshes the chunks meshed elsewhere: ' + JSON.stringify(snap));
  assert.equal(snap.secondCall, 0, 'and nothing when called again at the same camera: ' + JSON.stringify(snap));
  await settleHere(page);
  const back = await page.evaluate(() => window.__cw.internals.manager.chunks.filter((c) => c.level.name === 'h1')
    .map((c) => [c.key, c.mesh.userData.triangles]));
  assert.deepEqual(back, first, 'the same meshes back at the start');
});

test('a stale reply never replaces a newer mesh', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const r = await page.evaluate(async () => {
    const cw = window.__cw, I = cw.internals, M = I.manager, cam = I.camera.position;
    const c = M.chunkAt('h1', cam.x, cam.z), seqs = [];
    const onChange = M.onChange;
    M.onChange = (ch, kind) => { if (ch === c) seqs.push(ch.mesh.userData.seq); onChange(ch, kind); };
    const discarded = M.discarded;
    M._reorderNext(c.key);
    M.tinForce({ tau: 2 });
    M.update(cam);
    const t0 = performance.now();
    while (!c.held && performance.now() - t0 < 60000) await new Promise((res) => setTimeout(res, 20));
    const held = c.held ? c.held.seq : null;
    M.tinForce({ tau: 0.5 });
    M.update(cam);
    const ok = await cw.settle(300000);
    const out = { held, seqs: seqs.slice(), installed: c.installedSeq, last: c.seqNext, tris: c.mesh.userData.triangles,
                  discarded: M.discarded - discarded, ok };
    const fresh = await M.meshChunk('h1', c.key, { tau: 0.5 });
    out.fresh = fresh.mesh.triangles;
    M.onChange = onChange;
    M.tinForce(null);
    return out;
  });
  await settleHere(page);
  assert.ok(r.held !== null, 'a reply was held back: ' + JSON.stringify(r));
  assert.ok(r.ok, 'the page went idle, so the discarded reply left the in-flight count');
  assert.ok(r.discarded >= 1, 'the held reply was discarded: ' + JSON.stringify(r));
  for (let k = 1; k < r.seqs.length; k++) assert.ok(r.seqs[k] > r.seqs[k - 1], 'the installed seq never goes backwards: ' + r.seqs);
  assert.equal(r.installed, r.last, 'the newest job is what is installed');
  assert.ok(r.held < r.installed);
  assert.equal(r.tris, r.fresh, 'and it is the mesh for the newer tolerance');
});

test('lowestGround bounds the drawn surface', { timeout: 300000 }, async () => {
  const { page } = await mainPage();
  const manifest = manifestOf();
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SYN, manifest.files.buildings.file))).toString('utf8'));
  const boxes = doc.features.map((f) => {
    const xs = f.ring.map((p) => p[0]), zs = f.ring.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  });
  // low: lowestGround; min: the drawn surface's minimum on a 0.5 m grid over the box; tight:
  // the lowest 1 m corner of every 16 m tile the box touches, recomputed here from the
  // chunk's own heights (cornerHeight), the tightest value that holds at every tolerance.
  // low must be at or below min, and no lower than tight: a bound that is merely low (the
  // whole chunk's minimum, say) would sink every wall far below the ground.
  const check = () => page.evaluate(async (boxes) => {
    const M = window.__cw.internals.manager, { cornerHeight } = await import('/world/js/chunks.js');
    const lv = M.levels.h1, S = lv.side, T = 16;
    const tight = (b) => {
      let v = Infinity;
      for (let te = Math.floor((b[0] + M.oe) / T); te <= Math.floor((b[2] + M.oe) / T); te++) {
        for (let tn = Math.floor((M.on - b[3]) / T); tn <= Math.floor((M.on - b[1]) / T); tn++) {
          const i = Math.floor(te * T / S), j = Math.floor(tn * T / S), c = M.byKey['h1:' + i + '_' + j];
          if (!c) { if (lv.sea.has(i + '_' + j)) v = Math.min(v, 0); else return null; continue; }
          const tx = te - i * (S / T), ty = (j + 1) * (S / T) - 1 - tn;
          for (let a = ty * T; a <= ty * T + T; a++) for (let q = tx * T; q <= tx * T + T; q++) v = Math.min(v, cornerHeight(c.data, a, q).y);
        }
      }
      return v;
    };
    return boxes.map((b) => {
      const low = M.lowestGround(b[0], b[1], b[2], b[3]);
      let min = Infinity;
      for (let x = b[0]; x <= b[2] + 1e-9; x += 0.5) for (let z = b[1]; z <= b[3] + 1e-9; z += 0.5) {
        const s = M.surfaceAt(x, z);
        if (s !== null) min = Math.min(min, s);
      }
      return { low, min, tight: tight(b) };
    });
  }, boxes);
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const start = await check();
  const cam = await page.evaluate(() => window.__cw.camera.get());
  await page.evaluate(({ x, z }) => window.__cw.camera.set({ x, z, y: 1500, mode: 'fly' }), cam);
  await settleHere(page);
  const up = await check();
  await page.evaluate(() => { window.__cw.camera.start(); window.__cw.internals.manager.tinForce({ tau: 2 }); });
  await settleHere(page);
  const coarse = await check();
  await page.evaluate(() => window.__cw.internals.manager.tinForce(null));
  await settleHere(page);
  for (const [name, r] of [['start', start], ['1.5 km up', up], ['tau 2 m', coarse]]) {
    assert.equal(r.length, boxes.length);
    r.forEach((b, k) => {
      assert.ok(b.low !== null && b.min < Infinity && b.tight !== null, name + ', building ' + k + ': ' + JSON.stringify(b));
      assert.ok(b.low <= b.min + 1e-9, name + ', building ' + k + ': lowest ' + b.low + ' above the drawn ' + b.min);
      assert.ok(b.low >= b.tight - 1e-9, name + ', building ' + k + ': lowest ' + b.low + ' below every corner of its tiles, ' + b.tight);
    });
  }
});

test('the triangle and draw-call budget per profile', { timeout: READY_MS + 600000 }, async () => {
  const budget = { laptop: { h1: 80000, total: 450000, calls: 150 }, phone: { h1: 40000, total: 300000, calls: 100 } };
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await page.evaluate(() => window.__cw.camera.start());
    await settleHere(page);
    const r = await page.evaluate(async () => {
      const cw = window.__cw;
      await cw.frame();
      for (let k = 0; k < 5 && cw.stats().shadowRedrawn; k++) await cw.frame();
      const v = cw.visible(), s = cw.stats();
      return { v, calls: s.drawCalls, profile: s.profile, total: v.h1 + v.h5 + v.h20 + v.trees + v.buildings };
    });
    const b = budget[name], at = name + ': ' + JSON.stringify(r);
    assert.equal(r.profile, name);
    assert.ok(r.v.h1 > 0 && r.v.h1 <= b.h1, 'h1 in view ' + at);
    assert.ok(r.total <= b.total, 'triangles in view ' + at);
    assert.ok(r.calls <= b.calls, 'draw calls ' + at);
    // a 600 m walk, 20 m at a time: the held h1 triangles stay under the profile's cap
    const walk = await page.evaluate(async () => {
      const cw = window.__cw, M = cw.internals.manager, s = cw.camera.get();
      let most = 0;
      for (let m = 20; m <= 600; m += 20) {
        const x = s.x + m, z = s.z, g = M.surfaceAt(x, z);
        cw.camera.set({ mode: 'walk', x, z, y: (g === null ? 0 : g) + 1.7, yaw: -Math.PI / 2, pitch: 0 });
        await cw.frame();
        await new Promise((res) => setTimeout(res, 150));
        most = Math.max(most, M.tinStats().held);
      }
      await cw.settle(300000);
      most = Math.max(most, M.tinStats().held);
      const t = M.tinStats();
      cw.camera.start();
      return { most, cap: t.heldCap };
    });
    await settleHere(page);
    assert.ok(walk.most <= walk.cap, name + ': held ' + walk.most + ' against ' + walk.cap);
  }
});

test('texture memory', { timeout: 60000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(() => window.__cw.internals.manager.terrainInfo());
  assert.ok(r.textureBytes <= 32 * 1024 * 1024, JSON.stringify(r));
  assert.ok(r.chunkTextureBytes > 0 && r.chunkTextureBytes <= 240 * 1024, JSON.stringify(r));
});

test('no see-through cracks (magenta), on both tiers', { timeout: READY_MS + 900000 }, async () => {
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await page.addScriptTag({ content: MAGENTA });
    await page.evaluate(() => window.__cw.camera.start());
    await settleHere(page);
    // poses: where four h1 chunks meet, the h1/h5 boundary seen from outside, and over the shore
    const poses = await page.evaluate(() => {
      const M = window.__cw.internals.manager, lv = M.levels.h1, cw = window.__cw, p = cw.camera.pose();
      const h1 = M.chunks.filter((c) => c.level.name === 'h1').sort((a, b) =>
        Math.hypot(a.x0 + 120 - p.x, a.z0 + 120 - p.z) - Math.hypot(b.x0 + 120 - p.x, b.z0 + 120 - p.z));
      const out = [];
      for (const c of h1) {       // c's north-east corner, where (i+1, j), (i, j+1), (i+1, j+1) meet it
        if (!['1_0', '0_1', '1_1'].every((d) => { const [di, dj] = d.split('_').map(Number); return lv.present.has((c.i + di) + '_' + (c.j + dj)); })) continue;
        const x = c.x0 + 240, z = c.z0, g = M.surfaceAt(x, z);
        if (g === null || g < 2) continue;
        out.push({ label: 'chunk corner', x: x - 60, z: z + 60, y: g + 60, tx: x, tz: z });
        break;
      }
      let best = null;
      for (const c of h1) {       // an outer side on the highest land
        for (let s = 0; s < 4; s++) {
          const k = M.neighbourKey(c, s);
          if (lv.present.has(k) || lv.sea.has(k)) continue;
          const [x, z] = M.sidePoint(c, s, 120), g = M.surfaceAt(x - [0, 1, 0, -1][s] * 2, z + [1, 0, -1, 0][s] * 2);
          if (g !== null && (!best || g > best.g)) best = { x, z, g, nx: [0, 1, 0, -1][s], nz: [-1, 0, 1, 0][s] };
        }
      }
      if (best) out.push({ label: 'h1/h5 boundary', x: best.x + best.nx * 90, z: best.z + best.nz * 90, y: best.g + 50, tx: best.x, tz: best.z });
      for (let d = 0; d < 1500; d += 5) {      // west from the start to the sea
        const q = M.groundAt(p.x - d, p.z);
        if (q && q.level === 'h1' && q.sea) {
          out.push({ label: 'shore', x: p.x - d + 40, z: p.z + 20, y: 60, tx: p.x - d, tz: p.z });
          break;
        }
      }
      return out;
    });
    assert.equal(poses.length, 3, name + ': three poses: ' + JSON.stringify(poses));
    const results = [];
    for (const tol of [{ tau: 2 }, { tau: 0.05 }, null]) {
      for (const pose of poses) {
        const r = await page.evaluate(async ({ pose, tol }) => {
          const cw = window.__cw, I = cw.internals;
          I.manager.tinForce(tol);
          const yaw = Math.atan2(-(pose.tx - pose.x), -(pose.tz - pose.z));
          cw.camera.set({ mode: 'fly', x: pose.x, z: pose.z, y: pose.y, yaw, pitch: -(I.camera.fov / 2 + 4) * Math.PI / 180 });
          await cw.settle(600000);
          if (cw.sunIdle) await cw.sunIdle();
          return window.__cwMagenta();
        }, { pose, tol });
        results.push(Object.assign({ tier: name, pose: pose.label, tol: JSON.stringify(tol) }, r));
      }
    }
    await page.evaluate(() => { window.__cw.internals.manager.tinForce(null); window.__cw.camera.start(); });
    await settleHere(page);
    const bad = results.filter((r) => r.cracks > 0);
    assert.deepEqual(bad, [], name + ': magenta pixels through the ground');
    assert.ok(results.some((r) => r.water > 1000), name + ': the shore pose sees the sea, so water was told apart from cracks');
  }
});

test('h1 sides facing h5 hang below the h5 edge', { timeout: 120000 }, async (t) => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const r = await page.evaluate(() => {
    const M = window.__cw.internals.manager, lv = M.levels.h1;
    let sides = 0, metres = 0, notKept = 0, differs = 0;
    const above = [];
    for (const c of M.chunks) {
      if (c.level.name !== 'h1' || !c.bottoms) continue;
      for (let s = 0; s < 4; s++) {
        const k = M.neighbourKey(c, s);
        if (lv.present.has(k) || lv.sea.has(k)) continue;
        const floor = M.outerFloor(c, s);
        if (!floor) continue;
        sides++;
        // the floor is kept per side (every h1 job asks for it), and the kept one is what a
        // fresh computation gives
        if (M.outerFloor(c, s) !== floor) notKept++;
        c.floors[s] = null;
        const fresh = M.outerFloor(c, s);
        for (let m = 0; m <= 240; m++) if (fresh[m] !== floor[m]) { differs++; break; }
        for (let m = 0; m <= 240; m++) {
          const b = c.bottoms[s][m];
          if (!Number.isFinite(b)) continue;
          metres++;
          if (b > floor[m] + 1e-4) above.push({ key: c.key, side: s, m, bottom: b, floor: floor[m] });
        }
      }
    }
    return { sides, metres, notKept, differs, above: above.slice(0, 5), n: above.length, remeshes: M.tinStats().levelSeamRemeshes };
  });
  t.diagnostic('levelSeamRemeshes ' + r.remeshes + ', outer sides ' + r.sides + ', metres checked ' + r.metres);
  assert.ok(r.sides > 10 && r.metres > 2000, JSON.stringify(r));
  assert.equal(r.n, 0, 'skirt bottoms above the h5 floor: ' + JSON.stringify(r.above));
  assert.equal(r.notKept, 0, 'each side\'s floor is worked out once and kept: ' + JSON.stringify(r));
  assert.equal(r.differs, 0, 'and the kept floor is what a fresh computation gives: ' + JSON.stringify(r));
});

// The derived floor when h5 arrives after the h1 chunks facing it: those were meshed with the
// fixed 16 m + 3 tau fallback, and an h5 chunk drawn 60 m lower (served 15 s late) must make
// checkLevelSeams re-mesh them to hang below it.
test('h1 sides facing an h5 chunk that arrives late and lower are re-meshed below it', { timeout: READY_MS + 120000 }, async (t) => {
  const manifest = manifestOf();
  const h1 = manifest.levels.find((l) => l.name === 'h1'), h5 = manifest.levels.find((l) => l.name === 'h5');
  const S5 = h5.cell * h5.chunk_samples, { origin_e: oe, origin_n: on } = manifest.crs;
  // the h5 chunk across an outer side of the h1 chunk nearest the start
  let key5 = null, best = Infinity;
  for (const key of Object.keys(h1.chunks)) {
    const [i, j] = key.split('_').map(Number);
    for (const [di, dj] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const k = (i + di) + '_' + (j + dj);
      if (h1.chunks[k] || (h1.sea || []).includes(k)) continue;
      const e = (i + di) * 240 + 120, n = (j + dj) * 240 + 120, d = Math.hypot(e - oe, n - on);
      const k5 = Math.floor(e / S5) + '_' + Math.floor(n / S5);
      if (h5.chunks[k5] && d < best) { best = d; key5 = k5; }
    }
  }
  assert.ok(key5, 'an h5 chunk facing an h1 side');
  const low = reencodeChunk(manifest, 'h5', key5, (dm) => { for (let k = 0; k < dm.length; k++) dm[k] -= 600; });
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    const l = m.levels.find((x) => x.name === 'h5');
    l.chunks[key5] = Object.assign({}, l.chunks[key5], { file: low.file, bytes: low.gz.length, min: low.min, max: low.max });
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  let served = 0;
  await ctx.route('**/out/synthetic/' + low.file, async (route) => {
    await new Promise((r) => setTimeout(r, 15000));
    served = Date.now();
    await route.fulfill({ status: 200, body: low.gz, contentType: 'application/gzip' });
  });
  const { page, log } = await openWorld(ctx);
  const r = await page.evaluate(async (key5) => {
    const cw = window.__cw, M = cw.internals.manager, lv = M.levels.h1;
    await cw.settle(300000);
    const above = [];
    let sides = 0, facing = 0;
    for (const c of M.chunks) {
      if (c.level.name !== 'h1' || !c.bottoms) continue;
      for (let s = 0; s < 4; s++) {
        const k = M.neighbourKey(c, s);
        if (lv.present.has(k) || lv.sea.has(k)) continue;
        const f = M.outerFloor(c, s);
        if (!f) continue;
        sides++;
        if (M.h5Across(c, s) === M.byKey['h5:' + key5]) facing++;
        for (let m = 0; m <= 240; m++) {
          const b = c.bottoms[s][m];
          if (Number.isFinite(b) && b > f[m] + 1e-4) above.push({ key: c.key, side: s, m, bottom: b, floor: f[m] });
        }
      }
    }
    return { remeshes: M.tinStats().levelSeamRemeshes, sides, facing, above: above.slice(0, 3), n: above.length };
  }, key5);
  t.diagnostic('levelSeamRemeshes ' + r.remeshes + ', outer sides ' + r.sides + ', facing the late chunk ' + r.facing);
  assert.ok(served > 0, 'the lowered h5 chunk was served');
  assert.ok(r.facing > 0, 'some h1 sides face it: ' + JSON.stringify(r));
  assert.ok(r.remeshes > 0, 'its arrival re-meshed the h1 chunks facing it: ' + JSON.stringify(r));
  assert.equal(r.n, 0, 'skirt bottoms above the h5 floor: ' + JSON.stringify(r.above));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(glWarnings(log), [], 'GL warnings');
  await page.close();
});

test('the drawn horizon agrees with the world\'s own 1 m horizon', { timeout: READY_MS + 600000 }, async (t) => {
  const facts = JSON.parse(fs.readFileSync(path.join(SYN, 'facts.json'), 'ascii'));
  const gp = facts.sun.garden_point;
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await page.evaluate(({ x, z }) => {
      const g = window.__cw.internals.manager.surfaceAt(x, z);
      window.__cw.camera.set({ mode: 'walk', x, z, y: g + 1.7, yaw: Math.PI, pitch: 0 });
    }, gp);
    await settleHere(page);
    const r = await horizonsAt(page, gp.x, gp.z, 11000);
    assert.equal(r.drawn.length, 720);
    assert.ok(Math.abs(r.cam[0] - gp.x) < 1e-6 && Math.abs(r.cam[2] - gp.z) < 1e-6, name + ': meshed for this eye: ' + JSON.stringify(r.cam));
    assert.deepEqual({ px: r.px, K: r.K, tmin: r.tmin }, r.live, name + ': meshed at the live tolerance settings');
    const near = r.tmin / (r.px * r.K);
    let worst = 0, at = -1, share = 0, atShare = -1, nNear = 0;
    for (let k = 0; k < 720; k++) {
      const d = Math.abs(r.drawn[k] - r.ref[k]), b = horizonBound(r, k);
      if (Math.min(r.distDrawn[k], r.distRef[k]) < near) nNear++;
      if (d > worst) { worst = d; at = k; }
      if (d / b > share) { share = d / b; atShare = k; }
    }
    t.diagnostic(name + ': px K ' + (r.px * r.K * 180 / Math.PI).toFixed(4) + ' deg; largest difference ' + worst.toFixed(5) +
                 ' deg at ray ' + at + ' (highest point ' + r.distDrawn[at] + ' m out); worst share of its bound ' + share.toFixed(3) +
                 ' at ray ' + atShare + '; rays decided nearer than ' + near.toFixed(1) + ' m: ' + nNear);
    assert.ok(share <= 1, name + ': ray ' + atShare + ': drawn ' + r.drawn[atShare] + ', reference ' + r.ref[atShare] +
              ', bound ' + horizonBound(r, atShare) + ' (' + r.distDrawn[atShare] + ' m, ' + r.distRef[atShare] + ' m)');
    await page.evaluate(() => window.__cw.camera.start());
    await settleHere(page);
  }
});

// The drawn horizon against the measured one (SPEC 8.1). The facts' rays run far past the
// world's edge, so only the rays the world itself decides are compared, masked as ST16 masks
// them: where the horizon beyond the world lies more than 0.35 deg below the measured one.
// The tolerance is ST16's 0.35 deg plus the ray's own drawing bound (TT14's), and the march
// runs to the world's farthest corner (from the manifest): a ray the world decides may be
// decided anywhere out to its edge, and the square h20 cover reaches past 11 km toward its
// corners.
test('the drawn horizon agrees with the measured one where the world decides it', { timeout: READY_MS + 600000 }, async (t) => {
  const facts = JSON.parse(fs.readFileSync(path.join(SYN, 'facts.json'), 'ascii'));
  const gp = facts.sun.garden_point, measured = facts.sun.horizon.profile_deg;
  const beyond = facts.sun.horizon.beyond_world.profile_deg;
  const maxM = Math.ceil(farCorner(manifestOf(), gp.x, gp.z));
  assert.equal(measured.length, 720);
  assert.equal(beyond.length, 720);
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await page.evaluate(({ x, z }) => {
      const g = window.__cw.internals.manager.surfaceAt(x, z);
      window.__cw.camera.set({ mode: 'walk', x, z, y: g + 1.7, yaw: Math.PI, pitch: 0 });
    }, gp);
    await settleHere(page);
    const r = await horizonsAt(page, gp.x, gp.z, maxM, 1.5);
    let n = 0, worst = 0, at = -1, excess = -Infinity, atExcess = -1;
    for (let k = 0; k < 720; k++) {
      if (!(beyond[k] < measured[k] - 0.35)) continue;
      n++;
      const d = Math.abs(r.drawn[k] - measured[k]), over = d - (0.35 + horizonBound(r, k));
      if (d > worst) { worst = d; at = k; }
      if (over > excess) { excess = over; atExcess = k; }
    }
    t.diagnostic(name + ': marched to ' + maxM + ' m; ' + n + ' rays the world decides; largest difference ' + worst.toFixed(3) +
                 ' deg at ' + at * 0.5 + ' deg true; closest to its tolerance by ' + (-excess).toFixed(3) + ' deg');
    assert.ok(n > 100, name + ': ' + n + ' rays the world decides');
    assert.ok(excess <= 0, name + ': ray ' + atExcess * 0.5 + ' deg: drawn ' + r.drawn[atExcess] + ', measured ' + measured[atExcess] +
              ', tolerance ' + (0.35 + horizonBound(r, atExcess)));
    await page.evaluate(() => window.__cw.camera.start());
    await settleHere(page);
  }
});

test('installs are throttled', { timeout: READY_MS + 300000 }, async () => {
  const budget = { laptop: [8, 400000], phone: [4, 150000] };
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await page.evaluate(() => {
      const p = window.__cw.camera.pose();
      window.__cw.camera.set({ mode: 'fly', x: p.x + 3000, z: p.z, y: 400, pitch: -0.2 });
    });
    await settleHere(page);
    await page.evaluate(() => window.__cw.camera.start());
    await page.evaluate(() => window.__cw.settle(300000));
    await settleHere(page);
    const s = await page.evaluate(() => window.__cw.internals.manager.tinStats());
    assert.ok(s.maxInstallsPerFrame > 0 && s.maxInstallsPerFrame <= budget[name][0], name + ': ' + JSON.stringify(s));
    assert.ok(s.maxInstallTrisPerFrame <= budget[name][1], name + ': ' + JSON.stringify(s));
  }
});

test('terrain frees its GPU memory', { timeout: READY_MS + 60000 }, async () => {
  const ctx = await newContext();
  const { page, log } = await openWorld(ctx);
  const r = await page.evaluate(async () => {
    const M = window.__cw.internals.manager, { sharedTextures } = await import('/world/js/terrainmat.js');
    await window.__cw.settle(300000);
    // a 'dispose' listener on every chunk geometry of every level, every h1 material, both
    // textures of every h1 chunk, and the shared noise and plot textures
    const fired = new Map(), kinds = { geometry: 0, material: 0, texture: 0, shared: 0 };
    const listen = (o, kind) => {
      if (!o || fired.has(o)) return;
      kinds[kind]++;
      fired.set(o, 0);
      o.addEventListener('dispose', () => fired.set(o, fired.get(o) + 1));
    };
    for (const c of M.chunks) {
      if (c.mesh) listen(c.mesh.geometry, 'geometry');
      if (c.material) listen(c.material, 'material');
      if (c.tex) { listen(c.tex.classTex, 'texture'); listen(c.tex.normalTex, 'texture'); }
    }
    for (const tx of sharedTextures()) listen(tx, 'shared');
    const before = M.terrainInfo();
    M.dispose();
    const counts = [...fired.values()];
    return { kinds, before, after: M.terrainInfo(), shared: sharedTextures().length, once: counts.filter((n) => n === 1).length,
             other: counts.filter((n) => n !== 1).length, total: counts.length };
  });
  assert.ok(r.kinds.geometry > 100 && r.before.textures > 0 && r.before.materials > 0, JSON.stringify(r));
  assert.equal(r.kinds.material, r.before.materials, 'a listener on every h1 material: ' + JSON.stringify(r));
  assert.equal(r.kinds.texture + r.kinds.shared, r.before.textures, 'and on every terrain texture: ' + JSON.stringify(r));
  assert.equal(r.kinds.shared, 2, 'the noise and the plot outline: ' + JSON.stringify(r));
  assert.equal(r.once, r.total, 'every geometry, material and texture was disposed exactly once: ' + JSON.stringify(r));
  assert.equal(r.other, 0);
  assert.equal(r.after.textures, 0);
  assert.equal(r.after.materials, 0);
  assert.equal(r.shared, 0, 'no shared texture is left');
  assert.deepEqual(log.errors, []);
  assert.deepEqual(glWarnings(log), [], 'GL warnings');
  await page.close();
});

test('trees follow a coarse re-mesh', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  const cam = await page.evaluate(() => { window.__cw.camera.start(); return window.__cw.camera.get(); });
  await page.evaluate(({ x, z }) => {
    window.__cw.camera.set({ x, z, y: 1500, mode: 'fly' });
    window.__cw.internals.manager.tinForce({ tau: 2 });
  }, cam);
  await settleHere(page);
  const r = await page.evaluate(() => {
    const { trees, manager: M, camera } = window.__cw.internals;
    const m = camera.matrix.clone();
    let n = 0, off = 0, worst = 0, coarse = 0;
    for (const g of trees.groups) for (const mesh of g.meshes) for (let k = 0; k < mesh.count; k++) {
      mesh.getMatrixAt(k, m);
      const e = m.elements, q = M.groundAt(e[12], e[14]);
      if (!q || q.level !== 'h1') continue;
      n++;
      const d = Math.abs(e[13] - q.y);
      if (d > 1e-3) { off++; worst = Math.max(worst, d); }
      if (Math.abs(q.y - M.refSurfaceAt(e[12], e[14])) > 0.2) coarse++;
    }
    return { n, off, worst, coarse };
  });
  await page.evaluate(() => { window.__cw.internals.manager.tinForce(null); window.__cw.camera.start(); });
  await settleHere(page);
  assert.ok(r.n > 100, 'trees were checked: ' + JSON.stringify(r));
  assert.equal(r.off, 0, 'every tree stands on the drawn surface: ' + JSON.stringify(r));
  assert.ok(r.coarse > 0, 'some trees stand off their 1 m corner surface, so this checks something: ' + JSON.stringify(r));
});

test('the slope limit refuses steep ground, and roofs keep the step', { timeout: READY_MS + 120000 }, async () => {
  const { page: main } = await mainPage();
  const unit = await main.evaluate(async () => {
    const { stepAllowed } = await import('/world/js/controls.js');
    const t = (deg) => Math.tan(deg * Math.PI / 180), out = {};
    for (const h of [0.1, 1]) for (const deg of [40, 49, 51, 55]) out['h1 ' + deg + ' deg over ' + h + ' m'] = stepAllowed(t(deg) * h, h, 'h1');
    out['roof 1.0 m over 5 m'] = stepAllowed(1.0, 5, 'building');
    out['roof 1.2 m over 5 m'] = stepAllowed(1.2, 5, 'building');
    return out;
  });
  for (const [k, v] of Object.entries(unit)) {
    const want = / (40|49) deg/.test(k) || k.startsWith('roof 1.0');
    assert.equal(v, want, k);
  }
  // Two planar ramps in one h1 chunk away from the buildings and the plot, rising eastward at 40
  // and 55 degrees from flat ground. A ramp's foot is carved half a metre's rise deep in one
  // sample column, so the drawn corner surface (the mean of four samples) starts at the full
  // slope instead of easing into it.
  const manifest = manifestOf();
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const { origin_e: oe, origin_n: on } = manifest.crs;
  const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SYN, manifest.files.buildings.file))).toString('utf8'));
  const plot = JSON.parse(fs.readFileSync(path.join(SYN, 'plot.json'), 'ascii'));
  const shapes = doc.features.map((f) => f.ring).concat(plot.parcels.map((p) => p.ring));
  const i0 = Math.floor(oe / 240), j0 = Math.floor(on / 240);
  let key = null;
  for (const [di, dj] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const k = (i0 + di) + '_' + (j0 + dj), e = h1.chunks[k];
    if (!e || e.min < 5) continue;
    const x0 = (i0 + di) * 240 - oe, z0 = -((j0 + dj + 1) * 240 - on);
    const clear = shapes.every((r) => r.every(([x, z]) => x < x0 + 40 || x > x0 + 200 || z < z0 + 40 || z > z0 + 200));
    if (clear) { key = k; break; }
  }
  assert.ok(key, 'an h1 chunk near the start with no building or plot in its middle');
  const H0 = Math.round((h1.chunks[key].max + 2) * 10);        // flat ground above the chunk's highest
  const XS = 100;                                              // the ramps start at corner x = 100
  const ramps = [[40, 60], [55, 160]];                         // degrees, first row (12 rows wide)
  const edited = reencodeChunk(manifest, 'h1', key, (dm, W) => {
    for (let r = 50; r <= 185; r++) for (let q = 50; q <= 131; q++) dm[r * W + q] = H0;
    for (const [deg, r0] of ramps) {
      const t = Math.tan(deg * Math.PI / 180);
      for (let r = r0; r < r0 + 12; r++) {
        // sample column q is centred at local x = q - 0.5
        dm[r * W + XS] = Math.round(H0 - 5 * t);                           // the carved foot
        for (let q = XS + 1; q <= 130; q++) dm[r * W + q] = Math.round(H0 + 10 * t * (q - 0.5 - XS));
      }
    }
  });
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const m = await res.json();
    const l = m.levels.find((x) => x.name === 'h1');
    l.chunks[key] = Object.assign({}, l.chunks[key], { file: edited.file, bytes: edited.gz.length, min: edited.min, max: edited.max });
    await route.fulfill({ response: res, body: JSON.stringify(m), headers: { 'content-type': 'application/json' } });
  });
  await ctx.route('**/out/synthetic/' + edited.file, (route) => route.fulfill({ status: 200, body: edited.gz, contentType: 'application/gzip' }));
  const { page, log } = await openWorld(ctx);
  const rises = {};
  for (const [deg, r0] of ramps) {
    // stand on the flat 4 m before the foot, facing east (up the ramp), and hold W for 2 s
    // at 60 frames a second, through the page's own walking code
    const r = await page.evaluate(async ({ key, r0, XS }) => {
      const cw = window.__cw, I = cw.internals, M = I.manager, c = M.byKey['h1:' + key];
      const x = c.x0 + XS - 4, z = c.z0 + r0 + 6;
      cw.camera.set({ mode: 'walk', x, z, y: M.surfaceAt(x, z) + 1.7, yaw: -Math.PI / 2, pitch: 0 });
      await cw.settle(300000);
      const C = I.controls;
      for (let k = 0; k < 60 && !C.onGround; k++) C.update(1 / 60);
      const start = C.feet.y;
      C.keys.add('KeyW');
      for (let k = 0; k < 120; k++) C.update(1 / 60);
      C.keys.delete('KeyW');
      const walked = { start, end: C.feet.y, moved: C.feet.x - x, onGround: C.onGround };
      // the same for 4 s with Space pressed again on every landing: a jump must not carry the
      // walker up ground too steep to walk (the rise is measured from the ground, not the feet)
      cw.camera.set({ mode: 'walk', x, z, y: M.surfaceAt(x, z) + 1.7, yaw: -Math.PI / 2, pitch: 0 });
      for (let k = 0; k < 60 && !C.onGround; k++) C.update(1 / 60);
      const start2 = C.feet.y;
      let jumps = 0;
      C.keys.add('KeyW');
      for (let k = 0; k < 240; k++) {
        if (C.onGround) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ' }));
          if (C.vy > 0) jumps++;
        }
        C.update(1 / 60);
      }
      C.keys.delete('KeyW');
      for (let k = 0; k < 120 && !C.onGround; k++) C.update(1 / 60);
      const jumped = { start: start2, end: C.feet.y, moved: C.feet.x - x, onGround: C.onGround, jumps };
      return { walked, jumped };
    }, { key, r0, XS });
    rises[deg] = r;
  }
  const up = (r) => r.end - r.start;
  assert.ok(up(rises[40].walked) > 1, 'up the 40 degree ramp: ' + JSON.stringify(rises[40]));
  assert.ok(up(rises[55].walked) < 0.3, 'not up the 55 degree ramp: ' + JSON.stringify(rises[55]));
  assert.ok(rises[55].jumped.jumps >= 4 && rises[55].jumped.onGround, 'the walker jumped and landed: ' + JSON.stringify(rises[55]));
  assert.ok(up(rises[55].jumped) < 0.3, 'nor up it by jumping: ' + JSON.stringify(rises[55]));
  assert.ok(up(rises[40].jumped) > 1, 'jumping up the 40 degree ramp still climbs it: ' + JSON.stringify(rises[40]));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(glWarnings(log), [], 'GL warnings');
  assert.deepEqual(log.console, []);
  await page.close();
});

test('the held-triangle cap raises px, and lets it back down', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const r = await page.evaluate(async () => {
    const cw = window.__cw, I = cw.internals, M = I.manager, cap = M.tin.heldCap;
    const idle = async () => {
      const t0 = performance.now();
      while (M.queue.length + M.inflight > 0 && performance.now() - t0 < 120000) await new Promise((res) => setTimeout(res, 50));
    };
    const held0 = M.heldTriangles(), px0 = M.px();
    // a cap under what is held: px rises x1.25 (at most once a second), every h1 chunk
    // re-meshes, and fewer triangles are held
    M.tin.heldCap = Math.round(0.8 * held0);
    try {
      const t0 = performance.now();
      while (performance.now() - t0 < 30000 && M.pxScale < 1.25 * 1.25 - 1e-9 && M.heldTriangles() > M.tin.heldCap) {
        M.update(I.camera.position);
        await idle();
        await new Promise((res) => setTimeout(res, 250));
      }
      M.update(I.camera.position);
      await idle();
      const raised = { pxScale: M.pxScale, px: M.px(), held: M.heldTriangles(), cap: M.tin.heldCap };
      // the profile's cap again, far above what is held: after 5 s under half of it, px steps back
      M.tin.heldCap = cap;
      const t1 = performance.now();
      while (performance.now() - t1 < 15000 && M.pxScale >= raised.pxScale) {
        M.update(I.camera.position);
        await new Promise((res) => setTimeout(res, 250));
      }
      return { held0, px0, raised, relaxed: { pxScale: M.pxScale, afterMs: Math.round(performance.now() - t1) } };
    } finally {
      M.tin.heldCap = cap;
      M.pxScale = 1;
      M.underHalfSince = null;
      M.tinForce(null);          // every h1 chunk stale again, for the settle below
    }
  });
  await settleHere(page);
  assert.ok(r.raised.pxScale > 1 && r.raised.px > r.px0, 'px rose over the cap: ' + JSON.stringify(r));
  assert.ok(r.raised.held < r.held0, 'and fewer triangles are held: ' + JSON.stringify(r));
  assert.ok(r.relaxed.pxScale < r.raised.pxScale && r.relaxed.afterMs >= 5000, 'px stepped back under half the cap: ' + JSON.stringify(r));
});

test('installs go on while the tab is hidden', { timeout: 240000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(() => window.__cw.camera.start());
  await settleHere(page);
  const r = await page.evaluate(async () => {
    const cw = window.__cw, I = cw.internals, M = I.manager, raf = window.requestAnimationFrame;
    // a hidden tab: document.hidden, and no animation frames at all
    window.requestAnimationFrame = () => 0;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    try {
      const h1 = M.chunks.filter((c) => c.level.name === 'h1' && c.status === 'ready');
      const seq0 = h1.map((c) => c.installedSeq);
      const p = I.camera.position.clone();
      p.y += 40;
      M.forceSnapshots(p);         // a re-mesh of every h1 chunk, for a camera 40 m up
      const t0 = performance.now();
      while (M.queue.length + M.inflight > 0 && performance.now() - t0 < 120000) await new Promise((res) => setTimeout(res, 50));
      return { chunks: h1.length, installed: h1.filter((c, k) => c.installedSeq > seq0[k]).length, left: M.queue.length + M.inflight,
               pending: M.pendingInstalls.length };
    } finally {
      delete document.hidden;
      delete document.visibilityState;
      window.requestAnimationFrame = raf;
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await settleHere(page);
  assert.equal(r.left, 0, 'every job was installed with no animation frame: ' + JSON.stringify(r));
  assert.equal(r.installed, r.chunks, 'every h1 chunk has its new mesh: ' + JSON.stringify(r));
});

// A load job keeps the tolerance settings it was sent with. When they change while it is
// out (here a resize through setView; the heldCap net and tinForce take the same path), the
// chunk is not yet 'ready' for _markStale to reach, and a camera that stays put never makes
// it stale: it must be re-meshed for the new settings when it arrives. Checked without
// settle(), whose forceSnapshots would hide the difference.
test('a chunk still loading when the view changes is meshed again for the new view', { timeout: READY_MS + 120000 }, async () => {
  const manifest = manifestOf();
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const { origin_e: oe, origin_n: on } = manifest.crs;
  // the three h1 chunks farthest from the origin, which load last anyway
  const held = Object.keys(h1.chunks).map((key) => {
    const [i, j] = key.split('_').map(Number);
    return { key, d: Math.hypot(i * 240 + 120 - oe, j * 240 + 120 - on) };
  }).sort((a, b) => b.d - a.d).slice(0, 3).map((x) => x.key);
  const ctx = await newContext();
  let release = null;
  const gate = new Promise((res) => { release = res; });
  for (const key of held) {
    const file = h1.chunks[key].file;
    await ctx.route('**/out/synthetic/' + file, async (route) => {
      await gate;
      await route.fulfill({ status: 200, body: fs.readFileSync(path.join(SYN, file)), contentType: 'application/gzip' });
    });
  }
  const page = await ctx.newPage();
  const log = watch(page);
  try {
    await page.goto(origin() + '/world/?w=out/synthetic/');
    // everything else in, the three held chunks' load jobs out
    await page.waitForFunction((held) => {
      const M = window.__cw && window.__cw.internals && window.__cw.internals.manager;
      if (!M || M.queue.length || M.pendingInstalls.length) return false;
      return M.chunks.every((c) => (c.level.name === 'h1' && held.includes(c.key) ? c.status === 'loading' && c.busy : c.status === 'ready'));
    }, held, { timeout: READY_MS, polling: 250 });
    const before = await page.evaluate((held) => {
      const I = window.__cw.internals, M = I.manager, K0 = M.K;
      M.setView(62, 360);                    // K roughly doubles: every chunk goes stale
      M.update(I.camera.position);           // as the next frame would
      return { K0, K1: M.K, sent: held.map((k) => M.byKey['h1:' + k].busyTol.K) };
    }, held);
    release();
    const r = await page.evaluate(async (held) => {
      const cw = window.__cw, I = cw.internals, M = I.manager, t0 = performance.now();
      const idle = () => M.queue.length + M.inflight === 0 && !M.pendingInstalls.length;
      while (!(cw.ready && idle()) && performance.now() - t0 < 120000) {
        M.update(I.camera.position);
        await new Promise((res) => setTimeout(res, 100));
      }
      await cw.frame();
      while (!idle() && performance.now() - t0 < 120000) await new Promise((res) => setTimeout(res, 100));
      const wrong = M.chunks.filter((c) => c.level.name === 'h1' && c.tolInfo && (c.tolInfo.K !== M.K || c.tolInfo.px !== M.px()))
        .map((c) => ({ key: c.key, K: c.tolInfo.K, px: c.tolInfo.px, held: held.includes(c.key) }));
      return { ready: cw.ready, idle: idle(), K: M.K, px: M.px(), wrong };
    }, held);
    const at = JSON.stringify({ held, before, r });
    assert.ok(before.K1 > 1.5 * before.K0, 'the view changed: ' + at);
    assert.deepEqual(before.sent, [before.K0, before.K0, before.K0], 'the held chunks were sent for the old view: ' + at);
    assert.ok(r.ready && r.idle, 'the world finished loading: ' + at);
    assert.deepEqual(r.wrong, [], 'every h1 chunk is meshed for the new view: ' + at);
    assert.deepEqual(log.errors, []);
    assert.deepEqual(glWarnings(log), [], 'GL warnings');
    assert.deepEqual(log.console, []);
  } finally {
    release();
    await page.close();
  }
});

test('the ground\'s noise is read at its own footprint across class borders, on both tiers', { timeout: READY_MS + 240000 }, async () => {
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    // Close up and straight down over a border of the road (whose noise is finer than its
    // neighbours'), the noise's mips above level 1 are replaced by white: a pixel that reads
    // a coarse mip then shows it. Rendered against the same noise mid-grey at every level,
    // nothing may differ. (A class's own noise frequency changes across the border; reading
    // the mip from that jump, not from the footprint, drew a line of flat colour.)
    const r = await page.evaluate(async () => {
      const cw = window.__cw, I = cw.internals, M = I.manager;
      const { SHARED } = await import('/world/js/terrainmat.js');
      let x = 110 - 0.5, z = -500 - 0.5;
      const road = M.materialAt(x, z).cls;
      while (M.materialAt(x + 0.25, z).cls === road && x < 160) x += 0.25;
      const other = M.materialAt(x + 0.25, z).cls;
      const g = M.surfaceAt(x, z);
      cw.camera.set({ mode: 'fly', x, z, y: g + 1.5, yaw: 0, pitch: -Math.PI / 2 + 0.001 });
      await cw.settle(300000);
      if (cw.sunIdle) await cw.sunIdle();
      const hide = [I.buildings && I.buildings.group, I.trees && I.trees.group, I.fence && I.fence.mesh].filter(Boolean);
      const was = hide.map((o) => o.visible);
      const own = SHARED.cwTNoise.value;
      const noise = (coarse) => {      // the same kind of texture as the page's own noise
        const levels = [];
        for (let w = 256, k = 0; w >= 1; w >>= 1, k++) {
          levels.push({ data: new Uint8Array(w * w * 4).fill(k >= 2 ? coarse : 128), width: w, height: w });
        }
        const t = new own.constructor(levels[0].data, 256, 256, own.format, own.type);
        t.mipmaps = levels;
        t.generateMipmaps = false;
        t.wrapS = own.wrapS; t.wrapT = own.wrapT;
        t.minFilter = own.minFilter;
        t.magFilter = own.magFilter;
        t.colorSpace = own.colorSpace;
        t.needsUpdate = true;
        return t;
      };
      const grey = noise(128), marked = noise(255);
      const gl = I.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const shot = (t) => {
        SHARED.cwTNoise.value = t;
        I.renderer.render(I.scene, I.camera);
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      hide.forEach((o) => { o.visible = false; });
      let a, b;
      try {
        a = shot(grey);
        b = shot(marked);
      } finally {
        SHARED.cwTNoise.value = own;
        hide.forEach((o, k) => { o.visible = was[k]; });
        grey.dispose();
        marked.dispose();
      }
      let differ = 0;
      for (let k = 0; k < w * h; k++) {
        if (Math.max(Math.abs(a[k * 4] - b[k * 4]), Math.abs(a[k * 4 + 1] - b[k * 4 + 1]), Math.abs(a[k * 4 + 2] - b[k * 4 + 2])) > 6) differ++;
      }
      // both classes in view
      const seen = new Set();
      for (let q = -1; q <= 1; q += 0.25) seen.add(M.materialAt(x + q, z).cls);
      cw.camera.start();
      await cw.settle(300000);
      return { road, other, border: x, differ, pixels: w * h, seen: [...seen] };
    });
    assert.equal(r.road, 7, name + ': the road point is road: ' + JSON.stringify(r));
    assert.ok(r.other !== 7 && r.seen.length >= 2, name + ': a border in view: ' + JSON.stringify(r));
    assert.equal(r.differ, 0, name + ': pixels that read a noise mip coarser than their footprint: ' + JSON.stringify(r));
  }
});

// The phone tier's two-class border blend (visible choice 10.2 #9): the second class, as a
// flat colour, meets the first at 50 % on a texel border and fades out a quarter metre inside,
// with no crease where the border turns a corner. A 1 m chunk whose class band holds a 45 deg
// staircase of road in open land is loaded by the page's own worker (a data: URL, so the edge
// bits come from worker.js) and drawn by the phone shader, 0.02 m a pixel, straight down, with
// the noise flat and ambient light only. Each pixel's colour is placed on the line from open
// land to road (t); t must change smoothly (no step between neighbouring pixels larger than
// the fade itself allows), be 0 or 1 more than 0.3 m from the other class, and be blended
// within 0.1 m of it. The blend it replaced, which fetched across the nearest texel border
// whatever class lay there, left saw-tooth creases at every step.
test('the phone\'s class borders are blended without creases', { timeout: READY_MS + 120000 }, async (t) => {
  const man = manifestOf();
  const h1 = man.levels.find((l) => l.name === 'h1');
  const key = Object.keys(h1.chunks)[0];
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(SYN, h1.chunks[key].file)));
  const W = raw.readUInt16LE(6), n = W * raw.readUInt16LE(8);
  assert.ok(raw.readUInt8(5) & 4, 'the chunk carries a class band');
  const off = 32 + 2 * n, STEP = 40;          // texel (q, r) is road when q >= r + STEP
  for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) raw.writeUInt8(q >= r + STEP ? 7 : 0, off + r * W + q);
  const url = 'data:application/octet-stream;base64,' + zlib.gzipSync(raw).toString('base64');
  const { page } = await mainPage();
  const r = await page.evaluate(async ({ url, STEP }) => {
    const M = window.__cw.internals.manager;
    const THREE = await import('three');
    const { patchTerrain } = await import('/world/js/terrainmat.js');
    const { classTexture } = await import('/world/js/chunks.js');
    const res = await M._post({ type: 'load', url, mode: 'tin', opts: { tau: 1, errors: 'exact', edges: true } }, false);
    const classTex = classTexture([res.tex.class0].concat(res.tex.classMips));
    const flat = (w, bytes, format) => {
      const tx = new THREE.DataTexture(new Uint8Array(w * w * bytes).fill(128), w, w, format, THREE.UnsignedByteType);
      tx.generateMipmaps = false; tx.minFilter = tx.magFilter = THREE.NearestFilter;
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.unpackAlignment = 1; tx.needsUpdate = true;
      return tx;
    };
    const normalTex = flat(241, 2, THREE.RGFormat), noise = flat(16, 4, THREE.RGBAFormat);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    mat.toneMapped = false;
    mat.onBeforeCompile = (sh) => patchTerrain(sh, { cwTClass: { value: classTex }, cwTNormal: { value: normalTex },
                                                     cwTNoise: { value: noise } }, 'phone');
    mat.customProgramCacheKey = () => 'cwT-crease-test';
    // chunk-local metres x0..x0+S, z0..z0+S, on a flat quad at y = 0 (position.xz is the cell)
    const x0 = 96, z0 = 56, S = 8, N = 400;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, 0, z0, x0, 0, z0 + S, x0 + S, 0, z0 + S, x0 + S, 0, z0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(g, mat));
    scene.add(new THREE.AmbientLight(0xffffff, Math.PI));
    const cam = new THREE.OrthographicCamera(-S / 2, S / 2, S / 2, -S / 2, 1, 100);
    cam.position.set(x0 + S / 2, 50, z0 + S / 2);
    cam.up.set(0, 0, -1);                          // screen up is -z, screen right is +x
    cam.lookAt(x0 + S / 2, 0, z0 + S / 2);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    const rr = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
    rr.setPixelRatio(1);
    rr.setSize(N, N, false);
    rr.render(scene, cam);
    const gl = rr.getContext(), px = new Uint8Array(N * N * 4);
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const glError = gl.getError();
    rr.dispose(); g.dispose(); mat.dispose(); classTex.dispose(); normalTex.dispose(); noise.dispose();
    // pixel (i, j), j counted from the bottom row, is the point below
    const at = (i, j) => [x0 + (i + 0.5) * S / N, z0 + S - (j + 0.5) * S / N];
    const cls = (x, z) => (Math.floor(x) + 1 >= Math.floor(z) + 1 + STEP ? 7 : 0);
    const col = (i, j) => [px[(j * N + i) * 4], px[(j * N + i) * 4 + 1], px[(j * N + i) * 4 + 2]];
    // the metres from (x, z) to the nearest texel of the other class
    const other = (x, z) => {
      const c = cls(x, z), q = Math.floor(x), rw = Math.floor(z);
      let best = Infinity;
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
        if (cls(q + b + 0.5, rw + a + 0.5) === c) continue;
        const dx = Math.max(q + b - x, 0, x - (q + b + 1)), dz = Math.max(rw + a - z, 0, z - (rw + a + 1));
        best = Math.min(best, Math.hypot(dx, dz));
      }
      return best;
    };
    // the two pure colours, as the mean over pixels a metre or more from the border
    const sum = { 0: [0, 0, 0, 0], 7: [0, 0, 0, 0] };
    for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) {
      const [x, z] = at(i, j);
      if (other(x, z) < 1) continue;
      const c = col(i, j), s = sum[cls(x, z)];
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++;
    }
    const A = sum[0].slice(0, 3).map((v) => v / sum[0][3]), B = sum[7].slice(0, 3).map((v) => v / sum[7][3]);
    const AB = B.map((v, k) => v - A[k]), L2 = AB.reduce((a, v) => a + v * v, 0);
    const T = new Float32Array(N * N);
    let offLine = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const c = col(i, j), d = c.map((v, k) => v - A[k]);
      const tt = d.reduce((a, v, k) => a + v * AB[k], 0) / L2;
      T[j * N + i] = tt;
      offLine = Math.max(offLine, Math.hypot(...d.map((v, k) => v - tt * AB[k])));
    }
    let step = 0, stepAt = null, notPure = 0, notBlended = 0, firstBad = null;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const tt = T[j * N + i];
      if (i + 1 < N && Math.abs(T[j * N + i + 1] - tt) > step) { step = Math.abs(T[j * N + i + 1] - tt); stepAt = at(i, j); }
      if (j + 1 < N && Math.abs(T[(j + 1) * N + i] - tt) > step) { step = Math.abs(T[(j + 1) * N + i] - tt); stepAt = at(i, j); }
      const [x, z] = at(i, j), d = other(x, z), own = cls(x, z) === 7 ? 1 : 0;
      if (d > 0.3 && Math.abs(tt - own) > 0.05) { notPure++; firstBad = firstBad || { x, z, d, t: tt }; }
      if (d < 0.1 && (tt < 0.2 || tt > 0.8)) { notBlended++; firstBad = firstBad || { x, z, d, t: tt }; }
    }
    return { A, B, contrast: Math.sqrt(L2), offLine, step, stepAt, notPure, notBlended, firstBad, glError, edges: !!res.tex.class0 };
  }, { url, STEP });
  t.diagnostic('open land ' + r.A.map((v) => v.toFixed(0)) + ', road ' + r.B.map((v) => v.toFixed(0)) +
               '; largest step between neighbouring pixels ' + r.step.toFixed(3) + ' of the way; off the line ' + r.offLine.toFixed(1));
  assert.equal(r.glError, 0);
  assert.ok(r.edges, 'the load job returned level 0 with edge bits');
  assert.ok(r.contrast > 40, 'the two classes differ on screen: ' + JSON.stringify(r));
  assert.ok(r.offLine < 12, 'every pixel is a mix of the two colours (flat noise): ' + JSON.stringify(r));
  assert.equal(r.notPure, 0, 'pixels blended more than 0.3 m from the other class: ' + JSON.stringify(r));
  assert.equal(r.notBlended, 0, 'pixels within 0.1 m of the other class left unblended: ' + JSON.stringify(r));
  assert.ok(r.step < 0.15, 'a crease: neighbouring pixels differ by ' + r.step.toFixed(3) + ' of the way at ' + JSON.stringify(r.stepAt));
});

// What the page itself installs for that blend (the crease test above posts its own job and
// builds its own texture, so it cannot see this). On the phone every installed h1 chunk's class
// texture must carry, on every mip level, the class in the low nibble and in the high nibble
// which edge neighbours hold another class (worker.js classEdges; the reference here is the
// test's own): level 0 over the decoded class band, the levels below over the plain majority
// mips, which a load job without edge bits returns for comparison. On the laptop the texture
// is the class band as decoded, with no high bits on any level.
test('the page installs the phone\'s class edge bits on every level, and none on the laptop', { timeout: READY_MS + 180000 }, async (t) => {
  for (const [name, get] of [['laptop', mainPage], ['phone', phonePage]]) {
    const { page } = await get();
    await settleHere(page);
    const r = await page.evaluate(async (name) => {
      const M = window.__cw.internals.manager;
      const edges = (a, w) => {       // bit 4 column - 1, 5 column + 1, 6 row - 1, 7 row + 1
        const out = new Uint8Array(w * w);
        for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
          const t = y * w + x, c = a[t] & 15;
          out[t] = c | (x > 0 && (a[t - 1] & 15) !== c ? 16 : 0) | (x < w - 1 && (a[t + 1] & 15) !== c ? 32 : 0) |
                   (y > 0 && (a[t - w] & 15) !== c ? 64 : 0) | (y < w - 1 && (a[t + w] & 15) !== c ? 128 : 0);
        }
        return out;
      };
      const firstDiff = (a, b) => { for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) return { k, got: a[k], want: b[k] }; return null; };
      const out = { tier: M.tin.tier, chunks: 0, bordered: 0, highBits: [0, 0], bad: [], compared: 0 };
      const h1 = M.chunks.filter((c) => c.level.name === 'h1' && c.tex && c.data && c.data.classes);
      for (const c of h1) {
        const mm = c.tex.classTex.mipmaps, cls = c.data.classes, W = mm[0].width;
        out.chunks++;
        if (cls.some((v) => v !== cls[0])) out.bordered++;
        if (mm[0].data.length !== cls.length) { out.bad.push({ key: c.key, level: 0, length: mm[0].data.length }); continue; }
        for (let k = 0; k < mm.length; k++) {
          const d = mm[k].data, w = mm[k].width;
          let high = 0;
          for (let i = 0; i < d.length; i++) if (d[i] > 15) high++;
          if (k < 2 && high) out.highBits[k]++;
          const low = d.map((v) => v & 15);
          // level 0's class is the decoded band's; every level's high nibble is its own edges
          const want = name === 'phone' ? edges(low, w) : low;
          const diff = (k === 0 ? firstDiff(low, cls) : null) || firstDiff(d, want);
          if (diff) { out.bad.push({ key: c.key, level: k, w, ...diff }); break; }
        }
        if (W !== 242) out.bad.push({ key: c.key, width: W });
      }
      // the levels below 0 are the plain majority mips: compare two bordered chunks with a job
      // that returns them without edge bits
      for (const c of h1.filter((c) => c.data.classes.some((v) => v !== c.data.classes[0])).slice(0, 2)) {
        const res = await M._post({ type: 'load', url: c.url, mode: 'tin', opts: { tau: 1, errors: 'exact', edges: false } }, false);
        const mm = c.tex.classTex.mipmaps;
        if (res.tex.class0 || res.tex.classMips.length !== mm.length - 1) { out.bad.push({ key: c.key, plain: res.tex.classMips.length, class0: !!res.tex.class0 }); continue; }
        res.tex.classMips.forEach((plain, k) => {
          const diff = firstDiff(mm[k + 1].data.map((v) => v & 15), plain);
          if (diff) out.bad.push({ key: c.key, level: k + 1, plain: true, ...diff });
        });
        out.compared++;
      }
      return out;
    }, name);
    t.diagnostic(name + ': ' + r.chunks + ' h1 chunks, ' + r.bordered + ' with a class border; edge bits on level 0 in ' +
                 r.highBits[0] + ', on level 1 in ' + r.highBits[1]);
    assert.equal(r.tier, name, 'the page is on the ' + name + ' tier');
    assert.ok(r.chunks > 0 && r.bordered > 0, name + ': installed h1 chunks with a class border: ' + JSON.stringify(r));
    assert.deepEqual(r.bad, [], name + ': class texture levels that are not as the tier draws them');
    assert.equal(r.compared, 2, name + ': two bordered chunks compared with the plain majority mips');
    if (name === 'phone') {
      assert.equal(r.highBits[0], r.bordered, 'phone: every bordered chunk has edge bits on level 0: ' + JSON.stringify(r));
      assert.ok(r.highBits[1] > 0, 'phone: level 1 carries edge bits: ' + JSON.stringify(r));
    } else {
      assert.deepEqual(r.highBits, [0, 0], 'laptop: no edge bits');
    }
  }
});

test('no request ever left localhost', () => {
  assert.deepEqual(offenders, []);
});
