"""Step 4: the measured facts (facts.json, world/FORMAT.md section 4).

    python -m commons_world facts --world DIR [--offline] [--cache DIR] [--compare-pvgis CSV]

Three blocks, each with a `method` string and a `caveats` list:
- plot:   slope and flat ground on the registered parcel (facts/slope.py);
- sun:    horizons (facts/horizon.py) and clear-sky direct-sun hours
          (facts/sun.py) for the whole plot, a garden point and a flat
          horizon, with the plot's sun map for 21 December and the sun's
          path on both solstices;
- access: named peaks within 15 km, walking routes to them and the nearest
          trailheads (facts/access.py).

The same code runs in two ways:
- as the build step "facts", registered just before "manifest" when this
  module is imported (build.PLUGIN_MODULES lists it, like
  commons_world.features), so a full build writes facts.json and lists it
  in the manifest; the synthetic command builds with `synthetic_pipeline()`;
- on a finished world folder (`run`), which writes facts.json, adds it to
  manifest.json with its size and sha256, adds its sources, rewrites
  NOTICE.txt and checks the world again.

What a world folder does not hold is fetched through the pipeline's HTTP
client only, or computed for the synthetic world (facts/providers.py).
Nothing from PVGIS is ever stored: --compare-pvgis prints its comparison
and nothing else.
"""

import json
import math
import os
import tempfile
import time
from pathlib import Path

import numpy as np

from ..build import BUILD, BuildError, Pipeline, default_generated_at

FACTS_NAME = "facts.json"
FACTS_VERSION = 1
NETWORK_RADIUS_M = 15000.0
L10_HALF_M = 15000.0
L50_HALF_M = 50000.0
# The highest ground in Norway (Galdhoepiggen, 2469 m). The terrain service covers
# Norway only and answers nodata elsewhere, so nothing it returns can be higher.
HIGHEST_GROUND_M = 2469.0
SUN_CELL_M = 2
DOM_MARGIN_M = 205


SYNTHETIC_CAVEAT = ("This is the synthetic test world: its terrain, surface, names and paths are "
                    "made up, and no Kartverket data is used. The method describes what a real "
                    "world is measured from.")


class FactsError(BuildError):
    """The facts could not be computed or written, for a reason the message explains."""


# -- the sun block's text ----------------------------------------------------------------

SUN_METHOD = (
    "Clear-sky potential direct sun. Sun positions: NREL's Solar Position Algorithm "
    "(pvlib, nrel_numpy), apparent elevation of the sun's centre (with refraction), every "
    "minute of {year} (UTC days). A minute counts when the sun's centre is above the "
    "horizon at its true azimuth. Horizons: rays every 0.5 deg of true bearing from an eye "
    "1.5 m above the terrain; terrain sampled (bilinear) on 1 m to 200 m, 10 m to 10 km, "
    "50 m to 50 km and 100 m beyond, out to where nothing in the region could rise 0.25 "
    "deg above a flat horizon ({reach} km here); curvature and refraction lower terrain "
    "by d^2 (1 - 0.13) / 2R. With canopy: the first 200 m use the 1 m surface model "
    "(trees and buildings) instead of the terrain. Plot median: over 2 m cells inside the "
    "registered parcel and not under a building; terrain_canopy_open_ground is the same "
    "with canopy, over only the cells whose surface stands within 2 m of the terrain "
    "(open_ground_cells of them). Garden point: the centre of the largest circle that fits "
    "inside the largest patch under 5 deg. Monthly figures are means over every day of the "
    "month.")

SUN_CAVEATS = (
    "Clear sky: weather is not included.",
    "The surface model's survey date and season are not known (leaf-on is inferred, not "
    "confirmed): bare deciduous trees in winter may block less than the canopy figures show.",
    "Trees and buildings count only within 200 m and inside the surface-model window around "
    "the plot; beyond that the horizon is bare terrain.",
    "Kartverket's terrain model covers Norway only; outside Norway, and at sea, heights are "
    "taken as 0 m.",
    "The 10, 50 and 100 m terrain is resampled by the server, which lowers sharp ridges and "
    "summits a little, so the far horizon errs low.",
    "For the plot's cells, terrain within 1 km is traced from each 2 m cell; beyond 1 km the "
    "horizon is traced once from the plot's centre and seen from each cell's own eye height.",
    "Refraction near the horizon changes with the weather; the sun's is pvlib's standard "
    "atmosphere and the terrain's uses k = 0.13.",
    "The sun counts as up when its centre clears the horizon, so its upper half can shine "
    "for a few minutes before and after.",
)

ACCESS_METHOD = (
    "Named peaks (Kartverket place names of types {types}) within 15 km of the house in a "
    "straight line; the nearest 5 and highest 5, heights re-measured on 1 m terrain: the "
    "highest ground in a 200 m square around the place's point that can be reached from it "
    "without dropping more than 2 m, if that is a top (the highest ground within 20 m all "
    "round); else the same within 30 m of the point; else, with no distinct top near the "
    "name, the height at the point itself (h_basis says which); h_places is the height before "
    "re-measuring: the highest sample within 30 m of the name, on the finest level the world "
    "stores there (places.json), or on 10 m terrain beyond the world's edge. Walking "
    "network: {network}; ferries, "
    "tunnels and lines in buildings left out, bridges kept (heights interpolated along the "
    "bridge); line ends within 2 m of another line joined, vertices within 2 m merged. Heights "
    "every 5 m: 1 m terrain within 1.5 km of the origin, 10 m beyond. Shortest route by "
    "length (Dijkstra) from the house, joined to the nearest point of the network. climb_m is "
    "the sum of rises; naismith_h = km / 5 + climb / 600; tobler_h integrates "
    "6 exp(-3.5 |slope + 0.05|) km/h. reaches_summit: the route ends within 50 m "
    "horizontally and 20 m in height of the summit. Trailheads: where a path, track or marked "
    "route leaving a road or footway leads onto at least 500 m of path, and Turrutebasen "
    "information points coded as parking; the 5 nearest by route, at least 50 m apart.")

ACCESS_CAVEATS = (
    "OpenStreetMap is not used: the network is Kartverket's (NVDB Vegnett Pluss, N50 paths, "
    "Turrutebasen), and paths missing from those are missing here.",
    "Climb is from 1 m terrain within 1.5 km of the origin and from 10 m terrain beyond; on "
    "the coarse terrain small ups and downs are smoothed away, so climb is understated.",
    "Every road counts as walkable, with or without a footway or verge; walking bans, "
    "private roads and motorways are not read.",
    "Routes are the shortest by length, not the quickest or easiest.",
    "A summit is the top of the ground a name sits on, which can be a neighbouring top "
    "joined to the named one by a shallow dip (under 2 m) rather than the one meant; "
    "h_basis flags a summit more than 50 m from the place's point.",
    "Naismith and Tobler describe a fit walker on a path in good conditions, with no stops; "
    "snow, season, daylight and the state of the path are not considered.",
    "Turrutebasen's facility code 22 is taken to mean parking; the codes are not documented.",
    "The route starts where the house joins the network and ends where the network passes "
    "closest to the summit; the steps off the network are not included.",
)


def _round_list(values, digits=2):
    return [round(float(v), digits) + 0.0 for v in values]


def _square(e0, n0, half, cell):
    from .horizon import square_bounds
    return square_bounds(e0, n0, half, cell)


def _layer(provider, bounds, cell, name, fill=0.0):
    from .horizon import Layer
    arr = provider.dtm(bounds, cell)
    nodata = float(np.isnan(arr).mean())
    arr = np.where(np.isfinite(arr), arr, fill).astype(np.float32)
    return Layer(arr, bounds[0], bounds[3], cell, name), nodata


# -- the computation ----------------------------------------------------------------------

def h20_squares(levels, origin):
    """(side, set of (i, j)): the world's h20 squares, land and sea, from its level records.

    Without an h20 record, grid.py's own inclusion rule for the h20 disk around the origin.
    """
    from .. import grid
    for record in levels or []:
        if isinstance(record, dict) and record.get("name") == "h20":
            side = int(record["cell"]) * int(record["chunk_samples"])
            keys = list(record.get("chunks") or {}) + list(record.get("sea") or [])
            return side, {tuple(int(v) for v in key.split("_")) for key in keys}
    level = grid.LEVELS_BY_NAME["h20"]
    return level.side, set(grid.chunks_for_disk(level, float(origin[0]), float(origin[1])))


def compute(view, provider, *, generated_at, log=lambda m: None, pvgis=None, sun_year=None,
            levels=None):
    """(facts dict, report dict) for a WorldView and a provider.

    `levels` are the world's manifest level records; they say where the drawn world ends
    for sun.horizon.beyond_world (grid.py's h20 disk when they are not given).
    """
    from . import access, horizon, slope, sun
    from .horizon import Band
    from .slope import raster_mask

    timings = {}
    report = {}
    started = time.monotonic()
    oe, on = view.origin
    offset = view.offset_deg

    # -- plot and slope ------------------------------------------------------------------
    t = time.monotonic()
    pw = slope.plot_window(view)
    dom_bounds = (pw[0] - DOM_MARGIN_M, pw[1] - DOM_MARGIN_M, pw[2] + DOM_MARGIN_M,
                  pw[3] + DOM_MARGIN_M)
    dom = provider.dom(dom_bounds)
    dtm_dom = np.asarray(slope.crop(view, view.dtm1, dom_bounds), dtype=np.float32)
    dom_nodata = float(np.isnan(dom).mean())
    dom = np.where(np.isfinite(dom), dom, dtm_dom)
    # The surface is never below the ground: where the surface model reads lower than the
    # stored terrain (noise, or the terrain's 0.1 m rounding) the terrain is used.
    dom = np.fmax(dom, dtm_dom)
    dom = np.where(np.isfinite(dom), dom, 0.0).astype(np.float32)
    dom_layer = horizon.Layer(dom, dom_bounds[0], dom_bounds[3], 1.0, "dom1")
    m = DOM_MARGIN_M
    dom_window = dom[m:dom.shape[0] - m, m:dom.shape[1] - m]
    plot_block, detail = slope.plot_facts(view, dom_window)
    timings["plot"] = time.monotonic() - t
    log("facts: plot done ({:.1f} s)".format(timings["plot"]))

    # -- rasters for horizons and routes -------------------------------------------------
    t = time.monotonic()
    h1_arr = np.where(np.isfinite(view.dtm1), view.dtm1, np.nan).astype(np.float32)
    h1_layer = horizon.Layer(h1_arr, view.h1.west, view.h1.north, view.h1.cell, "h1")
    l10, nd10 = _layer(provider, _square(oe, on, L10_HALF_M, 10), 10, "10m")
    l50, nd50 = _layer(provider, _square(oe, on, L50_HALF_M, 50), 50, "50m")

    # -- observers -----------------------------------------------------------------------
    w, s, e, n = view.parcel_union.bounds
    c2 = SUN_CELL_M
    west2 = math.floor(w / c2) * c2
    north2 = math.ceil(n / c2) * c2
    cols = int(math.ceil((e - west2) / c2))
    rows = int(math.ceil((north2 - s) / c2))
    in_plot = raster_mask(view.parcels, (rows, cols), west2, north2, c2)
    under = raster_mask([b.polygon for b in view.buildings], (rows, cols), west2, north2, c2)
    obs = in_plot & ~under
    rr, qq = np.nonzero(obs)
    ce = west2 + (qq + 0.5) * c2
    cn = north2 - (rr + 0.5) * c2
    ground = h1_layer.sample(ce, cn)
    eye = ground + horizon.EYE_M
    # open ground at a cell: surface within 2 m of the terrain over its 2 x 2 m block
    ndsm = dom - dtm_dom
    open_cell = np.ones(len(ce), dtype=bool)
    for dq in (-0.5, 0.5):
        for dn in (-0.5, 0.5):
            q = np.floor(ce + dq - dom_bounds[0]).astype(int)
            r = np.floor(dom_bounds[3] - (cn + dn)).astype(int)
            open_cell &= ~(ndsm[r, q] > slope.OPEN_GROUND_MAX_M)
    garden = detail["garden"]
    ge, gn = garden["e"], garden["n"]
    g_ground = float(h1_layer.sample(np.array([ge]), np.array([gn]))[0])
    g_eye = g_ground + horizon.EYE_M
    ref = view.parcel_union.centroid
    re_, rn_ = float(ref.x), float(ref.y)

    # -- reach: where nothing could still rise 0.25 deg ----------------------------------
    # The 100 m raster reaches as far as the highest ground the terrain service can
    # return (HIGHEST_GROUND_M) could still stand 0.25 deg above a flat horizon from the
    # lowest eye; within it, the highest ground actually found sets the rays' reach.
    eye_min = float(min(np.min(eye) if len(eye) else g_eye, g_eye))
    needed = horizon.reach_for_relief(HIGHEST_GROUND_M - eye_min)
    fetched_half = float(min(horizon.CAP_M,
                             max(L50_HALF_M, math.ceil((needed + 1000.0) / 1000.0) * 1000.0)))
    l100, nd100 = _layer(provider, _square(oe, on, fetched_half, 100), 100, "100m")
    timings["rasters"] = time.monotonic() - t
    log("facts: rasters done ({:.1f} s)".format(timings["rasters"]))
    t = time.monotonic()
    top = l100.max_within(re_, rn_, fetched_half)
    hmax = top[0] if top else 0.0
    reach = horizon.reach_for_relief(hmax - eye_min)
    reach = float(min(max(reach, horizon.MIN_REACH_M), horizon.CAP_M, fetched_half))
    reach = math.floor(reach / 100.0) * 100.0

    def far_bands(first10):
        return [Band(l10, first10, min(horizon.MID_M, reach), 10.0),
                Band(l50, horizon.MID_M + 50.0, min(horizon.FAR50_M, reach), 50.0),
                Band(l100, horizon.FAR50_M + 100.0, reach, 100.0)]

    near_t = Band(h1_layer, 1.0, horizon.NEAR_M, 1.0)
    near_c = Band(dom_layer, 1.0, horizon.NEAR_M, 1.0)

    # -- plot cells ----------------------------------------------------------------------
    if len(ce):
        tan_t, _ = horizon.cast(ce, cn, eye, [near_t], offset)
        tan_c, _ = horizon.cast(ce, cn, eye, [near_c], offset)
        tan_m, _ = horizon.cast(ce, cn, eye, [Band(l10, horizon.NEAR_M + 10.0,
                                                   horizon.PER_CELL_M, 10.0)], offset)
        lowered, dist = horizon.ray_samples(re_, rn_, far_bands(horizon.PER_CELL_M + 10.0),
                                            offset)
        tan_f = horizon.shared_far_tan(lowered, dist, eye)
        cells_t = horizon.to_degrees(np.maximum(np.maximum(tan_t, tan_m), tan_f))
        cells_c = horizon.to_degrees(np.maximum(np.maximum(tan_c, tan_m), tan_f))
    else:
        cells_t = cells_c = np.zeros((0, horizon.N_AZ))
    timings["horizon_cells"] = time.monotonic() - t
    log("facts: {} plot cells traced ({:.1f} s)".format(len(ce), timings["horizon_cells"]))

    # -- the garden point, traced all the way --------------------------------------------
    t = time.monotonic()
    rest = far_bands(horizon.NEAR_M + 10.0)
    gt, gd = horizon.cast([ge], [gn], [g_eye], [near_t] + rest, offset)
    gc, _ = horizon.cast([ge], [gn], [g_eye], [near_c] + rest, offset)
    garden_t = horizon.to_degrees(gt[0])
    garden_c = horizon.to_degrees(gc[0])
    # the same rays from the terrain beyond the drawn world only (the viewer's far gate)
    side20, squares20 = h20_squares(levels, view.origin)
    beyond_from = horizon.ray_exit_m(ge, gn, squares20, side20, offset)
    beyond_tan, beyond_d = horizon.beyond_profile(ge, gn, g_eye, rest, beyond_from, offset)
    report["garden_horizon_distance_m"] = gd[0]
    timings["horizon_garden"] = time.monotonic() - t

    # -- sun -----------------------------------------------------------------------------
    t = time.monotonic()
    year = sun_year or sun.SUN_YEAR
    altitude = float(np.nanmean(ground)) if len(ground) else g_ground
    sy = sun.SunYear(view.lat, view.lon, altitude=max(altitude, 0.0), year=year)
    profiles = [None, garden_t, garden_c] + list(cells_t) + list(cells_c)
    minutes = sy.daily_minutes(profiles)
    P = len(ce)
    cells_min_t = minutes[3:3 + P]
    cells_min_c = minutes[3 + P:3 + 2 * P]
    dec21 = sy.day_of[sun.DEC21]
    map_t = np.full((rows, cols), -1, dtype=np.int64)
    map_c = np.full((rows, cols), -1, dtype=np.int64)
    map_t[rr, qq] = cells_min_t[:, dec21]
    map_c[rr, qq] = cells_min_c[:, dec21]
    open_rows = cells_min_c[open_cell] if P else cells_min_c
    timings["sun"] = time.monotonic() - t
    log("facts: sun hours done ({:.1f} s)".format(timings["sun"]))

    def local(e_, n_):
        return round(e_ - oe, 1) + 0.0, round(-(n_ - on), 1) + 0.0

    gx, gz = local(ge, gn)
    sun_block = {
        "method": SUN_METHOD.format(year=year, reach=round(reach / 1000.0)),
        "caveats": list(SUN_CAVEATS),
        "year": year,
        "altitude_m": round(max(altitude, 0.0), 2),
        "days": "every day of each month, UTC calendar days",
        "astronomical": sy.summary(minutes[0]),
        "plot_median": {
            "cells": int(P), "cell_m": SUN_CELL_M,
            "terrain": sy.median_summary(cells_min_t),
            "terrain_canopy": sy.median_summary(cells_min_c),
            "terrain_canopy_open_ground": sy.median_summary(open_rows),
            "open_ground_cells": int(open_cell.sum()) if P else 0,
        },
        "garden_point": {
            "x": gx, "z": gz, "ground_m": round(g_ground, 1), "basis": garden["basis"],
            "terrain": sy.summary(minutes[1]), "terrain_canopy": sy.summary(minutes[2]),
        },
        "horizon": {
            "step_deg": horizon.STEP_DEG, "max_distance_m": reach,
            "observer": "garden point, eye 1.5 m above the terrain",
            "variant": "terrain only",
            "south_sector": [horizon.SOUTH_SECTOR_DEG[0], horizon.SOUTH_SECTOR_DEG[1]],
            "south_sector_mean_deg": round(horizon.sector_mean(garden_t), 2),
            "profile_deg": _round_list(garden_t),
            "profile_canopy_deg": _round_list(garden_c),
            "regional_max_m": round(hmax, 1),
            "coarse_raster_radius_m": fetched_half,
            "beyond_world": {
                "observer": "garden point, eye 1.5 m above the terrain",
                "from": "where each ray leaves the world's h20 squares (land and sea)",
                "from_m": [int(v) for v in beyond_from],
                "profile_deg": _round_list(horizon.to_degrees(beyond_tan)),
                "distance_m": [int(round(float(v))) for v in beyond_d],
            },
        },
        "plot_map": {
            "cell_m": SUN_CELL_M, "x0": round(west2 - oe, 1) + 0.0,
            "z0": round(-(north2 - on), 1) + 0.0, "cols": cols, "rows": rows,
            "anchor": "x0, z0 is the north-west corner of cell (0, 0); rows run north to "
                      "south; -1 is outside the parcel or under a building",
            "dec21_min_terrain": [int(v) for v in map_t.ravel()],
            "dec21_min_canopy": [int(v) for v in map_c.ravel()],
        },
        "sun_path": {
            "dec21": sun.sun_path(view.lat, view.lon, year, 12, 21, altitude=max(altitude, 0.0)),
            "jun21": sun.sun_path(view.lat, view.lon, year, 6, 21, altitude=max(altitude, 0.0)),
        },
    }
    sun_block["caveats"].append(
        "The rays stop at {:.0f} km: the 100 m terrain was read to {:.0f} km, as far as ground "
        "as high as Norway's highest point ({:.0f} m) could still stand 0.25 deg above a flat "
        "horizon; the service covers Norway only, so nothing higher can come from it."
        .format(reach / 1000.0, fetched_half / 1000.0, HIGHEST_GROUND_M))
    nodata = {"10m": nd10, "50m": nd50, "100m": nd100}
    if any(v > 0 for v in nodata.values()):
        sun_block["caveats"].append(
            "Nodata in the coarse terrain, taken as 0 m: {}.".format(", ".join(
                "{} {:.1%}".format(k, v) for k, v in nodata.items())))
    if dom_nodata > 0:
        sun_block["caveats"].append("{:.1%} of the surface model around the plot was nodata "
                                    "and taken as the terrain.".format(dom_nodata))

    # -- access --------------------------------------------------------------------------
    t = time.monotonic()
    net_inputs = provider.network(view, NETWORK_RADIUS_M)
    for c in net_inputs.extra_places:
        found = l10.max_within(c.e, c.n, 30.0)
        if found is not None:
            c.h, c.e, c.n = found
    net_inputs.extra_places = [c for c in net_inputs.extra_places if np.isfinite(c.h)]
    elevation = access.Elevation([(h1_layer, 1, access.H1_ELEVATION_RADIUS_M),
                                  (l10, 10, None), (l50, 50, None)], view.origin)
    access_block, _ = access.access_facts(view, provider, net_inputs, elevation, log)
    access_block = dict({"method": ACCESS_METHOD.format(
                             types=", ".join(access.PEAK_TYPES), network=net_inputs.label),
                         "caveats": list(ACCESS_CAVEATS) + list(net_inputs.warnings),
                         "network": net_inputs.label,
                         "peak_types": list(access.PEAK_TYPES)}, **access_block)
    timings["access"] = time.monotonic() - t
    log("facts: access done ({:.1f} s)".format(timings["access"]))

    if view.synthetic:
        # The methods name the sources a real world uses; say plainly that this one is not.
        for block in (plot_block, sun_block, access_block):
            block["caveats"] = [SYNTHETIC_CAVEAT] + list(block.get("caveats") or [])
    facts = {"version": FACTS_VERSION, "generated_at": generated_at,
             "plot": plot_block, "sun": sun_block, "access": access_block}

    # -- PVGIS: printed, never stored ----------------------------------------------------
    if pvgis is not None:
        report["pvgis"] = compare_pvgis(view, pvgis, h1_layer, l10, far_bands, offset)
    timings["total"] = time.monotonic() - started
    report["timings_s"] = {k: round(v, 1) for k, v in timings.items()}
    report["rasters"] = list(provider.rasters)
    report["network"] = net_inputs.stats
    report["reach_m"] = reach
    report["regional_max_m"] = hmax
    report["plot_cells"] = int(P)
    return facts, report


PVGIS_FROM_M = (200.0, 1000.0, 5000.0)


def compare_pvgis(view, path, h1_layer, l10, far_bands, offset):
    """Our horizon beyond 200 m at the PVGIS file's point, against the file's profile.

    The comparison is also printed for our horizon beyond 1 km and beyond 5 km, which
    shows whether a difference comes from near terrain or from distant mountains.
    """
    from . import horizon
    from .. import geo

    lat, lon, rows = horizon.read_pvgis_horizon(path)
    if lat is None or lon is None:
        e, n = float(view.origin[0]), float(view.origin[1])
        where = "origin (the file gives no position)"
    else:
        e, n = geo.to_grid(lat, lon, view.epsg)
        where = "the file's position"
    ground = h1_layer.sample(np.array([e]), np.array([n]))[0]
    if not np.isfinite(ground):
        ground = l10.sample(np.array([e]), np.array([n]))[0]
    result = {}
    for start in PVGIS_FROM_M:
        bands = [b for b in far_bands(start + 10.0) if b.first <= b.last]
        tan, dist = horizon.cast([e], [n], [ground + horizon.EYE_M], bands, offset)
        ours = horizon.to_degrees(tan[0])
        key = "beyond_{}m".format(int(start))
        result[key] = horizon.compare_profiles(ours, rows)
        if start == PVGIS_FROM_M[0]:
            b = result[key]["worst"]["true_bearing"]
            k = int(round(b / horizon.STEP_DEG)) % horizon.N_AZ
            result[key]["worst"]["ours_distance_m"] = float(dist[0, k])
    result["point"] = where
    result["offset_from_origin_m"] = round(math.hypot(e - view.origin[0], n - view.origin[1]), 1)
    result["ground_m"] = round(float(ground), 1)
    result["directions"] = len(rows)
    return result


def format_pvgis(result):
    """Human-readable lines for the PVGIS comparison (printed only)."""
    lines = ["PVGIS horizon comparison (ours minus PVGIS), at {}, {} m from the origin, ground "
             "{} m, {} directions:".format(result["point"], result["offset_from_origin_m"],
                                          result["ground_m"], result["directions"])]
    for start in PVGIS_FROM_M:
        r = result["beyond_{}m".format(int(start))]
        lines.append(" our horizon from terrain beyond {} m:".format(int(start)))
        for key in ("all", "north", "east", "south", "west"):
            s = r.get(key)
            if s:
                lines.append("  {:5s} n={:2d}  mean {:+.2f}  mean abs {:.2f}  max abs {:.2f}  "
                             "rmse {:.2f} deg".format(key, s["n"], s["mean_diff_deg"],
                                                       s["mean_abs_diff_deg"],
                                                       s["max_abs_diff_deg"], s["rmse_deg"]))
        w = r["worst"]
        lines.append("  largest difference at true {:.1f} deg: ours {:.2f}{}, PVGIS {:.2f}".format(
            w["true_bearing"], w["ours_deg"],
            " (terrain {:.0f} m away)".format(w["ours_distance_m"]) if "ours_distance_m" in w
            else "", w["theirs_deg"]))
    return lines


# -- running inside a build ----------------------------------------------------------------

def _provider_for(view, client, surface=None, log=None):
    from .providers import RealProvider, SyntheticProvider
    if view.synthetic:
        return SyntheticProvider(view.origin, view.h1_level, surface=surface)
    return RealProvider(client, epsg=view.epsg, log=log)


def _stats(report, client_counts=None):
    out = {"plot_cells": report["plot_cells"], "reach_m": report["reach_m"],
           "regional_max_m": round(report["regional_max_m"], 1),
           "rasters": report["rasters"], "network": report["network"]}
    if client_counts:
        out["http"] = client_counts
    return out


def step_facts(ctx):
    """Build step: compute facts.json from what the build has written so far."""
    from .world import WorldError, load_world

    record = {"id": ctx.world_id, "crs": ctx.crs, "levels": ctx.level_records,
              "files": ctx.files, "stats": ctx.stats}
    try:
        view = load_world(ctx.work_dir, record, synthetic=bool(ctx.synthetic))
    except WorldError as exc:
        ctx.warnings.append("Facts not computed: {}".format(exc))
        return
    surface = getattr(getattr(ctx, "map", None), "surface", None)
    provider = _provider_for(view, ctx.client, surface=surface, log=ctx.log)
    facts, report = compute(view, provider, generated_at=ctx.generated_at, log=ctx.log,
                            levels=ctx.level_records)
    ctx.write_json("facts", FACTS_NAME, facts)
    for source in provider.sources:
        ctx.add_source(source)
    ctx.stats["facts"] = _stats(report)


def install(pipeline):
    """Register "facts" in `pipeline`, just before "manifest"."""
    if "facts" not in pipeline.names():
        pipeline.register("facts", step_facts)
    return pipeline


def synthetic_pipeline():
    """A copy of the shared synthetic build with "facts" added (the shared one is untouched)."""
    from ..synthetic import SYNTHETIC
    return install(Pipeline("synthetic", list(SYNTHETIC.steps)))


install(BUILD)


# -- running on a finished world -------------------------------------------------------------

class CountingTransport:
    """Wraps a client's transport to count requests and bytes received, per host."""

    def __init__(self, inner):
        self.inner = inner
        self.requests = 0
        self.bytes = 0
        self.by_host = {}

    def __call__(self, method, url, headers, body, timeout):
        from urllib.parse import urlsplit
        status, resp_headers, content = self.inner(method, url, headers, body, timeout)
        host = urlsplit(url).hostname or ""
        size = len(content or b"")
        self.requests += 1
        self.bytes += size
        entry = self.by_host.setdefault(host, {"requests": 0, "bytes": 0})
        entry["requests"] += 1
        entry["bytes"] += size
        return status, resp_headers, content


def _atomic_write(path, data, mode=0o644):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, mode)       # mkstemp makes 0600; world files are world-readable
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _retrieved(record, fetch_log):
    record = dict(record)
    endpoint = record.get("endpoint")
    dates = sorted({e["fetched_at"][:10] for e in fetch_log
                    if endpoint and e["url"].startswith(endpoint) and e["fetched_at"]})
    if dates:
        record["retrieved"] = dates[0]
        if dates[-1] != dates[0]:
            record["retrieved_until"] = dates[-1]
    return record


def http_counts(client, counter):
    """What the client did in this run: requests, bytes received, responses, cache hits."""
    if client is None:
        return None
    out = {"responses": len(client.fetch_log),
           "from_cache": sum(1 for e in client.fetch_log if e["from_cache"]),
           "requests": client.requests_made}
    if counter is not None:
        out["bytes_received"] = counter.bytes
        out["by_host"] = {h: dict(v) for h, v in sorted(counter.by_host.items())}
    return out


def run(world_dir, client=None, *, log=lambda m: None, compare_pvgis=None, generated_at=None,
        counter=None):
    """Compute facts.json for a finished world, list it in the manifest, and check the world.

    Returns (facts, report). Raises FactsError if the finished world fails its check
    (the previous manifest, NOTICE and facts.json are put back).
    """
    from .. import gitguard, manifest as manifestlib
    from ..sources import CREDIT_KARTVERKET_MAP, CREDIT_SSR, SOURCE_STEDSNAVN
    from .world import WorldError, load_world

    folder = Path(world_dir)
    gitguard.check_destination(folder, "a world folder")
    try:
        view = load_world(folder)
    except (WorldError, KeyError) as exc:
        raise FactsError(str(exc)) from exc
    if not view.synthetic and client is None:
        raise FactsError("a real world needs the HTTP client for its facts")
    provider = _provider_for(view, client, log=log)
    manifest_path = folder / manifestlib.MANIFEST_NAME
    try:
        levels = json.loads(manifest_path.read_text(encoding="ascii")).get("levels")
    except (OSError, ValueError, AttributeError):
        levels = None
    facts, report = compute(view, provider, generated_at=generated_at or default_generated_at(),
                            log=log, pvgis=compare_pvgis, levels=levels)
    notice_path = folder / manifestlib.NOTICE_NAME
    facts_path = folder / FACTS_NAME
    old = {p: (p.read_bytes() if p.exists() else None)
           for p in (manifest_path, notice_path, facts_path)}
    manifest = json.loads(old[manifest_path].decode("ascii"))
    data = manifestlib.dumps_json(facts)
    fetch_log = client.fetch_log if client is not None else []
    names = {s.get("name") for s in manifest["sources"]}
    added = False
    for source in provider.sources:
        if source["name"] not in names:
            manifest["sources"].append(_retrieved(source, fetch_log))
            names.add(source["name"])
            added = True
    credits = list(manifest["credits"])
    if not view.synthetic:
        if SOURCE_STEDSNAVN in provider.sources and CREDIT_SSR not in credits:
            credits.append(CREDIT_SSR)
        if CREDIT_KARTVERKET_MAP not in credits and len(provider.sources) > 1:
            credits.append(CREDIT_KARTVERKET_MAP)
    manifest["credits"] = credits
    report["http"] = http_counts(client, counter)
    manifest["stats"]["facts"] = dict(_stats(report, report["http"]),
                                      generated_at=facts["generated_at"])
    try:
        _atomic_write(facts_path, data)
        manifest["files"]["facts"] = {"file": FACTS_NAME, "bytes": len(data),
                                      "sha256": manifestlib.sha256_hex(data)}
        if added or credits != json.loads(old[manifest_path].decode("ascii"))["credits"]:
            notice = manifestlib.notice_text(
                world_id=manifest["id"], generated_at=manifest["generated_at"],
                credits=manifest["credits"], sources=manifest["sources"],
                commit=(manifest.get("pipeline") or {}).get("commit"),
                synthetic=view.synthetic)
            _atomic_write(notice_path, notice)
            manifest["files"]["notice"] = {"file": manifestlib.NOTICE_NAME,
                                           "bytes": len(notice),
                                           "sha256": manifestlib.sha256_hex(notice)}
        _atomic_write(manifest_path, manifestlib.dumps_json(manifest))
        problems = manifestlib.check_world(folder)
        if problems:
            raise FactsError("the world failed its check after facts.json was added:\n  "
                             + "\n  ".join(problems))
    except BaseException:
        for path, content in old.items():
            if content is None:
                if path.exists():
                    path.unlink()
            else:
                _atomic_write(path, content)
        raise
    return facts, report


def run_cli(world_dir, *, cache_dir, offline=False, compare_pvgis=None, log=print, out=print):
    """The `facts` command: set up the client, run, and print a summary."""
    from .. import gitguard
    from ..http import Client, requests_transport

    world_dir = Path(world_dir)
    client = None
    counter = None
    try:
        manifest = json.loads((world_dir / "manifest.json").read_text(encoding="ascii"))
    except (OSError, ValueError) as exc:
        raise FactsError("{} is not a built world: {}".format(world_dir, exc)) from exc
    from ..synthetic import SYNTHETIC_ID
    if manifest.get("id") != SYNTHETIC_ID:
        if cache_dir is not None:
            gitguard.check_destination(cache_dir, "the response cache")
        client = Client(cache_dir, offline=offline)
        counter = CountingTransport(client.transport or requests_transport)
        client.transport = counter
    facts, report = run(world_dir, client, log=log, compare_pvgis=compare_pvgis,
                        counter=counter)
    counts = report.get("http")
    out("facts: {}".format(json.dumps(report.get("timings_s"))))
    if counts is not None:
        out("facts: http {} requests, {} bytes received, {} responses ({} from cache)".format(
            counts["requests"], counts.get("bytes_received"), counts["responses"],
            counts["from_cache"]))
        for host, c in sorted(counts["by_host"].items()):
            out("  {}: {} requests, {} bytes".format(host, c["requests"], c["bytes"]))
    if report.get("pvgis"):
        for line in format_pvgis(report["pvgis"]):
            out(line)
    return world_dir, facts, report
