/* Commons World: tree geometries at three levels of detail, and the look rule.
 *
 * Every geometry is a unit tree: height 1, base at y = 0, drawn with the instance scale
 * (crown, max(2, height), crown). Each is normalised when it is built: its silhouette
 * radius at half height (y = 0.5) is measured from its own triangle edges and x and z are
 * scaled so that it is exactly 1, so the drawn crown matches the measured half-height
 * crown radius (FORMAT.md, trees.bin) at every level of detail.
 *
 *            conifer                               broadleaf
 *   near     6 drooping tiers with undersides,     trunk, 3 branch stubs, 7 blobs:
 *            and a trunk: 108 triangles            174 triangles
 *   mid      3 tiers and a trunk: 26               3 octahedra and a trunk: 32
 *   far      one 5-sided cone: 5                   one octahedron: 8
 *
 * The colours bake a vertical shading into the vertices (darker under each tier and in
 * the lower and inner blobs). Whether a tree looks like a conifer or a broadleaf follows
 * its measured proportions where they are clear, and a hash of its position where they
 * are not: it is not its species, which nothing in the data says.
 */
import * as THREE from 'three';

// The look rule (a visible choice, one line each): a measured crown / height below
// CONIFER_BELOW looks like a conifer, above BROAD_ABOVE like a broadleaf, and in between a
// hash of the position decides. Exact fractions [numerator, denominator], compared in integers.
export const CONIFER_BELOW = [3, 20];      // 0.15
export const BROAD_ABOVE = [3, 10];        // 0.30
const TRUNK = new THREE.Color(0x5b4a38);
export const GREENS = { conifer: [0x3f5a3c, 0x4a5f38], broad: [0x6b8a4c, 0x5f7f45] };

/* An integer hash of a position, identical on every device (Math.imul is exact). */
export function hash2(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul((z | 0) + 0x9e3779b9, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* 'conifer' or 'broad' for a tree at (xdm, zdm) decimetres, height and crown in metres.
 * The ratio is compared in trees.bin's own units (crown in 0.1 m, height in 0.25 m), in
 * integers, so a ratio exactly on a threshold is the same on every device. */
export function treeLook(xdm, zdm, height, crown) {
  const hq = Math.round(height * 4), cq = Math.round(crown * 10);
  // crown / height = 0.4 cq / hq = 2 cq / (5 hq), against num / den: 2 cq den <> 5 hq num
  if (2 * cq * CONIFER_BELOW[1] < 5 * hq * CONIFER_BELOW[0]) return 'conifer';
  if (2 * cq * BROAD_ABOVE[1] > 5 * hq * BROAD_ABOVE[0]) return 'broad';
  const tall = Math.max(0, Math.min(1, (height - 12) / 10));
  return hash2(xdm, zdm) < 0.55 + 0.3 * tall ? 'conifer' : 'broad';
}

// numbers in [0, 1) from the position hash: the same on every device
function rng(seed) {
  let i = 0;
  return () => hash2(seed * 7919 + 17, i++);
}

/* Parts [{geometry, colour(y) -> THREE.Color}] merged into one non-indexed geometry with a
 * colour per vertex. */
function merge(parts) {
  const geos = parts.map((p) => (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  const c = new THREE.Color();
  geos.forEach((g, k) => {
    const P = g.attributes.position;
    pos.set(P.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let v = 0; v < P.count; v++) {
      parts[k].colour(P.getX(v), P.getY(v), P.getZ(v), c);
      col[(o + v) * 3] = c.r; col[(o + v) * 3 + 1] = c.g; col[(o + v) * 3 + 2] = c.b;
    }
    o += P.count;
  });
  for (const g of geos) g.dispose();
  for (const p of parts) p.geometry.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/* The largest horizontal distance from the axis at which a triangle edge crosses y = h. */
export function radiusAt(geometry, h = 0.5) {
  const p = geometry.attributes.position;
  let rmax = 0;
  for (let t = 0; t + 2 < p.count; t += 3) {
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
      const ya = p.getY(t + i), yb = p.getY(t + j);
      if ((ya - h) * (yb - h) > 0 || ya === yb) continue;
      const u = (h - ya) / (yb - ya);
      const x = p.getX(t + i) + u * (p.getX(t + j) - p.getX(t + i));
      const z = p.getZ(t + i) + u * (p.getZ(t + j) - p.getZ(t + i));
      rmax = Math.max(rmax, Math.hypot(x, z));
    }
  }
  return rmax;
}

function normalised(g) {
  const r = radiusAt(g);
  if (r > 0) g.scale(1 / r, 1, 1 / r);      // three transforms the normals to match
  g.computeBoundingSphere();
  return g;
}

const plain = (colour) => (x, y, z, c) => c.copy(colour);

/* A conifer: `tiers` drooping cones under the envelope R(y) = 2 (1 - y), which passes
 * radius 1 at half height, each shaded from 0.65 at its skirt to 1 at its top. */
function conifer(tiers, seg, undersides, trunkSeg, green, seed) {
  const r = rng(seed), parts = [];
  parts.push({ geometry: new THREE.CylinderGeometry(0.035, 0.06, 0.5, trunkSeg, 1, true).translate(0, 0.13, 0),
               colour: plain(TRUNK) });
  const base = 0.18, top = 1.0, step = (top - base) / tiers;
  for (let i = 0; i < tiers; i++) {
    const y0 = base + i * step;
    const apex = Math.min(1.0, y0 + step * 1.9);          // tiers overlap
    const R = 2 * (1 - y0) * (0.98 + 0.06 * r());
    const h = apex - y0;
    const cone = new THREE.ConeGeometry(R, h, seg, 1, true).translate(0, y0 + h / 2, 0);
    const p = cone.attributes.position;
    for (let v = 0; v < p.count; v++) {
      if (p.getY(v) < y0 + 1e-6) {                        // droop and jitter the skirt
        p.setY(v, y0 - 0.035 * (0.6 + 0.8 * r()));
        const k = 0.92 + 0.16 * r();
        p.setX(v, p.getX(v) * k);
        p.setZ(v, p.getZ(v) * k);
      }
    }
    cone.rotateY(r() * Math.PI);
    const shade = (x, y, z, c) => c.copy(green).multiplyScalar(0.65 + 0.35 * Math.max(0, Math.min(1, (y - y0) / h)));
    parts.push({ geometry: cone, colour: shade });
    if (undersides) {
      parts.push({ geometry: new THREE.CircleGeometry(R * 0.96, seg).rotateX(Math.PI / 2).translate(0, y0 - 0.02, 0),
                   colour: (x, y, z, c) => c.copy(green).multiplyScalar(0.6) });
    }
  }
  return merge(parts);
}

/* A broadleaf: a trunk, branch stubs, and blobs inside an ellipsoid centred at 0.62 with
 * radius 1 at half height; the lower and inner blobs are shaded 0.75-0.85. */
function broadleaf(green, seed) {
  const r = rng(seed), parts = [];
  parts.push({ geometry: new THREE.CylinderGeometry(0.04, 0.07, 0.62, 5, 1, true).translate(0, 0.19, 0), colour: plain(TRUNK) });
  for (let b = 0; b < 3; b++) {
    const g = new THREE.CylinderGeometry(0.018, 0.03, 0.34, 4, 1, true).translate(0, 0.17, 0);
    g.rotateZ(0.5 + 0.3 * r()).rotateY((b / 3) * 2 * Math.PI + r()).translate(0, 0.42, 0);
    parts.push({ geometry: g, colour: plain(TRUNK) });
  }
  const yc = 0.62, eb = 0.38, a = 1.0 / Math.sqrt(1 - ((0.5 - yc) / eb) ** 2);
  const place = [[0, yc, 0, 0.62, 0.8]];
  for (let i = 0; i < 5; i++) {
    const t = (i / 5) * 2 * Math.PI + r() * 0.4;
    place.push([Math.cos(t) * a * 0.55, yc - 0.06 + 0.1 * r(), Math.sin(t) * a * 0.55, 0.45, 0.85]);
  }
  place.push([0, yc + eb * 0.55, 0, 0.42, 1.0]);
  for (const [x, y, z, s, shade] of place) {
    const g = new THREE.IcosahedronGeometry(1, 0).scale(s * a, s * eb * 1.25, s * a).translate(x, y, z);
    const lo = y - s * eb * 1.25, hi = y + s * eb * 1.25;
    parts.push({ geometry: g, colour: (px, py, pz, c) => c.copy(green).multiplyScalar(shade * (0.88 + 0.12 * Math.max(0, Math.min(1, (py - lo) / (hi - lo))))) });
  }
  return merge(parts);
}

function broadMid(green) {
  const parts = [{ geometry: new THREE.CylinderGeometry(0.04, 0.07, 0.62, 4, 1, true).translate(0, 0.19, 0), colour: plain(TRUNK) }];
  for (const [x, y, z, k, shade] of [[0, 0.62, 0, 1.0, 1.0], [0.35, 0.55, 0.2, 0.7, 0.85], [-0.3, 0.58, -0.25, 0.7, 0.8]]) {
    parts.push({ geometry: new THREE.OctahedronGeometry(1, 0).scale(0.75 * k, 0.4 * k, 0.75 * k).translate(x, y, z),
                 colour: (px, py, pz, c) => c.copy(green).multiplyScalar(shade) });
  }
  return merge(parts);
}

/* {coniferNear, coniferMid, coniferFar, broadNear, broadMid, broadFar}. The foliage is in
 * each look's first green; the instance colour carries the second (see greenRatio). */
export function treeGeometries() {
  const cg = new THREE.Color(GREENS.conifer[0]), bg = new THREE.Color(GREENS.broad[0]);
  return {
    coniferNear: normalised(conifer(6, 8, true, 6, cg, 1)),
    coniferMid: normalised(conifer(3, 6, false, 4, cg, 1)),
    coniferFar: normalised(merge([{ geometry: new THREE.ConeGeometry(1.0, 0.95, 5, 1, true).translate(0, 0.525, 0),
                                    colour: (x, y, z, c) => c.copy(cg).multiplyScalar(0.75 + 0.25 * (y - 0.05) / 0.95) }])),
    broadNear: normalised(broadleaf(bg, 2)),
    broadMid: normalised(broadMid(bg)),
    broadFar: normalised(merge([{ geometry: new THREE.OctahedronGeometry(1, 0).scale(1, 0.4, 1).translate(0, 0.6, 0),
                                  colour: (x, y, z, c) => c.copy(bg).multiplyScalar(0.8 + 0.2 * (y - 0.2) / 0.8) }]))
  };
}

/* The instance colour that turns a look's first green into its second (linear, per channel). */
export function greenRatio(look) {
  const a = new THREE.Color(GREENS[look][0]), b = new THREE.Color(GREENS[look][1]);
  return [b.r / a.r, b.g / a.g, b.b / a.b];
}

/* Test hook: the silhouette radius at half height of every level and look. */
export function treeGeometryRadii() {
  const g = treeGeometries(), out = [];
  for (const [name, geo] of Object.entries(g)) {
    const look = name.startsWith('conifer') ? 'conifer' : 'broad';
    out.push({ lod: name.slice(look.length).toLowerCase(), look, radiusAtHalf: radiusAt(geo), triangles: geo.attributes.position.count / 3 });
    geo.dispose();
  }
  return out;
}
