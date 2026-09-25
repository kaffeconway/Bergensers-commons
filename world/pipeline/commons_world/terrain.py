"""Terrain from Kartverket's national height model, via the hoydedata.no ImageServer.

`fetch_raster` asks `exportImage` for a float32 GeoTIFF on an exact grid, in
tiles of at most 3000 pixels a side, and checks that every tile came back on
exactly the grid asked for. `level_chunks` fetches everything one height level
needs in as few tiles as practical and cuts it into chunks, so a chunk's apron
is the very same pixels as its neighbour's edge.

A GeoTIFF on exactly the grid asked for can still hold values from somewhere
else: the service's 4 m and 5 m output was found 2 m off (see grid.LEVELS).
`registration_check` compares a coarse level with block means of a finer level
where both exist, searching up to one coarse cell each way, and the build
reports what it finds for every pair of levels.

Sea in the terrain model is 0 m. Nodata (declared nodata, NaN, or an absurd
value: above 10000 m, or below -500 m, which catches an undeclared -9999) is
set to 0 m and counted.

Heights stay in float64 from the moment anything is computed from them (the
2 x 2 mean of h5) until the codec rounds them, so they are rounded once.
"""

import math

import numpy as np

from .grid import chunks_for_disk, sample_centres, stored_array_bounds, union_bounds
from .raster import LevelGrid

EXPORT_IMAGE = "https://hoydedata.no/arcgis/rest/services/{service}/ImageServer/exportImage"
DTM_SERVICE = "NHM_DTM_25832"
DOM_SERVICE = "NHM_DOM_25832"

# The service allows 4096 px a side; one research pass got a 502 at 4000.
MAX_TILE_PX = 3000

# Anything higher than this is not a height on Earth...
NODATA_ABS_LIMIT = 10000.0
# ...and anything lower than this is not a height in any terrain model the
# pipeline reads (the lowest land in Norway is a few metres below NN2000). It
# is set well below 0 so that land below sea level stays land.
NODATA_LOW_M = -500.0

_TRANSFORM_TOL = 1e-6


class TerrainError(RuntimeError):
    """The height service answered with something other than the grid asked for."""


def service_epsg(service):
    """The EPSG code a hoydedata service name ends in (NHM_DTM_25832 -> 25832)."""
    return int(service.rsplit("_", 1)[1])


def _fmt(value):
    value = float(value)
    return str(int(value)) if value.is_integer() else repr(value)


def _pixels(extent, cell):
    count = extent / cell
    if abs(count - round(count)) > 1e-6 or round(count) < 1:
        raise ValueError("extent {} m is not a whole number of {} m cells".format(extent, cell))
    return int(round(count))


def _split(total, max_px):
    """Split `total` pixels into the fewest near-equal runs of at most max_px."""
    parts = max(1, math.ceil(total / max_px))
    base, extra = divmod(total, parts)
    runs, offset = [], 0
    for k in range(parts):
        size = base + (1 if k < extra else 0)
        runs.append((offset, size))
        offset += size
    return runs


def _is_tiff(resp):
    return resp.content[:4] in (b"II*\x00", b"MM\x00*")


def _read_tiff(content, bounds, width, height, cell, epsg):
    """Parse one GeoTIFF tile and insist it is exactly the grid requested."""
    from rasterio.crs import CRS
    from rasterio.io import MemoryFile

    west, _, _, north = bounds
    with MemoryFile(content) as memfile:
        with memfile.open() as ds:
            if (ds.width, ds.height) != (width, height):
                raise TerrainError("tile is {}x{} px, asked for {}x{}".format(
                    ds.width, ds.height, width, height))
            if ds.count != 1 or ds.dtypes[0] != "float32":
                raise TerrainError("tile has {} band(s) of {}; asked for one float32 band"
                                   .format(ds.count, ", ".join(sorted(set(ds.dtypes)))))
            if ds.crs is None:
                raise TerrainError("tile has no coordinate system")
            if ds.crs.to_epsg() != epsg and ds.crs != CRS.from_epsg(epsg):
                raise TerrainError("tile is in {}, asked for EPSG:{}".format(ds.crs, epsg))
            t = ds.transform
            expected = (cell, 0.0, west, 0.0, -cell, north)
            got = (t.a, t.b, t.c, t.d, t.e, t.f)
            if any(abs(g - x) > _TRANSFORM_TOL for g, x in zip(got, expected)):
                raise TerrainError("tile transform {} does not match the grid asked for {}"
                                   .format(got, expected))
            band = ds.read(1, masked=True)
    data = np.ma.filled(band.astype(np.float32), np.nan)
    return np.asarray(data, dtype=np.float32)


def _fetch_tile(client, service, bounds, width, height, cell, interpolation):
    epsg = service_epsg(service)
    west, south, east, north = bounds
    params = {
        "bbox": ",".join(_fmt(v) for v in (west, south, east, north)),
        "bboxSR": epsg,
        "imageSR": epsg,
        "size": "{},{}".format(width, height),
        "format": "tiff",
        "pixelType": "F32",
        "interpolation": interpolation,
        "f": "image",
    }
    resp = client.get(EXPORT_IMAGE.format(service=service), params=params, cache_check=_is_tiff)
    resp.raise_for_status()
    if not _is_tiff(resp):
        snippet = resp.content[:300].decode("utf-8", errors="replace")
        raise TerrainError("{} did not return a GeoTIFF: {}".format(service, snippet))
    return _read_tiff(resp.content, bounds, width, height, cell, epsg)


def _mosaic(client, service, bounds, cell, interpolation, max_px, want=None):
    west, south, east, north = bounds
    width = _pixels(east - west, cell)
    height = _pixels(north - south, cell)
    out = np.full((height, width), np.nan, dtype=np.float32)
    tiles = 0
    for r0, rows in _split(height, max_px):
        for q0, cols in _split(width, max_px):
            tile = (west + q0 * cell, north - (r0 + rows) * cell,
                    west + (q0 + cols) * cell, north - r0 * cell)
            if want is not None and not want(tile):
                continue
            out[r0:r0 + rows, q0:q0 + cols] = _fetch_tile(
                client, service, tile, cols, rows, cell, interpolation)
            tiles += 1
    return out, tiles


def fetch_raster(client, service, bounds, cell, interpolation, max_px=MAX_TILE_PX):
    """Heights over `bounds` (west, south, east, north) at `cell` metres.

    Returns a float32 array, rows north to south, covering exactly `bounds`:
    pixel (r, q) has its centre at (west + (q + 0.5) * cell, north - (r + 0.5) * cell).
    Nodata comes back as NaN.
    """
    out, _ = _mosaic(client, service, bounds, cell, interpolation, max_px)
    return out


class ChunkSet(dict):
    """{(i, j): (242, 242) heights} for one level, plus fetch statistics.

    float32 as the service sends them, or float64 where they were averaged.
    """

    nodata_fraction = 0.0
    nodata_samples = 0
    samples = 0
    tiles = 0
    bounds = None


def _overlaps(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def fill_nodata(arr):
    """Set NaN and impossible heights to 0 m in place; return how many were set."""
    with np.errstate(invalid="ignore"):
        bad = ~np.isfinite(arr) | (arr > NODATA_ABS_LIMIT) | (arr < NODATA_LOW_M)
    count = int(bad.sum())
    arr[bad] = 0.0
    return count


def block_mean(arr, factor):
    """Mean of each factor x factor block of `arr`, in float64; NaN anywhere in a block gives NaN.

    Not cast back to float32: that would round the mean once to float32 and the
    codec would round it again to 0.1 m, and the two roundings can disagree.
    """
    if factor == 1:
        return arr
    h, w = arr.shape
    if h % factor or w % factor:
        raise ValueError("a {}x{} array does not split into {} x {} blocks".format(
            h, w, factor, factor))
    blocks = np.asarray(arr, dtype=np.float64).reshape(h // factor, factor, w // factor, factor)
    return blocks.mean(axis=(1, 3))


def level_chunks(client, level, e0, n0, service=DTM_SERVICE, max_px=MAX_TILE_PX):
    """Fetch and cut every chunk of `level` within its radius of (e0, n0).

    One mosaic covers the stored arrays of all included chunks; tiles of it
    that touch no included chunk are not requested. Nodata is set to 0 m.
    A level with a `fetch_cell` is fetched at that finer cell and each block
    of fetched cells averaged into one level cell (grid.LEVELS says why h5 is).
    """
    keys = chunks_for_disk(level, e0, n0)
    bounds = union_bounds(level, keys)
    stored = [stored_array_bounds(level, i, j) for i, j in keys]
    factor = level.fetch_factor
    mosaic, tiles = _mosaic(client, service, bounds, level.cell / factor, level.interpolation,
                            max_px, want=lambda tile: any(_overlaps(tile, b) for b in stored))
    mosaic = block_mean(mosaic, factor)
    west, _, _, north = bounds
    k = level.stored
    out = ChunkSet()
    bad = 0
    for (i, j), (w, _, _, n) in zip(keys, stored):
        q0 = int(round((w - west) / level.cell))
        r0 = int(round((north - n) / level.cell))
        arr = mosaic[r0:r0 + k, q0:q0 + k].copy()
        bad += fill_nodata(arr)
        out[(i, j)] = arr
    out.samples = len(keys) * k * k
    out.nodata_samples = bad
    out.nodata_fraction = bad / out.samples if out.samples else 0.0
    out.tiles = tiles
    out.bounds = bounds
    return out


# -- registration check -----------------------------------------------------------

# A coarse level is reported as shifted when moving it by a whole number of fine
# cells makes it at least this many metres closer, on average, to the fine
# level's block means. There is no ratio test: a correctly placed coarse level
# is never an exact block mean (the server's bilinear 20 m output sits about
# 0.6 m from the true 20 m cell means on real terrain), so "twice as close"
# could only ever be met by a shift of a whole cell or more.
REGISTRATION_MIN_GAIN_M = 0.05
REGISTRATION_MIN_CELLS = 200


def _integral(values):
    out = np.zeros((values.shape[0] + 1, values.shape[1] + 1), dtype=np.float64)
    out[1:, 1:] = values.cumsum(axis=0).cumsum(axis=1)
    return out


def _box(integral, r0, q0, k):
    return (integral[r0 + k, q0 + k] - integral[r0, q0 + k] - integral[r0 + k, q0]
            + integral[r0, q0])


def registration_check(fine_level, fine_chunks, coarse_level, coarse_chunks, max_shift=None):
    """Does a coarse level sit where FORMAT.md says its samples are? Checked against a finer level.

    Each coarse sample (the chunks' own samples, not the aprons) is compared
    with the mean of the fine samples covering its cell, where the fine level
    has them and all of them are above 0 m (sea says nothing about position).
    The comparison is repeated with the coarse cell moved by every whole number
    of fine cells up to `max_shift` east and north (by default one whole coarse
    cell, so that a half-cell or whole-cell displacement is inside the search),
    always over the same cells.

    Returns a dict: which level it was compared with, cells compared, mean
    |coarse - block mean| unmoved, the best shift [east, north] in metres and its
    mean, the search window, whether the best shift lies on the window's edge
    (so the true displacement may be larger), and whether the level looks
    shifted: the best shift is not [0, 0] and is at least
    REGISTRATION_MIN_GAIN_M closer on average.
    """
    fc, cc = fine_level.cell, coarse_level.cell
    k = cc / fc
    if abs(k - round(k)) > 1e-9 or k < 2:
        raise ValueError("{} cells are not whole multiples of {} cells".format(
            coarse_level.name, fine_level.name))
    k = int(round(k))
    m = k if max_shift is None else int(max_shift)
    if not fine_chunks or not coarse_chunks:
        return {"compared_with": fine_level.name, "cells": 0, "note": "nothing to compare"}
    fine = LevelGrid(fine_level, list(fine_chunks))
    heights = fine.assemble(fine_chunks, dtype=np.float64)
    bad = ~np.isfinite(heights) | (heights <= 0.0)
    sums = _integral(np.where(bad, 0.0, heights))
    bads = _integral(bad.astype(np.float64))
    del heights, bad
    a = coarse_level.apron
    east_all, north_all, values = [], [], []
    for (i, j), arr in sorted(coarse_chunks.items()):
        west, south, east, north = (i * coarse_level.side, j * coarse_level.side,
                                    (i + 1) * coarse_level.side, (j + 1) * coarse_level.side)
        if east <= fine.west or west >= fine.east or north <= fine.south or south >= fine.north:
            continue
        e, n = sample_centres(coarse_level, i, j)
        inner = np.asarray(arr, dtype=np.float64)[a:-a or None, a:-a or None]
        ee, nn = np.meshgrid(e[a:-a or None], n[a:-a or None])
        east_all.append(ee.ravel())
        north_all.append(nn.ravel())
        values.append(inner.ravel())
    if not values:
        return {"compared_with": fine_level.name, "cells": 0,
                "note": "the levels do not overlap"}
    e = np.concatenate(east_all)
    n = np.concatenate(north_all)
    v = np.concatenate(values)
    # The unmoved block of each coarse cell, as fine (row, column) of its north-west corner.
    q0 = np.rint((e - cc / 2.0 - fine.west) / fc).astype(np.int64)
    r0 = np.rint((fine.north - (n + cc / 2.0)) / fc).astype(np.int64)
    # Every shifted block lies inside the unmoved block grown by m cells on each
    # side, so a cell is compared only if that grown block is inside the fine
    # grid and holds no sea or nodata. Then every shift sees the same cells.
    grown = k + 2 * m
    inside = ((q0 - m >= 0) & (r0 - m >= 0) & (q0 + k + m <= fine.width)
              & (r0 + k + m <= fine.height))
    qg = np.clip(q0 - m, 0, max(fine.width - grown, 0))
    rg = np.clip(r0 - m, 0, max(fine.height - grown, 0))
    valid = np.isfinite(v) & (v > 0.0) & inside
    if grown <= min(fine.width, fine.height):
        valid &= _box(bads, rg, qg, grown) == 0
    else:
        valid[:] = False
    cells = int(valid.sum())
    result = {"compared_with": fine_level.name, "cells": cells,
              "window_m": [-m * fc, m * fc]}
    if cells < REGISTRATION_MIN_CELLS:
        result["note"] = "too few land cells to compare"
        return result
    q0, r0, v = q0[valid], r0[valid], v[valid]
    shifts = [(dx, dy) for dy in range(-m, m + 1) for dx in range(-m, m + 1)]
    scores = {}
    for dx, dy in shifts:
        means = _box(sums, r0 - dy, q0 + dx, k) / (k * k)
        scores[(dx, dy)] = float(np.mean(np.abs(v - means)))
    unmoved = scores[(0, 0)]
    best = min(shifts, key=lambda s: (round(scores[s], 9), abs(s[0]) + abs(s[1]), s))
    gain = unmoved - scores[best]
    shifted = best != (0, 0) and gain >= REGISTRATION_MIN_GAIN_M
    result.update({"mean_abs_diff_m": round(unmoved, 3),
                   "best_shift_m": [best[0] * fc, best[1] * fc],
                   "best_mean_abs_diff_m": round(scores[best], 3),
                   "at_window_edge": max(abs(best[0]), abs(best[1])) == m,
                   "shifted": bool(shifted)})
    return result
