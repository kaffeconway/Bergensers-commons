/* Commons World: the chunk worker.
 *
 * Plain JavaScript that imports nothing. chunks.js starts a small pool of these
 * as module workers. A job fetches one CWH1 height chunk (world/FORMAT.md
 * section 3), inflates it when it starts with the gzip magic, checks it against
 * the hash in its file name, undoes the planar predictor and meshes it:
 *   - h1 as block columns (greedy-merged tops and walls, 1, 2 or 4 m cells);
 *   - h5 and h20 as a smooth grid on the chunk's cell corners, with holes where
 *     a finer level covers and skirts on every edge.
 * Typed arrays go back to the page as transfers.
 *
 * Local frame (FORMAT.md section 1): x = E - origin_e, z = -(N - origin_n), y up.
 * Mesh positions are relative to the chunk square's north-west corner.
 */
'use strict';

var CACHE_NAME = 'commons-world-chunks-v1';
var SEA_FLOOR = -2;          // metres: what a wall sees on the far side of a sea cell
var LINE_CLASSES = { 7: 1, 8: 1, 9: 1 };
// When a coarse cell's samples tie, the more specific class wins.
var CLASS_PRIORITY = [12, 7, 8, 9, 4, 6, 13, 3, 1, 2, 10, 11, 0];

var cfg = { originE: 0, originN: 0, rings: [], plotBox: null };

// ---------------------------------------------------------------- palette
// sRGB hex, turned into linear bytes (three.js treats vertex colours as linear).
var TOP_HEX = {
  0: 0x9cab78,   // open land
  1: 0x566f48,   // forest
  2: 0x8e9166,   // bog, marsh
  3: 0xb0b974,   // farmland
  4: 0x5a8797,   // lake, river
  5: 0x3e6b7c,   // sea (tops are not drawn; used by the smooth levels under water)
  6: 0xb4ae9e,   // built-up
  7: 0x6e6a63,   // road
  8: 0xa9a18f,   // footway
  9: 0xa08662,   // path
  10: 0x8c8b83,  // bare rock
  11: 0xeef0ec,  // snow
  12: 0x857e72,  // building footprint
  13: 0xc8b689   // sand, gravel
};
var WALL_HEX = {
  earth: 0x806a52, rock: 0x7d7b74, snow: 0xcfd2ce, sand: 0xa68e66, made: 0x8a847a, water: 0x4b6f7c
};
var PLOT_LIGHT = 0xe2bf93;   // parcel interior: a light warm wash
var PLOT_STRONG = 0xb8552f;  // parcel boundary cells
var SLOPE_SHADE = [1.0, 0.9, 0.8, 0.7];

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexParts(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function toBytes(rgb) {
  return [Math.round(srgbToLinear(rgb[0]) * 255), Math.round(srgbToLinear(rgb[1]) * 255),
          Math.round(srgbToLinear(rgb[2]) * 255)];
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

var topCache = {};
// key = cls * 16 + slope * 4 + tint
function topColour(key) {
  var c = topCache[key];
  if (c) return c;
  var cls = key >> 4, slope = (key >> 2) & 3, tint = key & 3;
  var rgb = hexParts(TOP_HEX[cls] !== undefined ? TOP_HEX[cls] : TOP_HEX[0]);
  if (tint === 1) rgb = mix(rgb, hexParts(PLOT_LIGHT), 0.35);
  else if (tint === 2) rgb = mix(rgb, hexParts(PLOT_STRONG), 0.8);
  var s = SLOPE_SHADE[slope];
  c = toBytes([rgb[0] * s, rgb[1] * s, rgb[2] * s]);
  topCache[key] = c;
  return c;
}
var wallCache = {};
function wallKind(cls) {
  if (cls === 10) return 'rock';
  if (cls === 11) return 'snow';
  if (cls === 13) return 'sand';
  if (cls === 6 || cls === 7 || cls === 8 || cls === 12) return 'made';
  if (cls === 5) return 'water';
  return 'earth';
}
function wallColour(cls) {
  var c = wallCache[cls];
  if (!c) { c = toBytes(hexParts(WALL_HEX[wallKind(cls)])); wallCache[cls] = c; }
  return c;
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
// Four vertices in order; triangles (0,1,2) and (0,2,3). The caller orders them so
// that (v1 - v0) x (v2 - v0) points along the face normal (counter-clockwise front).
Mesh.prototype.quad = function (v0, v1, v2, v3, nx, ny, nz, rgb) {
  var a = this.vert(v0[0], v0[1], v0[2], nx, ny, nz, rgb);
  this.vert(v1[0], v1[1], v1[2], nx, ny, nz, rgb);
  this.vert(v2[0], v2[1], v2[2], nx, ny, nz, rgb);
  this.vert(v3[0], v3[1], v3[2], nx, ny, nz, rgb);
  this.tri(a, a + 1, a + 2);
  this.tri(a, a + 2, a + 3);
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

// ---------------------------------------------------------------- plot polygon
function pointInPlot(x, z) {
  var b = cfg.plotBox;
  if (!b || x < b[0] || x > b[2] || z < b[1] || z > b[3]) return false;
  var inside = false, rings = cfg.rings;
  for (var k = 0; k < rings.length; k++) {
    var ring = rings[k], n = ring.length / 2;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = ring[2 * i], zi = ring[2 * i + 1], xj = ring[2 * j], zj = ring[2 * j + 1];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
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

function slopeBucket(tan) {
  if (tan < 0.5774) return 0;   // under 30 degrees
  if (tan < 1.0) return 1;      // under 45
  if (tan < 1.7321) return 2;   // under 60
  return 3;
}

// ---------------------------------------------------------------- blocks (h1)
/* d: {header, v, classes}. o: {lod: 1|2|4, x0, z0 (local coordinates of the chunk
 * square's north-west corner), edgeAbsent: [n, e, s, w], tint: bool; optional
 * step: height step in metres (default 1), shade: slope darkening (default true),
 * floors: [n, e, s, w], each null or the lowest top the loaded neighbour across that
 * edge can draw, per metre along it (chunks.js edgeFloor)}.
 * A coarse cell of L x L samples takes the rounded mean height of its land samples
 * (1 m steps), is sea when most of its samples are, and takes the majority class.
 * Walls inside the chunk are emitted once, by the higher cell. On the chunk border
 * the neighbour's top is estimated from the apron and, when given, its floor, and every
 * border cell hangs a wall ("skirt") below the lower of the two, deep enough to cover
 * the neighbour however its level of detail rounds: the lower side's skirt is always
 * underground. The apron alone sees one sample into the neighbour, not a drop inside
 * its coarse cells; that is what the floors are for. The result carries edgeBottom:
 * how far down the border walls reach, per metre along each edge (-32768 where the
 * border cell is sea and has no wall), so the page can tell when a re-mesh is needed.
 */
function meshBlocks(d, o) {
  var h = d.header, W = h.width, K = W - 2, L = o.lod | 0;
  if (!h.apron || h.height !== W) throw new Error('block meshing needs a square chunk with its apron');
  if (L < 1 || K % L) throw new Error('block size ' + L + ' does not divide ' + K);
  var n = K / L, base = h.base, v = d.v, cls = d.classes, N = W * W;
  var step = o.step > 1 ? o.step | 0 : 1, shade = o.shade !== false;
  var dm = new Int32Array(N), top1 = new Int32Array(N), sea1 = new Uint8Array(N);
  for (var t = 0; t < N; t++) {
    var hv = base + v[t], c = cls ? cls[t] : 0, s = isSea(hv, c);
    dm[t] = hv; sea1[t] = s ? 1 : 0;
    top1[t] = s ? SEA_FLOOR : Math.floor((hv + 5) / 10);
  }
  var nn = n * n;
  var ctop = new Int32Array(nn), csea = new Uint8Array(nn), ckey = new Uint16Array(nn), ccls = new Uint8Array(nn);
  var counts = new Int32Array(16);
  var tinted = 0, strong = 0, doTint = o.tint && cfg.rings.length > 0;
  for (var A = 0; A < n; A++) {
    for (var B = 0; B < n; B++) {
      var r0 = 1 + A * L, q0 = 1 + B * L, seaCount = 0, sum = 0, land = 0;
      counts.fill(0);
      for (var a = 0; a < L; a++) {
        for (var b = 0; b < L; b++) {
          var ts = (r0 + a) * W + q0 + b;
          if (sea1[ts]) { seaCount++; continue; }
          sum += dm[ts]; land++;
          var cc = cls ? cls[ts] : 0;
          if (cc < 16) counts[cc] += (L > 1 && LINE_CLASSES[cc]) ? 2 : 1;
        }
      }
      var ci = A * n + B;
      if (doTint) {
        var cx = o.x0 + (B + 0.5) * L, cz = o.z0 + (A + 0.5) * L;
        if (pointInPlot(cx, cz)) {
          tinted++;
          var edge = !pointInPlot(cx + L, cz) || !pointInPlot(cx - L, cz) ||
                     !pointInPlot(cx, cz + L) || !pointInPlot(cx, cz - L);
          if (edge) strong++;
          ckey[ci] = edge ? 2 : 1;
        }
      }
      if (seaCount * 2 > L * L || land === 0) {
        csea[ci] = 1; ctop[ci] = SEA_FLOOR; ccls[ci] = 5;
        continue;
      }
      // round half up to whole metres, or to multiples of `step` metres when asked
      ctop[ci] = step * Math.floor((sum + 5 * step * land) / (10 * step * land));
      var k = pickClass(counts);
      ccls[ci] = k;
      // slope across the cell, from the samples just outside it (the apron supplies the edges)
      var rc = r0 + (L >> 1), qc = q0 + (L >> 1);
      var gx = (landDm(dm, sea1, rc * W + q0 + L) - landDm(dm, sea1, rc * W + q0 - 1)) / (10 * (L + 1));
      var gz = (landDm(dm, sea1, (r0 + L) * W + qc) - landDm(dm, sea1, (r0 - 1) * W + qc)) / (10 * (L + 1));
      ckey[ci] = (k << 4) | ((shade ? slopeBucket(Math.sqrt(gx * gx + gz * gz)) : 0) << 2) | ckey[ci];
    }
  }

  var m = new Mesh(Int16Array, 16384);
  // tops: greedy rectangles of equal height and colour
  var done = new Uint8Array(nn);
  for (A = 0; A < n; A++) {
    for (B = 0; B < n; B++) {
      ci = A * n + B;
      if (done[ci] || csea[ci]) continue;
      var ht = ctop[ci], key = ckey[ci], w = 1;
      while (B + w < n) {
        var cj = ci + w;
        if (done[cj] || csea[cj] || ctop[cj] !== ht || ckey[cj] !== key) break;
        w++;
      }
      var hh = 1;
      grow: while (A + hh < n) {
        for (var q = 0; q < w; q++) {
          cj = (A + hh) * n + B + q;
          if (done[cj] || csea[cj] || ctop[cj] !== ht || ckey[cj] !== key) break grow;
        }
        hh++;
      }
      for (a = 0; a < hh; a++) for (q = 0; q < w; q++) done[(A + a) * n + B + q] = 1;
      var x0 = B * L, x1 = (B + w) * L, z0 = A * L, z1 = (A + hh) * L;
      m.quad([x0, ht, z0], [x0, ht, z1], [x1, ht, z1], [x1, ht, z0], 0, 127, 0, topColour(key));
    }
  }

  // walls
  var absent = o.edgeAbsent || [false, false, false, false];
  var floors = o.floors || null;
  var edgeBottom = [new Int16Array(K), new Int16Array(K), new Int16Array(K), new Int16Array(K)];
  for (var eb = 0; eb < 4; eb++) edgeBottom[eb].fill(-32768);
  function wallTop(i) { return csea[i] ? SEA_FLOOR : ctop[i]; }
  // Border estimate for one cell side: [neighbour estimate, skirt depth]. side: 0 N, 1 E, 2 S, 3 W.
  function border(A, B, side) {
    var est = Infinity, diff = 0, i, r, q, t1, t2;
    for (i = -1; i <= L; i++) {
      if (side === 1 || side === 3) {
        r = 1 + A * L + i; if (r < 0 || r > W - 1) continue;
        q = side === 1 ? W - 1 : 0;
        t1 = top1[r * W + q]; t2 = top1[r * W + (side === 1 ? W - 2 : 1)];
        if (r + 1 <= W - 1) diff = Math.max(diff, Math.abs(t1 - top1[(r + 1) * W + q]));
      } else {
        q = 1 + B * L + i; if (q < 0 || q > W - 1) continue;
        r = side === 2 ? W - 1 : 0;
        t1 = top1[r * W + q]; t2 = top1[(side === 2 ? W - 2 : 1) * W + q];
        if (q + 1 <= W - 1) diff = Math.max(diff, Math.abs(t1 - top1[r * W + q + 1]));
      }
      diff = Math.max(diff, Math.abs(t1 - t2));
      if (i >= 0 && i < L && t1 < est) est = t1;
    }
    var f = floors && floors[side];
    if (f) {
      var k0 = (side === 1 || side === 3) ? A * L : B * L;
      for (i = 0; i < L; i++) if (f[k0 + i] < est) est = f[k0 + i];
    }
    var depth = Math.min(300, 2 + 4 * diff + (absent[side] ? 8 : 0));
    return [est, depth];
  }
  // One wall face of cell (A, B) on `side`, as [top, bottom, class] or null.
  function face(A, B, side) {
    var ci = A * n + B;
    if (csea[ci]) return null;
    var top = ctop[ci], bottom;
    var nA = A + (side === 2 ? 1 : side === 0 ? -1 : 0), nB = B + (side === 1 ? 1 : side === 3 ? -1 : 0);
    if (nA >= 0 && nA < n && nB >= 0 && nB < n) {
      bottom = wallTop(nA * n + nB);
      if (bottom >= top) return null;
    } else {
      var e = border(A, B, side);
      bottom = Math.min(top, e[0]) - e[1];
      var eb = edgeBottom[side], kb = (side === 1 || side === 3) ? A * L : B * L;
      for (var z = 0; z < L; z++) eb[kb + z] = bottom;
    }
    return [top, bottom, ccls[ci]];
  }
  var side, run, f, g;
  // east and west faces run north-south: scan down each column
  for (side = 1; side <= 3; side += 2) {
    for (B = 0; B < n; B++) {
      A = 0;
      while (A < n) {
        f = face(A, B, side);
        if (!f) { A++; continue; }
        run = 1;
        while (A + run < n) {
          g = face(A + run, B, side);
          if (!g || g[0] !== f[0] || g[1] !== f[1] || wallKind(g[2]) !== wallKind(f[2])) break;
          run++;
        }
        var za = A * L, zb = (A + run) * L, rgb = wallColour(f[2]);
        if (side === 1) {
          var xe = (B + 1) * L;
          m.quad([xe, f[0], zb], [xe, f[1], zb], [xe, f[1], za], [xe, f[0], za], 127, 0, 0, rgb);
        } else {
          var xw = B * L;
          m.quad([xw, f[0], za], [xw, f[1], za], [xw, f[1], zb], [xw, f[0], zb], -127, 0, 0, rgb);
        }
        A += run;
      }
    }
  }
  // south and north faces run east-west: scan along each row
  for (side = 0; side <= 2; side += 2) {
    for (A = 0; A < n; A++) {
      B = 0;
      while (B < n) {
        f = face(A, B, side);
        if (!f) { B++; continue; }
        run = 1;
        while (B + run < n) {
          g = face(A, B + run, side);
          if (!g || g[0] !== f[0] || g[1] !== f[1] || wallKind(g[2]) !== wallKind(f[2])) break;
          run++;
        }
        var xa = B * L, xb = (B + run) * L;
        rgb = wallColour(f[2]);
        if (side === 2) {
          var zs = (A + 1) * L;
          m.quad([xa, f[0], zs], [xa, f[1], zs], [xb, f[1], zs], [xb, f[0], zs], 0, 0, 127, rgb);
        } else {
          var zn = A * L;
          m.quad([xb, f[0], zn], [xb, f[1], zn], [xa, f[1], zn], [xa, f[0], zn], 0, 0, -127, rgb);
        }
        B += run;
      }
    }
  }
  var out = m.finish();
  out.tint = { cells: tinted, strong: strong, cell: L };
  out.edgeBottom = edgeBottom;
  return out;
}

function landDm(dm, sea1, t) { return sea1[t] ? Math.max(0, dm[t]) : dm[t]; }

// ---------------------------------------------------------------- smooth grid (h5, h20)
/* o: {stride (in cells), holeCells (corner cells per hole square), holeGrid (squares
 * per side), holes (Uint8Array, row-major from the north), skirt (metres)}.
 * Vertices sit on cell corners, each the mean of the four samples around it, so two
 * neighbouring chunks compute identical edges from their aprons. Quads whose four
 * corners are all sea are left out (the water plane is opaque).
 */
function meshSmooth(d, o) {
  var h = d.header, W = h.width, K = W - 2, c = h.cell, s = o.stride | 0;
  if (!h.apron || h.height !== W) throw new Error('smooth meshing needs a square chunk with its apron');
  if (s < 1 || K % s) throw new Error('stride ' + s + ' does not divide ' + K);
  var nv = K / s + 1, base = h.base, v = d.v, cls = d.classes;
  var hC = new Float32Array(nv * nv), seaC = new Uint8Array(nv * nv), keyC = new Uint16Array(nv * nv);
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
      var gx = ((hs[1] + hs[3]) - (hs[0] + hs[2])) / (2 * c);
      var gz = ((hs[2] + hs[3]) - (hs[0] + hs[1])) / (2 * c);
      nxC[i] = gx; nzC[i] = gz;
      var k = sea === 4 ? 5 : pickClass(counts);
      keyC[i] = (k << 4) | (slopeBucket(Math.sqrt(gx * gx + gz * gz)) << 2);
    }
  }
  var m = new Mesh(Float32Array, nv * nv + 4096);
  for (i = 0; i < nv * nv; i++) {
    var len = Math.sqrt(nxC[i] * nxC[i] + 1 + nzC[i] * nzC[i]);
    m.vert((i % nv) * s * c, hC[i], Math.floor(i / nv) * s * c,
           Math.round(-nxC[i] / len * 127), Math.round(1 / len * 127), Math.round(-nzC[i] / len * 127),
           topColour(keyC[i]));
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

// ---------------------------------------------------------------- jobs
function transferables(out) {
  var list = [];
  if (out.v) list.push(out.v.buffer);
  if (out.classes) list.push(out.classes.buffer);
  if (out.mesh) list.push(out.mesh.pos.buffer, out.mesh.nor.buffer, out.mesh.col.buffer, out.mesh.idx.buffer);
  if (out.mesh && out.mesh.edgeBottom) out.mesh.edgeBottom.forEach(function (a) { list.push(a.buffer); });
  return list;
}

function meshFor(d, msg) {
  if (msg.mode === 'blocks') return meshBlocks(d, msg.opts);
  if (msg.mode === 'smooth') return meshSmooth(d, msg.opts);
  return null;
}

async function handle(msg) {
  if (msg.type === 'init') {
    cfg.originE = msg.originE; cfg.originN = msg.originN;
    cfg.rings = (msg.rings || []).map(function (r) { return Float64Array.from(r); });
    var box = null;
    cfg.rings.forEach(function (r) {
      for (var i = 0; i < r.length; i += 2) {
        if (!box) box = [r[i], r[i + 1], r[i], r[i + 1]];
        box[0] = Math.min(box[0], r[i]); box[1] = Math.min(box[1], r[i + 1]);
        box[2] = Math.max(box[2], r[i]); box[3] = Math.max(box[3], r[i + 1]);
      }
    });
    cfg.plotBox = box;
    return { ok: true };
  }
  var t0 = performance.now(), d, out = { ok: true };
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
  } else if (msg.type === 'mesh') {
    d = msg.data;
  } else {
    throw new Error('unknown job type ' + msg.type);
  }
  out.mesh = meshFor(d, msg);
  out.ms = performance.now() - t0;
  return out;
}

self.onmessage = function (ev) {
  var msg = ev.data;
  handle(msg).then(function (out) {
    out.id = msg.id;
    self.postMessage(out, transferables(out));
  }, function (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) });
  });
};
