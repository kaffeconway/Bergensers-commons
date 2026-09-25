"""The map-feature steps shared by the real build and the synthetic one.

They run between "terrain_fetch" and "terrain", in this order, and read their
inputs from ctx.map (a MapInputs):

    classes -> buildings -> trees -> places -> map_stats

- classes: rasterises every level's class band (commons_world.classes) and
  sets ctx.class_source, so "terrain" writes each chunk with band 2;
- buildings: footprints from the h1 surface model, anchored to register
  points, with roof planes fitted to the same model (commons_world.roofs),
  written to buildings.json.gz and painted into the h1 class band;
- trees: canopy tops within the h1 radius, written to trees.bin.gz. Building
  footprints and every roof candidate (registered or not), grown by a cell,
  and lake and sea cells are excluded;
- places: named terrain features with heights from the chunks, places.json;
- map_stats: what was used and made, into manifest.stats["map"].

The real build fills ctx.map from Kartverket (commons_world.features); the
synthetic build fills it from invented shapes (commons_world.synthetic). No
step here touches the network.
"""

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from . import buildings as buildingslib
from . import classes as classeslib
from . import places as placeslib
from . import roofs as roofslib
from . import trees as treeslib
from .raster import LevelGrid


@dataclass
class MapInputs:
    """Everything the map steps draw from, in the world's grid."""

    kommuner: list = field(default_factory=list)
    areas: list = field(default_factory=list)            # n50.Area
    lines: list = field(default_factory=list)            # n50.Line: roads, paths, streams
    spot_heights: list = field(default_factory=list)     # n50.SpotHeight
    building_points: list = field(default_factory=list)  # n50.BuildingPoint
    trail_points: list = field(default_factory=list)     # trails.InfoPoint
    place_candidates: list = field(default_factory=list) # places.Candidate
    surface: object = None                               # h1 ChunkSet of DOM heights
    n50_by_kommune: dict = field(default_factory=dict)   # kommunenummer -> n50.N50Data
    stats: dict = field(default_factory=dict)


def inputs(ctx):
    """ctx.map, created empty on first use."""
    if getattr(ctx, "map", None) is None:
        ctx.map = MapInputs()
    return ctx.map


def level_named(ctx, name):
    for level in ctx.levels:
        if level.name == name:
            return level
    return None


def address_point(ctx):
    """The geocoded address point in the grid (unrounded if known), else the origin."""
    record = ctx.geocode_record or {}
    if record.get("e") is not None and record.get("n") is not None:
        return float(record["e"]), float(record["n"])
    return float(ctx.origin[0]), float(ctx.origin[1])


def step_classes(ctx):
    m = inputs(ctx)
    band = classeslib.build_class_band(ctx.levels, ctx.chunks, m.areas, m.lines)
    ctx.class_band = band
    ctx.class_source = band.source


def step_buildings(ctx):
    m = inputs(ctx)
    h1 = level_named(ctx, "h1")
    if h1 is None or not ctx.chunks.get("h1") or m.surface is None:
        m.stats["buildings"] = {"skipped": "no h1 level or no surface model"}
        return
    grid = LevelGrid(h1, list(ctx.chunks["h1"]))
    dtm = grid.assemble(ctx.chunks["h1"])
    dom = grid.assemble(m.surface)
    dom = np.where(np.isfinite(dom), dom, dtm)
    oe, on = ctx.origin
    found, stats, labels = buildingslib.segment(dom, dtm, grid, m.building_points,
                                                within=(oe, on, h1.radius), return_labels=True)
    stats["house"] = buildingslib.choose_house(found, [p.polygon for p in ctx.parcels],
                                               address_point(ctx))
    shapes = None
    if roofslib.FIT:
        shapes, stats["roofs"] = roofslib.fit_all(found, dom, dtm, grid, labels, ctx.origin)
    record = buildingslib.buildings_record(found, ctx.origin, shapes)
    ids = [f["id"] for f in record["features"] if f["house"]]
    stats["house"]["id"] = ids[0] if ids else None
    ctx.write_json("buildings", "buildings.json.gz", record, gz=True)
    footprints = [b.polygon for b in found]
    band = getattr(ctx, "class_band", None)
    if band is not None:
        stats["footprint_cells"] = band.add_buildings("h1", footprints)
    ctx.h1_surface = buildingslib.H1Surface(grid=grid, dtm=dtm, dom=dom, footprints=footprints,
                                            roofs=labels > 0)
    m.stats["buildings"] = stats


def _tree_exclusion(ctx, surface):
    band = getattr(ctx, "class_band", None)
    entry = band.get("h1") if band is not None else None
    if entry is not None:
        cls = entry.classes
        buildings = cls == classeslib.BUILDING
        water = (cls == classeslib.LAKE) | (cls == classeslib.SEA)
    else:
        buildings = classeslib._rasterize(surface.footprints, surface.grid)
        water = classeslib.sea_mask(surface.dtm)
    if surface.roofs is not None:
        buildings = buildings | surface.roofs    # an unregistered roof is still not a tree
    buildings = ndimage.binary_dilation(buildings, structure=np.ones((3, 3), dtype=bool))
    return buildings | water


def step_trees(ctx):
    m = inputs(ctx)
    surface = getattr(ctx, "h1_surface", None)
    if surface is None:
        m.stats["trees"] = {"skipped": "no h1 surface model"}
        return
    h1 = level_named(ctx, "h1")
    oe, on = ctx.origin
    found, stats = treeslib.find_trees(surface.ndsm, surface.dtm, surface.grid,
                                       exclude=_tree_exclusion(ctx, surface),
                                       within=(oe, on, h1.radius))
    entry = ctx.write_file("trees", "trees.bin.gz", treeslib.encode_gz(found, ctx.origin))
    stats["bytes"] = entry["bytes"]
    m.stats["trees"] = stats


def step_places(ctx):
    m = inputs(ctx)
    found = placeslib.sample_heights(m.place_candidates, ctx.chunks, ctx.levels)
    ctx.write_json("places", "places.json", placeslib.places_record(found, ctx.origin))
    by_level = {}
    for p in found:
        by_level[p.level] = by_level.get(p.level, 0) + 1
    stats = dict(m.stats.get("places") or {})
    stats.update({"places": len(found), "by_level": dict(sorted(by_level.items())),
                  "max_offset_m": round(max((p.offset_m for p in found), default=0.0), 1),
                  "spot_height_check": placeslib.spot_height_check(found, m.spot_heights)})
    m.stats["places"] = stats


def step_map_stats(ctx):
    m = inputs(ctx)
    kinds = {}
    for line in m.lines:
        key = "{}:{}".format(line.source, line.kind)
        kinds[key] = kinds.get(key, 0) + 1
    record = {
        "inputs": {"kommuner": list(m.kommuner), "areas": len(m.areas),
                   "lines_by_source_and_kind": dict(sorted(kinds.items())),
                   "spot_heights": len(m.spot_heights),
                   "building_points": len(m.building_points),
                   "trail_points": len(m.trail_points),
                   "place_candidates": len(m.place_candidates)},
    }
    record.update(m.stats)
    band = getattr(ctx, "class_band", None)
    if band is not None:
        record["classes"] = band.stats()
    ctx.stats["map"] = record


SHARED_STEPS = (
    ("classes", step_classes),
    ("buildings", step_buildings),
    ("trees", step_trees),
    ("places", step_places),
    ("map_stats", step_map_stats),
)
