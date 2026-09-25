/* Commons World: things on the terrain.
 *
 * Fetching (with gzip detection), trees.bin (FORMAT.md section 4) as instanced
 * meshes per h1 chunk, buildings.json as extruded prisms, the plot boundary as a
 * low fence, and an index of footprints so the walker cannot step through walls.
 */
import * as THREE from 'three';

// ------------------------------------------------------------------ fetching
export function safeWorldPath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(path) || path.startsWith('/') ||
      path.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('unsafe path in manifest: ' + JSON.stringify(path));
  }
  return path;
}

export async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(url + ': HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export async function fetchJSON(url) {
  const bytes = await fetchBytes(url);
  return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

// ------------------------------------------------------------------ hashing
/* An integer hash of a position, identical on every device (Math.imul is exact). */
export function hash2(x, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul((z | 0) + 0x9e3779b9, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ trees
export function parseTrees(bytes) {
  if (bytes.length < 12) throw new Error('trees.bin is too short');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'CWT1') throw new Error('not a CWT1 tree file (magic ' + JSON.stringify(magic) + ')');
  if (bytes[4] !== 1) throw new Error('CWT1 version ' + bytes[4] + ' is not supported');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(8, true);
  if (bytes.length !== 12 + 8 * count) throw new Error('trees.bin is ' + bytes.length + ' bytes, expected ' + (12 + 8 * count));
  const xdm = new Int16Array(count), zdm = new Int16Array(count), gdm = new Int16Array(count);
  const height = new Float32Array(count), crown = new Float32Array(count);
  for (let k = 0, o = 12; k < count; k++, o += 8) {
    xdm[k] = dv.getInt16(o, true);
    zdm[k] = dv.getInt16(o + 2, true);
    gdm[k] = dv.getInt16(o + 4, true);
    height[k] = bytes[o + 6] * 0.25;
    crown[k] = bytes[o + 7] * 0.1;
  }
  return { count, xdm, zdm, gdm, height, crown };
}

function mergeParts(parts) {
  // parts: [{geometry, color: THREE.Color}] -> one non-indexed geometry with a colour attribute
  const geos = parts.map((p) => (p.geometry.index ? p.geometry.toNonIndexed() : p.geometry));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  geos.forEach((g, k) => {
    const c = parts[k].color, cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let v = 0; v < cnt; v++) { col[(o + v) * 3] = c.r; col[(o + v) * 3 + 1] = c.g; col[(o + v) * 3 + 2] = c.b; }
    o += cnt;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  geos.forEach((g) => g.dispose());
  parts.forEach((p) => p.geometry.dispose());
  return out;
}

function treeGeometries() {
  const trunk = new THREE.Color(0x5b4a38), spruce = new THREE.Color(0x3f5a3c), leaf = new THREE.Color(0x6b8a4c);
  const t = (g, y) => g.translate(0, y, 0);
  return {
    coniferNear: mergeParts([
      { geometry: t(new THREE.CylinderGeometry(0.06, 0.09, 0.45, 5, 1, true), 0.105), color: trunk },
      { geometry: t(new THREE.ConeGeometry(1.0, 0.62, 7, 1, false), 0.46), color: spruce },
      { geometry: t(new THREE.ConeGeometry(0.66, 0.5, 7, 1, false), 0.75), color: spruce }
    ]),
    coniferFar: mergeParts([
      { geometry: t(new THREE.ConeGeometry(1.0, 0.95, 5, 1, true), 0.525), color: spruce }
    ]),
    broadNear: mergeParts([
      { geometry: t(new THREE.CylinderGeometry(0.07, 0.11, 0.6, 5, 1, true), 0.18), color: trunk },
      { geometry: t(new THREE.IcosahedronGeometry(1, 0).scale(1, 0.36, 1), 0.62), color: leaf }
    ]),
    broadFar: mergeParts([
      { geometry: t(new THREE.OctahedronGeometry(1, 0).scale(1, 0.4, 1), 0.6), color: leaf }
    ])
  };
}

/* One InstancedMesh per h1 chunk and look (conifer or broadleaf). The look is decoration:
 * it comes from a hash of the tree's position, not from data about the species.
 * A tree starts on its 1 m block top (from trees.bin). The chunk manager draws far chunks
 * in 2 m and 4 m blocks whose tops are means, up to several metres off that, so each time
 * a chunk is (re)meshed reground() stands its trees on the top actually drawn. */
export class TreeSet {
  constructor(scene, trees, origin, chunkSide, profile) {
    this.geo = treeGeometries();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material.toneMapped = false;
    this.profile = profile;
    this.group = new THREE.Group();
    this.group.name = 'trees';
    this.groups = [];
    this.byKey = new Map();
    this.count = trees.count;
    const [oe, on] = origin;
    const buckets = new Map();
    for (let k = 0; k < trees.count; k++) {
      const x = trees.xdm[k] / 10, z = trees.zdm[k] / 10;
      const key = Math.floor((x + oe) / chunkSide) + '_' + Math.floor((on - z) / chunkSide);
      let b = buckets.get(key);
      if (!b) { b = []; buckets.set(key, b); }
      b.push(k);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    for (const [key, list] of buckets) {
      const [ci, cj] = key.split('_').map(Number);
      const x0 = ci * chunkSide - oe, z0 = -((cj + 1) * chunkSide - on);
      const kinds = { conifer: [], broad: [] };
      for (const k of list) {
        const hsh = hash2(trees.xdm[k], trees.zdm[k]);
        const tall = Math.max(0, Math.min(1, (trees.height[k] - 12) / 10));
        (hsh < 0.55 + 0.3 * tall ? kinds.conifer : kinds.broad).push(k);
      }
      const entry = { key, x0, z0, side: chunkSide, meshes: [], near: true };
      for (const kind of ['conifer', 'broad']) {
        const ids = kinds[kind];
        if (!ids.length) continue;
        const mesh = new THREE.InstancedMesh(this.geo[kind + 'Near'], this.material, ids.length);
        mesh.name = 'trees:' + key + ':' + kind;
        mesh.userData.kind = kind;
        ids.forEach((k, n) => {
          const h = Math.max(2, trees.height[k]);
          const r = Math.max(0.5, trees.crown[k]) * (kind === 'conifer' ? 1.25 : 1.0);
          const hsh = hash2(trees.zdm[k] * 7 + 3, trees.xdm[k] * 13 + 1);
          // stand on the 1 m block top, which is the ground drawn near the walker
          p.set(trees.xdm[k] / 10, Math.floor((trees.gdm[k] + 5) / 10), trees.zdm[k] / 10);
          q.setFromAxisAngle(up, hsh * Math.PI * 2);
          s.set(r, h, r);
          mesh.setMatrixAt(n, m.compose(p, q, s));
          const b = 0.84 + 0.26 * hash2(trees.xdm[k] + 11, trees.zdm[k] - 5);
          col.setRGB(b * (0.96 + 0.06 * hsh), b, b * (0.95 + 0.05 * (1 - hsh)));
          mesh.setColorAt(n, col);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        entry.meshes.push(mesh);
      }
      this.groups.push(entry);
      this.byKey.set(key, entry);
    }
    scene.add(this.group);
  }

  /* Stand the trees of h1 chunk `key` on topAt(x, z), the block top drawn there (null
   * leaves a tree where it is). Returns how many moved. */
  reground(key, topAt) {
    const g = this.byKey.get(key);
    if (!g) return 0;
    const m = new THREE.Matrix4();
    let moved = 0;
    for (const mesh of g.meshes) {
      let changed = false;
      for (let n = 0; n < mesh.count; n++) {
        mesh.getMatrixAt(n, m);
        const e = m.elements, y = topAt(e[12], e[14]);
        if (y === null || y === undefined || e[13] === y) continue;
        e[13] = y;
        mesh.setMatrixAt(n, m);
        changed = true;
        moved++;
      }
      if (changed) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
    return moved;
  }

  update(cam) {
    let changed = false;
    for (const g of this.groups) {
      const dx = Math.max(g.x0 - cam.x, 0, cam.x - (g.x0 + g.side));
      const dz = Math.max(g.z0 - cam.z, 0, cam.z - (g.z0 + g.side));
      const near = Math.hypot(dx, dz) < this.profile.treesNear;
      if (near === g.near) continue;
      g.near = near;
      changed = true;
      for (const mesh of g.meshes) mesh.geometry = this.geo[mesh.userData.kind + (near ? 'Near' : 'Far')];
    }
    return changed;
  }

  dispose() {
    for (const g of Object.values(this.geo)) g.dispose();
    this.material.dispose();
    for (const g of this.groups) for (const m of g.meshes) m.dispose();
  }
}

// ------------------------------------------------------------------ buildings
function signedAreaXZ(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

class Prisms {
  constructor() { this.pos = []; this.col = []; this.idx = []; }
  // Returns the indices of the wall-bottom vertices, so the walls can be lowered later.
  add(ring, bottom, top, wall, roof) {
    // FORMAT.md rings are counter-clockwise in grid (E, N), i.e. negative area in (x, z).
    // Normalise to that, so each wall quad below faces out of the footprint.
    const r = signedAreaXZ(ring) > 0 ? ring.slice().reverse() : ring;
    const bottoms = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      const v = this.pos.length / 3;
      this.pos.push(p[0], top, p[1], p[0], bottom, p[1], q[0], bottom, q[1], q[0], top, q[1]);
      for (let k = 0; k < 4; k++) this.col.push(wall.r, wall.g, wall.b);
      this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      bottoms.push(v + 1, v + 2);
    }
    const contour = r.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const v0 = this.pos.length / 3;
    for (const p of r) { this.pos.push(p[0], top, p[1]); this.col.push(roof.r, roof.g, roof.b); }
    for (const t of tris) {
      // keep the roof facing up: (b - a) x (c - a) must have a positive y
      const a = r[t[0]], b = r[t[1]], c = r[t[2]];
      const ny = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
      if (ny >= 0) this.idx.push(v0 + t[0], v0 + t[1], v0 + t[2]);
      else this.idx.push(v0 + t[0], v0 + t[2], v0 + t[1]);
    }
    return bottoms;
  }
  mesh(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1)
                                            : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.toneMapped = false;
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    return m;
  }
}

/* Buildings as flat-roofed prisms. `ground` is the median terrain under a footprint, so
 * on a slope the ground just outside the downhill wall is lower than that: walls start
 * sunk 2 m below it, and reground() takes them further down, to the lowest ground any
 * block size can draw around the footprint, once the 1 m heights there are loaded. */
export function buildBuildings(features) {
  const others = new Prisms(), house = new Prisms();
  const wall = new THREE.Color(0xcfc9bd), roof = new THREE.Color(0x69706d);
  const hWall = new THREE.Color(0xc98e5c), hRoof = new THREE.Color(0x7c2e3e);
  let houseInfo = null, n = 0;
  const items = [];
  for (const f of features) {
    if (!Array.isArray(f.ring) || f.ring.length < 3) continue;
    const ground = Number(f.ground), top = Number(f.roof);
    if (!isFinite(ground) || !isFinite(top)) continue;
    const bottom = ground - 2;                       // sunk, so no block top shows beneath it
    const roofY = Math.max(top, ground + 2);
    n++;
    const xs = f.ring.map((p) => p[0]), zs = f.ring.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    let target, verts;
    if (f.house === true && !houseInfo) {
      verts = house.add(f.ring, bottom, roofY, hWall, hRoof);
      target = 'house';
      houseInfo = { ring: f.ring, ground, roof: roofY, centroid: ringCentroid(f.ring), id: f.id };
    } else {
      verts = others.add(f.ring, bottom, roofY, wall, roof);
      target = 'others';
    }
    items.push({ id: f.id, house: target === 'house', ground, bottom, roof: roofY, box, target, verts });
  }
  const group = new THREE.Group();
  group.name = 'buildings';
  const othersMesh = others.mesh('buildings');
  const houseMesh = house.mesh('house');
  group.add(othersMesh, houseMesh);
  const meshes = { house: houseMesh, others: othersMesh };

  /* lowestAt(x0, z0, x1, z1) gives the lowest ground drawable over a box, or null while it
   * is not known. `touches(box)`, when given, limits the work to the buildings it accepts.
   * Returns how many buildings were lowered. */
  function reground(lowestAt, touches) {
    const dirty = new Set();
    let lowered = 0;
    for (const it of items) {
      if (touches && !touches(it.box)) continue;
      const low = lowestAt(it.box[0] - 0.5, it.box[1] - 0.5, it.box[2] + 0.5, it.box[3] + 0.5);
      if (low === null || low === undefined) continue;
      const bottom = Math.min(it.ground - 2, low - 0.25);
      if (bottom >= it.bottom) continue;
      it.bottom = bottom;
      const arr = meshes[it.target].geometry.attributes.position.array;
      for (const v of it.verts) arr[v * 3 + 1] = bottom;
      dirty.add(it.target);
      lowered++;
    }
    for (const t of dirty) {
      const g = meshes[t].geometry;
      g.attributes.position.needsUpdate = true;
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    return lowered;
  }
  return { group, othersMesh, houseMesh, house: houseInfo, count: n, items, reground };
}

/* Footprints in 16 m buckets, for walking: inside a footprint the ground is its roof. */
export class FootprintIndex {
  constructor(features) {
    this.size = 16;
    this.cells = new Map();
    for (const f of features) {
      if (!Array.isArray(f.ring) || f.ring.length < 3) continue;
      const xs = f.ring.map((p) => p[0]), zs = f.ring.map((p) => p[1]);
      const b = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
      const item = { ring: f.ring, box: b, roof: Math.max(Number(f.roof), Number(f.ground) + 2) };
      for (let i = Math.floor(b[0] / this.size); i <= Math.floor(b[2] / this.size); i++) {
        for (let j = Math.floor(b[1] / this.size); j <= Math.floor(b[3] / this.size); j++) {
          const k = i + '_' + j;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(item);
        }
      }
    }
  }
  roofAt(x, z) {
    const list = this.cells.get(Math.floor(x / this.size) + '_' + Math.floor(z / this.size));
    if (!list) return null;
    for (const it of list) {
      const b = it.box;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      if (pointInRing(it.ring, x, z)) return it.roof;
    }
    return null;
  }
}

// ------------------------------------------------------------------ plot fence
/* A low (0.4 m) ribbon along every ring of the parcel, standing on the drawn block
 * tops, so the boundary reads from a distance. Rebuilt when the blocks under it change. */
export class PlotFence {
  constructor(scene, parcels) {
    this.rings = [];
    for (const p of parcels || []) {
      if (Array.isArray(p.ring) && p.ring.length >= 3) this.rings.push(p.ring);
      for (const h of p.holes || []) if (Array.isArray(h) && h.length >= 3) this.rings.push(h);
    }
    this.material = new THREE.MeshBasicMaterial({
      color: 0xb8552f, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
    });
    this.material.toneMapped = false;
    this.mesh = null;
    this.scene = scene;
    this.signature = '';
  }
  rebuild(topAt) {
    const pos = [], idx = [];
    let missing = 0;
    for (const ring of this.rings) {
      const pts = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(len / 0.5));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      pts.push(pts[0]);
      let first = -1;
      for (const [x, z] of pts) {
        let y = topAt(x, z);
        if (y == null) { missing++; y = 0; }
        const v = pos.length / 3;
        pos.push(x, y - 0.05, z, x, y + 0.4, z);
        if (first >= 0) idx.push(v - 2, v, v - 1, v - 1, v, v + 1);
        first = v;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'plot-fence';
    this.mesh.renderOrder = 2;
    this.scene.add(this.mesh);
    return missing;
  }
}

export function plotRingsFlat(parcels) {
  const out = [];
  for (const p of parcels || []) {
    for (const r of [p.ring].concat(p.holes || [])) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const flat = [];
      for (const pt of r) flat.push(Number(pt[0]), Number(pt[1]));
      out.push(flat);
    }
  }
  return out;
}
