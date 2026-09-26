"""Horizons by ray casting over nested terrain rasters, with Earth curvature and refraction.

A ray leaves the observer's eye (1.5 m above the terrain) every 0.5 deg of
true bearing. Along it the terrain is sampled (bilinear) on the finest raster
that covers each distance:

    1 m   (the world's h1 terrain, or the 1 m surface model)  1 m steps,   1 .. 200 m
    10 m  (fetched, covering 15 km around the origin)         10 m steps,  210 m .. 10 km
    50 m  (fetched, 100 km square)                             50 m steps,  10 .. 50 km
    100 m (fetched, 300 km square or wider)                    100 m steps, 50 km .. reach

Each sample's height is lowered by the Earth's curvature less refraction,
d^2 (1 - k) / 2R with k = 0.13 and R = 6 371 km, and its elevation angle seen
from the eye is atan((h - drop - eye) / d). The horizon in that direction is
the largest angle along the ray.

The reach is where nothing in the region could still stand 0.25 deg above a
flat horizon: the distance d at which the highest height H in the 100 m
raster, seen from the lowest eye, has tan(0.25 deg) d + drop(d) = H - eye. It
is never less than 10 km and never more than 250 km.

Rays are straight lines in the national grid, started at the grid bearing of
the true bearing (true + grid north offset at the origin). Over these
distances a straight grid line is a geodesic to well within the rasters'
precision; the grid scale factor (within 0.05 % of 1) is ignored.
"""

import math
from dataclasses import dataclass

import numpy as np

EARTH_RADIUS_M = 6371000.0
REFRACTION_K = 0.13
EYE_M = 1.5
STEP_DEG = 0.5
N_AZ = 720
RELIEF_ANGLE_DEG = 0.25
MIN_REACH_M = 10000.0
CAP_M = 250000.0
NEAR_M = 200.0
MID_M = 10000.0
FAR50_M = 50000.0
PER_CELL_M = 1000.0
SOUTH_SECTOR_DEG = (135.0, 225.0)
ENVELOPE_PROBES = 9


def drop_m(d, k=REFRACTION_K, radius=EARTH_RADIUS_M):
    """How far terrain at distance d sinks below the eye's tangent plane: d^2 (1 - k) / 2R."""
    d = np.asarray(d, dtype=np.float64)
    return d * d * (1.0 - k) / (2.0 * radius)


def reach_for_relief(relief_m, angle_deg=RELIEF_ANGLE_DEG, k=REFRACTION_K,
                     radius=EARTH_RADIUS_M):
    """The distance beyond which terrain `relief_m` above the eye stays below `angle_deg`."""
    if relief_m <= 0:
        return 0.0
    a = (1.0 - k) / (2.0 * radius)
    b = math.tan(math.radians(angle_deg))
    return (-b + math.sqrt(b * b + 4.0 * a * relief_m)) / (2.0 * a)


class Layer:
    """A north-up raster in the grid: array rows north to south, cell `cell` metres."""

    def __init__(self, array, west, north, cell, name=""):
        self.array = np.ascontiguousarray(np.asarray(array, dtype=np.float32))
        self.west = float(west)
        self.north = float(north)
        self.cell = float(cell)
        self.name = name
        self.height, self.width = self.array.shape

    @property
    def bounds(self):
        return (self.west, self.north - self.height * self.cell,
                self.west + self.width * self.cell, self.north)

    def sample(self, e, n):
        """Bilinear heights at grid points (between cell centres); NaN outside."""
        e = np.asarray(e, dtype=np.float64)
        n = np.asarray(n, dtype=np.float64)
        fq = (e - self.west) / self.cell - 0.5
        fr = (self.north - n) / self.cell - 0.5
        inside = (fq >= 0) & (fr >= 0) & (fq <= self.width - 1) & (fr <= self.height - 1)
        q0 = np.clip(np.floor(fq), 0, max(self.width - 2, 0)).astype(np.int64)
        r0 = np.clip(np.floor(fr), 0, max(self.height - 2, 0)).astype(np.int64)
        wq = (fq - q0).astype(np.float32)
        wr = (fr - r0).astype(np.float32)
        flat = self.array.ravel()
        idx = r0 * self.width + q0
        idx = np.where(inside, idx, 0)
        a = flat[idx]
        b = flat[idx + 1]
        c = flat[idx + self.width]
        d = flat[idx + self.width + 1]
        out = (a * (1 - wq) + b * wq) * (1 - wr) + (c * (1 - wq) + d * wq) * wr
        return np.where(inside, out, np.nan)

    def max_within(self, e0, n0, radius):
        """(height, e, n) of the highest finite sample whose centre lies within `radius`.

        None if no sample does. Only the window around the disk is read.
        """
        c = self.cell
        q0 = max(int(math.floor((e0 - radius - self.west) / c)) - 1, 0)
        q1 = min(int(math.ceil((e0 + radius - self.west) / c)) + 1, self.width)
        r0 = max(int(math.floor((self.north - (n0 + radius)) / c)) - 1, 0)
        r1 = min(int(math.ceil((self.north - (n0 - radius)) / c)) + 1, self.height)
        if q0 >= q1 or r0 >= r1:
            return None
        east = self.west + (np.arange(q0, q1) + 0.5) * c
        north = self.north - (np.arange(r0, r1) + 0.5) * c
        window = self.array[r0:r1, q0:q1]
        d2 = (east[None, :] - e0) ** 2 + (north[:, None] - n0) ** 2
        values = np.where((d2 <= radius * radius) & np.isfinite(window), window, -np.inf)
        r, q = np.unravel_index(int(np.argmax(values)), values.shape)
        if not np.isfinite(values[r, q]):
            return None
        return float(values[r, q]), float(east[q]), float(north[r])


@dataclass
class Band:
    """Samples every `step` metres from `first` to `last` (inclusive) on `layer`."""

    layer: Layer
    first: float
    last: float
    step: float

    def distances(self):
        if self.last < self.first:
            return np.zeros(0)
        count = int(math.floor((self.last - self.first) / self.step + 1e-9)) + 1
        return self.first + self.step * np.arange(count, dtype=np.float64)


def directions(offset_deg, n_az=N_AZ, step_deg=STEP_DEG):
    """(true bearings, unit east, unit north) of each ray, in the grid."""
    true = np.arange(n_az) * step_deg
    g = np.radians(true + offset_deg)
    return true, np.sin(g), np.cos(g)


def _cast_band(band, e, n, eye, dirs):
    """Per observer and ray: the best tan(angle) along this band, and its distance."""
    d = band.distances()
    P = len(e)
    n_az = len(dirs[0])
    best = np.full((P, n_az), -np.inf, dtype=np.float64)
    best_d = np.zeros((P, n_az), dtype=np.float64)
    if len(d) == 0:
        return best, best_d
    layer = band.layer
    lowered = drop_m(d)
    cell = layer.cell
    fq0 = (e - layer.west) / cell - 0.5
    fr0 = (layer.north - n) / cell - 0.5
    iq = np.floor(fq0)
    ir = np.floor(fr0)
    xq = fq0 - iq
    xr = fr0 - ir
    shared = P > 1 and np.ptp(xq) < 1e-9 and np.ptp(xr) < 1e-9
    flat = layer.array.ravel()
    W, H = layer.width, layer.height
    iq = iq.astype(np.int64)
    ir = ir.astype(np.int64)
    _, unit_e, unit_n = dirs
    for k in range(n_az):
        se, sn = unit_e[k], unit_n[k]
        if shared:
            fq = xq[0] + d * se / cell
            fr = xr[0] - d * sn / cell
            oq = np.floor(fq)
            orow = np.floor(fr)
            wq = (fq - oq).astype(np.float32)
            wr = (fr - orow).astype(np.float32)
            Q = iq[:, None] + oq.astype(np.int64)[None, :]
            R = ir[:, None] + orow.astype(np.int64)[None, :]
            inside = (Q >= 0) & (Q < W - 1) & (R >= 0) & (R < H - 1)
            idx = np.where(inside, R * W + Q, 0)
            h = ((flat[idx] * (1 - wq) + flat[idx + 1] * wq) * (1 - wr)
                 + (flat[idx + W] * (1 - wq) + flat[idx + W + 1] * wq) * wr)
            h = np.where(inside, h, np.nan)
        else:
            h = layer.sample(e[:, None] + d[None, :] * se, n[:, None] + d[None, :] * sn)
        t = (h - lowered[None, :] - eye[:, None]) / d[None, :]
        t = np.where(np.isfinite(t), t, -np.inf)
        j = np.argmax(t, axis=1)
        best[:, k] = t[np.arange(P), j]
        best_d[:, k] = d[j]
    return best, best_d


def cast(e, n, eye, bands, offset_deg, n_az=N_AZ, step_deg=STEP_DEG):
    """(tan of the horizon angle, distance of the terrain that makes it) per observer and ray.

    `e`, `n`, `eye` are 1-D arrays (eye = absolute eye height). Rays with no
    finite sample have tan -inf.
    """
    e = np.atleast_1d(np.asarray(e, dtype=np.float64))
    n = np.atleast_1d(np.asarray(n, dtype=np.float64))
    eye = np.atleast_1d(np.asarray(eye, dtype=np.float64))
    dirs = directions(offset_deg, n_az, step_deg)
    best = np.full((len(e), n_az), -np.inf)
    best_d = np.zeros((len(e), n_az))
    for band in bands:
        t, dist = _cast_band(band, e, n, eye, dirs)
        better = t > best
        best = np.where(better, t, best)
        best_d = np.where(better, dist, best_d)
    return best, best_d


def ray_samples(e0, n0, bands, offset_deg, n_az=N_AZ, step_deg=STEP_DEG):
    """For one point: (heights less the drop, per ray and sample; the sample distances)."""
    _, unit_e, unit_n = directions(offset_deg, n_az, step_deg)
    ds, rows = [], []
    for band in bands:
        d = band.distances()
        if not len(d):
            continue
        h = band.layer.sample(e0 + unit_e[:, None] * d[None, :], n0 + unit_n[:, None] * d[None, :])
        rows.append(np.where(np.isfinite(h), h - drop_m(d)[None, :], -np.inf))
        ds.append(d)
    if not ds:
        return np.full((n_az, 0), -np.inf), np.zeros(0)
    return np.concatenate(rows, axis=1), np.concatenate(ds)


def ray_exit_m(e0, n0, squares, side, offset_deg, n_az=N_AZ, step_deg=STEP_DEG, limit_m=CAP_M):
    """Per ray: where a ray from (e0, n0) first leaves a union of chunk squares, in metres.

    `squares` holds the (i, j) of squares [i*side, (i+1)*side) x [j*side, (j+1)*side) in the
    grid (world/FORMAT.md section 2). Each ray walks from square to square along its line,
    so the distance is exact; it is rounded up to whole metres, so every sample at or
    beyond it lies outside the union. 0 on every ray when (e0, n0) is outside the union;
    `limit_m` if a ray has not left it by then.
    """
    squares = set(squares)
    _, unit_e, unit_n = directions(offset_deg, n_az, step_deg)
    out = np.zeros(n_az, dtype=np.int64)
    i0, j0 = math.floor(e0 / side), math.floor(n0 / side)
    if (i0, j0) not in squares:
        return out

    def first_step(p, u, cell):
        if u > 0:
            return ((cell + 1) * side - p) / u, side / u, 1
        if u < 0:
            return (cell * side - p) / u, -side / u, -1
        return math.inf, math.inf, 0

    for k in range(n_az):
        tx, dtx, si = first_step(e0, float(unit_e[k]), i0)
        ty, dty, sj = first_step(n0, float(unit_n[k]), j0)
        i, j, t = i0, j0, 0.0
        while t < limit_m:
            if tx < ty:
                t, i, tx = tx, i + si, tx + dtx
            else:
                t, j, ty = ty, j + sj, ty + dty
            if (i, j) not in squares:
                break
        out[k] = int(math.ceil(min(t, limit_m) - 1e-9))
    return out


def beyond_profile(e0, n0, eye, bands, from_m, offset_deg, n_az=N_AZ, step_deg=STEP_DEG):
    """(tan, distance) per ray from the samples at or beyond from_m[k] only.

    The samples, their curvature-and-refraction drop and the eye are exactly those of
    `ray_samples` and `cast`, so on a ray whose horizon is set at or beyond from_m[k] this
    gives the same angle. tan is -inf and the distance 0 where no such sample is found.
    """
    lowered, dist = ray_samples(e0, n0, bands, offset_deg, n_az, step_deg)
    tan = np.full(n_az, -np.inf)
    where = np.zeros(n_az)
    if not len(dist):
        return tan, where
    from_m = np.asarray(from_m, dtype=np.float64)
    t = (lowered - float(eye)) / dist[None, :]
    t = np.where((dist[None, :] >= from_m[:, None]) & np.isfinite(t), t, -np.inf)
    j = np.argmax(t, axis=1)
    tan = t[np.arange(n_az), j]
    where = np.where(np.isfinite(tan), dist[j], 0.0)
    return tan, where


def shared_far_tan(lowered, dist, eyes, probes=ENVELOPE_PROBES, chunk=48):
    """Best tan per observer eye height and ray, from one point's far samples.

    The far part of every plot cell's horizon is taken from one point of the
    plot (the parallax of terrain beyond 1 km across a plot is small), but
    each cell sees it from its own eye height. Seen as a function of the eye
    height x, each sample's tan is a line, (A_i - x) / d_i, and the horizon is
    their upper envelope. The samples that can be on that envelope anywhere
    between the lowest and highest eye are found exactly: between two probe
    heights, where the best samples are a and b, the envelope is at least
    max(line a, line b), and a sample can only reach it if it does so at one
    of the probes or where lines a and b cross (it is a line; the bound is
    convex). Each eye is then scored against those samples only, which gives
    the same answer as scoring it against all of them.
    """
    eyes = np.asarray(eyes, dtype=np.float64)
    lowered = np.asarray(lowered, dtype=np.float64)
    n_az, count = lowered.shape
    out = np.full((len(eyes), n_az), -np.inf)
    if count == 0 or not len(eyes):
        return out
    inv = 1.0 / dist
    lo, hi = float(eyes.min()), float(eyes.max())
    xs = np.linspace(lo, hi, probes) if hi > lo else np.array([lo])
    for r0 in range(0, n_az, chunk):
        A = lowered[r0:r0 + chunk]                                      # (R, S)
        f = (A[:, :, None] - xs[None, None, :]) * inv[None, :, None]    # (R, S, K)
        f = np.where(np.isfinite(f), f, -np.inf)
        best = np.argmax(f, axis=1)                                     # (R, K)
        keep = np.zeros(A.shape, dtype=bool)
        keep[np.arange(A.shape[0])[:, None], best] = True
        rows = np.arange(A.shape[0])
        for k in range(len(xs) - 1):
            a, b = best[:, k], best[:, k + 1]
            Aa, Ab = A[rows, a], A[rows, b]
            ia, ib = inv[a], inv[b]
            with np.errstate(divide="ignore", invalid="ignore"):
                cross = (Aa * ia - Ab * ib) / (ia - ib)
            cross = np.where(np.isfinite(cross), cross, xs[k])
            cross = np.clip(cross, xs[k], xs[k + 1])
            for x in (np.full(len(rows), xs[k]), np.full(len(rows), xs[k + 1]), cross):
                bound = np.maximum((Aa - x) * ia, (Ab - x) * ib)
                val = (A - x[:, None]) * inv[None, :]
                keep |= np.isfinite(val) & (val >= bound[:, None] - 1e-12)
        width = int(keep.sum(axis=1).max())
        idx = np.zeros((A.shape[0], width), dtype=np.int64)
        for r in range(A.shape[0]):
            sel = np.flatnonzero(keep[r])
            idx[r, :len(sel)] = sel
            idx[r, len(sel):] = sel[0]
        Ac = np.take_along_axis(A, idx, axis=1)                          # (R, W)
        ic = inv[idx]
        t = (Ac[None, :, :] - eyes[:, None, None]) * ic[None, :, :]
        t = np.where(np.isfinite(t), t, -np.inf)
        out[:, r0:r0 + chunk] = t.max(axis=2)
    return out


def to_degrees(tan):
    """Horizon angles in degrees; a ray with no terrain at all counts as flat (0)."""
    tan = np.asarray(tan, dtype=np.float64)
    return np.where(np.isfinite(tan), np.degrees(np.arctan(np.where(np.isfinite(tan), tan, 0.0))),
                    0.0)


def sector_mean(profile_deg, lo=SOUTH_SECTOR_DEG[0], hi=SOUTH_SECTOR_DEG[1], step_deg=STEP_DEG):
    """Mean of a profile over true bearings lo..hi inclusive."""
    true = np.arange(len(profile_deg)) * step_deg
    sel = (true >= lo - 1e-9) & (true <= hi + 1e-9)
    return float(np.mean(np.asarray(profile_deg)[sel]))


def interpolate_profile(profile_deg, true_azimuth, step_deg=STEP_DEG):
    """Horizon angle at arbitrary true azimuths, linear between rays, wrapping at 360."""
    profile = np.asarray(profile_deg, dtype=np.float64)
    n = len(profile)
    x = np.mod(np.asarray(true_azimuth, dtype=np.float64), 360.0) / step_deg
    i0 = np.floor(x).astype(np.int64) % n
    w = x - np.floor(x)
    return profile[i0] * (1.0 - w) + profile[(i0 + 1) % n] * w


def square_bounds(e0, n0, half, cell):
    """(west, south, east, north), `2 * half` wide, on a lattice of `cell` (half a multiple of cell)."""
    half = math.ceil(half / cell) * cell
    west = math.floor(e0 / cell) * cell - half
    south = math.floor(n0 / cell) * cell - half
    return (west, south, west + 2 * half, south + 2 * half)


# -- PVGIS horizon files (a local check only; nothing from them is stored) -------------

def read_pvgis_horizon(path):
    """(lat, lon, [(true bearing, horizon deg)]) from a PVGIS printhorizon CSV.

    PVGIS writes azimuth A with 0 = south, 90 = west, -90 = east; the true
    bearing is (A + 180) mod 360.
    """
    lat = lon = None
    rows = []
    in_table = False
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.split()
            if line.startswith("Latitude"):
                lat = float(line.split(":")[1])
                continue
            if line.startswith("Longitude"):
                lon = float(line.split(":")[1])
                continue
            if parts[:2] == ["A", "H_hor"]:
                in_table = True
                continue
            if in_table:
                try:
                    a, h = float(parts[0]), float(parts[1])
                except (IndexError, ValueError):
                    if rows:
                        break
                    continue
                rows.append(((a + 180.0) % 360.0, h))
    if not rows:
        raise ValueError("{}: no A / H_hor table found".format(path))
    return lat, lon, rows


SECTORS = (("north", 315.0, 45.0), ("east", 45.0, 135.0), ("south", 135.0, 225.0),
           ("west", 225.0, 315.0))


def compare_profiles(ours_deg, theirs, step_deg=STEP_DEG):
    """Differences (ours - theirs) at the other profile's bearings, overall and by sector."""
    bearings = np.array([b for b, _ in theirs])
    other = np.array([h for _, h in theirs])
    mine = interpolate_profile(ours_deg, bearings, step_deg)
    diff = mine - other

    def stats(sel):
        if not sel.any():
            return None
        dd = diff[sel]
        return {"n": int(sel.sum()), "mean_diff_deg": round(float(dd.mean()), 2),
                "mean_abs_diff_deg": round(float(np.abs(dd).mean()), 2),
                "max_abs_diff_deg": round(float(np.abs(dd).max()), 2),
                "rmse_deg": round(float(np.sqrt((dd ** 2).mean())), 2)}

    out = {"all": stats(np.ones(len(diff), dtype=bool))}
    for name, lo, hi in SECTORS:
        sel = ((bearings >= lo) | (bearings < hi)) if lo > hi else ((bearings >= lo) & (bearings < hi))
        out[name] = stats(sel)
    worst = int(np.argmax(np.abs(diff)))
    out["worst"] = {"true_bearing": float(bearings[worst]), "ours_deg": round(float(mine[worst]), 2),
                    "theirs_deg": round(float(other[worst]), 2)}
    return out
