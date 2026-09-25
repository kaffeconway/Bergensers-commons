/* Commons World: the sun worker. Imports nothing.
 *
 * It holds the terrain heights the page has loaded (every h20 and h5 chunk, and the h1
 * chunks near the h1 window, cloned from the chunk manager's decoded data) and, for a sun
 * direction, works out how high the terrain upstream shades each point: the "shade
 * height" SH. A receiver hAG metres above the data ground h has direct sun when
 * h + hAG > SH. Leaving out the caster one cell upstream keeps a point's own relief from
 * shading it; the lighting's N.L already darkens slopes that face away from the sun.
 *
 * The sweep, per level: a square grid of side 2R turned to face the sun (t runs
 * downstream, away from the sun; v across). Each row is walked from its upstream edge with
 * a running maximum:
 *     A_k  = max(A_{k-1}, h_{k-1}) - c tanE      (every caster strictly upstream)
 *     SH_k = A_{k-1} - c tanE                    (casters two or more cells upstream)
 * The level stored is M = SH - h (metres; negative is lit) as half floats, and on the h1
 * window also D, the distance to the caster, for the penumbra. The levels nest:
 *     h20  the disc holding every h20 square, around the origin, at 40 m cells;
 *     h5   the h5 radius around the origin, at 5 m (laptop) or 10 m (phone);
 *     h1   a window of +-512 m or +-256 m around the camera, at 1 m.
 * A ray from a receiver toward the sun leaves a convex square once, through its upstream
 * edge, so a finer level's rows start from the coarser level's shade there. The coarser
 * shade leaves out its own nearest caster, so each finer row starts two coarse cells
 * further upstream and walks that stretch on the finer data first. The h20 rows start from
 * the far gate: terrain beyond the drawn world, as a caster line across the sun's azimuth
 * at its measured distance and angle from the garden point, which makes the gate exact
 * there.
 *
 * A square that no level holds a chunk for is 0 m where a level lists it (sea, or a chunk
 * that failed or has not loaded) and no caster at all where none does (beyond the world).
 *
 * Jobs are numbered; the page keeps one in flight. Results are transferred to the page and
 * the page transfers its previous set back ('return'), so nothing is copied per update.
 */

var UNKNOWN = -1e9;
var M_MIN = -10000, M_MAX = 60000;       // M is clamped here before it is made a half float
var HAS_F16 = typeof Float16Array === 'function';

var cfg = { oe: 0, on: 0, offset: 0, garden: null };
var levels = {};                          // name -> level record
var order = [];                           // finest first
var pool = [];                            // arrays returned by the page, for reuse
var last = null;                          // the last sun job's direction and gate, for window jobs
var keepH5 = null;                        // a copy of the last h5 result, to seed window jobs
var derived = null;                       // the world-only horizon at the garden point

// ------------------------------------------------------------------ half floats
var f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(v) {                      // round to nearest, ties to even
  f32[0] = v;
  var x = u32[0], sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  var e = exp - 112;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    var shift = 14 - e, h = mant >> shift, rem = mant & ((1 << shift) - 1), mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (h & 1))) h++;
    return sign | h;
  }
  var hv = (e << 10) | (mant >> 13), r = mant & 0x1fff;
  if (r > 0x1000 || (r === 0x1000 && (hv & 1))) hv++;
  return sign | hv;
}
function fromHalf(h) {
  var s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
// ------------------------------------------------------------------ heights
function parseKey(key) {
  var m = /^(-?\d+)_(-?\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function makeLevel(rec) {
  var K = rec.samples, S = rec.cell * K;
  var keys = (rec.keys || []).concat(rec.sea || []), i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  keys.forEach(function (k) {
    var p = parseKey(k);
    if (!p) return;
    i0 = Math.min(i0, p[0]); j0 = Math.min(j0, p[1]); i1 = Math.max(i1, p[0]); j1 = Math.max(j1, p[1]);
  });
  if (!isFinite(i0)) { i0 = j0 = 0; i1 = j1 = -1; }
  var ni = i1 - i0 + 1, nj = j1 - j0 + 1;
  var lv = { name: rec.name, cell: rec.cell, K: K, S: S, i0: i0, j0: j0, ni: ni, nj: nj,
             grid: new Array(Math.max(0, ni * nj)).fill(null),
             listed: new Uint8Array(Math.max(0, ni * nj)),    // 1 listed as a chunk file, 2 as sea
             coarser: null, bytes: 0, count: 0, radius: rec.radius || 0, radiusSquares: 0 };
  (rec.keys || []).forEach(function (k) { var p = parseKey(k); if (p) lv.listed[(p[0] - i0) + (p[1] - j0) * ni] = 1; });
  (rec.sea || []).forEach(function (k) { var p = parseKey(k); if (p) lv.listed[(p[0] - i0) + (p[1] - j0) * ni] = 2; });
  return lv;
}

function storeChunk(msg) {
  var lv = levels[msg.level], p = parseKey(msg.key);
  if (!lv || !p) return;
  var gi = p[0] - lv.i0, gj = p[1] - lv.j0;
  if (gi < 0 || gj < 0 || gi >= lv.ni || gj >= lv.nj) return;
  var idx = gi + gj * lv.ni, old = lv.grid[idx];
  if (old) { lv.bytes -= old.v.byteLength; lv.count--; }
  lv.grid[idx] = { v: msg.v, base: msg.header.base, W: msg.header.width };
  lv.bytes += msg.v.byteLength;
  lv.count++;
  derived = null;
}

function dropChunks(level, keys) {
  var lv = levels[level];
  if (!lv) return;
  keys.forEach(function (k) {
    var p = parseKey(k);
    if (!p) return;
    var gi = p[0] - lv.i0, gj = p[1] - lv.j0;
    if (gi < 0 || gj < 0 || gi >= lv.ni || gj >= lv.nj) return;
    var idx = gi + gj * lv.ni;
    if (lv.grid[idx]) { lv.bytes -= lv.grid[idx].v.byteLength; lv.count--; lv.grid[idx] = null; }
  });
  derived = null;
}

/* The data height at local (x, z) on level lv, falling back to coarser levels: bilinear
 * between sample centres (every chunk carries a one-sample apron), 0 m below sea level.
 * 0 where a level lists the square but has no data for it; UNKNOWN beyond every level. */
function sampleAt(lv, x, z) {
  var listed = false;
  for (var L = lv; L; L = L.coarser) {
    var u = (x + cfg.oe) / L.cell, w = (cfg.on - z) / L.cell;
    var i = Math.floor(u / L.K), j = Math.floor(w / L.K), gi = i - L.i0, gj = j - L.j0;
    if (gi < 0 || gj < 0 || gi >= L.ni || gj >= L.nj) continue;
    var idx = gi + gj * L.ni, ch = L.grid[idx];
    if (ch) return bilinear(ch, u - i * L.K + 0.5, (j + 1) * L.K + 0.5 - w);
    if (L.listed[idx] === 2) return 0;
    if (L.listed[idx] === 1) listed = true;
  }
  return listed ? 0 : UNKNOWN;
}

function bilinear(ch, fq, fr) {
  var q0 = Math.floor(fq), r0 = Math.floor(fr), wq = fq - q0, wr = fr - r0, W = ch.W, v = ch.v;
  var t = r0 * W + q0;
  var a = v[t], b = v[t + 1], c = v[t + W], d = v[t + W + 1];
  var h = (ch.base + (a * (1 - wq) + b * wq) * (1 - wr) + (c * (1 - wq) + d * wq) * wr) / 10;
  return h > 0 ? h : 0;
}

// ------------------------------------------------------------------ the sweep
function takeArray(len) {
  for (var i = 0; i < pool.length; i++) {
    if (pool[i].length === len) return pool.splice(i, 1)[0];
  }
  return new Uint16Array(len);
}

/* The shade height SH at local (x, z) from a finished level result (its halves plus the data
 * heights at the four texel centres), or null outside the square. */
function shadeHeightAt(res, lv, x, z) {
  var dx = x - res.cx, dz = z - res.cz;
  var fk = (dx * res.wx + dz * res.wz + res.R) / res.c - 0.5, fa = (dx * res.px + dz * res.pz + res.R) / res.c - 0.5;
  var k = Math.floor(fk), a = Math.floor(fa);
  if (k < 0 || a < 0 || k + 1 >= res.n || a + 1 >= res.n) return null;
  var wk = fk - k, wa = fa - a, n = res.n, sum = 0;
  for (var da = 0; da < 2; da++) {
    for (var dk = 0; dk < 2; dk++) {
      var kk = k + dk, aa = a + da;
      var t = (kk + 0.5) * res.c - res.R, v = (aa + 0.5) * res.c - res.R;
      var px = res.cx + res.wx * t + res.px * v, pz = res.cz + res.wz * t + res.pz * v;
      var m = fromHalf(res.m[aa * n + kk]);
      if (m <= M_MIN) return -Infinity;
      var h = sampleAt(lv, px, pz);
      var sh = m + (h <= UNKNOWN ? 0 : h);
      sum += sh * (dk ? wk : 1 - wk) * (da ? wa : 1 - wa);
    }
  }
  return sum;
}

/* One level. sun = {ux, uz, tanE} (u points toward the sun). seed(a, sx, sz) gives the
 * shade height arriving at row a's walk start (sx, sz) and its caster distance, and may
 * ask for `pre` extra cells walked on this level's data before the square begins. gate:
 * optional per-row caster {s0, dG, hc}: a line at distance dG toward the sun from the
 * garden point, of height hc, where s0 is the row start's distance toward the sun. */
function sweep(lv, cx, cz, R, c, sun, seedFn, pre, withD, gate) {
  var n = Math.round(2 * R / c);
  var wx = -sun.ux, wz = -sun.uz, px = -wz, pz = wx;
  var drop = c * sun.tanE, tanE = sun.tanE;
  var ch = withD ? 2 : 1;
  var out = takeArray(n * n * ch);
  var f16 = HAS_F16 ? new Float16Array(out.buffer, out.byteOffset, out.length) : null;
  var K = lv.K, invK = 1 / K, cell = lv.cell, i0 = lv.i0, j0 = lv.j0, ni = lv.ni, nj = lv.nj, grid = lv.grid;
  var du = wx * c / cell, dw = -wz * c / cell;     // per step: E grows with x, N falls as z grows
  // the chunk the walk is in, and its square in level cells (E / cell, N / cell)
  var cu0 = 0, cu1 = -1, cw0 = 0, cw1 = -1, cv = null, cW = 0, cbase = 0, csea = false;
  // and the coarser level's, for the stretches this level has no chunk for
  var L2 = lv.coarser, ratio = L2 ? cell / L2.cell : 0, K2 = L2 ? L2.K : 1, invK2 = 1 / K2;
  var du0 = 0, du1 = -1, dw0 = 0, dw1 = -1, dv = null, dW = 0, dbase = 0;
  for (var a = 0; a < n; a++) {
    var v = (a + 0.5) * c - R;
    var rx = cx + px * v - wx * (R + pre * c), rz = cz + pz * v - wz * (R + pre * c);   // walk start
    var s = seedFn ? seedFn(a, rx, rz) : null;
    var A = s ? s.sh : -Infinity, dA = s ? s.d : 1e9;
    var prevH = -Infinity, Aprev = -Infinity, dAprev = 1e9;
    var gk = -1, gs0 = 0;
    if (gate) {
      gs0 = gate.s0 + pre * c;
      if (gate.dG >= gs0) { var g0 = gate.hc - (gate.dG - gs0) * tanE; if (g0 > A) { A = g0; dA = gate.dG - gs0; } }
      else gk = Math.ceil((gs0 - gate.dG) / c - 0.5);                   // first sample at or past the line
    }
    var x0 = rx + wx * 0.5 * c, z0 = rz + wz * 0.5 * c;
    var u = (x0 + cfg.oe) / cell, w = (cfg.on - z0) / cell;
    var row = a * n;
    for (var k = -pre; k < n; k++, u += du, w += dw) {
      var h;
      if (!(u >= cu0 && u < cu1 && w >= cw0 && w < cw1)) {
        var i = Math.floor(u * invK), j = Math.floor(w * invK), gi = i - i0, gj = j - j0;
        var inGrid = gi >= 0 && gj >= 0 && gi < ni && gj < nj;
        var chunk = inGrid ? grid[gi + gj * ni] : null;
        cu0 = i * K; cu1 = cu0 + K; cw0 = j * K; cw1 = cw0 + K;
        csea = inGrid && lv.listed[gi + gj * ni] === 2;
        if (chunk) { cv = chunk.v; cW = chunk.W; cbase = chunk.base; } else cv = null;
      }
      if (cv) {
        var fq = u - cu0 + 0.5, fr = cw1 + 0.5 - w;
        var q0 = fq | 0, r0 = fr | 0, wq = fq - q0, wr = fr - r0, t = r0 * cW + q0;
        h = (cbase + (cv[t] * (1 - wq) + cv[t + 1] * wq) * (1 - wr) + (cv[t + cW] * (1 - wq) + cv[t + cW + 1] * wq) * wr) / 10;
        if (h < 0) h = 0;
      } else if (csea) {
        h = 0;
      } else {
        var u2 = u * ratio, w2 = w * ratio;
        if (L2 && !(u2 >= du0 && u2 < du1 && w2 >= dw0 && w2 < dw1)) {
          var i2 = Math.floor(u2 * invK2), j2 = Math.floor(w2 * invK2), hi = i2 - L2.i0, hj = j2 - L2.j0;
          var c2 = (hi >= 0 && hj >= 0 && hi < L2.ni && hj < L2.nj) ? L2.grid[hi + hj * L2.ni] : null;
          du0 = i2 * K2; du1 = du0 + K2; dw0 = j2 * K2; dw1 = dw0 + K2;
          if (c2) { dv = c2.v; dW = c2.W; dbase = c2.base; } else dv = null;
        }
        if (L2 && dv) {
          var fq2 = u2 - du0 + 0.5, fr2 = dw1 + 0.5 - w2;
          var q2 = fq2 | 0, r2 = fr2 | 0, wq2 = fq2 - q2, wr2 = fr2 - r2, t2 = r2 * dW + q2;
          h = (dbase + (dv[t2] * (1 - wq2) + dv[t2 + 1] * wq2) * (1 - wr2) + (dv[t2 + dW] * (1 - wq2) + dv[t2 + dW + 1] * wq2) * wr2) / 10;
          if (h < 0) h = 0;          // a chunk not loaded here: the coarser data stands in
        } else {
          var kk = k + pre;
          h = sampleAt(lv, x0 + wx * kk * c, z0 + wz * kk * c);
        }
      }
      var SH, D;
      if (k > -pre) {
        Aprev = A; dAprev = dA;
        if (prevH >= A) { A = prevH - drop; dA = c; } else { A -= drop; dA += c; }
        SH = Aprev - drop; D = dAprev + c;
      } else {
        A -= 0.5 * drop; dA += 0.5 * c; SH = A; D = dA;
      }
      if (k + pre === gk) {
        var sk = gs0 - (k + pre + 0.5) * c, gv = gate.hc - (gate.dG - sk) * tanE;
        if (gv > A) { A = gv; dA = gate.dG - sk; }
        if (gv > SH) { SH = gv; D = gate.dG - sk; }
      }
      prevH = h;
      if (k < 0) continue;
      var M = SH - (h <= UNKNOWN ? 0 : h);
      if (!(M > M_MIN)) M = M_MIN; else if (M > M_MAX) M = M_MAX;
      var o = (row + k) * ch;
      if (f16) f16[o] = M; else out[o] = toHalf(M);
      if (withD) {
        if (D > M_MAX) D = M_MAX;
        if (f16) f16[o + 1] = D; else out[o + 1] = toHalf(D);
      }
    }
  }
  return { cx: cx, cz: cz, R: R, c: c, n: n, wx: wx, wz: wz, px: px, pz: pz, m: out, withD: withD };
}

/* Seeds a finer level's rows from a coarser result: the coarser shade two coarse cells in
 * from the square's edge, carried back upstream to where the walk starts. */
function seedFrom(res, lv, sun, pre, c) {
  return function (a, sx, sz) {
    var back = pre * c;
    var ex = sx - sun.ux * back, ez = sz - sun.uz * back;               // the square's edge
    var sh = shadeHeightAt(res, lv, ex, ez);
    if (sh === null || sh === -Infinity) return null;
    return { sh: sh + back * sun.tanE, d: back };
  };
}

function dirFor(gridBearing, el) {
  var b = gridBearing * Math.PI / 180;
  var e = Math.max(el, 0.01) * Math.PI / 180;
  return { ux: Math.sin(b), uz: -Math.cos(b), tanE: Math.tan(e) };
}

function gateRow(gate, sun, cx, cz, R) {
  if (!gate || !cfg.garden) return null;
  // the row starts lie on a line across the sun; their distance toward the sun from the
  // garden point is the same for every row
  var s0 = (cx - cfg.garden.x) * sun.ux + (cz - cfg.garden.z) * sun.uz + R;
  var ground = sampleAt(order[0], cfg.garden.x, cfg.garden.z);
  var eye = (ground <= UNKNOWN ? 0 : ground) + 1.5;
  return { s0: s0, dG: gate.dG, hc: eye + gate.tanG * gate.dG };
}

function windowLevel(sun, win, q, h5res, gate) {
  var lv = levels.h1;
  if (!lv || !win || !h5res) return null;
  var c5 = h5res.c, c1 = q.h1Cell;
  var pre = Math.round(2 * c5 / c1);
  return sweep(lv, win.x, win.z, q.h1Half, c1, sun, seedFrom(h5res, levels.h5, sun, pre, c1), pre, true, null);
}

function runSun(msg) {
  var t0 = performance.now();
  var q = msg.quality, sun = dirFor(msg.gridBearing, msg.el);
  var ms = {};
  var out = { levels: {} };
  var r20 = null, r5 = null;
  if (levels.h20) {
    var R20 = Math.ceil(levels.h20.radiusSquares / q.h20Cell) * q.h20Cell;
    r20 = sweep(levels.h20, 0, 0, R20, q.h20Cell, sun, null, 0, false, gateRow(msg.gate, sun, 0, 0, R20));
    out.levels.h20 = r20;
  }
  var t1 = performance.now(); ms.h20 = t1 - t0;
  if (levels.h5) {
    var R5 = Math.ceil(levels.h5.radius / q.h5Cell) * q.h5Cell;
    var pre5 = r20 ? Math.round(2 * r20.c / q.h5Cell) : 0;
    r5 = sweep(levels.h5, 0, 0, R5, q.h5Cell, sun, r20 ? seedFrom(r20, levels.h20, sun, pre5, q.h5Cell) : null, pre5, false, null);
    out.levels.h5 = r5;
    if (!keepH5 || keepH5.m.length !== r5.m.length) keepH5 = Object.assign({}, r5, { m: new Uint16Array(r5.m.length) });
    else Object.assign(keepH5, r5, { m: keepH5.m });
    keepH5.m.set(r5.m);
  }
  var t2 = performance.now(); ms.h5 = t2 - t1;
  var r1 = windowLevel(sun, msg.window, q, r5 ? keepH5 : null, msg.gate);
  out.levels.h1 = r1;
  ms.h1 = performance.now() - t2;
  last = { sun: sun, q: q, gate: msg.gate, gridBearing: msg.gridBearing, el: msg.el };
  ms.total = performance.now() - t0;
  out.ms = ms;
  out.dir = { wx: -sun.ux, wz: -sun.uz, px: sun.uz, pz: -sun.ux };
  return out;
}

function runWindow(msg) {
  var t0 = performance.now();
  var out = { levels: {} };
  if (last && keepH5) out.levels.h1 = windowLevel(last.sun, msg.window, last.q, keepH5, last.gate);
  else out.levels.h1 = null;
  out.ms = { h1: performance.now() - t0, total: performance.now() - t0 };
  if (last) out.dir = { wx: -last.sun.ux, wz: -last.sun.uz, px: last.sun.uz, pz: -last.sun.ux };
  return out;
}

// ------------------------------------------------------------------ rays over the data
var EARTH_R = 6371000, REFRACTION_K = 0.13;
function bands(reach) {
  var out = [];
  if (levels.h1) out.push([levels.h1, 1, 1400, 1]);
  if (levels.h5) out.push([levels.h5, levels.h1 ? 1405 : 5, 4900, 5]);
  if (levels.h20) out.push([levels.h20, levels.h5 ? 4920 : 20, reach, 20]);
  return out;
}

/* The highest tan along a ray from (x, z) at eye height y0, marching the data (the finest
 * level that holds each point); `curv` lowers each sample by the facts' curvature and
 * refraction drop. {tan, d}; tan is -Infinity where the ray finds no data. */
function marchRay(x, z, y0, ux, uz, curv, stopTan) {
  var reach = (levels.h20 ? levels.h20.radiusSquares : 0) + Math.hypot(x, z) + 20;
  var best = -Infinity, bestD = 0, bs = bands(reach);
  for (var b = 0; b < bs.length; b++) {
    var lv = bs[b][0], d0 = bs[b][1], d1 = bs[b][2], step = bs[b][3];
    for (var d = d0; d <= d1; d += step) {
      var h = sampleAt(lv, x + ux * d, z + uz * d);
      if (h <= UNKNOWN) continue;
      var t = (h - (curv ? d * d * (1 - REFRACTION_K) / (2 * EARTH_R) : 0) - y0) / d;
      if (t > best) { best = t; bestD = d; if (stopTan !== undefined && best > stopTan) return { tan: best, d: bestD }; }
    }
  }
  return { tan: best, d: bestD };
}

/* Is (x, z), eye metres above the data ground, in direct sun? Flat (no curvature), every
 * caster included, and the far gate. */
function marchPoint(p, gridBearing, el, gate) {
  var lv = order[0], g = sampleAt(lv, p.x, p.z);
  if (g <= UNKNOWN) return { lit: null, level: 'none' };
  var y0 = g + p.eye, b = gridBearing * Math.PI / 180, ux = Math.sin(b), uz = -Math.cos(b);
  var tanE = Math.tan(el * Math.PI / 180);
  if (el <= -1) return { lit: false, ground: g, tan: null, reason: 'night' };
  var r = marchRay(p.x, p.z, y0, ux, uz, false);
  var lit = !(r.tan >= tanE);
  var reason = lit ? 'sun' : 'terrain';
  if (lit && gate && cfg.garden) {
    var s = (p.x - cfg.garden.x) * ux + (p.z - cfg.garden.z) * uz;
    var ge = sampleAt(lv, cfg.garden.x, cfg.garden.z) + 1.5;
    var sh = ge + gate.tanG * gate.dG - (gate.dG - s) * tanE;
    if (gate.dG > s && y0 <= sh) { lit = false; reason = 'gate'; }
  }
  return { lit: lit, ground: g, tan: isFinite(r.tan) ? r.tan : null, dist: r.d, reason: reason };
}

/* The world-only horizon at (x, z), eye metres up: 720 rays by true bearing, with the facts'
 * curvature and refraction drop; degrees, 0 where a ray finds nothing (as the facts do). */
function horizon(x, z, eye) {
  var lv = order[0], g = sampleAt(lv, x, z), y0 = (g <= UNKNOWN ? 0 : g) + eye;
  var deg = new Float64Array(720), dist = new Float64Array(720);
  for (var k = 0; k < 720; k++) {
    var b = (k * 0.5 + cfg.offset) * Math.PI / 180;
    var r = marchRay(x, z, y0, Math.sin(b), -Math.cos(b), true);
    deg[k] = isFinite(r.tan) ? Math.atan(r.tan) * 180 / Math.PI : 0;
    dist[k] = r.d;
  }
  return { profile_deg: deg, distance_m: dist, ground: g };
}

function bytesHeld() {
  var n = 0;
  for (var name in levels) n += levels[name].bytes;
  pool.forEach(function (a) { n += a.byteLength; });
  if (keepH5) n += keepH5.m.byteLength;
  return n;
}

// ------------------------------------------------------------------ messages
function handle(msg) {
  if (msg.type === 'init') {
    cfg.oe = msg.originE; cfg.on = msg.originN; cfg.offset = msg.offset || 0;
    cfg.garden = msg.garden || null;
    levels = {}; order = [];
    (msg.levels || []).forEach(function (rec) { levels[rec.name] = makeLevel(rec); });
    ['h1', 'h5', 'h20'].forEach(function (name) { if (levels[name]) order.push(levels[name]); });
    for (var i = 0; i + 1 < order.length; i++) order[i].coarser = order[i + 1];
    order.forEach(function (L) {
      // the disc holding every square of the level: the farthest square corner from the origin
      var far = 0;
      for (var gi = 0; gi < L.ni; gi++) for (var gj = 0; gj < L.nj; gj++) {
        if (!L.listed[gi + gj * L.ni]) continue;
        var e0 = (L.i0 + gi) * L.S - cfg.oe, n0 = (L.j0 + gj) * L.S - cfg.on;
        for (var ce = 0; ce < 2; ce++) for (var cn = 0; cn < 2; cn++) far = Math.max(far, Math.hypot(e0 + ce * L.S, n0 + cn * L.S));
      }
      L.radiusSquares = far;
      if (!L.radius) L.radius = far;
    });
    return { ok: true };
  }
  if (msg.type === 'heights') { storeChunk(msg); return null; }
  if (msg.type === 'drop') { dropChunks(msg.level, msg.keys || []); return null; }
  if (msg.type === 'return') { (msg.arrays || []).forEach(function (a) { if (a && a.length) pool.push(a); }); while (pool.length > 6) pool.shift(); return null; }
  if (msg.type === 'sun') return runSun(msg);
  if (msg.type === 'window') return runWindow(msg);
  if (msg.type === 'march') {
    return { points: (msg.points || []).map(function (p) { return marchPoint(p, msg.gridBearing, msg.el, msg.gate); }) };
  }
  if (msg.type === 'horizon') {
    if (!derived || derived.x !== msg.x || derived.z !== msg.z) {
      derived = horizon(msg.x, msg.z, msg.eye === undefined ? 1.5 : msg.eye);
      derived.x = msg.x; derived.z = msg.z;
    }
    return { profile_deg: Array.from(derived.profile_deg), distance_m: Array.from(derived.distance_m), ground: derived.ground };
  }
  throw new Error('unknown sun job ' + msg.type);
}

self.onmessage = function (ev) {
  var msg = ev.data, out;
  try {
    out = handle(msg);
  } catch (err) {
    self.postMessage({ id: msg.id, type: msg.type, ok: false, error: String(err && err.message || err) });
    return;
  }
  if (out === null) return;
  out.id = msg.id; out.type = msg.type; out.ok = true; out.bytes = bytesHeld();
  var transfer = [];
  if (out.levels) {
    for (var name in out.levels) if (out.levels[name]) transfer.push(out.levels[name].m.buffer);
  }
  self.postMessage(out, transfer);
};
