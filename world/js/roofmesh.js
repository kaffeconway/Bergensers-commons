/* Commons World: building meshes from measured roof planes (FORMAT.md, roof_shape).
 *
 * A building is a set of parts that tile its drawn outline, each with a roof that is the
 * MINIMUM of its planes. Plane [sx, sz, y0] gives y = y0 + sx (x - at[0]) + sz (z - at[1]).
 * The mesher makes:
 *   - roof faces: each part triangulated (earcut, via three's ShapeUtils), every triangle
 *     clipped into the region where each plane is the lowest;
 *   - walls along the outline (inset by the overhang when that stays a simple ring), cut
 *     where the edge passes from part to part and where a crease crosses it, from the wall
 *     bottom up to the roof above each point;
 *   - step faces where two parts' roofs meet at different heights;
 *   - an optional fascia hanging under the roof edge.
 * Every face is computed from the stored planes, so a wall top, a roof edge and a step face
 * that meet are made from the same numbers. One tolerance, TOL, is used throughout.
 * No vertex is shared between faces, so computeVertexNormals() gives each face its own
 * normal. Written for this project (from the HD-pass prototype); no third-party code.
 */
import { ShapeUtils, Vector2 } from 'three';

export const TOL = 1e-6;              // metres: two heights closer than this are equal
const MIN_AREA = 1e-9;                // square metres: smaller triangles are not drawn
export const GROUP = { walls: 0, roofs: 1, trim: 2 };
// texture tiles, in metres (detailmaps.js draws one tile per texture)
export const TILE = { wall: 1.6, roofAcross: 1.2, roofDown: 1.4, flat: 4.0 };

export function areaXZ(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
// FORMAT.md rings are counter-clockwise seen from above, north up: NEGATIVE area in (x, z)
function canon(r) { return areaXZ(r) > 0 ? r.slice().reverse() : r.slice(); }
const ev = (P, x, z) => P.sx * x + P.sz * z + P.c;
function minPlane(Ps, x, z) {
  let k = 0, best = Infinity;
  for (let i = 0; i < Ps.length; i++) { const y = ev(Ps[i], x, z); if (y < best - 1e-9) { best = y; k = i; } }
  return k;
}
const keyOf = (p) => p[0].toFixed(4) + ',' + p[1].toFixed(4);

export function pointInRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

/* A roof_shape made ready to mesh: {at, parts: [{ring, Ps, model, planes}], outline}.
 * Throws on anything a reader cannot draw: a number that is not finite, a ring of fewer
 * than 3 points, or parts that do not chain into one outline. */
export function prepareShape(shape) {
  if (!shape || !Array.isArray(shape.parts) || !shape.parts.length) throw new Error('no parts');
  const at = shape.at;
  if (!Array.isArray(at) || at.length !== 2 || !finite(at[0]) || !finite(at[1])) throw new Error('at is not two numbers');
  const parts = shape.parts.map((p, i) => {
    if (!p || !Array.isArray(p.ring) || p.ring.length < 3) throw new Error('part ' + i + ': ring');
    for (const q of p.ring) if (!Array.isArray(q) || !finite(q[0]) || !finite(q[1])) throw new Error('part ' + i + ': ring point');
    if (!Array.isArray(p.planes) || !p.planes.length) throw new Error('part ' + i + ': no planes');
    for (const pl of p.planes) if (!Array.isArray(pl) || pl.length !== 3 || !pl.every(finite)) throw new Error('part ' + i + ': plane');
    const ring = canon(p.ring.map((q) => [q[0], q[1]]));
    if (Math.abs(areaXZ(ring)) < 1e-6) throw new Error('part ' + i + ': no area');
    const Ps = p.planes.map(([sx, sz, y0]) => ({ sx, sz, c: y0 - sx * at[0] - sz * at[1] }));
    return { ring, Ps, model: p.model, planes: p.planes };
  });
  const outline = outerRing(parts);
  return { at: [at[0], at[1]], parts, outline };
}

/* The flat prism of FORMAT.md's `roof`: one part over `ring` at height `top`. */
export function prismShape(ring, top) {
  const r = canon(ring.map((q) => [q[0], q[1]]));
  const Ps = [{ sx: 0, sz: 0, c: top }];
  return { at: [0, 0], parts: [{ ring: r, Ps, model: 'flat', planes: [[0, 0, top]] }], outline: r };
}

/* Height of the drawn roof at (x, z): the part containing the point (the first, on a
 * shared edge), or null outside the outline. */
export function roofAt(prep, x, z) {
  for (const p of prep.parts) {
    if (!pointInRing(p.ring, x, z)) continue;
    return ev(p.Ps[minPlane(p.Ps, x, z)], x, z);
  }
  return null;
}

/* As roofAt, but a point on or outside the outline takes the nearest part. */
export function roofNear(prep, x, z) {
  const y = roofAt(prep, x, z);
  if (y !== null) return y;
  const k = nearestPart(prep.parts, x, z);
  const Ps = prep.parts[k].Ps;
  return ev(Ps[minPlane(Ps, x, z)], x, z);
}

/* The lowest roof height over the outline (the roof is concave: it is at a ring vertex). */
export function lowestRoof(prep) {
  let lo = Infinity;
  for (const p of prep.parts) for (const q of p.ring) lo = Math.min(lo, ev(p.Ps[minPlane(p.Ps, q[0], q[1])], q[0], q[1]));
  return lo;
}

export function isPitched(prep) {
  return prep.parts.some((p) => p.Ps.some((P) => Math.hypot(P.sx, P.sz) > 1e-6));
}

// clip a convex polygon [[x,z]...] to f(x,z) = a*x + b*z + c >= 0
function clipHalf(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p[0] + b * p[1] + c, fq = a * q[0] + b * q[1] + c;
    if (fp >= -TOL) out.push(p);
    if ((fp > TOL && fq < -TOL) || (fp < -TOL && fq > TOL)) {
      const t = fp / (fp - fq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

// breakpoints (t in (0,1)) where the active plane of Ps changes along a->b
function creaseTs(Ps, a, b) {
  const ts = [];
  for (let i = 0; i < Ps.length; i++) for (let j = i + 1; j < Ps.length; j++) {
    const fa = ev(Ps[i], a[0], a[1]) - ev(Ps[j], a[0], a[1]), fb = ev(Ps[i], b[0], b[1]) - ev(Ps[j], b[0], b[1]);
    if (!((fa > TOL && fb < -TOL) || (fa < -TOL && fb > TOL))) continue;
    const t = fa / (fa - fb);
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const x = a[0] + t * (b[0] - a[0]), z = a[1] + t * (b[1] - a[1]);
    const y = ev(Ps[i], x, z);
    let active = true;                       // only where planes i and j are the roof there
    for (let k = 0; k < Ps.length; k++) if (k !== i && k !== j && ev(Ps[k], x, z) < y - 1e-9) { active = false; break; }
    if (active) ts.push(t);
  }
  return ts.sort((p, q) => p - q);
}

function segCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/* Inward mitred offset of a ring by d. Returns null when the result is not a simple ring
 * whose edges keep their directions: the walls then stand on the outline itself. */
export function insetRing(ring, d) {
  if (!(d > 0)) return ring;
  const r = canon(ring), n = r.length, out = [];
  const sgn = areaXZ(r) < 0 ? 1 : -1;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n], dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz);
    if (!(L > TOL)) return null;
    const nx = sgn * dz / L, nz = -sgn * dx / L;           // inward normal
    lines.push({ p: [p[0] + nx * d, p[1] + nz * d], u: [dx / L, dz / L] });
  }
  for (let i = 0; i < n; i++) {
    const A = lines[(i - 1 + n) % n], B = lines[i];
    const den = A.u[0] * B.u[1] - A.u[1] * B.u[0];
    if (Math.abs(den) < 1e-6) { out.push(B.p); continue; }
    const t = ((B.p[0] - A.p[0]) * B.u[1] - (B.p[1] - A.p[1]) * B.u[0]) / den;
    out.push([A.p[0] + t * A.u[0], A.p[1] + t * A.u[1]]);
  }
  // every edge keeps its direction and a length, stays inside, and the ring does not cross itself
  for (let i = 0; i < n; i++) {
    const p = out[i], q = out[(i + 1) % n], a = r[i], b = r[(i + 1) % n];
    const dot = (q[0] - p[0]) * (b[0] - a[0]) + (q[1] - p[1]) * (b[1] - a[1]);
    if (!(dot > 1e-6)) return null;
    if (!pointInRing(r, p[0], p[1])) return null;
  }
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segCross(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
  }
  return out;
}

/* The mesh of one building: {pos, uv, idx, groups (one per triangle), wallBottom, inset}.
 * opts: overhang (m), fascia (m), topGroup (the group of the roof faces, default roofs). */
export function meshBuilding(prep, bottom, opts = {}) {
  const overhang = opts.overhang || 0, fascia = opts.fascia || 0;
  const topGroup = opts.topGroup === undefined ? GROUP.roofs : opts.topGroup;
  const parts = prep.parts.map((p) => ({ ring: p.ring, Ps: p.Ps }));
  sharedEdgePoints(parts);
  const outline = prep.outline;
  const pos = [], uv = [], groups = [], idx = [], wallBottom = [];
  const addV = (x, y, z, u, v) => { pos.push(x, y, z); uv.push(u, v); return pos.length / 3 - 1; };
  const tri = (a, b, c, g) => {
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area < MIN_AREA) return;
    idx.push(a, b, c);
    groups.push(g);
  };
  const partAt = (x, z) => { for (let k = 0; k < parts.length; k++) if (pointInRing(parts[k].ring, x, z)) return k; return -1; };
  const roofY = (k, x, z) => { const Ps = parts[k].Ps; return ev(Ps[minPlane(Ps, x, z)], x, z); };

  // ---- roof faces: triangulate each part, clip each triangle into each plane's region
  for (const part of parts) {
    const tris = ShapeUtils.triangulateShape(part.ring.map((p) => new Vector2(p[0], p[1])), []);
    const Ps = part.Ps;
    for (const t of tris) {
      const T = t.map((i) => part.ring[i]);
      for (let i = 0; i < Ps.length; i++) {
        let poly = T;
        for (let j = 0; j < Ps.length && poly.length >= 3; j++) {
          if (j === i) continue;                        // region of i: P_j - P_i >= 0 for every j
          poly = clipHalf(poly, Ps[j].sx - Ps[i].sx, Ps[j].sz - Ps[i].sz, Ps[j].c - Ps[i].c);
        }
        if (poly.length < 3 || Math.abs(areaXZ(poly)) < MIN_AREA) continue;
        poly = withExtra(poly, part.extra);
        // texture coordinates, in tiles: on a pitched face u along the contour and v down the
        // slope (slope metres); on a flat face u = x and v = z
        const g = Math.hypot(Ps[i].sx, Ps[i].sz);
        let vUV;
        if (g > 1e-6) {
          const cos = 1 / Math.sqrt(1 + g * g), dx = -Ps[i].sx / g, dz = -Ps[i].sz / g;
          vUV = ([x, z]) => addV(x, ev(Ps[i], x, z), z, (x * dz - z * dx) / TILE.roofAcross, (x * dx + z * dz) / cos / TILE.roofDown);
        } else {
          vUV = ([x, z]) => addV(x, ev(Ps[i], x, z), z, x / TILE.flat, z / TILE.flat);
        }
        const vi = poly.map(vUV);
        const up = (a, b, c) => (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        // a clipped piece is convex but may hold three points in a line (a ring vertex on a
        // crease, a shared-edge point): fan it from its centroid then, so no triangle is a sliver
        let straight = false;
        for (let k = 0; k < poly.length; k++) if (Math.abs(up(poly[k], poly[(k + 1) % poly.length], poly[(k + 2) % poly.length])) < 1e-9) straight = true;
        if (straight) {
          const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
          const ci = vUV([cx, cz]), cp = [cx, cz];
          for (let k = 0; k < vi.length; k++) {
            const a = poly[k], b = poly[(k + 1) % poly.length];
            if (Math.abs(up(cp, a, b)) < 1e-12) continue;
            if (up(cp, a, b) >= 0) tri(ci, vi[k], vi[(k + 1) % vi.length], topGroup);
            else tri(ci, vi[(k + 1) % vi.length], vi[k], topGroup);
          }
        } else {
          for (let k = 1; k + 1 < vi.length; k++) {
            if (up(poly[0], poly[k], poly[k + 1]) >= 0) tri(vi[0], vi[k], vi[k + 1], topGroup);
            else tri(vi[0], vi[k + 1], vi[k], topGroup);
          }
        }
      }
    }
  }

  // ---- edges: outer edges carry walls (and the fascia), shared edges carry step faces
  const edgeOwner = new Map();
  parts.forEach((part, k) => part.ring.forEach((p, i) => {
    edgeOwner.set(keyOf(p) + '>' + keyOf(part.ring[(i + 1) % part.ring.length]), k);
  }));
  // A vertical polygon on segment a->b between bottom and top at each breakpoint, facing to
  // the right of a->b (out of a canonical ring). cols: [t, yBottom, yTop], with optional
  // lowLeft / lowRight: a point on the vertical edge where the neighbour's top is lower.
  function verticalStrip(a, b, cols, g, sAt, bottoms, tile) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let k = 0; k + 1 < cols.length; k++) {
      const [t0, b0, y0] = cols[k], [t1, b1, y1] = cols[k + 1];
      const x0 = a[0] + t0 * (b[0] - a[0]), z0 = a[1] + t0 * (b[1] - a[1]);
      const x1 = a[0] + t1 * (b[0] - a[0]), z1 = a[1] + t1 * (b[1] - a[1]);
      if ((t1 - t0) * L < TOL) continue;
      const u0 = (sAt + t0 * L) / tile, u1 = (sAt + t1 * L) / tile;
      const va = addV(x0, b0, z0, u0, b0 / tile), vb = addV(x1, b1, z1, u1, b1 / tile);
      const vc = addV(x1, y1, z1, u1, y1 / tile), vd = addV(x0, y0, z0, u0, y0 / tile);
      if (bottoms) bottoms.push(va, vb);
      const extra0 = cols[k].lowLeft, extra1 = cols[k + 1].lowRight;
      const e1 = extra1 !== undefined && extra1 > b1 + TOL && extra1 < y1 - TOL ? addV(x1, extra1, z1, u1, extra1 / tile) : -1;
      const e0 = extra0 !== undefined && extra0 > b0 + TOL && extra0 < y0 - TOL ? addV(x0, extra0, z0, u0, extra0 / tile) : -1;
      const poly = [va, vb];
      if (e1 >= 0) poly.push(e1);
      if (y1 - b1 > TOL) poly.push(vc);
      if (y0 - b0 > TOL) poly.push(vd);
      if (e0 >= 0) poly.push(e0);
      if (poly.length < 3) continue;
      for (let k2 = 1; k2 + 1 < poly.length; k2++) tri(poly[0], poly[k2], poly[k2 + 1], g);
    }
  }
  function profile(k, a, b) {
    const ts = [0, ...creaseTs(parts[k].Ps, a, b), 1];
    return ts.map((t) => { const x = a[0] + t * (b[0] - a[0]), z = a[1] + t * (b[1] - a[1]); return [t, roofY(k, x, z)]; });
  }
  const wallRing = overhang > 0 ? insetRing(outline, overhang) : outline;
  const walls = wallRing || outline;
  const ivs = [];
  let s = 0;
  for (let i = 0; i < walls.length; i++) {
    const a = walls[i], b = walls[(i + 1) % walls.length];
    // first where the edge passes from one part to another, then each piece's own creases
    let cuts = [0, 1];
    for (const part of parts) for (let j = 0; j < part.ring.length; j++) {
      const t = segParam(a, b, part.ring[j], part.ring[(j + 1) % part.ring.length]);
      if (t !== null) cuts.push(t);
    }
    cuts = [...new Set(cuts.map((t) => Math.round(t * 1e9) / 1e9))].sort((p, q) => p - q);
    const at = (t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    for (let c = 0; c + 1 < cuts.length; c++) {
      const [xm, zm] = at(0.5 * (cuts[c] + cuts[c + 1]));
      let k = partAt(xm, zm); if (k < 0) k = nearestPart(parts, xm, zm);
      const A = at(cuts[c]), B = at(cuts[c + 1]);
      const ts = [0, ...creaseTs(parts[k].Ps, A, B), 1].map((t) => cuts[c] + t * (cuts[c + 1] - cuts[c]));
      for (let m = 0; m + 1 < ts.length; m++) {
        if (ts[m + 1] - ts[m] < 1e-9) continue;
        const [xq, zq] = at(0.5 * (ts[m] + ts[m + 1]));
        const P = parts[k].Ps[minPlane(parts[k].Ps, xq, zq)];
        const [x0, z0] = at(ts[m]), [x1, z1] = at(ts[m + 1]);
        ivs.push({ a, b, s, t0: ts[m], t1: ts[m + 1], y0: ev(P, x0, z0), y1: ev(P, x1, z1) });
      }
    }
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  // where the roof steps between two parts, the higher wall piece carries a point at the lower
  // top, so its vertical edge meets the neighbouring wall and the step face vertex for vertex
  for (let m = 0; m < ivs.length; m++) {
    const c = ivs[m], p = ivs[(m - 1 + ivs.length) % ivs.length], n = ivs[(m + 1) % ivs.length];
    const col0 = [c.t0, bottom, c.y0], col1 = [c.t1, bottom, c.y1];
    if (p.y1 < c.y0 - TOL) col0.lowLeft = p.y1;
    if (n.y0 < c.y1 - TOL) col1.lowRight = n.y0;
    verticalStrip(c.a, c.b, [col0, col1], GROUP.walls, c.s, wallBottom, TILE.wall);
  }
  // step faces on shared part edges: from the lower roof up to the higher, facing the lower side
  const done = new Set();
  parts.forEach((part, k) => part.ring.forEach((p, i) => {
    const q = part.ring[(i + 1) % part.ring.length];
    const other = edgeOwner.get(keyOf(q) + '>' + keyOf(p));
    if (other === undefined) return;
    const id = [keyOf(p), keyOf(q)].sort().join('|');
    if (done.has(id)) return;
    done.add(id);
    const ts = [...new Set([0, 1, ...creaseTs(part.Ps, p, q), ...creaseTs(parts[other].Ps, p, q)]
      .map((t) => Math.round(t * 1e9) / 1e9))].sort((x, y) => x - y);
    const yAt = (t, kk) => roofY(kk, p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]));
    const tt = [];
    for (let m = 0; m < ts.length; m++) {            // split further where the two roofs cross
      tt.push(ts[m]);
      if (m + 1 < ts.length) {
        const d0 = yAt(ts[m], k) - yAt(ts[m], other), d1 = yAt(ts[m + 1], k) - yAt(ts[m + 1], other);
        if ((d0 > TOL && d1 < -TOL) || (d0 < -TOL && d1 > TOL)) tt.push(ts[m] + (ts[m + 1] - ts[m]) * d0 / (d0 - d1));
      }
    }
    for (let m = 0; m + 1 < tt.length; m++) {
      const tm = 0.5 * (tt[m] + tt[m + 1]);
      if (Math.abs(yAt(tm, k) - yAt(tm, other)) <= TOL) continue;
      const hiK = yAt(tm, k) >= yAt(tm, other) ? k : other, loK = hiK === k ? other : k;
      // p->q runs with part k on its left, so a strip drawn p->q faces part `other`
      const [a, b, t0, t1] = loK === other ? [p, q, tt[m], tt[m + 1]] : [q, p, 1 - tt[m + 1], 1 - tt[m]];
      const yb = (t) => roofY(loK, a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
      const yt = (t) => roofY(hiK, a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
      verticalStrip(a, b, [[t0, yb(t0), yt(t0)], [t1, yb(t1), yt(t1)]], GROUP.walls, 0, null, TILE.wall);
    }
  }));
  // fascia: a band under the roof edge along the outline, when the walls are inset
  if (fascia > 0 && wallRing && overhang > 0) {
    let sf = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length];
      const mx = 0.5 * (a[0] + b[0]), mz = 0.5 * (a[1] + b[1]);
      let k = edgeOwner.get(keyOf(a) + '>' + keyOf(b));
      if (k === undefined) k = nearestPart(parts, mx, mz);
      const prof = profile(k, a, b);
      verticalStrip(a, b, prof.map(([t, y]) => [t, y - fascia, y]), GROUP.trim, sf, null, TILE.wall);
      sf += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return { pos, uv, idx, groups, wallBottom, inset: !!wallRing || !(overhang > 0), walls };
}

/* Where two parts meet, the step face between them has a vertex wherever either roof has a
 * crease or the two roofs cross. Those points are kept beside each part's ring (the
 * triangulator drops points that lie in a straight line) and put into the roof pieces after
 * clipping, so both sides' roof faces have them and every edge is shared vertex for vertex. */
function sharedEdgePoints(parts) {
  const owner = new Map();
  parts.forEach((part, pi) => part.ring.forEach((p, i) => owner.set(keyOf(p) + '>' + keyOf(part.ring[(i + 1) % part.ring.length]), pi)));
  const extra = new Map();
  parts.forEach((part, pi) => part.ring.forEach((p, i) => {
    const q = part.ring[(i + 1) % part.ring.length];
    const oi = owner.get(keyOf(q) + '>' + keyOf(p));
    if (oi === undefined || oi < pi) return;
    const A = parts[pi].Ps, B = parts[oi].Ps;
    let ts = [...creaseTs(A, p, q), ...creaseTs(B, p, q)];
    const y = (Ps, t) => { const x = p[0] + t * (q[0] - p[0]), z = p[1] + t * (q[1] - p[1]); return ev(Ps[minPlane(Ps, x, z)], x, z); };
    const grid = [0, ...ts.slice().sort((a, b) => a - b), 1];
    for (let m = 0; m + 1 < grid.length; m++) {
      const d0 = y(A, grid[m]) - y(B, grid[m]), d1 = y(A, grid[m + 1]) - y(B, grid[m + 1]);
      if ((d0 > TOL && d1 < -TOL) || (d0 < -TOL && d1 > TOL)) ts.push(grid[m] + (grid[m + 1] - grid[m]) * d0 / (d0 - d1));
    }
    ts = [...new Set(ts.filter((t) => t > 1e-7 && t < 1 - 1e-7).map((t) => Math.round(t * 1e9) / 1e9))].sort((a, b) => a - b);
    if (!ts.length) return;
    extra.set(keyOf(p) + '>' + keyOf(q), ts);
    extra.set(keyOf(q) + '>' + keyOf(p), ts.map((t) => 1 - t).reverse());
  }));
  for (const part of parts) {
    part.extra = [];
    part.ring.forEach((p, i) => {
      const q = part.ring[(i + 1) % part.ring.length];
      for (const t of extra.get(keyOf(p) + '>' + keyOf(q)) || []) part.extra.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    });
  }
}

/* Put each extra point that lies inside an edge of the convex piece `poly` into that edge. */
function withExtra(poly, extra) {
  if (!extra || !extra.length) return poly;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    out.push(a);
    if (L2 < 1e-12) continue;
    const on = [];
    for (const r of extra) {
      const t = ((r[0] - a[0]) * dx + (r[1] - a[1]) * dz) / L2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      if (Math.abs((r[0] - a[0]) * dz - (r[1] - a[1]) * dx) / Math.sqrt(L2) < TOL) on.push([t, r]);
    }
    on.sort((x, y) => x[0] - y[0]).forEach(([, r]) => out.push(r));
  }
  return out;
}

/* The outline of the building: the part-ring edges that no other part shares, chained into
 * one ring. Throws if they do not chain (the parts do not tile one simple polygon). */
function outerRing(parts) {
  if (parts.length === 1) return parts[0].ring;
  const all = new Set(), next = new Map();
  for (const part of parts) part.ring.forEach((p, i) => all.add(keyOf(p) + '>' + keyOf(part.ring[(i + 1) % part.ring.length])));
  for (const part of parts) part.ring.forEach((p, i) => {
    const q = part.ring[(i + 1) % part.ring.length];
    if (all.has(keyOf(q) + '>' + keyOf(p))) return;
    if (next.has(keyOf(p))) throw new Error('parts do not tile one simple outline');
    next.set(keyOf(p), [p, q]);
  });
  if (!next.size) throw new Error('parts have no outer edge');
  const start = next.keys().next().value, out = [];
  let cur = start;
  for (let guard = 0; guard <= next.size; guard++) {
    const e = next.get(cur);
    if (!e) break;
    out.push(e[0]);
    cur = keyOf(e[1]);
    if (cur === start) {
      if (out.length !== next.size) break;
      return out;
    }
  }
  throw new Error('parts do not tile one simple outline');
}

function segParam(a, b, c, d) {
  // t on a->b where it crosses c->d (proper crossing, or touching c), else null
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return t;
}

function nearestPart(parts, x, z) {
  let best = 0, bd = Infinity;
  parts.forEach((p, k) => p.ring.forEach((a, i) => {
    const b = p.ring[(i + 1) % p.ring.length], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(a[0] + t * dx - x, a[1] + t * dz - z);
    if (d < bd) { bd = d; best = k; }
  }));
  return best;
}
