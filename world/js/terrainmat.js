/* Commons World: the textured material of the h1 ground (within 1.5 km).
 *
 * Every h1 chunk gets its own MeshLambertMaterial from makeChunkMaterial(), patched with
 * onBeforeCompile, so three.js keeps its own lights, fog and shadow code. All of them
 * produce the same shader source per quality tier and share one program; what differs
 * per chunk (its class band and its 1 m normals) is in that material's own uniforms.
 * Materials are only ever made by the factory, never by clone(): Material.copy would
 * JSON-copy userData and would not carry the closure the patch lives in.
 *
 * What the patch draws, from data the chunk already carries:
 *   - the land-cover class of the 1 m band, as a procedural material per class (two
 *     colours and noise; nothing depicts an object that was not measured), with borders
 *     blended: a soft-max over up to four classes on a laptop, a two-class blend at the
 *     nearest texel border on a phone; a 0.45 m domain warp breaks the 1 m staircase;
 *   - light from the 1 m corner normals, so relief shows however coarse the triangles;
 *   - bare rock on steep ground by slope, per class (drawn, not measured);
 *   - bump and grain below 1 m (drawn), faded out before they could shimmer;
 *   - a fade to the far palette with distance, the colours h5 and h20 are drawn in;
 *   - lakes that reflect a little of the horizon colour, a wet band along the shore;
 *   - the plot: a warm wash inside and a line along its boundary, from a signed-distance
 *     texture.
 * No image files: the noise is generated here, everything else comes from the chunks.
 * GLSL identifiers all start with cwT (the sun patch uses cwS).
 */
import * as THREE from 'three';

export const PLOT_LIGHT = 0xe2bf93;    // parcel interior: a light warm wash
export const PLOT_STRONG = 0xb8552f;   // parcel boundary line

/* Per class code (index; 14 is slope rock): two sRGB colours a and b whose mean is the far
 * colour, an optional third colour c covering the share cMix of the ground in patches,
 * the far colour (what h5 and h20 draw; worker.js FAR repeats it), noise frequencies per
 * metre (broad, fine), contrast between a and b, bump strength, and the slope in degrees
 * at which bare rock starts to show (0: always rock; 90: never). Class 12 (building
 * footprint) is a copy of class 6 (built-up: paved, yards), so no darker rim shows where
 * a wall stands inside the traced footprint. */
export const TERRAIN_PALETTE = [
  { code: 0, name: 'open land', a: 0x8fa06b, b: 0xabb886, far: 0x9cab78, scale: 0.35, fine: 4, contrast: 1.0, bump: 0.10, onset: 34 },
  { code: 1, name: 'forest', a: 0x4b6340, b: 0x627a50, c: 0x6b5a40, cMix: 0.15, far: 0x566f48, scale: 0.5, fine: 3, contrast: 0.9, bump: 0.12, onset: 40 },
  { code: 2, name: 'bog, marsh', a: 0x7f855a, b: 0x9c9d72, c: 0x5f6848, cMix: 0.2, far: 0x8e9166, scale: 0.15, fine: 2, contrast: 1.0, bump: 0.05, onset: 45 },
  { code: 3, name: 'farmland', a: 0xa3ae66, b: 0xbcc482, far: 0xb0b974, scale: 0.08, fine: 2, contrast: 0.6, bump: 0.04, onset: 45 },
  { code: 4, name: 'lake, river', a: 0x5a8797, b: 0x5a8797, far: 0x5a8797, scale: 0.2, fine: 1, contrast: 0, bump: 0, onset: 90 },
  { code: 5, name: 'sea', a: 0x3d6878, b: 0x3d6878, far: 0x3e6b7c, scale: 0.2, fine: 1, contrast: 0, bump: 0, onset: 90 },
  { code: 6, name: 'built-up', a: 0xa9a393, b: 0xbfb9a9, far: 0xb4ae9e, scale: 1.0, fine: 3, contrast: 0.6, bump: 0.03, onset: 55 },
  { code: 7, name: 'road', a: 0x646059, b: 0x78746c, far: 0x6e6a63, scale: 3.0, fine: 9, contrast: 0.5, bump: 0.02, onset: 90 },
  { code: 8, name: 'footway', a: 0x9d9583, b: 0xb5ad9b, far: 0xa9a18f, scale: 2.0, fine: 6, contrast: 0.6, bump: 0.03, onset: 90 },
  { code: 9, name: 'path', a: 0x927a58, b: 0xae926c, far: 0xa08662, scale: 2.5, fine: 7, contrast: 0.8, bump: 0.08, onset: 90 },
  { code: 10, name: 'bare rock', a: 0x7a7972, b: 0x9e9d94, far: 0x8c8b83, scale: 0.6, fine: 3, contrast: 1.0, bump: 0.30, onset: 0 },
  { code: 11, name: 'snow', a: 0xe6e9e5, b: 0xf6f7f3, far: 0xeef0ec, scale: 0.3, fine: 1, contrast: 0.4, bump: 0.05, onset: 60 },
  { code: 12, name: 'building footprint (as built-up)', a: 0xa9a393, b: 0xbfb9a9, far: 0xb4ae9e, scale: 1.0, fine: 3, contrast: 0.6, bump: 0.03, onset: 55 },
  { code: 13, name: 'sand, gravel', a: 0xbaa87b, b: 0xd6c497, far: 0xc8b689, scale: 2.0, fine: 6, contrast: 0.9, bump: 0.15, onset: 50 },
  { code: 14, name: 'slope rock', a: 0x77746c, b: 0x9a978e, far: 0x88857d, scale: 0.5, fine: 3, contrast: 1.0, bump: 0.30, onset: 90 }
];

const SLOPE_ROCK = 14;
const lin = (hex) => new THREE.Color().setHex(hex);    // sRGB hex to the linear working space

// The rock onset as the up component of the normal (2: always rock).
function onsetCos(onset) { return onset <= 0 ? 2 : Math.cos(onset * Math.PI / 180); }
function smoothstep(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

// How much of class `code` is drawn as bare rock where the ground normal's up component is ny.
export function rockWeight(code, ny) {
  const p = TERRAIN_PALETTE[code] || TERRAIN_PALETTE[0], c = onsetCos(p.onset);
  return 1 - smoothstep(c - 0.06, c, ny);
}

// The far colour (linear [r, g, b]): the class's far colour mixed toward slope rock.
export function farColourLinear(code, ny) {
  const p = TERRAIN_PALETTE[code] || TERRAIN_PALETTE[0];
  return lin(p.far).lerp(lin(TERRAIN_PALETTE[SLOPE_ROCK].far), rockWeight(code, ny)).toArray();
}

// ------------------------------------------------------------------ noise
/* A 32-bit integer hash, written for this file: two rounds of multiply by an odd constant
 * and xor-shift. Uniform enough for value noise. */
function hash01(x, y, seed) {
  let h = Math.imul(x, 0x6c8e9cf5) ^ Math.imul(y, 0x3b9ac9a7) ^ Math.imul(seed, 0x2545f491);
  h = Math.imul(h ^ (h >>> 16), 0x7a3d9e2b);
  h = Math.imul(h ^ (h >>> 15), 0x4c1b8d67);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Tileable value noise on an N x N grid, `cells` lattice cells across, quintic fade.
function valueNoise(N, cells, seed) {
  const out = new Float32Array(N * N), per = N / cells;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < N; y++) {
    const gy = y / per, iy = Math.floor(gy), fy = fade(gy - iy);
    for (let x = 0; x < N; x++) {
      const gx = x / per, ix = Math.floor(gx), fx = fade(gx - ix);
      const x1 = (ix + 1) % cells, y1 = (iy + 1) % cells;
      const a = hash01(ix, iy, seed), b = hash01(x1, iy, seed), c = hash01(ix, y1, seed), d = hash01(x1, y1, seed);
      out[y * N + x] = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
  }
  return out;
}
// Rank-equalise to a uniform [0, 1], so a threshold at 1 - s covers exactly the share s.
function equalise(f) {
  const idx = Array.from(f.keys()).sort((i, j) => f[i] - f[j]), out = new Float32Array(f.length);
  for (let r = 0; r < idx.length; r++) out[idx[r]] = r / (idx.length - 1);
  return out;
}

/* RGBA8 256 x 256, tiling, mipmapped: R and G are two independent fields (a 16-texel
 * lattice plus a half-weight 8-texel one, equalised); B and A are the x and z slopes of a
 * third, finer field, for bump. One texture read gives all four. */
export function makeNoiseTexture() {
  const N = 256;
  const field = (seed, c0, c1) => {
    const a = valueNoise(N, c0, seed), b = valueNoise(N, c1, seed + 101), out = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = a[i] + 0.5 * b[i];
    return out;
  };
  const r = equalise(field(11, 16, 32)), g = equalise(field(23, 16, 32)), h = field(37, 32, 64);
  const dx = new Float32Array(N * N), dz = new Float32Array(N * N);
  let big = 1e-9;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      dx[i] = (h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N]) / 2;
      dz[i] = (h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]) / 2;
      big = Math.max(big, Math.abs(dx[i]), Math.abs(dz[i]));
    }
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(r[i] * 255);
    data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = Math.round(128 + 127 * dx[i] / big);
    data[i * 4 + 3] = Math.round(128 + 127 * dz[i] / big);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.name = 'cwT-noise';
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ shared uniforms
function paletteArrays() {
  const A = new Float32Array(48), B = new Float32Array(48), C = new Float32Array(48), F = new Float32Array(48);
  const MA = new Float32Array(64), MB = new Float32Array(64);
  TERRAIN_PALETTE.forEach((p, i) => {
    lin(p.a).toArray(A, i * 3); lin(p.b).toArray(B, i * 3); lin(p.c === undefined ? p.a : p.c).toArray(C, i * 3);
    lin(p.far).toArray(F, i * 3);
    MA.set([p.scale, p.fine, p.contrast, p.bump], i * 4);
    MB.set([onsetCos(p.onset), p.cMix || 0, p.code === 4 ? 1 : p.code === 5 ? 2 : 0, 0], i * 4);
  });
  return { A, B, C, F, MA, MB };
}
const PAL = paletteArrays();

/* The uniforms every chunk material shares: one {value} object each, so setting a value
 * here reaches every material. Per-chunk textures are in each material's own uniforms. */
export const SHARED = {
  cwTNoise: { value: null },
  cwTPlotSdf: { value: null },
  cwTPlotBox: { value: new THREE.Vector4(1, 1, 0, 0) },     // empty until the plot arrives
  cwTFade: { value: new THREE.Vector4(60, 600, 400, 1500) },
  cwTHorizon: { value: new THREE.Color(0xc9d6dc) },
  cwTColA: { value: PAL.A }, cwTColB: { value: PAL.B }, cwTColC: { value: PAL.C }, cwTFar: { value: PAL.F },
  cwTMatA: { value: PAL.MA }, cwTMatB: { value: PAL.MB }
};

export function ensureNoise() {
  if (!SHARED.cwTNoise.value) SHARED.cwTNoise.value = makeNoiseTexture();
  return SHARED.cwTNoise.value;
}
// fade: [detail fade start, end, far-colour fade start, end] in metres.
export function setFade(fade) { SHARED.cwTFade.value.set(fade[0], fade[1], fade[2], fade[3]); }
// The fog colour, by reference, so a later change of the fog shows on the lakes too.
export function setHorizon(color) { if (color && color.isColor) SHARED.cwTHorizon.value = color; }
export function setPlot(texture, box) {
  if (SHARED.cwTPlotSdf.value && SHARED.cwTPlotSdf.value !== texture) SHARED.cwTPlotSdf.value.dispose();
  SHARED.cwTPlotSdf.value = texture;
  if (box) SHARED.cwTPlotBox.value.set(box[0], box[1], box[2], box[3]);
  else SHARED.cwTPlotBox.value.set(1, 1, 0, 0);
}
// The shared textures that are alive, for terrainInfo().
export function sharedTextures() {
  return [SHARED.cwTNoise.value, SHARED.cwTPlotSdf.value].filter(Boolean);
}
export function disposeShared() {
  for (const t of sharedTextures()) t.dispose();
  SHARED.cwTNoise.value = null;
  SHARED.cwTPlotSdf.value = null;
  SHARED.cwTPlotBox.value.set(1, 1, 0, 0);
}

// ------------------------------------------------------------------ the patch
const glslColour = (hex) => { const c = lin(hex); return 'vec3(' + [c.r, c.g, c.b].map((v) => v.toFixed(6)).join(', ') + ')'; };

const VERT_DECL = `
varying vec2 vCwTCell;
varying vec3 vCwTWorld;
`;
const VERT_BODY = `
vCwTCell = position.xz;
vCwTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const FRAG_DECL = `
uniform sampler2D cwTClass;
uniform sampler2D cwTNormal;
uniform sampler2D cwTNoise;
uniform sampler2D cwTPlotSdf;
uniform vec4 cwTPlotBox;
uniform vec4 cwTFade;
uniform vec3 cwTHorizon;
uniform vec3 cwTColA[16];
uniform vec3 cwTColB[16];
uniform vec3 cwTColC[16];
uniform vec3 cwTFar[16];
uniform vec4 cwTMatA[16];
uniform vec4 cwTMatB[16];
varying vec2 vCwTCell;
varying vec3 vCwTWorld;
const vec3 cwTPlotLight = ${glslColour(PLOT_LIGHT)};
const vec3 cwTPlotStrong = ${glslColour(PLOT_STRONG)};
// One band-limited octave of the shared noise, centred on 0: one unit of p * cwTFreq is one
// lattice cell (16 texels); it fades out before a pixel covers half its wavelength.
vec4 cwTOct4(vec2 cwTP, float cwTFreq, float cwTMpp) {
  return (texture(cwTNoise, cwTP * (cwTFreq * 0.0625)) - 0.5) * clamp(1.5 - 2.0 * cwTMpp * cwTFreq, 0.0, 1.0);
}
float cwTOct(vec2 cwTP, float cwTFreq, float cwTMpp) { return cwTOct4(cwTP, cwTFreq, cwTMpp).r; }
// The class code at texel cwTT of mip level cwTL (texel q + 1 is cell q; 0 and 241 are the apron).
int cwTClassAt(ivec2 cwTT, int cwTL) {
  int cwTS = max(1, 242 >> cwTL);
  return int(texelFetch(cwTClass, clamp(cwTT, ivec2(0), ivec2(cwTS - 1)), cwTL).r * 255.0 + 0.5);
}
float cwTRock(int cwTC, float cwTNy) {
  float cwTOn = cwTMatB[cwTC].x;
  return 1.0 - smoothstep(cwTOn - 0.06, cwTOn, cwTNy);
}
vec3 cwTFarColour(int cwTC, float cwTNy) { return mix(cwTFar[cwTC], cwTFar[14], cwTRock(cwTC, cwTNy)); }
// A class's albedo from the broad (cwTN1) and fine (cwTN2) noise, both centred on 0.
vec3 cwTAlbedo(int cwTC, vec4 cwTN1, vec4 cwTN2, float cwTDetail) {
  vec4 cwTM = cwTMatA[cwTC];
  float cwTT = clamp(0.5 + cwTM.z * (1.6 * cwTN1.r + 0.8 * cwTDetail * cwTN2.r), 0.0, 1.0);
  vec3 cwTCol = mix(cwTColA[cwTC], cwTColB[cwTC], cwTT);
  float cwTMix = cwTMatB[cwTC].y;
  if (cwTMix > 0.0) cwTCol = mix(cwTCol, cwTColC[cwTC], smoothstep(0.46 - cwTMix, 0.54 - cwTMix, cwTN1.g + 0.5 * cwTN2.g));
  return cwTCol;
}
// Each class's own noise "height", for sharpening borders.
float cwTClassNoise(int cwTC, vec4 cwTN) {
  return 0.5 + 0.5 * sin(6.2832 * (cwTN.r + 0.6 * cwTN.g) + float(cwTC) * 2.4);
}
`;

const CLASS_PAIR_LAPTOP = `
  {
    // four texels round the warped point on the majority mip for this footprint; the
    // bilinear weights merged per class; each class scored weight + 0.35 (noise - 0.5); a
    // soft-max whose temperature rises with pixel size; the top two classes kept.
    float cwTS = exp2(float(cwTLod));
    vec2 cwTU = (cwTQ + 1.0) / cwTS - 0.5;
    ivec2 cwTT0 = ivec2(floor(cwTU));
    vec2 cwTF = fract(cwTU);
    int cwTCC[4] = int[4](cwTClassAt(cwTT0, cwTLod), cwTClassAt(cwTT0 + ivec2(1, 0), cwTLod),
                          cwTClassAt(cwTT0 + ivec2(0, 1), cwTLod), cwTClassAt(cwTT0 + ivec2(1, 1), cwTLod));
    float cwTWW[4] = float[4]((1.0 - cwTF.x) * (1.0 - cwTF.y), cwTF.x * (1.0 - cwTF.y), (1.0 - cwTF.x) * cwTF.y, cwTF.x * cwTF.y);
    int cwTCls[4] = int[4](0, 0, 0, 0);
    float cwTWt[4] = float[4](0.0, 0.0, 0.0, 0.0);
    int cwTNc = 0;
    for (int cwTI = 0; cwTI < 4; cwTI++) {
      bool cwTFound = false;
      for (int cwTJ = 0; cwTJ < 4; cwTJ++) {
        if (cwTJ < cwTNc && cwTCls[cwTJ] == cwTCC[cwTI]) { cwTWt[cwTJ] += cwTWW[cwTI]; cwTFound = true; }
      }
      if (!cwTFound) { cwTCls[cwTNc] = cwTCC[cwTI]; cwTWt[cwTNc] = cwTWW[cwTI]; cwTNc++; }
    }
    float cwTTemp = mix(0.03, 0.6, smoothstep(0.1, 2.0, cwTFw));
    float cwTSc[4] = float[4](0.0, 0.0, 0.0, 0.0);
    float cwTMx = -1e9;
    for (int cwTI = 0; cwTI < 4; cwTI++) {
      if (cwTI >= cwTNc) break;
      cwTSc[cwTI] = cwTWt[cwTI] + 0.35 * (cwTClassNoise(cwTCls[cwTI], cwTN0) - 0.5);
      cwTMx = max(cwTMx, cwTSc[cwTI]);
    }
    int cwTIa = 0;
    for (int cwTI = 0; cwTI < 4; cwTI++) {
      if (cwTI >= cwTNc) break;
      cwTSc[cwTI] = exp((cwTSc[cwTI] - cwTMx) / cwTTemp);
      if (cwTSc[cwTI] > cwTSc[cwTIa]) cwTIa = cwTI;
    }
    int cwTIb = -1;
    for (int cwTI = 0; cwTI < 4; cwTI++) {
      if (cwTI >= cwTNc) break;
      if (cwTI != cwTIa && (cwTIb < 0 || cwTSc[cwTI] > cwTSc[cwTIb])) cwTIb = cwTI;
    }
    cwTA = cwTCls[cwTIa];
    if (cwTIb < 0) { cwTB = cwTA; cwTTB = 0.0; }
    else { cwTB = cwTCls[cwTIb]; cwTTB = cwTSc[cwTIb] / (cwTSc[cwTIa] + cwTSc[cwTIb]); }
  }
`;

const CLASS_PAIR_PHONE = `
  {
    // the warped nearest texel (class A), and the one across its nearest border (class B),
    // which meets A at 50 % on the border and fades out a quarter texel inside A
    float cwTS = exp2(float(cwTLod));
    vec2 cwTU = (cwTQ + 1.0) / cwTS;
    ivec2 cwTTA = ivec2(floor(cwTU));
    vec2 cwTF = fract(cwTU);
    float cwTEx = min(cwTF.x, 1.0 - cwTF.x), cwTEz = min(cwTF.y, 1.0 - cwTF.y);
    ivec2 cwTDir = cwTEx < cwTEz ? ivec2(cwTF.x < 0.5 ? -1 : 1, 0) : ivec2(0, cwTF.y < 0.5 ? -1 : 1);
    cwTA = cwTClassAt(cwTTA, cwTLod);
    cwTB = cwTClassAt(cwTTA + cwTDir, cwTLod);
    cwTTB = cwTA == cwTB ? 0.0 : 0.5 * (1.0 - smoothstep(0.0, 0.25, min(cwTEx, cwTEz)));
  }
`;

function albedoBlock(tier) {
  const laptop = tier !== 'phone';
  return `
  // ---- the terrain's albedo (cwT)
  float cwTFw = max(max(length(dFdx(vCwTCell)), length(dFdy(vCwTCell))), 1e-4);   // metres per pixel
  float cwTDist = length(vViewPosition);
  float cwTDetail = 1.0 - smoothstep(cwTFade.x, cwTFade.y, cwTDist);
  vec2 cwTNxz = texture(cwTNormal, (vCwTCell + 0.5) / 241.0).rg * 2.0 - 1.0;       // 1 m corner normal
  vec3 cwTNW = vec3(cwTNxz.x, sqrt(max(0.0, 1.0 - dot(cwTNxz, cwTNxz))), cwTNxz.y);
  float cwTNy = cwTNW.y;
  vec4 cwTN0 = texture(cwTNoise, vCwTWorld.xz * (0.37 * 0.0625));                   // warp and class noise
  int cwTLod = int(clamp(floor(log2(max(cwTFw, 1.0))), 0.0, 7.0));
  vec2 cwTQ = vCwTCell + (cwTN0.rg - 0.5) * (0.9 * (1.0 - smoothstep(1.0, 4.0, cwTFw)));   // 0.45 m warp
  int cwTA = 0;
  int cwTB = 0;
  float cwTTB = 0.0;
${laptop ? CLASS_PAIR_LAPTOP : CLASS_PAIR_PHONE}
${laptop ? `
  vec4 cwTN1 = cwTOct4(vCwTWorld.xz, cwTMatA[cwTA].x, cwTFw);                                        // broad
  vec4 cwTN2 = cwTOct4(mat2(0.8, -0.6, 0.6, 0.8) * vCwTWorld.xz, cwTMatA[cwTA].y, cwTFw);            // fine, bump
  // rock noise on the plane along the contour and up, so it does not stretch on cliffs
  vec2 cwTCont = vec2(-cwTNW.z, cwTNW.x);
  float cwTContL = length(cwTCont);
  vec2 cwTRp = cwTContL > 0.05 ? vec2(dot(vCwTWorld.xz, cwTCont / cwTContL), vCwTWorld.y) : vCwTWorld.xz;
  vec4 cwTNR = cwTOct4(cwTRp, cwTMatA[14].x, cwTFw);
  vec3 cwTAlbA = cwTAlbedo(cwTA, cwTN1, cwTN2, cwTDetail);
  vec3 cwTAlbB = cwTAlbedo(cwTB, cwTN1, cwTN2, cwTDetail);
  float cwTRockW = mix(cwTRock(cwTA, cwTNy + cwTN1.g * 0.16), cwTRock(cwTB, cwTNy + cwTN1.g * 0.16), cwTTB);
  int cwTShore = cwTClassAt(ivec2(floor((vCwTCell + 1.0) * 0.25)), 2);
  float cwTNearWater = (cwTShore == 5 || cwTShore == 4 || cwTA == 5 || cwTB == 5) ? 1.0 : 0.0;
` : `
  vec4 cwTN1 = cwTN0 - 0.5;                                                                          // broad (shared)
  vec4 cwTN2 = cwTOct4(vCwTWorld.xz, cwTMatA[cwTA].y, cwTFw);                                        // fine, bump
  vec4 cwTNR = cwTN1;
  vec3 cwTAlbA = cwTAlbedo(cwTA, cwTN1, cwTN2, cwTDetail);
  // class B: its flat albedo, times the shared noise term; normals, bump and rock come from A
  vec3 cwTAlbB = 0.5 * (cwTColA[cwTB] + cwTColB[cwTB]) * (1.0 + cwTMatA[cwTB].z * 0.6 * cwTN1.r);
  float cwTRockW = cwTRock(cwTA, cwTNy + cwTN1.g * 0.16);
  float cwTNearWater = (cwTA == 5 || cwTB == 5 || cwTA == 4 || cwTB == 4) ? 1.0 : 0.0;
`}
  vec3 cwTAlb = mix(cwTAlbA, cwTAlbB, cwTTB);
  vec3 cwTRockAlb = mix(cwTColA[14], cwTColB[14], clamp(0.5 + cwTMatA[14].z * 1.6 * cwTNR.r, 0.0, 1.0));
  cwTAlb = mix(cwTAlb, cwTRockAlb, cwTRockW);
  // water: lakes and rivers lie flat and reflect a little sky (below); sea shows only on
  // shore triangles above 0 m
  float cwTLake = (cwTA == 4 ? 1.0 - cwTTB : 0.0) + (cwTB == 4 ? cwTTB : 0.0);
  // a wet band along the sea, and on land next to a lake
  float cwTWet = cwTNearWater * (1.0 - smoothstep(0.0, 0.4, vCwTWorld.y)) * step(0.0, vCwTWorld.y);
  if (cwTA != 4 && cwTB == 4) cwTWet = max(cwTWet, min(1.0, 2.0 * cwTTB));
  cwTAlb *= 1.0 - 0.3 * cwTWet * (1.0 - cwTLake);
  // sub-metre bump, fading out by footprint and distance
  float cwTBump = (1.0 - smoothstep(0.02, 0.12, cwTFw)) * cwTDetail * (1.0 - cwTLake) *
                  mix(cwTMatA[cwTA].w, cwTMatA[14].w, cwTRockW);
  cwTNW = normalize(cwTNW + cwTBump * 4.0 * vec3(-cwTN2.b, 0.0, -cwTN2.a));
  cwTNW = normalize(mix(cwTNW, vec3(0.0, 1.0, 0.0), cwTLake));
  // far away: the far palette, as h5 and h20 are coloured
  cwTAlb = mix(cwTAlb, mix(cwTFarColour(cwTA, cwTNy), cwTFarColour(cwTB, cwTNy), cwTTB),
               smoothstep(cwTFade.z, cwTFade.w, cwTDist));
  // the plot: a wash inside, a line along the boundary
  if (vCwTWorld.x >= cwTPlotBox.x && vCwTWorld.x <= cwTPlotBox.z && vCwTWorld.z >= cwTPlotBox.y && vCwTWorld.z <= cwTPlotBox.w) {
    float cwTSd = textureLod(cwTPlotSdf, (vCwTWorld.xz - cwTPlotBox.xy) / (cwTPlotBox.zw - cwTPlotBox.xy), 0.0).r;
    float cwTAa = max(cwTFw, 0.02);
    float cwTLw = max(0.3, 1.25 * cwTFw);
    cwTAlb = mix(cwTAlb, cwTPlotLight, 0.35 * (1.0 - smoothstep(-0.5 * cwTAa, 0.5 * cwTAa, cwTSd)));
    cwTAlb = mix(cwTAlb, cwTPlotStrong, 0.8 * (1.0 - smoothstep(cwTLw - 0.5 * cwTAa, cwTLw + 0.5 * cwTAa, abs(cwTSd))));
  }
  diffuseColor.rgb *= cwTAlb;
`;
}

const NORMAL_BODY = `
  normal = normalize((viewMatrix * vec4(cwTNW, 0.0)).xyz);
`;
const EMISSIVE_BODY = `
  totalEmissiveRadiance += cwTHorizon * 0.5 * pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 5.0) * cwTLake;
`;

function after(src, anchor, text) {
  if (!src.includes(anchor)) throw new Error('cw patch anchor missing: ' + anchor);
  return src.replace(anchor, anchor + '\n' + text);
}
function replace(src, anchor, text) {
  if (!src.includes(anchor)) throw new Error('cw patch anchor missing: ' + anchor);
  return src.replace(anchor, text);
}

/* The patch. u holds the material's own uniforms (its chunk's two textures); the shared
 * ones come from SHARED. The source depends only on the tier, which is in the program's
 * cache key. */
export function patchTerrain(shader, u, tier) {
  Object.assign(shader.uniforms, SHARED, u);
  let vs = shader.vertexShader, fs = shader.fragmentShader;
  vs = after(vs, '#include <common>', VERT_DECL);
  vs = after(vs, '#include <project_vertex>', VERT_BODY);
  fs = after(fs, '#include <common>', FRAG_DECL);
  fs = replace(fs, '#include <color_fragment>', albedoBlock(tier));
  fs = after(fs, '#include <normal_fragment_begin>', NORMAL_BODY);
  fs = after(fs, '#include <emissivemap_fragment>', EMISSIVE_BODY);
  shader.vertexShader = vs;
  shader.fragmentShader = fs;
}

/* A new material for one h1 chunk, every call (a factory, never clone()). Nothing goes in
 * userData: the uniforms live in the closure. */
export function makeChunkMaterial({ classTex, normalTex }, tier) {
  const t = tier === 'phone' ? 'phone' : 'laptop';
  ensureNoise();
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.toneMapped = false;
  const u = { cwTClass: { value: classTex }, cwTNormal: { value: normalTex } };
  m.onBeforeCompile = (shader) => patchTerrain(shader, u, t);
  m.customProgramCacheKey = () => 'cwT1-' + t;
  m.name = 'cwT-chunk';
  return m;
}
