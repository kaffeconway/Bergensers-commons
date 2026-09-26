/* Commons World: sun, shade, sky and light on the page.
 *
 * - Terrain shade comes from the sun worker (sunworker.js): three levels of "how high the
 *   terrain upstream shades each point", as half-float textures in the sun's own frame,
 *   read by a patch on every lit material (withSunShade). The patch dims only the sun's
 *   direct light; the sky and ambient fill are left alone.
 * - Trees and buildings cast into one near shadow map (a DirectionalLight, PCF) fitted to a
 *   disc of receivers ahead of the camera. The terrain never casts into it.
 * - Light, sky and fog follow the sun's elevation (a keyframe table, a patched Sky with a
 *   twilight and night floor, and the fog matched to the sky after each settled change).
 *
 * Everything here works in local metres: x east, z south, y up (world/FORMAT.md section 1).
 * Nothing in here touches THREE.ShaderChunk: every patch is a string replacement on one
 * material, and throws if its anchor is missing (a three.js upgrade must re-check them).
 */
import * as THREE from 'three';
import { sunPosition, sunVector, horizonAt, sitePosition, siteZone, factsYear, localParts, formatLocal,
         zoneLabel, MONTHS } from './sun.js';

// Per profile: the sweep's cells and h1 window, the near map, and how far trees cast on a phone.
export const SUN_PROFILES = {
  phone: { h20Cell: 40, h5Cell: 10, h1Half: 256, h1Cell: 1, map: 1024, radius: 1.5, Rn: 70, back: 600, treeCast: 300 },
  laptop: { h20Cell: 40, h5Cell: 5, h1Half: 512, h1Cell: 1, map: 2048, radius: 2, Rn: 150, back: 1500, treeCast: Infinity }
};
// While a slider is dragged: coarser cells, a smaller h1 window.
const DRAG = { h20Cell: 40, h5Cell: 20, h1Half: 256, h1Cell: 2 };
const NIGHT_EL = -1;               // below this (deg) the sun gives no direct light at all
const DEFAULT_AZ = 235;            // today's view: 21 Jun, the tick nearest this true azimuth
const FLY_OFF_M = 500;             // above this height over the ground the h1 window is off
const RESWEEP_MS = 300;            // chunks arriving: one sweep after they stop for this long
const M_LIT = -10000;              // the fully lit value the textures start with
const HALF_LIT = halfOf(M_LIT);

/* Light by the sun's apparent elevation: [el, sun intensity, sun colour, hemisphere
 * intensity, sky colour, ground colour, ambient]. Colours are sRGB; linear in elevation
 * between rows. design-sun-custom.md section 4.2. */
export const LIGHT_KEYS = [
  [-18, 0.0, [1, 0.62, 0.40], 0.30, [0.30, 0.38, 0.58], [0.20, 0.20, 0.22], 0.10],
  [-12, 0.0, [1, 0.62, 0.40], 0.34, [0.32, 0.39, 0.60], [0.22, 0.22, 0.24], 0.10],
  [-6, 0.0, [1, 0.62, 0.40], 0.55, [0.52, 0.56, 0.70], [0.30, 0.29, 0.30], 0.12],
  [-3, 0.0, [1, 0.62, 0.40], 0.72, [0.66, 0.66, 0.74], [0.38, 0.35, 0.32], 0.13],
  [1, 0.5, [1, 0.62, 0.40], 1.00, [0.74, 0.75, 0.80], [0.47, 0.42, 0.36], 0.15],
  [5, 1.5, [1, 0.78, 0.58], 1.20, [0.80, 0.84, 0.90], [0.52, 0.47, 0.40], 0.16],
  [12, 2.1, [1, 0.88, 0.74], 1.35, [0.84, 0.89, 0.94], [0.54, 0.50, 0.42], 0.17],
  [25, 2.4, [1, 0.93, 0.84], 1.45, [0.87, 0.91, 0.95], [0.54, 0.50, 0.42], 0.17],
  [50, 2.5, [1, 0.95, 0.88], 1.55, [0.89, 0.93, 0.95], [0.54, 0.50, 0.42], 0.17]
];
/* The sky's floor below it (linear, before the sky's tone mapping): at the horizon and at the
 * zenith. A pale twilight, then deep blue, then a moonless night. */
export const SKY_FLOOR = [
  [2, [0, 0, 0], [0, 0, 0]],
  [-1, [0.20, 0.19, 0.21], [0.08, 0.10, 0.16]],
  [-4, [0.16, 0.16, 0.22], [0.07, 0.09, 0.17]],
  [-8, [0.07, 0.09, 0.17], [0.035, 0.05, 0.11]],
  [-12, [0.045, 0.055, 0.105], [0.02, 0.028, 0.065]],
  [-18, [0.035, 0.045, 0.08], [0.012, 0.018, 0.04]]
];

function lerpRows(rows, el) {
  const up = rows[0][0] < rows[rows.length - 1][0];
  const r = up ? rows : rows.slice().reverse();
  if (el <= r[0][0]) return r[0];
  if (el >= r[r.length - 1][0]) return r[r.length - 1];
  let i = 0;
  while (el > r[i + 1][0]) i++;
  const a = r[i], b = r[i + 1], t = (el - a[0]) / (b[0] - a[0]);
  return a.map((v, k) => (k === 0 ? el : Array.isArray(v) ? v.map((x, j) => x + (b[k][j] - x) * t) : v + (b[k] - v) * t));
}
export function lightAt(el) {
  const k = lerpRows(LIGHT_KEYS, el);
  return { sunI: el < NIGHT_EL ? 0 : k[1], sun: k[2], hemiI: k[3], sky: k[4], ground: k[5], amb: k[6] };
}
function skyFloorAt(el) { const k = lerpRows(SKY_FLOOR, el); return { horizon: k[1], zenith: k[2] }; }

// ------------------------------------------------------------------ half floats
function halfOf(v) {
  const f = new Float32Array([v]), x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112;
  return sign | ((e << 10) + (((x & 0x7fffff) + 0x1000) >> 13));
}
export function fromHalf(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

// ------------------------------------------------------------------ the material patch
// Shared by every patched material; createSun fills the values.
const SU = {
  cwSM1: { value: null }, cwSM5: { value: null }, cwSM20: { value: null },
  cwSF1: { value: new THREE.Vector4(0, 0, 1, 1) }, cwSF5: { value: new THREE.Vector4(0, 0, 1, 1) },
  cwSF20: { value: new THREE.Vector4(0, 0, 1, 1) },
  cwSSc: { value: new THREE.Vector3(1, 1, 1) },
  cwSDir: { value: new THREE.Vector4(1, 0, 0, 1) },
  cwSOn: { value: new THREE.Vector3(0, 0, 0) },
  cwSDebug: { value: 0 }
};
const KINDS = ['zero', 'instance', 'attribute'];
const decorated = new WeakMap();            // material -> kind

const VERT_DECL = `
varying vec2 vCwSW;
varying float vCwSHag;`;
function vertBody(kind) {
  const hag = kind === 'instance'
    ? '#ifdef USE_INSTANCING\n  vCwSHag = ( instanceMatrix * vec4( transformed, 1.0 ) ).y - instanceMatrix[ 3 ].y;\n#else\n  vCwSHag = 0.0;\n#endif'
    : kind === 'attribute' ? '  vCwSHag = cwSP.y - cwGround;' : '  vCwSHag = 0.0;';
  return `
{
  vec4 cwSP = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  cwSP = instanceMatrix * cwSP;
#endif
  cwSP = modelMatrix * cwSP;
  vCwSW = cwSP.xz;
${hag}
}`;
}
const FRAG_DECL = `
uniform sampler2D cwSM1;
uniform sampler2D cwSM5;
uniform sampler2D cwSM20;
uniform vec4 cwSF1;
uniform vec4 cwSF5;
uniform vec4 cwSF20;
uniform vec3 cwSSc;
uniform vec4 cwSDir;
uniform vec3 cwSOn;
uniform float cwSDebug;
varying vec2 vCwSW;
varying float vCwSHag;
float cwSVisV = 1.0;
float cwSNearV = 1.0;
float cwSInside( vec4 F ) {
  vec2 d = vCwSW - F.xy;
  float r = max( abs( dot( d, cwSDir.xy ) ), abs( dot( d, cwSDir.zw ) ) );
  return 1.0 - smoothstep( F.z - 22.0 * F.w, F.z - 2.0 * F.w, r );
}
vec2 cwSUv( vec4 F, float sc ) {
  vec2 d = vCwSW - F.xy;
  return ( vec2( dot( d, cwSDir.xy ), dot( d, cwSDir.zw ) ) + F.z ) / ( 2.0 * F.z ) * sc;
}
float cwSStep( float M, float pen ) { return smoothstep( -pen, pen, vCwSHag - M ); }
float cwSVis() {
  float w20 = cwSOn.z * cwSInside( cwSF20 );
  float w5 = cwSOn.y * cwSInside( cwSF5 );
  float w1 = cwSOn.x * cwSInside( cwSF1 );
  float v = 1.0;
  if ( w20 > 0.0 ) v = mix( v, cwSStep( texture2D( cwSM20, cwSUv( cwSF20, cwSSc.z ) ).r, 0.6 * cwSF20.w ), w20 );
  if ( w5 > 0.0 ) v = mix( v, cwSStep( texture2D( cwSM5, cwSUv( cwSF5, cwSSc.y ) ).r, 0.6 * cwSF5.w ), w5 );
  if ( w1 > 0.0 ) {
    vec2 md = texture2D( cwSM1, cwSUv( cwSF1, cwSSc.x ) ).rg;
    v = mix( v, cwSStep( md.r, 0.3 + 0.00465 * md.g ), w1 );
  }
  return v;
}
float cwSNear( float s, vec4 c ) {
  vec3 p = c.xyz / c.w;
  float e = max( abs( p.x - 0.5 ), abs( p.y - 0.5 ) ) * 2.0;
  cwSNearV = mix( s, 1.0, smoothstep( 0.85, 1.0, e ) );
  return cwSNearV;
}
vec3 cwSShoulder( vec3 c ) {
  return mix( c, 0.8 + 0.2 * ( 1.0 - exp( -( c - 0.8 ) / 0.2 ) ), step( 0.8, c ) );
}
// the debug colour, written so that after the output's sRGB encoding the canvas holds the
// visibilities themselves: R terrain shade, G the near map
vec3 cwSDebugColour() {
  vec3 c = vec3( cwSVisV, cwSNearV, 0.0 );
  return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}`;
const DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const DIR_SHADOW = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';

function anchor(src, find, what) {
  if (!src.includes(find)) throw new Error('cw patch anchor missing: ' + what);
}

/* The sun patch on one shader (what onBeforeCompile gets). kind: how high above the ground
 * each vertex is: 'zero' (terrain, water), 'instance' (an instanced tree, above its base),
 * 'attribute' (a building vertex, above the per-vertex cwGround). Throws if an anchor is
 * missing. */
export function patchSunShader(shader, kind) {
  if (!KINDS.includes(kind)) throw new Error('cw patch: unknown kind ' + kind);
  const vs = shader.vertexShader, fs = shader.fragmentShader;
  anchor(vs, '#include <common>', 'vertex #include <common>');
  anchor(vs, '#include <worldpos_vertex>', 'vertex #include <worldpos_vertex>');
  anchor(fs, '#include <common>', 'fragment #include <common>');
  anchor(fs, '#include <lights_fragment_begin>', 'fragment #include <lights_fragment_begin>');
  anchor(fs, '#include <opaque_fragment>', 'fragment #include <opaque_fragment>');
  const lights = THREE.ShaderChunk.lights_fragment_begin;
  anchor(lights, DIR_INFO, 'lights_fragment_begin getDirectionalLightInfo');
  anchor(lights, DIR_SHADOW, 'lights_fragment_begin directional getShadow');
  Object.assign(shader.uniforms, SU);
  shader.vertexShader = vs
    .replace('#include <common>', '#include <common>' + VERT_DECL + (kind === 'attribute' ? '\nattribute float cwGround;' : ''))
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>' + vertBody(kind));
  shader.fragmentShader = fs
    .replace('#include <common>', '#include <common>' + FRAG_DECL)
    .replace('#include <lights_fragment_begin>', lights
      .replace(DIR_INFO, DIR_INFO + '\n\t\tcwSVisV = cwSVis();\n\t\tdirectLight.color *= cwSVisV;')
      .replace(DIR_SHADOW, 'cwSNear( ' + DIR_SHADOW + ', vDirectionalShadowCoord[ i ] )'))
    .replace('#include <opaque_fragment>',
      'outgoingLight = cwSShoulder( outgoingLight );\nif ( cwSDebug > 0.5 ) outgoingLight = cwSDebugColour();\n#include <opaque_fragment>');
  return shader;
}

/* Decorate a Lambert or Phong material with the sun patch, chaining any onBeforeCompile it
 * already has (the previous hook runs first) and extending its program key with the kind.
 * Which materials are decorated is kept in a WeakMap, never in userData: a clone() copies
 * userData but not onBeforeCompile, so a clone is decorated again on its first frame. */
export function withSunShade(material, kind) {
  const had = decorated.get(material);
  if (had !== undefined) {
    if (had !== kind) throw new Error('cw sun patch: material "' + (material.name || material.type) + '" is ' + had + ', asked for ' + kind);
    return material;
  }
  if (!KINDS.includes(kind)) throw new Error('cw sun patch: unknown kind ' + kind);
  const prevCompile = material.onBeforeCompile, prevKey = material.customProgramCacheKey;
  const ownCompile = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey');
  material.onBeforeCompile = function (shader, renderer) {
    if (ownCompile && prevCompile) prevCompile.call(this, shader, renderer);
    patchSunShader(shader, kind);
  };
  material.customProgramCacheKey = function () {
    return (ownKey && prevKey ? prevKey.call(this) : '') + '|cwS1-' + kind;
  };
  decorated.set(material, kind);
  material.needsUpdate = true;
  return material;
}
export function sunKindOf(material) { return decorated.get(material); }

/* The kind of a mesh: its userData.cwHag when set, else 'instance' for an InstancedMesh,
 * 'attribute' when the geometry has cwGround, else 'zero'. */
export function meshKind(mesh) {
  if (mesh.userData && mesh.userData.cwHag !== undefined) return mesh.userData.cwHag;
  if (mesh.isInstancedMesh) return 'instance';
  if (mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.cwGround) return 'attribute';
  return 'zero';
}
const isLit = (m) => !!m && (m.isMeshLambertMaterial || m.isMeshPhongMaterial);

// ------------------------------------------------------------------ the sun
export function createSun({ renderer, scene, camera, sky, lights, water, manifest, facts, listing, manager,
                            profile: viewProfile, requestFrame, onError }) {
  const { hemi, fill, sunLight } = lights;
  const report = onError || (() => {});
  const crs = manifest.crs;
  const offset = Number(crs.grid_north_offset_deg) || 0;
  const site = sitePosition(manifest, listing);
  const zone = siteZone(manifest, listing);
  const year = factsYear(facts);
  const fs = (facts && facts.sun) || {};
  const garden = fs.garden_point && Number.isFinite(fs.garden_point.x) && Number.isFinite(fs.garden_point.z)
    ? { x: fs.garden_point.x, z: fs.garden_point.z } : null;
  const okProfile = (a) => Array.isArray(a) && a.length === 720 && a.every(Number.isFinite);
  const profile = fs.horizon && okProfile(fs.horizon.profile_deg) ? fs.horizon.profile_deg : null;
  const bw = fs.horizon && fs.horizon.beyond_world;
  const beyond = bw && okProfile(bw.profile_deg) && okProfile(bw.distance_m) ? bw : null;
  const monthly = fs.garden_point && fs.garden_point.terrain && Array.isArray(fs.garden_point.terrain.monthly_h)
    ? fs.garden_point.terrain.monthly_h : null;
  const base = SUN_PROFILES[viewProfile && viewProfile.name] || SUN_PROFILES.laptop;
  let quality = base;
  let derivedGate = null;          // from the world's own horizon when facts have no beyond_world

  const altitude = () => {
    if (Number.isFinite(fs.altitude_m)) return fs.altitude_m;
    if (fs.garden_point && Number.isFinite(fs.garden_point.ground_m)) return Math.max(0, fs.garden_point.ground_m);
    const g = manager.groundAt(0, 0);
    return g ? Math.max(0, g.y) : 0;
  };

  // ---------------------------------------------------------------- the sky's night floor
  const skyMat = sky.material;
  const skySource = skyMat.fragmentShader;
  anchor(skySource, 'uniform float time;', 'Sky uniform float time');
  anchor(skySource, 'gl_FragColor = vec4( texColor, 1.0 );', 'Sky gl_FragColor');
  skyMat.uniforms.cwSNight = { value: new THREE.Vector3() };
  skyMat.uniforms.cwSNightZ = { value: new THREE.Vector3() };
  skyMat.fragmentShader = skySource
    .replace('uniform float time;', 'uniform float time;\n\t\tuniform vec3 cwSNight;\n\t\tuniform vec3 cwSNightZ;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );',
             'texColor += mix( cwSNight, cwSNightZ, clamp( direction.y * 2.0, 0.0, 1.0 ) );\n\t\t\tgl_FragColor = vec4( texColor, 1.0 );');
  skyMat.needsUpdate = true;

  // ---------------------------------------------------------------- the near shadow map
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;          // the map must exist before any receiver is drawn
  sunLight.castShadow = true;
  const applyMapSize = () => {
    sunLight.shadow.mapSize.set(base.map, base.map);
    sunLight.shadow.radius = base.radius;
    if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
  };
  applyMapSize();
  sunLight.shadow.normalBias = 0.12;
  if (!sunLight.target.parent) scene.add(sunLight.target);

  // ---------------------------------------------------------------- terrain-shade textures
  const h20 = manifest.levels.find((l) => l.name === 'h20');
  const h5 = manifest.levels.find((l) => l.name === 'h5');
  const h1 = manifest.levels.find((l) => l.name === 'h1');
  function squaresRadius(l) {
    if (!l) return 0;
    const S = l.cell * l.chunk_samples;
    let far = 0;
    for (const key of Object.keys(l.chunks || {}).concat(l.sea || [])) {
      const m = /^(-?\d+)_(-?\d+)$/.exec(key);
      if (!m) continue;
      const e0 = Number(m[1]) * S - crs.origin_e, n0 = Number(m[2]) * S - crs.origin_n;
      for (const a of [0, S]) for (const b of [0, S]) far = Math.max(far, Math.hypot(e0 + a, n0 + b));
    }
    return far;
  }
  const radius20 = squaresRadius(h20), radius5 = h5 ? h5.radius || squaresRadius(h5) : 0;
  const texSize = (q) => ({
    h20: h20 ? Math.round(2 * Math.ceil(radius20 / q.h20Cell) * q.h20Cell / q.h20Cell) : 2,
    h5: h5 ? Math.round(2 * Math.ceil(radius5 / q.h5Cell) * q.h5Cell / q.h5Cell) : 2,
    h1: h1 ? Math.round(2 * q.h1Half / q.h1Cell) : 2
  });
  const tex = {};
  function makeTexture(N, ch) {
    const data = new Uint16Array(N * N * ch);
    for (let i = 0; i < N * N; i++) data[i * ch] = HALF_LIT;
    const t = new THREE.DataTexture(data, N, N, ch === 1 ? THREE.RedFormat : THREE.RGFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.flipY = false;
    t.unpackAlignment = 2;
    t.needsUpdate = true;
    renderer.initTexture(t);
    t.image = { data: null, width: N, height: N };   // uploaded; results go in with texSubImage2D
    return t;
  }
  function ensureTextures(q) {
    const want = texSize(q);
    for (const [name, ch] of [['h1', 2], ['h5', 1], ['h20', 1]]) {
      const t = tex[name];
      if (t && t.image.width >= want[name]) continue;
      if (t) t.dispose();
      tex[name] = makeTexture(want[name], ch);
    }
    SU.cwSM1.value = tex.h1; SU.cwSM5.value = tex.h5; SU.cwSM20.value = tex.h20;
  }
  ensureTextures(base);
  function upload(name, res) {
    const t = tex[name], gl = renderer.getContext(), props = renderer.properties.get(t);
    if (!props.__webglTexture) renderer.initTexture(t);
    renderer.state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, res.n, res.n, res.withD ? gl.RG : gl.RED, gl.HALF_FLOAT, res.m);
  }

  // What the GPU was last given, per level, for sunShadeAt (and returned to the worker when
  // the next result replaces it).
  const cur = { h1: null, h5: null, h20: null };

  // ---------------------------------------------------------------- the worker
  const worker = new Worker(new URL('./sunworker.js', import.meta.url), { type: 'module' });
  let workerBytes = 0, disposed = false;
  worker.onerror = (ev) => { ev.preventDefault(); report(new Error('sun worker failed: ' + (ev.message || 'unknown error'))); };
  const levelRec = (l) => ({ name: l.name, cell: l.cell, samples: l.chunk_samples, radius: l.radius,
                             keys: Object.keys(l.chunks || {}), sea: l.sea || [] });
  worker.postMessage({ type: 'init', id: 0, originE: crs.origin_e, originN: crs.origin_n, offset,
                       garden, levels: [h1, h5, h20].filter(Boolean).map(levelRec) });

  let seq = 0, inflight = null, pending = null, requested = 0, landed = 0, posted = 0, debounce = 0;
  const waiters = [];
  const other = new Map();         // id -> resolve, for march and horizon jobs
  function post(kind, q) {
    if (disposed) return;
    const job = { kind, q: q || quality };
    if (kind === 'window' && pending && pending.kind === 'sun') return;     // the sun job covers it
    requested = ++seq;
    job.id = requested;
    if (inflight) { pending = job; return; }
    send(job);
  }
  // The sun the textures were last swept for, and the one the newest sent job sweeps for: the
  // readout compares drawn shade with the measurement only when the two agree.
  let sentSun = null, shownSun = null;
  const sunKey = () => [state.elevation, state.gridBearing, state.gate ? state.gate.tanG : '', state.gate ? state.gate.dG : ''].join('|');
  function send(job) {
    inflight = job;
    posted++;
    if (job.kind === 'sun') sentSun = sunKey();
    job.sunKey = sentSun;
    if (job.kind === 'sun') {
      worker.postMessage({ type: 'sun', id: job.id, gridBearing: state.gridBearing, el: state.elevation,
                           quality: job.q, window: win.on ? { x: win.x, z: win.z } : null, gate: state.gate });
    } else {
      worker.postMessage({ type: 'window', id: job.id, window: win.on ? { x: win.x, z: win.z } : null });
    }
  }
  worker.onmessage = (ev) => {
    const r = ev.data;
    if (r.bytes !== undefined) workerBytes = r.bytes;
    if (other.has(r.id)) {
      const f = other.get(r.id);
      other.delete(r.id);
      f(r);
      // once whatever this reply sets off has posted its jobs (promise continuations run
      // first), anyone waiting for the sun to go idle hears about it
      setTimeout(wake, 0);
      return;
    }
    if (!inflight || r.id !== inflight.id) return;
    const job = inflight;
    inflight = null;
    if (!r.ok) report(new Error('sun worker: ' + r.error));
    else { install(r); shownSun = job.sunKey; }
    if (pending) { const p = pending; pending = null; send(p); }
    requestFrame();
    wake();
    if (r.ok && sun.onShade) { try { sun.onShade(); } catch (err) { report(err); } }
  };
  function install(r) {
    const back = [];
    const map = { h1: ['cwSF1', 'x'], h5: ['cwSF5', 'y'], h20: ['cwSF20', 'z'] };
    for (const name of ['h20', 'h5', 'h1']) {
      if (!(name in r.levels)) continue;
      const res = r.levels[name];
      if (cur[name]) back.push(cur[name].m);
      if (!res) { cur[name] = null; SU.cwSOn.value[map[name][1]] = 0; continue; }
      if (res.n > tex[name].image.width) ensureTextures(quality);
      upload(name, res);
      res.N = tex[name].image.width;
      cur[name] = res;
      SU[map[name][0]].value.set(res.cx, res.cz, res.R, res.c);
      SU.cwSSc.value[map[name][1]] = res.n / res.N;
      SU.cwSOn.value[map[name][1]] = 1;
    }
    if (r.dir) SU.cwSDir.value.set(r.dir.wx, r.dir.wz, r.dir.px, r.dir.pz);
    landed = r.id;
    state.lastMs = r.ms;
    if (back.length) worker.postMessage({ type: 'return', arrays: back }, back.map((a) => a.buffer));
  }
  function ask(msg) {
    return new Promise((resolve) => {
      const id = ++seq;
      other.set(id, resolve);
      worker.postMessage(Object.assign({ id }, msg));
    });
  }
  function isIdle() { return !inflight && !pending && !debounce && other.size === 0; }
  function wake() {
    if (!isIdle()) return;
    while (waiters.length) waiters.shift()();
  }

  // ---------------------------------------------------------------- heights for the worker
  const heldH1 = new Set();
  function h1Wanted(c) {
    if (!win.on) return false;
    const e = quality.h1Half + 240, S = c.level.side;
    return c.x0 < win.x + e && c.x0 + S > win.x - e && c.z0 < win.z + e && c.z0 + S > win.z - e;
  }
  function postHeights(c) {
    // cloned, never transferred: the chunk manager and groundAt keep reading c.data.v
    worker.postMessage({ type: 'heights', level: c.level.name, key: c.key, header: c.data.header, v: c.data.v });
  }
  function syncH1() {
    const drop = [];
    for (const c of manager.chunks) {
      if (c.level.name !== 'h1' || !c.data) continue;
      const want = h1Wanted(c);
      if (want && !heldH1.has(c.key)) { postHeights(c); heldH1.add(c.key); }
      else if (!want && heldH1.has(c.key)) { heldH1.delete(c.key); drop.push(c.key); }
    }
    if (drop.length) worker.postMessage({ type: 'drop', level: 'h1', keys: drop });
  }
  const arrivals = new Map();       // 'level:key' -> the last job id asked for when it arrived
  function addChunk(c) {
    if (!c || !c.data || disposed) return;
    let matters = false;
    if (c.level.name === 'h1') {
      if (h1Wanted(c) && !heldH1.has(c.key)) { postHeights(c); heldH1.add(c.key); matters = true; }
    } else {
      postHeights(c);
      matters = true;
    }
    if (matters) arrivals.set(c.level.name + ':' + c.key, requested);
    if (matters && !state.night) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = 0; if (!state.night) post('sun', quality); else wake(); }, RESWEEP_MS);
    }
  }

  // ---------------------------------------------------------------- the h1 window
  const win = { on: false, x: 0, z: 0 };
  function wantWindow() {
    if (!h1) return { on: false, x: 0, z: 0 };
    const p = camera.position, g = manager.groundAt(p.x, p.z);
    const above = g ? p.y - g.y : 0;
    const x = Math.round(p.x / 32) * 32, z = Math.round(p.z / 32) * 32;
    const reach = (h1.radius || 1500) + quality.h1Half;
    return { on: above <= FLY_OFF_M && Math.hypot(x, z) <= reach, x, z };
  }
  function moveWindow(force) {
    const w = wantWindow();
    const moved = w.on !== win.on || (w.on && Math.max(Math.abs(w.x - win.x), Math.abs(w.z - win.z)) > quality.h1Half / 4);
    if (!moved && !force) return false;
    Object.assign(win, w);
    syncH1();
    return true;
  }

  // ---------------------------------------------------------------- the far gate
  function gateAt(az) {
    if (beyond) {
      const G = horizonAt(beyond.profile_deg, az), dG = beyond.distance_m[Math.round(az / 0.5) % 720];
      return dG > 0 ? { G, tanG: Math.tan(G * Math.PI / 180), dG } : null;
    }
    if (derivedGate) {
      const k = Math.round(az / 0.5) % 720;
      return derivedGate[k] === null ? null : { G: derivedGate[k], tanG: Math.tan(derivedGate[k] * Math.PI / 180), dG: radius20 + 5000 };
    }
    return null;
  }
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ---------------------------------------------------------------- state
  const state = { utc: null, trueAzimuth: DEFAULT_AZ, elevation: 38, geometric: 38, gridBearing: DEFAULT_AZ + offset,
                  gate: null, gateF: 1, night: false, behindFar: false, lastMs: null, dir: [0, 1, 0] };
  const defaultUtc = (() => {
    if (!site) return null;
    let best = null;
    const day0 = Date.UTC(year, 5, 21);
    for (let k = 0; k < 144; k++) {
      const t = day0 + k * 600000, s = sunPosition(t, site.lat, site.lon, altitude());
      if (s.elevation <= 0) continue;
      const d = Math.abs(((s.azimuth - DEFAULT_AZ + 540) % 360) - 180);
      if (!best || d < best.d) best = { d, t };
    }
    return best ? best.t : null;
  })();
  const hasPath = !!(fs.sun_path && Array.isArray(fs.sun_path.jun21) && fs.sun_path.jun21.length);
  const pad = (v) => String(v).padStart(2, '0');
  const utcText = (t) => { const d = new Date(t); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC'; };

  // With no latitude and longitude there is no clock: today's fixed sun (the facts' sun path
  // sample nearest 235 deg, else a summer afternoon).
  function fixedSun() {
    let az = DEFAULT_AZ, el = 38, source = 'default (no facts.json sun path)';
    const path = fs.sun_path && fs.sun_path.jun21;
    if (Array.isArray(path)) {
      let best = null;
      for (const p of path) {
        if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1]) || p[1] < 12) continue;
        const d = Math.abs(((p[0] - DEFAULT_AZ + 540) % 360) - 180);
        if (!best || d < best.d) best = { d, az: p[0], el: p[1] };
      }
      if (best) { az = best.az; el = best.el; source = 'facts.json sun path, 21 June, mid-afternoon'; }
    }
    return { azimuth: az, elevation: el, geometric: el, source };
  }

  let fogDirty = false;
  function applySunTime(utc, q) {
    let s, source;
    if (site && utc !== null) {
      s = sunPosition(utc, site.lat, site.lon, altitude());
      source = utc === defaultUtc
        ? 'computed for ' + utcText(utc) + ', the ' + (hasPath ? 'facts.json sun-path sample' : '10-minute tick') + ' nearest 235 deg'
        : 'computed for ' + utcText(utc) + ' (NOAA equations, pvlib refraction)';
    } else {
      s = fixedSun();
      source = s.source;
      utc = null;
    }
    const el = s.elevation, az = s.azimuth;
    const gate = gateAt(az);
    const gateF = gate ? smooth(gate.G - 0.27, gate.G + 0.27, el) : 1;
    const dir = sunVector(az, el, offset);
    const wasNight = state.night;
    Object.assign(state, { utc, trueAzimuth: az, elevation: el, geometric: s.geometric, gridBearing: az + offset,
                           gate: gate ? { tanG: gate.tanG, dG: gate.dG } : null, gateF, dir,
                           // behind the far terrain: the sun is up, but not above the horizon beyond the world
                           behindFar: !!gate && el > 0 && el <= gate.G, night: el < NIGHT_EL || gateF <= 0, source });
    // lights
    const k = lightAt(el);
    sunLight.intensity = k.sunI * gateF;
    sunLight.color.setRGB(k.sun[0], k.sun[1], k.sun[2], THREE.SRGBColorSpace);
    hemi.intensity = k.hemiI;
    hemi.color.setRGB(k.sky[0], k.sky[1], k.sky[2], THREE.SRGBColorSpace);
    hemi.groundColor.setRGB(k.ground[0], k.ground[1], k.ground[2], THREE.SRGBColorSpace);
    fill.intensity = k.amb;
    // sky
    sky.material.uniforms.sunPosition.value.set(dir[0], dir[1], dir[2]);
    if (sky.material.uniforms.showSunDisc) sky.material.uniforms.showSunDisc.value = state.behindFar ? 0 : 1;
    const f = skyFloorAt(el);
    sky.material.uniforms.cwSNight.value.set(f.horizon[0], f.horizon[1], f.horizon[2]);
    sky.material.uniforms.cwSNightZ.value.set(f.zenith[0], f.zenith[1], f.zenith[2]);
    // shadows and shade
    fitDirty = true;
    if (!state.night) {
      moveWindow(false);
      post('sun', q);
      markShadowsDirty();
    } else if (wasNight !== state.night) {
      // nothing to sweep or draw; the textures keep their last contents
    }
    fogDirty = true;
    publish();
    requestFrame();
  }

  function publish() {
    const tz = zone.tz;
    cwSun.trueAzimuth = state.trueAzimuth;
    cwSun.elevation = state.elevation;
    cwSun.gridBearing = state.gridBearing;
    cwSun.offset = offset;
    cwSun.source = state.source;
    cwSun.dir = state.dir.slice();
    cwSun.utc = state.utc;
    cwSun.local = state.utc !== null ? formatLocal(state.utc, tz) : null;
    cwSun.tz = tz;
    cwSun.geometric = state.geometric;
    cwSun.altitude_m = altitude();
    cwSun.behindFacts = profile ? !(state.elevation > horizonAt(profile, state.trueAzimuth)) : null;
    cwSun.behindFar = state.behindFar;
  }
  const cwSun = {};

  // ---------------------------------------------------------------- the near box
  let fitDirty = true, lastFocus = null, lastYaw = null, rects = { buildings: null, trees: null }, rectsVersion = 0;
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const L = new THREE.Vector3(), X = new THREE.Vector3(), Y = new THREE.Vector3(), focus = new THREE.Vector3();
  function relief(fx, fz, R) {
    let lo = Infinity, hi = -Infinity;
    for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) {
      if (a * a + b * b > 16) continue;
      const y = manager.surfaceAt(fx + a * R / 4, fz + b * R / 4);
      if (y === null) continue;
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    return hi > lo ? hi - lo : 0;
  }
  function fitBox() {
    const Rn = base.Rn;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    const fx = camera.position.x + fwd.x * 0.35 * Rn, fz = camera.position.z + fwd.z * 0.35 * Rn;
    const yaw = Math.atan2(fwd.x, -fwd.z);
    const moved = !lastFocus || Math.hypot(fx - lastFocus[0], fz - lastFocus[1]) > Rn / 8 ||
                  Math.abs(((yaw - lastYaw) * 180 / Math.PI + 540) % 360 - 180) > 20;
    if (!moved && !fitDirty) return false;
    fitDirty = false;
    lastFocus = [fx, fz]; lastYaw = yaw;
    const g = manager.surfaceAt(fx, fz);
    focus.set(fx, g === null ? camera.position.y - 1.7 : g, fz);
    const el = Math.max(state.elevation, 1) * Math.PI / 180;
    const sinE = Math.sin(el), cosE = Math.cos(el), tanE = Math.tan(el);
    const dh = relief(fx, fz, Rn);
    const half = Rn * sinE + 0.5 * dh * cosE + 5;
    const back = Math.min(base.back, 60 / tanE);
    L.set(state.dir[0], state.dir[1], state.dir[2]).normalize();
    if (L.y < Math.sin(1 * Math.PI / 180)) { L.y = Math.sin(1 * Math.PI / 180); L.normalize(); }
    X.crossVectors(up, L).normalize();
    Y.crossVectors(L, X).normalize();
    const texX = 2 * Rn / base.map, texY = 2 * half / base.map;
    const px = Math.round(focus.dot(X) / texX) * texX, py = Math.round(focus.dot(Y) / texY) * texY, pl = focus.dot(L);
    const f = new THREE.Vector3().addScaledVector(X, px).addScaledVector(Y, py).addScaledVector(L, pl);
    // The near plane stands `back` metres toward the sun from the receiver disc's sunward edge
    // and its highest ground, not from the focus: a receiver r metres sunward of the focus is
    // r cos e nearer the light, and a caster h metres above it h / sin e nearer still. Measured
    // from the focus, casters in the sunward part of the disc fell in front of the near plane
    // and cast nothing (at a 44 deg sun on a laptop, everything beyond about 86 m). The far
    // plane reaches past the disc's other edge and its lowest ground.
    const edge = Rn * cosE + dh * sinE + 5;
    const cam = sunLight.shadow.camera;
    cam.left = -Rn; cam.right = Rn; cam.top = half; cam.bottom = -half;
    cam.near = 0.5; cam.far = back + edge + Rn * cosE + dh + 10;
    cam.updateProjectionMatrix();
    sunLight.target.position.copy(f);
    sunLight.position.copy(f).addScaledVector(L, back + edge);
    sunLight.updateMatrixWorld();
    sunLight.target.updateMatrixWorld();
    sunLight.shadow.bias = -0.05 / (cam.far - cam.near);
    box = { Rn, half, back, edge, near: cam.near, far: cam.far, texX, texY, focus: [f.x, f.y, f.z], dh };
    // the caster rects: the receiver disc swept toward the sun
    const ux = state.dir[0], uz = state.dir[2], ul = Math.hypot(ux, uz) || 1;
    const sweepL = Math.min(back, 35 / tanE);
    const ex = ux / ul * sweepL, ez = uz / ul * sweepL;
    const r = { x0: Math.min(fx, fx + ex) - Rn, z0: Math.min(fz, fz + ez) - Rn, x1: Math.max(fx, fx + ex) + Rn, z1: Math.max(fz, fz + ez) + Rn };
    let t = r;
    if (isFinite(base.treeCast)) {
      const c = base.treeCast;
      t = { x0: Math.max(r.x0, fx - c), z0: Math.max(r.z0, fz - c), x1: Math.min(r.x1, fx + c), z1: Math.min(r.z1, fz + c) };
    }
    setRects({ buildings: r, trees: t });
    return true;
  }
  let box = null;
  const rectKey = (r) => (r ? [r.x0, r.z0, r.x1, r.z1].map((v) => Math.round(v * 10)).join(',') : 'null');
  function setRects(next) {
    if (rectKey(next.buildings) === rectKey(rects.buildings) && rectKey(next.trees) === rectKey(rects.trees)) return;
    rects = next;
    rectsVersion++;
  }

  let lastRedraw = false;
  function markShadowsDirty(opts) {
    if (disposed || state.night) return;             // at night the map is not redrawn
    renderer.shadowMap.needsUpdate = true;
    if (opts && opts.inFrame) lastRedraw = true;     // inside the frame, before its shadow pass
    else requestFrame();
  }

  // ---------------------------------------------------------------- fog
  const fogTable = new Map();       // elevation bucket -> sRGB hex
  const BUCKETS = [-18, -12, -6, -3, 0, 3, 8, 20, 50];
  const bucketOf = (el) => BUCKETS.reduce((b, v) => (Math.abs(v - el) < Math.abs(b - el) ? v : b), BUCKETS[0]);
  function matchFogToSky() {
    // The fog takes the colour the sky shows just above the horizon, read back from the canvas.
    const gl = renderer.getContext();
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const hc = new THREE.PerspectiveCamera(30, size.x / Math.max(1, size.y), 1, 20000);
    hc.rotation.order = 'YXZ';
    hc.position.set(0, 100, 0);
    const skyPos = sky.position.clone();
    sky.position.copy(hc.position);
    const hidden = [];
    for (const o of scene.children) if (o !== sky && o.visible) { o.visible = false; hidden.push(o); }
    const nu = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;         // no shadow pass for these renders
    // only the few pixels read back are drawn: a scissor round the centre of the canvas (the
    // next frame redraws the whole canvas)
    const pr = renderer.getPixelRatio(), hadScissor = renderer.getScissorTest();
    const oldScissor = renderer.getScissor(new THREE.Vector4());
    renderer.setScissorTest(true);
    renderer.setScissor(Math.floor(size.x / 2 / pr) - 8, Math.floor(size.y / 2 / pr) - 2, 16, 4);
    const px = new Uint8Array(4 * 8), acc = [0, 0, 0];
    let n = 0;
    for (let k = 0; k < 8; k++) {
      hc.rotation.set(THREE.MathUtils.degToRad(1.5), k * Math.PI / 4, 0);
      hc.updateMatrixWorld();
      renderer.render(scene, hc);
      gl.readPixels(Math.floor(size.x / 2) - 4, Math.floor(size.y / 2), 8, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 8; i++) { acc[0] += px[i * 4]; acc[1] += px[i * 4 + 1]; acc[2] += px[i * 4 + 2]; n++; }
    }
    renderer.setScissor(oldScissor);
    renderer.setScissorTest(hadScissor);
    renderer.shadowMap.needsUpdate = nu;
    for (const o of hidden) o.visible = true;
    sky.position.copy(skyPos);
    if (n && acc[0] + acc[1] + acc[2] > 0) {
      scene.fog.color.setRGB(acc[0] / n / 255, acc[1] / n / 255, acc[2] / n / 255, THREE.SRGBColorSpace);
      fogTable.set(bucketOf(state.elevation), scene.fog.color.getHex());
    }
    fogDirty = false;
    return '#' + scene.fog.color.getHexString(THREE.SRGBColorSpace);
  }
  function fogFromTable() {
    // while dragging: the nearest matched elevations, blended
    const el = state.elevation;
    let lo = null, hi = null;
    for (const b of BUCKETS) {
      if (!fogTable.has(b)) continue;
      if (b <= el && (lo === null || b > lo)) lo = b;
      if (b >= el && (hi === null || b < hi)) hi = b;
    }
    if (lo === null && hi === null) return;
    const a = new THREE.Color(fogTable.get(lo !== null ? lo : hi)), b = new THREE.Color(fogTable.get(hi !== null ? hi : lo));
    const t = lo !== null && hi !== null && hi > lo ? (el - lo) / (hi - lo) : 0;
    scene.fog.color.copy(a.lerp(b, t));
  }

  // ---------------------------------------------------------------- decoration by traversal
  let coverageErrors = 0;
  const kindErrors = new WeakSet();
  function decorate() {
    scene.traverseVisible((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let kind = null;
      for (const m of mats) {
        if (!isLit(m)) continue;
        if (kind === null) kind = meshKind(o);
        const had = decorated.get(m);
        if (had === kind) continue;
        if (had !== undefined) {
          if (!kindErrors.has(m)) {
            kindErrors.add(m);
            coverageErrors++;
            report(new Error('cw sun patch: one material is shared by meshes of kinds ' + had + ' and ' + kind + ' (' + o.name + ')'));
          }
          continue;
        }
        try { withSunShade(m, kind); } catch (err) { report(err); }
      }
    });
  }

  // ---------------------------------------------------------------- queries
  function inside(res, x, z) {
    const dx = x - res.cx, dz = z - res.cz;
    const r = Math.max(Math.abs(dx * res.wx + dz * res.wz), Math.abs(dx * res.px + dz * res.pz));
    return 1 - smooth(res.R - 22 * res.c, res.R - 2 * res.c, r);
  }
  function mAt(res, x, z, ch) {
    // as the GPU samples it: bilinear between texel centres, clamped at the edge
    const dx = x - res.cx, dz = z - res.cz;
    const N = res.n;
    const fk = Math.max(0, Math.min(N - 1, (dx * res.wx + dz * res.wz + res.R) / res.c - 0.5));
    const fa = Math.max(0, Math.min(N - 1, (dx * res.px + dz * res.pz + res.R) / res.c - 0.5));
    const k0 = Math.floor(fk), a0 = Math.floor(fa), k1 = Math.min(N - 1, k0 + 1), a1 = Math.min(N - 1, a0 + 1);
    const wk = fk - k0, wa = fa - a0;
    const g = (a, k, o) => fromHalf(res.m[(a * N + k) * ch + o]);
    const at = (o) => (g(a0, k0, o) * (1 - wk) + g(a0, k1, o) * wk) * (1 - wa) + (g(a1, k0, o) * (1 - wk) + g(a1, k1, o) * wk) * wa;
    return { M: at(0), D: ch === 2 ? at(1) : 0 };
  }
  function shadeAt(x, z, hAG = 1.5) {
    if (!cur.h1 && !cur.h5 && !cur.h20) return { lit: true, margin_m: Infinity, level: 'none', vis: 1 };
    if (state.gate && state.gateF <= 0) return { lit: false, margin_m: -Infinity, level: 'gate', vis: 0 };
    let v = 1, pick = null;
    for (const [name, ch] of [['h20', 1], ['h5', 1], ['h1', 2]]) {
      const res = cur[name];
      if (!res) continue;
      const w = inside(res, x, z);
      if (w <= 0) continue;
      const { M, D } = mAt(res, x, z, ch);
      const pen = name === 'h1' ? 0.3 + 0.00465 * D : 0.6 * res.c;
      v = v + (smooth(-pen, pen, hAG - M) - v) * w;
      if (w >= 0.5) pick = { level: name, margin: hAG - M };
    }
    if (!pick) return { lit: true, margin_m: Infinity, level: 'none', vis: v };
    const out = { lit: pick.margin > 0, margin_m: pick.margin, level: pick.level, vis: v };
    if (state.night) { out.lit = false; out.night = true; }
    return out;
  }

  // ---------------------------------------------------------------- the object
  const sun = {
    get night() { return state.night; },
    get rectsVersion() { return rectsVersion; },
    get enabled() { return !!site; },
    get zone() { return zone; },
    get year() { return year; },
    get site() { return site; },
    get garden() { return garden; },
    get profile() { return profile; },
    get monthly() { return monthly; },
    get box() { return box; },
    get lastRedraw() { return lastRedraw; },
    get quality() { return quality; },
    cw: cwSun,
    state,
    defaultUtc,
    // The sun the start pose is chosen for: always the default time, whatever ?t= says.
    defaultVector() {
      if (site && defaultUtc !== null) {
        const s = sunPosition(defaultUtc, site.lat, site.lon, altitude());
        return new THREE.Vector3(...sunVector(s.azimuth, s.elevation, offset));
      }
      const s = fixedSun();
      return new THREE.Vector3(...sunVector(s.azimuth, s.elevation, offset));
    },
    setTime(utc, q) { applySunTime(utc, q === 'drag' ? DRAG : quality); },
    settled() {
      // after a drag: a full sweep, and the fog matched to the sky
      if (!state.night) post('sun', quality);
      fogDirty = true;
      requestFrame();
    },
    utc() { return state.utc; },
    beforeRender() {
      if (disposed) return;
      lastRedraw = false;
      decorate();
      if (!state.night) {
        if (moveWindow(false)) post('window', quality);
        if (fitBox()) markShadowsDirty({ inFrame: true });
      } else if (rects.buildings || rects.trees) {
        setRects({ buildings: null, trees: null });
      }
      // at night nothing is redrawn, except the very first map, which every receiver needs
      if (state.night && sunLight.shadow.map) renderer.shadowMap.needsUpdate = false;
      lastRedraw = renderer.shadowMap.needsUpdate;
    },
    // Called by the page before it renders a frame (never from inside a render): the fog is
    // matched to the sky after a settled change, and follows the cached table while dragging.
    prepareFrame() {
      if (disposed || !fogDirty) return;
      if (state.dragging) { fogFromTable(); return; }
      matchFogToSky();
    },
    // Once every chunk has loaded: without beyond_world, derive the far gate from the world's
    // own horizon, and apply the time again with it.
    async onWorldLoaded() {
      if (beyond || !profile || !garden || derivedGate) return;
      await sun.deriveGate();
      if (!disposed) applySunTime(state.utc, quality);
    },
    // the h1 window for where the camera is now, without waiting for a frame (settle uses it)
    update() {
      if (disposed || state.night) return;
      if (moveWindow(false)) post('window', quality);
    },
    // true when the shade last uploaded was swept for the sun as it is now
    shadeFresh() { return shownSun !== null && shownSun === sunKey(); },
    onShade: null,                 // called after each sweep result is uploaded
    casterRects() { return state.night ? { buildings: null, trees: null } : { buildings: rects.buildings, trees: rects.trees }; },
    markShadowsDirty,
    addChunk,
    idle() { return new Promise((resolve) => { waiters.push(resolve); wake(); }); },
    jobIds() { return { requested, landed, posted, inflight: inflight ? inflight.id : null, pending: pending ? pending.id : null }; },
    // the last job id asked for when a chunk's heights reached the worker (a test hook)
    arrivalOf(level, key) { const v = arrivals.get(level + ':' + key); return v === undefined ? null : v; },
    shadeAt,
    march(points) {
      if (!site && state.utc === null && !state.dir) return Promise.resolve(null);
      return ask({ type: 'march', points, gridBearing: state.gridBearing, el: state.elevation,
                   gate: state.gate }).then((r) => r.points);
    },
    worldHorizon(x, z, eye = 1.5) { return ask({ type: 'horizon', x, z, eye }); },
    async deriveGate() {
      // no beyond_world in the facts: the world's own horizon at the garden point, and a gate
      // wherever the measured one stands more than 0.3 deg above it (design-sun-custom 2.4)
      if (beyond || !profile || !garden) return null;
      const r = await ask({ type: 'horizon', x: garden.x, z: garden.z, eye: 1.5 });
      derivedGate = r.profile_deg.map((w, k) => (profile[k] - w > 0.3 ? profile[k] : null));
      return derivedGate;
    },
    setQuality(q) {
      quality = q ? SUN_PROFILES[q] : base;
      ensureTextures(quality);
      moveWindow(true);
      if (!state.night) post('sun', quality);
      requestFrame();
    },
    setDebug(mode) { SU.cwSDebug.value = mode === 'split' ? 1 : 0; requestFrame(); },
    setDragging(on) { state.dragging = !!on; if (on) fogFromTable(); },
    fogColour() { return '#' + scene.fog.color.getHexString(THREE.SRGBColorSpace); },
    matchFog: matchFogToSky,
    coverage() {
      const out = [];
      scene.traverseVisible((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m, i) => {
          if (isLit(m) && decorated.get(m) === undefined) out.push(Array.isArray(o.material) ? o.name + '[' + i + ']' : o.name);
        });
      });
      return out;
    },
    bytes() {
      let page = 0;
      for (const k of ['h1', 'h5', 'h20']) if (cur[k]) page += cur[k].m.byteLength;
      return { workerBytes, pageBytes: page };
    },
    get coverageErrors() { return coverageErrors; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (debounce) clearTimeout(debounce);
      worker.terminate();
      for (const k of Object.keys(tex)) tex[k].dispose();
      sky.material.fragmentShader = skySource;
      delete sky.material.uniforms.cwSNight;
      delete sky.material.uniforms.cwSNightZ;
      sky.material.needsUpdate = true;
      sunLight.shadow.dispose();
      waiters.splice(0).forEach((f) => f());
    }
  };
  moveWindow(true);
  // No latitude and longitude, or no daytime tick to open at: there is no slider, and the
  // fixed sun from before the slider stays (the facts' sun-path sample nearest 235 deg).
  if (!site || defaultUtc === null) applySunTime(null, quality);
  return sun;
}

export { localParts, zoneLabel };
