/* Commons World: things on the terrain.
 *
 * Fetching (with gzip detection); trees.bin (FORMAT.md section 4) as instanced meshes per
 * h1 chunk, at three levels of detail (treegeo.js); buildings.json as meshes of their
 * measured roofs where the file has them (roofmesh.js) and flat prisms where it does not;
 * the plot boundary as a low fence; and an index of the drawn outlines so the walker
 * cannot step through walls and stands on roofs as drawn.
 */
import * as THREE from 'three';
import { prepareShape, prismShape, meshBuilding, roofAt as roofOf, lowestRoof, isPitched, GROUP } from './roofmesh.js';
import { detailMaps, releaseDetailMaps } from './detailmaps.js';
import { treeGeometries, treeLook, greenRatio, hash2 } from './treegeo.js';

export { hash2 };

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

// Per profile: the dynamic near set (the nearest trees, drawn in full) and the mid/far
// switch's hysteresis, in metres. The mid/far distance itself is PROFILES.treesNear.
export const TREE_PROFILES = {
  phone: { nearRadius: 50, nearCap: 64, hyst: 20 },
  laptop: { nearRadius: 90, nearCap: 256, hyst: 20 }
};
const NEAR_BUCKET = 16;          // metres: the grid the near set is looked up in
const NEAR_REFILL = 5;           // metres the camera moves before the near set is refilled
const LOOKS = ['conifer', 'broad'];

/* One InstancedMesh per h1 chunk and look (conifer or broadleaf), drawn at the mid level
 * within PROFILES.treesNear of the camera and at the far level beyond it, plus a near set:
 * one InstancedMesh per look holding the nearest trees in full, each of which is hidden in
 * its chunk mesh (a zero-scale matrix) while it is there. The look follows the measured
 * proportions where they are clear (treegeo.js); it is not the species. A tree starts on
 * the terrain model's height (trees.bin) and is stood on the surface as drawn by
 * reground() whenever its chunk is (re)meshed. */
export class TreeSet {
  constructor(scene, trees, origin, chunkSide, profile) {
    this.geo = treeGeometries();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.material.toneMapped = false;
    this.profile = profile;
    this.tp = TREE_PROFILES[profile && profile.name] || TREE_PROFILES.laptop;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'trees';
    this.groups = [];
    this.byKey = new Map();
    this.count = trees.count;
    const n = trees.count;
    this.tx = new Float64Array(n); this.ty = new Float64Array(n); this.tz = new Float64Array(n);
    this.scale = new Float32Array(2 * n); this.yaw = new Float32Array(n); this.colour = new Float32Array(3 * n);
    this.look = new Uint8Array(n); this.slot = new Int32Array(n); this.chunkOf = new Array(n);
    this.looks = { conifer: 0, broad: 0 };
    const [oe, on] = origin;
    const buckets = new Map();
    const ratio = LOOKS.map((l) => greenRatio(l));
    for (let k = 0; k < n; k++) {
      const x = trees.xdm[k] / 10, z = trees.zdm[k] / 10;
      this.tx[k] = x; this.tz[k] = z; this.ty[k] = trees.gdm[k] / 10;
      this.scale[2 * k] = Math.max(0.5, trees.crown[k]);
      this.scale[2 * k + 1] = Math.max(2, trees.height[k]);
      const hsh = hash2(trees.zdm[k] * 7 + 3, trees.xdm[k] * 13 + 1);
      this.yaw[k] = hsh * Math.PI * 2;
      const look = treeLook(trees.xdm[k], trees.zdm[k], trees.height[k], trees.crown[k]) === 'conifer' ? 0 : 1;
      this.look[k] = look;
      this.looks[LOOKS[look]]++;
      const b = 0.84 + 0.26 * hash2(trees.xdm[k] + 11, trees.zdm[k] - 5);
      const second = hash2(trees.xdm[k] * 3 + 17, trees.zdm[k] * 5 - 9) < 0.5;
      const g = second ? ratio[look] : [1, 1, 1];
      this.colour[3 * k] = b * (0.96 + 0.06 * hsh) * g[0];
      this.colour[3 * k + 1] = b * g[1];
      this.colour[3 * k + 2] = b * (0.95 + 0.05 * (1 - hsh)) * g[2];
      const key = Math.floor((x + oe) / chunkSide) + '_' + Math.floor((on - z) / chunkSide);
      let bk = buckets.get(key);
      if (!bk) { bk = []; buckets.set(key, bk); }
      bk.push(k);
    }
    const m = new THREE.Matrix4(), col = new THREE.Color();
    for (const [key, list] of buckets) {
      const [ci, cj] = key.split('_').map(Number);
      const x0 = ci * chunkSide - oe, z0 = -((cj + 1) * chunkSide - on);
      const entry = { key, x0, z0, side: chunkSide, meshes: [], near: true, lodSet: false, orig: new Map() };
      for (let look = 0; look < 2; look++) {
        const ids = list.filter((k) => this.look[k] === look);
        if (!ids.length) continue;
        const kind = LOOKS[look];
        const mesh = new THREE.InstancedMesh(this.geo[kind + 'Mid'], this.material, ids.length);
        mesh.name = 'trees:' + key + ':' + kind;
        mesh.userData.kind = kind;
        mesh.userData.ids = Int32Array.from(ids);
        ids.forEach((k, i) => {
          this.slot[k] = i;
          this.chunkOf[k] = mesh;
          mesh.setMatrixAt(i, this._matrix(k, m));
          mesh.setColorAt(i, col.setRGB(this.colour[3 * k], this.colour[3 * k + 1], this.colour[3 * k + 2]));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        entry.orig.set(mesh, mesh.instanceMatrix.array.slice());
        this.group.add(mesh);
        entry.meshes.push(mesh);
      }
      this.groups.push(entry);
      this.byKey.set(key, entry);
    }
    // the near set
    this.nearMeshes = LOOKS.map((kind) => {
      const mesh = new THREE.InstancedMesh(this.geo[kind + 'Near'], this.material, this.tp.nearCap);
      mesh.name = 'trees:near:' + kind;
      mesh.userData.kind = kind;
      mesh.userData.ids = new Int32Array(this.tp.nearCap);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.setColorAt(0, col.setRGB(1, 1, 1));
      this.group.add(mesh);
      return mesh;
    });
    this.nearIndex = new Map();      // tree -> [look, slot in the near mesh]
    this.lastFill = null;
    this.cells = new Map();
    for (let k = 0; k < n; k++) {
      const key = Math.floor(this.tx[k] / NEAR_BUCKET) + '_' + Math.floor(this.tz[k] / NEAR_BUCKET);
      let c = this.cells.get(key);
      if (!c) { c = []; this.cells.set(key, c); }
      c.push(k);
    }
    scene.add(this.group);
  }

  _matrix(k, m) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw[k]);
    const r = this.scale[2 * k], h = this.scale[2 * k + 1];
    return m.compose(new THREE.Vector3(this.tx[k], this.ty[k], this.tz[k]), q, new THREE.Vector3(r, h, r));
  }

  // hide tree k in its chunk mesh (zero scale, same place) or restore its matrix
  _hide(k, hidden) {
    const mesh = this.chunkOf[k], i = this.slot[k];
    const orig = this._entryOf(mesh).orig.get(mesh), arr = mesh.instanceMatrix.array;
    for (let e = 0; e < 16; e++) arr[i * 16 + e] = orig[i * 16 + e];
    if (hidden) for (const e of [0, 1, 2, 4, 5, 6, 8, 9, 10]) arr[i * 16 + e] = 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  _entryOf(mesh) { return this.byKey.get(mesh.name.split(':')[1]); }

  /* Stand the trees of h1 chunk `key` on surfaceAt(x, z), the surface drawn there (null
   * leaves a tree where it is), the near set's copies included. Returns how many moved. */
  reground(key, surfaceAt) {
    const g = this.byKey.get(key);
    if (!g) return 0;
    let moved = 0, nearMoved = false;
    for (const mesh of g.meshes) {
      const ids = mesh.userData.ids, orig = g.orig.get(mesh), arr = mesh.instanceMatrix.array;
      let changed = false;
      for (let i = 0; i < ids.length; i++) {
        const k = ids[i], y = surfaceAt(this.tx[k], this.tz[k]);
        if (y === null || y === undefined || y === this.ty[k]) continue;
        this.ty[k] = y;
        orig[i * 16 + 13] = y;
        arr[i * 16 + 13] = y;
        changed = true;
        moved++;
        const at = this.nearIndex.get(k);
        if (at) {
          const nm = this.nearMeshes[at[0]];
          nm.instanceMatrix.array[at[1] * 16 + 13] = y;
          nm.instanceMatrix.needsUpdate = true;
          nearMoved = true;
        }
      }
      if (changed) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
    }
    if (nearMoved) for (const nm of this.nearMeshes) nm.computeBoundingSphere();
    return moved;
  }

  /* Levels of detail for the camera at `cam`: each chunk's mid or far geometry (with 20 m of
   * hysteresis around PROFILES.treesNear), and the near set once the camera has moved more
   * than 5 m. True iff any geometry, matrix or count changed. */
  update(cam) {
    let changed = false;
    const edge = this.profile.treesNear, half = this.tp.hyst / 2;
    for (const g of this.groups) {
      const dx = Math.max(g.x0 - cam.x, 0, cam.x - (g.x0 + g.side));
      const dz = Math.max(g.z0 - cam.z, 0, cam.z - (g.z0 + g.side));
      const d = Math.hypot(dx, dz);
      let mid = g.near;
      if (!g.lodSet) { mid = d < edge; g.lodSet = true; }
      else if (g.near && d > edge + half) mid = false;
      else if (!g.near && d < edge - half) mid = true;
      if (mid === g.near) continue;
      g.near = mid;
      changed = true;
      for (const mesh of g.meshes) {
        mesh.geometry = this.geo[mesh.userData.kind + (mid ? 'Mid' : 'Far')];
        mesh.receiveShadow = mid;
      }
    }
    if (this._refill(cam)) changed = true;
    return changed;
  }

  _refill(cam) {
    const last = this.lastFill;
    if (last && Math.hypot(cam.x - last[0], cam.y - last[1], cam.z - last[2]) <= NEAR_REFILL) return false;
    this.lastFill = [cam.x, cam.y, cam.z];
    const R = this.tp.nearRadius, B = NEAR_BUCKET, found = [[], []];
    for (let i = Math.floor((cam.x - R) / B); i <= Math.floor((cam.x + R) / B); i++) {
      for (let j = Math.floor((cam.z - R) / B); j <= Math.floor((cam.z + R) / B); j++) {
        for (const k of this.cells.get(i + '_' + j) || []) {
          const d = Math.hypot(this.tx[k] - cam.x, this.ty[k] - cam.y, this.tz[k] - cam.z);
          if (d <= R) found[this.look[k]].push([d, k]);
        }
      }
    }
    const next = new Map();
    for (let look = 0; look < 2; look++) {
      found[look].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      found[look].slice(0, this.tp.nearCap).forEach(([, k], slot) => next.set(k, [look, slot]));
    }
    let same = next.size === this.nearIndex.size;
    if (same) for (const [k, at] of next) { const was = this.nearIndex.get(k); if (!was || was[1] !== at[1]) { same = false; break; } }
    if (same) return false;
    for (const k of this.nearIndex.keys()) if (!next.has(k)) this._hide(k, false);
    for (const k of next.keys()) if (!this.nearIndex.has(k)) this._hide(k, true);
    this.nearIndex = next;
    const m = new THREE.Matrix4(), col = new THREE.Color(), counts = [0, 0];
    for (const [k, [look, slot]] of next) {
      const nm = this.nearMeshes[look];
      nm.setMatrixAt(slot, this._matrix(k, m));
      nm.setColorAt(slot, col.setRGB(this.colour[3 * k], this.colour[3 * k + 1], this.colour[3 * k + 2]));
      nm.userData.ids[slot] = k;
      counts[look] = Math.max(counts[look], slot + 1);
    }
    this.nearMeshes.forEach((nm, look) => {
      nm.count = counts[look];
      nm.instanceMatrix.needsUpdate = true;
      if (nm.instanceColor) nm.instanceColor.needsUpdate = true;
      nm.computeBoundingSphere();
    });
    return true;
  }

  /* Chunk meshes that meet `rect` ({x0, z0, x1, z1}, local metres) cast shadows, the others
   * do not; the near set always does. null: every chunk casts. True iff a flag changed. */
  setShadowFocus(rect) {
    let changed = false;
    for (const g of this.groups) {
      const on = !rect || (g.x0 <= rect.x1 && g.x0 + g.side >= rect.x0 && g.z0 <= rect.z1 && g.z0 + g.side >= rect.z0);
      for (const mesh of g.meshes) if (mesh.castShadow !== on) { mesh.castShadow = on; changed = true; }
    }
    return changed;
  }

  nearSet() {
    const ids = [...this.nearIndex.keys()].sort((a, b) => a - b);
    return { ids, count: ids.length };
  }

  lookCounts() { return { conifer: this.looks.conifer, broad: this.looks.broad }; }

  dispose() {
    for (const g of Object.values(this.geo)) g.dispose();
    this.material.dispose();
    for (const g of this.groups) for (const m of g.meshes) m.dispose();
    for (const m of this.nearMeshes) m.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

// ------------------------------------------------------------------ buildings
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

// Drawn, not measured (a visible choice each, one line to change):
export const OVERHANG = { pitched: 0.4, flat: 0.15, fallback: 0 };   // eave inset of the walls, m
export const FASCIA = 0.2;                                             // trim board under the eaves, m
// The listing house is drawn only as measured (Joseph's answer, A2): no drawn eave, no
// fascia, and a plain roof in its highlight colour. Its walls keep the cladding.
export const HOUSE_OVERHANG = { pitched: 0, flat: 0, fallback: 0 };   // walls at the measured roof edge
export const HOUSE_FASCIA = 0;
export const HOUSE_ROOF_MAP = null;                                    // plain roof: no tile courses ('tiles' to add them)
// Colours: neighbours neutral with a +-5 % lightness jitter and no hue change; the house keeps
// its highlight, which is not its real colour. Walls are lifted 8 % for the cladding's average.
const COLOURS = { others: { walls: 0xcfc9bd, roof: 0x5f6664 }, house: { walls: 0xc98e5c, roof: 0x7c2e3e } };
const WALL_LIFT = 1.08, TRIM_SHADE = 0.8, JITTER = 0.05;
const SLICE = { buildings: 50, ms: 8 };   // neighbours are meshed in slices this size, at most
const MODELS = new Set(['flat', 'shed', 'gable', 'hip', 'split']);
const WALL_TILE = 1.6;                    // roofmesh.js TILE.wall: a wall's v is height / 1.6

/* The features of a buildings.json document, or [] (reported through onError) if it is
 * not version 1. */
export function buildingFeatures(doc, onError) {
  if (!doc || typeof doc !== 'object') return [];
  if (doc.version !== 1) {
    if (onError) onError(new Error('buildings.json version ' + doc.version + ' is not supported'));
    return [];
  }
  return Array.isArray(doc.features) ? doc.features : [];
}

/* What a feature is drawn as, worked out once per feature object:
 * {id, ground, top, ridge, prep (roofmesh), fallback, malformed, model, pitched, box, ring}. */
const plans = new WeakMap();
function planOf(f) {
  if (!f || typeof f !== 'object') return null;
  if (plans.has(f)) return plans.get(f);
  let plan = null;
  const ground = Number(f.ground), roof = Number(f.roof);
  if (Array.isArray(f.ring) && f.ring.length >= 3 && Number.isFinite(ground) && Number.isFinite(roof)) {
    const top = Math.max(roof, ground + 2);
    const s = f.roof_shape;
    let prep = null, malformed = false, ridge = top;
    if (s !== undefined && s !== null && !(typeof s === 'object' && s.model === 'none')) {
      try {
        if (typeof s !== 'object' || !MODELS.has(s.model)) throw new Error('unknown model');
        prep = prepareShape(s);
        if (!(lowestRoof(prep) >= ground - 2 + 0.5)) throw new Error('roof below the walls');
        if (!Number.isFinite(s.ridge)) throw new Error('ridge');
        ridge = s.ridge;
      } catch (e) {
        prep = null;
        malformed = true;
      }
    }
    const fallback = !prep;
    if (fallback) prep = prismShape(f.ring, top);
    let box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of prep.outline.concat(f.ring)) {
      box = [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])];
    }
    plan = { f, id: f.id, ground, top, ridge, prep, fallback, malformed, model: fallback ? null : s.model,
             pitched: !fallback && isPitched(prep), box, ring: prep.outline };
  }
  plans.set(f, plan);
  return plan;
}

function meshOptions(plan, isHouse, opts = {}) {
  const kind = plan.fallback ? 'fallback' : plan.pitched ? 'pitched' : 'flat';
  const overhang = opts.overhang !== undefined ? opts.overhang : (isHouse ? HOUSE_OVERHANG : OVERHANG)[kind];
  const fascia = opts.fascia !== undefined ? opts.fascia : (plan.fallback ? 0 : isHouse ? HOUSE_FASCIA : FASCIA);
  return { overhang, fascia, topGroup: plan.fallback ? GROUP.trim : GROUP.roofs };
}

function coloursFor(plan, isHouse) {
  const c = COLOURS[isHouse ? 'house' : 'others'];
  const j = isHouse ? 1 : 1 + JITTER * (2 * hash2(Number(plan.id) * 7919 + 13, 101) - 1);
  const walls = new THREE.Color(c.walls).multiplyScalar(WALL_LIFT * j);
  const roof = new THREE.Color(c.roof).multiplyScalar(j);
  const trim = roof.clone().multiplyScalar(TRIM_SHADE);
  return [walls, roof, trim];
}

const boxMeets = (b, r) => b[0] <= r.x1 && b[2] >= r.x0 && b[1] <= r.z1 && b[3] >= r.z0;

/* One of the two building meshes, built from per-building meshes in one go. Its index is
 * laid out walls, roofs, trim, each a geometry group, and within a group one contiguous
 * block per building, so setShadowFocus() can put the buildings near the sun's box first. */
class BuildingMesh {
  constructor(name, materials) {
    this.mesh = new THREE.Mesh(BuildingMesh.empty(), materials);
    this.mesh.name = name;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.entries = [];
    this.inFocus = [0, 0, 0];
    this.focusKey = null;
    this.source = null;
    this.mesh.onBeforeShadow = (r, o, cam, sc, geometry, depth, group) => {
      if (!group) return;
      geometry.drawRange.start = group.start;
      geometry.drawRange.count = this.inFocus[group.materialIndex];
    };
    this.mesh.onAfterShadow = (r, o, cam, sc, geometry) => {
      geometry.drawRange.start = 0;
      geometry.drawRange.count = Infinity;
    };
  }

  static empty() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('cwGround', new THREE.Float32BufferAttribute([], 1));
    g.setIndex([]);
    for (let m = 0; m < 3; m++) g.addGroup(0, 0, m);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    return g;
  }

  /* entries: [{item, mesh (roofmesh output), colours [walls, roofs, trim]}] */
  build(entries) {
    // within each group, buildings in 240 m squares, row by row, for locality
    const sq = (e) => [Math.floor(e.item.box[1] / 240), Math.floor(e.item.box[0] / 240)];
    entries = entries.slice().sort((a, b) => { const p = sq(a), q = sq(b); return p[0] - q[0] || p[1] - q[1] || a.order - b.order; });
    let nv = 0, ni = 0;
    for (const e of entries) { e.voff = nv; nv += e.mesh.pos.length / 3; ni += e.mesh.idx.length; }
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
    const gnd = new Float32Array(nv);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    for (const e of entries) {
      pos.set(e.mesh.pos, e.voff * 3);
      uv.set(e.mesh.uv, e.voff * 2);
      gnd.fill(e.item.ground, e.voff, e.voff + e.mesh.pos.length / 3);
      const I = e.mesh.idx, G = e.mesh.groups;
      for (let t = 0; t < G.length; t++) {
        const c = e.colours[G[t]];
        for (let k = 0; k < 3; k++) {
          const v = e.voff + I[3 * t + k];
          col[3 * v] = c.r; col[3 * v + 1] = c.g; col[3 * v + 2] = c.b;
        }
      }
    }
    const starts = [0, 0, 0], counts = [0, 0, 0];
    let cursor = 0;
    for (let g = 0; g < 3; g++) {
      starts[g] = cursor;
      for (const e of entries) {
        e.blocks = e.blocks || [];
        const I = e.mesh.idx, G = e.mesh.groups, from = cursor;
        for (let t = 0; t < G.length; t++) {
          if (G[t] !== g) continue;
          idx[cursor++] = e.voff + I[3 * t];
          idx[cursor++] = e.voff + I[3 * t + 1];
          idx[cursor++] = e.voff + I[3 * t + 2];
        }
        e.blocks[g] = [from, cursor - from];
      }
      counts[g] = cursor - starts[g];
    }
    for (const e of entries) e.item.verts = e.mesh.wallBottom.map((v) => v + e.voff);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('cwGround', new THREE.BufferAttribute(gnd, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    for (let g = 0; g < 3; g++) geo.addGroup(starts[g], counts[g], g);
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const old = this.mesh.geometry;
    this.mesh.geometry = geo;
    old.dispose();
    this.entries = entries;
    this.starts = starts;
    this.counts = counts;
    this.source = idx.slice();
    this.inFocus = counts.slice();
    this.focusKey = null;
  }

  /* Put the buildings whose box meets rect first within each group; null: all in focus.
   * True iff the order or the in-focus counts changed. */
  focus(rect) {
    if (!this.source) return false;
    const inside = this.entries.map((e) => !rect || boxMeets(e.item.box, rect));
    const key = inside.map((b) => (b ? '1' : '0')).join('');
    if (key === this.focusKey) return false;
    this.focusKey = key;
    const idx = this.mesh.geometry.index.array, src = this.source;
    for (let g = 0; g < 3; g++) {
      let w = this.starts[g];
      for (const want of [true, false]) {
        this.entries.forEach((e, i) => {
          if (inside[i] !== want) return;
          const [from, n] = e.blocks[g];
          if (n) idx.set(src.subarray(from, from + n), w);
          w += n;
        });
        if (want) this.inFocus[g] = w - this.starts[g];
      }
    }
    this.mesh.geometry.index.needsUpdate = true;
    return true;
  }
}

/* Buildings: each drawn from its measured roof where the file has a sound roof_shape, and
 * as a flat-topped prism at max(roof, ground + 2) where it does not (the top then plain,
 * in the trim group). `ground` is the median terrain under a footprint, so on a slope the
 * ground just outside the downhill wall is lower than that: walls start sunk 2 m below
 * it, and reground() takes them further down, to the lowest ground drawable around the
 * footprint, once the heights there are loaded.
 * The house is meshed at once; the neighbours in slices of at most 50 buildings or 8 ms,
 * on a setTimeout chain, and drawn in one swap when the last slice ends (`ready`). */
export function buildBuildings(features) {
  const maps = detailMaps();
  const matsFor = (roofMap) => {
    const walls = new THREE.MeshLambertMaterial({ vertexColors: true, map: maps.cladding });
    const roofs = new THREE.MeshLambertMaterial({ vertexColors: true, map: roofMap, side: THREE.DoubleSide });
    const trim = new THREE.MeshLambertMaterial({ vertexColors: true });
    for (const m of [walls, roofs, trim]) m.toneMapped = false;
    return [walls, roofs, trim];
  };
  const house = new BuildingMesh('house', matsFor(HOUSE_ROOF_MAP === 'tiles' ? maps.tiles : null));
  const others = new BuildingMesh('buildings', matsFor(maps.tiles));
  const group = new THREE.Group();
  group.name = 'buildings';
  group.add(others.mesh, house.mesh);

  const items = [], byId = new Map(), pending = [];
  const info = { byModel: {}, fallback: 0, malformed: 0 };
  let houseInfo = null, houseEntry = null, order = 0;
  for (const f of features || []) {
    const plan = planOf(f);
    if (!plan) continue;
    const isHouse = f.house === true && !houseInfo;
    const item = { id: f.id, house: isHouse, ground: plan.ground, bottom: plan.ground - 2, roof: plan.ridge,
                   box: plan.box, target: isHouse ? 'house' : 'others', verts: null, plan };
    items.push(item);
    byId.set(f.id, item);
    if (plan.fallback) info.fallback++;
    else info.byModel[plan.model] = (info.byModel[plan.model] || 0) + 1;
    if (plan.malformed) info.malformed++;
    const entry = { item, order: order++, colours: coloursFor(plan, isHouse), mesh: null };
    if (isHouse) {
      houseInfo = { ring: plan.ring, ground: plan.ground, roof: plan.ridge, centroid: ringCentroid(plan.ring),
                    id: f.id, shape: plan.fallback ? null : f.roof_shape };
      houseEntry = entry;
    } else {
      pending.push(entry);
    }
  }
  const timing = { houseMs: 0, slices: 0, longestSliceMs: 0, totalMs: 0, swapMs: 0 };
  const mesh1 = (entry) => meshBuilding(entry.item.plan.prep, entry.item.bottom, meshOptions(entry.item.plan, entry.item.house));
  let t0 = performance.now();
  if (houseEntry) {
    houseEntry.mesh = mesh1(houseEntry);
    house.build([houseEntry]);
  }
  timing.houseMs = performance.now() - t0;

  let lastRect = null, disposed = false;
  const ready = new Promise((resolve) => {
    const start = performance.now();
    let next = 0;
    const slice = () => {
      if (disposed) { resolve(false); return; }
      const s0 = performance.now();
      let n = 0;
      while (next < pending.length && n < SLICE.buildings && (n === 0 || performance.now() - s0 < SLICE.ms)) {
        pending[next].mesh = mesh1(pending[next]);
        next++;
        n++;
      }
      if (next >= pending.length) {
        const w0 = performance.now();
        others.build(pending);
        others.focus(lastRect);
        timing.swapMs = performance.now() - w0;
      }
      const ms = performance.now() - s0;
      timing.slices++;
      timing.longestSliceMs = Math.max(timing.longestSliceMs, ms);
      if (next < pending.length) { setTimeout(slice, 0); return; }
      timing.totalMs = performance.now() - start;
      resolve(true);
    };
    setTimeout(slice, 0);
  });

  const meshes = { house, others };
  /* lowestAt(x0, z0, x1, z1) gives the lowest ground drawable over a box, or null while it
   * is not known. `touches(box)`, when given, limits the work to the buildings it accepts.
   * Returns how many buildings were lowered (a building not yet meshed is meshed with it). */
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
      lowered++;
      if (!it.verts) continue;
      const geo = meshes[it.target].mesh.geometry;
      const P = geo.attributes.position.array, U = geo.attributes.uv.array;
      for (const v of it.verts) { P[v * 3 + 1] = bottom; U[v * 2 + 1] = bottom / WALL_TILE; }
      dirty.add(it.target);
    }
    for (const t of dirty) {
      const g = meshes[t].mesh.geometry;
      g.attributes.position.needsUpdate = true;
      g.attributes.uv.needsUpdate = true;
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    return lowered;
  }

  return {
    group, othersMesh: others.mesh, houseMesh: house.mesh, house: houseInfo, count: items.length, items, reground, ready,
    timing,
    /* Test hook: one building's geometry, rebuilt off-scene (by default as drawn). */
    meshFor(id, opts = {}) {
      const it = byId.get(id);
      if (!it) return null;
      const m = meshBuilding(it.plan.prep, it.bottom, meshOptions(it.plan, it.house, opts));
      return { pos: m.pos, uv: m.uv, idx: m.idx, groups: m.groups, wallBottom: m.wallBottom };
    },
    setShadowFocus(rect) {
      lastRect = rect || null;
      const a = house.focus(lastRect), b = others.focus(lastRect);
      return a || b;
    },
    /* Test hook: the index counts in focus, and in all, per group of each mesh. */
    shadowFocus() {
      return { house: { inFocus: house.inFocus.slice(), counts: (house.counts || [0, 0, 0]).slice() },
               others: { inFocus: others.inFocus.slice(), counts: (others.counts || [0, 0, 0]).slice() } };
    },
    info() { return { byModel: Object.assign({}, info.byModel), fallback: info.fallback, malformed: info.malformed }; },
    dispose() {
      disposed = true;
      for (const b of [house, others]) {
        b.mesh.geometry.dispose();
        for (const m of b.mesh.material) m.dispose();
      }
      if (group.parent) group.parent.remove(group);
      releaseDetailMaps();
    }
  };
}

/* The drawn outlines in 16 m buckets, for walking: inside one the ground is its roof as
 * drawn (the planes of the part containing the point), or the flat top of a prism. */
export class FootprintIndex {
  constructor(features) {
    this.size = 16;
    this.cells = new Map();
    for (const f of features || []) {
      const plan = planOf(f);
      if (!plan) continue;
      const b = plan.box;
      for (let i = Math.floor(b[0] / this.size); i <= Math.floor(b[2] / this.size); i++) {
        for (let j = Math.floor(b[1] / this.size); j <= Math.floor(b[3] / this.size); j++) {
          const k = i + '_' + j;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k).push(plan);
        }
      }
    }
  }
  roofAt(x, z) {
    const list = this.cells.get(Math.floor(x / this.size) + '_' + Math.floor(z / this.size));
    if (!list) return null;
    for (const p of list) {
      const b = p.box;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      const y = roofOf(p.prep, x, z);
      if (y !== null) return y;
    }
    return null;
  }
}

// ------------------------------------------------------------------ plot fence
/* A low (0.4 m) ribbon along every ring of the parcel, standing on the drawn surface, so
 * the boundary reads from a distance. Rebuilt when the ground under it changes. */
export class PlotFence {
  constructor(scene, parcels) {
    this.rings = [];
    for (const p of parcels || []) {
      if (Array.isArray(p.ring) && p.ring.length >= 3) this.rings.push(p.ring);
      for (const h of p.holes || []) if (Array.isArray(h) && h.length >= 3) this.rings.push(h);
    }
    this.colour = new THREE.Color(0xb8552f);
    this.material = new THREE.MeshBasicMaterial({
      color: this.colour.clone(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2
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
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.scene.add(this.mesh);
    return missing;
  }
  /* The fence's colour times f, f in [0.4, 1] (dimmed at night). */
  setDim(f) {
    const k = Math.max(0.4, Math.min(1, Number(f)));
    this.material.color.copy(this.colour).multiplyScalar(Number.isFinite(k) ? k : 1);
  }
  dispose() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    this.material.dispose();
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
