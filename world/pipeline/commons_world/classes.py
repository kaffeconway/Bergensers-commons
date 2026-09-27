"""The land-cover class band (band 2 of a CWH1 chunk) for every chunk of every level.

Each level is rasterised once, on a LevelGrid over all of its chunks, and the
build's class_source then cuts each chunk's 242 x 242 window out of it. Codes
and rules are world/FORMAT.md section 3.

Precedence, lowest first (a later tier overwrites an earlier one):
1. sea: the sample's height is <= 0 m (after rounding to 0.1 m, as the codec
   rounds);
2. land-cover polygons (N50 Arealdekke). N50's sea polygons (Havflate) are
   painted only where the terrain is at or below 0 m, so they never put sea
   on dry ground;
3. lakes and rivers: lake and river polygons, and at h1 streams as 2 m lines;
4. roads and paths, painted paths first, then footways, then roads, so a
   pedestrian crossing never cuts a road;
5. building footprints, h1 only (added by commons_world.buildings);
6. finally, every sample at or below 0 m that is not a lake or river is set back
   to sea. N50 polygons are generalised, so along the shore they overlap the
   water; without this a sea sample could carry "forest" and the viewer would
   have to second-guess the band;
7. h1 only, after the footprints: forest only where trees stand
   (forest_correction, run by commons_world.mapsteps). N50 draws its forest for
   1:50 000, so a lawn, a garden or a clearing inside a forest polygon comes out
   as forest. A forest cell with no tree in the 1 m surface model near it
   becomes open land. Only forest changes, and only to open land. h5 and h20
   keep N50's classes: the surface model is fetched for h1 only.

What each level carries:
- h1: every road (6 m), footway (3 m) and path (2 m), buffered to that
  nominal width around its centre line. A cell is painted when its centre
  falls inside the buffer;
- h5: driveable roads only;
- h20: only roads of NVDB vegkategori E, R and F.
At h5 and h20 a road is drawn as a one-cell-wide line through every cell its
centre line touches, since a 6 m road is narrower than one cell.

Lines that are not on the ground surface: tunnels and other underground or
in-building lines (SOSI medium U, B, J) are not drawn at all. Bridges and
lines on water (medium L, S, V) are drawn only over cells that are neither
lake nor sea, so a bridge never paints a road across the water.
"""

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from shapely.geometry import box

from .raster import LevelGrid

OPEN, FOREST, BOG, FARMLAND, LAKE, SEA, BUILT_UP = 0, 1, 2, 3, 4, 5, 6
ROAD, FOOTWAY, PATH, ROCK, SNOW, BUILDING, GRAVEL = 7, 8, 9, 10, 11, 12, 13
CODES = tuple(range(14))
KIND_CODES = {"road": ROAD, "footway": FOOTWAY, "path": PATH}
WIDTHS_M = {"road": 6.0, "footway": 3.0, "path": 2.0, "stream": 2.0}
PAINT_ORDER = ("path", "footway", "road")
H20_CATEGORIES = ("E", "R", "F")
SKIP_MEDIA = ("U", "B", "J")
OVER_LAND_MEDIA = ("L", "S", "V")
_NONE = 255

# The forest correction (h1 only; FORMAT.md section 3; see forest_correction).
CANOPY_MIN_M = 3.0      # surface this far above the terrain, and not a roof, is a tree
CANOPY_FRINGE_M = 2.0   # a forest cell this close to a tree stays forest (crown edge, small gap)
MIN_OPEN_M2 = 25.0      # a patch of samples with no tree within the fringe, inside forest and
                        # smaller than this, stays forest (speckle): gaps up to about 8 m across
SURFACE_GAP_M = 1.0     # a surface this far below the terrain is a hole (nodata reads 0 m)


def level_rule(level):
    """"h1", "h5" or "h20": which of FORMAT.md's rules a level follows (by name, else cell)."""
    if level.name in ("h1", "h5", "h20"):
        return level.name
    if level.cell <= 1:
        return "h1"
    return "h5" if level.cell <= 5 else "h20"


def sea_mask(heights):
    """Samples at or below 0 m after rounding to whole decimetres (NaN is not sea)."""
    h = np.asarray(heights, dtype=np.float64)
    with np.errstate(invalid="ignore"):
        return np.isfinite(h) & (np.floor(h * 10.0 + 0.5) <= 0)


def _rasterize(shapes, grid, all_touched=False):
    """Boolean mask of the cells the shapes cover on `grid`."""
    from rasterio.features import rasterize

    shapes = [s for s in shapes if s is not None and not s.is_empty]
    if not shapes:
        return np.zeros(grid.shape, dtype=bool)
    burned = rasterize([(s, 1) for s in shapes], out_shape=grid.shape, transform=grid.transform,
                       fill=0, all_touched=all_touched, dtype="uint8")
    return burned.astype(bool)


def _paint_codes(cls, items, grid):
    """Paint (code, geometry) pairs in order; later ones win."""
    from rasterio.features import rasterize

    items = [(g, int(c)) for c, g in items if g is not None and not g.is_empty]
    if not items:
        return
    burned = rasterize(items, out_shape=grid.shape, transform=grid.transform, fill=_NONE,
                       all_touched=False, dtype="uint8")
    painted = burned != _NONE
    cls[painted] = burned[painted]


def lines_for_level(lines, rule):
    """The road and path lines a level draws, by FORMAT.md's rules, as {kind: [Line]}."""
    out = {kind: [] for kind in PAINT_ORDER}
    for line in lines:
        if line.kind not in KIND_CODES or (line.medium or "T") in SKIP_MEDIA:
            continue
        if rule == "h5" and line.kind != "road":
            continue
        if rule == "h20" and (line.kind != "road" or line.category not in H20_CATEGORIES):
            continue
        out[line.kind].append(line)
    return out


@dataclass
class LevelClasses:
    """One level's class raster and how it was made."""

    grid: LevelGrid
    classes: np.ndarray
    stats: dict = field(default_factory=dict)


def rasterise_level(level, grid, heights, areas=(), lines=(), buildings=()):
    """The class raster for one level. `heights` is the level's height mosaic on `grid`.

    `areas` are n50.Area (code, tier, polygon); `lines` are n50.Line (roads,
    footways, paths, streams); `buildings` are footprint polygons (h1 only).
    """
    rule = level_rule(level)
    frame = box(*grid.bounds)
    cls = np.full(grid.shape, OPEN, dtype=np.uint8)
    sea = sea_mask(heights)
    cls[sea] = SEA

    def near(geom):
        return geom.intersects(frame)

    landcover = [a for a in areas if a.tier == "landcover" and near(a.polygon)]
    sea_areas = [a.polygon for a in areas if a.tier == "sea" and near(a.polygon)]
    water = [a for a in areas if a.tier == "water" and near(a.polygon)]
    if sea_areas:
        cls[_rasterize(sea_areas, grid) & sea] = SEA
    _paint_codes(cls, [(a.code, a.polygon) for a in landcover], grid)
    _paint_codes(cls, [(a.code, a.polygon) for a in water], grid)
    stream_cells = 0
    if rule == "h1":
        streams = [line.geometry() for line in lines
                   if line.kind == "stream" and (line.medium or "T") not in SKIP_MEDIA]
        streams = [s.buffer(WIDTHS_M["stream"] / 2.0, quad_segs=4) for s in streams if near(s)]
        mask = _rasterize(streams, grid)
        stream_cells = int(mask.sum())
        cls[mask] = LAKE
    is_water = (cls == LAKE) | (cls == SEA)
    drawn = {}
    for kind, kind_lines in lines_for_level(lines, rule).items():
        normal, over_land = [], []
        for line in kind_lines:
            geom = line.geometry()
            if not near(geom):
                continue
            if rule == "h1":
                geom = geom.buffer(WIDTHS_M[kind] / 2.0, quad_segs=4)
            (over_land if (line.medium or "T") in OVER_LAND_MEDIA else normal).append(geom)
        all_touched = rule != "h1"
        mask = _rasterize(normal, grid, all_touched)
        if over_land:
            mask |= _rasterize(over_land, grid, all_touched) & ~is_water
        cls[mask] = KIND_CODES[kind]
        drawn[kind] = len(normal) + len(over_land)
    if buildings:
        if rule != "h1":
            raise ValueError("building footprints belong to h1 only")
        cls[_rasterize(buildings, grid)] = BUILDING
    overlapped = sea & (cls != SEA) & (cls != LAKE)
    land_on_sea = int(overlapped.sum())
    cls[overlapped] = SEA
    counts = np.bincount(cls.ravel(), minlength=len(CODES))
    stats = {
        "rule": rule,
        "cells": int(cls.size),
        "class_cells": {str(c): int(counts[c]) for c in CODES if counts[c]},
        "areas_drawn": {"landcover": len(landcover), "water": len(water), "sea": len(sea_areas)},
        "lines_drawn": drawn,
        "stream_cells": stream_cells,
        "land_classes_reset_to_sea": land_on_sea,
    }
    return LevelClasses(grid=grid, classes=cls, stats=stats)


def forest_correction(classes, dtm, dom, cell=1.0):
    """The forest cells with no tree near them, as (mask, stats). Changes nothing itself.

    `classes` is a level's class raster with the building footprints already
    painted (12); `dtm` and `dom` are the terrain and surface models on the same
    grid, NaN where there is none.

    - A tree is a cell whose surface stands at least CANOPY_MIN_M above the
      terrain, outside every footprint grown by one cell, so a roof and its eaves
      never count as a tree. Roof candidates without a register point do count:
      canopy can be flat enough to pass the roof test (commons_world.buildings
      drops those candidates for the same reason), and taking them for roofs
      would open holes in a stand.
    - A hole in the surface model (NaN, or more than SURFACE_GAP_M below the
      terrain, which is how nodata stored as 0 m reads) counts as a tree:
      missing data is not evidence of open ground.
    - A forest cell is a candidate when no tree or hole lies within
      CANOPY_FRINGE_M of its centre, so crown edges below CANOPY_MIN_M and gaps
      up to twice that wide inside a stand stay forest.
    - A candidate opens (becomes open land) when its 8-connected patch of
      candidates covers at least MIN_OPEN_M2, so a lone gap inside a stand does
      not speckle, or when the patch touches land of another class (anything
      but forest, lake, river and sea): a treeless sliver between a road and a
      footway, or along a lawn, is the open ground next to it, not a gap.

    Only forest cells are ever opened, never a cell with no terrain height.
    """
    cls = np.asarray(classes)
    dtm = np.asarray(dtm, dtype=np.float64)
    dom = np.asarray(dom, dtype=np.float64)
    if cls.shape != dtm.shape or dom.shape != dtm.shape:
        raise ValueError("classes, terrain and surface must share one grid")
    ground = np.isfinite(dtm)
    with np.errstate(invalid="ignore"):
        surface = ground & np.isfinite(dom) & (dom >= dtm - SURFACE_GAP_M)
        high = surface & (dom - dtm >= CANOPY_MIN_M)
    roofs = ndimage.binary_dilation(cls == BUILDING, structure=np.ones((3, 3), dtype=bool))
    trees = high & ~roofs
    holes = ground & ~surface
    reach = int(np.floor(CANOPY_FRINGE_M / cell + 1e-9))
    offsets = np.arange(-reach, reach + 1, dtype=np.float64) * cell
    disk = offsets[:, None] ** 2 + offsets[None, :] ** 2 <= CANOPY_FRINGE_M ** 2 + 1e-9
    near = ndimage.binary_dilation(trees | holes, structure=disk)
    forest = (cls == FOREST) & ground
    candidate = forest & ~near
    eight = np.ones((3, 3), dtype=bool)
    labels, count = ndimage.label(candidate, structure=eight)
    big = np.bincount(labels.ravel(), minlength=count + 1) * (cell * cell) >= MIN_OPEN_M2
    other = ground & ~np.isin(cls, (FOREST, LAKE, SEA))
    edge = np.zeros(count + 1, dtype=bool)
    edge[labels[ndimage.binary_dilation(other, structure=eight) & (labels > 0)]] = True
    opens = big | edge
    opens[0] = False
    opened = opens[labels]
    stats = {
        "forest_cells": int(forest.sum()),
        "forest_to_open": int(opened.sum()),
        "open_patches": int(opens.sum()),
        "small_patches_opened_at_edges": int((edge & ~big)[1:].sum()),
        "small_patches_kept": int(count - opens.sum()),
        "small_patch_cells_kept": int((candidate & ~opened).sum()),
        "surface_hole_cells": int(holes.sum()),
        "canopy_min_m": CANOPY_MIN_M,
        "fringe_m": CANOPY_FRINGE_M,
        "min_open_m2": MIN_OPEN_M2,
    }
    return opened, stats


class ClassBand:
    """Every level's class raster, and the class_source the build writes chunks with."""

    def __init__(self):
        self.levels = {}

    def add(self, level, level_classes):
        self.levels[level.name] = level_classes

    def get(self, name):
        return self.levels.get(name)

    def add_buildings(self, level_name, footprints):
        """Paint building footprints (grid polygons) as class 12 on one level (h1)."""
        entry = self.levels.get(level_name)
        if entry is None or not footprints:
            return 0
        mask = _rasterize(footprints, entry.grid)
        entry.classes[mask] = BUILDING
        entry.stats["building_cells"] = int(mask.sum())
        return int(mask.sum())

    def correct_forest(self, level_name, dtm, dom):
        """Open one level's forest cells where the surface model shows no tree; the stats."""
        entry = self.levels.get(level_name)
        if entry is None:
            return None
        opened, stats = forest_correction(entry.classes, dtm, dom, entry.grid.cell)
        entry.classes[opened] = OPEN
        entry.stats["forest_correction"] = stats
        return stats

    def source(self, level, i, j, heights):
        """ctx.class_source: chunk (i, j)'s window of the level's class raster, or None."""
        entry = self.levels.get(level.name)
        if entry is None:
            return None
        return entry.grid.cut(entry.classes, i, j)

    def stats(self):
        out = {}
        for name, entry in self.levels.items():
            counts = np.bincount(entry.classes.ravel(), minlength=len(CODES))
            record = dict(entry.stats)
            record["class_cells"] = {str(c): int(counts[c]) for c in CODES if counts[c]}
            out[name] = record
        return out


def build_class_band(levels, chunks, areas, lines):
    """Rasterise every level in `levels` that has chunks; return a ClassBand."""
    band = ClassBand()
    for level in levels:
        chunkset = chunks.get(level.name)
        if not chunkset:
            continue
        grid = LevelGrid(level, list(chunkset))
        heights = grid.assemble(chunkset, dtype=np.float64)   # as the codec will round them
        band.add(level, rasterise_level(level, grid, heights, areas, lines))
    return band
