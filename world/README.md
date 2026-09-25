# Commons World: the viewer

An explorable 3D world around one listing: walk or fly over the ground within about
10 km of a house, drawn from open map data. Near the house (1.5 km) the terrain is
Minecraft-like blocks from the 1 m height model, with trees, buildings and the plot
boundary; beyond that it is smooth and fades into haze. Click or tap the house for its
specs and, once computed, measured facts about the plot (slope, sun, walks).

The plan is `PLAN.md`, the data contract is `FORMAT.md`, and the pipeline that builds a
world is `pipeline/` (see `pipeline/SOURCES.md` for where its data comes from).

## Running it locally

The viewer needs a web server: modules, `fetch` and workers do not work from a
double-clicked `file://` page. From the repo root:

```
python3 -m http.server 8000
```

then open `http://localhost:8000/world/` for the synthetic test world, or
`http://localhost:8000/world/?w=out/<id>/` for a world you have built. `?w=` is a folder
inside `world/`; anything else is refused. There is no build step: `index.html` loads
three.js from `vendor/three/` through an import map, and nothing is fetched from anywhere
but the server it came from (no CDNs, fonts or map tiles).

## Building a world

Worlds are built by the pipeline into `world/out/<id>/`, which git ignores.

```
cd world/pipeline
python -m commons_world synthetic                     # world/out/synthetic, no network
python -m commons_world build --listing listing.json  # a real listing, world/out/<id>
python -m commons_world check ../out/<id>             # check a built folder
```

The listing file comes from the property tracker's exporter; `PLAN.md` section 8 says
what it may contain. Python 3.11 and `pipeline/requirements.txt`.

## Controls

| | Desktop | Phone or tablet |
|---|---|---|
| Look | click the view (pointer lock; Esc lets go), or drag | drag anywhere but the joystick |
| Move | W A S D or the arrow keys | the joystick, bottom left |
| Walk / fly | F, or the Fly button | the Fly button |
| Up, down (flying) | Space, Shift (or E, Q) | the Up and Down buttons |
| Jump, run (walking) | Space, Shift | |
| Specs | click the house, or the Specs button | tap the house, or Specs |

A click or tap picks the house only where it is actually seen: the ray is walked from the
eye to the house against the ground as drawn, so a click on a hill that hides it does
nothing (the house's label still shows through, as a locator, and opens the specs). With
the keyboard, the view is the first stop in the tab order and shows a focus ring inside
its edge; the Up and Down buttons also move while Enter or Space is held on them.

Walking keeps the eye 1.7 m above the ground, with gravity and an automatic step up of
at most 1.1 m. The ground height is read straight from the decoded heights, not by
raycasting: within 1.5 km the 1 m block top, beyond that the smooth surface exactly as
it is drawn at its current coarseness. Buildings are solid; the sea is walked on at 0 m.
Flying is kept at least 2 m (eye height) above that ground, and above the water plane
where no ground is known, including beyond the world's edge; nothing stops you flying
out past the edge. You start on the plot, just outside the house, facing it.

## What is drawn

- **Blocks within 1.5 km (h1).** Tops at the rounded height in 1 m steps, drawn in 1 m
  blocks near you and in 2 m and 4 m blocks further away:

  | | 1 m blocks | 2 m blocks | 4 m blocks |
  |---|---|---|---|
  | Phone (coarse pointer or narrow screen) | within 150 m | to 400 m | beyond |
  | Laptop | within 400 m | to 800 m | beyond |

  Distances are to the nearest point of each 240 m chunk; a chunk switches to coarser
  blocks only 40 m past a threshold, so it does not flicker. Where two chunks meet, the
  higher one's border wall reaches below anything the neighbour can draw at any block
  size. A chunk's one-sample apron cannot see a drop inside its neighbour's 4 m block, so
  once the neighbour is loaded the page compares the two and re-meshes the chunk if its
  wall stops short (`checkSeams` in `js/chunks.js`). Colours come from the
  land-cover band (forest, open land, bog, farmland, lake, built-up, road, footway,
  path, rock, snow, building footprint, sand), darker on steep ground, with earth-toned
  walls. Sea cells have no top: a flat water plane at 0 m shows there.
- **Smooth terrain beyond (h5 to 5 km, h20 to 11 km),** with a hole wherever a finer
  level covers, coarser grids further off, and skirts on every edge to hide cracks.
- **Trees** from `trees.bin`: real positions and heights, each standing on the block top
  drawn under it (re-set whenever its chunk changes block size, since a 4 m block's top is
  a mean and can sit several metres off the 1 m top). Whether one looks like a conifer or
  a broadleaf is decoration from a hash of its position, not species data. Where a coarse
  block is mostly sea, a tree on it stands on the water.
- **Buildings** from `buildings.json`, as flat-roofed prisms; the house is the warm one
  with a label. `ground` in the file is the median under the footprint, so on a slope
  the walls are taken down to the lowest ground any block size can draw around it,
  once the 1 m heights there are loaded.
- **The plot**: parcel cells tinted in the blocks, the boundary cells strongly, and a
  0.4 m fence along it. It is the registered parcel, drawn as approximate, and the specs
  panel says so with its accuracy class.
- **Sun and sky**: the sun sits where `facts.json` puts it on a mid-afternoon of 21 June
  (or at 235 degrees true, 38 degrees up, until facts exist), turned from true to grid
  bearing with the manifest's `grid_north_offset_deg`. Fog runs from 2.5 to 9.5 km in the
  colour of the sky at the horizon.

## Performance

Chunk files are refused, not drawn, when their header's cell size, corner, EPSG or size
disagrees with the manifest key they are listed under. The page title uses only approved
listing text, never the world's id (a property number). A screen reader hears when the
world has loaded or went wrong, not each chunk as it arrives.

Pixel ratio is capped at 1.5 on phones, frames are drawn only while something moves or
loads, nothing is drawn while the tab is hidden, and geometry is disposed when a chunk is
re-meshed or the page closes. Chunks are decoded and meshed in a pool of
`min(4, cores - 1)` module workers, nearest first; the Cache API keeps chunk files
(their names carry a content hash).

Measured in headless Chromium on the synthetic world, from the start pose (triangles
counted, not timed; software rendering says nothing about speed on a phone):

| Start view | Triangles drawn | Draw calls | Block zone, all h1 chunks |
|---|---|---|---|
| Phone, 390 x 844 | about 0.40 M | 70 | 0.57 M |
| Laptop, 1280 x 720 | about 0.60 M | 100 | 0.74 M |

The synthetic world is gentle and nearly half of it is sea. The real prototype, on steeper
ground, drew well over PLAN.md's phone rule of thumb of about 0.4 M from its start view;
its figures are kept out of this file because it is public. **Not decided:**
drawing the 4 m blocks in 4 m height steps (as the step 1 research proposed) would take
the synthetic world's phone block zone from 0.57 M to 0.28 M triangles, and adding 2 m
steps for 2 m blocks to 0.25 M. It changes how distant ground looks, so it is left at
1 m steps; `PROFILES` in `js/chunks.js` has a `steps` entry per block size for when it
is decided. If it is adopted, `lowestTop()` and `edgeFloor()` in `js/chunks.js` must
allow for a coarse top up to half a step below the lowest 1 m top, or building walls
float and seams open. No real phone has been tried.

## Files

| | |
|---|---|
| `index.html` | the page: canvas, overlays, styles, import map |
| `js/main.js` | loading the world, the scene, the render loop, `window.__cw` |
| `js/chunks.js` | chunks: worker pool, nearest-first queue, detail by distance, ground height |
| `js/worker.js` | CWH1 decoding and meshing; plain JavaScript that imports nothing |
| `js/objects.js` | trees, buildings, the plot fence |
| `js/controls.js` | walking, flying, pointer lock, touch |
| `js/panel.js` | the specs panel, measured facts and credits |
| `vendor/three/` | three.js r185.1, byte-identical to npm (`VERSION.txt`) |

Every file here is pure ASCII: non-ASCII characters are written `\uXXXX` in JavaScript
and `&#NNN;` in HTML.

## Tests

```
CW_PYTHON=/path/to/python-with-numpy node --test world/tests/viewer/viewer.test.mjs
```

from the repo root. The tests start their own `python3 -m http.server` on a free port,
build the synthetic world first if it is missing, and drive headless Chromium through
Playwright (installed globally, or findable by `npm root -g`; set
`PLAYWRIGHT_BROWSERS_PATH` if its browsers live elsewhere). They use the synthetic world
and the fixtures in `tests/viewer/fixtures/` only. They check: no console or page errors;
every chunk the manifest lists is loaded; loading starts under the camera; the JavaScript
decoder matches `commons_world.codec` sample for sample (`make_vectors.py` writes the
vectors); block and smooth faces wind outward; chunk seams have no gaps at any mix of
block sizes; clicking the house opens the specs; the plot tint matches the parcel's area
within 1% at 1, 2 and 4 m; credits show and fold; the view is not just sky; the sun uses
the grid north offset; walking lands on the block top; facts render from `facts.json`;
unknown versions and bad paths are refused readably; the phone layout has no sideways
scroll, and its Up and Down buttons work from the keyboard; a click where a hill hides the
house does not open the specs (the synthetic hill, found by walking sight lines), and a
mouse click shows no focus ring where Tab shows one inside the canvas edge; a chunk listed
under the wrong key is refused; the title never shows the world's id, and only the end of
loading is announced; blank BRA-e, TBA and freehold rows read "not stated"; trees stand on the drawn block top at every block size; a border wall reaches a
neighbour's floor, including a drop inside its 4 m block that loaded after it (a
synthetic chunk with a pit, served in place of the real one); every building wall
reaches the drawn ground (with one building's recorded ground raised 4 m); beyond the
blocks the ground under the camera is the surface as drawn; flying stays above the water
beyond the world's edge; no request leaves localhost; and these files are ASCII.

## Credits

On screen, in a corner that folds to an (i) button but is never removed: every string in
the world's `manifest.credits` (for Norway, Kartverket's data under CC BY 4.0, and the
place-name credit), plus three.js (MIT). The world's `NOTICE.txt` is linked from there.

## Publishing

Nothing under `world/out/` is ever committed: a built world is a precise location of
somebody's home. Whether and where worlds are published is decided separately
(`PLAN.md`, decisions D1 and D5).
