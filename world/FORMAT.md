# Commons World: data formats, version 1

The contract between the pipeline (`world/pipeline/`, Python) and the viewer
(`world/index.html` + `world/js/`). Change a format here first, bump its version, and keep
old readers working or fail loudly.

A built world is a folder, `world/out/<id>/` locally. Nothing under `world/out/` is ever
committed (see `.gitignore`), because a built world is a precise location. Where built
worlds are published, if anywhere, is decided outside this file.

All JSON is UTF-8 **encoded as pure ASCII** (`ensure_ascii`, so the letter o-slash is
written as the six characters `\u00f8`). All binary is little-endian.

---

## 1. Coordinates

- **`crs.epsg`**: the national grid the place was built in (Vestland: 25832).
- **Origin `O = (origin_e, origin_n)`**: the geocoded address point, rounded to whole
  metres.
- **Local frame (viewer):**
  - `x = E - origin_e` (metres east);
  - `z = -(N - origin_n)` (metres south);
  - `y` = height above the vertical datum (NN2000 in Norway; sea at 0).
- **`crs.grid_north_offset_deg`**: the grid bearing of true north at `O`. It is about +3.4 in
  western Vestland. For any direction:
  - true bearing = grid bearing - offset;
  - grid bearing = true bearing + offset.

  The sun's true azimuth `A` is drawn at grid bearing `A + offset`.

## 2. Height levels and the chunk grid

| Level | Cell `c` | Radius `R` from O | Chunk samples `K` | Chunk side `S = K*c` |
|---|---|---|---|---|
| `h1` | 1 m | 1500 m | 240 | 240 m |
| `h5` | 5 m | 5000 m | 240 | 1200 m |
| `h20` | 20 m | 11000 m | 240 | 4800 m |

- **Absolute chunk grid.** Chunk `(i, j)` of a level covers `E in [i*S, (i+1)*S)` and
  `N in [j*S, (j+1)*S)`, in absolute grid coordinates. So chunks align across levels and
  across listings. Every `h5` chunk is exactly 5 x 5 `h1` chunk squares, and every `h20`
  chunk is exactly 4 x 4 `h5` squares.
- **Inclusion.** A chunk is included when its square intersects the disk of radius `R`
  around `O`, i.e. when the distance from `O` to the nearest point of the square is `<= R`.
- **Samples are cell centres.**
  - Each chunk stores a one-sample apron on every side: a `(K+2) x (K+2)` = `242 x 242`
    array.
  - Stored row `r` and column `q` (both 0..241) have their centre at:
    - `E = i*S - c + (q + 0.5)*c`
    - `N = (j+1)*S + c - (r + 0.5)*c`
  - Row 0 is the northmost row. The apron (row/column 0 and 241) duplicates the
    neighbouring chunk's edge samples, so a chunk can be meshed without its neighbours.
- **Sea chunks.** A chunk whose every stored sample is `<= 0.0 m` is **not written**. It is
  listed under `sea` in the manifest, and the viewer draws sea there.
- **Sources (Norway).** Kartverket's national height model (NHM DTM), via the hoydedata
  ImageServer `exportImage`:
  - `h1` with nearest-neighbour: native 1 m pixels, whose centres fall on `x.5` m.
  - `h5`: the server's bilinear output at 2.5 m, averaged 2 x 2 into each 5 m cell. The
    server's own 4 m and 5 m output was found displaced by 2 m in places, varying from
    place to place, so a fixed correction could not work.
  - `h20`: the server's bilinear output at 20 m.
  - Every build compares `h5` and `h20` with block means of `h1`, and `h20` with `h5`,
    searching one coarse cell each way, and records the result in
    `manifest.stats.registration`. A detected shift is a warning in the manifest.
  - Nodata is filled with 0 m; its fraction per level is recorded in the manifest.

## 3. Height chunk file: CWH1

**Path:** `<level>/<i>_<j>.<hash8>.cwh.gz`, where `hash8` is the first 8 hex characters of
the sha256 of the *uncompressed* payload. The file is gzip (level 9, `mtime=0`, so the
output is deterministic) of:

**Header (32 bytes):**

| Offset | Type | Field |
|---|---|---|
| 0 | 4 x u8 | magic `CWH1` (ASCII) |
| 4 | u8 | version = 1 |
| 5 | u8 | flags: bit0 planar predictor; bit1 one-sample apron; bit2 class band present |
| 6 | u16 | width (242) |
| 8 | u16 | height (242) |
| 10 | u16 | cell size in centimetres (100, 500, 2000) |
| 12 | i32 | E of the stored array's north-west *corner*, in decimetres (`(i*S - c) * 10`) |
| 16 | i32 | N of that corner, in decimetres (`((j+1)*S + c) * 10`) |
| 20 | i32 | base height in decimetres |
| 24 | u32 | EPSG code |
| 28 | u32 | reserved, 0 |

**Band 1: heights.** `width*height` values of u16, row-major, north to south and west to
east.
- Let `h_dm = floor(h_m * 10 + 0.5)`.
- `v = (h_dm - base) mod 65536`. The pipeline picks `base = min(h_dm)` over the chunk, so
  `v` is the plain offset.
- **Planar predictor** (when flag bit0 is set):
  - `pred(r,q) = v(r,q-1) + v(r-1,q) - v(r-1,q-1)`, mod 65536; neighbours outside the
    array count as 0.
  - Stored value `s = (v - pred) mod 65536`.
  - To decode: `v = (s + pred) mod 65536`, then `h_m = (base + v) / 10`.
- The range is therefore 6553.5 m above `base`, which covers any chunk on Earth.

**Band 2: land-cover class** (when flag bit2 is set). `width*height` u8 values in the same
order, raw (gzip compresses them).

| Code | Class | Code | Class |
|---|---|---|---|
| 0 | open land, unknown | 7 | road (driveable) |
| 1 | forest | 8 | footway / cycleway / pavement |
| 2 | bog, marsh | 9 | path, track, trail |
| 3 | farmland | 10 | bare rock, open mountain |
| 4 | lake, river | 11 | snow, glacier |
| 5 | sea | 12 | building footprint (`h1` only) |
| 6 | built-up area | 13 | sand, gravel, quarry |

- **Sea is decided by height.** A sample at or below 0 m is class 5 unless it is a lake or
  river (class 4). Land cover, roads and building footprints are painted only on samples
  above 0 m; N50's generalised polygons overlap the shore, and without this rule a sea
  sample could carry "forest".
- **Precedence when rasterising**, lowest first: sea, then
  land-cover polygons, then lakes and rivers, then roads and paths, then building
  footprints.
- **What each level carries:**
  - `h1`: every road, footway and path, buffered to a nominal width (road 6 m, footway
    3 m, path 2 m).
  - `h5`: driveable roads only.
  - `h20`: only national and county roads (NVDB vegkategori E, R, F).

## 4. Other files in a world folder

Paths below are relative to the world folder. Every file is listed in `manifest.files`
with its byte size and sha256.

### `buildings.json.gz`

Buildings within `h1` radius.
- **Footprints** are segmented from the 1 m surface model minus the terrain model, and
  anchored to building points from the Matrikkel building register.

```json
{"version": 1,
 "features": [
   {"id": 1, "type": 111, "source": "dom",
    "ground": 28.1, "roof": 34.6, "house": true,
    "ring": [[x, z], [x, z]]}
 ]}
```

- `ring` is local metres, rounded to 0.1 m, not closed (the last vertex is not repeated),
  with no repeated consecutive vertex, and counter-clockwise seen from above with north up
  and east right. Its shoelace area is positive in grid (E, N), and so negative if computed
  directly on (x, z), because z points south.
- `ground` is the median terrain height under the footprint.
- `roof` is the 90th percentile of the surface model inside it.
- `roof_shape` (optional) is the roof fitted to the 1 m surface model, and the outline it is
  drawn over. When it is absent, or has `"model": "none"`, the shape was not measured, and a
  reader draws a flat top at `roof` as before. A `roof_shape` from the synthetic world:

  ```json
  {"model": "gable", "quality": "good", "rms": 0.02, "inliers": 1.0,
   "cells": 64, "pitch": 31.0, "ridge_bearing": 90.0,
   "eave": 103.49, "ridge": 106.5, "outline": "straightened",
   "at": [-60.0, -45.0],
   "parts": [{"model": "gable",
              "ring": [[-65.0, -50.0], [-65.0, -40.0], [-55.0, -40.0], [-55.0, -50.0]],
              "planes": [[0.0, -0.6017, 106.5], [0.0, 0.6017, 106.5]]}]}
  ```

  - A part's roof height at (x, z) is the minimum over its planes `[sx, sz, y0]` of
    `y0 + sx * (x - at[0]) + sz * (z - at[1])`, in metres above the vertical datum.
    `at` is local metres, rounded to 0.1 m; `sx` and `sz` are rounded to 0.0001, `y0` to
    0.01 m.
  - `parts[].ring` follows the conventions of `ring`, and is always written, even for a
    single part. The parts tile the drawn outline: they share edges vertex for vertex and
    do not overlap, and the drawn outline is their union. Walls are not at this outline:
    it is the edge of the roof.
  - `outline` is `"straightened"` or `"traced"`. A straightened outline is fitted along the
    fitted ridge to the same cells, and kept only when it stays within 15 % of the traced
    area, 1.5 m of every traced vertex and 0.45 m of the traced outline on average
    (symmetric difference over perimeter); otherwise it is traced. Either may also be
    grown where the fitted roof clearly continues past the traced cells. While the
    pipeline's `roofs.HOUSE_OUTLINE` is `"traced"` (the default), the listing house is
    `"traced"`: it is neither grown, straightened nor split, so it has one part whose
    `ring` is its `ring`, and the drawn outline is its `ring`. Where no single shape fits
    it, its `model` is `none`.
  - `model` is `flat`, `shed`, `gable`, `hip` (a pyramid is a hip), `split` (two or three
    parts, each with its own `model` of `flat`, `shed` or `gable`), or `none`. `quality`
    is `good` or `fair`. `rms` (m, 0.01) and `inliers` (a share, 0.01) describe the fit to
    `cells` surface-model cells.
  - `pitch` is in degrees (0.1): the mean slope of the pitched planes, 0 when flat.
  - `ridge_bearing` (degrees, 0.1) is the grid bearing of the ridge for `gable` and `hip`
    (clockwise from grid north, that is from -z; 0-180), and the downhill bearing for
    `shed` (0-360). It is absent for `flat` and `split`. A true bearing is the grid
    bearing minus `crs.grid_north_offset_deg` (section 1).
  - `eave` and `ridge` are the lowest and highest points of the drawn roof over its
    outline (metres above the datum, 0.01 m).
  - With `"model": "none"` only `reason` is present: `"too few cells"`, `"no model fits"`,
    or `"implausible"` (the fitted roof came within 1.5 m of the terrain over the outline
    plus 0.5 m, or rose more than 1 m above the highest surface-model cell).
- `type` is the register's building-type code, or 0 if none was matched.
- `house: true` marks exactly one building: the listing's house, if identified.
- **Optional:** buildings beyond `h1` come from register points only. They have
  `source: "register"` and a default square `ring`.
- Readers ignore keys they do not know. The viewer refuses a file whose `version` is not
  1, and draws a building whose `roof_shape` is malformed (a number that is not finite,
  parts that do not chain into one outline, a roof below its wall bottom plus 0.5 m) as
  the flat prism, and counts it.

### `trees.bin.gz`

Gzip of:
- **Header (12 bytes):** magic `CWT1`, u8 version = 1, u8 flags = 0, u16 reserved,
  u32 count.
- **One 8-byte record per tree:**

  | Type | Field |
  |---|---|
  | i16 | x in decimetres |
  | i16 | z in decimetres |
  | i16 | ground height in decimetres |
  | u8 | tree height in units of 0.25 m |
  | u8 | crown radius in units of 0.1 m |

Records are sorted by (z, x). Trees come from local maxima of canopy height (surface
minus terrain) above 3 m, outside building footprints, within `h1` radius.
The file says nothing about species: the viewer's conifer or broadleaf look follows each
tree's measured proportions (crown radius against height), and is not its species.

### `plot.json`

```json
{"version": 1,
 "parcels": [{"ring": [[x, z]], "holes": [], "area_polygon_m2": 0.0,
              "area_register_m2": 0.0, "accuracy_class": "Gult"}],
 "stated_plot_m2": 0,
 "note": "Registered parcel for the address. The listing states a larger plot.",
 "source": "Kartverket, Eiendom API and Matrikkelen teig (CC BY 4.0)"}
```

The ring convention is the same as for buildings. Holes are rings too, and are also
counter-clockwise (unlike GeoJSON, whose holes run clockwise).

### `listing.json`

The exporter's output (`world/schema/listing.schema.json`), plus two fields the pipeline
adds:
- `"id"`: `no-<kommune>-<gnr>-<bnr>`, e.g. the made-up `"no-9999-1-1"`;
- `"geocode"`: `{"source", "lat", "lon", "epsg", "e", "n", "property"}`.

### `places.json`

Named places near the world, for labels and facts:

```json
{"version": 1, "features": [{"name": "...", "type": "Fjell", "x": 0.0, "z": 0.0, "h": 0.0}]}
```

`h` is sampled from the terrain model, not taken from a tag.

### `facts.json`

Written by step 4 (`commons_world/facts/`). The viewer shows whatever is present and says
"not computed" for anything missing.
- Distances are metres, heights metres, angles degrees, and bearings **true** degrees
  clockwise from north.
- Every block carries a `method` string (shown as a tooltip) and a `caveats` list.

```json
{"version": 1, "generated_at": "...",
 "plot": {
   "method": "...", "caveats": ["..."],
   "area_m2": 0.0, "analysed_m2": 0.0, "open_ground_m2": 0.0,
   "elevation_min": 0.0, "elevation_max": 0.0,
   "slope_median_deg": 0.0, "slope_p10_deg": 0.0, "slope_p90_deg": 0.0,
   "plane_fit": {"slope_deg": 0.0, "aspect_true_deg": 0.0},
   "bands_deg": [{"from": 0, "to": 5, "m2": 0.0, "m2_smoothed": 0.0}],
   "ratio_bands": [{"label": "gentler than 1 in 5", "m2": 0.0}],
   "largest_patch": {"under5_m2": 0.0, "under10_m2": 0.0,
                     "circle_under5_m": 0.0, "circle_under10_m": 0.0}},
 "sun": {
   "method": "...", "caveats": ["Clear sky: weather is not included."],
   "astronomical": {"dec21_h": 0.0, "decjan_mean_h": 0.0, "jun21_h": 0.0, "monthly_h": [0.0]},
   "plot_median": {"terrain": {"dec21_h": 0.0, "decjan_mean_h": 0.0, "jun21_h": 0.0, "monthly_h": [0.0]},
                   "terrain_canopy": {"dec21_h": 0.0, "decjan_mean_h": 0.0, "jun21_h": 0.0, "monthly_h": [0.0]}},
   "garden_point": {"x": 0.0, "z": 0.0,
                    "terrain": {"dec21_h": 0.0}, "terrain_canopy": {"dec21_h": 0.0}},
   "horizon": {"step_deg": 0.5, "max_distance_m": 0.0, "south_sector_mean_deg": 0.0,
               "profile_deg": [0.0]},
   "plot_map": {"cell_m": 2, "x0": 0.0, "z0": 0.0, "cols": 0, "rows": 0,
                "dec21_min_terrain": [0], "dec21_min_canopy": [0]},
   "sun_path": {"dec21": [[0.0, 0.0]], "jun21": [[0.0, 0.0]]}},
 "access": {
   "method": "...", "caveats": ["..."],
   "network": "NVDB Vegnett Pluss + Turrutebasen + N50 paths",
   "peaks": [{"name": "...", "h": 0.0, "x": 0.0, "z": 0.0,
              "straight_m": 0.0, "bearing_true_deg": 0.0,
              "route_m": 0.0, "climb_m": 0.0, "naismith_h": 0.0, "tobler_h": 0.0,
              "reaches_summit": true, "gap_m": 0.0,
              "route": [[0.0, 0.0]]}],
   "trailheads": [{"kind": "path leaves road", "x": 0.0, "z": 0.0,
                   "route_m": 0.0, "climb_m": 0.0}]}}
```

Notes:
- **Monthly values.** `monthly_h` has 12 values (Jan..Dec), each the mean over that month
  of daily potential direct-sun hours.
- **The plot sun map.** `plot_map` arrays are row-major, north to south, one integer per
  2 m cell in minutes; -1 means outside the plot or under a building.
- **The sun path.** `sun_path` lists `[true_azimuth_deg, apparent_elevation_deg]` every
  10 minutes while the sun is up.
- **Routes.** `route` polylines are local metres, simplified to about 5 m.

### `manifest.json`

```json
{"format": "commons-world", "version": 1, "id": "no-9999-1-1",
 "generated_at": "2026-09-25T12:00:00Z",
 "pipeline": {"version": "0.1.0", "commit": "abc1234"},
 "crs": {"epsg": 25832, "origin_e": 0, "origin_n": 0,
         "grid_north_offset_deg": 0.0, "scale_factor": 1.0, "vertical": "NN2000"},
 "levels": [{"name": "h1", "cell": 1, "radius": 1500, "chunk_samples": 240,
             "apron": 1, "class_band": true, "nodata_fraction": 0.0,
             "chunks": {"1234_5678": {"file": "h1/1234_5678.0a1b2c3d.cwh.gz",
                                       "bytes": 0, "sha256": "...", "min": 0.0, "max": 0.0}},
             "sea": ["1233_5679"]}],
 "files": {"buildings": {"file": "buildings.json.gz", "bytes": 0, "sha256": "..."}},
 "sources": [{"name": "...", "publisher": "...", "licence": "CC BY 4.0",
              "licence_url": "...", "endpoint": "...", "retrieved": "2026-09-25"}],
 "credits": ["(c) Kartverket, CC BY 4.0 ..."],
 "robots": [{"host": "api.kartverket.no", "status": 404, "policy": "allow-all",
             "checked_at": "..."}],
 "stats": {}}
```

- Chunk keys are `"<i>_<j>"`.
- The viewer ignores unknown keys, and refuses a `version` it does not know.
