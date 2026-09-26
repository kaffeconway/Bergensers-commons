# Commons World: the plan

An explorable 3D world around each Bergensers Commons listing. The step 1 plan was written
on 24 Sept 2026 and reviewed by Joseph. This version, of 25 Sept, records what changed
once work began: robots.txt ruled out OpenStreetMap, the first prototype sold, and step 2
(the pipeline) is built. The HD pass of 26 Sept (smooth textured ground, measured roofs,
fuller trees, and the sun with a date and time slider) is recorded in D16, D17 and
sections 4, 5, 10 and 11.

Figures are marked as one of:
- **measured:** fetched, run or read at the source;
- **computed:** worked out from measured inputs;
- **estimate:** anything else.

This file is public. It holds no group scores, no group finances, no assessment of any
listing, and nothing that places a listing on the map. Those go to Joseph directly.

---

## 0. Decisions

### Taken on 25 Sept 2026 ("Run your plan. Keep it safe. Read robots.txt")

| # | What was done | Why |
|---|---|---|
| D1, D5 | **Nothing is published.** No data repo exists, nothing is merged to `main`, and built worlds stay in `world/out/`, which git ignores | Publishing a world waits for an explicit yes |
| D2 | Stored levels 1 m / 5 m / 20 m | The recommendation, within the brief's 10–20 m |
| D3 | The plot drawn is the registered parcel only, with a note when the listing states a different area | The recommendation |
| D4 | The specs panel gets whole-property cost if owned outright; no per-person figures, targets or group scores | The recommendation |
| D6 | No LICENSE file is added; that choice stays with Joseph. The vendored three.js keeps its MIT licence | Not the editor's call |
| D7 | **No OpenStreetMap at all.** Norway is built from Kartverket's open data only (section 2) | robots.txt: `overpass-api.de` disallows `/api/`, and both extract hosts disallow `*.pbf`. So no ODbL applies either |
| D9 | Vertex colours. **Superseded by D16** | The recommendation |
| D11 | No cloudiness line, and no automated PVGIS cross-check | `re.jrc.ec.europa.eu` disallows all robots. Joseph downloaded two PVGIS horizon profiles by hand, which are used as a local check only |
| - | **The prototype changed.** The first prototype and the next choice both sold. The prototype is now a live Vestland listing that Joseph confirmed is still for sale | A world of a sold house helps nobody |

### Taken on 25 Sept 2026, before the HD pass (asked, and answered by Joseph)

| # | What was done | Why |
|---|---|---|
| D16 | **Built-in materials, patched.** The world keeps three.js's built-in Lambert and Phong materials, but the h1 ground's textures and the sun's terrain shade are `onBeforeCompile` patches on them (`js/terrainmat.js`, `js/sunshade.js`). Replaces D9. A later move to WebGPU would need these patches ported | Joseph chose smooth ground textured by land type, and real shadows with a date and time slider. Neither can be built with vertex colours or unpatched materials. Asked first (A1); he said proceed |
| D17 | **The listing house is drawn only as measured.** Its roof is drawn as fitted to the surface model (an off-centre ridge stays off-centre); its walls stand at the measured roof edge (no overhang), on its traced outline; no trim board; a plain roof in the highlight colour. Each is one constant. (Other buildings get a drawn overhang, trim, tile courses and straightened outlines; those are built as defaults and wait for his look, D18) | Joseph's choice of "nothing on the listing house is made up", asked part by part (A2); he took the conservative answer for all five |

### Still open

| # | Decision | Step | Recommendation |
|---|---|---|---|
| D1 | **Where built worlds would live**, if published | before publishing | A separate public repo, `kaffeconway/commons-world-data`, with its own GitHub Pages site, published as one squashed commit (section 6) |
| D5 | **What gets published, and for how long.** A world is by construction a precise location of somebody's home, and publishing one per listing publishes the group's shortlist | before publishing | An allow-list Joseph approves, and a world taken down when its listing sells. CLAUDE.md's "no specific home locations for anyone" covers sellers as written, so adopting this means rewording that rule |
| D6 | **Licences**: code licence, and the data notice | before publishing | Code: MIT or similar. Data: CC BY 4.0 attribution to Kartverket, carried in every world's `NOTICE.txt` and on screen |
| D8 | The brief mentioned "two corrections to CLAUDE.md" but listed one (GitHub Pages), which was already there | - | What was the second? |
| D10 | **How far you can see.** Fog fades the world out before its 10 km edge, so distant mountains are not drawn. Since the HD pass, where the measured horizon says mountains beyond the edge hide the sun, the view is shown in their shade and the sun disc is hidden, but no silhouette of them is drawn | 3 | Fog on phones. On laptops, a coarse horizon ring out to ~30 km at ~100 m, roughly 0.3 to 0.5 MB (estimate) |
| D11 | **Which sun figure the panel leads with**: plot median or a garden point; terrain only or with trees and buildings | 4 | Lead with the plot median, terrain only, with the with-trees figure beside it |
| D12 | **Italy terrain.** The brief named Copernicus DEM, a 30 m *surface* model that reads 3.5–7.9 m above the ground on average at the sites tested | 5 | Regione Piemonte's 5 m ground model where it covers, TINITALY 10 m elsewhere, and Copernicus only as a last resort, with its required notice |
| D13 | The link from `index.html`, and the hub map's base layer | 5 | Decide then. A world cannot open from a saved copy the way `index.html` can |
| D14 | **Phone triangle budget.** Before the HD pass the real prototype's phone start view drew well over the ~0.4 M rule of thumb. The HD pass replaced the blocks with smooth ground: on the synthetic world the phone start view now draws about 191 k triangles in 74 draw calls, plus about 0.2 k in the shadow pass (laptop: about 282 k in 104 calls), and the real prototype's phone start view is under the rule, main and shadow pass together. These are counts from a headless browser; no phone has been tried | before approval | Try it on a real phone first. If it stutters, apply the cut order in README (Performance) one step at a time, re-measuring after each; the step that turns off the phone's blended borders needs Joseph's say |
| D15 | **Small visible choices made in steps 3-4**: the house label shows through hills as a locator; a peak whose named point has no distinct top is reported as "short of the named point"; a summit found more than 50 m from its named point is flagged on the panel | before approval | Keep; each is one line to change |
| D18 | **Visible choices built with a default in the HD pass**, each one named constant. Ground: the colours per land type; bare rock drawn by slope (34 to 60 degrees by type); sub-metre bumps, grain and a wet shore band; lakes reflecting a little sky; textures stopping at 1.5 km; the distant-ground tolerance (2 px phone, 1 px laptop); the plot's 35% wash and 80% line; the 50 degree walking limit; two-type borders on a phone; the ground under buildings drawn as built-up. Buildings: neutral neighbours with a small lightness jitter; a 0.4 m overhang (0.15 m on flat roofs) and a trim board; board cladding and tile courses; straightened outlines, kept clear of neighbours (round buildings become polygons); a plain flat top where no roof fits; a 1.5 m plausibility clearance; an L- or T-shaped listing house kept whole. Trees: the conifer or broadleaf look from the measured shape. Light and time: opening at 21 June mid-afternoon; the local clock and one facts year; the chip and panel; the time keys; the shadow map on phones; the softer daylight, under which low evening sun leaves faint object shadows; untoned colours; what the panel calls measured and drawn | before approval | Joseph to look at each in the screenshots; each is one line to change |

---

## 1. How this was checked

- **Research, before step 1:**
  - Nine research passes, each in a scratch folder.
  - Three review passes checked the plan against that evidence.
- **Before step 2 was built:** robots.txt was read for every host (`pipeline/SOURCES.md`).
- **Step 2 build:**
  - Built by agents working to `FORMAT.md`.
  - Two independent reviewers checked it for safety and privacy, and for correctness.
  - Every confirmed finding was fixed and has a test.
- **Listing data:** comes only through the tracker's exporter (section 8). The spreadsheet
  on Joseph's Mac is not needed.
- **Sprawl Fjord Sim:** the Mac zip was not visible. The Drive copy and the uploaded
  single-file version were reviewed instead (section 9).

---

## 2. Data sources

### 2.1 Norway: Kartverket's open data

The pipeline refuses any host not listed in `pipeline/SOURCES.md` and enforces robots.txt
at run time. Everything below is CC BY 4.0, credited "© Kartverket".

| Data | Service |
|---|---|
| Address to coordinates and property number | `api.kartverket.no/adresser/v1` |
| Registered parcel (teig) geometry, and its stored area | `api.kartverket.no/eiendom/v1`; area from the teig WFS on `wfs.geonorge.no`. Geometry and areas only; owner data is never requested |
| Terrain (DTM) and surface (DOM), 1 m national model | `hoydedata.no` ImageServer `exportImage`. The pipeline tiles requests at ≤ 3000 px |
| Coarser terrain | the same service: 5 m is fetched at 2.5 m and averaged 2 × 2, 20 m is the server's own bilinear output (see `FORMAT.md` §2 for why) |
| Land cover, water, coast | N50 Kartdata, via the Geonorge download API, for every municipality the disk touches |
| Roads, footways, paths | NVDB Vegnett Pluss (monthly), via the same download API |
| Building points (type code, building number) | Matrikkelen building-point WFS |
| Trails | Turrutebasen WFS |
| Named peaks and places | `api.kartverket.no/stedsnavn/v1`; heights sampled from the terrain |

**Not used:**
- **Aerial photos (Norge i bilder):** restricted, so ground colour is procedural. Checked
  again on 25 Sept 2026 (research only, no code): every form of it is still a licensed
  product (its map services and downloads are for Norge digitalt members; only credited
  screenshots of the website are free to use), and Norway has no open aerial imagery
  finer than Sentinel-2's 10 m. Sentinel-2 is open and needs no key, but at 10 m it could
  only tint the distance; whether to do that is a look decision not yet asked, and it
  would be a new source. For step 5, France's IGN BD ORTHO (20 cm, Licence Ouverte) is
  usable; Italy's orthophotos are unverified.
- **FKB building footprints:** restricted. Footprints are segmented from the surface
  model instead (section 4).
- **DTM10 in UTM 32:** its licence is CC BY-NC; the resampled 1 m model replaces it.
- **Seabed depth:** the sea is drawn flat.

### 2.2 France, Italy, Spain (step 5; tested, not yet built)

**France.**
- **Terrain:** IGN's LiDAR HD ground model at 0.5 m (Géoplateforme WMS-R). It covers the
  full 10 km radius around every tracked listing.
- **Parcels and addresses:** Parcellaire Express and API Carto for parcels; the
  Géoplateforme geocoder for addresses.
- **Licence:** Licence Ouverte 2.0.
- **Check first:** robots.txt for those hosts must be read before any is added to the
  allowlist.

**Italy.**
- **Terrain:** the Piemonte 5 m LiDAR ground model (CC BY 4.0), or TINITALY 10 m.
  Copernicus GLO-30 is a surface model, too coarse for a plot.
- **Parcels:** the Agenzia delle Entrate bulk download (the WFS was blocked from here).
- **Check first:** robots.txt, before use.

**Spain** (only if a listing appears there). IGN 5 m terrain. The Catastro's parcels are
not openly licensed.

The French and Italian listings give commune-level addresses only, so step 5 needs another
way to place the actual house.

---

## 3. Coordinates

- **Grid.** Each place is processed in its country's grid (EPSG:25832 for Vestland). There
  is no reprojection of source data.
- **Viewer frame.** Metres from the geocoded address point:
  - x east, y up, z south.
  - Float32 keeps millimetre precision at 10 km.
- **True north.** Grid north differs from true north by a few degrees in western Norway:
  about +3.4° of grid bearing, varying with longitude. The manifest records the exact value
  per place, and the sun and compass use it. A test pins the sign.
- **Heights.** NN2000 in Norway (sea at 0 m).

---

## 4. Level of detail and chunks

The full contract is `FORMAT.md`. In short:

| Level | Resolution | Covers | Chunk |
|---|---|---|---|
| h1 | 1 m | 1.5 km from the house | 240 m (240 x 240 samples, plus a one-sample apron) |
| h5 | 5 m | 5 km | 1,200 m |
| h20 | 20 m | 10 km, plus ~1 km margin | 4,800 m |

- **Chunk files.** Heights are stored as int16 decimetres, run through a planar predictor
  and gzipped. A land-cover class band rides along in the same file.
- **Sea chunks.** Chunks that are all sea are not stored.
- **File names.** Each carries a content hash, so a republish re-downloads only what
  changed.

**Drawing.** Since the HD pass (26 Sept) there are no blocks. The 1 m data is kept
everywhere inside 1.5 km and drawn as smooth ground: an adaptive right-triangulated
irregular network (RTIN) per 240 m chunk, in 16 m tiles, meshed in the workers from an
exact error map. Near the walker it stays within 5 cm of the 1 m surface; further out the
allowed error grows with distance so that it stays about 2 CSS pixels on a phone and 1 on
a laptop, which is what keeps the triangle count down. Chunks are re-meshed as the walker
moves, with skirts under every edge. The ground is textured by land type in a patched
material (D16), with slope rock and sub-metre detail drawn, not measured.

Beyond 1.5 km the terrain is smooth tiles from h5 and h20, with skirts to hide cracks, and
fog.

**On the terrain** (all from Kartverket data):
- **Trees within 1.5 km.** Real positions and heights, from local peaks in surface height
  minus ground height, with building footprints masked out.
- **Buildings.** Roof areas are segmented from the surface model and anchored to register
  points, with heights measured. One is marked as the house. Since the HD pass, roof
  planes (flat, mono-pitch, gable, hipped, or split into parts) are fitted to the same
  surface model; where none fits, the roof is drawn flat and plain.
- **Roads, paths, water, land cover.** From the class band.
- **Plot boundary.** The registered parcel, drawn as approximate: its accuracy class is
  published with it.

---

## 5. Viewer (step 3)

**Technology.** three.js r185.1 with the plain WebGL renderer: vendored in
`world/vendor/three/` and byte-identical to npm (checked by hash), with no build step.
Built-in materials, with `onBeforeCompile` patches for the ground's textures and the sun's
terrain shade (D16), so a later move to WebGPU would need those patches ported. Babylon.js, CesiumJS,
MapLibre, deck.gl and PlayCanvas were compared and set aside; see the step 1 research.

**Controls.**
- **Desktop:** pointer lock and WASD, with a key to toggle flying.
- **Phone:** thumb joystick and drag-to-look. iOS has no pointer lock.

**Phone budgets** (rules of thumb):
- about 0.4 M triangles;
- 100–200 draw calls;
- pixel ratio capped at 1.5;
- no rendering while nothing moves.

**It needs a server.** The world will not open from a double-clicked file: modules,
fetch and workers are blocked on `file://` (verified in Chromium). Locally, run
`python3 -m http.server`.

**Style.** It follows CLAUDE.md: forced light colour scheme, the sage-and-paper palette,
`:focus-visible` rings, and credits in a corner that collapse to an (i) button but are
never hidden.

---

## 6. Storage and size

### 6.1 Measured on the first real build (25 Sept)

| Part | Bytes |
|---|---|
| Height chunks, all three levels, with the land-cover band (220 files) | 5.94 MB |
| trees (21 thousand) | 0.15 MB |
| buildings (1.3 thousand) | 0.10 MB |
| manifest, places, notice, listing, plot | 0.12 MB |
| **Total, 227 files** | **6.31 MB** |

- **Against the step 1 estimate of about 7 MB:** the OpenStreetMap layer the estimate
  included no longer exists, and the land-cover band costs 0.57 MB.
- **That site was coastal.** A steep inland site should come out some 15–20% larger
  (estimate).
- **Planning figure:** 10 MB per listing.
- **Cost of a first build** (the pipeline's cache, never published): about 5 minutes,
  113 requests and 202 MB downloaded, for all three levels, the surface model, N50,
  NVDB, trails, building points and place names.

### 6.2 Where built worlds would live, if published (D1)

**Recommended:** a separate public repo, `commons-world-data`, served by GitHub Pages at
the same address as the app. It needs no CORS setup, no keys and no card. It would be
published as one squashed commit, so the repo holds one copy and a takedown is real.

At 10 MB per listing, GitHub's 1 GB site limit holds about 80 worlds.

**Ruled out:**
- `world/data/` in this repo: this repo's history is permanent.
- Git LFS: GitHub Pages cannot serve it.
- Release assets: they send no CORS header.
- One big file read in slices: Firefox mis-decodes slices of Pages' gzipped responses.

---

## 7. Measured facts (step 4)

The pipeline computes these in Python; the browser only shows them. Each figure carries
its method, and the format is `FORMAT.md`'s `facts.json`.

**Slope and flat ground on the plot.**
- Horn's method on the 1 m terrain, raw and 3 × 3 m smoothed.
- Buildings and water excluded.
- Area by slope band, and NIBIO's 1:5 and 1:3 farmland ratios.
- The largest connected patch under 5° and under 10°, and the largest circle that fits in
  it.

**Sun hours.**
- **Sun position:** NREL's algorithm (pvlib).
- **Horizon:** rays every 0.5° of true bearing. 1 m terrain to 200 m, 10 m to 10 km, then
  coarser out to where no terrain in the region could still rise 0.25° above the horizon
  (90–220 km in mountains). Earth curvature and refraction are included.
- **Outputs:** clear-sky potential hours for 21 Dec, the Dec–Jan average, 21 Jun and each
  month, for terrain only and with trees and buildings.
- **Weather** is not included, and the panel says so.

**Peaks and trailheads.**
- Named peaks from Kartverket's place names, with heights from the terrain. The coarse
  levels flatten summits, so each shortlisted peak is re-measured on fresh 1 m data: the
  summit is the highest ground reachable from the named point without dropping more than
  2 m that is also a top (highest within 20 m all round). If there is none within 30 m,
  the panel says the name marks no distinct top, and a summit found over 50 m from its
  named point is flagged.
- Trailheads derived from where paths leave roads, parking and Turrutebasen route ends.
- Walking routes on NVDB footways, paths and roads, plus Turrutebasen. Climb comes from
  the terrain, time from Naismith and from Tobler's hiking function.
- "Real access" means the path network reaches within 50 m and 20 m of height of the
  summit.

**Tests.** Known answers:
- a flat plane gives 0°, a 10% ramp 5.71°;
- a synthetic wall and cone;
- solar noon at a fixed synthetic point, and the sun's position over a year against an
  independent implementation of NOAA's equations (a MET Norway cross-check is not
  written: `api.met.no` is not on the allowlist);
- routing on a toy graph.

---

## 8. Listing data: one way out of the private tracker

**How.** `tools/export_world.py` in the private tracker writes the only listing record a
world reads (`schema/listing.schema.json`). It fails closed:
- Every field must be classed.
- Free text crosses only as a string approved in `world_public/<slug>.yml`.
- Costs are whole-property, owned outright, from the tracker's cost model on generic
  assumptions.
- A leak check refuses agent names, handles, reference numbers, per-person money, scores
  and notes-only words, even inside an approved string.
- It writes only where git ignores the output.

**Addresses.** Joseph's brief of 24 Sept allows listing addresses to be public. The
approvals record that, address by address.

**Condition.** The only condition data is the group's own provisional score, which is
not listing data. The panel shows the build year and "condition report: not stated"
until one is recorded.

---

## 9. Sprawl Fjord Sim

Very little carries over: neither version has real geography, chunking or first-person
controls. What is kept:
- **the idea of seeding by position:** an integer coordinate hash, so every device puts the
  same tree in the same place;
- **a few patterns from the Drive version:** instanced meshes with per-copy colour, a
  draped strip for the plot line, a background-worker wrapper, and polyline helpers.

Its `noise.js` has no licence notice, so three.js's credited SimplexNoise addon, seeded,
replaces it.

---

## 10. Steps

| Step | Status |
|---|---|
| 1. Plan | Done, 24 Sept |
| 2. Pipeline for one listing | **Built 25 Sept.** 409 tests (network tests separate). The first real build is described in 6.1. Committed to the working branch, not `main` |
| 3. Viewer | **Built 25 Sept.** Walk and fly, blocks near and smooth far with no cracks at any level boundary, plot line, house and specs panel, facts, credits, phone controls. 30 headless Playwright tests on the synthetic world (decoder parity with the pipeline, winding, seams, picking, plot tint, phone layout, no request leaving the page's own server). **HD pass built 26 Sept:** smooth textured ground, measured roofs, fuller trees, sun slider and shade; 111 viewer tests in four files (one of them a TODO test that waits on Joseph's choice of evening light), and 521 pipeline tests. Not yet tried on a real phone, Safari or iOS |
| 4. Measured facts | **Built 25 Sept.** Slope and flat ground, clear-sky sun hours from a horizon cast to ~160 km, peaks and trailheads by walking route. Every figure independently recomputed by a reviewer. 459 pipeline tests in all |
| 5. Hub map, other listings, France, Italy | **Only after Joseph approves the prototype** |

Nothing reaches `main`, and so the live site, until Joseph says so. Every pushed branch of
this repo is public on GitHub, so the public-safety rules apply from the first push.

---

## 11. Not checked, uncertain, or gone wrong

- **robots.txt was read late.** In step 1 research, before any robots.txt was read, agents
  sent automated requests that those sites disallow:
  - OpenStreetMap's Overpass service;
  - a regional extract download;
  - PVGIS.

  They also made a few requests to Nominatim and the OpenStreetMap API, whose rules were
  never read. The extract carried contributors' usernames and was deleted. The pipeline
  now enforces robots.txt in code.
- **An address in branch history.** An early version of this file, since removed from the
  branch, named the first prototype's address.
- **Browsers.** Not tested on Safari or iOS.
- **Kartverket terms.** Its terms for automated use are not confirmed with Kartverket. No
  limit is documented, and none was hit.
- **Byte-identical rebuilds.** The gzip bytes, and so the manifest's sha256, can differ
  between zlib builds. File names hash the uncompressed data, so they cannot.
- **Peak heights.** Taken from the coarse levels, they come out low (a median of about
  5 m below Kartverket's surveyed spot heights beyond 5 km). Step 4 measures peaks on
  fresh fine data.
- **Seasons.** The surface model's survey season is inferred, not confirmed, so whether
  trees were in leaf is uncertain.
- **The HD pass has not run on a real phone or a real GPU.** Every figure for it is a
  count from headless Chromium with software rendering, or a timing in Node on a shared
  machine. Not measured: frame rate on any device; the cost per pixel of the ground's
  shader (several texture reads per pixel), of the sun's patch and of the shadow map's
  filtering; shader compile time on mobile drivers; how long the terrain-shade sweep and
  the ground's meshing take on a phone's CPU. The first follow-up is Joseph opening a
  local build on his own phone, served from his own machine, since worlds are never
  published.
- **Legal reading.** The CC BY 4.0 reading is careful, but it is not legal advice.
