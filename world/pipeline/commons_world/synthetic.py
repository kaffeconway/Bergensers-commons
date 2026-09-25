"""A deterministic synthetic place, built through the same writers as a real world.

    python -m commons_world synthetic [--out DIR]

The place is invented. Its origin is 60.0 N 4.0 E, a point in the open North
Sea chosen because nothing lives there; the land, hills, lake and parcel around
it are functions in this file. No network is used and no real data is read.

- hills: a sum of Gaussians, the highest about 400 m;
- sea: everything west of a wavy coastline is exactly 0 m, as in Kartverket's
  terrain model, so some chunks at every level are all sea and are skipped;
- a lake: flat at LAKE_LEVEL inside a lobed outline, with banks blended in;
- a parcel: a 90 x 40 m rectangle (3,600 m2) on a slope near the origin;
- map features, run through the same steps as a real build
  (commons_world.mapsteps): land-cover polygons (forest, bog, farmland,
  built-up, rock, gravel, and an N50-style sea polygon that overlaps the
  shore), the lake, a stream, roads of several categories (one on a bridge
  over the lake, one in a tunnel), a footway, a path and a trail; ten
  buildings (eight with roofs and register points, one roof with no point,
  one point with no roof), the house among them inside the parcel; a few
  hundred trees in two forest patches; and named hills with spot heights.

Local coordinates here are x east and n north, in metres from the origin.
(FORMAT.md's viewer frame uses z = -n.)
"""

import math
from pathlib import Path

import numpy as np
from shapely.affinity import rotate, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.prepared import prep

from . import __version__, geo, grid
from .build import (PIPELINES, BuildContext, Pipeline, Step, _staging_dir, run_pipeline,
                    set_origin, step_listing, step_manifest, step_plot, step_terrain,
                    step_terrain_fetch)
from .classes import BOG, BUILT_UP, FARMLAND, FOREST, GRAVEL, LAKE, ROCK, SEA
from .mapsteps import SHARED_STEPS, inputs
from .n50 import Area, BuildingPoint, Line, SpotHeight
from .parcel import Parcel
from .places import Candidate, keep_candidates
from .raster import LevelGrid
from .terrain import ChunkSet
from .trails import InfoPoint

SYNTHETIC_ID = "zz-synthetic"
ORIGIN_LAT = 60.0
ORIGIN_LON = 4.0
EPSG = 25832
GENERATED_AT = "2026-01-01T00:00:00Z"

# (x east, n north, amplitude m, sigma m)
HILLS = (
    (2600.0, 1800.0, 360.0, 1300.0),
    (-200.0, 3800.0, 220.0, 1100.0),
    (4200.0, -3200.0, 300.0, 1900.0),
    (900.0, -2300.0, 150.0, 900.0),
    (7000.0, 6000.0, 260.0, 2500.0),
    (-350.0, 320.0, 110.0, 380.0),
)
SHORE_WIDTH = 250.0
LAKE_CENTRE = (900.0, -800.0)
LAKE_LEVEL = 96.0
LAKE_BANK = 250.0
PARCEL_CENTRE = (15.0, -10.0)
PARCEL_SIZE = (90.0, 40.0)
PARCEL_ROTATION_DEG = 25.0
STATED_PLOT_M2 = 3900

def coast_x(n):
    """x of the coastline at northing n: sea lies to the west of it."""
    n = np.asarray(n, dtype=np.float64)
    return -800.0 + 200.0 * np.sin(n / 700.0) + 100.0 * np.cos(n / 330.0)


def land_height(x, n):
    """Height of the land surface before the coast and the lake are applied."""
    x = np.asarray(x, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    h = 8.0 + 0.004 * (x - coast_x(n))
    for hx, hn, amp, sigma in HILLS:
        h = h + amp * np.exp(-((x - hx) ** 2 + (n - hn) ** 2) / (2.0 * sigma * sigma))
    return h + 2.5 * np.sin(x / 37.0) * np.cos(n / 53.0) + 1.5 * np.sin((x + n) / 91.0)


def lake_offset(x, n):
    """Distance outside the lake's lobed shore (negative inside), metres."""
    dx = np.asarray(x, dtype=np.float64) - LAKE_CENTRE[0]
    dn = np.asarray(n, dtype=np.float64) - LAKE_CENTRE[1]
    theta = np.arctan2(dn, dx)
    radius = 200.0 + 30.0 * np.cos(3.0 * theta) + 15.0 * np.sin(5.0 * theta)
    return np.hypot(dx, dn) - radius


def height_local(x, n):
    """Terrain height in metres at local (x east, n north). Vectorised."""
    x = np.asarray(x, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    shore = np.clip((x - coast_x(n)) / SHORE_WIDTH, 0.0, 1.0)
    h = land_height(x, n) * shore
    off = lake_offset(x, n)
    t = np.clip(1.0 - off / LAKE_BANK, 0.0, 1.0)
    w = t * t * (3.0 - 2.0 * t)
    banked = LAKE_LEVEL + 0.15 * np.maximum(off, 0.0)
    h = np.where(off > 0.0, (1.0 - w) * h + w * banked, LAKE_LEVEL)
    return h


def origin():
    """The synthetic origin in EPSG:25832, whole metres."""
    return geo.round_origin(*geo.to_grid(ORIGIN_LAT, ORIGIN_LON, EPSG))


def height_grid(e, n, origin_en):
    """Height at absolute grid coordinates (E, N) for a world with origin `origin_en`."""
    return height_local(np.asarray(e) - origin_en[0], np.asarray(n) - origin_en[1])


def parcel_polygon(origin_en):
    """The synthetic parcel, in grid coordinates."""
    cx, cn = PARCEL_CENTRE
    half_w, half_h = PARCEL_SIZE[0] / 2.0, PARCEL_SIZE[1] / 2.0
    a = math.radians(PARCEL_ROTATION_DEG)
    corners = []
    for dx, dn in ((-half_w, -half_h), (half_w, -half_h), (half_w, half_h), (-half_w, half_h)):
        x = cx + dx * math.cos(a) - dn * math.sin(a)
        n = cn + dx * math.sin(a) + dn * math.cos(a)
        corners.append((origin_en[0] + x, origin_en[1] + n))
    return Polygon(corners)


def synthetic_listing():
    """A listing record that validates against listing.schema.json. All invented."""
    return {
        "schema_version": 1,
        "country": "NO",
        "link": None,
        "facts": {
            "currency": "NOK",
            "asking_price": 3000000,
            "shared_debt": None,
            "freehold": True,
            "other_purchase_costs": None,
            "kommunale_avgifter_monthly": None,
            "eiendomsskatt_monthly": None,
            "property_type": "Enebolig (synthetic)",
            "build_year": 1970,
            "bra_i_m2": 120,
            "bra_e_m2": None,
            "tba_m2": None,
            "bedrooms": 3,
            "rooms": 5,
            "plot_stated_m2": STATED_PLOT_M2,
            "plot_ownership": "Eiet (synthetic)",
            "ground_rent": None,
            "condition_report": "not stated",
        },
        "approved_text": {
            "address": "Synthetic Road 1, 0000 Nowhere",
            "nickname": "Synthetic test place",
            "municipality": "Nowhere (synthetic)",
            "use_class": "synthetic",
        },
        "costs": {
            "basis": "whole property, owned outright",
            "currency": "NOK",
            "transfer_cost": None,
            "all_in": None,
            "all_in_eur": None,
            "stated_monthly": None,
            "maintenance_monthly": None,
            "owned_outright_monthly": None,
            "owned_outright_monthly_eur": None,
            "warnings": ["Synthetic listing: no costs were computed."],
        },
        "export": {
            "generated_at": GENERATED_AT,
            "exporter_version": "commons_world.synthetic " + __version__,
        },
    }


def terrain_source(origin_en):
    """A terrain source for the build: level -> ChunkSet sampled from height_local."""
    def source(level):
        out = ChunkSet()
        for i, j in grid.chunks_for_disk(level, *origin_en):
            east, north = grid.sample_centres(level, i, j)
            out[(i, j)] = height_grid(east[None, :], north[:, None], origin_en)
        out.samples = len(out) * level.stored * level.stored
        return out
    return source


# -- map features ---------------------------------------------------------------
# Everything below is in local metres (x east, n north) and invented.

# (centre x, centre n, radius x, radius n)
FOREST_PATCHES = ((-300.0, 420.0, 200.0, 170.0), (520.0, 650.0, 260.0, 200.0),
                  (2600.0, 1800.0, 900.0, 700.0), (4200.0, -3200.0, 1100.0, 800.0),
                  (-200.0, 3800.0, 700.0, 600.0))
BOG_PATCHES = ((1500.0, 3000.0, 400.0, 250.0), (750.0, -250.0, 110.0, 70.0))
FARMLAND_BOX = (-520.0, -950.0, -150.0, -450.0)
BUILT_UP_BOX = (-160.0, -220.0, 260.0, 160.0)
ROCK_CIRCLE = (2600.0, 1800.0, 450.0)
GRAVEL_BOX = (1270.0, 180.0, 1330.0, 220.0)
# An N50-style sea polygon whose edge runs onto the shore: it must not paint land.
HAVFLATE_EAST_EDGE = -650.0

# (kind, NVDB vegkategori, SOSI medium, source, [(x, n), ...])
LINES = (
    ("road", "F", None, "nvdb", ((-600.0, -380.0), (1500.0, -380.0), (3000.0, -1200.0),
                                 (6000.0, -1500.0), (9800.0, -1500.0))),
    ("road", "K", None, "nvdb", ((110.0, -380.0), (110.0, 900.0), (300.0, 2500.0))),
    ("road", "P", None, "nvdb", ((110.0, 30.0), (62.0, 18.0))),
    ("road", "K", "L", "nvdb", ((900.0, -1150.0), (900.0, -450.0))),
    ("road", "R", "U", "nvdb", ((900.0, 400.0), (1300.0, 400.0))),
    ("road", "E", None, "nvdb", ((-500.0, 6000.0), (9000.0, 6000.0))),
    ("footway", None, None, "nvdb", ((122.0, -380.0), (122.0, 900.0))),
    ("path", None, None, "n50", ((110.0, 600.0), (400.0, 700.0), (700.0, 900.0),
                                 (1000.0, 1200.0))),
    ("path", None, None, "turrutebasen", ((1000.0, 1200.0), (1800.0, 1600.0),
                                          (2600.0, 1800.0))),
    ("stream", None, None, "n50", ((1150.0, -800.0), (1500.0, -900.0), (2000.0, -1000.0))),
)

# (x, n, width E-W, depth N-S, rotation deg, eave m, ridge rise m (0 flat), type,
#  has a register point, has a roof)
BUILDINGS = (
    (5.0, -8.0, 12.0, 9.0, 25.0, 3.0, 2.5, 111, True, True),     # the house, in the parcel
    (38.0, 2.0, 7.0, 6.0, 25.0, 3.0, 0.0, 181, True, True),      # its garage, in the parcel
    (-60.0, 45.0, 10.0, 10.0, 0.0, 3.2, 3.0, 111, True, True),   # the neighbours
    (200.0, -150.0, 14.0, 10.0, 0.0, 6.0, 0.0, 311, True, True), # an office
    (620.0, -170.0, 30.0, 20.0, 0.0, 8.0, 0.0, 211, True, True), # a workshop
    (-300.0, 700.0, 8.0, 6.0, 40.0, 2.8, 2.2, 161, True, True),  # a cabin
    (60.0, 250.0, 11.0, 9.0, -10.0, 3.0, 2.8, 111, True, True),  # another house
    (900.0, 300.0, 9.0, 7.0, 15.0, 2.8, 2.0, 161, True, True),   # another cabin
    (-200.0, -110.0, 10.0, 7.0, 0.0, 3.5, 2.5, 0, False, True),  # a barn nobody registered
    (300.0, 320.0, 10.0, 8.0, 0.0, 3.0, 2.0, 111, True, False),  # registered, since demolished
)

TREE_SEED = 20260925
TREE_TARGET = 320
TREE_PATCHES = 2            # trees grow in the first two forest patches (inside h1)
TREE_SPACING_M = 5.5
TREE_CLEARANCE_M = 12.0     # from buildings, roads and paths
TREE_HEIGHT_M = (6.0, 20.0)
TREE_CROWN_M = (1.5, 3.5)   # half-height crown radius
CANOPY_ROUGHNESS_M = 0.5   # noise on crowns: real 1 m canopy is rough, roofs are not

# (name, register type, x, n): names at hills, a little off their tops.
PLACE_NAMES = (
    ("Synthetic Fjell", "Fjell", 2612.0, 1790.0),
    ("Synthetic Topp", "Topp", 7010.0, 5990.0),
    ("Synthetic Haug", "Haug", -338.0, 330.0),
    ("Synthetic \u00c5s", "\u00c5s", 4190.0, -3210.0),
    ("Synthetic Berg", "Berg", 905.0, -2290.0),
    ("Synthetic H\u00f8yde", "H\u00f8yde", -190.0, 3810.0),
    ("Synthetic Vik", "Vik i sj\u00f8", -1500.0, 0.0),        # not a terrain type: dropped
    ("Far Away Fjell", "Fjell", 20000.0, 0.0),                # outside the world: dropped
)
TRAIL_POINTS = ((1000.0, 1200.0, 22),)


def _grid_polygon(poly, origin_en):
    return translate(poly, xoff=origin_en[0], yoff=origin_en[1])


def _grid_coords(coords, origin_en):
    return np.asarray(coords, dtype=np.float64) + np.asarray(origin_en, dtype=np.float64)


def ellipse(cx, cn, rx, rn, segments=72):
    """An ellipse as a polygon, local metres."""
    t = np.linspace(0.0, 2.0 * math.pi, segments, endpoint=False)
    return Polygon(np.column_stack([cx + rx * np.cos(t), cn + rn * np.sin(t)]))


def lake_polygon(segments=720):
    """The lake's shore (lake_offset == 0) as a polygon, local metres."""
    theta = np.linspace(-math.pi, math.pi, segments, endpoint=False)
    radius = 200.0 + 30.0 * np.cos(3.0 * theta) + 15.0 * np.sin(5.0 * theta)
    return Polygon(np.column_stack([LAKE_CENTRE[0] + radius * np.cos(theta),
                                    LAKE_CENTRE[1] + radius * np.sin(theta)]))


def synthetic_areas(origin_en):
    """Land-cover, water and sea polygons (n50.Area) in grid coordinates."""
    local = []
    for cx, cn, rx, rn in FOREST_PATCHES:
        local.append((FOREST, "landcover", ellipse(cx, cn, rx, rn), "Skog"))
    for cx, cn, rx, rn in BOG_PATCHES:
        local.append((BOG, "landcover", ellipse(cx, cn, rx, rn), "Myr"))
    local.append((FARMLAND, "landcover", box(*FARMLAND_BOX), "DyrketMark"))
    local.append((BUILT_UP, "landcover", box(*BUILT_UP_BOX), "Tettbebyggelse"))
    cx, cn, r = ROCK_CIRCLE
    local.append((ROCK, "landcover", Point(cx, cn).buffer(r, quad_segs=16), "synthetic rock"))
    local.append((GRAVEL, "landcover", box(*GRAVEL_BOX), "Steinbrudd"))
    local.append((LAKE, "water", lake_polygon(), "Innsj\u00f8"))
    local.append((SEA, "sea", box(-20000.0, -20000.0, HAVFLATE_EAST_EDGE, 20000.0), "Havflate"))
    return [Area(code=code, tier=tier, polygon=_grid_polygon(poly, origin_en), source_type=kind)
            for code, tier, poly, kind in local]


def synthetic_lines(origin_en):
    """Roads, footway, path, trail and stream (n50.Line) in grid coordinates."""
    return [Line(kind=kind, coords=_grid_coords(coords, origin_en), category=category,
                 medium=medium, source=source, source_type="synthetic")
            for kind, category, medium, source, coords in LINES]


def building_footprint(spec):
    """A building's rectangle, local metres."""
    x, n, width, depth, angle = spec[:5]
    rect = box(x - width / 2.0, n - depth / 2.0, x + width / 2.0, n + depth / 2.0)
    return rotate(rect, angle, origin=(x, n))


def synthetic_building_points(origin_en):
    """Register points (n50.BuildingPoint) for the buildings that have one."""
    out = []
    for number, spec in enumerate(BUILDINGS, start=1):
        if spec[8]:
            out.append(BuildingPoint(type=spec[7], e=origin_en[0] + spec[0],
                                     n=origin_en[1] + spec[1], number=number, status="TB",
                                     source="synthetic"))
    return out


def synthetic_trees(origin_en):
    """[(x, n, height, crown)] in local metres: seeded, inside the first forest patches."""
    rng = np.random.default_rng(TREE_SEED)
    obstacles = [building_footprint(spec) for spec in BUILDINGS]
    obstacles += [LineString(coords) for kind, _, medium, _, coords in LINES if kind != "stream"]
    keep_clear = prep(unary_union(obstacles).buffer(TREE_CLEARANCE_M))
    patches = [(ellipse(*patch), patch) for patch in FOREST_PATCHES[:TREE_PATCHES]]
    trees = []
    for _ in range(TREE_TARGET * 40):
        if len(trees) >= TREE_TARGET:
            break
        poly, (cx, cn, rx, rn) = patches[len(trees) % len(patches)]
        x = float(rng.uniform(cx - rx, cx + rx))
        n = float(rng.uniform(cn - rn, cn + rn))
        height = float(rng.uniform(*TREE_HEIGHT_M))
        crown = float(rng.uniform(*TREE_CROWN_M))
        if not poly.contains(Point(x, n)) or keep_clear.contains(Point(x, n)):
            continue
        if height_local(x, n) <= 2.0:
            continue
        if any((x - a) ** 2 + (n - b) ** 2 < TREE_SPACING_M ** 2 for a, b, _, _ in trees):
            continue
        trees.append((round(x, 2), round(n, 2), round(height, 2), round(crown, 2)))
    return trees


def surface_mosaic(level, chunkset, origin_en):
    """(LevelGrid, DOM mosaic): the terrain plus roofs and tree crowns, on the h1 grid."""
    from rasterio.features import rasterize

    lgrid = LevelGrid(level, list(chunkset))
    dtm = lgrid.assemble(chunkset).astype(np.float64)
    dom = dtm.copy()
    rng = np.random.default_rng(TREE_SEED + 1)
    east, north = lgrid.centres()
    for spec in BUILDINGS:
        if not spec[9]:
            continue
        x, n, width, depth, angle, eave, ridge = spec[:7]
        footprint = _grid_polygon(building_footprint(spec), origin_en)
        cells = rasterize([(footprint, 1)], out_shape=lgrid.shape, transform=lgrid.transform,
                          fill=0, dtype="uint8").astype(bool)
        rows, cols = np.nonzero(cells)
        if not len(rows):
            continue                          # outside this (smaller) h1 grid
        de = east[cols] - (origin_en[0] + x)
        dn = north[rows] - (origin_en[1] + n)
        a = math.radians(angle)
        across = -de * math.sin(a) + dn * math.cos(a)   # distance from the ridge line
        base = float(dtm[rows, cols].max())
        rise = ridge * np.clip(1.0 - np.abs(across) / (depth / 2.0), 0.0, 1.0)
        dom[rows, cols] = base + eave + rise + rng.normal(0.0, 0.02, len(rows))
    canopy = np.zeros(lgrid.shape, dtype=np.float64)
    for x, n, height, crown in synthetic_trees(origin_en):
        e, nn = origin_en[0] + x, origin_en[1] + n
        reach = crown * math.sqrt(2.0)
        r0, q0 = lgrid.rowcol(e - reach, nn + reach)
        r1, q1 = lgrid.rowcol(e + reach, nn - reach)
        r0, q0 = max(int(r0), 0), max(int(q0), 0)
        r1, q1 = min(int(r1) + 1, lgrid.height), min(int(q1) + 1, lgrid.width)
        d = np.hypot(east[None, q0:q1] - e, north[r0:r1, None] - nn)
        z = np.where(d < reach, height * (1.0 - 0.5 * (d / crown) ** 2), 0.0)
        canopy[r0:r1, q0:q1] = np.maximum(canopy[r0:r1, q0:q1], z)
    rough = canopy > 0.5
    canopy[rough] += rng.normal(0.0, CANOPY_ROUGHNESS_M, int(rough.sum()))
    dom = np.maximum(dom, dtm + canopy)
    return lgrid, dom


def surface_chunks(level, chunkset, origin_en):
    """The synthetic surface model as a ChunkSet with the same chunks as the terrain."""
    lgrid, dom = surface_mosaic(level, chunkset, origin_en)
    out = ChunkSet()
    for i, j in chunkset:
        out[(i, j)] = lgrid.cut(dom, i, j).astype(np.float32)
    out.samples = len(out) * level.stored * level.stored
    return out


def synthetic_candidates(origin_en, radius):
    """Place-name candidates in grid coordinates, filtered as a real build filters them."""
    oe, on = origin_en
    cands = [Candidate(name=name, type=kind, e=oe + x, n=on + n, number=index)
             for index, (name, kind, x, n) in enumerate(PLACE_NAMES, start=1)]
    return keep_candidates(cands, oe, on, radius)


def synthetic_spot_heights(origin_en):
    """N50-style spot heights: whole metres at the hills' true tops."""
    out = []
    for hx, hn, _, _ in HILLS:
        top = height_local(hx, hn)
        out.append(SpotHeight(kind="Terrengpunkt", e=origin_en[0] + hx, n=origin_en[1] + hn,
                              h=float(math.floor(top + 0.5))))
    return out


def step_synthetic_map(ctx):
    """Fill ctx.map with the invented features, as the real build's fetch steps would."""
    m = inputs(ctx)
    m.kommuner = []
    m.areas = synthetic_areas(ctx.origin)
    m.lines = synthetic_lines(ctx.origin)
    m.spot_heights = synthetic_spot_heights(ctx.origin)
    m.building_points = synthetic_building_points(ctx.origin)
    m.trail_points = [InfoPoint(e=ctx.origin[0] + x, n=ctx.origin[1] + n, code=code)
                      for x, n, code in TRAIL_POINTS]
    outer = max(ctx.levels, key=lambda level: level.radius)
    m.place_candidates = synthetic_candidates(ctx.origin, outer.radius)
    h1 = next((level for level in ctx.levels if level.name == "h1"), None)
    if h1 is not None and ctx.chunks.get("h1"):
        m.surface = surface_chunks(h1, ctx.chunks["h1"], ctx.origin)


SYNTHETIC_SOURCE = {
    "name": "Synthetic terrain, parcel and listing (commons_world/synthetic.py)",
    "publisher": "Commons World pipeline",
    "licence": "n/a: generated test data",
}
SYNTHETIC_CREDIT = "Synthetic test world: generated by the Commons World pipeline. No real data."


def step_synthetic(ctx):
    """Set up everything a real build would have fetched, from the functions above."""
    ctx.synthetic = True
    ctx.listing = synthetic_listing()
    ctx.world_id = SYNTHETIC_ID
    e, n = geo.to_grid(ORIGIN_LAT, ORIGIN_LON, EPSG)
    set_origin(ctx, e, n)
    ctx.geocode_record = {
        "source": "synthetic (commons_world/synthetic.py)", "lat": ORIGIN_LAT,
        "lon": ORIGIN_LON, "epsg": EPSG, "e": round(e, 2), "n": round(n, 2),
        "property": "synthetic", "placement_verified": None,
    }
    polygon = parcel_polygon(ctx.origin)
    ctx.parcels = [Parcel(polygon=polygon, accuracy_class="Gult", teig_id=1, main=True)]
    ctx.register_areas = {1: round(polygon.area, 1)}
    ctx.plot_source = "Synthetic test parcel (commons_world/synthetic.py); no real data"
    ctx.terrain_source = terrain_source(ctx.origin)
    ctx.add_source(SYNTHETIC_SOURCE)
    ctx.add_credit(SYNTHETIC_CREDIT)


def core_synthetic_pipeline():
    """A fresh copy of the synthetic build, with no registered extras."""
    return Pipeline("synthetic", [
        Step("synthetic", step_synthetic),
        Step("plot", step_plot),
        Step("terrain_fetch", step_terrain_fetch),
        Step("synthetic_map", step_synthetic_map),
    ] + [Step(name, fn) for name, fn in SHARED_STEPS] + [
        Step("terrain", step_terrain),
        Step("listing", step_listing),
        Step("manifest", step_manifest),
    ])


SYNTHETIC = core_synthetic_pipeline()
PIPELINES["synthetic"] = SYNTHETIC


def build_synthetic(out_dir, *, levels=grid.LEVELS, generated_at=GENERATED_AT, commit=None,
                    pipeline=None, log=None):
    """Write the synthetic world into `out_dir` (the world folder itself); return it."""
    out_dir = Path(out_dir)
    staging = _staging_dir(out_dir.parent, out_dir.name)
    ctx = BuildContext(work_dir=staging, out_dir=out_dir, levels=levels,
                       vertical="none (synthetic heights; sea at 0 m)",
                       generated_at=generated_at, commit=commit, synthetic=True, log=log)
    return run_pipeline(pipeline or SYNTHETIC, ctx)
