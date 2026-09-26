# Commons World: the viewer

An explorable 3D world around one listing: walk or fly over the ground within about
10 km of a house, drawn from open map data. Near the house (1.5 km) the ground is drawn
smooth from the 1 m height model and textured by land type from the map, with trees,
buildings and the plot boundary; beyond that it is coarser and fades into haze. The sun
and its shade follow a chosen date and time. Click or tap the house for its specs and,
once computed, measured facts about the plot (slope, sun, walks).

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
| Sun and time | T, or the sun chip at the bottom | the sun chip at the bottom |
| Earlier, later | Comma and Period: ten minutes (also while the mouse is captured) | the time slider in the sun panel |
| On a sun slider | PageUp, PageDown: an hour on the time slider, a week on the date slider | |

There is no Shift variant of the time keys: Shift already means run, and fly down.

A click or tap picks the house only where it is actually seen: the ray is walked from the
eye to the house against the ground as drawn, so a click on a hill that hides it does
nothing (the house's label still shows through, as a locator, and opens the specs). With
the keyboard, the view is the first stop in the tab order and shows a focus ring inside
its edge; the Up and Down buttons also move while Enter or Space is held on them.

Walking keeps the eye 1.7 m above the ground, with gravity. The ground is the surface
exactly as it is drawn, read from the heights the page holds, not by raycasting: within
1.5 km the triangles of the smooth 1 m ground as currently meshed, beyond that the
smooth surface at its current coarseness. A step is refused where the ground rises more
steeply than 50 degrees over it, so very steep ground cannot be climbed; onto a roof the
limit is instead a rise of 1.1 m. Walking downhill keeps the feet on the ground rather
than falling in hops, and the eye eases up a rise. Buildings are solid, and a sloped roof
is walked on as it is drawn; the sea is walked on at 0 m. Flying is kept at least 2 m
(eye height) above that ground, and above the water plane where no ground is known,
including beyond the world's edge; nothing stops you flying out past the edge. You start
on the plot, just outside the house, facing it.

## What is drawn

- **Ground within 1.5 km (h1).** Smooth ground on the 1 m height model's cell corners,
  as an adaptive triangulation per 240 m chunk (a right-triangulated irregular network
  in 16 m tiles, `js/worker.js`): near you the ground is kept to within 5 cm of the 1 m
  surface, and further away fewer triangles are drawn, but every point is guaranteed to
  be within a tolerance of the 1 m surface that grows with distance, about 2 CSS pixels
  on a phone and 1 on a laptop, so the error on screen stays about the same everywhere.
  A chunk is re-meshed when you have moved more than 16 m, or a quarter of its distance,
  since it was last meshed. Skirts hang below every chunk edge, deep enough to cover the
  difference to a neighbour meshed under the same refresh rule (after a long jump of the
  camera, a neighbour still meshed for the old position can leave a narrow slot on steep
  ground for the moment until its own re-mesh lands), and, where the next level begins,
  down below the lowest the h5 ground draws there, re-meshed when that h5 ground
  arrives. The ground is textured by land type from the map's class band (open land,
  forest, bog, farmland, lake, built-up, road, footway, path, rock, snow, sand; the
  ground under buildings is drawn as built-up), with borders between types blended
  rather than stepped in 1 m squares (up to four types on a laptop; two on a phone, the
  second as a flat colour across a narrow band), light from the 1 m surface's own
  slopes, and a wet band along the shore; lakes reflect a little of the sky. **Drawn,
  not measured:** bare rock where the ground is steep (from about 34 to 60 degrees,
  depending on the land type), and grain and bumps finer than a metre. The textures fade
  into the far colours between about 0.4 and 1.5 km (nearer on a phone), and the h5 and
  h20 ground uses the same far colours. Everything is generated in code; there are no
  image files. Sea squares have no ground: a flat water plane at 0 m shows there.
- **Smooth terrain beyond (h5 to 5 km, h20 to 11 km),** with a hole wherever a finer
  level covers, coarser grids further off, and skirts on every edge to hide cracks.
- **Trees** from `trees.bin`: real positions and heights, drawn at three levels of
  detail, each shaped so its width at half height is the measured crown; the nearest
  dozens are drawn in full. Each stands on the ground as drawn under it (re-set whenever
  its chunk is re-meshed). Whether a tree looks like a conifer or a broadleaf follows its
  measured crown and height where they are clear, and is not its species.
- **Buildings** from `buildings.json`, each drawn from its roof as fitted to the 1 m
  surface model: flat, mono-pitch, gable, hipped or pyramid, or two or three parts where
  one shape does not explain it. Where no shape fits well, or the fitted one would come
  down to the ground, the building keeps a flat top at the height the model gives it,
  plain, so "shape not measured" shows. On other buildings the outline is straightened
  along the ridge when that stays close to the measured cells and clear of the
  neighbours' footprints, the walls stand 0.4 m (0.15 m on flat roofs) inside the roof
  edge with a trim board, and the roofs have tile courses: all drawn. The listing house
  is drawn only as measured: its walls stand at the measured roof edge of its traced
  outline, with no trim and a plain roof, however uneven the fitted roof is; it is never
  cut into parts, so where no single roof shape fits it, it keeps the plain flat top.
  Walls have vertical boards everywhere; no building shows windows or doors, because
  where they are is not known. The house is the warm one with a label; its ochre and red
  are a highlight, not its real colours. `ground` in the file is the median under the
  footprint, so on a slope the walls are taken down to the lowest ground drawn anywhere
  in the 16 m tiles around the footprint, at any tolerance, once the 1 m heights there
  are loaded.
- **The plot**: a warm wash over the parcel and a line along its boundary, drawn on the
  ground in the shader from a signed-distance map (never thinner than about 0.3 m or a
  pixel), and a 0.4 m fence along it. It is the registered parcel, drawn as approximate,
  and the specs panel says so with its accuracy class.
- **Sun and sky.** The sun is placed for a chosen date and time: the chip at the bottom
  of the screen shows them, and opens a panel with a date slider (one year, the year the
  measured figures are for), a time slider (the site's own clock and zone, the whole
  day, night included) and Now, 21 Dec, 21 Jun and Noon. The world opens at 21 June,
  mid-afternoon; `?t=2026-12-21T12:00` (site time; a trailing `Z` means UTC) opens at
  another time, and the address follows the slider, in that same form, so a view can be
  shared. Nothing is remembered on the device. Without a latitude and longitude for the
  world there is no slider, and the sun stands where the measured sun path puts it on a
  June afternoon. Bearings are turned from true to grid with the manifest's
  `grid_north_offset_deg`.

  Shade from the ground is worked out from this world's own heights (1 m near you, then
  5 m and 20 m out to the edge of the world) in a background worker, for the chosen
  time. Mountains beyond the edge of the world are not drawn: where the measured horizon
  says they hide the sun, the whole view is shown in their shade and the sun disc is
  hidden. The shadows of trees and buildings are drawn from their drawn shapes, near you
  only, in one shadow map; they are never called measured. The panel keeps the two
  apart: "measured" lines come from the measured facts (clear sky, terrain only, at eye
  height at the garden point), "drawn" lines speak only about this world's heights.
  Light, sky colour and haze follow the sun's height, through twilight to a moonless
  night.

## Performance

Chunk files are refused, not drawn, when their header's cell size, corner, EPSG or size
disagrees with the manifest key they are listed under. The page title uses only approved
listing text, never the world's id (a property number). A screen reader hears when the
world has loaded or went wrong, not each chunk as it arrives.

Pixel ratio is capped at 1.5 on phones, frames are drawn only while something moves or
loads, nothing is drawn while the tab is hidden, and geometry is disposed when a chunk is
re-meshed or the page closes. Chunks are decoded and meshed in a pool of
`min(4, cores - 1)` module workers, nearest first; the workers hold nothing between jobs.
Finished meshes are installed at most 4 chunks or 150,000 triangles per frame on a phone
(8 or 400,000 on a laptop). The Cache API keeps chunk files (their names carry a content
hash). The terrain shade is swept in its own worker, and the object shadow map is redrawn
only when the sun, the objects near you or the place you stand change.

Measured in headless Chromium on the synthetic world, from the start pose at the opening
time (triangles counted, not timed; software rendering says nothing about speed on a
phone):

| Start view, synthetic world | h1 | h5 | h20 | Trees | Buildings | Main pass: triangles, draw calls | Shadow pass, 21 Jun 14:30 and 21 Dec 09:00 UTC | h1 held |
|---|---|---|---|---|---|---|---|---|
| Phone, 390 x 844 | 17,853 | 50,304 | 120,720 | 869 | 325 | 191,219 in 74 | 194 in 6; 212 in 6 | 69,380 |
| Laptop, 1280 x 720 | 29,007 | 92,784 | 158,160 | 971 | 325 | 282,395 in 104 | 194 in 6; 230 in 6 | 70,292 |

The first five columns count what is inside the view; the main pass is what the renderer
drew. Before this change the same views drew about 0.40 M and 0.60 M triangles, nearly
all of them blocks.

The synthetic world is gentle and nearly half of it is sea. PLAN.md's rule of thumb for a
phone is about 0.4 M triangles; the real prototype's start view is now under it, main
pass and shadow pass together, where before this change it was well over. Its figures are
kept out of this file because it is public. No real phone has been tried.

The same page over a scripted 600 m walk at 4.2 m/s, then a fly-up to 400 m and 1.5 km
out (synthetic world): no frame installed more than 4 chunks (59,446 triangles) on a phone
or 8 chunks (121,110 triangles) on a laptop; the h1 triangles held stayed near 70,000,
against caps of 250,000 and 600,000; the walk asked for about 2 chunk jobs a second and
the fly-up about 51; nothing went wrong, and no frame was drawn in the 3 s after either
ended or after the page settled. The terrain's textures come to about 30 MB on both
profiles, as the renderer counts them. The sun's memory (`stats().sun`) is 13.7 MB in the
worker and 4.6 MB on the page on a phone, and 22.3 MB and 13.7 MB on a laptop.

The terrain shade, timed in Node on one core of a quiet 4-core machine over four runs
(synthetic world): a full update takes 73-93 ms at phone quality and 208-222 ms at laptop
quality, and 40-50 ms while the slider is dragged; moving the 1 m window with you takes
11-15 ms on a phone and 44-45 ms on a laptop. The design allows 100 ms for a full update
on a phone and 40 ms while dragging, so the dragging figure sits at or just over its
allowance here.

If a phone turns out too slow, these are cut in this order, one named constant at a time,
re-measuring after each; the December shade, which comes from the terrain sweep, is kept
to the end:

1. the pixel ratio on phones, 1.5 to 1.25 (`PROFILES.phone.pixelRatio` in `js/chunks.js`);
2. the object shadow map on phones: trees cast only within 150 m, then a 512 px map, then
   none (terrain shade stays, and costs no triangles);
3. the ground's sub-metre bump and finest grain beyond 20 m;
4. the ground's normal texture on phones, lighting from the vertex normals instead, with
   the phone drawn at 1 px;
5. the sweep's quality on phones: coarser h5, a smaller 1 m window, h20 only on release;
6. the conservative error map (`errors: 'bound'`) on phones: cheaper to load, more
   triangles;
7. fewer near trees on phones;
8. the trim board on other buildings;
9. the phone's two-type border blend: only with Joseph's say, since he asked for blended
   borders;
10. a last resort, not recommended: error maps precomputed by the pipeline, which is a
    format change and bigger downloads.

## Files

| | |
|---|---|
| `index.html` | the page: canvas, overlays, the sun chip and panel, styles, import map |
| `js/main.js` | loading the world, the scene, the render loop, `window.__cw` |
| `js/chunks.js` | chunks: worker pool, nearest-first queue, the TIN's tolerance and refresh, install throttle, ground height |
| `js/worker.js` | CWH1 decoding, the h1 TIN (error maps, extraction, skirts, textures) and the smooth h5/h20 grids; plain JavaScript that imports nothing |
| `js/terrainmat.js` | the h1 ground's material: per-land-type textures, rock, the plot mark (a patched `MeshLambertMaterial`, one program) |
| `js/objects.js` | trees, buildings, the plot fence |
| `js/roofmesh.js` | building meshes from roof planes |
| `js/detailmaps.js` | the cladding and tile detail maps, drawn in code |
| `js/treegeo.js` | tree shapes and the look rule |
| `js/sun.js` | where the sun is (NOAA's equations, with the refraction the facts use) and the site's clock; imports nothing |
| `js/sunworker.js` | the terrain-shade sweep over the loaded heights, in a worker; imports nothing |
| `js/sunshade.js` | the terrain-shade textures and the material patch, the near shadow map, light, sky and fog |
| `js/sunui.js` | the sun chip, the date and time panel, and their keys |
| `js/controls.js` | walking, flying, pointer lock, touch |
| `js/panel.js` | the specs panel, measured facts and credits |
| `vendor/three/` | three.js r185.1, byte-identical to npm (`VERSION.txt`) |
| `tests/viewer/harness.mjs` | the shared test harness: server, browser, synthetic world, page helpers |
| `tests/viewer/viewer.test.mjs` | the viewer's tests |
| `tests/viewer/terrain.test.mjs` | the ground's tests: the TIN, seams, textures, walking |
| `tests/viewer/objects.test.mjs` | buildings and trees |
| `tests/viewer/sun.test.mjs` | the sun, shade, shadow and slider tests |

Every file here is pure ASCII: non-ASCII characters are written `\uXXXX` in JavaScript
and `&#NNN;` in HTML.

## Tests

```
CW_PYTHON=/path/to/python node --test --test-concurrency=1 world/tests/viewer/*.test.mjs
```

from the repo root. `CW_PYTHON` must have numpy, pandas and pvlib (the pipeline's
`requirements.txt`): the first test in `sun.test.mjs` runs `make_vectors.py --sun-out`;
the decoder vectors alone still need only numpy. The tests start their own
`python3 -m http.server` on a free port (`tests/viewer/harness.mjs`), build the synthetic
world first if it is missing, and drive headless Chromium through Playwright (installed
globally, or findable by `npm root -g`; set `PLAYWRIGHT_BROWSERS_PATH` if its browsers
live elsewhere). They use the synthetic world and the fixtures in `tests/viewer/fixtures/`
only. The whole run takes the best part of an hour on a busy four-core machine; the
shade-agreement test (ST5) sweeps 442 times and is the slowest.

`viewer.test.mjs` checks: no console or page errors or GL warnings; every chunk the
manifest lists is loaded; loading starts under the camera; the JavaScript decoder matches
`commons_world.codec` sample for sample (`make_vectors.py` writes the vectors); smooth
faces wind outward; h1 chunk seams are covered at every mix of tolerances; clicking the
house, its walls or its roof opens the specs; a click where a hill hides the house does
not (the synthetic hill, found by walking sight lines), and a mouse click shows no focus
ring where Tab shows one inside the canvas edge; the plot mark matches the parcel's area
within 1% and has a boundary line; credits show and fold; the view is not just sky; the
sun uses the grid north offset; walking lands on the drawn ground and stays on it going
downhill; facts render from `facts.json`; unknown versions and bad paths are refused
readably; the phone layout has no sideways scroll, and its Up and Down buttons work from
the keyboard; a chunk listed under the wrong key is refused; the title never shows the
world's id, and only the end of loading is announced; trees stand on the drawn surface at
every detail, the near set included; every building wall reaches the drawn ground (with
one building's recorded ground raised 4 m); the ground under the camera is the surface as
drawn, h1 included; flying stays above the water beyond the world's edge; leaving the page
frees every geometry and texture; no request leaves localhost; the chunk worker imports
nothing; and these files are ASCII.

`terrain.test.mjs` checks the ground: the TIN faces up and its skirts out; it stays
within its tolerance with either error map and has no T-junctions; a cliff on a chunk
edge is covered from both sides; land cover lands in the right place; the far palette is
one table; one terrain program per tier, with lights and shadows intact; moving
re-meshes only what it must; a stale reply never replaces a newer mesh; walls reach the
lowest drawn ground; the triangle and draw-call budgets per profile; texture memory; no
see-through cracks; h1 skirts hang below the h5 edge (also when that h5 chunk arrives late
and lower); the drawn horizon agrees with the world's own 1 m horizon, and with the
measured one where the world decides it; installs are throttled; terrain frees its GPU
memory; trees follow a coarse re-mesh; the slope limit (jumping included); the
held-triangle cap; installs while the tab is hidden; a chunk still loading when the view
changes is meshed again for the new view; and the ground's noise read at its own
footprint across land-type borders.

`objects.test.mjs` checks buildings and trees: closed, outward buildings; invented split,
stepped, traced, hipped, pyramid, shed, flat and unfitted roofs closed and meeting their
walls; the house drawn only as measured, and as the flat prism by one constant; wall tops
on the roof; the drawn roof is the measured roof; old and malformed files (a number that
is not finite, parts that do not chain, a roof below the walls); no openings; neighbours
after the house; walking on a roof; the ground each building carries for the sun; the
neighbours' colours; the tree near set, crown tie, look rule, level-of-detail hysteresis
and budget; shadow focus, its in-place partition and partial upload; the return values
that ask for a redraw; material kinds; and the fence.

`sun.test.mjs` holds the sun tests ST1-ST32: the sun against pvlib and against the
synthetic facts; the garden point's hours; the site's clock; the drawn terrain shade
against the facts at the garden point and over the 21 December plot map; the GPU drawing
what the CPU says; shadows visible; the slider by keyboard; the layout with the chip and
panel; a usable night; a clean console; the shadow budget; `settle()` waiting for the sun;
the far gate; the world-only horizon against the measured one; the start staying put;
every lit material shaded by the sun; no shadow work at night; late and failed chunks;
`?t=` and ASCII labels; the facts year; and, added after the reviews, casters across the
whole near shadow map, a far gate that only dims, a gate derived from the world, the near
map's redraw, T and the address, a world with no latitude or longitude, the open panel
following the sweep, the readout's lines, three's texture state after a sun upload, and
the 1 m window following the camera. Beside them it checks that every ground, building and
tree material is patched by its kind with the shadow flags as specified, and that trees
cast shadows on the drawn ground. Until the owner decides the evening light, the spec's
own ST8 (a shadow at 21 June 19:00 UTC below 0.85 of the lit ground) runs as a TODO test
beside ST8; it fails and is reported as TODO, which does not fail the run.

## Credits

On screen, in a corner that folds to an (i) button but is never removed: every string in
the world's `manifest.credits` (for Norway, Kartverket's data under CC BY 4.0, and the
place-name credit), plus three.js (MIT). The world's `NOTICE.txt` is linked from there.
No data source was added for the smooth ground, the roofs or the sun: the roof planes are
fitted to Kartverket's surface model, already credited, and every texture is generated in
code.

In the code: the h1 ground's RTIN triangle table is adapted from mapbox/martini, ISC
licence (its notice is kept in `js/worker.js`). The sun's position uses NOAA's equations,
with the refraction of NREL's SPA as pvlib applies it; the formulas were re-expressed, no
code was copied.

## Publishing

Nothing under `world/out/` is ever committed: a built world is a precise location of
somebody's home. Whether and where worlds are published is decided separately
(`PLAN.md`, decisions D1 and D5).
