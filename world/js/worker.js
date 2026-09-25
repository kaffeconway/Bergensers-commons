/* Commons World: the chunk worker.
 *
 * Plain JavaScript that imports nothing. chunks.js starts a small pool of these
 * as module workers. They keep no state between jobs: every job carries what it needs.
 * A load job fetches one CWH1 height chunk (world/FORMAT.md section 3), inflates it
 * when it starts with the gzip magic, checks it against the hash in its file name,
 * undoes the planar predictor and meshes it:
 *   - h1 as an adaptive right-triangulated irregular network (RTIN) over the chunk's
 *     241 x 241 cell corners, in 15 x 15 tiles of 16 m, with an exact error map, so
 *     every drawn point is within the tolerance tau(d) of the 1 m corner surface.
 *     Skirts hang from its borders. A load also returns the error map, the per-tile
 *     lowest and highest corners, and the chunk's two textures (1 m corner normals and
 *     the class band with a majority mip chain), which the page keeps;
 *   - h5 and h20 as a smooth grid on the chunk's cell corners, with holes where
 *     a finer level covers and skirts on every edge.
 * A mesh job re-extracts an h1 TIN from the data and error map it is sent (or builds
 * the error map first, for tests), or re-meshes an h5 or h20 chunk.
 * A plotSdf job returns the signed distance to the parcel rings over a box.
 * Typed arrays go back to the page as transfers.
 *
 * Local frame (FORMAT.md section 1): x = E - origin_e, z = -(N - origin_n), y up.
 * Mesh positions are relative to the chunk square's north-west corner.
 */
'use strict';

var CACHE_NAME = 'commons-world-chunks-v1';
// When a coarse cell's samples tie, the more specific class wins; sea is last, so coasts
// keep their land.
var CLASS_PRIORITY = [12, 7, 8, 9, 4, 6, 13, 3, 1, 2, 10, 11, 0, 5];
var SEA_Y = -3;              // metres: a corner with two or more sea samples is at most this
var COAST = 0.05;            // a triangle holding sea and land scores at least this x its hypotenuse
var TILE = 16, TILES = 15, NV = 241;
var RK = 1 / (2 * Math.SQRT2 - 2);   // 1.2071: the nested bounding radius per metre of hypotenuse

var cfg = { originE: 0, originN: 0, rings: [] };

// ---------------------------------------------------------------- far palette
/* The far colour per class code (sRGB hex; index 14 is slope rock) and the rock onset in
 * degrees of slope (0: always rock; 90: never). The same table as TERRAIN_PALETTE's `far`
 * and `onset` in terrainmat.js, which the h1 shader fades to with distance: test TT5
 * checks the two entry for entry. Class 12 (building footprint) copies class 6. */
var FAR = [0x9cab78, 0x566f48, 0x8e9166, 0xb0b974, 0x5a8797, 0x3e6b7c, 0xb4ae9e, 0x6e6a63, 0xa9a18f, 0xa08662, 0x8c8b83, 0xeef0ec, 0xb4ae9e, 0xc8b689, 0x88857d];
var ONSET = [34, 40, 45, 45, 90, 90, 55, 90, 90, 90, 0, 60, 55, 50];

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexLinear(hex) {
  return [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255),
          srgbToLinear((hex & 255) / 255)];
}
var FAR_LIN = FAR.map(hexLinear);
function smoothstep(e0, e1, x) {
  var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
// Rock weight from the up component of the ground normal: 0 below the class's onset slope,
// 1 about 3.5 degrees steeper.
function rockWeight(cls, ny) {
  var on = ONSET[cls] === undefined ? 90 : ONSET[cls];
  var c = on <= 0 ? 2 : Math.cos(on * Math.PI / 180);
  return 1 - smoothstep(c - 0.06, c, ny);
}
// The far colour as linear bytes (three.js treats vertex colours as linear).
function farColourBytes(cls, ny) {
  var a = FAR_LIN[cls] || FAR_LIN[0], r = FAR_LIN[14], w = rockWeight(cls, ny);
  return [Math.round((a[0] + (r[0] - a[0]) * w) * 255), Math.round((a[1] + (r[1] - a[1]) * w) * 255),
          Math.round((a[2] + (r[2] - a[2]) * w) * 255)];
}

// ---------------------------------------------------------------- growable buffers
function Grow(Type, cap) { this.a = new Type(cap); this.n = 0; }
Grow.prototype.room = function (k) {
  if (this.n + k > this.a.length) {
    var b = new this.a.constructor(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
};
Grow.prototype.done = function () { return this.a.slice(0, this.n); };

function Mesh(PosType, cap) {
  this.pos = new Grow(PosType, cap * 3);
  this.nor = new Grow(Int8Array, cap * 3);
  this.col = new Grow(Uint8Array, cap * 3);
  this.idx = new Grow(Uint32Array, cap * 2);
  this.verts = 0;
  this.yMin = Infinity;
  this.yMax = -Infinity;
}
Mesh.prototype.vert = function (x, y, z, nx, ny, nz, rgb) {
  var p = this.pos, n = this.nor, c = this.col;
  p.room(3); n.room(3); c.room(3);
  p.a[p.n++] = x; p.a[p.n++] = y; p.a[p.n++] = z;
  n.a[n.n++] = nx; n.a[n.n++] = ny; n.a[n.n++] = nz;
  c.a[c.n++] = rgb[0]; c.a[c.n++] = rgb[1]; c.a[c.n++] = rgb[2];
  if (y < this.yMin) this.yMin = y;
  if (y > this.yMax) this.yMax = y;
  return this.verts++;
};
Mesh.prototype.tri = function (a, b, c) {
  var i = this.idx;
  i.room(3);
  i.a[i.n++] = a; i.a[i.n++] = b; i.a[i.n++] = c;
};
Mesh.prototype.finish = function () {
  var idx = this.idx.done();
  if (this.verts <= 65536) idx = Uint16Array.from(idx);
  return {
    pos: this.pos.done(), nor: this.nor.done(), col: this.col.done(), idx: idx,
    vertices: this.verts, triangles: this.idx.n / 3,
    yMin: this.verts ? this.yMin : 0, yMax: this.verts ? this.yMax : 0
  };
};

// ---------------------------------------------------------------- fetching and decoding
async function gunzip(bytes) {
  var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchBytes(url, useCache) {
  var res = null, cache = null;
  if (useCache && typeof caches !== 'undefined') {
    try { cache = await caches.open(CACHE_NAME); res = await cache.match(url); } catch (e) { cache = null; res = null; }
  }
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
    if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* storage full or refused: fine */ } }
  }
  var bytes = new Uint8Array(await res.arrayBuffer());
  // The file is gzip; a server may already have inflated it (Content-Encoding). Look at the bytes.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  return bytes;
}

function hex(buf) {
  var b = new Uint8Array(buf), s = '';
  for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

// The file name carries the first 8 hex digits of the sha256 of the uncompressed payload.
async function checkHash(url, bytes) {
  var m = /\.([0-9a-f]{8})\.cwh(\.gz)?$/.exec(url.split('?')[0]);
  if (!m || typeof crypto === 'undefined' || !crypto.subtle) return null;
  var digest = hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 8);
  if (digest !== m[1]) throw new Error(url + ': content hash ' + digest + ' does not match its name');
  return digest;
}

function decodeCWH1(bytes) {
  if (bytes.length < 32) throw new Error('too short for a CWH1 header (' + bytes.length + ' bytes)');
  var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'CWH1') throw new Error('not a CWH1 chunk (magic ' + JSON.stringify(magic) + ')');
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var version = bytes[4];
  if (version !== 1) throw new Error('CWH1 version ' + version + ' is not supported (this viewer reads 1)');
  var flags = bytes[5];
  var width = dv.getUint16(6, true), height = dv.getUint16(8, true), cellCm = dv.getUint16(10, true);
  var header = {
    version: version, flags: flags, width: width, height: height, cellCm: cellCm, cell: cellCm / 100,
    cornerEdm: dv.getInt32(12, true), cornerNdm: dv.getInt32(16, true), base: dv.getInt32(20, true),
    epsg: dv.getUint32(24, true), reserved: dv.getUint32(28, true),
    planar: (flags & 1) !== 0, apron: (flags & 2) !== 0, hasClasses: (flags & 4) !== 0
  };
  var count = width * height;
  var expected = 32 + 2 * count + (header.hasClasses ? count : 0);
  if (bytes.length !== expected) throw new Error('CWH1 payload is ' + bytes.length + ' bytes, expected ' + expected);
  var v = new Uint16Array(count);
  for (var t = 0; t < count; t++) v[t] = dv.getUint16(32 + 2 * t, true);
  if (header.planar) planarRestore(v, width, height);
  var classes = header.hasClasses ? bytes.slice(32 + 2 * count, 32 + 3 * count) : null;
  return { header: header, v: v, classes: classes };
}

// v(r,q) = s(r,q) + v(r,q-1) + v(r-1,q) - v(r-1,q-1), mod 65536, zero outside the array.
function planarRestore(v, w, h) {
  for (var r = 0; r < h; r++) {
    var o = r * w;
    for (var q = 0; q < w; q++) {
      var left = q > 0 ? v[o + q - 1] : 0;
      var up = r > 0 ? v[o - w + q] : 0;
      var ul = (q > 0 && r > 0) ? v[o - w + q - 1] : 0;
      v[o + q] = (v[o + q] + left + up - ul) & 0xFFFF;
    }
  }
}

// ---------------------------------------------------------------- shared helpers
function isSea(dm, cls) { return cls === 5 || (dm <= 0 && cls !== 4); }

function pickClass(counts) {
  var best = -1, bestCount = 0;
  for (var p = 0; p < CLASS_PRIORITY.length; p++) {
    var c = CLASS_PRIORITY[p];
    if (counts[c] > bestCount) { best = c; bestCount = counts[c]; }
  }
  return best < 0 ? 0 : best;
}

// ---------------------------------------------------------------- h1: corners and textures
/* Corner (a, b), row a from the north and column b from the west, is the mean of stored
 * samples (a, b), (a, b+1), (a+1, b) and (a+1, b+1), in metres; with two or more of them
 * sea it is at most -3 m and flagged sea (the meshSmooth rule). Float32, as drawn; the
 * page recomputes the same values (chunks.js cornerHeight) for groundAt. */
function checkH1(h) {
  if (!h.apron || h.width !== NV + 1 || h.height !== NV + 1) {
    throw new Error('TIN meshing needs a 242 x 242 chunk with its apron');
  }
}
function tinCorners(d) {
  var h = d.header, W = h.width, base = h.base, v = d.v, cls = d.classes;
  checkH1(h);
  var hC = new Float32Array(NV * NV), sea = new Uint8Array(NV * NV), yVis = 0;
  for (var a = 0; a < NV; a++) {
    for (var b = 0; b < NV; b++) {
      var t0 = a * W + b, sum = 0, ns = 0;
      for (var u = 0; u < 4; u++) {
        var t = u === 0 ? t0 : u === 1 ? t0 + 1 : u === 2 ? t0 + W : t0 + W + 1;
        var dm = base + v[t], c = cls ? cls[t] : 0;
        sum += dm / 10;
        if (isSea(dm, c)) ns++;
      }
      var y = sum / 4, i = a * NV + b;
      if (ns >= 2) { y = Math.min(y, SEA_Y); sea[i] = 1; }
      hC[i] = y;
      if (hC[i] > yVis) yVis = hC[i];
    }
  }
  return { hC: hC, sea: sea, yVis: yVis };
}

// Corner normals from the 2 x 2 samples round each corner: normalize(-gx, 1, -gz).
// Returns the RG8 texture (n.x, n.z as round(c * 127.5 + 127.5)) and Int8 vertex normals.
function tinNormals(d) {
  var h = d.header, W = h.width, v = d.v, cellM = h.cell || 1;
  var tex = new Uint8Array(NV * NV * 2), nor = new Int8Array(NV * NV * 3);
  for (var a = 0; a < NV; a++) {
    for (var b = 0; b < NV; b++) {
      var t = a * W + b, h00 = v[t], h01 = v[t + 1], h10 = v[t + W], h11 = v[t + W + 1];
      var gx = ((h01 + h11) - (h00 + h10)) / (20 * cellM), gz = ((h10 + h11) - (h00 + h01)) / (20 * cellM);
      var inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz), i = a * NV + b;
      tex[2 * i] = Math.round(-gx * inv * 127.5 + 127.5);
      tex[2 * i + 1] = Math.round(-gz * inv * 127.5 + 127.5);
      nor[3 * i] = Math.round(-gx * inv * 127);
      nor[3 * i + 1] = Math.round(inv * 127);
      nor[3 * i + 2] = Math.round(-gz * inv * 127);
    }
  }
  return { tex: tex, nor: nor };
}

/* The class band's majority mip chain below level 0 (which is the band itself): each
 * level is floor(previous / 2) wide, as WebGL requires, and a texel takes the most common
 * class of the 2 x 2 texels under it (3 wide at an odd level's last row or column), ties
 * to CLASS_PRIORITY with sea last. */
function classMips(classes, W) {
  var levels = [], cur = classes, w = W, counts = new Int32Array(16);
  while (w > 1) {
    var nw = Math.max(1, w >> 1), next = new Uint8Array(nw * nw);
    for (var y = 0; y < nw; y++) {
      var y1 = y === nw - 1 ? w : 2 * y + 2;
      for (var x = 0; x < nw; x++) {
        var x1 = x === nw - 1 ? w : 2 * x + 2;
        counts.fill(0);
        for (var yy = 2 * y; yy < y1; yy++) for (var xx = 2 * x; xx < x1; xx++) counts[cur[yy * w + xx] & 15]++;
        next[y * nw + x] = pickClass(counts);
      }
    }
    levels.push(next);
    cur = next; w = nw;
  }
  return levels;
}

// ---------------------------------------------------------------- h1: the RTIN
/* The triangle table and the tile id scheme below are adapted from mapbox/martini
 * (https://github.com/mapbox/martini), which carries this notice:
 *
 *   ISC License
 *
 *   Copyright (c) 2019, Mapbox
 *
 *   Permission to use, copy, modify, and/or distribute this software for any purpose
 *   with or without fee is hereby granted, provided that the above copyright notice
 *   and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 *   REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 *   FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 *   INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 *   OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 *   TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 *   THIS SOFTWARE.
 *
 * Triangle `id` (2 <= id < 1024) of a 16 m tile is found by walking its bits from the
 * lowest: bit 0 picks the root, each later bit a child, the leading 1 ends the walk. A
 * triangle (a, b, c) has its hypotenuse a-b and its right angle at c; its children are
 * id + 2^k = (b, c, m) and id + 2^(k+1) = (c, a, m), with m the hypotenuse midpoint and
 * 2^k <= id < 2^(k+1). Ids below 512 can split (their midpoint is a grid corner); ids
 * 512-1023 are the 1 m triangles. Coordinates are (x, row) within the tile. */
var TRI = (function () {
  var n = 1022, tab = new Int8Array(n * 6), flip = new Uint8Array(1024);
  for (var i = 0; i < n; i++) {
    var id = i + 2, ax = 0, ay = 0, bx = 0, by = 0, cx = 0, cy = 0;
    if (id & 1) { bx = by = cx = TILE; } else { ax = ay = cy = TILE; }
    while ((id >>= 1) > 1) {
      var mx = (ax + bx) >> 1, my = (ay + by) >> 1;
      if (id & 1) { bx = ax; by = ay; ax = cx; ay = cy; } else { ax = bx; ay = by; bx = cx; by = cy; }
      cx = mx; cy = my;
    }
    tab[i * 6] = ax; tab[i * 6 + 1] = ay; tab[i * 6 + 2] = bx; tab[i * 6 + 3] = by; tab[i * 6 + 4] = cx; tab[i * 6 + 5] = cy;
    // up-facing (counter-clockwise seen from above, x east and z south) needs
    // cross(b - a, c - a).y = (b.z - a.z)(c.x - a.x) - (b.x - a.x)(c.z - a.z) > 0
    flip[i + 2] = ((by - ay) * (cx - ax) - (bx - ax) * (cy - ay)) > 0 ? 0 : 1;
  }
  return { tab: tab, flip: flip };
})();

/* The exact error map: for every splittable triangle, the largest visible vertical error
 * over every grid corner in it of not splitting it, kept at its hypotenuse midpoint and
 * maxed up the hierarchy (so a parent's entry is at least its children's). "Visible"
 * clamps both heights at 0 (the water hides what is below). A triangle with all three
 * vertices sea is dropped when drawn, so it reads as 0. One chunk-global array, filled
 * finest level first over all 225 tiles, so tile edges inside a chunk never crack.
 * Rows are scanned as spans, with an incremental plane. Float32 metres. */
function errorsExact(C) {
  var hC = C.hC, sea = C.sea, tab = TRI.tab, E = new Float32Array(NV * NV);
  for (var i = 509; i >= 0; i--) {
    var o = i * 6, lax = tab[o], lay = tab[o + 1], lbx = tab[o + 2], lby = tab[o + 3], lcx = tab[o + 4], lcy = tab[o + 5];
    var L = Math.hypot(lbx - lax, lby - lay);
    var area2 = (lbx - lax) * (lcy - lay) - (lby - lay) * (lcx - lax), sg = area2 > 0 ? 1 : -1;
    // edge functions a*x + b*y + c, inside where all three are >= 0
    var ed = [[lbx, lby, lcx, lcy], [lcx, lcy, lax, lay], [lax, lay, lbx, lby]].map(function (e) {
      return [(e[1] - e[3]) * sg, (e[2] - e[0]) * sg, (e[0] * e[3] - e[1] * e[2]) * sg];
    });
    var y0 = Math.min(lay, lby, lcy), y1 = Math.max(lay, lby, lcy), x0 = Math.min(lax, lbx, lcx), x1 = Math.max(lax, lbx, lcx);
    var spans = [];
    for (var y = y0; y <= y1; y++) {
      var lo = x0, hi = x1;
      for (var k = 0; k < 3; k++) {
        var ea = ed[k][0], kk = ed[k][1] * y + ed[k][2];
        if (ea === 0) { if (kk < 0) { lo = 1; hi = 0; } }
        else if (ea > 0) lo = Math.max(lo, Math.ceil(-kk / ea - 1e-9));
        else hi = Math.min(hi, Math.floor(-kk / ea + 1e-9));
      }
      spans.push(lo, hi);
    }
    for (var ty = 0; ty < TILES; ty++) {
      for (var tx = 0; tx < TILES; tx++) {
        var X = tx * TILE, Y = ty * TILE;
        var ax = lax + X, ay = lay + Y, bx = lbx + X, by = lby + Y, cx = lcx + X, cy = lcy + Y;
        var m = ((ay + by) >> 1) * NV + ((ax + bx) >> 1);
        var ia = ay * NV + ax, ib = by * NV + bx, ic = cy * NV + cx;
        var ha = hC[ia], hb = hC[ib], hc = hC[ic], allSea = sea[ia] && sea[ib] && sea[ic];
        var P = ((hb - ha) * (cy - ay) - (hc - ha) * (by - ay)) / area2;
        var Q = ((hc - ha) * (bx - ax) - (hb - ha) * (cx - ax)) / area2;
        var R = ha - P * ax - Q * ay;
        var e = 0, anySea = 0, anyLand = 0;
        for (var r = 0, yy = y0 + Y; r < spans.length; r += 2, yy++) {
          var slo = spans[r] + X, shi = spans[r + 1] + X;
          if (shi < slo) continue;
          var p = yy * NV + slo, s = P * slo + Q * yy + R;
          for (var x = slo; x <= shi; x++, p++, s += P) {
            var hh = hC[p], hv = hh > 0 ? hh : 0, sv = allSea ? 0 : (s > 0 ? s : 0), dd = hv > sv ? hv - sv : sv - hv;
            if (dd > e) e = dd;
            if (sea[p]) anySea = 1; else anyLand = 1;
          }
        }
        if (anySea && anyLand && COAST * L > e) e = COAST * L;
        if (e > E[m]) E[m] = e;
        if (i < 254) {
          var lc = ((ay + cy) >> 1) * NV + ((ax + cx) >> 1), rc = ((by + cy) >> 1) * NV + ((bx + cx) >> 1);
          if (E[lc] > E[m]) E[m] = E[lc];
          if (E[rc] > E[m]) E[m] = E[rc];
        }
      }
    }
  }
  return E;
}

/* The conservative bound (the phone fallback, errors: 'bound'): a triangle's error is at
 * most its midpoint surplus plus the larger of its children's; an all-sea triangle is
 * bounded by the highest visible height under it. Cheaper, still a guarantee, more
 * triangles. */
function errorsBound(C) {
  var hC = C.hC, sea = C.sea, tab = TRI.tab;
  var E = new Float32Array(NV * NV), HV = new Float32Array(NV * NV), MIX = new Uint8Array(NV * NV);
  for (var p = 0; p < NV * NV; p++) { HV[p] = hC[p] > 0 ? hC[p] : 0; MIX[p] = sea[p] ? 1 : 2; }
  for (var i = 509; i >= 0; i--) {
    var o = i * 6;
    for (var ty = 0; ty < TILES; ty++) {
      for (var tx = 0; tx < TILES; tx++) {
        var X = tx * TILE, Y = ty * TILE;
        var ax = tab[o] + X, ay = tab[o + 1] + Y, bx = tab[o + 2] + X, by = tab[o + 3] + Y, cx = tab[o + 4] + X, cy = tab[o + 5] + Y;
        var m = ((ay + by) >> 1) * NV + ((ax + bx) >> 1);
        var ia = ay * NV + ax, ib = by * NV + bx, ic = cy * NV + cx;
        var childE = 0, childHV = Math.max(HV[ia], HV[ib], HV[ic], HV[m]), mix = MIX[ia] | MIX[ib] | MIX[ic] | MIX[m];
        if (i < 254) {
          var lc = ((ay + cy) >> 1) * NV + ((ax + cx) >> 1), rc = ((by + cy) >> 1) * NV + ((bx + cx) >> 1);
          childE = Math.max(E[lc], E[rc]);
          childHV = Math.max(childHV, HV[lc], HV[rc]);
          mix |= MIX[lc] | MIX[rc];
        }
        var e;
        if (sea[ia] && sea[ib] && sea[ic]) e = childHV;
        else {
          var hm = hC[m] > 0 ? hC[m] : 0, s = (hC[ia] + hC[ib]) / 2;
          e = Math.abs(hm - (s > 0 ? s : 0)) + childE;
        }
        if (mix === 3) { var L = Math.hypot(bx - ax, by - ay); if (COAST * L > e) e = COAST * L; }
        if (e > E[m]) E[m] = e;
        if (childHV > HV[m]) HV[m] = childHV;
        MIX[m] |= mix;
      }
    }
  }
  return E;
}

// Centimetres, rounded up so the guarantee holds, saturating at 655.35 m.
function errorsCm(E) {
  var out = new Uint16Array(E.length);
  for (var i = 0; i < E.length; i++) { var c = Math.ceil(E[i] * 100); out[i] = c > 65535 ? 65535 : c; }
  return out;
}

// Per-tile lowest and highest drawn corner, sea corners at their drawn height.
function tileRange(C) {
  var lo = new Float32Array(TILES * TILES), hi = new Float32Array(TILES * TILES), hC = C.hC;
  for (var ty = 0; ty < TILES; ty++) {
    for (var tx = 0; tx < TILES; tx++) {
      var mn = Infinity, mx = -Infinity;
      for (var a = ty * TILE; a <= ty * TILE + TILE; a++) {
        for (var b = tx * TILE; b <= tx * TILE + TILE; b++) {
          var y = hC[a * NV + b];
          if (y < mn) mn = y;
          if (y > mx) mx = y;
        }
      }
      lo[ty * TILES + tx] = mn; hi[ty * TILES + tx] = mx;
    }
  }
  return { tileMin: lo, tileMax: hi };
}

/* Extract a TIN.
 * tol: {tau} (metres, uniform) or {px, K, tmin, cam: [x, y, z]} with cam in chunk-local
 *   metres: tau(d) = max(tmin, px K d). A triangle splits when its error exceeds tau at
 *   dh = max(0, |m - cam| - 1.2071 L) (horizontal; hypotenuse L, midpoint m) combined with
 *   the chunk-constant dy = max(0, cam.y - highest visible corner). That radius keeps a
 *   graded tolerance free of T-junctions, and every drawn point within tau at its own
 *   distance.
 * borders: [n, e, s, w], each {kind: 'h1' | 'sea' | 'outer', floor: Float32Array(241) or
 *   null}, floor[k] the lowest the neighbouring h5 level can draw at metre k along the side
 *   (N and S run west to east, E and W north to south).
 * Returns {mesh, split}. Skirts: one quad per pair of consecutive used border vertices,
 * unless both are sea, facing out of the chunk; its bottom, with taus = tau at the
 * segment's nearest point to the camera, is
 *   'h1': top - (0.5 + 3 taus); 'sea': min(that, -3);
 *   'outer' with a floor: min(that, the floor's minimum over the segment - 0.5);
 *   'outer' without: top - (16 + 3 taus).
 * mesh.bottoms[side][k] is the skirt bottom at metre k (NaN where there is none). */
function extractTin(C, E16, nor, tol, borders, keepDropped) {
  var hC = C.hC, sea = C.sea, tab = TRI.tab, flip = TRI.flip;
  var uniform = tol.tau !== undefined && tol.tau !== null;
  var tmin = uniform ? Number(tol.tau) : Number(tol.tmin), k = uniform ? 0 : Number(tol.px) * Number(tol.K);
  var cam = uniform ? [0, 0, 0] : tol.cam, camx = cam[0], camz = cam[2];
  var dy = uniform ? 0 : Math.max(0, cam[1] - C.yVis), dy2 = dy * dy;
  function tauAt(dh) { return uniform ? tmin : Math.max(tmin, k * Math.sqrt(dh * dh + dy2)); }
  var split = new Uint8Array(TILES * TILES * 64);
  var tris = new Grow(Int32Array, 4096), dropped = keepDropped ? new Grow(Int32Array, 256) : null;
  var anySplit = false;
  function rec(ax, ay, bx, by, cx, cy, id, bit, tile) {
    var mx = (ax + bx) >> 1, my = (ay + by) >> 1;
    if (id < 512) {
      var e = E16[my * NV + mx];
      if (e > 0) {
        var L = Math.hypot(bx - ax, by - ay);
        var dh = uniform ? 0 : Math.max(0, Math.hypot(mx - camx, my - camz) - RK * L);
        if (e > tauAt(dh) * 100) {
          split[tile * 64 + ((id - 2) >> 3)] |= 1 << ((id - 2) & 7);
          anySplit = true;
          rec(cx, cy, ax, ay, mx, my, id + 2 * bit, 2 * bit, tile);
          rec(bx, by, cx, cy, mx, my, id + bit, 2 * bit, tile);
          return;
        }
      }
    }
    var ia = ay * NV + ax, ib = by * NV + bx, ic = cy * NV + cx;
    if (sea[ia] && sea[ib] && sea[ic]) {
      if (dropped) { dropped.room(3); dropped.a[dropped.n++] = ia; dropped.a[dropped.n++] = ib; dropped.a[dropped.n++] = ic; }
      return;
    }
    tris.room(3);
    tris.a[tris.n++] = ia;
    if (flip[id]) { tris.a[tris.n++] = ic; tris.a[tris.n++] = ib; } else { tris.a[tris.n++] = ib; tris.a[tris.n++] = ic; }
  }
  for (var ty = 0; ty < TILES; ty++) {
    for (var tx = 0; tx < TILES; tx++) {
      var X = tx * TILE, Y = ty * TILE, tile = ty * TILES + tx;
      rec(X + TILE, Y + TILE, X, Y, X, Y + TILE, 2, 2, tile);          // id 2: south-west half
      rec(X, Y, X + TILE, Y + TILE, X + TILE, Y, 3, 2, tile);          // id 3: north-east half
    }
  }
  // vertices: the used corners, in corner order
  var nT = tris.n, T = tris.a, used = new Int32Array(NV * NV).fill(-1), nUsed = 0;
  for (var q = 0; q < nT; q++) if (used[T[q]] < 0) used[T[q]] = nUsed++;
  // (re)number in corner order so the mesh does not depend on the walk
  nUsed = 0;
  for (var ci = 0; ci < NV * NV; ci++) if (used[ci] >= 0) used[ci] = nUsed++;
  // border vertices per side, in order along the side
  function cornerOf(s, kk) { return s === 0 ? kk : s === 1 ? kk * NV + 240 : s === 2 ? 240 * NV + kk : kk * NV; }
  var sides = [], skirtVerts = 0, skirtTris = 0;
  for (var s = 0; s < 4; s++) {
    var bd = borders && borders[s] ? borders[s] : { kind: 'h1', floor: null };
    var list = [];
    for (var kk = 0; kk <= 240; kk++) if (used[cornerOf(s, kk)] >= 0) list.push(kk);
    var bottom = new Float64Array(list.length).fill(Infinity), segs = [];
    for (var j = 1; j < list.length; j++) {
      var k0 = list[j - 1], k1 = list[j], i0 = cornerOf(s, k0), i1 = cornerOf(s, k1);
      if (sea[i0] && sea[i1]) continue;
      // the segment's nearest point to the camera (chunk-local, horizontal)
      var taus = tmin;
      if (!uniform) {
        var px0 = s === 0 || s === 2 ? k0 : (s === 1 ? 240 : 0), pz0 = s === 1 || s === 3 ? k0 : (s === 2 ? 240 : 0);
        var px1 = s === 0 || s === 2 ? k1 : px0, pz1 = s === 1 || s === 3 ? k1 : pz0;
        var sx = Math.max(Math.min(camx, Math.max(px0, px1)), Math.min(px0, px1));
        var sz = Math.max(Math.min(camz, Math.max(pz0, pz1)), Math.min(pz0, pz1));
        taus = tauAt(Math.hypot(sx - camx, sz - camz));
      }
      var D = 0.5 + 3 * taus, ends = [[j - 1, i0], [j, i1]];
      var fmin = Infinity;
      if (bd.kind === 'outer' && bd.floor) for (var f = k0; f <= k1; f++) fmin = Math.min(fmin, bd.floor[f]);
      for (var e2 = 0; e2 < 2; e2++) {
        var top = hC[ends[e2][1]], b;
        if (bd.kind === 'sea') b = Math.min(top - D, SEA_Y);
        else if (bd.kind === 'outer') b = bd.floor ? Math.min(top - D, fmin - 0.5) : top - (16 + 3 * taus);
        else b = top - D;
        if (b < bottom[ends[e2][0]]) bottom[ends[e2][0]] = b;
      }
      segs.push(j);
      skirtTris += 2;
    }
    var hasBottom = new Uint8Array(list.length);
    for (var g = 0; g < segs.length; g++) { hasBottom[segs[g] - 1] = 1; hasBottom[segs[g]] = 1; }
    for (var g2 = 0; g2 < list.length; g2++) if (hasBottom[g2]) skirtVerts++;
    sides.push({ list: list, bottom: bottom, segs: segs, hasBottom: hasBottom });
  }
  var nVerts = nUsed + skirtVerts;
  var pos = new Float32Array(nVerts * 3), nrm = new Int8Array(nVerts * 3);
  var idx = nVerts <= 65536 ? new Uint16Array(nT + skirtTris * 3) : new Uint32Array(nT + skirtTris * 3);
  var yMin = Infinity, yMax = -Infinity;
  for (var cj = 0; cj < NV * NV; cj++) {
    var vi = used[cj];
    if (vi < 0) continue;
    var y = hC[cj];
    pos[vi * 3] = cj % NV; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = (cj / NV) | 0;
    nrm[vi * 3] = nor[cj * 3]; nrm[vi * 3 + 1] = nor[cj * 3 + 1]; nrm[vi * 3 + 2] = nor[cj * 3 + 2];
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  for (var q2 = 0; q2 < nT; q2++) idx[q2] = used[T[q2]];
  var nv = nUsed, ni = nT, bottoms = [];
  for (var s2 = 0; s2 < 4; s2++) {
    var S = sides[s2], bvi = new Int32Array(S.list.length).fill(-1), bot = new Float32Array(NV).fill(NaN);
    for (var g3 = 0; g3 < S.list.length; g3++) {
      if (!S.hasBottom[g3]) continue;
      var topV = used[cornerOf(s2, S.list[g3])], by2 = S.bottom[g3];
      bvi[g3] = nv;
      pos[nv * 3] = pos[topV * 3]; pos[nv * 3 + 1] = by2; pos[nv * 3 + 2] = pos[topV * 3 + 2];
      nrm[nv * 3] = nrm[topV * 3]; nrm[nv * 3 + 1] = nrm[topV * 3 + 1]; nrm[nv * 3 + 2] = nrm[topV * 3 + 2];
      if (by2 < yMin) yMin = by2;
      nv++;
    }
    for (var g4 = 0; g4 < S.segs.length; g4++) {
      var jj = S.segs[g4], A = used[cornerOf(s2, S.list[jj - 1])], B = used[cornerOf(s2, S.list[jj])];
      var Ab = bvi[jj - 1], Bb = bvi[jj];
      // A comes first along the side: west to east on N and S, north to south on E and W.
      if (s2 === 0 || s2 === 1) { idx[ni++] = A; idx[ni++] = B; idx[ni++] = Bb; idx[ni++] = A; idx[ni++] = Bb; idx[ni++] = Ab; }
      else { idx[ni++] = B; idx[ni++] = A; idx[ni++] = Ab; idx[ni++] = B; idx[ni++] = Ab; idx[ni++] = Bb; }
      var ka = S.list[jj - 1], kb = S.list[jj], ya = S.bottom[jj - 1], yb = S.bottom[jj];
      for (var km = ka; km <= kb; km++) {
        var val = ya + (yb - ya) * (km - ka) / (kb - ka);
        if (!(bot[km] <= val)) bot[km] = val;
      }
    }
    bottoms.push(bot);
  }
  var mesh = {
    pos: pos, nor: nrm, idx: idx, vertices: nVerts, triangles: (nT + skirtTris * 3) / 3,
    surfaceTriangles: nT / 3, skirtTriangles: skirtTris,
    yMin: nVerts ? yMin : 0, yMax: nVerts ? yMax : 0, floor: !anySplit, bottoms: bottoms,
    snap: uniform ? null : [cam[0], cam[1], cam[2]]
  };
  if (keepDropped) {
    mesh.dropped = dropped.done();
    var corner = new Int32Array(nVerts).fill(-1);
    for (var c3 = 0; c3 < NV * NV; c3++) if (used[c3] >= 0) corner[used[c3]] = c3;
    mesh.corner = corner;
  }
  return { mesh: mesh, split: split };
}

// Everything an h1 load computes once from the decoded chunk.
function prepareTin(d, errors) {
  var C = tinCorners(d);
  var E = errors === 'bound' ? errorsBound(C) : errorsExact(C);
  var n = tinNormals(d), r = tileRange(C);
  var cls = d.classes || new Uint8Array(d.header.width * d.header.height);
  return { C: C, E16: errorsCm(E), nor: n.nor, normalTex: n.tex, tileMin: r.tileMin, tileMax: r.tileMax,
           mips: classMips(cls, d.header.width) };
}

// ---------------------------------------------------------------- smooth grid (h5, h20)
/* o: {stride (in cells), holeCells (corner cells per hole square), holeGrid (squares
 * per side), holes (Uint8Array, row-major from the north), skirt (metres)}.
 * Vertices sit on cell corners, each the mean of the four samples around it, so two
 * neighbouring chunks compute identical edges from their aprons. Quads whose four
 * corners are all sea are left out (the water plane is opaque). Colours are the far
 * palette (FAR), mixed toward slope rock by the onset table, as the h1 texture fades to.
 */
function meshSmooth(d, o) {
  var h = d.header, W = h.width, K = W - 2, c = h.cell, s = o.stride | 0;
  if (!h.apron || h.height !== W) throw new Error('smooth meshing needs a square chunk with its apron');
  if (s < 1 || K % s) throw new Error('stride ' + s + ' does not divide ' + K);
  var nv = K / s + 1, base = h.base, v = d.v, cls = d.classes;
  var hC = new Float32Array(nv * nv), seaC = new Uint8Array(nv * nv), clsC = new Uint8Array(nv * nv);
  var nxC = new Float32Array(nv * nv), nzC = new Float32Array(nv * nv);
  var counts = new Int32Array(16);
  for (var a = 0; a < nv; a++) {
    for (var b = 0; b < nv; b++) {
      var rr = a * s, kk = b * s;
      var t00 = rr * W + kk, t01 = t00 + 1, t10 = t00 + W, t11 = t10 + 1;
      var ts = [t00, t01, t10, t11], hs = [0, 0, 0, 0], sea = 0, sum = 0;
      counts.fill(0);
      for (var u = 0; u < 4; u++) {
        var dmv = base + v[ts[u]], cc = cls ? cls[ts[u]] : 0;
        hs[u] = dmv / 10; sum += hs[u];
        if (isSea(dmv, cc)) sea++; else if (cc < 16) counts[cc]++;
      }
      var i = a * nv + b, y = sum / 4;
      if (sea >= 2) { y = Math.min(y, -3); seaC[i] = 1; }
      hC[i] = y;
      nxC[i] = ((hs[1] + hs[3]) - (hs[0] + hs[2])) / (2 * c);
      nzC[i] = ((hs[2] + hs[3]) - (hs[0] + hs[1])) / (2 * c);
      clsC[i] = sea === 4 ? 5 : pickClass(counts);
    }
  }
  var m = new Mesh(Float32Array, nv * nv + 4096);
  for (i = 0; i < nv * nv; i++) {
    var len = Math.sqrt(nxC[i] * nxC[i] + 1 + nzC[i] * nzC[i]);
    m.vert((i % nv) * s * c, hC[i], Math.floor(i / nv) * s * c,
           Math.round(-nxC[i] / len * 127), Math.round(1 / len * 127), Math.round(-nzC[i] / len * 127),
           farColourBytes(clsC[i], 1 / len));
  }
  var holeCells = o.holeCells | 0, g = o.holeGrid | 0, holes = o.holes;
  function hole(qa, qb) {
    if (!holes) return false;
    return holes[Math.floor(qa * s / holeCells) * g + Math.floor(qb * s / holeCells)] === 1;
  }
  var nq = nv - 1;
  function drawn(qa, qb) {
    if (qa < 0 || qb < 0 || qa >= nq || qb >= nq) return false;
    if (hole(qa, qb)) return false;
    var i0 = qa * nv + qb;
    return !(seaC[i0] && seaC[i0 + 1] && seaC[i0 + nv] && seaC[i0 + nv + 1]);
  }
  function needsSkirt(qa, qb) {
    // outside the chunk, or a hole: something else must meet this edge
    return qa < 0 || qb < 0 || qa >= nq || qb >= nq || hole(qa, qb);
  }
  var D = o.skirt || 20;
  var skirtNormal = function (i) { return [m.nor.a[i * 3], m.nor.a[i * 3 + 1], m.nor.a[i * 3 + 2]]; };
  function skirt(iTopA, iTopB) {
    // a vertical strip below the edge from vertex iTopA to iTopB, in that order;
    // the caller orders them so the strip faces out of the drawn quad.
    var pa = [m.pos.a[iTopA * 3], m.pos.a[iTopA * 3 + 1], m.pos.a[iTopA * 3 + 2]];
    var pb = [m.pos.a[iTopB * 3], m.pos.a[iTopB * 3 + 1], m.pos.a[iTopB * 3 + 2]];
    var na = skirtNormal(iTopA), nb = skirtNormal(iTopB);
    var ca = [m.col.a[iTopA * 3], m.col.a[iTopA * 3 + 1], m.col.a[iTopA * 3 + 2]];
    var cb = [m.col.a[iTopB * 3], m.col.a[iTopB * 3 + 1], m.col.a[iTopB * 3 + 2]];
    var v0 = m.vert(pa[0], pa[1], pa[2], na[0], na[1], na[2], ca);
    m.vert(pa[0], pa[1] - D, pa[2], na[0], na[1], na[2], ca);
    m.vert(pb[0], pb[1] - D, pb[2], nb[0], nb[1], nb[2], cb);
    m.vert(pb[0], pb[1], pb[2], nb[0], nb[1], nb[2], cb);
    m.tri(v0, v0 + 1, v0 + 2);
    m.tri(v0, v0 + 2, v0 + 3);
  }
  var quads = 0;
  for (var qa = 0; qa < nq; qa++) {
    for (var qb = 0; qb < nq; qb++) {
      if (!drawn(qa, qb)) continue;
      quads++;
      var nw = qa * nv + qb, ne = nw + 1, sw = nw + nv, se = sw + 1;
      m.tri(nw, sw, se);
      m.tri(nw, se, ne);
      if (needsSkirt(qa - 1, qb)) skirt(ne, nw);   // north edge, facing -z
      if (needsSkirt(qa + 1, qb)) skirt(sw, se);   // south edge, facing +z
      if (needsSkirt(qa, qb + 1)) skirt(se, ne);   // east edge, facing +x
      if (needsSkirt(qa, qb - 1)) skirt(nw, sw);   // west edge, facing -x
    }
  }
  var out = m.finish();
  out.quads = quads;
  return out;
}

// ---------------------------------------------------------------- the plot
/* Signed distance in metres to the parcel rings over bbox [x0, z0, x1, z1] (local), on an
 * n x n grid of texel centres, row-major with rows along z from z0: the distance to the
 * nearest ring edge, negative inside (even-odd over every ring and hole). */
function plotSdf(bbox, n) {
  var x0 = bbox[0], z0 = bbox[1], dx = (bbox[2] - bbox[0]) / n, dz = (bbox[3] - bbox[1]) / n;
  var out = new Float32Array(n * n), rings = cfg.rings;
  for (var j = 0; j < n; j++) {
    var z = z0 + (j + 0.5) * dz;
    for (var i = 0; i < n; i++) {
      var x = x0 + (i + 0.5) * dx, best = Infinity, inside = false;
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r], m = ring.length / 2;
        for (var a = 0, b = m - 1; a < m; b = a++) {
          var xa = ring[2 * a], za = ring[2 * a + 1], xb = ring[2 * b], zb = ring[2 * b + 1];
          if ((za > z) !== (zb > z) && x < (xb - xa) * (z - za) / (zb - za) + xa) inside = !inside;
          var ex = xb - xa, ez = zb - za, l2 = ex * ex + ez * ez;
          var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xa) * ex + (z - za) * ez) / l2)) : 0;
          var qx = xa + t * ex - x, qz = za + t * ez - z, d2 = qx * qx + qz * qz;
          if (d2 < best) best = d2;
        }
      }
      var dd = Math.sqrt(best);
      out[j * n + i] = inside ? -dd : dd;
    }
  }
  return out;
}

// ---------------------------------------------------------------- jobs
function transferables(out) {
  var list = [];
  function add(a) { if (a && a.buffer && list.indexOf(a.buffer) < 0) list.push(a.buffer); }
  add(out.v); add(out.classes); add(out.E); add(out.tileMin); add(out.tileMax); add(out.split); add(out.sdf);
  if (out.tex) { add(out.tex.normal); (out.tex.classMips || []).forEach(add); }
  if (out.mesh) {
    add(out.mesh.pos); add(out.mesh.nor); add(out.mesh.col); add(out.mesh.idx);
    add(out.mesh.dropped); add(out.mesh.corner);
    (out.mesh.bottoms || []).forEach(add);
  }
  return list;
}

// A TIN from decoded data: E16 given (the page's copy) or built here (tests).
function tinJob(d, msg, out) {
  var o = msg.opts || {};
  var C = tinCorners(d), E16 = msg.E, nor;
  if (!E16) E16 = errorsCm(o.errors === 'bound' ? errorsBound(C) : errorsExact(C));
  nor = tinNormals(d).nor;
  var tol = o.tau !== undefined && o.tau !== null ? { tau: o.tau } : { px: o.px, K: o.K, tmin: o.tmin, cam: o.cam };
  var r = extractTin(C, E16, nor, tol, o.borders, !!o.keepDropped);
  out.mesh = r.mesh; out.split = r.split;
}

async function handle(msg) {
  if (msg.type === 'init') {
    cfg.originE = msg.originE; cfg.originN = msg.originN;
    cfg.rings = (msg.rings || []).map(function (r) { return Float64Array.from(r); });
    return { ok: true };
  }
  var t0 = performance.now(), d, out = { ok: true, seq: msg.seq };
  if (msg.type === 'plotSdf') {
    out.sdf = plotSdf(msg.bbox, msg.texels | 0);
    out.ms = performance.now() - t0;
    return out;
  }
  if (msg.type === 'load' || msg.type === 'decode') {
    var bytes = await fetchBytes(msg.url, !!msg.useCache);
    out.hash = await checkHash(msg.url, bytes);
    d = decodeCWH1(bytes);
    // FORMAT.md: a chunk whose header disagrees with where the manifest puts it is refused,
    // never drawn somewhere else.
    var want = msg.expect || {};
    for (var key of ['cellCm', 'cornerEdm', 'cornerNdm', 'epsg', 'width', 'height']) {
      if (want[key] !== undefined && d.header[key] !== want[key]) {
        throw new Error(msg.url + ': header ' + key + ' is ' + d.header[key] + ', the manifest key says ' + want[key]);
      }
    }
    out.header = d.header; out.v = d.v; out.classes = d.classes;
    if (msg.type === 'decode') return out;
    if (msg.mode === 'tin') {
      var o = msg.opts || {};
      var P = prepareTin(d, o.errors);
      var tol = o.tau !== undefined && o.tau !== null ? { tau: o.tau } : { px: o.px, K: o.K, tmin: o.tmin, cam: o.cam };
      var r = extractTin(P.C, P.E16, P.nor, tol, o.borders, false);
      out.E = P.E16; out.tileMin = P.tileMin; out.tileMax = P.tileMax;
      out.tex = { normal: P.normalTex, classMips: P.mips };
      out.mesh = r.mesh; out.split = r.split;
      out.ms = performance.now() - t0;
      return out;
    }
  } else if (msg.type === 'mesh') {
    d = msg.data;
    if (msg.mode === 'tin') {
      tinJob(d, msg, out);
      out.ms = performance.now() - t0;
      return out;
    }
  } else {
    throw new Error('unknown job type ' + msg.type);
  }
  if (msg.mode !== 'smooth') throw new Error('unknown mesh mode ' + msg.mode);
  out.mesh = meshSmooth(d, msg.opts);
  out.ms = performance.now() - t0;
  return out;
}

self.onmessage = function (ev) {
  var msg = ev.data;
  handle(msg).then(function (out) {
    out.id = msg.id;
    self.postMessage(out, transferables(out));
  }, function (err) {
    self.postMessage({ id: msg.id, seq: msg.seq, ok: false, error: String(err && err.message || err) });
  });
};
