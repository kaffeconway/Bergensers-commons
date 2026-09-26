/* Commons World: greyscale detail maps for building walls and roofs, drawn in code.
 *
 * Each map is one 256 x 256 tile, values 0.78 to 1.0, multiplied by the vertex colour
 * on a MeshLambertMaterial({vertexColors: true, map}). They are seeded, so every device
 * and every screenshot draws the same pixels, and no image file is shipped.
 *
 *   cladding  vertical boards, 1.6 m square: 8 boards of 0.2 m, a groove between them,
 *             a tone per board and a faint vertical grain (u = metres along the wall,
 *             v = height)
 *   tiles     roof tiles, 1.2 m across by 1.4 m down the slope: 0.30 m tiles in 0.35 m
 *             courses, staggered by half a tile, each course lighter at its top with a
 *             shadow line at its lower edge, a tone per tile (u along the contour,
 *             v down the slope, per face). A flat roof reads the same map with the tile
 *             stretched to 4 m square (u = x, v = z), which gives the seams of a sheet
 *             roof every 1 m (roofmesh.js TILE.flat).
 *
 * Nothing here is measured: the help text says the cladding and the tiles are drawn.
 */
import * as THREE from 'three';
import { hash2 } from './treegeo.js';

const SIZE = 256;
const LO = 0.78, HI = 1.0;

// numbers in [0, 1) from the position hash: the same on every device
function rng(seed) {
  let i = 0;
  return () => hash2(seed, i++);
}

function texture(values) {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const g = Math.round(255 * Math.max(LO, Math.min(HI, values[i])));
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = g;
    data[4 * i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;                    // three uses min(8, what the GPU offers)
  t.needsUpdate = true;
  return t;
}

/* Vertical boards: row y is height (v), column x runs along the wall (u). */
function cladding() {
  const r = rng(1601), v = new Float32Array(SIZE * SIZE);
  const boards = 8, w = SIZE / boards;
  const tone = Array.from({ length: boards }, () => 1 + 0.08 * (r() - 0.5));
  const grain = Array.from({ length: SIZE }, () => 1 + 0.04 * (r() - 0.5));
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const b = Math.floor(x / w), inBoard = x - b * w;
    const groove = inBoard < 2;
    v[y * SIZE + x] = groove ? LO : 0.93 * tone[b] * grain[x];
  }
  return texture(v);
}

/* Tiles: row y runs down the slope (v, flipY off), column x along the contour (u). */
function tiles() {
  const r = rng(1214), v = new Float32Array(SIZE * SIZE);
  const across = 4, courses = 4, tw = SIZE / across, ch = SIZE / courses;
  const tone = Array.from({ length: courses * across }, () => 1 + 0.1 * (r() - 0.5));
  for (let y = 0; y < SIZE; y++) {
    const c = Math.floor(y / ch), inCourse = y - c * ch;
    const shift = (c % 2) * tw / 2;
    for (let x = 0; x < SIZE; x++) {
      const xs = (x + shift) % SIZE, t = Math.floor(xs / tw), inTile = xs - t * tw;
      let g = 0.99 - 0.1 * (inCourse / ch);          // lighter at the top of each course
      g *= tone[c * across + t];
      if (inTile < 1) g = 0.84;                      // the gap between two tiles
      if (inCourse >= ch - 3) g = LO;                // the shadow at the course's lower edge
      v[y * SIZE + x] = g;
    }
  }
  const t = texture(v);
  t.flipY = false;
  return t;
}

let shared = null;
let users = 0;

/* The shared maps, made on first use: {cladding, tiles}. Each user calls release() once. */
export function detailMaps() {
  if (!shared) shared = { cladding: cladding(), tiles: tiles() };
  users++;
  return shared;
}

export function releaseDetailMaps() {
  if (!shared || --users > 0) return;
  shared.cladding.dispose();
  shared.tiles.dispose();
  shared = null;
  users = 0;
}
