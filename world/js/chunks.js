/* Commons World: height chunks on the page side.
 *
 * Keeps every chunk the manifest lists and loads them nearest-first through a pool of
 * stateless workers (worker.js).
 *   - h1 (within 1.5 km) is an adaptive TIN per chunk, with a tolerance that grows with
 *     distance: tau(d) = max(tmin, px K d), px a CSS-pixel target and K radians per CSS
 *     pixel. The page keeps each chunk's error map beside its heights, and re-meshes a
 *     chunk when the camera has moved more than max(16 m, a quarter of its distance) since
 *     the camera its mesh was made for. Each h1 chunk has its own textured material
 *     (terrainmat.js).
 *   - h5 and h20 are smooth grids whose stride is picked from the camera distance (with
 *     hysteresis).
 * Worker replies are installed a few per frame (the install throttle), so a burst of
 * replies never uploads in one frame. Ground-height questions are answered from the data
 * the page holds, for exactly the surface that is drawn; that is what walking, trees,
 * the fence and picking use.
 */
import * as THREE from 'three';
import { makeChunkMaterial, ensureNoise, setFade, setHorizon, setPlot, sharedTextures, disposeShared,
         rockWeight } from './terrainmat.js';

// Drawing detail, per profile (PLAN.md section 4).
// tin: px, the CSS-pixel target; tmin, the finest tolerance (m); snapMin and snapFrac, the
//   refresh rule; heldCap, the h1 triangles held before px is raised; errors, 'exact' or
//   'bound' (cheaper, more triangles); install, what may be installed per frame; tier, the
//   material's quality; fade, (detail fade start, end, far-colour fade start, end) in m.
export const PROFILES = {
  phone: {
    name: 'phone',
    tin: { px: 2, tmin: 0.05, snapMin: 16, snapFrac: 0.25, heldCap: 250000, errors: 'exact',
           install: { chunks: 4, triangles: 150000 }, tier: 'phone', fade: [42, 420, 280, 1050] },
    h5: { strides: [1, 2, 4, 8], at: [450, 1000, 2000] },
    h20: { strides: [1, 2, 4], at: [3000, 5500] },
    treesNear: 200,
    pixelRatio: 1.5
  },
  laptop: {
    name: 'laptop',
    tin: { px: 1, tmin: 0.05, snapMin: 16, snapFrac: 0.25, heldCap: 600000, errors: 'exact',
           install: { chunks: 8, triangles: 400000 }, tier: 'laptop', fade: [60, 600, 400, 1500] },
    h5: { strides: [1, 2, 4, 8], at: [700, 1500, 3000] },
    h20: { strides: [1, 2, 4], at: [4000, 7000] },
    treesNear: 450,
    pixelRatio: 2
  }
};
const HYSTERESIS = 40;          // metres beyond a threshold before going coarser
const JOBS_PER_WORKER = 2;      // a fetch in flight while another chunk meshes
const PLOT_TEXELS = { phone: 256, laptop: 512 };   // the plot's signed-distance texture
const PLOT_MARGIN = 20;         // metres round the parcels' box
const TILE = 16, TILES = 15, NV = 241;
const RK = 1 / (2 * Math.SQRT2 - 2);   // 1.2071: the nested bounding radius per metre of hypotenuse
const SIDES = [[0, 1], [1, 0], [0, -1], [-1, 0]];   // N, E, S, W as (di, dj); j counts northward
const H5_STRIDES = [1, 2, 4, 8];

function parseKey(key) {
  const m = /^(-?\d+)_(-?\d+)$/.exec(key);
  if (!m) throw new Error('bad chunk key ' + JSON.stringify(key));
  return [Number(m[1]), Number(m[2])];
}

function safeRelative(path) {
  // A manifest path must stay inside the world folder.
  if (typeof path !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(path) || path.startsWith('/') ||
      path.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('unsafe path in manifest: ' + JSON.stringify(path));
  }
  return path;
}

/* Today's resize rule in main.js, which owns the camera: the profile's base field of view
 * (70 degrees on a phone, 62 on a laptop), widened in portrait to keep about 55 degrees
 * across, at most 90. Returns K = 2 tan(fov / 2) / the CSS height: radians per CSS pixel.
 * Used until main.js calls setView(). */
export function defaultK(profile) {
  const w = (typeof innerWidth === 'number' && innerWidth) || 1280, h = (typeof innerHeight === 'number' && innerHeight) || 720;
  const base = profile && profile.name === 'phone' ? 70 : 62;
  const across = 2 * Math.atan(Math.tan(27.5 * Math.PI / 180) / (w / h)) * 180 / Math.PI;
  const fov = Math.min(90, Math.max(base, across));
  return 2 * Math.tan(fov * Math.PI / 360) / h;
}

// ------------------------------------------------------------------ the TIN, page side
/* Corner (a, b) of a decoded h1 chunk, row a from the north: the mean of its four samples
 * in metres, at most -3 m when two or more are sea, rounded to float32. The worker's rule
 * (worker.js tinCorners), in the same order, so the heights equal the drawn vertices. */
export function cornerHeight(data, a, b) {
  const h = data.header, W = h.width, base = h.base, v = data.v, cls = data.classes, t0 = a * W + b;
  let sum = 0, ns = 0;
  for (let u = 0; u < 4; u++) {
    const t = u === 0 ? t0 : u === 1 ? t0 + 1 : u === 2 ? t0 + W : t0 + W + 1;
    const dm = base + v[t], c = cls ? cls[t] : 0;
    sum += dm / 10;
    if (c === 5 || (dm <= 0 && c !== 4)) ns++;
  }
  let y = sum / 4;
  if (ns >= 2) y = Math.min(y, -3);
  return { y: Math.fround(y), sea: ns >= 2 };
}

/* The leaf triangle of a TIN tile holding tile-local point (u, v), both in [0, 16], by
 * walking the split bits worker.js set (at most 9 steps): root id 3 (u > v) or 2, then
 * child (c, a, m) = id + 2^(k+1) or (b, c, m) = id + 2^k, whichever side of c-m the point
 * is on. Returns [ax, ay, bx, by, cx, cy, id] in tile-local (x, row). */
export function tinLeaf(split, tile, u, v) {
  let ax, ay, bx, by, cx, cy, id;
  if (u > v) { ax = 0; ay = 0; bx = TILE; by = TILE; cx = TILE; cy = 0; id = 3; }
  else { ax = TILE; ay = TILE; bx = 0; by = 0; cx = 0; cy = TILE; id = 2; }
  let bit = 2;
  while (id < 512 && (split[tile * 64 + ((id - 2) >> 3)] & (1 << ((id - 2) & 7)))) {
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const side = (mx - cx) * (v - cy) - (my - cy) * (u - cx);
    const sideA = (mx - cx) * (ay - cy) - (my - cy) * (ax - cx);
    if (side * sideA >= 0) { const nx = cx, ny = cy; bx = ax; by = ay; ax = nx; ay = ny; cx = mx; cy = my; id += 2 * bit; }
    else { ax = bx; ay = by; bx = cx; by = cy; cx = mx; cy = my; id += bit; }
    bit *= 2;
  }
  return [ax, ay, bx, by, cx, cy, id];
}
const FULL_SPLIT = new Uint8Array(TILES * TILES * 64).fill(255);

// Height over a leaf of chunk data at chunk-local (lx, lz); {y, sea} with y = max(0, s).
function leafHeight(data, split, lx, lz) {
  const tx = Math.min(TILES - 1, Math.max(0, Math.floor(lx / TILE))), ty = Math.min(TILES - 1, Math.max(0, Math.floor(lz / TILE)));
  const u = lx - TILE * tx, v = lz - TILE * ty, X = TILE * tx, Y = TILE * ty;
  const [ax, ay, bx, by, cx, cy] = tinLeaf(split, ty * TILES + tx, u, v);
  const A = cornerHeight(data, Y + ay, X + ax), B = cornerHeight(data, Y + by, X + bx), C = cornerHeight(data, Y + cy, X + cx);
  if (A.sea && B.sea && C.sea) return { y: 0, sea: true };
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / d;
  const wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / d;
  const s = wa * A.y + wb * B.y + (1 - wa - wb) * C.y;
  return { y: Math.max(0, s), sea: s <= 0 };
}

export class ChunkManager {
  constructor({ scene, manifest, worldBase, profile, plotRings, onChange, onError, useCache = true }) {
    this.scene = scene;
    this.manifest = manifest;
    this.worldBase = worldBase;
    this.profile = profile;
    this.tin = profile.tin || PROFILES[profile.name === 'phone' ? 'phone' : 'laptop'].tin;
    this.onChange = onChange || (() => {});
    this.onError = onError || (() => {});
    this.useCache = useCache;
    this.oe = manifest.crs.origin_e;
    this.on = manifest.crs.origin_n;
    this.offset = Number(manifest.crs.grid_north_offset_deg) || 0;
    this.plotRings = (plotRings || []).filter((r) => r.length >= 6);
    this.levels = {};
    this.chunks = [];
    this.byKey = {};
    this.queue = [];
    this.inflight = 0;          // jobs posted and not yet installed, discarded or failed
    this.posted = 0;            // jobs a worker is still working on
    this.seq = 0;
    this.pending = new Map();
    this.pendingInstalls = [];
    this.dispatchLog = [];
    this.loadedCount = 0;
    this.failed = 0;
    this.cam = new THREE.Vector3();
    this.jobs = { load: 0, mesh: 0 };
    this.levelSeamRemeshes = 0;
    this.levelVersion = 0;      // bumped when an h5 chunk loads
    this.maxInstallsPerFrame = 0;
    this.maxInstallTrisPerFrame = 0;
    this.discarded = 0;
    this.pxScale = 1;           // the heldCap safety net: px x this
    this.lastRaise = -Infinity;
    this.underHalfSince = null;
    this.force = null;          // tinForce(): {tau} or {px}
    this.viewK = null;          // setView()
    this.K = defaultK(profile);
    this.plot = null;
    this.plotPosted = false;
    this.drain = null;
    this.disposed = false;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.smoothMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.smoothMaterial.toneMapped = false;
    ensureNoise();
    setFade(this.tin.fade);
    if (scene.fog && scene.fog.color) setHorizon(scene.fog.color);

    for (const lv of manifest.levels) {
      if (!['h1', 'h5', 'h20'].includes(lv.name)) continue;   // unknown levels are ignored
      const side = lv.cell * lv.chunk_samples;
      const level = {
        name: lv.name, cell: lv.cell, side, radius: lv.radius, samples: lv.chunk_samples, apron: lv.apron === undefined ? 1 : lv.apron,
        present: new Set(Object.keys(lv.chunks)), sea: new Set(lv.sea || []), count: 0
      };
      this.levels[lv.name] = level;
      for (const [key, entry] of Object.entries(lv.chunks)) {
        const [i, j] = parseKey(key);
        const c = {
          level, key, i, j, entry,
          url: new URL(safeRelative(entry.file), worldBase).href,
          x0: i * side - this.oe,                // local x of the square's west edge
          z0: -((j + 1) * side - this.on),       // local z of the square's north edge
          min: entry.min, max: entry.max,
          status: 'queued', data: null, mesh: null, lod: 0, busy: false, queuedMesh: false,
          seqNext: 0, installedSeq: 0, busySeq: 0, forceStale: false
        };
        this.chunks.push(c);
        this.byKey[level.name + ':' + key] = c;
      }
    }
    this.total = this.chunks.length;
    // For h5 and h20: the squares a finer level leaves to this one, for distances.
    for (const c of this.chunks) {
      if (c.level.name === 'h1') continue;
      const o = this.jobOptions(c, 1).opts;
      if (!o.holes) continue;
      const g = o.holeGrid, ss = c.level.side / g;
      c.drawn = [];
      for (let a = 0; a < g; a++) for (let b = 0; b < g; b++) {
        if (!o.holes[a * g + b]) c.drawn.push([c.x0 + b * ss, c.z0 + a * ss, ss]);
      }
    }

    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    this.workers = [];
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._reply(ev.data);
      w.onerror = (ev) => {
        ev.preventDefault();
        this.onError(new Error('chunk worker failed: ' + (ev.message || 'unknown error')));
      };
      w.jobs = 0;
      w.postMessage({ type: 'init', id: 0, originE: this.oe, originN: this.on, rings: this.plotRings });
      this.workers.push(w);
    }
    // While the tab is hidden requestAnimationFrame does not fire: the install drain moves
    // to setTimeout, and back.
    this._onVisibility = () => {
      if (!this.drain) return;
      this._cancelDrain();
      this._scheduleDrain();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
  }

  // ------------------------------------------------------------ distances and detail
  distance(c, cam) {
    const s = c.level.side;
    const dx = Math.max(c.x0 - cam.x, 0, cam.x - (c.x0 + s));
    const dz = Math.max(c.z0 - cam.z, 0, cam.z - (c.z0 + s));
    const dy = Math.max(0, cam.y - (c.max == null ? 0 : c.max));
    if (c.level.name === 'h1' || !c.drawn) return Math.sqrt(dx * dx + dz * dz + dy * dy);
    // An h5 or h20 chunk near the middle is mostly hole: measure to the part that is drawn.
    let best = Infinity;
    for (const [sx0, sz0, ss] of c.drawn) {
      const ex = Math.max(sx0 - cam.x, 0, cam.x - (sx0 + ss));
      const ez = Math.max(sz0 - cam.z, 0, cam.z - (sz0 + ss));
      best = Math.min(best, ex * ex + ez * ez);
    }
    return best === Infinity ? 1e9 : Math.sqrt(best + dy * dy);
  }

  // The h5 or h20 stride for a chunk (h1 has none: its detail is the tolerance).
  detailFor(c, cam, current) {
    const rule = this.profile[c.level.name];
    const values = rule.strides;
    const d = this.distance(c, cam);
    const fine = rule.at.filter((t) => d >= t).length;
    const lag = rule.at.filter((t) => d >= t + HYSTERESIS).length;
    const cur = values.indexOf(current);
    let idx;
    if (cur < 0) idx = fine;
    else if (fine < cur) idx = fine;
    else if (lag > cur) idx = lag;
    else idx = cur;
    return values[Math.min(idx, values.length - 1)];
  }

  // What a chunk's CWH1 header must say, from its manifest key (FORMAT.md sections 2 and 3):
  // cell size, the stored array's north-west corner in decimetres, EPSG and the apron'd size.
  expectedHeader(c) {
    const lv = c.level, cellCm = Math.round(lv.cell * 100), W = lv.samples + 2 * lv.apron;
    return {
      cellCm, width: W, height: W, epsg: this.manifest.crs.epsg,
      cornerEdm: Math.round((c.i * lv.side - lv.apron * lv.cell) * 10),
      cornerNdm: Math.round(((c.j + 1) * lv.side + lv.apron * lv.cell) * 10)
    };
  }

  // ------------------------------------------------------------ h1 tolerance and borders
  // The effective pixel target (the profile's, or tinForce's, times the heldCap factor).
  px() { return (this.force && this.force.px !== undefined ? this.force.px : this.tin.px) * this.pxScale; }

  // The tolerance for a job on chunk c now: {tau} or {px, K, tmin, cam} (cam chunk-local).
  tolFor(c) {
    if (this.force && this.force.tau !== undefined) return { tau: this.force.tau };
    return { px: this.px(), K: this.K, tmin: this.tin.tmin, cam: [this.cam.x - c.x0, this.cam.y, this.cam.z - c.z0] };
  }

  neighbourKey(c, side) { return (c.i + SIDES[side][0]) + '_' + (c.j + SIDES[side][1]); }

  /* Per side: 'h1' where an h1 land chunk is across it, 'sea' for an h1 sea square, else
   * 'outer' (the h5 hole's edge), with the lowest the loaded h5 chunk draws along the side
   * at any of its strides, per metre, or null until that chunk has loaded. */
  bordersFor(c) {
    const lv = c.level, out = [];
    for (let s = 0; s < 4; s++) {
      const k = this.neighbourKey(c, s);
      if (lv.present.has(k)) out.push({ kind: 'h1', floor: null });
      else if (lv.sea.has(k)) out.push({ kind: 'sea', floor: null });
      else out.push({ kind: 'outer', floor: this.outerFloor(c, s) });
    }
    return out;
  }

  // The h5 chunk that draws the square across side s of h1 chunk c, if loaded.
  h5Across(c, s) {
    const S = c.level.side, cx = c.x0 + S / 2 + SIDES[s][0] * S, cz = c.z0 + S / 2 - SIDES[s][1] * S;
    const h5 = this.chunkAt('h5', cx, cz);
    return h5 && h5.data ? h5 : null;
  }

  // Point k (0..240) along side s of chunk c, local metres (N and S west to east, E and W north to south).
  sidePoint(c, s, k) {
    const S = c.level.side;
    if (s === 0) return [c.x0 + k, c.z0];
    if (s === 1) return [c.x0 + S, c.z0 + k];
    if (s === 2) return [c.x0 + k, c.z0 + S];
    return [c.x0, c.z0 + k];
  }

  /* The lowest the h5 chunk across side s of c draws along it, per metre, at any of its
   * strides; null until that chunk has loaded. It depends only on that chunk's heights,
   * which never change once loaded, so it is worked out once per side and kept (bordersFor
   * runs on every h1 job): the array is shared, and callers only read it. */
  outerFloor(c, s) {
    const h5 = this.h5Across(c, s);
    if (!h5) return null;
    const kept = c.floors || (c.floors = [null, null, null, null]);
    if (kept[s] && kept[s].data === h5.data) return kept[s].floor;
    const out = new Float32Array(NV);
    for (let k = 0; k < NV; k++) {
      const [x, z] = this.sidePoint(c, s, k);
      let low = Infinity;
      for (const st of H5_STRIDES) low = Math.min(low, this._smoothAtStride(h5, x, z, st).y);
      out[k] = low;
    }
    kept[s] = { data: h5.data, floor: out };
    return out;
  }

  /* An h5 chunk has loaded: re-mesh any facing h1 chunk whose skirt bottom lies above the
   * new floor minus 0.5 anywhere (the tiles design's derived floor). */
  checkLevelSeams(h5) {
    const S5 = h5.level.side;
    for (const c of this.chunks) {
      if (c.level.name !== 'h1' || c.status !== 'ready') continue;
      // only chunks whose outer neighbour squares this h5 chunk covers
      let near = false;
      for (let s = 0; s < 4 && !near; s++) {
        const S = c.level.side, cx = c.x0 + S / 2 + SIDES[s][0] * S, cz = c.z0 + S / 2 - SIDES[s][1] * S;
        if (cx >= h5.x0 && cx < h5.x0 + S5 && cz >= h5.z0 && cz < h5.z0 + S5) near = true;
      }
      if (near) this._checkSkirtFloors(c);
    }
  }

  _checkSkirtFloors(c) {
    if (!c.bottoms || c.forceStale) return false;
    const b = this.bordersFor(c);
    for (let s = 0; s < 4; s++) {
      if (b[s].kind !== 'outer' || !b[s].floor) continue;
      const bot = c.bottoms[s], f = b[s].floor;
      for (let k = 0; k < NV; k++) {
        if (Number.isFinite(bot[k]) && bot[k] > f[k] - 0.5 + 1e-4) {
          this.levelSeamRemeshes++;
          this._queueMesh(c, true);
          return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------ h5 and h20 options
  jobOptions(c, detail) {
    const lv = c.level;
    // holes where the next finer level covers (its chunks and its sea squares)
    const finer = lv.name === 'h5' ? this.levels.h1 : this.levels.h5;
    let holes = null, grid = 1, holeCells = lv.samples;
    if (finer) {
      grid = Math.round(lv.side / finer.side);
      holeCells = lv.samples / grid;
      holes = new Uint8Array(grid * grid);
      for (let a = 0; a < grid; a++) {
        for (let b = 0; b < grid; b++) {
          const fi = c.i * grid + b, fj = (c.j + 1) * grid - 1 - a;   // row a counts from the north
          const k = fi + '_' + fj;
          if (finer.present.has(k) || finer.sea.has(k)) holes[a * grid + b] = 1;
        }
      }
    }
    const strideM = detail * lv.cell;
    return {
      mode: 'smooth',
      opts: { stride: detail, holeCells, holeGrid: grid, holes, skirt: 10 + 0.75 * strideM }
    };
  }

  // ------------------------------------------------------------ worker jobs
  /* Post a job to the least busy worker. `installs`: the job's reply is installed (or
   * discarded) later, and inflight falls then, exactly once (_done); otherwise it falls at
   * the reply. queue.length + inflight therefore counts every job whose effect is not in
   * place yet, which is what settle() waits on. */
  _post(msg, installs) {
    let best = this.workers[0];
    for (const w of this.workers) if (w.jobs < best.jobs) best = w;
    const id = ++this.seq;
    msg.id = id;
    best.jobs++;
    this.posted++;
    this.inflight++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: best, installs: !!installs });
      best.postMessage(msg);
    });
  }

  _reply(data) {
    const p = this.pending.get(data.id);
    if (!p) return;              // the init acknowledgement
    this.pending.delete(data.id);
    p.worker.jobs--;
    this.posted--;
    if (!p.installs) this.inflight--;
    if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
  }

  _done() { this.inflight--; }

  start(cam) {
    this.cam.copy(cam);
    for (const c of this.chunks) this.queue.push({ c, kind: 'load' });
    this.pump();
  }

  update(cam) {
    if (this.disposed) return;
    this.cam.copy(cam);
    if (this.viewK === null) this._setK(defaultK(this.profile));
    this._heldCheck();
    for (const c of this.chunks) {
      if (c.status !== 'ready' || c.queuedMesh) continue;
      if (c.level.name === 'h1') {
        // Stale against the newest camera sent: a job in flight already has it, so it is not
        // queued again unless the camera has moved on from that one too.
        if (c.forceStale) this._queueMesh(c, false);
        else if (c.busy && c.busyTol) { if (this._stale(c, c.busyTol)) this._queueMesh(c, false); }
        else if (this._stale(c, c.tolInfo) && !this.floorAlready(c)) this._queueMesh(c, false);
      } else {
        if (c.busy) continue;
        const want = this.detailFor(c, cam, c.lod);
        if (want !== c.lod) { c.queuedMesh = true; this.queue.push({ c, kind: 'mesh' }); }
      }
    }
    this.pump();
  }

  _queueMesh(c, force) {
    if (force) c.forceStale = true;
    if (c.queuedMesh || c.status !== 'ready') return;
    c.queuedMesh = true;
    this.queue.push({ c, kind: 'mesh' });
  }

  /* The refresh rule: stale when the camera has moved more than max(snapMin, snapFrac D)
   * from the camera a mesh was made for (t, the installed one's or the one in flight), D
   * the distance to the chunk's box. A uniform tolerance does not depend on the camera, so
   * it never goes stale. */
  _stale(c, t) {
    if (!t) return false;
    if (t.tau !== undefined) return false;
    const moved = Math.hypot(this.cam.x - t.cam[0], this.cam.y - t.cam[1], this.cam.z - t.cam[2]);
    return moved > Math.max(this.tin.snapMin, this.tin.snapFrac * this.distance(c, this.cam));
  }

  /* Skip a re-mesh that would change nothing that matters: the installed mesh is the
   * 450-triangle floor (no split), no root would split at the current camera, and no skirt
   * would need to be deeper (every border segment's tolerance now is at most its tolerance
   * when installed). The tolerance settings must be the installed ones. */
  floorAlready(c) {
    const t = c.tolInfo;
    if (!t || !c.floorMesh || !c.E || t.tau !== undefined) return false;
    const now = this.tolFor(c);
    if (now.tau !== undefined || !this._sameSettings(t, now)) return false;
    const k = now.px * now.K, tmin = now.tmin;
    let yVis = 0;
    for (let q = 0; q < c.tileMax.length; q++) if (c.tileMax[q] > yVis) yVis = c.tileMax[q];
    const cx = now.cam[0], cz = now.cam[2], dyNow = Math.max(0, now.cam[1] - yVis);
    const ox = t.cam[0] - c.x0, oz = t.cam[2] - c.z0, dyOld = Math.max(0, t.cam[1] - yVis);
    const tau = (dh, dy) => Math.max(tmin, k * Math.hypot(dh, dy));
    const L = TILE * Math.SQRT2;
    for (let ty = 0; ty < TILES; ty++) {
      for (let tx = 0; tx < TILES; tx++) {
        const mx = tx * TILE + 8, mz = ty * TILE + 8, e = c.E[mz * NV + mx];
        if (e > 0 && e > tau(Math.max(0, Math.hypot(mx - cx, mz - cz) - RK * L), dyNow) * 100) return false;
      }
    }
    const near = (x0, z0, x1, z1, px, pz) => {
      const sx = Math.max(Math.min(px, Math.max(x0, x1)), Math.min(x0, x1)), sz = Math.max(Math.min(pz, Math.max(z0, z1)), Math.min(z0, z1));
      return Math.hypot(sx - px, sz - pz);
    };
    for (let s = 0; s < 4; s++) {
      for (let q = 0; q < TILES; q++) {
        const a = q * TILE, b = a + TILE;
        const seg = s === 0 ? [a, 0, b, 0] : s === 1 ? [240, a, 240, b] : s === 2 ? [a, 240, b, 240] : [0, a, 0, b];
        const tn = tau(near(seg[0], seg[1], seg[2], seg[3], cx, cz), dyNow);
        const to = tau(near(seg[0], seg[1], seg[2], seg[3], ox, oz), dyOld);
        if (tn > to + 1e-9) return false;
      }
    }
    return true;
  }

  pump() {
    if (this.disposed) return;
    const cap = this.workers.length * JOBS_PER_WORKER;
    while (this.posted < cap && this.queue.length) {
      // nearest first, measured from where the camera is now; finer levels win ties; at most
      // one job in flight per chunk
      let bi = -1, bd = Infinity;
      for (let k = 0; k < this.queue.length; k++) {
        const job = this.queue[k];
        if (job.c.busy) continue;
        const bias = job.c.level.name === 'h1' ? 0 : job.c.level.name === 'h5' ? 60 : 180;
        const d = this.distance(job.c, this.cam) + bias + (job.kind === 'mesh' ? 30 : 0);
        if (d < bd) { bd = d; bi = k; }
      }
      if (bi < 0) break;
      const job = this.queue.splice(bi, 1)[0];
      this._run(job);
    }
  }

  async _run(job) {
    const c = job.c, isH1 = c.level.name === 'h1';
    let detail, msg, tolInfo = null;
    if (job.kind === 'mesh') c.queuedMesh = false;
    if (isH1) {
      const tol = this.tolFor(c), borders = this.bordersFor(c);
      detail = tol.tau !== undefined ? { tau: tol.tau } : { px: tol.px };
      tolInfo = tol.tau !== undefined ? { tau: tol.tau } : { px: tol.px, K: tol.K, tmin: tol.tmin, cam: [this.cam.x, this.cam.y, this.cam.z] };
      tolInfo.levelVersion = this.levelVersion;
      const opts = Object.assign({}, tol, { borders });
      if (job.kind === 'load') {
        opts.errors = this.tin.errors;
        msg = { type: 'load', url: c.url, useCache: this.useCache, expect: this.expectedHeader(c), mode: 'tin', opts };
      } else {
        c.forceStale = false;
        msg = { type: 'mesh', mode: 'tin', data: c.data, E: c.E, opts };
      }
    } else {
      detail = this.detailFor(c, this.cam, job.kind === 'load' ? 0 : c.lod);
      if (job.kind === 'mesh' && detail === c.lod) return;   // the camera came back before it ran
      const o = this.jobOptions(c, detail);
      msg = job.kind === 'load'
        ? { type: 'load', url: c.url, useCache: this.useCache, expect: this.expectedHeader(c), mode: o.mode, opts: o.opts }
        : { type: 'mesh', data: c.data, mode: o.mode, opts: o.opts };
    }
    const seq = ++c.seqNext;
    msg.seq = seq;
    c.busy = true;
    c.busySeq = seq;
    c.busyTol = tolInfo;
    if (job.kind === 'load') c.status = 'loading';
    this.dispatchLog.push({ key: c.key, level: c.level.name, kind: job.kind, detail });
    if (isH1) this.jobs[job.kind]++;
    const reply = this._post(msg, true);
    if (job.kind === 'load' && !this.plotPosted) this._postPlot();
    let res;
    try {
      res = await reply;
    } catch (err) {
      this._fail(c, job.kind, err);
      this.pump();
      return;
    }
    this._enqueue({ c, res, kind: job.kind, detail, seq, tolInfo });
    this.pump();
  }

  _fail(c, kind, err) {
    if (c.busySeq) { c.busy = false; c.busySeq = 0; c.busyTol = null; }
    this._done();
    if (this.disposed) return;
    if (kind === 'load') { c.status = 'error'; this.failed++; }
    this.onError(new Error(c.level.name + ' ' + c.key + ': ' + err.message));
  }

  // ------------------------------------------------------------ the install throttle
  _enqueue(entry) {
    const c = entry.c;
    if (this.disposed) { this._done(); return; }
    if (c.reorderNext && entry.kind === 'mesh') {
      // test hook: hold this reply back until the chunk's next one has arrived
      c.reorderNext = false;
      c.held = entry;
      c.busy = false;
      c.busySeq = 0;
      c.busyTol = null;
      return;
    }
    this.pendingInstalls.push(entry);
    if (c.held) { this.pendingInstalls.push(c.held); c.held = null; }
    this._scheduleDrain();
  }

  _scheduleDrain() {
    if (this.drain || this.disposed) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden || typeof requestAnimationFrame !== 'function') {
      this.drain = { timeout: setTimeout(() => { this.drain = null; this._drain(); }, 0) };
    } else {
      this.drain = { raf: requestAnimationFrame(() => { this.drain = null; this._drain(); }) };
    }
  }

  _cancelDrain() {
    if (!this.drain) return;
    if (this.drain.timeout !== undefined) clearTimeout(this.drain.timeout);
    if (this.drain.raf !== undefined) cancelAnimationFrame(this.drain.raf);
    this.drain = null;
  }

  // Install within the frame's budget: install.chunks replies and install.triangles triangles
  // (at least one reply per frame, whatever its size).
  _drain() {
    if (this.disposed) return;
    const budget = this.tin.install;
    let n = 0, tris = 0;
    while (this.pendingInstalls.length && n < budget.chunks) {
      const e = this.pendingInstalls[0], t = e.res.mesh ? e.res.mesh.triangles : 0;
      if (n > 0 && tris + t > budget.triangles) break;
      this.pendingInstalls.shift();
      if (this._install(e)) { n++; tris += t; }
    }
    if (n > this.maxInstallsPerFrame) this.maxInstallsPerFrame = n;
    if (tris > this.maxInstallTrisPerFrame) this.maxInstallTrisPerFrame = tris;
    this._heldCheck();
    if (this.pendingInstalls.length) this._scheduleDrain();
    this.pump();
  }

  // Returns false when the reply was stale and discarded.
  _install(e) {
    const c = e.c, res = e.res, m = res.mesh, isH1 = c.level.name === 'h1';
    if (c.busySeq === e.seq) { c.busy = false; c.busySeq = 0; c.busyTol = null; }
    if (e.seq <= c.installedSeq) {           // an older reply than the one installed
      this.discarded++;
      this._done();
      return false;
    }
    c.installedSeq = e.seq;
    if (e.kind === 'load') c.data = { header: res.header, v: res.v, classes: res.classes };
    if (isH1 && e.kind === 'load') {
      c.E = res.E; c.tileMin = res.tileMin; c.tileMax = res.tileMax; c.loadMs = res.ms;
      const levels = [res.classes || new Uint8Array(242 * 242)].concat(res.tex.classMips);
      const classTex = new THREE.DataTexture(levels[0], 242, 242, THREE.RedFormat, THREE.UnsignedByteType);
      let w = 242;
      classTex.mipmaps = levels.map((data) => { const mm = { data, width: w, height: w }; w = Math.max(1, w >> 1); return mm; });
      classTex.generateMipmaps = false;
      classTex.minFilter = THREE.NearestFilter;
      classTex.magFilter = THREE.NearestFilter;
      classTex.unpackAlignment = 1;
      classTex.colorSpace = THREE.NoColorSpace;
      classTex.needsUpdate = true;
      const normalTex = new THREE.DataTexture(res.tex.normal, NV, NV, THREE.RGFormat, THREE.UnsignedByteType);
      normalTex.generateMipmaps = true;
      normalTex.minFilter = THREE.LinearMipmapLinearFilter;
      normalTex.magFilter = THREE.LinearFilter;
      normalTex.unpackAlignment = 1;
      normalTex.colorSpace = THREE.NoColorSpace;
      normalTex.needsUpdate = true;
      c.tex = { classTex, normalTex, normal: res.tex.normal, classBytes: levels.reduce((s, l) => s + l.length, 0) };
      c.material = makeChunkMaterial({ classTex, normalTex }, this.tin.tier);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3, true));
    if (m.col) g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    const s = c.level.side;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, m.yMin, 0), new THREE.Vector3(s, m.yMax, s));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const old = c.mesh;
    const mesh = new THREE.Mesh(g, isH1 ? c.material : this.smoothMaterial);
    mesh.name = c.level.name + ':' + c.key;
    mesh.position.set(c.x0, 0, c.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.castShadow = false;
    mesh.receiveShadow = isH1;
    mesh.userData.triangles = m.triangles;
    mesh.visible = m.triangles > 0;
    if (isH1) {
      mesh.userData.skirtTriangles = m.skirtTriangles;
      mesh.userData.snap = e.tolInfo.cam ? e.tolInfo.cam.slice() : null;
      mesh.userData.seq = e.seq;
      mesh.userData.split = res.split;
      c.split = res.split;
      c.bottoms = m.bottoms;
      c.floorMesh = !!m.floor;
      c.tolInfo = e.tolInfo;
      c.lod = 'tin';
    } else {
      c.lod = e.detail;
    }
    this.group.add(mesh);
    if (old) { this.group.remove(old); old.geometry.dispose(); }
    c.mesh = mesh;
    if (e.kind === 'load') {
      c.status = 'ready';
      c.level.count++;
      this.loadedCount++;
    }
    this._done();
    try {
      this.onChange(c, e.kind);
    } catch (err) {
      this.onError(err);
    }
    if (c.level.name === 'h5' && e.kind === 'load') { this.levelVersion++; this.checkLevelSeams(c); }
    // A job keeps the settings it was sent with. If they changed while it was out (a resize
    // through setView, the heldCap net, tinForce), _markStale could not reach a chunk that
    // was still loading, and the camera may never move far enough to re-mesh it: do it now.
    if (isH1 && !this._sameSettings(e.tolInfo, this.tolFor(c))) this._queueMesh(c, true);
    else if (isH1 && e.tolInfo.levelVersion !== this.levelVersion) this._checkSkirtFloors(c);
    return true;
  }

  // Were a job's tolerance settings (px, K, tmin, or a pinned tau; not its camera) these?
  _sameSettings(t, now) {
    if (!t) return false;
    if (now.tau !== undefined) return t.tau === now.tau;
    return t.tau === undefined && t.px === now.px && t.K === now.K && t.tmin === now.tmin;
  }

  // The heldCap safety net: above the cap, px rises x1.25 (up to 4x); after 5 s under half
  // the cap it steps back down.
  _heldCheck() {
    if (this.force && this.force.tau !== undefined) return;   // a pinned tolerance: nothing to relax
    const held = this.heldTriangles(), cap = this.tin.heldCap, now = performance.now();
    if (held > cap) {
      this.underHalfSince = null;
      if (this.pxScale < 4 && now - this.lastRaise > 1000) {
        this.pxScale = Math.min(4, this.pxScale * 1.25);
        this.lastRaise = now;
        this._markStale();
      }
    } else if (this.pxScale > 1 && held < cap / 2) {
      if (this.underHalfSince === null) this.underHalfSince = now;
      else if (now - this.underHalfSince > 5000) {
        this.pxScale = Math.max(1, this.pxScale / 1.25);
        this.underHalfSince = now;
        this._markStale();
      }
    } else {
      this.underHalfSince = null;
    }
  }

  _markStale() { for (const c of this.chunks) if (c.level.name === 'h1' && c.status === 'ready') c.forceStale = true; }

  _setK(K) {
    if (!(K > 0)) return;
    if (Math.abs(K - this.K) / this.K > 0.02) { this.K = K; this._markStale(); }
  }

  // ------------------------------------------------------------ queries
  get done() { return this.loadedCount + this.failed === this.total; }

  counts() {
    const out = {};
    for (const [name, lv] of Object.entries(this.levels)) out[name] = lv.count;
    return out;
  }

  triangles() {
    const out = { all: 0 };
    for (const c of this.chunks) {
      if (!c.mesh) continue;
      out.all += c.mesh.userData.triangles;
      out[c.level.name] = (out[c.level.name] || 0) + c.mesh.userData.triangles;
    }
    return out;
  }

  heldTriangles() {
    let n = 0;
    for (const c of this.chunks) if (c.mesh && c.level.name === 'h1') n += c.mesh.userData.triangles;
    return n;
  }

  // Keys '<level>@<lod>': every h1 chunk under 'h1@tin', h5 and h20 by stride.
  lodSummary() {
    const out = {};
    for (const c of this.chunks) {
      if (!c.mesh) continue;
      const k = c.level.name + '@' + c.lod;
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  chunkAt(levelName, x, z) {
    const lv = this.levels[levelName];
    if (!lv) return null;
    const e = x + this.oe, n = this.on - z;
    const c = this.byKey[levelName + ':' + Math.floor(e / lv.side) + '_' + Math.floor(n / lv.side)];
    return c || null;
  }

  isSeaSquare(levelName, x, z) {
    const lv = this.levels[levelName];
    if (!lv) return false;
    const e = x + this.oe, n = this.on - z;
    return lv.sea.has(Math.floor(e / lv.side) + '_' + Math.floor(n / lv.side));
  }

  /* The ground as drawn at local (x, z): {y, sea, level}, or null where nothing is loaded.
   * h1: the installed TIN, exactly (the leaf found from the split bits, interpolated over
   * its corners' float32 heights), with y = max(0, s) and the water at 0. Beyond: the h5,
   * then h20, surface exactly as drawn (_smoothAt). Never a raycast. */
  groundAt(x, z) {
    const h1 = this.chunkAt('h1', x, z);
    if (h1 && h1.data && h1.split) {
      const r = leafHeight(h1.data, h1.split, x - h1.x0, z - h1.z0);
      return { y: r.y, sea: r.sea, level: 'h1' };
    }
    if (this.isSeaSquare('h1', x, z)) return { y: 0, sea: true, level: 'h1' };
    for (const name of ['h5', 'h20']) {
      const c = this.chunkAt(name, x, z);
      if (c && c.data) return this._smoothAt(c, x, z);
      if (this.isSeaSquare(name, x, z)) return { y: 0, sea: true, level: name };
    }
    return null;
  }

  // What trees, the fence, picking and the walker stand on: the height of the drawn ground.
  surfaceAt(x, z) {
    const g = this.groundAt(x, z);
    return g ? g.y : null;
  }

  /* A test hook: the tau = 0 surface. h1: linear over the 1 m corners, split along the same
   * diagonal as the TIN's finest level, max(0, s); h5 and h20: _smoothAt. Independent of the
   * installed h1 meshes. */
  refSurfaceAt(x, z) {
    const h1 = this.chunkAt('h1', x, z);
    if (h1 && h1.data) return leafHeight(h1.data, FULL_SPLIT, x - h1.x0, z - h1.z0).y;
    if (this.isSeaSquare('h1', x, z)) return 0;
    for (const name of ['h5', 'h20']) {
      const c = this.chunkAt(name, x, z);
      if (c && c.data) return this._smoothAt(c, x, z).y;
      if (this.isSeaSquare(name, x, z)) return 0;
    }
    return null;
  }

  /* The smooth surface as worker.js meshSmooth draws it at the chunk's current stride:
   * triangles (nw, sw, se) and (nw, se, ne) over cell corners, each corner the mean of the
   * four samples around it, pushed to -3 m when two or more of them are sea. Flying is held
   * above this, so the eye never dips under the ground that is shown. */
  _smoothAt(c, x, z) {
    return this._smoothAtStride(c, x, z, c.mesh && c.lod > 0 ? c.lod : 1);
  }

  _smoothAtStride(c, x, z, s) {
    const h = c.data.header, W = h.width, K = W - 2, base = h.base, v = c.data.v, cls = c.data.classes;
    const step = s * h.cell, nq = K / s;
    const lx = x - c.x0, lz = z - c.z0;
    const b = Math.max(0, Math.min(nq - 1, Math.floor(lx / step)));
    const a = Math.max(0, Math.min(nq - 1, Math.floor(lz / step)));
    const u = Math.max(0, Math.min(1, lx / step - b)), w = Math.max(0, Math.min(1, lz / step - a));
    const corner = (A, B) => {
      const t0 = A * s * W + B * s;
      let sum = 0, sea = 0;
      for (const t of [t0, t0 + 1, t0 + W, t0 + W + 1]) {
        const dm = base + v[t], k = cls ? cls[t] : 0;
        sum += dm / 10;
        if (k === 5 || (dm <= 0 && k !== 4)) sea++;
      }
      return sea >= 2 ? Math.min(sum / 4, -3) : sum / 4;
    };
    const nw = corner(a, b), ne = corner(a, b + 1), sw = corner(a + 1, b), se = corner(a + 1, b + 1);
    const y = w >= u ? nw + w * (sw - nw) + u * (se - sw) : nw + u * (ne - nw) + w * (se - ne);
    return { y: Math.max(0, y), sea: y <= 0, level: c.level.name };
  }

  /* The lowest ground drawn anywhere over the box (local metres), at every tolerance: the
   * minimum of tileMin over every 16 m h1 tile the box touches (every drawn triangle lies in
   * one tile and interpolates that tile's corners); an h1 sea square counts as the water at
   * 0. null while an h1 chunk the box needs is not loaded, or where the box leaves h1. */
  lowestGround(xa, za, xb, zb) {
    const lv = this.levels.h1;
    if (!lv) return null;
    const S = lv.side;
    const e0 = Math.floor((xa + this.oe) / TILE), e1 = Math.floor((xb + this.oe) / TILE);
    const n0 = Math.floor((this.on - zb) / TILE), n1 = Math.floor((this.on - za) / TILE);
    let low = Infinity;
    for (let tn = n0; tn <= n1; tn++) {
      for (let te = e0; te <= e1; te++) {
        const i = Math.floor(te * TILE / S), j = Math.floor(tn * TILE / S);
        const c = this.byKey['h1:' + i + '_' + j];
        if (!c) {
          if (lv.sea.has(i + '_' + j)) { if (low > 0) low = 0; continue; }
          return null;
        }
        if (!c.tileMin) return null;
        const tx = te - i * (S / TILE), ty = (j + 1) * (S / TILE) - 1 - tn;
        const v = c.tileMin[ty * TILES + tx];
        if (v < low) low = v;
      }
    }
    return low === Infinity ? null : low;
  }

  /* A CPU mirror of the shader's unwarped class lookup: {cls, rock, level}. cls from the
   * class band; rock in [0, 1] from the 1 m corner normal (bilinear, as the texture is
   * sampled) and the onset table. */
  materialAt(x, z) {
    if (!this.chunkAt('h1', x, z) && this.isSeaSquare('h1', x, z)) return { cls: 5, rock: 0, level: 'h1' };
    for (const name of ['h1', 'h5', 'h20']) {
      const c = this.chunkAt(name, x, z);
      if (!c || !c.data) continue;
      const d = c.data, W = d.header.width, cell = d.header.cell || c.level.cell;
      const lx = (x - c.x0) / cell, lz = (z - c.z0) / cell;
      const col = Math.min(W - 2, Math.floor(lx)) + 1, row = Math.min(W - 2, Math.floor(lz)) + 1;
      const cls = d.classes ? d.classes[row * W + col] : 0;
      let ny;
      if (name === 'h1' && c.tex) {
        const nt = c.tex.normal, px = Math.min(NV - 1, Math.max(0, lx)), pz = Math.min(NV - 1, Math.max(0, lz));
        const b0 = Math.min(NV - 2, Math.floor(px)), a0 = Math.min(NV - 2, Math.floor(pz)), fu = px - b0, fv = pz - a0;
        const at = (a, b, k) => nt[(a * NV + b) * 2 + k] / 255 * 2 - 1;
        const bil = (k) => (1 - fv) * ((1 - fu) * at(a0, b0, k) + fu * at(a0, b0 + 1, k)) + fv * ((1 - fu) * at(a0 + 1, b0, k) + fu * at(a0 + 1, b0 + 1, k));
        const nx = bil(0), nz = bil(1);
        ny = Math.sqrt(Math.max(0, 1 - nx * nx - nz * nz));
      } else {
        const a = Math.min(W - 2, Math.round(lz)), b = Math.min(W - 2, Math.round(lx)), t = a * W + b, v = d.v;
        const gx = ((v[t + 1] + v[t + W + 1]) - (v[t] + v[t + W])) / (20 * cell), gz = ((v[t + W] + v[t + W + 1]) - (v[t] + v[t + 1])) / (20 * cell);
        ny = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      }
      return { cls, rock: rockWeight(cls, ny), level: name };
    }
    return null;
  }

  /* The plot mark, integrated from the signed distances the page keeps (the values the
   * shader reads), sampled every 0.25 m, bilinear: the washed area (sd < 0), the polygon
   * area of the rings (holes subtracted), and the area of the thinnest line (|sd| < 0.3). */
  plotMark() {
    const p = this.plot;
    let polygonArea = 0;
    const rings = this.plotRings;
    const inside = (ring, x, z) => {
      let inn = false;
      for (let a = 0, b = ring.length / 2 - 1; a < ring.length / 2; b = a++) {
        const xa = ring[2 * a], za = ring[2 * a + 1], xb = ring[2 * b], zb = ring[2 * b + 1];
        if ((za > z) !== (zb > z) && x < (xb - xa) * (z - za) / (zb - za) + xa) inn = !inn;
      }
      return inn;
    };
    rings.forEach((r, k) => {
      let a2 = 0;
      for (let a = 0, b = r.length / 2 - 1; a < r.length / 2; b = a++) a2 += r[2 * b] * r[2 * a + 1] - r[2 * a] * r[2 * b + 1];
      let depth = 0;
      rings.forEach((o, q) => { if (q !== k && inside(o, r[0], r[1])) depth++; });
      polygonArea += (depth % 2 ? -1 : 1) * Math.abs(a2) / 2;
    });
    if (!p) return { area: 0, polygonArea, lineArea: 0 };
    const [x0, z0, x1, z1] = p.bbox, n = p.n, dx = (x1 - x0) / n, dz = (z1 - z0) / n, h = 0.25;
    let area = 0, lineArea = 0;
    for (let z = z0 + h / 2; z < z1; z += h) {
      const fz = Math.min(n - 1, Math.max(0, (z - z0) / dz - 0.5)), j0 = Math.min(n - 2, Math.floor(fz)), tz = fz - j0;
      for (let x = x0 + h / 2; x < x1; x += h) {
        const fx = Math.min(n - 1, Math.max(0, (x - x0) / dx - 0.5)), i0 = Math.min(n - 2, Math.floor(fx)), tx = fx - i0;
        const s = p.sdf, r0 = j0 * n + i0, r1 = r0 + n;
        const sd = (1 - tz) * ((1 - tx) * s[r0] + tx * s[r0 + 1]) + tz * ((1 - tx) * s[r1] + tx * s[r1 + 1]);
        if (sd < 0) area += h * h;
        if (Math.abs(sd) < 0.3) lineArea += h * h;
      }
    }
    return { area, polygonArea, lineArea };
  }

  _postPlot() {
    this.plotPosted = true;
    if (!this.plotRings.length) return;
    let b = null;
    for (const r of this.plotRings) {
      for (let k = 0; k < r.length; k += 2) {
        if (!b) b = [r[k], r[k + 1], r[k], r[k + 1]];
        b[0] = Math.min(b[0], r[k]); b[1] = Math.min(b[1], r[k + 1]); b[2] = Math.max(b[2], r[k]); b[3] = Math.max(b[3], r[k + 1]);
      }
    }
    const bbox = [b[0] - PLOT_MARGIN, b[1] - PLOT_MARGIN, b[2] + PLOT_MARGIN, b[3] + PLOT_MARGIN];
    const n = PLOT_TEXELS[this.tin.tier] || 512;
    this._post({ type: 'plotSdf', bbox, texels: n }, true).then((res) => {
      if (this.disposed) { this._done(); return; }
      const half = new Uint16Array(n * n), back = new Float32Array(n * n);
      for (let k = 0; k < n * n; k++) { half[k] = THREE.DataUtils.toHalfFloat(res.sdf[k]); back[k] = THREE.DataUtils.fromHalfFloat(half[k]); }
      const t = new THREE.DataTexture(half, n, n, THREE.RedFormat, THREE.HalfFloatType);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      t.name = 'cwT-plot';
      t.needsUpdate = true;
      this.plot = { bbox, n, sdf: back, texture: t };
      setPlot(t, bbox);
      this._done();
    }, (err) => {
      this._done();
      if (!this.disposed) this.onError(new Error('plot outline: ' + err.message));
    });
  }

  /* The horizon as drawn (or, with surface 'reference', over the tau = 0 surface) from
   * (x, z), eye metres above that ground: index k is true bearing k x 0.5 degrees, the
   * value the highest angle in degrees, marching 1 m in h1, 5 m in h5 and 20 m in h20 out
   * to maxM, with the earth's curvature and refraction as facts/horizon.py (a drop of
   * d^2 (1 - 0.13) / 2R); a ray that finds no ground reads 0. */
  drawnHorizon(x, z, { eye = 1.5, maxM = 11000, surface = 'drawn' } = {}) {
    const surf = surface === 'reference' ? (a, b) => this.refSurfaceAt(a, b) : (a, b) => this.surfaceAt(a, b);
    const g0 = surf(x, z);
    const out = new Float64Array(720);
    if (g0 === null) return out;
    const eyeY = g0 + eye, R = 6371000;
    const step = (px, pz) => (this.chunkAt('h1', px, pz) || this.isSeaSquare('h1', px, pz) ? 1
      : this.chunkAt('h5', px, pz) || this.isSeaSquare('h5', px, pz) ? 5 : 20);
    for (let k = 0; k < 720; k++) {
      const g = (k * 0.5 + this.offset) * Math.PI / 180, dx = Math.sin(g), dz = -Math.cos(g);
      let best = -Infinity;
      for (let d = 1; d <= maxM;) {
        const px = x + dx * d, pz = z + dz * d, y = surf(px, pz);
        if (y !== null) {
          const a = Math.atan((y - d * d * (1 - 0.13) / (2 * R) - eyeY) / d);
          if (a > best) best = a;
        }
        d += step(px, pz);
      }
      out[k] = Number.isFinite(best) ? best * 180 / Math.PI : 0;
    }
    return out;
  }

  // ------------------------------------------------------------ transition shims
  drawnTopAt(x, z) { return this.surfaceAt(x, z); }                                     // SHIM(G2)
  lowestTop(xa, za, xb, zb) { return this.lowestGround(xa, za, xb, zb); }               // SHIM(G2)
  plotTint() { return {}; }                                                              // SHIM(G2)

  // ------------------------------------------------------------ views, stats and test hooks
  /* K = 2 tan(fov / 2) / cssHeight; every h1 chunk goes stale when it changes by more
   * than 2 %. */
  setView(fovDeg, cssHeight) {
    this.viewK = 2 * Math.tan(fovDeg * Math.PI / 360) / Math.max(1, cssHeight);
    this._setK(this.viewK);
  }

  terrainInfo() {
    const keys = new Set();
    let materials = 0, textures = 0, textureBytes = 0, chunkTextureBytes = 0;
    for (const c of this.chunks) {
      if (!c.material) continue;
      materials++;
      keys.add(c.material.customProgramCacheKey());
      if (c.tex) {
        textures += 2;
        let nb = 0;
        for (let w = NV; ; w = Math.max(1, w >> 1)) { nb += w * w * 2; if (w === 1) break; }
        textureBytes += c.tex.classBytes + nb;
        chunkTextureBytes = Math.max(chunkTextureBytes, c.tex.classBytes + nb);
      }
    }
    for (const t of sharedTextures()) {
      textures++;
      const img = t.image, bpp = t.type === THREE.HalfFloatType ? 2 : 4;
      let nb = img.width * img.height * bpp;
      if (t.generateMipmaps) nb = Math.round(nb * 4 / 3);
      textureBytes += nb;
    }
    return { programs: keys.size, materials, textures, textureBytes, chunkTextureBytes };
  }

  tinStats() {
    let maxSnapAgeM = 0;
    for (const c of this.chunks) {
      if (c.level.name !== 'h1' || !c.tolInfo || !c.tolInfo.cam) continue;
      const t = c.tolInfo.cam;
      maxSnapAgeM = Math.max(maxSnapAgeM, Math.hypot(this.cam.x - t[0], this.cam.y - t[1], this.cam.z - t[2]));
    }
    return {
      px: this.px(), tmin: this.tin.tmin, heldCap: this.tin.heldCap, held: this.heldTriangles(),
      jobs: { load: this.jobs.load, mesh: this.jobs.mesh }, maxSnapAgeM, levelSeamRemeshes: this.levelSeamRemeshes,
      maxInstallsPerFrame: this.maxInstallsPerFrame, maxInstallTrisPerFrame: this.maxInstallTrisPerFrame,
      pxScale: this.pxScale, K: this.K, discarded: this.discarded, force: this.force
    };
  }

  /* A test hook: {tau: m} pins every h1 chunk to a uniform tolerance, {px} sets the pixel
   * target, null releases. Every h1 chunk goes stale. */
  tinForce(opt) {
    this.force = opt ? Object.assign({}, opt) : null;
    this._markStale();
  }

  /* Re-mesh every loaded h1 chunk for this camera, so meshes do not depend on the path the
   * camera took (used by settle()). A chunk whose newest mesh (the one in flight, else the
   * installed one) was made for exactly this camera, with the same tolerance settings and
   * the same h5 floors, is left alone, and so is one already queued (a queued job reads the
   * camera when it is sent): meshing is deterministic, so it would come back the same. A
   * second call at the same camera therefore costs nothing. */
  forceSnapshots(cam) {
    if (cam) this.cam.copy(cam);
    for (const c of this.chunks) {
      if (c.level.name !== 'h1' || c.status !== 'ready') continue;
      if (c.queuedMesh || (!c.forceStale && this._meshedHere(c))) continue;
      this._queueMesh(c, true);
    }
    this.pump();
  }

  // Was chunk c's newest mesh made for exactly the current camera and settings?
  _meshedHere(c) {
    const t = c.busy ? c.busyTol : c.tolInfo, now = this.tolFor(c);
    if (!t || t.levelVersion !== this.levelVersion || !this._sameSettings(t, now)) return false;
    if (now.tau !== undefined) return true;
    return !!t.cam && t.cam[0] === this.cam.x && t.cam[1] === this.cam.y && t.cam[2] === this.cam.z;
  }

  // A test hook: hold chunk `key`'s next mesh reply back until the one after it has arrived.
  _reorderNext(key) {
    const c = this.byKey['h1:' + key];
    if (c) c.reorderNext = true;
  }

  decode(url) { return this._post({ type: 'decode', url }, false); }

  /* Mesh a loaded chunk off-scene. h1: detail {cam: [x, y, z], px} or {tau}; returns
   * {mesh, split, x0, z0, side}. h5, h20: detail is the stride. */
  meshChunk(levelName, key, detail) {
    const c = this.byKey[levelName + ':' + key];
    if (!c || !c.data) return Promise.reject(new Error('chunk not loaded: ' + levelName + ' ' + key));
    if (levelName === 'h1') {
      const opts = detail && detail.tau !== undefined ? { tau: detail.tau }
        : { px: detail.px, K: this.K, tmin: this.tin.tmin, cam: [detail.cam[0] - c.x0, detail.cam[1], detail.cam[2] - c.z0] };
      opts.borders = this.bordersFor(c);
      return this._post({ type: 'mesh', mode: 'tin', data: c.data, E: c.E, opts }, false)
        .then((res) => ({ mesh: res.mesh, split: res.split, x0: c.x0, z0: c.z0, side: c.level.side }));
    }
    const o = this.jobOptions(c, detail);
    return this._post({ type: 'mesh', data: c.data, mode: o.mode, opts: o.opts }, false)
      .then((res) => ({ mesh: res.mesh, x0: c.x0, z0: c.z0, side: c.level.side }));
  }

  // mode 'tin': opts {tau | px, K, tmin, cam, borders, keepDropped, errors}, returning {mesh,
  // split} and, with keepDropped, {dropped, corner} beside them; 'smooth' as meshSmooth.
  meshRaw(data, mode, opts) { return this._post({ type: 'mesh', data, mode, opts }, false); }

  dispose() {
    this.disposed = true;
    this._cancelDrain();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisibility);
    for (const w of this.workers) w.terminate();
    for (const c of this.chunks) {
      if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
      if (c.material) { c.material.dispose(); c.material = null; }
      if (c.tex) { c.tex.classTex.dispose(); c.tex.normalTex.dispose(); c.tex = null; }
    }
    this.pendingInstalls.length = 0;
    this.smoothMaterial.dispose();
    this.plot = null;
    disposeShared();
  }
}
