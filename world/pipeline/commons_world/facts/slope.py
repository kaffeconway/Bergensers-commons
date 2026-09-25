"""Slope and flat ground on the plot, from the 1 m terrain.

Method (the text of METHOD below is what the viewer shows):
- Slope and aspect by Horn's (1981) 3 x 3 method on the 1 m terrain model,
  as the h1 chunks store it (heights rounded to 0.1 m), and again after a
  3 x 3 moving average of the heights (NIBIO's slope map smooths the 1 m
  model to 3 x 3 m in the same spirit).
- Cells count when their centre lies inside the registered parcel (plot.json),
  outside every building footprint grown by 1 m (the terrain model is
  interpolated under buildings), and not on water (class band 4 or 5, or a
  height at or below 0 m).
- Open ground: the analysed cells where the surface model is at most 2 m
  above the terrain (no tree, shed or wall standing on it).
- Bands by slope angle; NIBIO's farmland ratios 1 in 5 (20 %, 11.31 deg) and
  1 in 3 (33 %, 18.43 deg).
- A least-squares plane through every analysed cell gives the overall slope
  and the true bearing the plane faces downhill.
- Patches: 8-connected groups of analysed cells under 5 and under 10 degrees
  on the smoothed slope; the largest, and the diameter of the largest circle
  that fits inside it, from a Euclidean distance transform (within about a
  cell: up to 1 m low, or up to about 0.4 m high where the nearest cell
  outside lies diagonally). Both are also given on the raw slope (*_raw).

Aspect is the direction of steepest descent as a grid bearing (clockwise from
grid north); the plot block reports it as a true bearing.
"""

import math

import numpy as np
from affine import Affine
from rasterio.features import rasterize
from scipy import ndimage
from shapely.ops import unary_union

SLOPE_BANDS = ((0, 5), (5, 10), (10, 15), (15, 20), (20, 30), (30, 90))
RATIO_1_IN_5 = 0.2
RATIO_1_IN_3 = 1.0 / 3.0
RATIO_LABELS = ("gentler than 1 in 5", "1 in 5 to 1 in 3", "steeper than 1 in 3")
PATCH_LIMITS_DEG = (5.0, 10.0)
BUILDING_BUFFER_M = 1.0
OPEN_GROUND_MAX_M = 2.0
WINDOW_MARGIN_M = 3
WATER_CLASSES = (4, 5)
EIGHT = np.ones((3, 3), dtype=bool)

METHOD = ("Horn (1981) 3 x 3 slope on Kartverket's 1 m terrain model as stored in the "
          "world (heights rounded to 0.1 m), raw and after a 3 x 3 m moving average "
          "of the heights. Cells (1 m) count when their centre is inside the registered "
          "parcel, outside building footprints grown by 1 m, and not on water. Open "
          "ground also leaves out cells where the surface model stands more than 2 m "
          "above the terrain. Bands by angle; NIBIO's farmland ratios 1 in 5 (11.31 "
          "deg) and 1 in 3 (18.43 deg). The plane fit is least squares over every "
          "analysed cell; aspect is the true bearing it faces downhill. Patches are "
          "8-connected cells under 5 and 10 deg on the smoothed slope; the circle is "
          "the largest that fits inside the patch (distance transform). The *_raw "
          "patch and circle figures are the same on the raw, unsmoothed slope.")

CAVEATS = (
    "The terrain model is interpolated under buildings and where the laser did not reach "
    "the ground, so slopes next to walls and under dense trees are the model's, not a "
    "survey's.",
    "Heights are stored to 0.1 m, which adds about 0.7 deg of noise to a single 1 m cell's "
    "raw slope on flat ground; the smoothed figures are steadier.",
    "Footprints are segmented from the surface model, so a shed under about 12 m2 or 2.5 m "
    "high is not removed and counts as ground.",
    "Only the registered parcel is analysed. Where the listing states a different plot "
    "area, the difference is not included.",
    "Circle diameters are measured on the 1 m cell grid: they can be up to 1 m low, or up to "
    "about 0.4 m high where the nearest cell outside the patch lies diagonally.",
)


def horn(dem, cell=1.0):
    """(slope_deg, aspect_grid_deg) by Horn's method; NaN on the outer ring of cells.

    Rows run north to south and columns west to east. Aspect is the grid
    bearing of steepest descent (0 = grid north, 90 = east); flat cells get 0.
    """
    z = np.asarray(dem, dtype=np.float64)
    slope = np.full(z.shape, np.nan)
    aspect = np.full(z.shape, np.nan)
    if z.shape[0] < 3 or z.shape[1] < 3:
        return slope, aspect
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dz_east = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * cell)
    dz_south = ((g + 2.0 * h + i) - (a + 2.0 * b + c)) / (8.0 * cell)
    dz_north = -dz_south
    slope[1:-1, 1:-1] = np.degrees(np.arctan(np.hypot(dz_east, dz_north)))
    aspect[1:-1, 1:-1] = np.degrees(np.arctan2(-dz_east, -dz_north)) % 360.0
    return slope, aspect


def smooth3(dem):
    """3 x 3 moving average of heights; NaN where the window is not complete."""
    z = np.asarray(dem, dtype=np.float64)
    out = ndimage.uniform_filter(np.nan_to_num(z), size=3, mode="constant")
    valid = ndimage.uniform_filter(np.isfinite(z).astype(np.float64), size=3,
                                   mode="constant")
    out = np.where(valid > 1.0 - 1e-9, out, np.nan)
    out[0, :] = out[-1, :] = np.nan
    out[:, 0] = out[:, -1] = np.nan
    return out


def plane_fit(e, n, z):
    """Least-squares plane z = a E + b N + c: (slope_deg, aspect_grid_deg of descent)."""
    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    z = np.asarray(z, dtype=np.float64)
    if len(z) < 3:
        return None, None
    A = np.column_stack([e - e.mean(), n - n.mean(), np.ones_like(e)])
    (a, b, _), *_ = np.linalg.lstsq(A, z, rcond=None)
    slope = math.degrees(math.atan(math.hypot(a, b)))
    aspect = math.degrees(math.atan2(-a, -b)) % 360.0
    return slope, aspect


def band_areas(slope_deg, mask, cell_area=1.0, bands=SLOPE_BANDS):
    """Area (m2) per slope band over `mask`; a band holds from <= s < to (the last includes 90)."""
    s = np.asarray(slope_deg)[mask]
    s = s[np.isfinite(s)]
    out = []
    for k, (lo, hi) in enumerate(bands):
        last = k == len(bands) - 1
        sel = (s >= lo) & ((s <= hi) if last else (s < hi))
        out.append(float(sel.sum()) * cell_area)
    return out


def ratio_areas(slope_deg, mask, cell_area=1.0):
    """Area (m2) gentler than 1 in 5, 1 in 5 to 1 in 3, steeper than 1 in 3."""
    s = np.asarray(slope_deg)[mask]
    s = s[np.isfinite(s)]
    grad = np.tan(np.radians(s))
    return [float((grad < RATIO_1_IN_5).sum()) * cell_area,
            float(((grad >= RATIO_1_IN_5) & (grad <= RATIO_1_IN_3)).sum()) * cell_area,
            float((grad > RATIO_1_IN_3).sum()) * cell_area]


def largest_patch(mask):
    """(cell count, boolean mask) of the largest 8-connected component of `mask`."""
    labels, count = ndimage.label(mask, structure=EIGHT)
    if count == 0:
        return 0, np.zeros(np.shape(mask), dtype=bool)
    sizes = ndimage.sum_labels(np.ones_like(labels), labels, index=np.arange(1, count + 1))
    best = int(np.argmax(sizes)) + 1
    return int(sizes[best - 1]), labels == best


def inscribed_circle(mask, cell=1.0):
    """(diameter in metres, (row, col) of its centre) of the largest circle inside `mask`.

    The distance transform gives, for each cell, the distance from its centre
    to the centre of the nearest cell outside the mask; the circle's radius is
    that less half a cell. With the centre held to cell centres the figure can
    be up to one cell low; where the nearest outside cell is diagonal, its
    corner is nearer than that radius, so it can also be up to about 0.41 of a
    cell high (2 x (sqrt(2) - 0.5 - sqrt(0.5)) at one cell's diagonal).
    """
    mask = np.asarray(mask, dtype=bool)
    if not mask.any():
        return 0.0, None
    padded = np.pad(mask, 1, constant_values=False)
    dist = ndimage.distance_transform_edt(padded)[1:-1, 1:-1]
    r, q = np.unravel_index(int(np.argmax(dist)), dist.shape)
    return max(0.0, (2.0 * float(dist[r, q]) - 1.0) * cell), (int(r), int(q))


def raster_mask(geoms, shape, west, north, cell=1.0):
    """Boolean raster: cells whose centre lies inside any of `geoms`."""
    geoms = [g for g in geoms if g is not None and not g.is_empty]
    if not geoms:
        return np.zeros(shape, dtype=bool)
    transform = Affine(cell, 0.0, west, 0.0, -cell, north)
    return rasterize([(g, 1) for g in geoms], out_shape=shape, transform=transform, fill=0,
                     dtype="uint8").astype(bool)


def plot_window(view, margin=WINDOW_MARGIN_M):
    """(west, south, east, north) on the h1 lattice around the parcels, `margin` cells wide."""
    w, s, e, n = view.parcel_union.bounds
    cell = view.h1.cell
    west = math.floor(w / cell) * cell - margin * cell
    south = math.floor(s / cell) * cell - margin * cell
    east = math.ceil(e / cell) * cell + margin * cell
    north = math.ceil(n / cell) * cell + margin * cell
    return west, south, east, north


def crop(view, array, bounds):
    """The part of an h1-grid-shaped array covering `bounds` (on the h1 lattice)."""
    west, south, east, north = bounds
    cell = view.h1.cell
    q0 = int(round((west - view.h1.west) / cell))
    r0 = int(round((view.h1.north - north) / cell))
    q1 = int(round((east - view.h1.west) / cell))
    r1 = int(round((view.h1.north - south) / cell))
    if q0 < 0 or r0 < 0 or q1 > view.h1.width or r1 > view.h1.height:
        raise ValueError("the window {} is outside the h1 terrain".format(bounds))
    return array[r0:r1, q0:q1]


def masks(view, bounds, dom=None):
    """Masks over the window: parcel, buildings (+1 m), water, analysed, open ground."""
    west, south, east, north = bounds
    dtm = np.asarray(crop(view, view.dtm1, bounds), dtype=np.float64)
    shape = dtm.shape
    parcel = raster_mask(view.parcels, shape, west, north)
    footprints = [b.polygon for b in view.buildings]
    grown = unary_union(footprints).buffer(BUILDING_BUFFER_M) if footprints else None
    buildings = raster_mask([grown], shape, west, north)
    water = ~np.isfinite(dtm) | (dtm <= 0.0)
    if view.classes1 is not None:
        cls = crop(view, view.classes1, bounds)
        water |= np.isin(cls, WATER_CLASSES)
    analysed = parcel & ~buildings & ~water
    if dom is not None:
        ndsm = np.where(np.isfinite(dom), dom - dtm, 0.0)
        open_ground = analysed & ~(ndsm > OPEN_GROUND_MAX_M)
    else:
        open_ground = None
    return {"dtm": dtm, "parcel": parcel, "buildings": buildings, "water": water,
            "analysed": analysed, "open": open_ground}


def plot_facts(view, dom_window=None):
    """(plot block for facts.json, details for the sun step).

    `dom_window` is the surface model over plot_window(view), same lattice, or None.
    """
    bounds = plot_window(view)
    west, south, east, north = bounds
    m = masks(view, bounds, dom_window)
    dtm, analysed = m["dtm"], m["analysed"]
    slope, _ = horn(dtm)
    slope_s, _ = horn(smooth3(dtm))
    ok = analysed & np.isfinite(slope) & np.isfinite(slope_s)
    rows, cols = np.nonzero(ok)
    e = west + (cols + 0.5)
    n = north - (rows + 0.5)
    raw = slope[ok]
    # The parcel's area as plot.json states it (the polygon before its ring was rounded to
    # 0.1 m for storage), so the panel shows one figure for one parcel; the stored rings'
    # own area where a record lacks it.
    stored = list(getattr(view, "parcel_areas", None) or [])
    if len(stored) == len(view.parcels) and all(a is not None for a in stored):
        area_polygon = float(sum(stored))
    else:
        area_polygon = float(sum(p.area for p in view.parcels))
    block = {"method": METHOD, "caveats": list(CAVEATS),
             "area_m2": round(area_polygon, 1),
             "analysed_m2": float(ok.sum()),
             "open_ground_m2": (float((ok & m["open"]).sum()) if m["open"] is not None
                                else None),
             "excluded_m2": {"buildings_with_1m_margin": float((m["parcel"] & m["buildings"])
                                                                .sum()),
                             "water": float((m["parcel"] & m["water"] & ~m["buildings"])
                                            .sum())},
             "cell_m": 1}
    if m["open"] is None:
        block["caveats"].append("No surface model was available, so open ground was not "
                                "measured.")
    if not ok.any():
        block.update({"elevation_min": None, "elevation_max": None, "slope_median_deg": None,
                      "slope_p10_deg": None, "slope_p90_deg": None,
                      "plane_fit": {"slope_deg": None, "aspect_true_deg": None},
                      "bands_deg": [], "ratio_bands": [], "largest_patch": None})
        return block, {"bounds": bounds, "garden": None, "masks": m}
    heights = dtm[ok]
    p10, p50, p90 = np.percentile(raw, [10, 50, 90])
    plane_slope, plane_aspect = plane_fit(e, n, heights)
    raw_bands = band_areas(slope, ok)
    smooth_bands = band_areas(slope_s, ok)
    raw_ratios = ratio_areas(slope, ok)
    smooth_ratios = ratio_areas(slope_s, ok)
    block.update({
        "elevation_min": round(float(heights.min()), 1),
        "elevation_max": round(float(heights.max()), 1),
        "slope_median_deg": round(float(p50), 1),
        "slope_p10_deg": round(float(p10), 1),
        "slope_p90_deg": round(float(p90), 1),
        "slope_smoothed_median_deg": round(float(np.median(slope_s[ok])), 1),
        "plane_fit": {"slope_deg": round(plane_slope, 1),
                      "aspect_true_deg": round(view.true_bearing(plane_aspect), 1),
                      "aspect_grid_deg": round(plane_aspect, 1)},
        "bands_deg": [{"from": lo, "to": hi, "m2": a, "m2_smoothed": b}
                      for (lo, hi), a, b in zip(SLOPE_BANDS, raw_bands, smooth_bands)],
        "ratio_bands": [{"label": label, "m2": a, "m2_smoothed": b}
                        for label, a, b in zip(RATIO_LABELS, raw_ratios, smooth_ratios)],
    })
    patch = {"slope": "3 x 3 m smoothed"}
    garden = None
    for limit in PATCH_LIMITS_DEG:
        tag = "under{}".format(int(limit))
        cells, pmask = largest_patch(ok & (slope_s < limit))
        diameter, centre = inscribed_circle(pmask)
        raw_cells, raw_mask = largest_patch(ok & (slope < limit))
        raw_diameter, _ = inscribed_circle(raw_mask)
        patch["{}_m2".format(tag)] = float(cells)
        patch["circle_{}_m".format(tag)] = round(diameter, 1)
        patch["{}_m2_raw".format(tag)] = float(raw_cells)
        patch["circle_{}_m_raw".format(tag)] = round(raw_diameter, 1)
        if limit == 5.0 and centre is not None:
            r, q = centre
            garden = {"e": west + q + 0.5, "n": north - r - 0.5,
                      "basis": "centre of the largest circle inside the largest patch under "
                               "5 deg (smoothed slope)"}
    if garden is None:
        flat = np.where(ok, slope_s, np.inf)
        r, q = np.unravel_index(int(np.argmin(flat)), flat.shape)
        garden = {"e": west + q + 0.5, "n": north - r - 0.5,
                  "basis": "the flattest analysed cell (no patch under 5 deg)"}
    block["largest_patch"] = patch
    return block, {"bounds": bounds, "garden": garden, "masks": m}
