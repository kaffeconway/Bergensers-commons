"""Map features for a real Norwegian build, from Kartverket's open data only.

The command line imports this module for `build` (build.PLUGIN_MODULES), which
registers these steps between "terrain_fetch" and "terrain":

    kommuner -> n50 -> roads -> trails -> building_points -> surface -> place_names
             -> classes -> buildings -> trees -> places -> map_stats

The first seven fetch, through ctx.client only (host allowlist, robots.txt,
rate limit, disk cache), and fill ctx.map; the last five are the shared steps
of commons_world.mapsteps. No OpenStreetMap data is used.

Requests, for a world with levels h1 / h5 / h20 (all cached for a rebuild):
- kommuner: about two per municipality the h20 disk touches, plus sample
  points near a boundary (commons_world.download.kommuner_for_disk);
- n50 and roads: per municipality, one order and one file each, plus one
  area list per dataset;
- trails: one request per 1000 routes, and one per 1000 information points;
- building_points: one per 1000 register points within the h1 disk's square;
- surface: the same exportImage tiles as the h1 terrain, from the surface
  model (four tiles at the default 1.5 km radius);
- place_names: one per 5000 m query square and page of 500 names (16
  squares cover an 11 km disk).

If NVDB cannot be ordered or read for a municipality, that municipality's
roads and footways come from N50 Samferdsel instead, and the manifest's
warnings say so.
"""

import zipfile

from lxml import etree

from . import buildings as buildingslib
from . import download, n50, nvdb, trails
from . import places as placeslib
from . import terrain as terrainlib
from .build import BUILD, BuildError
from .gml import GMLError
from .http import HTTPError
from .mapsteps import SHARED_STEPS, inputs, level_named
from .raster import LevelGrid
from .sources import (CREDIT_KARTVERKET_MAP, CREDIT_SSR, DATASETS, SOURCE_BYGNINGSPUNKT,
                      SOURCE_KOMMUNEINFO, SOURCE_N50, SOURCE_NHM_DOM, SOURCE_NVDB,
                      SOURCE_STEDSNAVN, SOURCE_TURRUTER)

# Projections to ask for, most preferred first. Anything else is reprojected.
N50_PROJECTIONS = ("25832", "25833", "25835")
NVDB_PROJECTIONS = ("5972", "5973", "5975")
READ_ERRORS = (download.DownloadError, HTTPError, GMLError, etree.XMLSyntaxError,
               zipfile.BadZipFile)


def outer_level(ctx):
    """The level with the largest radius (h20 by default)."""
    return max(ctx.levels, key=lambda level: level.radius)


def clip_bounds(ctx):
    """(west, south, east, north) of the outer level's chunks: what map data is kept for."""
    level = outer_level(ctx)
    keys = list(ctx.chunks.get(level.name) or [])
    if not keys:
        raise BuildError("terrain_fetch has not run: no chunks for {}".format(level.name))
    return LevelGrid(level, keys).bounds


def fetch_preferred(client, uuid, kommune, projections, fmt="GML"):
    """Download one dataset for one municipality in the first projection it is offered in."""
    areas = download.area_list(client, uuid)
    entry, offered = download.offered(areas, kommune)
    if entry is None:
        raise download.DownloadError("dataset {} is not offered for kommune {}".format(
            uuid, kommune))
    for projection in projections:
        if fmt in offered.get(projection, set()):
            return projection, download.fetch(client, uuid, kommune, projection, fmt)
    raise download.DownloadError("dataset {} for kommune {} is not offered as {} in any of {}; "
                                 "offered: {}".format(uuid, kommune, fmt, projections,
                                                      {k: sorted(v) for k, v in offered.items()}))


def step_kommuner(ctx):
    m = inputs(ctx)
    radius = outer_level(ctx).radius
    lookup = download.kommuner_for_disk(ctx.client, ctx.origin[0], ctx.origin[1], radius,
                                        epsg=ctx.epsg)
    ctx.add_source(SOURCE_KOMMUNEINFO)
    m.kommuner = list(lookup.kommuner)
    m.stats["kommuner"] = lookup.stats()
    if not m.kommuner:
        ctx.warnings.append("No municipality was found within the world; there is no N50 or "
                            "NVDB data in it.")


def step_n50(ctx):
    m = inputs(ctx)
    clip = clip_bounds(ctx)
    files = []
    total = n50.N50Data()
    for kommune in m.kommuner:
        projection, downloaded = fetch_preferred(ctx.client, DATASETS["n50"]["uuid"], kommune,
                                                 N50_PROJECTIONS)
        data = n50.N50Data()
        for f in downloaded:
            n50.parse_zip(f.content, clip=clip, epsg=ctx.epsg, data=data)
            files.append({"name": f.name, "bytes": len(f.content), "projection": projection})
        m.n50_by_kommune[kommune] = data
        total.extend(data)
    m.areas += total.areas
    m.lines += [line for line in total.lines if line.kind in ("path", "stream")]
    m.spot_heights += total.spot_heights
    ctx.add_source(SOURCE_N50)
    ctx.add_credit(CREDIT_KARTVERKET_MAP)
    stats = total.stats()
    stats["files"] = files
    m.stats["n50"] = stats


def step_roads(ctx):
    m = inputs(ctx)
    clip = clip_bounds(ctx)
    files, fallbacks = [], []
    total = nvdb.NVDBData()
    for kommune in m.kommuner:
        try:
            projection, downloaded = fetch_preferred(ctx.client, DATASETS["nvdb"]["uuid"],
                                                     kommune, NVDB_PROJECTIONS)
            data = nvdb.NVDBData()
            for f in downloaded:
                nvdb.parse_zip(f.content, clip=clip, epsg=ctx.epsg, data=data)
                files.append({"name": f.name, "bytes": len(f.content), "projection": projection})
        except READ_ERRORS as exc:
            fallback = n50.roads(m.n50_by_kommune.get(kommune) or n50.N50Data())
            m.lines += fallback
            fallbacks.append({"kommune": kommune, "error": str(exc)[:300],
                              "n50_lines": len(fallback)})
            ctx.warnings.append("NVDB Vegnett Pluss could not be read for kommune {} ({}); its "
                                "roads and footways come from N50 Samferdsel instead."
                                .format(kommune, type(exc).__name__))
            continue
        total.extend(data)
    m.lines += total.lines
    if files:
        ctx.add_source(SOURCE_NVDB)
    if fallbacks:
        ctx.add_source(SOURCE_N50)
    stats = total.stats()
    stats["files"] = files
    stats["n50_fallback"] = fallbacks
    m.stats["roads"] = stats


def step_trails(ctx):
    m = inputs(ctx)
    data = trails.fetch(ctx.client, clip_bounds(ctx), epsg=ctx.epsg)
    m.lines += data.routes
    m.trail_points += data.points
    ctx.add_source(SOURCE_TURRUTER)
    m.stats["trails"] = data.stats()


def step_building_points(ctx):
    m = inputs(ctx)
    h1 = level_named(ctx, "h1")
    if h1 is None:
        return
    oe, on = ctx.origin
    bounds = (oe - h1.radius, on - h1.radius, oe + h1.radius, on + h1.radius)
    points, requests = buildingslib.fetch_points(ctx.client, bounds, epsg=ctx.epsg)
    m.building_points += points
    ctx.add_source(SOURCE_BYGNINGSPUNKT)
    m.stats["building_points"] = {"points": len(points), "requests": requests}


def step_surface(ctx):
    m = inputs(ctx)
    h1 = level_named(ctx, "h1")
    if h1 is None:
        return
    m.surface = terrainlib.level_chunks(ctx.client, h1, ctx.origin[0], ctx.origin[1],
                                        service=terrainlib.DOM_SERVICE)
    ctx.add_source(SOURCE_NHM_DOM)
    m.stats["surface"] = {"tiles": m.surface.tiles,
                          "nodata_fraction": round(float(m.surface.nodata_fraction), 6)}


def step_place_names(ctx):
    m = inputs(ctx)
    radius = outer_level(ctx).radius
    search = placeslib.fetch_names(ctx.client, ctx.origin[0], ctx.origin[1], radius,
                                   epsg=ctx.epsg)
    m.place_candidates += search.candidates
    ctx.add_source(SOURCE_STEDSNAVN)
    ctx.add_credit(CREDIT_SSR)
    m.stats["places"] = search.stats()


FETCH_STEPS = (
    ("kommuner", step_kommuner),
    ("n50", step_n50),
    ("roads", step_roads),
    ("trails", step_trails),
    ("building_points", step_building_points),
    ("surface", step_surface),
    ("place_names", step_place_names),
)
STEPS = FETCH_STEPS + SHARED_STEPS


def install(pipeline):
    """Register every map-feature step into `pipeline`, just before "terrain"."""
    for name, fn in STEPS:
        pipeline.register(name, fn, before="terrain")
    return pipeline


if "classes" not in BUILD.names():
    install(BUILD)
