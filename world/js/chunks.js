/* Commons World: height chunks on the page side.
 *
 * Keeps every chunk the manifest lists, loads them nearest-first through a pool of
 * workers (worker.js), picks each chunk's drawing detail from the camera distance
 * (with hysteresis) and re-meshes when that changes. It also answers ground-height
 * questions straight from the decoded heights, which is what walking uses.
 */
import * as THREE from 'three';

// Drawing detail by camera distance, in metres (PLAN.md section 4).
export const PROFILES = {
  phone: {
    name: 'phone',
    // steps: the height step (m) for each block size. The task fixes 1 m; 4 m steps for 4 m
    // blocks would roughly halve the block triangles here (see world/README.md).
    blocks: { sizes: [1, 2, 4], at: [150, 400], steps: [1, 1, 1] },
    h5: { strides: [1, 2, 4, 8], at: [450, 1000, 2000] },
    h20: { strides: [1, 2, 4], at: [3000, 5500] },
    treesNear: 200,
    pixelRatio: 1.5
  },
  laptop: {
    name: 'laptop',
    blocks: { sizes: [1, 2, 4], at: [400, 800], steps: [1, 1, 1] },
    h5: { strides: [1, 2, 4, 8], at: [700, 1500, 3000] },
    h20: { strides: [1, 2, 4], at: [4000, 7000] },
    treesNear: 450,
    pixelRatio: 2
  }
};
const HYSTERESIS = 40;          // metres beyond a threshold before going coarser
const JOBS_PER_WORKER = 2;      // a fetch in flight while another chunk meshes

function parseKey(key) {
  const m = /^(-?\d+)_(-?\d+)$/.exec(key);
  if (!m) throw new Error('bad chunk key ' + JSON.stringify(key));
  return [Number(m[1]), Number(m[2])];
}

const SEA_FLOOR = -2;           // metres; worker.js uses the same for sea cells

/* The lowest top a chunk can draw along one of its own edges, at any block size up to
 * `group`: for each metre along the edge (0 N and 2 S run west to east, 1 E and 3 W
 * north to south), the minimum 1 m top over the group-by-group block that touches it.
 * A coarse block's top is the rounded mean of its land samples, so it is never below that
 * minimum; sea counts as the sea floor. data is a decoded chunk with its apron. */
export function edgeFloor(data, side, group) {
  const h = data.header, W = h.width, K = W - 2, base = h.base, v = data.v, cls = data.classes;
  const out = new Int16Array(K);
  const top = (r, q) => {
    const t = r * W + q, dm = base + v[t], c = cls ? cls[t] : 0;
    return c === 5 || (dm <= 0 && c !== 4) ? SEA_FLOOR : Math.floor((dm + 5) / 10);
  };
  for (let g0 = 0; g0 < K; g0 += group) {
    let low = Infinity;
    const span = Math.min(group, K - g0);
    for (let a = 0; a < span; a++) {           // along the edge
      for (let d = 0; d < Math.min(group, K); d++) {   // inward from it
        const k = 1 + g0 + a;
        const t = side === 0 ? top(1 + d, k) : side === 2 ? top(K - d, k)
          : side === 1 ? top(k, K - d) : top(k, 1 + d);
        if (t < low) low = t;
      }
    }
    for (let a = 0; a < span; a++) out[g0 + a] = low;
  }
  return out;
}

function safeRelative(path) {
  // A manifest path must stay inside the world folder.
  if (typeof path !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(path) || path.startsWith('/') ||
      path.split('/').some((p) => p === '..' || p === '')) {
    throw new Error('unsafe path in manifest: ' + JSON.stringify(path));
  }
  return path;
}

export class ChunkManager {
  constructor({ scene, manifest, worldBase, profile, plotRings, onChange, onError, useCache = true }) {
    this.scene = scene;
    this.manifest = manifest;
    this.worldBase = worldBase;
    this.profile = profile;
    this.onChange = onChange || (() => {});
    this.onError = onError || (() => {});
    this.useCache = useCache;
    this.oe = manifest.crs.origin_e;
    this.on = manifest.crs.origin_n;
    this.levels = {};
    this.chunks = [];
    this.byKey = {};
    this.queue = [];
    this.inflight = 0;
    this.seq = 0;
    this.pending = new Map();
    this.dispatchLog = [];
    this.loadedCount = 0;
    this.failed = 0;
    this.seamRemeshes = 0;
    this.cam = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);
    this.blockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.smoothMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.blockMaterial.toneMapped = false;
    this.smoothMaterial.toneMapped = false;

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
          status: 'queued', data: null, mesh: null, lod: 0, busy: false, dirty: false
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
      w.postMessage({ type: 'init', id: 0, originE: this.oe, originN: this.on, rings: plotRings || [] });
      this.workers.push(w);
    }
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

  detailFor(c, cam, current) {
    const rule = c.level.name === 'h1' ? this.profile.blocks : this.profile[c.level.name];
    const values = c.level.name === 'h1' ? rule.sizes : rule.strides;
    const d = this.distance(c, cam);
    const fine = rule.at.filter((t) => d >= t).length;
    const lag = rule.at.filter((t) => d >= t + HYSTERESIS).length;
    const cur = values.indexOf(current);
    let idx;
    if (cur < 0) idx = fine;
    else if (fine < cur) idx = fine;
    else if (lag > cur) idx = lag;
    else idx = cur;
    // A smooth chunk must not use a stride coarser than its holes allow.
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

  // ------------------------------------------------------------ worker jobs
  _post(msg, transfer) {
    let best = this.workers[0];
    for (const w of this.workers) if (w.jobs < best.jobs) best = w;
    const id = ++this.seq;
    msg.id = id;
    best.jobs++;
    this.inflight++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: best });
      best.postMessage(msg, transfer || []);
    });
  }

  _reply(data) {
    const p = this.pending.get(data.id);
    if (!p) return;              // the init acknowledgement
    this.pending.delete(data.id);
    p.worker.jobs--;
    this.inflight--;
    if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
  }

  jobOptions(c, detail) {
    const lv = c.level;
    if (lv.name === 'h1') {
      const present = (di, dj) => {
        const k = (c.i + di) + '_' + (c.j + dj);
        return lv.present.has(k) || lv.sea.has(k);
      };
      // What each land neighbour can draw along the shared edge, when it is loaded: the
      // border walls reach below it at any block size (see edgeFloor). A neighbour that is
      // not loaded yet is settled later by checkSeams().
      const floors = [], floorsUsed = [];
      for (let s = 0; s < 4; s++) {
        const nb = this.neighbour(c, s);
        floors.push(nb && nb.data ? this.floorOf(nb, (s + 2) % 4) : null);
        floorsUsed.push(!nb || !!nb.data);
      }
      return {
        mode: 'blocks',
        floorsUsed,
        opts: {
          lod: detail, x0: c.x0, z0: c.z0, tint: true, step: this.stepFor(detail),
          edgeAbsent: [!present(0, 1), !present(1, 0), !present(0, -1), !present(-1, 0)],
          floors
        }
      };
    }
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

  stepFor(size) {
    const b = this.profile.blocks, k = b.sizes.indexOf(size);
    return b.steps && k >= 0 ? b.steps[k] : 1;
  }

  // ------------------------------------------------------------ h1 seams
  // side: 0 N, 1 E, 2 S, 3 W (as in worker.js). The land h1 chunk across that edge, or null.
  neighbour(c, side) {
    const di = side === 1 ? 1 : side === 3 ? -1 : 0, dj = side === 0 ? 1 : side === 2 ? -1 : 0;
    return this.byKey[c.level.name + ':' + (c.i + di) + '_' + (c.j + dj)] || null;
  }

  // edgeFloor() of a loaded chunk's own edge, at the profile's largest block size; cached,
  // since the data never changes once loaded.
  floorOf(c, side) {
    if (!c.floors) c.floors = [null, null, null, null];
    if (!c.floors[side]) c.floors[side] = edgeFloor(c.data, side, Math.max(...this.profile.blocks.sizes));
    return c.floors[side];
  }

  /* A chunk meshed before a neighbour loaded estimated that neighbour from its one-sample
   * apron, which cannot see a drop inside the neighbour's coarse blocks. Once the neighbour
   * is loaded, compare what it can draw with how far down this chunk's border walls reach,
   * and re-mesh only where a gap could show. */
  checkSeams(c) {
    if (c.level.name !== 'h1' || c.status !== 'ready' || c.busy || c.queuedMesh || !c.edgeBottom || !c.floorsUsed) return;
    for (let s = 0; s < 4; s++) {
      if (c.floorsUsed[s]) continue;
      const nb = this.neighbour(c, s);
      if (!nb) { c.floorsUsed[s] = true; continue; }
      if (!nb.data) continue;
      const f = this.floorOf(nb, (s + 2) % 4), b = c.edgeBottom[s];
      let gap = false;
      for (let k = 0; k < f.length; k++) if (f[k] < b[k]) { gap = true; break; }
      if (!gap) { c.floorsUsed[s] = true; continue; }
      c.queuedMesh = true;
      this.seamRemeshes++;
      this.queue.push({ c, kind: 'remesh' });
      return;
    }
  }

  // Sides whose loaded neighbour could still draw below this chunk's border walls (tests).
  seamDebts() {
    const out = [];
    for (const c of this.chunks) {
      if (c.level.name !== 'h1' || !c.edgeBottom) continue;
      for (let s = 0; s < 4; s++) {
        const nb = this.neighbour(c, s);
        if (!nb || !nb.data) continue;
        const f = this.floorOf(nb, (s + 2) % 4), b = c.edgeBottom[s];
        for (let k = 0; k < f.length; k++) if (f[k] < b[k]) { out.push({ key: c.key, side: s, at: k, floor: f[k], wall: b[k] }); break; }
      }
    }
    return out;
  }

  start(cam) {
    this.cam.copy(cam);
    for (const c of this.chunks) this.queue.push({ c, kind: 'load' });
    this.pump();
  }

  update(cam) {
    this.cam.copy(cam);
    for (const c of this.chunks) {
      if (c.status !== 'ready' || c.busy) continue;
      const want = this.detailFor(c, cam, c.lod);
      if (want !== c.lod && !c.queuedMesh) {
        c.queuedMesh = true;
        this.queue.push({ c, kind: 'mesh' });
      }
    }
    this.pump();
  }

  pump() {
    const cap = this.workers.length * JOBS_PER_WORKER;
    while (this.inflight < cap && this.queue.length) {
      // nearest first, measured from where the camera is now; finer levels win ties
      let bi = 0, bd = Infinity;
      for (let k = 0; k < this.queue.length; k++) {
        const job = this.queue[k];
        const bias = job.c.level.name === 'h1' ? 0 : job.c.level.name === 'h5' ? 60 : 180;
        const d = this.distance(job.c, this.cam) + bias + (job.kind === 'mesh' ? 30 : 0);
        if (d < bd) { bd = d; bi = k; }
      }
      const job = this.queue.splice(bi, 1)[0];
      this._run(job);
    }
  }

  async _run(job) {
    const c = job.c;
    const detail = this.detailFor(c, this.cam, job.kind === 'load' ? 0 : c.lod);
    if (job.kind === 'mesh' && detail === c.lod) {   // the camera came back before it ran
      c.queuedMesh = false;
      return;
    }
    c.busy = true;
    const o = this.jobOptions(c, detail);
    this.dispatchLog.push({ key: c.key, level: c.level.name, kind: job.kind, detail });
    let ok = false;
    try {
      let res;
      if (job.kind === 'load') {
        c.status = 'loading';
        res = await this._post({ type: 'load', url: c.url, useCache: this.useCache,
                                 expect: this.expectedHeader(c), mode: o.mode, opts: o.opts });
        c.data = { header: res.header, v: res.v, classes: res.classes };
      } else {
        c.queuedMesh = false;
        res = await this._post({ type: 'mesh', data: c.data, mode: o.mode, opts: o.opts });
      }
      this._install(c, res.mesh, detail);
      c.floorsUsed = o.floorsUsed || null;
      c.edgeBottom = res.mesh.edgeBottom || null;
      if (job.kind === 'load') {
        c.status = 'ready';
        c.level.count++;
        this.loadedCount++;
      }
      ok = true;
      this.onChange(c, job.kind);
    } catch (err) {
      if (job.kind === 'load') { c.status = 'error'; this.failed++; }
      this.onError(new Error(c.level.name + ' ' + c.key + ': ' + err.message));
    } finally {
      c.busy = false;
      if (ok && c.level.name === 'h1') {
        // this chunk against its loaded neighbours, and they against it
        this.checkSeams(c);
        for (let s = 0; s < 4; s++) { const nb = this.neighbour(c, s); if (nb) this.checkSeams(nb); }
      }
      this.pump();
    }
  }

  _install(c, m, detail) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    const s = c.level.side, y0 = m.yMin, y1 = m.yMax;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, y0, 0), new THREE.Vector3(s, y1, s));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const old = c.mesh;
    const mesh = new THREE.Mesh(g, c.level.name === 'h1' ? this.blockMaterial : this.smoothMaterial);
    mesh.name = c.level.name + ':' + c.key;
    mesh.position.set(c.x0, 0, c.z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.triangles = m.triangles;
    mesh.userData.tint = m.tint || null;
    mesh.visible = m.triangles > 0;
    this.group.add(mesh);
    if (old) { this.group.remove(old); old.geometry.dispose(); }
    c.mesh = mesh;
    c.lod = detail;
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

  lodSummary() {
    const out = {};
    for (const c of this.chunks) {
      if (!c.mesh) continue;
      const k = c.level.name + '@' + c.lod;
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  plotTint() {
    const by = {};
    for (const c of this.chunks) {
      const t = c.mesh && c.mesh.userData.tint;
      if (!t || !t.cells) continue;
      const k = String(t.cell);
      if (!by[k]) by[k] = { cell: t.cell, cells: 0, strong: 0, area: 0 };
      by[k].cells += t.cells;
      by[k].strong += t.strong;
      by[k].area += t.cells * t.cell * t.cell;
    }
    return by;
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

  /* Height of the top the walker stands on at local (x, z), or null when the data is
   * not loaded yet. Inside h1: the 1 m block top (round half up), sea at 0. Beyond: the
   * h5, then h20, surface exactly as drawn (see _smoothAt). Never a raycast. */
  groundAt(x, z) {
    const h1 = this.chunkAt('h1', x, z);
    if (h1 && h1.data) {
      const e = x + this.oe, n = this.on - z, S = h1.level.side;
      const q = Math.floor(e - h1.i * S) + 1;
      const r = Math.ceil((h1.j + 1) * S - n);
      const W = h1.data.header.width, t = r * W + q;
      const dm = h1.data.header.base + h1.data.v[t];
      const cls = h1.data.classes ? h1.data.classes[t] : 0;
      if (cls === 5 || (dm <= 0 && cls !== 4)) return { y: 0, sea: true, level: 'h1' };
      return { y: Math.floor((dm + 5) / 10), sea: false, level: 'h1' };
    }
    if (this.isSeaSquare('h1', x, z)) return { y: 0, sea: true, level: 'h1' };
    for (const name of ['h5', 'h20']) {
      const c = this.chunkAt(name, x, z);
      if (c && c.data) return this._smoothAt(c, x, z);
      if (this.isSeaSquare(name, x, z)) return { y: 0, sea: true, level: name };
    }
    return null;
  }

  /* The smooth surface as worker.js meshSmooth draws it at the chunk's current stride:
   * triangles (nw, sw, se) and (nw, se, ne) over cell corners, each corner the mean of the
   * four samples around it, pushed to -3 m when two or more of them are sea. Flying is held
   * above this, so the eye never dips under the ground that is shown (a bilinear read of
   * the sample centres sat up to a few metres below it on convex slopes). */
  _smoothAt(c, x, z) {
    const h = c.data.header, W = h.width, K = W - 2, base = h.base, v = c.data.v, cls = c.data.classes;
    const s = c.mesh && c.lod > 0 ? c.lod : 1, step = s * h.cell, nq = K / s;
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

  /* The lowest ground any block size can draw over the box (local metres): the box is
   * widened to whole blocks of the largest size, a coarse block's top is never below the
   * lowest 1 m land top in it, and sea shows the water at 0. null while an h1 chunk the
   * box needs is not loaded, or where the box leaves h1. */
  lowestTop(xa, za, xb, zb) {
    const lv = this.levels.h1;
    if (!lv) return null;
    const G = Math.max(...this.profile.blocks.sizes), S = lv.side;
    const e0 = Math.floor((xa + this.oe) / G) * G, e1 = Math.ceil((xb + this.oe) / G) * G;
    const n0 = Math.floor((this.on - zb) / G) * G, n1 = Math.ceil((this.on - za) / G) * G;
    let low = Infinity;
    for (let n = n0; n < n1; n++) {
      const j = Math.floor(n / S);
      for (let e = e0; e < e1; e++) {
        const i = Math.floor(e / S);
        const c = this.byKey['h1:' + i + '_' + j];
        if (!c) {
          if (lv.sea.has(i + '_' + j)) { if (low > 0) low = 0; continue; }
          return null;
        }
        if (!c.data) return null;
        // the sample whose cell is [e, e+1) x [n, n+1)
        const W = c.data.header.width, t = ((j + 1) * S - n) * W + (e - i * S + 1);
        const dm = c.data.header.base + c.data.v[t], cls = c.data.classes ? c.data.classes[t] : 0;
        const top = cls === 5 || (dm <= 0 && cls !== 4) ? 0 : Math.floor((dm + 5) / 10);
        if (top < low) low = top;
      }
    }
    return low === Infinity ? null : low;
  }

  /* The drawn block top at (x, z) for the chunk's current block size; mirrors worker.js
   * so the plot fence sits on what is drawn. */
  drawnTopAt(x, z) {
    const c = this.chunkAt('h1', x, z);
    if (!c || !c.data) return null;
    const L = c.lod || 1, W = c.data.header.width, base = c.data.header.base;
    const lx = x - c.x0, lz = z - c.z0;
    const A = Math.min(c.level.samples / L - 1, Math.max(0, Math.floor(lz / L)));
    const B = Math.min(c.level.samples / L - 1, Math.max(0, Math.floor(lx / L)));
    let sea = 0, sum = 0, land = 0;
    for (let a = 0; a < L; a++) {
      for (let b = 0; b < L; b++) {
        const t = (1 + A * L + a) * W + 1 + B * L + b;
        const dm = base + c.data.v[t], cls = c.data.classes ? c.data.classes[t] : 0;
        if (cls === 5 || (dm <= 0 && cls !== 4)) sea++;
        else { sum += dm; land++; }
      }
    }
    if (sea * 2 > L * L || land === 0) return 0;
    const step = this.stepFor(L);
    return step * Math.floor((sum + 5 * step * land) / (10 * step * land));
  }

  /* The height of whatever ground is drawn at (x, z): the block top at the chunk's current
   * size within h1 (sea and its water plane at 0), else the smooth surface as drawn. null
   * where nothing is known. Used to tell whether the ground hides something (picking). */
  surfaceAt(x, z) {
    const top = this.drawnTopAt(x, z);
    if (top !== null) return top;
    const g = this.groundAt(x, z);
    return g ? g.y : null;
  }

  // ------------------------------------------------------------ test hooks
  decode(url) { return this._post({ type: 'decode', url }); }

  meshChunk(levelName, key, detail) {
    const c = this.byKey[levelName + ':' + key];
    if (!c || !c.data) return Promise.reject(new Error('chunk not loaded: ' + levelName + ' ' + key));
    const o = this.jobOptions(c, detail);
    return this._post({ type: 'mesh', data: c.data, mode: o.mode, opts: o.opts })
      .then((res) => ({ mesh: res.mesh, x0: c.x0, z0: c.z0, side: c.level.side }));
  }

  meshRaw(data, mode, opts) { return this._post({ type: 'mesh', data, mode, opts }); }

  // Mesh every loaded h1 chunk at its current block size with extra options; triangle total.
  async blockTrianglesWith(extra) {
    let total = 0;
    for (const c of this.chunks) {
      if (c.level.name !== 'h1' || !c.data) continue;
      const o = this.jobOptions(c, c.lod);
      const res = await this._post({ type: 'mesh', data: c.data, mode: o.mode, opts: Object.assign(o.opts, (extra.byLod ? extra.byLod[c.lod] : extra) || {}) });
      total += res.mesh.triangles;
    }
    return total;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const c of this.chunks) if (c.mesh) c.mesh.geometry.dispose();
    this.blockMaterial.dispose();
    this.smoothMaterial.dispose();
  }
}
