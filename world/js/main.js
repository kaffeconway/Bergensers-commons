/* Commons World viewer: the page's entry point.
 *
 * ?w=<folder inside world/> picks the world (default out/synthetic/). The manifest
 * says what exists; nothing outside that folder and world/vendor is ever requested.
 * window.__cw exposes state and hooks for the tests in world/tests/viewer/.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ChunkManager, PROFILES } from './chunks.js';
import { fetchJSON, fetchBytes, parseTrees, TreeSet, buildBuildings, FootprintIndex, PlotFence,
         plotRingsFlat, pointInRing, safeWorldPath } from './objects.js';
import { Controls, EYE } from './controls.js';
import { renderSpecs, renderCredits } from './panel.js';

const FORMAT = 'commons-world';
const VERSION = 1;
const WORLD_ROOT = new URL('../', import.meta.url);
const DEFAULT_SUN = { trueAzimuth: 235, elevation: 38 };   // a summer mid-afternoon, roughly, at 60 N

const $ = (id) => document.getElementById(id);
const cw = window.__cw = { ready: false, errors: [], version: VERSION };

class UserError extends Error {}

function recordError(err) {
  const msg = err && err.message ? err.message : String(err);
  cw.errors.push(msg);
  setStatus();
}
window.addEventListener('error', (ev) => recordError(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => recordError(ev.reason));

function showFatal(title, text) {
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  $('error').hidden = false;
  $('bar').hidden = true;
  $('credits').hidden = true;
}

// ------------------------------------------------------------------ status line
let loadedFiles = 0;
let manager = null;
// The status line counts chunks as they load; a screen reader hears only #announce, which
// says when loading is done or something went wrong, not every chunk.
function announce(text) {
  const a = $('announce');
  if (a.textContent !== text) a.textContent = text;
}
function setStatus(extra) {
  const el = $('status');
  el.classList.toggle('bad', cw.errors.length > 0);
  if (cw.errors.length) {
    el.textContent = cw.errors.length === 1 ? 'Problem: ' + cw.errors[0] : cw.errors.length + ' problems; the first: ' + cw.errors[0];
    announce(el.textContent);
    return;
  }
  if (extra !== undefined) { el.textContent = extra; return; }
  if (manager && !manager.done) {
    el.textContent = 'Loading terrain ' + manager.loadedCount + ' / ' + manager.total;
  } else {
    el.textContent = '';
    if (manager) announce('The world has loaded.');
  }
  const bar = $('progress');
  const f = manager ? manager.loadedCount / Math.max(1, manager.total) : 0;
  bar.firstElementChild.style.width = (100 * f).toFixed(1) + '%';
  bar.classList.toggle('done', !!manager && manager.done);
}

// ------------------------------------------------------------------ world folder
function worldBase() {
  const raw = new URLSearchParams(location.search).get('w') || 'out/synthetic/';
  let p = raw.trim();
  if (!p.endsWith('/')) p += '/';
  const parts = p.split('/').slice(0, -1);
  if (!/^[A-Za-z0-9._\/-]+$/.test(p) || p.startsWith('/') || parts.some((s) => s === '..' || s === '.' || s === '')) {
    throw new UserError('"' + raw + '" is not a folder inside world/. Use ?w=out/<id>/.');
  }
  return { href: new URL(p, WORLD_ROOT).href, rel: p };
}

function checkManifest(m, rel) {
  if (!m || typeof m !== 'object') throw new UserError('manifest.json in ' + rel + ' is not a JSON object.');
  if (m.format !== FORMAT) {
    throw new UserError('The folder ' + rel + ' holds "' + String(m.format) + '", not a Commons World (format "' + FORMAT + '").');
  }
  if (m.version !== VERSION) {
    throw new UserError('This world is format version ' + String(m.version) + ', and this viewer reads version ' + VERSION +
      ' only. Update the viewer, or rebuild the world with the matching pipeline.');
  }
  if (!m.crs || !isFinite(m.crs.origin_e) || !isFinite(m.crs.origin_n)) throw new UserError('manifest.json has no usable crs.');
  if (!Array.isArray(m.levels)) throw new UserError('manifest.json lists no height levels.');
}

// ------------------------------------------------------------------ sun
function sunFrom(facts, offset) {
  let az = DEFAULT_SUN.trueAzimuth, el = DEFAULT_SUN.elevation, source = 'default (no facts.json sun path)';
  const path = facts && facts.sun && facts.sun.sun_path && facts.sun.sun_path.jun21;
  if (Array.isArray(path)) {
    let best = null;
    for (const p of path) {
      if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1]) || p[1] < 12) continue;
      const d = Math.abs(((p[0] - DEFAULT_SUN.trueAzimuth + 540) % 360) - 180);
      if (!best || d < best.d) best = { d, az: p[0], el: p[1] };
    }
    if (best) { az = best.az; el = best.el; source = 'facts.json sun path, 21 June, mid-afternoon'; }
  }
  // FORMAT.md section 1: true bearing = grid bearing - offset, so grid = true + offset.
  const grid = az + offset;
  const b = THREE.MathUtils.degToRad(grid), e = THREE.MathUtils.degToRad(el);
  const dir = new THREE.Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
  return { trueAzimuth: az, elevation: el, gridBearing: grid, offset, source, dir: [dir.x, dir.y, dir.z], vec: dir };
}

// ------------------------------------------------------------------ start pose
function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz)));
  }
  return best;
}

/* Standing just outside the house, on the plot, facing it: try every 10 degrees
 * around the house, step out of the footprint, and prefer standing well inside the
 * parcel, a few metres back, on the side the sun lights. */
function startPose(house, parcels, footprints, sunVec) {
  if (!house) return { x: 0, z: 0, look: null };
  const [cx, cz] = house.centroid;
  const rings = (parcels || []).map((p) => p.ring).filter((r) => Array.isArray(r) && r.length >= 3);
  const inPlot = (x, z) => rings.length === 0 || rings.some((r) => pointInRing(r, x, z));
  const sx = sunVec.x, sz = sunVec.z, sl = Math.hypot(sx, sz) || 1;
  let best = null;
  for (let a = 0; a < 360; a += 10) {
    const r = THREE.MathUtils.degToRad(a), dx = Math.sin(r), dz = -Math.cos(r);
    let t = 0;
    while (t < 80 && pointInRing(house.ring, cx + dx * t, cz + dz * t)) t += 0.25;
    if (t >= 80) continue;
    for (const extra of [13, 11, 9, 7, 5, 3.5]) {
      const x = cx + dx * (t + extra), z = cz + dz * (t + extra);
      if (!inPlot(x, z) || footprints.roofAt(x, z) !== null) continue;
      const clear = rings.length ? Math.min(...rings.map((rg) => distanceToRing(rg, x, z))) : 5;
      const score = extra + 3 * ((dx * sx + dz * sz) / sl) + Math.min(4, clear);
      if (!best || score > best.score) best = { x, z, score };
      break;
    }
  }
  if (!best) best = { x: cx + 8, z: cz + 8 };
  return { x: best.x, z: best.z, look: [cx, house.ground + (house.roof - house.ground) * 0.45, cz] };
}

// ------------------------------------------------------------------ main
async function main() {
  const { href: base, rel } = worldBase();
  cw.world = rel;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const narrow = Math.min(innerWidth, innerHeight) < 600;
  const profile = coarse || narrow ? PROFILES.phone : PROFILES.laptop;
  const touchUi = coarse || (narrow && navigator.maxTouchPoints > 0);
  document.documentElement.classList.toggle('touch', touchUi);
  cw.profile = profile.name;
  cw.touch = touchUi;

  let manifest;
  try {
    manifest = await fetchJSON(new URL('manifest.json', base).href);
  } catch (err) {
    if (err.status === 404) {
      throw new UserError('There is no world at world/' + rel + ' (no manifest.json). Build one with ' +
        'python -m commons_world synthetic, or pick another with ?w=out/<id>/.');
    }
    throw new UserError('Could not read world/' + rel + 'manifest.json: ' + err.message);
  }
  checkManifest(manifest, rel);
  cw.manifest = manifest;
  const files = manifest.files || {};
  const fileUrl = (key) => (files[key] && files[key].file ? new URL(safeWorldPath(files[key].file), base).href : null);

  // credits first: they are never left out
  const creditsBody = $('credits-body');
  renderCredits(creditsBody, manifest, fileUrl('notice'));
  const credits = $('credits'), creditsToggle = $('credits-toggle');
  const setCredits = (open) => {
    credits.classList.toggle('collapsed', !open);
    creditsToggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('commons-world:credits', open ? 'open' : 'closed'); } catch (e) { /* storage refused: fine */ }
  };
  let stored = null;
  try { stored = localStorage.getItem('commons-world:credits'); } catch (e) { stored = null; }
  credits.classList.toggle('collapsed', stored === 'closed');
  creditsToggle.setAttribute('aria-expanded', String(stored !== 'closed'));
  let creditsChosen = stored !== null;
  creditsToggle.addEventListener('click', () => { creditsChosen = true; setCredits(credits.classList.contains('collapsed')); });
  // On a phone the credits start open and fold to the (i) button once the world is first
  // touched, the way compact map attributions behave; an explicit choice is kept instead.
  const foldCredits = () => {
    credits.classList.add('collapsed');
    creditsToggle.setAttribute('aria-expanded', 'false');
  };
  const foldCreditsOnce = () => {
    if (creditsChosen || !cw.touch) return;
    creditsChosen = true;
    foldCredits();
  };

  // ---------------------------------------------------------------- renderer and scene
  const canvas = $('view');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: profile.name !== 'phone', powerPreference: 'high-performance' });
  } catch (err) {
    throw new UserError('This browser could not start WebGL, which the world needs (' + err.message + ').');
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, profile.pixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.42;
  const scene = new THREE.Scene();
  const baseFov = profile.name === 'phone' ? 70 : 62;
  const camera = new THREE.PerspectiveCamera(baseFov, 1, 0.5, 14000);
  camera.rotation.order = 'YXZ';

  const offset = Number(manifest.crs.grid_north_offset_deg) || 0;
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.6;
  su.rayleigh.value = 1.3;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.8;
  if (su.cloudCoverage) { su.cloudCoverage.value = 0.28; su.cloudDensity.value = 0.35; }
  scene.add(sky);

  // Lit tops come out close to their palette colours; the ambient share keeps shaded
  // walls readable rather than black.
  const hemi = new THREE.HemisphereLight(0xe4edf1, 0x8a7f6a, 2.0);
  const fill = new THREE.AmbientLight(0xffffff, 0.5);
  const sunLight = new THREE.DirectionalLight(0xfff3df, 2.1);
  scene.add(hemi, fill, sunLight, sunLight.target);
  scene.fog = new THREE.Fog(0xc9d6dc, 2500, 9500);

  const waterMat = new THREE.MeshPhongMaterial({ color: 0x3d6878, specular: 0x2a3438, shininess: 70,
                                                 polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });
  waterMat.toneMapped = false;
  const water = new THREE.Mesh(new THREE.CircleGeometry(12000, 96).rotateX(-Math.PI / 2), waterMat);
  water.name = 'water';
  scene.add(water);

  function applySun(sun) {
    su.sunPosition.value.copy(sun.vec);
    sunLight.position.copy(sun.vec).multiplyScalar(1000);
    cw.sun = { trueAzimuth: sun.trueAzimuth, elevation: sun.elevation, gridBearing: sun.gridBearing,
               offset: sun.offset, source: sun.source, dir: sun.dir };
  }

  // The fog takes the colour the sky shows just above the horizon, read back from the canvas.
  function matchFogToSky() {
    const gl = renderer.getContext();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const hc = new THREE.PerspectiveCamera(30, size.x / Math.max(1, size.y), 1, 20000);
    hc.rotation.order = 'YXZ';
    hc.position.set(0, 100, 0);
    sky.position.copy(hc.position);
    const hidden = [];
    for (const o of scene.children) if (o !== sky && o.visible) { o.visible = false; hidden.push(o); }
    const px = new Uint8Array(4 * 8), acc = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < 8; k++) {
      hc.rotation.set(THREE.MathUtils.degToRad(1.5), k * Math.PI / 4, 0);
      hc.updateMatrixWorld();
      renderer.render(scene, hc);
      gl.readPixels(Math.floor(size.x / 2) - 4, Math.floor(size.y / 2), 8, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 8; i++) { acc[0] += px[i * 4]; acc[1] += px[i * 4 + 1]; acc[2] += px[i * 4 + 2]; n++; }
    }
    for (const o of hidden) o.visible = true;
    if (n && acc[0] + acc[1] + acc[2] > 0) {
      scene.fog.color.setRGB(acc[0] / n / 255, acc[1] / n / 255, acc[2] / n / 255, THREE.SRGBColorSpace);
      cw.fogColour = '#' + scene.fog.color.getHexString(THREE.SRGBColorSpace);
    }
  }

  // ---------------------------------------------------------------- side files
  loadedFiles = 0;
  const optional = (p) => p.catch((err) => { recordError(err); return null; });
  const [listing, plot, buildingsDoc, treesBytes, facts] = await Promise.all([
    fileUrl('listing') ? optional(fetchJSON(fileUrl('listing'))) : null,
    fileUrl('plot') ? optional(fetchJSON(fileUrl('plot'))) : null,
    fileUrl('buildings') ? optional(fetchJSON(fileUrl('buildings'))) : null,
    fileUrl('trees') ? optional(fetchBytes(fileUrl('trees'))) : null,
    fileUrl('facts') ? optional(fetchJSON(fileUrl('facts'))) : null
  ]);
  cw.hasFacts = !!facts;
  const T = (listing && listing.approved_text) || {};
  // Only approved text names the place on screen; the world's id is a property number.
  $('title').textContent = T.nickname || T.address || 'Commons World';

  const sun = sunFrom(facts, offset);
  applySun(sun);

  const features = (buildingsDoc && Array.isArray(buildingsDoc.features)) ? buildingsDoc.features : [];
  const buildings = buildBuildings(features);
  scene.add(buildings.group);
  const footprints = new FootprintIndex(features);

  const parcels = (plot && Array.isArray(plot.parcels)) ? plot.parcels : [];
  const fence = new PlotFence(scene, parcels);
  let fenceDirty = parcels.length > 0;
  const plotBox = (() => {
    let b = null;
    for (const p of parcels) for (const [x, z] of p.ring || []) {
      if (!b) b = [x, z, x, z];
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
    }
    return b;
  })();

  // ---------------------------------------------------------------- terrain
  const h1Level = manifest.levels.find((l) => l.name === 'h1');
  const chunkSide = h1Level ? h1Level.cell * h1Level.chunk_samples : 240;
  let frameRequested = false;
  manager = new ChunkManager({
    scene, manifest, worldBase: base, profile, plotRings: plotRingsFlat(parcels),
    onChange: (c, kind) => {
      if (c.level.name === 'h1' && plotBox && c.x0 <= plotBox[2] && c.x0 + c.level.side >= plotBox[0] &&
          c.z0 <= plotBox[3] && c.z0 + c.level.side >= plotBox[1]) fenceDirty = true;
      if (c.level.name === 'h1' && trees) trees.reground(c.key, (x, z) => manager.drawnTopAt(x, z));
      if (c.level.name === 'h1' && kind === 'load') {
        // walls down to the lowest ground drawable around each footprint this chunk touches
        const x0 = c.x0 - 4, z0 = c.z0 - 4, x1 = c.x0 + c.level.side + 4, z1 = c.z0 + c.level.side + 4;
        buildings.reground((a, b, e, f) => manager.lowestTop(a, b, e, f),
                           (bx) => bx[0] <= x1 && bx[2] >= x0 && bx[1] <= z1 && bx[3] >= z0);
      }
      setStatus();
      requestFrame();
    },
    onError: (err) => recordError(err)
  });
  cw.expected = {};
  for (const l of manifest.levels) cw.expected[l.name] = Object.keys(l.chunks || {}).length;

  let trees = null;
  if (treesBytes) {
    try {
      trees = new TreeSet(scene, parseTrees(treesBytes), [manifest.crs.origin_e, manifest.crs.origin_n], chunkSide, profile);
    } catch (err) { recordError(err); }
  }

  const groundAt = (x, z) => {
    const g = manager.groundAt(x, z);
    if (!g) return null;
    const roof = footprints.roofAt(x, z);
    return roof !== null && roof > g.y ? { y: roof, sea: false, level: 'building' } : g;
  };

  // ---------------------------------------------------------------- controls
  const btnMode = $('btn-mode'), vert = $('vert');
  let controls = null;
  canvas.addEventListener('pointerdown', () => foldCreditsOnce());
  controls = new Controls({
    camera, canvas, groundAt,
    onChange: () => { if (controls && (controls.moving || controls.stick.active)) foldCreditsOnce(); requestFrame(); },
    onModeChange: (mode) => {
      btnMode.setAttribute('aria-pressed', String(mode === 'fly'));
      vert.hidden = mode !== 'fly';
    },
    onTap: (pt, type) => pick(pt, type),
    onLockChange: (locked) => {
      document.documentElement.classList.toggle('locked', locked);
      $('crosshair').hidden = !locked;
      if (locked) $('hint').hidden = true;
    }
  });
  if (touchUi) {
    $('touch').hidden = false;
    $('help-keys').hidden = true;
    $('help-touch').hidden = false;
    controls.bindStick($('stick'), $('knob'));
    controls.bindHold($('btn-up'), 1);
    controls.bindHold($('btn-down'), -1);
  } else {
    $('hint').hidden = false;
  }

  const pose = startPose(buildings.house, parcels, footprints, sun.vec);
  function goToStart() {
    controls.setMode('walk');
    const g = groundAt(pose.x, pose.z);
    const y = g ? g.y : (buildings.house ? buildings.house.ground : 0);
    controls.place(pose.x, y, pose.z);
    if (pose.look) controls.lookAt(pose.look[0], pose.look[1], pose.look[2]);
    else controls.setLook(0, -0.1);
  }
  goToStart();

  // ---------------------------------------------------------------- picking and panels
  const specs = $('specs'), btnSpecs = $('btn-specs'), help = $('help'), btnHelp = $('btn-help');
  renderSpecs($('specs-body'), { listing, plot, facts, manifest });
  function openPanel(panel, button, focusEl) {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
  function closePanel(panel, button) {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (hadFocus) button.focus({ preventScroll: true });
  }
  // The specs panel never covers the credits: on a wide screen it stops above them; as a
  // sheet on a phone it folds them to their (i) button, which stays on top.
  function fitSpecs() {
    if (specs.hidden) return;
    specs.style.maxHeight = '';
    const sheet = getComputedStyle(specs).bottom === '0px';
    if (sheet) { if (!creditsChosen) foldCredits(); return; }
    const top = specs.getBoundingClientRect().top, c = credits.getBoundingClientRect();
    const panel = specs.getBoundingClientRect();
    if (c.left < panel.right && c.right > panel.left) specs.style.maxHeight = Math.max(160, c.top - top - 10) + 'px';
  }
  window.addEventListener('resize', fitSpecs);
  creditsToggle.addEventListener('click', () => requestAnimationFrame(fitSpecs));
  const openSpecs = () => {
    closePanel(help, btnHelp);
    openPanel(specs, btnSpecs, $('specs-title'));
    fitSpecs();
    cw.specsOpenedBy = cw.specsOpenedBy || 'button';
  };
  const refocusCanvas = (ev) => { if (ev && ev.detail > 0) canvas.focus({ preventScroll: true }); };
  btnSpecs.addEventListener('click', () => (specs.hidden ? openSpecs() : closePanel(specs, btnSpecs)));
  $('specs-close').addEventListener('click', () => closePanel(specs, btnSpecs));
  btnHelp.addEventListener('click', () => {
    if (help.hidden) { closePanel(specs, btnSpecs); openPanel(help, btnHelp, $('help-title')); }
    else closePanel(help, btnHelp);
  });
  $('help-title').tabIndex = -1;
  $('help-close').addEventListener('click', () => closePanel(help, btnHelp));
  btnMode.addEventListener('click', (ev) => { controls.toggleMode(); refocusCanvas(ev); });
  $('house-label').addEventListener('click', () => { cw.specsOpenedBy = 'label'; openSpecs(); });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!specs.hidden) closePanel(specs, btnSpecs);
      if (!help.hidden) closePanel(help, btnHelp);
    }
  });

  const raycaster = new THREE.Raycaster();
  const pickables = [buildings.othersMesh, buildings.houseMesh];
  // The terrain is not raycast (it is hundreds of large meshes), so a building behind a hill
  // is still hit. Walk the ray from the eye to the hit instead and drop the hit if the drawn
  // ground rises above the ray anywhere on the way: 0.5 m steps, growing by 1% of the
  // distance, against the same heights the chunks are drawn with.
  const rayPoint = new THREE.Vector3();
  function hiddenByGround(ray, distance) {
    for (let t = camera.near; t < distance - 0.05; t += 0.5 + 0.01 * t) {
      ray.at(t, rayPoint);
      const y = manager.surfaceAt(rayPoint.x, rayPoint.z);
      if (y !== null && y > rayPoint.y + 0.01) return true;
    }
    return false;
  }
  function pick(pt, type) {
    const ndc = new THREE.Vector2(0, 0);
    if (pt) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((pt.x - r.left) / r.width) * 2 - 1, -((pt.y - r.top) / r.height) * 2 + 1);
    }
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    const hidden = hits.length > 0 && hiddenByGround(raycaster.ray, hits[0].distance);
    cw.lastPick = hits.length ? hits[0].object.name + (hidden ? ':hidden' : '') : null;
    if (hits.length && !hidden && hits[0].object === buildings.houseMesh) {
      cw.specsOpenedBy = 'pick';
      if (controls.lock.isLocked) document.exitPointerLock();
      openSpecs();
      return;
    }
    if (type === 'mouse' && !touchUi && !controls.lock.isLocked) controls.requestLock();
  }

  // ---------------------------------------------------------------- house label
  const label = $('house-label');
  const labelAnchor = buildings.house
    ? new THREE.Vector3(buildings.house.centroid[0], buildings.house.roof + 2.2, buildings.house.centroid[1]) : null;
  const v3 = new THREE.Vector3();
  function placeLabel() {
    if (!labelAnchor) { label.hidden = true; return; }
    v3.copy(labelAnchor).project(camera);
    const dist = camera.position.distanceTo(labelAnchor);
    if (v3.z > 1 || v3.z < -1 || Math.abs(v3.x) > 1.05 || Math.abs(v3.y) > 1.05 || dist > 1800) { label.hidden = true; return; }
    const r = canvas.getBoundingClientRect();
    const x = r.left + (v3.x + 1) / 2 * r.width, y = r.top + (1 - v3.y) / 2 * r.height;
    label.hidden = false;
    label.style.transform = 'translate(' + Math.round(x - label.offsetWidth / 2) + 'px,' + Math.round(y - label.offsetHeight) + 'px)';
  }

  // ---------------------------------------------------------------- render loop
  let raf = 0, last = 0, frames = 0, lastLod = 0, lodMoved = true, wasMoving = false;
  const waiters = [];
  function requestFrame() {
    if (raf || document.hidden) return;
    frameRequested = true;
    raf = requestAnimationFrame(frame);
  }
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    // keep about 55 degrees across in portrait, where a fixed vertical angle gets very narrow
    const across = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(27.5)) / camera.aspect);
    camera.fov = Math.min(90, Math.max(baseFov, THREE.MathUtils.radToDeg(across)));
    camera.updateProjectionMatrix();
    requestFrame();
  }
  function frame(now) {
    raf = 0;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const moving = controls.update(dt);
    if (moving) lodMoved = true;
    sky.position.copy(camera.position);
    water.position.set(camera.position.x, 0, camera.position.z);
    if (lodMoved && (now - lastLod > 250 || (wasMoving && !moving))) {
      lastLod = now;
      lodMoved = false;
      manager.update(camera.position);
      if (trees) trees.update(camera.position);
    }
    wasMoving = moving;
    if (fenceDirty) {
      fenceDirty = false;
      fence.rebuild((x, z) => manager.drawnTopAt(x, z));
    }
    renderer.render(scene, camera);
    frames++;
    placeLabel();
    checkReady();
    while (waiters.length) waiters.shift()();
    if (moving) requestFrame();
    else last = 0;
  }
  function checkReady() {
    if (cw.ready || !manager.done) return;
    cw.ready = true;
    cw.readyAt = performance.now();
    setStatus();
  }

  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
    else requestFrame();
  });
  window.addEventListener('pagehide', () => {
    manager.dispose();
    if (trees) trees.dispose();
    renderer.dispose();
  });

  // ---------------------------------------------------------------- test and debug hooks
  Object.assign(cw, {
    stats() {
      return {
        chunks: manager.counts(), expected: cw.expected, failed: manager.failed, pendingJobs: manager.queue.length + manager.inflight,
        triangles: renderer.info.render.triangles, drawCalls: renderer.info.render.calls,
        terrainTriangles: manager.triangles(), lods: manager.lodSummary(),
        trees: trees ? trees.count : 0, buildings: buildings.count,
        geometries: renderer.info.memory.geometries, pixelRatio: renderer.getPixelRatio(),
        profile: profile.name, frames, workers: manager.workers.length
      };
    },
    visible() {
      // triangles inside the view frustum, by kind (what the GPU is asked to draw, before occlusion)
      camera.updateMatrixWorld();
      const fr = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const out = { h1: 0, h5: 0, h20: 0, trees: 0, buildings: 0, objects: 0 };
      scene.traverse((o) => {
        if (!o.isMesh || !o.visible || !o.geometry) return;
        const g = o.geometry;
        if (!g.boundingSphere) g.computeBoundingSphere();
        const sphere = (o.isInstancedMesh && o.boundingSphere ? o.boundingSphere : g.boundingSphere).clone().applyMatrix4(o.matrixWorld);
        if (o.frustumCulled && !fr.intersectsSphere(sphere)) return;
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
        const kind = o.name.split(':')[0];
        out.objects++;
        if (kind in out) out[kind] += tris;
        else if (kind === 'house' || kind === 'buildings') out.buildings += tris;
      });
      return out;
    },
    houseScreenPoint() {
      if (!buildings.house) return null;
      const h = buildings.house;
      camera.updateMatrixWorld();
      const p = new THREE.Vector3(h.centroid[0], h.ground + (h.roof - h.ground) * 0.45, h.centroid[1]).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height,
               visible: p.z > -1 && p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 };
    },
    plotTintCells() {
      let area = 0;
      for (const p of parcels) if (isFinite(p.area_polygon_m2)) area += p.area_polygon_m2;
      return { byCell: manager.plotTint(), polygonArea: area };
    },
    camera: {
      get() {
        return { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: controls.yaw, pitch: controls.pitch,
                 mode: controls.mode, feet: controls.feet.y };
      },
      set(o) {
        if (o.mode) controls.setMode(o.mode);
        const f = controls.feet;
        controls.place(o.x !== undefined ? o.x : f.x, o.y !== undefined ? o.y - EYE : f.y, o.z !== undefined ? o.z : f.z);
        if (o.lookAt) controls.lookAt(o.lookAt[0], o.lookAt[1], o.lookAt[2]);
        else if (o.yaw !== undefined || o.pitch !== undefined) controls.setLook(o.yaw !== undefined ? o.yaw : controls.yaw, o.pitch !== undefined ? o.pitch : controls.pitch);
        lodMoved = true;
        lastLod = 0;
        requestFrame();
      },
      start() { goToStart(); lodMoved = true; lastLod = 0; requestFrame(); },
      pose() { return pose; }
    },
    frame() { return new Promise((resolve) => { waiters.push(resolve); requestFrame(); }); },
    async settle(maxMs = 60000) {
      // re-mesh to the current camera and wait until no job is left
      const t0 = performance.now();
      manager.update(camera.position);
      if (trees) trees.update(camera.position);
      while (manager.queue.length + manager.inflight > 0 && performance.now() - t0 < maxMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      fenceDirty = true;
      await cw.frame();
      return manager.queue.length + manager.inflight === 0;
    },
    groundAt: (x, z) => groundAt(x, z),
    decode: (url) => manager.decode(new URL(url, base).href),
    meshChunk: (level, key, detail) => manager.meshChunk(level, key, detail),
    meshRaw: (data, mode, opts) => manager.meshRaw(data, mode, opts),
    blockTrianglesWith: (extra) => manager.blockTrianglesWith(extra),
    loadOrder: () => manager.dispatchLog.slice(),
    openSpecs, house: buildings.house ? { centroid: buildings.house.centroid, ground: buildings.house.ground, roof: buildings.house.roof } : null,
    // the live objects, for integration checks that need drawn heights and meshes
    internals: { scene, renderer, camera, manager, trees, fence, buildings, footprints, controls, water, sky, parcels }
  });

  resize();
  requestAnimationFrame(() => {
    matchFogToSky();
    manager.start(camera.position);
    setStatus();
    requestFrame();
  });
}

main().catch((err) => {
  if (err instanceof UserError) showFatal('This world cannot be shown', err.message);
  else { showFatal('Something went wrong', err && err.message ? err.message : String(err)); }
  recordError(err);
});
