/* Commons World viewer: the page's entry point.
 *
 * ?w=<folder inside world/> picks the world (default out/synthetic/). The manifest
 * says what exists; nothing outside that folder and world/vendor is ever requested.
 * window.__cw exposes state and hooks for the tests in world/tests/viewer/.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { ChunkManager, PROFILES } from './chunks.js';
import { fetchJSON, fetchBytes, parseTrees, TreeSet, buildBuildings, buildingFeatures, FootprintIndex, PlotFence,
         plotRingsFlat, pointInRing, safeWorldPath } from './objects.js';
import { Controls, EYE } from './controls.js';
import { renderSpecs, renderCredits } from './panel.js';
import { createSun } from './sunshade.js';
import { createSunUi } from './sunui.js';
import { mapIntoYear, parseSiteTime } from './sun.js';

const FORMAT = 'commons-world';
const VERSION = 1;
const WORLD_ROOT = new URL('../', import.meta.url);

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
let placeDock = () => {};         // set once the page is built: keeps #dock clear of the corners
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
    placeDock();
    return;
  }
  if (extra !== undefined) { el.textContent = extra; placeDock(); return; }
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
  placeDock();
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

  const sky = new Sky();
  sky.scale.setScalar(10000);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.6;
  su.rayleigh.value = 1.3;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.8;
  if (su.cloudCoverage) { su.cloudCoverage.value = 0.28; su.cloudDensity.value = 0.35; }
  scene.add(sky);

  // The sun, sky and ambient fill follow the sun's elevation (sunshade.js lightAt); the
  // ambient share keeps shaded walls readable rather than black.
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
  water.receiveShadow = true;       // the fjord darkens in hill shade, and the glint goes with it
  scene.add(water);

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

  const features = buildingFeatures(buildingsDoc, recordError);
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
  let raf = 0, last = 0, frames = 0, lastLod = 0, lodMoved = true, wasMoving = false;
  const waiters = [];
  let sun = null;
  // a chunk's square against a caster rect; no rect (no near map drawn) never meets
  const meets = (c, r) => !!r && c.x0 <= r.x1 && c.x0 + c.level.side >= r.x0 && c.z0 <= r.z1 && c.z0 + c.level.side >= r.z0;
  manager = new ChunkManager({
    scene, manifest, worldBase: base, profile, plotRings: plotRingsFlat(parcels),
    onChange: (c, kind) => {
      if (c.level.name === 'h1') {
        if (plotBox && c.x0 <= plotBox[2] && c.x0 + c.level.side >= plotBox[0] &&
            c.z0 <= plotBox[3] && c.z0 + c.level.side >= plotBox[1]) fenceDirty = true;
        if (trees && trees.reground(c.key, (x, z) => manager.surfaceAt(x, z)) > 0 &&
            sun && meets(c, sun.casterRects().trees)) sun.markShadowsDirty();
        if (kind === 'load') {
          // walls down to the lowest ground drawable around each footprint this chunk touches
          const x0 = c.x0 - 4, z0 = c.z0 - 4, x1 = c.x0 + c.level.side + 4, z1 = c.z0 + c.level.side + 4;
          const lowered = buildings.reground((a, b, e, f) => manager.lowestGround(a, b, e, f),
                                             (bx) => bx[0] <= x1 && bx[2] >= x0 && bx[1] <= z1 && bx[3] >= z0);
          if (lowered > 0 && sun && meets(c, sun.casterRects().buildings)) sun.markShadowsDirty();
        }
      }
      if (kind === 'load' && sun) sun.addChunk(c);
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

  // ---------------------------------------------------------------- sun, shade and sky
  sun = createSun({ renderer, scene, camera, sky, lights: { hemi, fill, sunLight }, water, manifest, facts, listing,
                    manager, profile, requestFrame: () => requestFrame(), onError: (err) => recordError(err) });
  cw.sun = sun.cw;

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
      if (locked) { $('hint').hidden = true; placeDock(); }
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

  // the start never moves with the slider: it is chosen for the default sun, whatever ?t= says
  const pose = startPose(buildings.house, parcels, footprints, sun.defaultVector());
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
    placeDock();
    if (focusEl) focusEl.focus({ preventScroll: true });
  }
  function closePanel(panel, button) {
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    placeDock();
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
  let sunUi = null;
  const openSpecs = () => {
    closePanel(help, btnHelp);
    if (sunUi) sunUi.close();
    openPanel(specs, btnSpecs, $('specs-title'));
    fitSpecs();
    placeDock();
    cw.specsOpenedBy = cw.specsOpenedBy || 'button';
  };
  const refocusCanvas = (ev) => { if (ev && ev.detail > 0) canvas.focus({ preventScroll: true }); };
  btnSpecs.addEventListener('click', () => (specs.hidden ? openSpecs() : closePanel(specs, btnSpecs)));
  $('specs-close').addEventListener('click', () => closePanel(specs, btnSpecs));
  btnHelp.addEventListener('click', () => {
    if (help.hidden) { closePanel(specs, btnSpecs); if (sunUi) sunUi.close(); openPanel(help, btnHelp, $('help-title')); }
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

  // ---------------------------------------------------------------- the sun chip and panel
  // #dock (bottom centre) holds the chip and the status line. It rises clear of whatever it
  // would meet in the lower corners (the hint, the credits, the stick) and of an open bottom
  // sheet (sun or specs), so the chip can always be reached, but never above the header; on a
  // wide screen the sun card sits above it, and above the hint and credits where they share
  // its width.
  const dock = $('dock'), sunPanel = $('sun');
  const sheetMedia = matchMedia('(max-width:600px), (max-height:460px)');
  placeDock = () => {
    const H = innerHeight, boxes = [];
    const add = (el) => {
      if (!el || el.hidden) return;
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) boxes.push(b);
    };
    add($('hint')); add($('credits'));
    if (touchUi) { add($('stick')); add($('vert')); }
    const sunOpen = !sunPanel.hidden, sheet = sheetMedia.matches;
    if (sunOpen && sheet) add(sunPanel);
    const specsOpen = !specs.hidden, specsSheet = specsOpen && getComputedStyle(specs).bottom === '0px';
    if (specsSheet) add(specs);
    const meets = (a, b) => b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top;
    const lift = () => {
      dock.style.bottom = '';
      let r = dock.getBoundingClientRect();
      for (let k = 0; k < 4 && r.height > 0; k++) {
        let raise = -1;
        for (const b of boxes) if (meets(r, b)) raise = Math.max(raise, H - b.top + 8);
        if (raise < 0) break;
        raise = Math.min(raise, H - 70 - r.height);   // below the header, whatever it meets
        dock.style.bottom = raise + 'px';
        r = dock.getBoundingClientRect();
      }
      return r;
    };
    dock.style.left = dock.style.maxWidth = '';
    let r = lift();
    // An open Specs side panel (on the right) that meets the dock: the dock moves into the
    // space left of the panel when the chip fits there (a long status line wraps), and stays
    // clear of the rest as before. Where it does not fit, the dock stays above the panel
    // (z-index), so the chip can still be reached.
    const side = specsOpen && !specsSheet ? specs.getBoundingClientRect() : null;
    const free = side ? side.left - 8 : 0, chipW = $('btn-sun').getBoundingClientRect().width;
    if (side && side.width > 0 && r.height > 0 && meets(r, side) && free - 16 >= chipW) {
      dock.style.maxWidth = free - 16 + 'px';
      dock.style.left = free / 2 + 'px';
      r = lift();
      if (meets(r, side)) { dock.style.left = dock.style.maxWidth = ''; r = lift(); }
    }
    if (sunOpen && !sheet) {
      const pr = sunPanel.getBoundingClientRect();
      let bottom = r.height > 0 ? H - r.top + 8 : 66;
      for (const el of [$('hint'), $('credits')]) {
        if (!el || el.hidden) continue;
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.left < pr.right && b.right > pr.left) bottom = Math.max(bottom, H - b.top + 8);
      }
      sunPanel.style.bottom = bottom + 'px';
      sunPanel.style.maxHeight = Math.max(160, H - bottom - 70) + 'px';
    } else {
      sunPanel.style.bottom = '';
      sunPanel.style.maxHeight = '';
    }
  };
  sunUi = createSunUi({
    sun, manifest, camera, groundAt, requestFrame: () => requestFrame(), placeDock: () => placeDock(), isTouch: touchUi,
    closeOthers: () => { closePanel(specs, btnSpecs); closePanel(help, btnHelp); },
    onOpenChange: (open) => {
      if (touchUi) $('touch').hidden = open;
      // as for the specs sheet: a sheet folds the credits to their (i) button, unless chosen
      if (open && sheetMedia.matches && !creditsChosen) foldCredits();
    }
  });
  window.addEventListener('resize', () => placeDock());
  creditsToggle.addEventListener('click', () => requestAnimationFrame(() => placeDock()));

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
    manager.setView(camera.fov, h);
    placeDock();
    requestFrame();
  }
  // Before three's shadow pass: the sun moves the near box and says which casters it needs;
  // the objects then limit what goes into the map, and the fence dims at night.
  let rectsSeen = -1, nightSeen = null;
  scene.onBeforeRender = (r, sc, cam) => {
    if (cam !== camera) return;
    sun.beforeRender();
    if (sun.rectsVersion !== rectsSeen) {
      rectsSeen = sun.rectsVersion;
      const rects = sun.casterRects();
      const a = buildings.setShadowFocus(rects.buildings);
      const b = trees ? trees.setShadowFocus(rects.trees) : false;
      if (a || b) sun.markShadowsDirty({ inFrame: true });
    }
    if (sun.night !== nightSeen) {
      nightSeen = sun.night;
      fence.setDim(sun.night ? 0.55 : 1);
    }
  };
  function frame(now) {
    raf = 0;
    sunUi.flush();                    // the newest slider value, once per frame
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
      if (trees && trees.update(camera.position)) sun.markShadowsDirty({ inFrame: true });
      sunUi.tick();
    }
    wasMoving = moving;
    if (fenceDirty) {
      fenceDirty = false;
      fence.rebuild((x, z) => manager.surfaceAt(x, z));
    }
    sun.prepareFrame();
    renderer.render(scene, camera);
    frames++;
    placeLabel();
    checkReady();
    while (waiters.length) waiters.shift()();
    if (moving) requestFrame();
    else last = 0;
  }
  // cw.ready also means every building is drawn (their meshing can run in slices)
  let buildingsReady = false;
  buildings.ready.then(() => { buildingsReady = true; sun.markShadowsDirty(); requestFrame(); });
  function checkReady() {
    if (cw.ready || !manager.done || !buildingsReady) return;
    cw.ready = true;
    cw.readyAt = performance.now();
    setStatus();
    sunUi.showChip(true);
    sun.onWorldLoaded().catch((err) => recordError(err));
  }

  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
    else requestFrame();
  });
  // Everything that holds GPU memory is disposed before the renderer: once renderer.dispose()
  // has cleared its properties, a later dispose no longer lowers renderer.info.memory.
  window.addEventListener('pagehide', () => {
    sun.dispose();
    buildings.dispose();
    fence.dispose();
    if (trees) trees.dispose();
    manager.dispose();
    water.geometry.dispose();
    water.material.dispose();
    sky.geometry.dispose();
    sky.material.dispose();
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
        profile: profile.name, frames, workers: manager.workers.length,
        shadowRedrawn: sun.lastRedraw, sun: sun.bytes(),
        terrain: manager.terrainInfo(),
        objects: buildings.info()
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
      // re-mesh to the current camera, wait until no chunk job is left, mesh every loaded h1
      // chunk for this camera (so meshes do not depend on the path it took), wait again, then
      // wait for the sun's sweep and its upload, and draw
      const t0 = performance.now(), left = () => maxMs - (performance.now() - t0);
      const busy = () => manager.queue.length + manager.inflight > 0;
      const drain = async () => { while (busy() && left() > 0) await new Promise((r) => setTimeout(r, 50)); };
      manager.update(camera.position);
      if (trees && trees.update(camera.position)) sun.markShadowsDirty();
      await drain();
      manager.forceSnapshots(camera.position);
      await drain();
      sun.update();
      let sunDone = false;
      await Promise.race([sun.idle().then(() => { sunDone = true; }), new Promise((r) => setTimeout(r, Math.max(0, left())))]);
      fenceDirty = true;
      await cw.frame();
      const ids = sun.jobIds();
      return !busy() && sunDone && ids.landed === ids.requested;
    },
    groundAt: (x, z) => groundAt(x, z),
    decode: (url) => manager.decode(new URL(url, base).href),
    meshChunk: (level, key, detail) => manager.meshChunk(level, key, detail),
    meshRaw: (data, mode, opts) => manager.meshRaw(data, mode, opts),
    loadOrder: () => manager.dispatchLog.slice(),
    openSpecs, house: buildings.house ? { centroid: buildings.house.centroid, ground: buildings.house.ground, roof: buildings.house.roof } : null,
    // the sun: time, shade and light (SPEC 3.4)
    setSunTime(t) {
      if (!sunUi.enabled) return;
      const tz = sun.zone.tz, y = sun.year;
      const utc = typeof t === 'number' ? mapIntoYear(t, y, tz) : parseSiteTime(t, y, tz);
      if (utc === null || !Number.isFinite(utc)) throw new Error('setSunTime: cannot read ' + JSON.stringify(t));
      sunUi.setTime(utc);
    },
    sunTime: () => sunUi.sunTime(),
    sunIdle: () => sun.idle(),
    sunShadeAt: (x, z, hAG = 1.5) => sun.shadeAt(x, z, hAG),
    sunReadout: () => sunUi.readout(),
    setSunQuality(q) { sun.setQuality(q); },
    sunCoverage: () => sun.coverage(),
    sunDebug(mode) { sun.setDebug(mode); },
    async frameCost() {
      // one frame with the near map redrawn and one without; the shadow pass is the difference
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
      const a = { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };
      renderer.render(scene, camera);
      const b = { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls };
      return { main: b, shadow: { triangles: a.triangles - b.triangles, calls: a.calls - b.calls } };
    },
    // the live objects, for integration checks that need drawn heights and meshes
    internals: { scene, renderer, camera, manager, trees, fence, buildings, footprints, controls, water, sky, parcels, sun }
  });

  resize();
  requestAnimationFrame(() => {
    cw.fogColour = sun.matchFog();
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
