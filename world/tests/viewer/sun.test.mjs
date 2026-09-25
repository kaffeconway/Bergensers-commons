// Commons World viewer tests: the sun, the terrain shade, the near shadow map and the
// date/time slider (SPEC section 6.3, ST1-ST23).
//
//   CW_PYTHON=<python with numpy, pandas and pvlib> node --test --test-concurrency=1 world/tests/viewer/sun.test.mjs
//
// The Node-only tests import world/js/sun.js directly. The browser tests use the synthetic
// world (world/out/synthetic) and compare with its own facts.json, never the fixture, except
// where a test routes one in on purpose. Nothing here describes a real place: the places in
// ST1 are round numbers, and every other figure is the synthetic world's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERE, SYN, PYTHON, READY_MS, offenders, origin, newContext, openWorld, mainPage } from './harness.mjs';

const SUN = await import('../../js/sun.js');
const read = (name) => JSON.parse(fs.readFileSync(path.join(SYN, name), 'ascii'));
const DAY = 86400000, MIN = 60000;
const ASCII = /^[\x20-\x7e]*$/;
const BAD_WORDS = /undefined|NaN|null/;

function site() {
  const m = read('manifest.json'), f = read('facts.json');
  return { lat: m.crs.lat_deg, lon: m.crs.lon_deg, alt: f.sun.altitude_m, facts: f, manifest: m,
           g: f.sun.garden_point, profile: f.sun.horizon.profile_deg };
}
// every 10 minutes of a UTC day, from hh:05, while the sun is up there
function ticks(y, mo, d, s) {
  const out = [];
  for (let k = 0; k < 144; k++) {
    const t = Date.UTC(y, mo - 1, d) + k * 10 * MIN + 5 * MIN;
    const p = SUN.sunPosition(t, s.lat, s.lon, s.alt);
    if (p.elevation > 0) out.push({ t, az: p.azimuth, el: p.elevation });
  }
  return out;
}
async function atStart(page) {
  await page.evaluate(async () => {
    window.__cw.camera.start();
    await window.__cw.settle();
  });
}

// ------------------------------------------------------------------------------------------
// Node only

test('ST1 the sun matches pvlib', { timeout: 180000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sun-')), 'sun-vectors.json');
  const r = spawnSync(PYTHON, [path.join(HERE, 'make_vectors.py'), '--sun-out', out], { encoding: 'utf8' });
  if (r.status === 2) assert.fail(r.stdout.trim() || r.stderr.trim());
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(fs.readFileSync(out, 'ascii'));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  // pvlib adds its refraction only above a geometric -0.833 deg, where it is about 0.6 deg,
  // so the apparent elevation jumps there. An independent sun is a hundredth of a degree off
  // and can fall on the other side of the step: instants within 0.02 deg of it are counted,
  // not compared, and must be rare.
  const SWITCH = -(0.26667 + 0.5667);
  let n = 0, step = 0, maxEl = 0, maxAz = 0;
  for (const [ms, lat, lon, alt, az, el, geo] of rows) {
    if (!(el > -1)) continue;
    if (Math.abs(geo - SWITCH) < 0.02) { step++; continue; }
    const s = SUN.sunPosition(ms, lat, lon, alt);
    const dEl = Math.abs(s.elevation - el);
    const dAz = Math.abs(((s.azimuth - az + 540) % 360) - 180) * Math.cos(el * Math.PI / 180);
    maxEl = Math.max(maxEl, dEl); maxAz = Math.max(maxAz, dAz);
    n++;
  }
  assert.ok(n > 20000, 'compared ' + n + ' instants');
  assert.ok(step < 0.02 * n, step + ' instants at the refraction step');
  assert.ok(maxEl <= 0.02, 'max |d el| ' + maxEl.toFixed(4));
  assert.ok(maxAz <= 0.02, 'max |d az| x cos el ' + maxAz.toFixed(4));
});

test('ST2 the sun path matches the synthetic facts', () => {
  const s = site();
  for (const [key, mo] of [['dec21', 12], ['jun21', 6]]) {
    const want = s.facts.sun.sun_path[key], got = [];
    for (let k = 0; k < 144; k++) {
      const p = SUN.sunPosition(Date.UTC(2026, mo - 1, 21) + k * 10 * MIN, s.lat, s.lon, s.alt);
      if (p.elevation > 0) got.push(p);
    }
    assert.equal(got.length, want.length, key + ' sample count');
    got.forEach((p, i) => {
      assert.ok(Math.abs(((p.azimuth - want[i][0] + 540) % 360) - 180) <= 0.02, key + ' azimuth ' + i);
      assert.ok(Math.abs(p.elevation - want[i][1]) <= 0.02, key + ' elevation ' + i);
    });
  }
});

test('ST3 garden-point hours come from the facts profile', { timeout: 120000 }, () => {
  const s = site(), want = s.g.terrain;
  const days = SUN.daysInYear(2026), minutes = [];
  for (let d = 0; d < days; d++) minutes.push(SUN.dailyMinutes(Date.UTC(2026, 0, 1) + d * DAY, s.lat, s.lon, s.alt, s.profile));
  for (let m = 0; m < 12; m++) {
    const sel = minutes.filter((_, d) => new Date(Date.UTC(2026, 0, 1) + d * DAY).getUTCMonth() === m);
    const mean = sel.reduce((a, b) => a + b, 0) / sel.length / 60;
    assert.ok(Math.abs(mean - want.monthly_h[m]) <= 0.01, 'month ' + (m + 1) + ': ' + mean.toFixed(3) + ' h against ' + want.monthly_h[m]);
  }
  const at = (mo, d) => minutes[SUN.dayOfYear(2026, mo, d)] / 60;
  assert.ok(Math.abs(at(12, 21) - want.dec21_h) <= 0.02, '21 Dec ' + at(12, 21));
  assert.ok(Math.abs(at(6, 21) - want.jun21_h) <= 0.02, '21 Jun ' + at(6, 21));
});

test('ST4 the site\'s clock (Node)', () => {
  const tz = 'Europe/Oslo';
  assert.equal(SUN.localDay(2026, 3, 29, tz).minutes, 1380);
  assert.equal(SUN.localDay(2026, 10, 25, tz).minutes, 1500);
  assert.equal(SUN.localDay(2026, 6, 21, tz).minutes, 1440);
  const d = SUN.localDay(2026, 10, 25, tz);
  assert.equal(SUN.formatLocal(d.start + 150 * MIN, tz), '25 Oct 02:30 CEST');
  assert.equal(SUN.formatLocal(d.start + 210 * MIN, tz), '25 Oct 02:30 CET');
  assert.equal(SUN.zoneLabel(Date.UTC(2026, 0, 1), 'UTC'), 'UTC');
  assert.match(SUN.zoneLabel(Date.UTC(2026, 0, 1), 'Asia/Kolkata'), /^UTC\+5:30$/);
});

// ------------------------------------------------------------------------------------------
// Browser, the synthetic world

test('ST4 the site\'s clock (Chromium)', { timeout: READY_MS + 30000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(() => {
    const cw = window.__cw, out = [];
    for (const t of ['2026-10-25T00:30Z', '2026-10-25T01:30Z']) { cw.setSunTime(t); out.push(cw.sun.local); }
    return out;
  });
  assert.deepEqual(r, ['25 Oct 02:30 CEST', '25 Oct 02:30 CET']);
});

test('ST5 drawn terrain shade agrees with the facts at the garden point', { timeout: 1800000 }, async () => {
  const { page } = await mainPage();
  await atStart(page);
  const s = site();
  const all = [...ticks(2026, 6, 21, s), ...ticks(2026, 12, 21, s), ...ticks(2026, 3, 21, s)];
  for (const quality of ['phone', 'laptop']) {
    const got = await page.evaluate(async ({ ts, g, quality }) => {
      const cw = window.__cw, out = [];
      cw.setSunQuality(quality);
      for (const t of ts) {
        cw.setSunTime(t);
        await cw.sunIdle();
        out.push(cw.sunShadeAt(g.x, g.z, 1.5));
      }
      cw.setSunQuality(null);
      return out;
    }, { ts: all.map((x) => x.t), g: { x: s.g.x, z: s.g.z }, quality });
    let undecidable = 0;
    got.forEach((r, i) => {
      const { t, az, el } = all[i];
      const hz = SUN.horizonAt(s.profile, az);
      assert.notEqual(r.level, 'none', quality + ' ' + new Date(t).toISOString() + ' has no shade data');
      if (Math.abs(el - hz) < 0.25) { undecidable++; return; }
      assert.equal(r.lit, el > hz, quality + ' ' + new Date(t).toISOString() + ': drawn ' + (r.lit ? 'lit' : 'shade') +
                   ', facts ' + (el > hz ? 'lit' : 'shade') + ' (margin ' + r.margin_m + ' m at ' + r.level + ')');
    });
    assert.ok(undecidable <= 0.01 * all.length, quality + ': ' + undecidable + ' undecidable of ' + all.length);
  }
  // the known answers on the synthetic world: behind the north-west hill in the evening
  const known = await page.evaluate(async (g) => {
    const cw = window.__cw, out = {};
    for (const t of ['2026-06-21T20:30Z', '2026-06-21T12:00Z', '2026-06-21T19:00Z']) {
      cw.setSunTime(t);
      await cw.sunIdle();
      out[t] = cw.sunShadeAt(g.x, g.z, 1.5).lit;
    }
    return out;
  }, { x: s.g.x, z: s.g.z });
  assert.deepEqual(known, { '2026-06-21T20:30Z': false, '2026-06-21T12:00Z': true, '2026-06-21T19:00Z': true });
});

test('ST6 the 21 Dec plot map', { timeout: 900000 }, async () => {
  const { page } = await mainPage();
  await atStart(page);
  const s = site(), pm = s.facts.sun.plot_map;
  const cells = [];
  for (let r = 0; r < pm.rows; r++) for (let q = 0; q < pm.cols; q++) {
    const i = r * pm.cols + q;
    if (pm.dec21_min_terrain[i] >= 0) cells.push({ i, x: pm.x0 + (q + 0.5) * pm.cell_m, z: pm.z0 + (r + 0.5) * pm.cell_m });
  }
  const lit = await page.evaluate(async ({ ts, cells }) => {
    const cw = window.__cw, n = new Array(cells.length).fill(0);
    for (const t of ts) {
      cw.setSunTime(t);
      await cw.sunIdle();
      cells.forEach((c, k) => { if (cw.sunShadeAt(c.x, c.z, 1.5).lit) n[k]++; });
    }
    return n;
  }, { ts: ticks(2026, 12, 21, s).map((x) => x.t), cells });
  assert.ok(cells.length > 100);
  cells.forEach((c, k) => {
    assert.ok(Math.abs(10 * lit[k] - pm.dec21_min_terrain[c.i]) <= 15,
              'cell ' + c.i + ': drawn ' + 10 * lit[k] + ' min, facts ' + pm.dec21_min_terrain[c.i]);
  });
});

/* Two ground points for the house's shadow at 21 Jun 19:00 UTC, found by raycasting from 0.1 m
 * above the drawn ground toward the sun: the shadow point's ray, and those from 8 points on a
 * 1 m circle round it, all hit the house; the lit point's rays all miss every building and
 * tree. The lit point is 3 m beyond the shadow's side edge, on the same ground class where
 * that is possible. */
const PICK = `
  window.__pickShadowPoints = async function () {
    const THREE = await import('three');
    const cw = window.__cw, I = cw.internals, dir = new THREE.Vector3(...cw.sun.dir).normalize();
    const house = I.buildings.houseMesh, others = [I.buildings.othersMesh, house];
    if (I.trees) for (const g of I.trees.groups) others.push(...g.meshes);
    const rc = new THREE.Raycaster();
    const ground = (x, z) => I.manager.surfaceAt(x, z);
    const hits = (x, z, targets) => {
      const y = ground(x, z);
      if (y === null) return null;
      rc.set(new THREE.Vector3(x, y + 0.1, z), dir);
      rc.far = 400;
      return rc.intersectObjects(targets, false).length > 0;
    };
    const ring = (x, z, targets, want) => {
      if (hits(x, z, targets) !== want) return false;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        if (hits(x + Math.cos(a), z + Math.sin(a), targets) !== want) return false;
      }
      return true;
    };
    const above = (x, z) => {        // nothing between the point and the sky straight up
      const y = ground(x, z);
      rc.set(new THREE.Vector3(x, y + 0.1, z), new THREE.Vector3(0, 1, 0));
      rc.far = 400;
      return rc.intersectObjects(others, false).length === 0;
    };
    const cls = (x, z) => {
      const c = I.manager.chunkAt('h1', x, z);
      if (!c || !c.data || !c.data.classes) return -1;
      const h = c.data.header, e = x + I.manager.oe, n = I.manager.on - z, S = c.level.side;
      const q = Math.floor(e - c.i * S) + 1, r = Math.ceil((c.j + 1) * S - n);
      return c.data.classes[r * h.width + q];
    };
    const hb = new THREE.Box3().setFromObject(house);
    const cx = (hb.min.x + hb.max.x) / 2, cz = (hb.min.z + hb.max.z) / 2;
    // downwind of the house, away from the sun
    const hx = -dir.x, hz = -dir.z, hl = Math.hypot(hx, hz), ux = hx / hl, uz = hz / hl;
    let shade = null;
    for (let d = 2; d < 80 && !shade; d += 0.5) {
      for (const side of [0, 1, -1, 2, -2, 3, -3]) {
        const x = cx + ux * d - uz * side, z = cz + uz * d + ux * side;
        if (I.footprints.roofAt(x, z) !== null) continue;
        if (ring(x, z, [house], true) && above(x, z)) { shade = { x, z }; break; }
      }
    }
    if (!shade) return null;
    let lit = null;
    for (const sgn of [1, -1]) {
      let s = 0;
      while (s < 60 && hits(shade.x - uz * s * sgn, shade.z + ux * s * sgn, [house])) s += 0.25;
      const x = shade.x - uz * (s + 3) * sgn, z = shade.z + ux * (s + 3) * sgn;
      if (s >= 60 || I.footprints.roofAt(x, z) !== null || !ring(x, z, others, false) || !above(x, z)) continue;
      const cand = { x, z, same: cls(x, z) === cls(shade.x, shade.z) };
      if (!lit || (cand.same && !lit.same)) lit = cand;
    }
    return lit ? { shade, lit } : null;
  };
  window.__lookDownAt = async function (x, z, h) {
    const cw = window.__cw, y = cw.internals.manager.surfaceAt(x, z);
    cw.camera.set({ mode: 'fly', x, y: y + h, z, yaw: 0, pitch: -Math.PI / 2 + 0.001 });
    await cw.settle();
    await cw.sunIdle();
  };
  window.__patch = function (pts, size, split) {
    const cw = window.__cw, I = cw.internals, r = I.renderer, cam = I.camera, gl = r.getContext();
    cw.sunDebug(split ? 'split' : null);
    r.render(I.scene, cam);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, out = [];
    for (const p of pts) {
      const y = I.manager.surfaceAt(p.x, p.z);
      const v = { x: p.x, y, z: p.z };
      const ndc = new (cam.position.constructor)(v.x, v.y, v.z).project(cam);
      const px = Math.round((ndc.x + 1) / 2 * W), py = Math.round((ndc.y + 1) / 2 * H);
      const h = Math.floor(size / 2), buf = new Uint8Array(size * size * 4);
      gl.readPixels(px - h, py - h, size, size, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // luma on the coded values (L), and relative luminance in linear light (Y)
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      let R = 0, G = 0, L = 0, Y = 0, n = size * size;
      for (let i = 0; i < n; i++) {
        R += buf[i * 4]; G += buf[i * 4 + 1];
        L += 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2];
        Y += 0.2126 * lin(buf[i * 4]) + 0.7152 * lin(buf[i * 4 + 1]) + 0.0722 * lin(buf[i * 4 + 2]);
      }
      out.push({ R: R / n / 255, G: G / n / 255, L: L / n, Y: Y / n });
    }
    cw.sunDebug(null);
    return out;
  };
`;

test('ST7 the GPU draws what the CPU says', { timeout: 600000 }, async () => {
  const { page } = await mainPage();
  await page.addScriptTag({ content: PICK });
  await atStart(page);
  const s = site();
  const r = await page.evaluate(async (g) => {
    const cw = window.__cw, out = {};
    await window.__lookDownAt(g.x, g.z, 60);
    for (const t of ['2026-06-21T20:30Z', '2026-06-21T12:00Z']) {
      cw.setSunTime(t);
      await cw.settle();
      out[t] = window.__patch([g], 3, true)[0];
    }
    cw.setSunTime('2026-06-21T19:00Z');
    cw.camera.start();
    await cw.settle();
    const pts = await window.__pickShadowPoints();
    if (!pts) return { out, pts: null };
    await window.__lookDownAt((pts.shade.x + pts.lit.x) / 2, (pts.shade.z + pts.lit.z) / 2, 40);
    const [a, b] = window.__patch([pts.shade, pts.lit], 3, true);
    out.shade = a; out.lit = b;
    return { out, pts };
  }, { x: s.g.x, z: s.g.z });
  assert.ok(r.out['2026-06-21T20:30Z'].R < 0.1, '20:30 R ' + r.out['2026-06-21T20:30Z'].R);
  assert.ok(r.out['2026-06-21T12:00Z'].R > 0.9, '12:00 R ' + r.out['2026-06-21T12:00Z'].R);
  assert.ok(r.pts, 'found a point in the house\'s shadow and a lit one beside it');
  assert.ok(r.out.shade.G < 0.3, 'in the house\'s shadow: G ' + r.out.shade.G);
  assert.ok(r.out.lit.G > 0.9, 'outside it: G ' + r.out.lit.G);
});

test('ST8 shadows are visible', { timeout: 600000 }, async () => {
  const { page } = await mainPage();
  await page.addScriptTag({ content: PICK });
  await atStart(page);
  const r = await page.evaluate(async () => {
    const cw = window.__cw;
    cw.setSunTime('2026-06-21T19:00Z');
    cw.camera.start();
    await cw.settle();
    const pts = await window.__pickShadowPoints();
    if (!pts) return null;
    await window.__lookDownAt((pts.shade.x + pts.lit.x) / 2, (pts.shade.z + pts.lit.z) / 2, 40);
    for (const id of ['bar', 'credits', 'hint', 'dock', 'house-label']) document.getElementById(id).style.visibility = 'hidden';
    const [a, b] = window.__patch([pts.shade, pts.lit], 9, false);
    for (const id of ['bar', 'credits', 'hint', 'dock', 'house-label']) document.getElementById(id).style.visibility = '';
    return { a, b, same: pts.lit.same };
  });
  assert.ok(r, 'found the two points');
  // Luminance is a linear-light quantity: the patches are compared as relative luminance Y.
  // (At this 11.5 deg sun the sky's fill is most of the light on flat ground, so the coded
  // values, luma, differ less: see the hand-off.)
  assert.ok(r.a.Y < 0.85 * r.b.Y, 'shadow patch Y ' + r.a.Y.toFixed(4) + ' against lit ' + r.b.Y.toFixed(4) +
            ' (luma ' + r.a.L.toFixed(1) + ' against ' + r.b.L.toFixed(1) + ')');
});

test('ST9 the slider works by keyboard', { timeout: READY_MS + 120000 }, async () => {
  const ctx = await newContext();
  await ctx.clock.install({ time: new Date('2027-03-01T09:00:00Z') });
  const { page } = await openWorld(ctx);
  const state = () => page.evaluate(async () => {
    await window.__cw.frame();
    return { utc: window.__cw.sun.utc, time: document.getElementById('sun-time').getAttribute('aria-valuetext'),
             day: document.getElementById('sun-day').getAttribute('aria-valuetext'), id: document.activeElement.id,
             open: !document.getElementById('sun').hidden, pose: window.__cw.camera.get() };
  });
  // Tab from the page: the canvas first, then the three pills, then the sun chip
  const order = [];
  for (let k = 0; k < 5; k++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id)); }
  assert.deepEqual(order, ['view', 'btn-specs', 'btn-mode', 'btn-help', 'btn-sun']);
  await page.keyboard.press('Enter');
  let s = await state();
  assert.equal(s.open, true);
  assert.equal(s.id, 'sun-title');
  for (let k = 0; k < 5 && s.id !== 'sun-time'; k++) { await page.keyboard.press('Tab'); s = await state(); }
  assert.equal(s.id, 'sun-time');
  const t0 = s.utc;
  await page.keyboard.press('ArrowRight');
  s = await state();
  assert.equal(s.utc - t0, 10 * MIN, 'ArrowRight is ten minutes');
  const v1 = s.time;
  await page.keyboard.press('PageUp');
  s = await state();
  assert.equal(s.utc - t0, 70 * MIN, 'PageUp is an hour');
  assert.notEqual(s.time, v1, 'aria-valuetext follows');
  await page.keyboard.press('Home');
  s = await state();
  const tz = 'Europe/Oslo', lp = SUN.localParts(t0, tz);
  assert.equal(s.utc, SUN.localDay(lp.y, lp.mo, lp.d, tz).start, 'Home is local midnight');
  await page.keyboard.press('Shift+Tab');
  s = await state();
  assert.equal(s.id, 'sun-day');
  const d0 = s.utc, dayText = s.day;
  await page.keyboard.press('ArrowRight');
  s = await state();
  assert.equal(s.utc - d0, DAY, 'the date arrows step a day');
  assert.notEqual(s.day, dayText);
  await page.keyboard.press('ArrowLeft');
  s = await state();
  assert.equal(s.utc, d0);
  // (buttons are clicked in the page: under the installed clock, pointer actions wait on
  // animation frames the fake clock drives)
  const press = (id) => page.evaluate((id) => document.getElementById(id).click(), id);
  await press('sun-dec');
  s = await state();
  const dec = SUN.localParts(s.utc, tz);
  assert.deepEqual([dec.y, dec.mo, dec.d, dec.h, dec.mi], [2026, 12, 21, 0, 0], '21 Dec keeps the time of day');
  await press('sun-now');
  s = await state();
  const now = SUN.localParts(s.utc, tz);
  assert.deepEqual([now.y, now.mo, now.d, now.h, now.mi], [2026, 3, 1, 10, 0], '"Now" is today at the site, in the facts year');
  await page.focus('#sun-time');
  await page.keyboard.press('Escape');
  s = await state();
  assert.equal(s.open, false);
  assert.equal(s.id, 'btn-sun');
  // Comma and Period: the time moves, the camera does not, walking or flying
  for (const mode of ['walk', 'fly']) {
    await page.evaluate((mode) => window.__cw.camera.set({ mode }), mode);
    await page.focus('#view');
    const a = await state();
    await page.keyboard.press('Period');
    const b = await state();
    await page.keyboard.press('Comma');
    await page.keyboard.press('Comma');
    const c = await state();
    assert.equal(b.utc - a.utc, 10 * MIN, mode + ': Period');
    assert.equal(c.utc - a.utc, -10 * MIN, mode + ': Comma');
    for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) assert.ok(Math.abs(c.pose[k] - a.pose[k]) < 1e-9, mode + ': camera ' + k + ' moved');
  }
  const a = await state();
  await page.keyboard.press('Shift+Period');
  const b = await state();
  assert.equal(b.utc - a.utc, 10 * MIN, 'Shift+Period is ten minutes too: Shift is not a modifier here');
  assert.deepEqual(await page.evaluate(() => window.__cw.errors), []);
  await page.close();
});

test('ST10 the layout with the sun chip and panel', { timeout: READY_MS * 2 + 120000 }, async () => {
  const measure = (page) => page.evaluate(() => {
    const box = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return b.width > 0 ? { l: b.left, t: b.top, r: b.right, b: b.bottom, h: b.height } : null; };
    return { W: innerWidth, H: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
             chip: box('btn-sun'), sun: box('sun'), stick: box('stick'), creditsToggle: box('credits-toggle'), credits: box('credits'),
             hint: box('hint'), status: box('status'), pills: ['btn-specs', 'btn-mode', 'btn-help'].map(box),
             controls: ['sun-day', 'sun-time', 'sun-now', 'sun-dec', 'sun-jun', 'sun-noon', 'sun-close'].map(box) };
  });
  const inside = (m, b) => b && b.l >= -0.5 && b.t >= -0.5 && b.r <= m.W + 0.5 && b.b <= m.H + 0.5;
  const meets = (a, b) => !!a && !!b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  // phones
  for (const vp of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const ctx = await newContext({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const { page, log } = await openWorld(ctx);
    const tag = vp.width + 'x' + vp.height;
    let m = await measure(page);
    assert.ok(inside(m, m.chip), tag + ': the chip is inside the viewport');
    assert.ok(m.chip.h >= 44, tag + ': chip hit height ' + m.chip.h);
    for (const o of [m.stick, m.creditsToggle, ...m.pills]) assert.ok(!meets(m.chip, o), tag + ': the chip meets another control');
    if (vp.width < vp.height) assert.ok(m.chip.l >= m.stick.r || m.chip.t >= m.stick.b, tag + ': the chip sits clear of the stick');
    await page.tap('#btn-sun');
    m = await measure(page);
    assert.ok(m.sun, tag + ': the panel opened');
    assert.ok(m.sw <= m.cw, tag + ': no sideways scroll');
    for (const c of m.controls) {
      assert.ok(inside(m, c), tag + ': a panel control is outside the viewport');
      assert.ok(c.h >= 44 || c === m.controls[6], tag + ': hit height ' + c.h);
    }
    assert.ok(inside(m, m.chip), tag + ': the chip stays inside the viewport');
    for (const o of [m.creditsToggle, ...m.pills]) assert.ok(!meets(m.sun, o), tag + ': the panel covers a control');
    assert.ok(!meets(m.chip, m.sun), tag + ': the panel covers the chip');
    if (vp.width < vp.height) assert.ok(m.sun.t >= 0.7 * m.H, tag + ': the panel top ' + m.sun.t + ' is above 70% of the height');
    // one panel at a time
    await page.tap('#sun-close');
    await page.tap('#btn-specs');
    assert.equal(await page.locator('#specs').isVisible(), true);
    await page.tap('#btn-sun');
    assert.equal(await page.locator('#specs').isVisible(), false, 'the chip closes Specs');
    assert.equal(await page.locator('#sun').isVisible(), true);
    await page.tap('#btn-specs');
    assert.equal(await page.locator('#sun').isVisible(), false, 'Specs closes the sun panel');
    await page.tap('#specs-close');
    await page.tap('#btn-help');
    await page.tap('#btn-sun');
    assert.equal(await page.locator('#help').isVisible(), false, 'the chip closes the help');
    await page.tap('#btn-help');
    assert.equal(await page.locator('#sun').isVisible(), false, 'the help closes the sun panel');
    assert.deepEqual(log.errors, []);
    await page.close();
  }
  // narrow laptops: the chip clear of the hint, the credits (open and folded) and the status,
  // also while the status shows an error
  const manifest = read('manifest.json');
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  const keys = Object.keys(h1.chunks).sort();
  for (const vp of [{ width: 1024, height: 700 }, { width: 800, height: 600 }]) {
    for (const withError of [false, true]) {
      const ctx = await newContext({ viewport: vp });
      if (withError) {
        await ctx.route('**/out/synthetic/manifest.json', async (route) => {
          const res = await route.fetch();
          const mm = await res.json();
          const l = mm.levels.find((x) => x.name === 'h1');
          const fa = l.chunks[keys[0]], fb = l.chunks[keys[keys.length - 1]];
          l.chunks[keys[0]] = fb; l.chunks[keys[keys.length - 1]] = fa;
          await route.fulfill({ response: res, body: JSON.stringify(mm), headers: { 'content-type': 'application/json' } });
        });
      }
      const { page } = await openWorld(ctx);
      const tag = vp.width + 'x' + vp.height + (withError ? ' with an error' : '');
      for (const folded of [false, true]) {
        const isFolded = await page.evaluate(() => document.getElementById('credits').classList.contains('collapsed'));
        if (isFolded !== folded) await page.click('#credits-toggle');
        await page.evaluate(() => window.__cw.frame());
        const m = await measure(page);
        assert.ok(inside(m, m.chip), tag + ': the chip is inside the viewport');
        for (const [name, o] of [['hint', m.hint], ['credits', m.credits], ['status', m.status]]) {
          assert.ok(!meets(m.chip, o), tag + (folded ? ', credits folded' : '') + ': the chip meets #' + name);
        }
        if (withError) assert.ok(m.status, tag + ': the status line shows the error');
      }
      // one panel at a time, with a mouse
      await page.click('#btn-specs');
      await page.click('#btn-sun');
      assert.equal(await page.locator('#specs').isVisible(), false);
      await page.click('#btn-specs');
      assert.equal(await page.locator('#sun').isVisible(), false);
      await page.click('#btn-help');
      assert.equal(await page.locator('#specs').isVisible(), false);
      await page.click('#btn-sun');
      assert.equal(await page.locator('#help').isVisible(), false);
      const m = await measure(page);
      for (const [name, o] of [['hint', m.hint], ['credits', m.credits]]) assert.ok(!meets(m.sun, o), tag + ': the sun panel covers #' + name);
      await page.close();
    }
  }
});

test('ST11 night is usable', { timeout: 300000 }, async () => {
  const { page } = await mainPage();
  await page.evaluate(async () => {
    const cw = window.__cw;
    cw.setSunTime('2026-12-21T20:00Z');
    cw.camera.start();
    await cw.settle();
    await cw.sunIdle();
    await cw.frame();
  });
  const hide = ['bar', 'credits', 'hint', 'dock', 'house-label', 'sun'];
  await page.evaluate((ids) => { for (const id of ids) document.getElementById(id).style.visibility = 'hidden'; }, hide);
  const png = await page.screenshot();
  await page.evaluate((ids) => { for (const id of ids) document.getElementById(id).style.visibility = ''; }, hide);
  const r = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, s = 0, s2 = 0;
    for (let i = 0; i < d.length; i += 16) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      n++; s += y; s2 += y * y;
    }
    const mean = s / n;
    return { mean, std: Math.sqrt(s2 / n - mean * mean) };
  }, png.toString('base64'));
  assert.ok(r.mean >= 12 && r.mean <= 70, 'mean luminance ' + r.mean.toFixed(1));
  assert.ok(r.std > 6, 'luminance spread ' + r.std.toFixed(1));
});

test('ST13 shadow budget', { timeout: READY_MS + 120000 }, async (t) => {
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const { page } = await openWorld(ctx);
  const has = await page.evaluate(() => !!(window.__cw.internals.trees && window.__cw.internals.trees.setShadowFocus));
  if (!has) { await page.close(); t.skip('integration-only: needs trees.setShadowFocus'); return; }
  for (const time of ['2026-06-21T14:30Z', '2026-12-21T09:00Z']) {
    const c = await page.evaluate(async (time) => {
      const cw = window.__cw;
      cw.setSunTime(time);
      cw.camera.start();
      await cw.settle();
      await cw.sunIdle();
      const withShadows = await cw.frameCost();
      const light = cw.internals.scene.children.find((o) => o.isDirectionalLight);
      cw.internals.renderer.shadowMap.enabled = false;
      light.castShadow = false;
      cw.internals.renderer.render(cw.internals.scene, cw.internals.camera);
      const off = { triangles: cw.internals.renderer.info.render.triangles, calls: cw.internals.renderer.info.render.calls };
      cw.internals.renderer.shadowMap.enabled = true;
      light.castShadow = true;
      cw.internals.renderer.shadowMap.needsUpdate = true;
      return { withShadows, off };
    }, time);
    assert.ok(c.withShadows.shadow.triangles <= 5000, time + ': shadow triangles ' + c.withShadows.shadow.triangles);
    assert.ok(c.withShadows.shadow.calls <= 12, time + ': shadow calls ' + c.withShadows.shadow.calls);
    assert.equal(c.withShadows.main.triangles, c.off.triangles, time + ': the main pass is unchanged by shadows');
  }
  await page.close();
});

test('ST14 settle waits for the sun', { timeout: 300000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const cw = window.__cw;
    cw.setSunTime('2026-03-21T10:05Z');
    const before = cw.internals.sun.jobIds();
    const ok = await cw.settle();
    return { ok, before, after: cw.internals.sun.jobIds() };
  });
  assert.equal(r.ok, true);
  assert.ok(r.before.requested > r.before.landed || r.before.inflight !== null, 'a sweep was asked for');
  assert.equal(r.after.landed, r.after.requested, 'settle returned before the sweep landed');
  assert.equal(r.after.inflight, null);
  assert.equal(r.after.pending, null);
});

test('ST15 the far gate', { timeout: READY_MS + 120000 }, async () => {
  const facts = read('facts.json');
  const bw = facts.sun.horizon.beyond_world;
  for (let k = 300; k <= 420; k++) { bw.profile_deg[k] = 10; bw.distance_m[k] = 30000; }   // 150-210 deg true
  const body = JSON.stringify(facts);
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/facts.json', (route) => route.fulfill({ status: 200, body, contentType: 'application/json' }));
  const { page } = await openWorld(ctx);
  const at = (t) => page.evaluate(async (t) => {
    const cw = window.__cw, I = cw.internals;
    cw.setSunTime(t);
    await cw.settle();
    const light = I.scene.children.find((o) => o.isDirectionalLight);
    return { intensity: light.intensity, disc: I.sky.material.uniforms.showSunDisc.value, far: cw.sun.behindFar,
             lines: cw.sunReadout().lines, az: cw.sun.trueAzimuth, el: cw.sun.elevation };
  }, t);
  const dec = await at('2026-12-21T11:40Z');
  assert.ok(dec.az > 150 && dec.az < 210 && dec.el < 10, 'the sun is in the gated sector, below 10 deg');
  assert.equal(dec.intensity, 0);
  assert.equal(dec.disc, 0);
  assert.equal(dec.far, true);
  assert.ok(dec.lines.some((l) => /behind mountains beyond the edge of this world/.test(l)), dec.lines.join(' | '));
  const jun = await at('2026-06-21T12:00Z');
  assert.ok(jun.intensity > 0);
  assert.equal(jun.disc, 1);
  assert.equal(jun.far, false);
  await page.close();
});

test('ST16 the world-only horizon agrees with the measured one', { timeout: 300000 }, async () => {
  const { page } = await mainPage();
  await atStart(page);
  const s = site(), bw = s.facts.sun.horizon.beyond_world;
  const w = await page.evaluate((g) => window.__cw.internals.sun.worldHorizon(g.x, g.z, 1.5), { x: s.g.x, z: s.g.z });
  assert.equal(w.profile_deg.length, 720);
  let n = 0;
  for (let k = 0; k < 720; k++) {
    if (!(bw.profile_deg[k] < s.profile[k] - 0.35)) continue;
    n++;
    assert.ok(Math.abs(w.profile_deg[k] - s.profile[k]) <= 0.35,
              'ray ' + k * 0.5 + ' deg: world ' + w.profile_deg[k].toFixed(2) + ', facts ' + s.profile[k]);
  }
  assert.ok(n > 100, n + ' rays the world decides');
});

test('ST17 the start stays put', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const cw = window.__cw;
    cw.setSunTime('2026-06-21T14:30Z');
    cw.camera.start();
    await cw.frame();
    const before = { pose: JSON.stringify(cw.camera.pose()), cam: cw.camera.get() };
    cw.setSunTime('2026-12-21T09:00Z');
    cw.camera.start();
    await cw.frame();
    return { before, after: { pose: JSON.stringify(cw.camera.pose()), cam: cw.camera.get() } };
  });
  assert.equal(r.after.pose, r.before.pose);
  for (const k of ['x', 'y', 'z', 'yaw', 'pitch']) assert.ok(Math.abs(r.after.cam[k] - r.before.cam[k]) < 1e-9, k);
});

test('ST18 every lit material is shaded by the sun', { timeout: 300000 }, async () => {
  const { page } = await mainPage();
  await atStart(page);
  const r = await page.evaluate(async () => {
    const cw = window.__cw, I = cw.internals;
    await cw.frame();
    const missing = [];
    I.scene.traverseVisible((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m, i) => {
        if (!(m.isMeshLambertMaterial || m.isMeshPhongMaterial)) return;
        const p = I.renderer.properties.get(m).currentProgram;
        if (!p || !/cwS1-/.test(p.cacheKey)) missing.push(o.name + '[' + i + ']');
      });
    });
    const shade = await import('/world/js/sunshade.js');
    // a clone is not decorated (onBeforeCompile does not survive clone()), until its first frame
    const water = I.water, orig = water.material, clone = orig.clone();
    const before = shade.sunKindOf(clone);
    water.material = clone;
    await cw.frame();
    const after = shade.sunKindOf(clone), key = I.renderer.properties.get(clone).currentProgram.cacheKey;
    water.material = orig;
    clone.dispose();
    await cw.frame();
    const THREE = await import('three');
    let thrown = null;
    try {
      const m = shade.withSunShade(new THREE.MeshLambertMaterial(), 'zero');
      m.onBeforeCompile({ vertexShader: 'void main() {}', fragmentShader: 'void main() {}', uniforms: {} });
    } catch (e) { thrown = e.message; }
    return { coverage: cw.sunCoverage(), missing, before, after, key, thrown };
  });
  assert.deepEqual(r.coverage, []);
  assert.deepEqual(r.missing, []);
  assert.equal(r.before, undefined);
  assert.equal(r.after, 'zero');
  assert.match(r.key, /cwS1-zero/);
  assert.match(r.thrown || '', /cw patch anchor missing/);
});

test('ST19 no shadow work at night', { timeout: 120000 }, async () => {
  const { page } = await mainPage();
  const r = await page.evaluate(async () => {
    const cw = window.__cw, S = cw.internals.sun;
    cw.setSunTime('2026-12-21T12:00Z');
    await cw.settle();
    const posted = S.jobIds().posted;
    cw.setSunTime('2026-12-21T20:00Z');
    const redrawn = [];
    for (let k = 0; k < 2; k++) {
      cw.camera.set({ yaw: cw.camera.get().yaw + 0.8 });    // a turn that would move the near box by day
      await cw.frame();
      redrawn.push(cw.stats().shadowRedrawn);
    }
    return { redrawn, posted, after: S.jobIds().posted, night: S.night };
  });
  assert.equal(r.night, true);
  assert.deepEqual(r.redrawn, [false, false]);
  assert.equal(r.after, r.posted, 'no sweep job at night');
});

test('ST20 a late upstream chunk re-sweeps', { timeout: READY_MS + 120000 }, async () => {
  const s = site(), m = s.manifest;
  const h5 = m.levels.find((l) => l.name === 'h5'), S5 = h5.cell * h5.chunk_samples;
  // an h5 chunk 2 km toward the sun of 21 Dec 11:40 UTC (south) from the garden point, held back 3 s
  const t = Date.UTC(2026, 11, 21, 11, 40), p = SUN.sunPosition(t, s.lat, s.lon, s.alt);
  const b = (p.azimuth + m.crs.grid_north_offset_deg) * Math.PI / 180;
  const x = s.g.x + Math.sin(b) * 2000, z = s.g.z - Math.cos(b) * 2000;
  const key = Math.floor((x + m.crs.origin_e) / S5) + '_' + Math.floor((m.crs.origin_n - z) / S5);
  assert.ok(h5.chunks[key], 'the upstream h5 chunk ' + key + ' exists');
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/' + h5.chunks[key].file, async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(origin() + '/world/?w=out/synthetic/&t=2026-12-21T12:40');
  await page.waitForFunction(() => window.__cw && window.__cw.ready, null, { timeout: READY_MS });
  const late = await page.evaluate(async ({ g, t, key }) => {
    const cw = window.__cw;
    await cw.sunIdle();
    const ids = cw.internals.sun.jobIds();
    ids.atArrival = cw.internals.sun.arrivalOf('h5', key);
    const a = cw.sunShadeAt(g.x, g.z, 1.5);
    cw.setSunTime(t);          // the same instant again, with every chunk in place
    await cw.sunIdle();
    return { ids, a, b: cw.sunShadeAt(g.x, g.z, 1.5) };
  }, { g: { x: s.g.x, z: s.g.z }, t, key });
  assert.ok(late.ids.atArrival !== null, 'the chunk reached the sun worker');
  assert.ok(late.ids.landed > late.ids.atArrival, 'a sweep asked for after the chunk arrived has landed (' +
            late.ids.atArrival + ' then ' + late.ids.landed + ')');
  assert.equal(late.ids.landed, late.ids.requested);
  assert.equal(late.a.level, late.b.level);
  assert.ok(Math.abs(late.a.margin_m - late.b.margin_m) < 1e-6, 'shade from the complete data: ' + late.a.margin_m + ' against ' + late.b.margin_m);
  await page.close();
});

test('ST21 ?t= opens at that time, and labels are ASCII', { timeout: READY_MS + 60000 }, async () => {
  const ctx = await newContext();
  const { page } = await openWorld(ctx, '?w=out/synthetic/&t=2026-12-21T12:00');
  const r = await page.evaluate(() => {
    const cw = window.__cw;
    return { local: cw.sun.local, chip: document.getElementById('btn-sun').textContent, lines: cw.sunReadout().lines,
             zone: cw.sunTime().local.split(' ').pop(), aria: document.getElementById('btn-sun').getAttribute('aria-label') };
  });
  assert.match(r.local, /^21 Dec 12:00/);
  for (const label of [r.chip, r.local, r.zone, r.aria, ...r.lines]) {
    assert.match(label, ASCII, JSON.stringify(label));
    assert.doesNotMatch(label, /\u00b0/);
    assert.doesNotMatch(label, BAD_WORDS);
  }
  assert.ok(r.lines.some((l) => / deg /.test(l)), 'angles say deg');
  await page.close();
});

test('ST22 a failed chunk leaves the sun working, and adds no error', { timeout: READY_MS + 120000 }, async () => {
  const m = read('manifest.json');
  const h5 = m.levels.find((l) => l.name === 'h5');
  const keys = Object.keys(h5.chunks).sort();
  const [a, b] = [keys[0], keys[keys.length - 1]];
  const ctx = await newContext();
  await ctx.route('**/out/synthetic/manifest.json', async (route) => {
    const res = await route.fetch();
    const mm = await res.json();
    const l = mm.levels.find((x) => x.name === 'h5');
    const fa = l.chunks[a], fb = l.chunks[b];
    l.chunks[a] = fb; l.chunks[b] = fa;
    await route.fulfill({ response: res, body: JSON.stringify(mm), headers: { 'content-type': 'application/json' } });
  });
  const { page } = await openWorld(ctx);
  const s = site();
  const r = await page.evaluate(async (g) => {
    const cw = window.__cw, t0 = performance.now();
    await Promise.race([cw.sunIdle(), new Promise((res) => setTimeout(res, 10000))]);
    return { ms: performance.now() - t0, errors: cw.errors.slice(), failed: cw.stats().failed,
             shade: cw.sunShadeAt(g.x, g.z, 1.5), lines: cw.sunReadout().lines, ids: cw.internals.sun.jobIds() };
  }, { x: s.g.x, z: s.g.z });
  assert.equal(r.failed, 2);
  assert.equal(r.errors.length, 2, r.errors.join(' | '));
  assert.ok(r.ms < 10000 && r.ids.landed === r.ids.requested, 'sunIdle resolved');
  assert.notEqual(r.shade.level, 'none');
  for (const l of r.lines) assert.doesNotMatch(l, BAD_WORDS);
  await page.close();
});

test('ST23 the date slider is the facts year', { timeout: READY_MS * 2 + 60000 }, async () => {
  const ctx = await newContext();
  await ctx.clock.install({ time: new Date('2027-03-01T09:00:00Z') });
  const { page } = await openWorld(ctx);
  assert.equal(await page.getAttribute('#sun-day', 'max'), '364');
  // (clicked in the page: under the installed clock, pointer actions wait on animation frames)
  await page.evaluate(() => { document.getElementById('btn-sun').click(); document.getElementById('sun-now').click(); });
  const r = await page.evaluate(() => ({ t: window.__cw.sunTime(), first: window.__cw.sunReadout().lines[0] }));
  const lp = SUN.localParts(r.t.utc, 'Europe/Oslo');
  assert.deepEqual([lp.y, lp.mo, lp.d, lp.h, lp.mi], [2026, 3, 1, 10, 0]);
  assert.match(r.first, /^1 Mar 2026, 10:00 CET/);
  assert.deepEqual(await page.evaluate(() => window.__cw.errors), []);
  await page.close();
  const ctx2 = await newContext();
  const { page: p2 } = await openWorld(ctx2, '?w=out/synthetic/&t=2027-06-21T12:00');
  const t2 = await p2.evaluate(() => window.__cw.sunTime());
  const l2 = SUN.localParts(t2.utc, 'Europe/Oslo');
  assert.deepEqual([l2.y, l2.mo, l2.d, l2.h, l2.mi], [2026, 6, 21, 12, 0]);
  await p2.close();
});

test('ST12 the console stays clean with shadows', async () => {
  const { page, log } = await mainPage();
  await page.evaluate(() => window.__cw.frame());
  assert.deepEqual(log.warnings.filter((w) => /PCFSoftShadowMap|GL_INVALID/.test(w)), []);
  assert.deepEqual(log.console, []);
  assert.deepEqual(log.errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cw.errors), []);
});

test('no request ever left localhost', () => {
  assert.deepEqual(offenders, []);
});
