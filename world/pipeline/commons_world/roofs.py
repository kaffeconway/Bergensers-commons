"""Roof shapes fitted to the 1 m surface model (world/FORMAT.md, `roof_shape`).

The surface model (NHM DOM) is not written into a world, so the roof of each
building is fitted here, from the cells segmentation already found for it
(commons_world.buildings), and written into buildings.json as planes.

Every model is the MINIMUM of a set of planes, with u the distance along a
ridge bearing phi and v the distance across it:

    flat    h                                         1 plane,  k = 1
    shed    h + a x + b n                             1 plane,  k = 3
    gable   h - p |v - s0|                            2 planes, k = 4
    hip     h - p max(|v - s0|, |u - t0| - d)         4 planes, k = 6 (d = 0: a pyramid)

1. Cells. `comp` is the building's component in the label raster (closed
   planar cells plus one grown ring). `core` drops the grown ring: comp and
   the 3 x 3 closing of the planar cells. The fit uses core when it holds at
   least max(10, a quarter of comp) cells, else comp.
2. Each model is fitted by Tukey-biweight IRLS (c = 4.685 MAD scale, the
   scale floored at 0.05 m), so tree crowns over an eave get no weight. The
   gable's bearing is searched every 6 degrees and along both axes of the
   footprint's minimum rectangle, then refined in 1 degree steps; its ridge
   offset at 17 values. A hip is searched around a good or fair gable.
3. The model with the lowest truncated BIC wins:
   n ln(max(mean(min(r^2, 0.5^2)), 0.07^2)) + k ln n.
4. Quality: good (inlier RMS <= 0.15 m, inlier share >= 0.8), fair (0.30 m,
   0.65) or poor. A good or fair pitched fit may regrow the outline by up to
   3 cells where the surface continues the fitted roof, and is refitted once.
5. A poor fit tries a split into two sides along a line; the split must win
   by 6 score units, the line costing 2 parameters. The parts are cut from
   the drawn outline, so a concave outline can give three.
6. The plausibility gate refuses a roof that comes within 1.5 m of the
   terrain over the drawn outline plus 0.5 m, or rises more than 1 m above the
   highest surface-model cell of the building.
7. The drawn outline of a building other than the house is straightened along
   the fitted ridge when that stays close to the traced cells; otherwise, and
   for the house while HOUSE_OUTLINE is "traced", it is traced.

Every search is on a fixed grid with first-found tie-breaking, and every
output is rounded, so a rebuild writes the same bytes. No network code.
"""

import math
import time

import numpy as np
import shapely
from affine import Affine
from scipy import ndimage
from shapely import affinity, contains_xy
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import split as shapely_split
from shapely.ops import unary_union

from . import buildings as buildingslib
from .parcel import ring_local

# The listing house (a visible choice): "traced" draws it over its measured ring,
# neither regrown nor straightened; "straightened" treats it as any other building.
HOUSE_OUTLINE = "traced"
# Straighten other buildings' outlines along the fitted ridge (a visible choice).
STRAIGHTEN_OTHERS = True
# Set False to write no roof_shape at all (the file is then as before this module).
FIT = True

MODELS = ("flat", "shed", "gable", "hip", "split", "none")
PART_MODELS = ("flat", "shed", "gable", "hip")
REASONS = ("too few cells", "no model fits", "implausible")

MIN_CELLS = 10
CORE_SHARE = 0.25
TAU_M = 0.5              # residuals are truncated here in the score
SIGMA0_M = 0.07          # the score's noise floor
LAMBDA = 1.0
TUKEY_C = 4.685
SCALE_FLOOR_M = 0.05
ITERS_FIT = 4            # IRLS passes for flat and shed
ITERS_SEARCH = 3         # IRLS passes inside the gable, hip and split searches
GABLE_STEP_DEG = 6.0
REFINE_DEG = 5.0
S0_VALUES = 17
S0_PERCENTILES = (4, 96)
HIP_T0_VALUES = 5
HIP_S0_SHIFT_M = (-0.5, 0.0, 0.5)
HIP_D_STEP_M = 0.5
HIP_END_SHARE = 0.10
GOOD = (0.15, 0.80)      # inlier RMS (m), inlier share
FAIR = (0.30, 0.65)
INLIER_FLOOR_M = 0.3
STATS_SCALE_FLOOR_M = 0.03
SPLIT_K = 2
SPLIT_MARGIN = 6.0
SPLIT_PERCENTILES = (12, 88)
SPLIT_STEP_M = 1.0
SPLIT_MIN_SHARE = 0.15
SPLIT_SNAP_M = 1.0       # the drawn cut moves onto an inner corner of the outline this near
SPLIT_BATCH_CELLS = 400  # up to this many cells, a bearing's offsets are fitted all at once
GROW_STEPS = 3
GROW_TOL = (0.35, 2.5)   # max(0.35 m, 2.5 x rms)
GROW_ROOF_ABOVE_M = 2.0
CLEARANCE_M = 1.5        # the gate: lowest roof over the outline above the terrain
TOP_MARGIN_M = 1.0       # the gate: highest roof over the highest surface cell
GATE_BUFFER_M = 0.5
MIN_PART_M2 = 1.0        # a thinner sliver of a split is merged into its neighbour
CROP_MARGIN = 8

# Straightening (a least-squares straight-edge fit along the ridge, to the same cells)
STRAIGHT_STEP_M = 0.25
STRAIGHT_WIN_M = 2.0
STRAIGHT_ANG_DEG = 22.0
STRAIGHT_MIN_RUN_M = 1.5
STRAIGHT_MIN_D_M = 3.0
STRAIGHT_MERGE_M = 1.2
STRAIGHT_MAX_OFF_M = 1.5
STRAIGHT_MAX_DEV_M = 0.45
STRAIGHT_AREA_TOL = 0.15


# -- fitting ---------------------------------------------------------------------

def _frame(x, n, phi_deg):
    """(u, v): along and across the grid bearing(s) phi. phi may be an array (P,)."""
    a = np.radians(np.atleast_1d(np.asarray(phi_deg, dtype=np.float64)))[:, None]
    u = x[None, :] * np.sin(a) + n[None, :] * np.cos(a)
    v = x[None, :] * np.cos(a) - n[None, :] * np.sin(a)
    return u, v


def _median(a):
    """The median along the last axis (np.median's value, without its per-call overhead)."""
    m = a.shape[-1]
    k = m // 2
    if m % 2:
        return np.partition(a, k, axis=-1)[..., k]
    p = np.partition(a, (k - 1, k), axis=-1)
    return 0.5 * (p[..., k - 1] + p[..., k])


def _tukey(r):
    """Tukey biweights for each row of residuals r, from that row's MAD scale."""
    med = _median(r)[..., None]
    s = np.maximum(1.4826 * _median(np.abs(r - med)), SCALE_FLOOR_M)[..., None]
    t = r / (TUKEY_C * s)
    t = 1.0 - np.minimum(t * t, 1.0)       # (1 - t^2)^2 inside |t| < 1, and 0 outside
    return t * t


def _solve2(w, D, z):
    """Weighted least squares of z ~ h + q D[k] for each row k, in closed form: (h, q, ok)."""
    wd = w * D
    sw, sd, sdd = w.sum(1), wd.sum(1), np.einsum("ij,ij->i", wd, D)
    sz, sdz = w @ z, wd @ z
    det = sw * sdd - sd * sd
    ok = det > 1e-9 * np.maximum(sw * sdd, 1e-12)
    det = np.where(ok, det, 1.0)
    return (sdd * sz - sd * sdz) / det, (sw * sdz - sd * sz) / det, ok


def _irls2(D, z, iters):
    """Tukey IRLS for z ~ h + q D[k], for every row k of D at once.

    Returns (h, q, r, ok): r is (K, n); ok is False where a solve was singular."""
    w = np.ones(D.shape)
    ok = np.ones(D.shape[0], dtype=bool)
    h = q = r = None
    for _ in range(iters):
        h, q, good = _solve2(w, D, z)
        ok &= good
        r = z[None, :] - h[:, None] - q[:, None] * D
        w = _tukey(r)
        few = w.sum(1) < 4
        if few.any():
            w[few] = 1.0
    return h, q, r, ok


def _irls_rows(x, n, z, D):
    """Tukey IRLS, all at once, for flat (ITERS_FIT passes), shed (ITERS_FIT) and
    z ~ h + q D[k] for every row of D (ITERS_SEARCH passes).

    Each model is solved from the weights its own residuals gave on the pass
    before (the first pass unweighted), and a model whose weights sum to fewer
    than its parameters plus 2 starts again from equal weights. Returns
    (flat h, flat r, shed beta, shed r, h, q, r, ok) for the rows of D."""
    m = len(z)
    K = D.shape[0]
    A = np.column_stack([x, n, np.ones(m)])
    W = np.ones((2 + K, m))
    ok = np.ones(K, dtype=bool)
    hf = rf = bs = rs = h = q = rd = None
    for it in range(max(ITERS_FIT, ITERS_SEARCH)):
        w = W[0]
        hf = float(w @ z / w.sum())
        rf = z - hf
        sw = np.sqrt(W[1])
        bs = np.linalg.lstsq(A * sw[:, None], z * sw, rcond=None)[0]
        rs = z - A @ bs
        rows = [rf[None, :], rs[None, :]]
        two = K and it < ITERS_SEARCH
        if two:
            h, q, good = _solve2(W[2:], D, z)
            ok &= good
            rd = z[None, :] - h[:, None] - q[:, None] * D
            rows.append(rd)
        R = np.vstack(rows)
        Wn = _tukey(R)
        sums = Wn.sum(1)
        if sums[0] < 3:
            Wn[0] = 1.0
        if sums[1] < 5:
            Wn[1] = 1.0
        if two:
            few = sums[2:] < 4
            if few.any():
                Wn[2:][few] = 1.0
            W = Wn
        else:
            W[:2] = Wn[:2]
    return hf, rf, bs, rs, h, q, rd, ok


def _score(r, k):
    n = r.shape[-1]
    ms = np.mean(np.minimum(r * r, TAU_M * TAU_M), axis=-1)
    return n * np.log(np.maximum(ms, SIGMA0_M * SIGMA0_M)) + LAMBDA * k * math.log(n)


def robust_stats(r):
    """(inlier RMS, inlier share): inliers within max(3 robust sigma, 0.3 m)."""
    s = max(1.4826 * float(_median(np.abs(r - _median(r)))), STATS_SCALE_FLOOR_M)
    inl = np.abs(r) <= max(3.0 * s, INLIER_FLOOR_M)
    rms = float(np.sqrt(np.mean(r[inl] ** 2))) if inl.any() else float("inf")
    return rms, float(inl.mean())


def quality(rms, inliers):
    if rms <= GOOD[0] and inliers >= GOOD[1]:
        return "good"
    if rms <= FAIR[0] and inliers >= FAIR[1]:
        return "fair"
    return "poor"


def _plane_uv(phi, cu, cv, c0):
    """y = c0 + cu u + cv v in the frame of `phi` -> (gx, gn, c) with y = gx x + gn n + c."""
    a = math.radians(phi)
    return (cu * math.sin(a) + cv * math.cos(a), cu * math.cos(a) - cv * math.sin(a), c0)


def _gable_planes(phi, s0, h, p):
    return [_plane_uv(phi, 0.0, -p, h + p * s0), _plane_uv(phi, 0.0, p, h - p * s0)]


def _hip_planes(phi, s0, t0, d, h, p):
    return [_plane_uv(phi, 0.0, -p, h + p * s0), _plane_uv(phi, 0.0, p, h - p * s0),
            _plane_uv(phi, -p, 0.0, h + p * (t0 + d)), _plane_uv(phi, p, 0.0, h - p * (t0 - d))]


def roof_z(planes, x, n):
    """The minimum of `planes` (gx, gn, c) at (x, n)."""
    return np.min([gx * x + gn * n + c for gx, gn, c in planes], axis=0)


def _gable_design(x, n, phis):
    """(phis, s0 (P, S), D (P*S, n)): the gable regressor -|v - s0| for each bearing and offset."""
    phis = [float(p) % 180.0 for p in phis]
    _, v = _frame(x, n, phis)
    lo, hi = np.percentile(v, S0_PERCENTILES, axis=1)
    s0 = np.linspace(lo, hi, S0_VALUES, axis=1)                        # (P, S)
    return phis, s0, -np.abs(v[:, None, :] - s0[:, :, None]).reshape(len(phis) * S0_VALUES, -1)


def _best_gables(phis, s0, h, q, r, ok):
    """The best gable at each bearing: a list of (score, phi, s0, h, p, r) or None."""
    S = s0.shape[1]
    score = np.where(ok & (q > 0), _score(r, 4), np.inf).reshape(len(phis), S)
    out = []
    for i, phi in enumerate(phis):
        j = int(np.argmin(score[i]))
        if not np.isfinite(score[i, j]):
            out.append(None)
            continue
        k = i * S + j
        out.append((float(score[i, j]), phi, float(s0[i, j]), float(h[k]), float(q[k]), r[k]))
    return out


def _hip(x, n, z, phi, s0):
    """The best hip around a gable's frame, or None: (score, s0, t0, d, h, p, r)."""
    u, v = _frame(x, n, [phi])
    u, v = u[0], v[0]
    ulo, uhi = np.percentile(u, 2), np.percentile(u, 98)
    half = 0.5 * (uhi - ulo)
    combos = [(t0, s0 + ds, d)
              for t0 in np.linspace(ulo + 0.4 * (uhi - ulo), ulo + 0.6 * (uhi - ulo), HIP_T0_VALUES)
              for ds in HIP_S0_SHIFT_M
              for d in np.arange(0.0, max(half, 0.5), HIP_D_STEP_M)]
    T0 = np.array([c[0] for c in combos])[:, None]
    S0 = np.array([c[1] for c in combos])[:, None]
    Dd = np.array([c[2] for c in combos])[:, None]
    along = np.abs(u[None, :] - T0) - Dd
    across = np.abs(v[None, :] - S0)
    ends = (along > across).mean(1)
    h, q, r, ok = _irls2(-np.maximum(across, along), z, ITERS_SEARCH)
    score = np.where(ok & (q > 0) & (ends >= HIP_END_SHARE), _score(r, 6), np.inf)
    j = int(np.argmin(score))
    if not np.isfinite(score[j]):
        return None
    t0, s0h, d = combos[j]
    return float(score[j]), float(s0h), float(t0), float(d), float(h[j]), float(q[j]), r[j]


def fit_single(x, n, z, phis=None, mrr=None, hip=True, fine=True, stats=True):
    """The best one-part model for centred cells (x, n) with heights z.

    phis: the gable bearings to try (default every 6 degrees plus the axes of the
    footprint's rectangle, `mrr`, refined in 1 degree steps when `fine`). The hip
    is searched only around a good or fair gable, when `hip`."""
    if phis is None:
        grid = [float(p) for p in np.arange(0.0, 180.0, GABLE_STEP_DEG)]
        if mrr is not None:
            grid += [mrr % 180.0, (mrr + 90.0) % 180.0]
    else:
        grid = list(phis)
    gphis, s0, D = _gable_design(x, n, grid)
    hf, rf, bs, rs, h, q, rd, ok = _irls_rows(x, n, z, D)
    cands = [dict(model="flat", k=1, r=rf, planes=[(0.0, 0.0, hf)], phi=None),
             dict(model="shed", k=3, r=rs, planes=[(float(bs[0]), float(bs[1]), float(bs[2]))],
                  phi=None)]
    gs = [g for g in _best_gables(gphis, s0, h, q, rd, ok) if g is not None]
    if gs and fine:
        g0 = min(gs, key=lambda t: t[0])
        rphis, rs0, RD = _gable_design(x, n, np.arange(g0[1] - REFINE_DEG,
                                                       g0[1] + REFINE_DEG + 0.1, 1.0))
        gs += [g for g in _best_gables(rphis, rs0, *_irls2(RD, z, ITERS_SEARCH)) if g is not None]
    if gs:
        _, phi, gs0, gh, gp, gr = min(gs, key=lambda t: t[0])
        cands.append(dict(model="gable", k=4, r=gr, phi=phi, planes=_gable_planes(phi, gs0, gh, gp)))
        if hip and quality(*robust_stats(gr)) != "poor":
            found = _hip(x, n, z, phi, gs0)
            if found is not None:
                _, s0h, t0, d, hh, hp, hr = found
                cands.append(dict(model="hip", k=6, r=hr, phi=phi,
                                  planes=_hip_planes(phi, s0h, t0, d, hh, hp)))
    for c in cands:
        c["score"] = float(_score(c["r"], c["k"]))
    best = min(cands, key=lambda c: c["score"])
    if stats:
        best["rms"], best["inliers"] = robust_stats(best["r"])
        best["quality"] = quality(best["rms"], best["inliers"])
    return best


def _median_masked(a, M, cnt):
    """The median of the entries of each row of `a` that `M` selects (cnt of them)."""
    srt = np.sort(np.where(M, a, np.inf), axis=-1)
    rows = np.arange(a.shape[0])
    return 0.5 * (srt[rows, (cnt - 1) // 2] + srt[rows, cnt // 2])


def _tukey_masked(r, M, cnt):
    med = _median_masked(r, M, cnt)[:, None]
    s = np.maximum(1.4826 * _median_masked(np.abs(r - med), M, cnt), SCALE_FLOOR_M)[:, None]
    t = r / (TUKEY_C * s)
    t = 1.0 - np.minimum(t * t, 1.0)
    return t * t * M


def _percentile_masked(a, M, cnt, q):
    """np.percentile's linear interpolation over the entries of each row that M selects."""
    srt = np.sort(np.where(M, a, np.inf), axis=-1)
    rows = np.arange(a.shape[0])
    pos = (cnt - 1) * (q / 100.0)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, cnt - 1)
    f = pos - lo
    return srt[rows, lo] + f * (srt[rows, hi] - srt[rows, lo])


def _fit_sides(x, n, z, M, phis):
    """fit_single(..., phis, hip=False, fine=False) for every cell subset (row of M) at
    once: [{model, k, planes, r (on the subset's cells), trunc}] per row."""
    M = np.asarray(M, dtype=bool)
    K, m = M.shape
    Mf = M.astype(np.float64)
    cnt = M.sum(1)
    A = np.stack([x, n, np.ones(m)], axis=1)
    # the gable design, per subset and bearing: s0 between the subset's own percentiles of v
    phis = [float(p) % 180.0 for p in phis]
    _, v = _frame(x, n, phis)                                           # (P, m)
    P = len(phis)
    s0 = np.empty((K, P, S0_VALUES))
    for i in range(P):
        vv = np.broadcast_to(v[i], (K, m))
        lo = _percentile_masked(vv, M, cnt, S0_PERCENTILES[0])
        hi = _percentile_masked(vv, M, cnt, S0_PERCENTILES[1])
        s0[:, i, :] = np.linspace(lo, hi, S0_VALUES, axis=1)
    D = -np.abs(v[None, :, None, :] - s0[:, :, :, None]).reshape(K * P * S0_VALUES, m)
    MD = np.repeat(M, P * S0_VALUES, axis=0)
    cD = np.repeat(cnt, P * S0_VALUES)
    W0, W1, WD = Mf.copy(), Mf.copy(), MD.astype(np.float64)
    ok = np.ones(D.shape[0], dtype=bool)
    for it in range(max(ITERS_FIT, ITERS_SEARCH)):
        hf = (W0 @ z) / W0.sum(1)
        rf = z[None, :] - hf[:, None]
        G = np.einsum("km,mi,mj->kij", W1, A, A)
        bvec = np.einsum("km,mi,m->ki", W1, A, z)
        bs = np.linalg.solve(G, bvec[:, :, None])[:, :, 0]
        rs = z[None, :] - bs @ A.T
        nw0, nw1 = _tukey_masked(rf, M, cnt), _tukey_masked(rs, M, cnt)
        W0 = np.where((nw0.sum(1) < 3)[:, None], Mf, nw0)
        W1 = np.where((nw1.sum(1) < 5)[:, None], Mf, nw1)
        if it < ITERS_SEARCH:
            h, q, good = _solve2(WD, D, z)
            ok &= good
            rd = z[None, :] - h[:, None] - q[:, None] * D
            nwd = _tukey_masked(rd, MD, cD)
            WD = np.where((nwd.sum(1) < 4)[:, None], MD, nwd)
    tr2 = TAU_M * TAU_M

    def trunc(r, Mk):
        return (np.minimum(r * r, tr2) * Mk).sum(1)

    def score(t, c, k):
        return c * np.log(np.maximum(t / c, SIGMA0_M * SIGMA0_M)) + LAMBDA * k * np.log(c)
    tf, ts, td = trunc(rf, Mf), trunc(rs, Mf), trunc(rd, MD)
    sf, ss = score(tf, cnt, 1), score(ts, cnt, 3)
    sd = np.where(ok & (q > 0), score(td, cD, 4), np.inf).reshape(K, P * S0_VALUES)
    out = []
    for k in range(K):
        cands = [(sf[k], "flat"), (ss[k], "shed")]
        j = int(np.argmin(sd[k]))
        if np.isfinite(sd[k, j]):
            cands.append((sd[k, j], "gable"))
        best = min(cands, key=lambda c: c[0])[1]
        sel = M[k]
        if best == "flat":
            out.append(dict(model="flat", k=1, planes=[(0.0, 0.0, float(hf[k]))], r=rf[k][sel],
                            trunc=float(tf[k])))
        elif best == "shed":
            out.append(dict(model="shed", k=3, planes=[tuple(float(b) for b in bs[k])],
                            r=rs[k][sel], trunc=float(ts[k])))
        else:
            row = k * P * S0_VALUES + j
            phi = phis[j // S0_VALUES]
            out.append(dict(model="gable", k=4, phi=phi,
                            planes=_gable_planes(phi, float(s0[k, j // S0_VALUES, j % S0_VALUES]),
                                                 float(h[row]), float(q[row])),
                            r=rd[row][sel], trunc=float(td[row])))
    return out


def _try_split(x, n, z, phis, single):
    """The best split into two sides along a line at one of `phis`, or None."""
    best = None
    m = len(z)
    need = max(MIN_CELLS, SPLIT_MIN_SHARE * m)
    for phi in phis:
        _, v = _frame(x, n, [phi])
        v = v[0]
        lo, hi = np.percentile(v, SPLIT_PERCENTILES[0]), np.percentile(v, SPLIT_PERCENTILES[1])
        offs = [float(o) for o in np.arange(lo, hi + 0.01, SPLIT_STEP_M)]
        sides = [(o, v >= o) for o in offs]
        sides = [(o, sd) for o, sd in sides if min(sd.sum(), (~sd).sum()) >= need]
        if not sides:
            continue
        side_phis = [phi, phi + 90.0]
        if m <= SPLIT_BATCH_CELLS:
            masks = np.array([mk for _, sd in sides for mk in (sd, ~sd)])
            fits = _fit_sides(x, n, z, masks, side_phis)
            pairs = [(fits[2 * i], fits[2 * i + 1]) for i in range(len(sides))]
        else:
            pairs = [tuple(fit_single(x[mk], n[mk], z[mk], phis=side_phis, hip=False, fine=False,
                                      stats=False) for mk in (sd, ~sd)) for _, sd in sides]
        for (off, sd), parts in zip(sides, pairs):
            r = np.concatenate([parts[0]["r"], parts[1]["r"]])
            score = float(_score(r, parts[0]["k"] + parts[1]["k"] + SPLIT_K))
            if best is None or score < best["score"]:
                # the drawn cut goes midway between the two sides' nearest cells: any line
                # in that gap splits the cells the same way
                mid = 0.5 * (float(v[sd].min()) + float(v[~sd].max()))
                best = dict(score=score, phi=float(phi), off=mid, parts=list(parts), r=r)
    if best is None or best["score"] > single["score"] - SPLIT_MARGIN:
        return None
    return best


def _to_abs(planes, cx, cn):
    return [(gx, gn, c - gx * cx - gn * cn) for gx, gn, c in planes]


def regrow(X, N, dom, dtm, comp, other, planes, rms):
    """comp plus cells next to it that continue the fitted roof: high, not another
    roof, within tolerance of the model, and the model well above the ground there."""
    tol = max(GROW_TOL[0], GROW_TOL[1] * rms)
    model = roof_z(planes, X, N)
    ok = (((dom - dtm) > buildingslib.MIN_HEIGHT_M) & ~other & (np.abs(dom - model) <= tol)
          & ((model - dtm) > GROW_ROOF_ABOVE_M))
    grown = comp.copy()
    for _ in range(GROW_STEPS):
        nxt = ndimage.binary_dilation(grown, structure=np.ones((3, 3), dtype=bool)) & ok & ~grown
        if not nxt.any():
            break
        grown |= nxt
    return grown


# -- straightening ----------------------------------------------------------------

def _run_offset(cls, q):
    return float(np.median(q[:, 1])) if cls == 0 else float(np.median(q[:, 0]))


def straighten(raw, phi):
    """(polygon, accepted): `raw` straightened along the grid bearing `phi`.

    Walk the outline every 0.25 m, smooth its tangent over 2 m, and class each
    point as parallel to phi, square to it, or neither. Short runs are absorbed,
    neighbouring runs of one class less than 1.2 m apart (a raster jog) merge,
    and each run becomes a line at its median offset (a least-squares line for
    "neither"); consecutive lines are intersected. Accepted only if valid, within
    15 % of the traced area, no vertex more than 1.5 m from the traced outline,
    and at most 0.45 m mean deviation (symmetric difference over perimeter)."""
    c = raw.centroid
    P = affinity.rotate(affinity.translate(raw, -c.x, -c.y), phi - 90.0, origin=(0, 0))
    ring = LineString(P.exterior.coords)
    L = ring.length
    k = max(int(L / STRAIGHT_STEP_M), 12)
    step = L / k
    pts = shapely.get_coordinates(shapely.line_interpolate_point(ring, np.arange(k) * step))
    w = max(int(round(STRAIGHT_WIN_M / step / 2)), 1)
    fwd = np.roll(pts, -w, axis=0) - np.roll(pts, w, axis=0)
    ang = np.arctan2(fwd[:, 1], fwd[:, 0])
    lim = math.sin(math.radians(STRAIGHT_ANG_DEG))
    cls = np.where(np.abs(np.sin(ang)) < lim, 0, np.where(np.abs(np.cos(ang)) < lim, 1, 2))
    if (cls != np.roll(cls, 1)).any():
        st = int(np.argmax(cls != np.roll(cls, 1)))
        cls, pts = np.roll(cls, -st), np.roll(pts, -st, axis=0)
    runs = []
    for i, cl in enumerate(cls):
        if runs and runs[-1][0] == cl:
            runs[-1][1].append(i)
        else:
            runs.append([int(cl), [i]])

    def merge_equal(rs):
        changed = True
        while changed and len(rs) > 1:
            changed = False
            for i in range(len(rs)):
                a, b = rs[i - 1], rs[i]
                if a is b or a[0] != b[0]:
                    continue
                if a[0] == 2 or abs(_run_offset(a[0], pts[a[1]])
                                    - _run_offset(b[0], pts[b[1]])) < STRAIGHT_MERGE_M:
                    a[1] = a[1] + b[1]
                    rs.pop(i)
                    changed = True
                    break
        return rs

    runs = merge_equal(runs)
    while len(runs) > 3:
        need = [(len(r[1]) * step) / (STRAIGHT_MIN_D_M if r[0] == 2 else STRAIGHT_MIN_RUN_M)
                for r in runs]
        i = int(np.argmin(need))
        if need[i] >= 1.0:
            break
        prev, nxt = runs[i - 1], runs[(i + 1) % len(runs)]
        j = (i - 1) % len(runs) if len(prev[1]) >= len(nxt[1]) else (i + 1) % len(runs)
        if j == (i - 1) % len(runs):
            runs[j][1] = runs[j][1] + runs[i][1]
        else:
            runs[j][1] = runs[i][1] + runs[j][1]
        runs.pop(i)
        runs = merge_equal(runs)
    if len(runs) < 3:
        return raw, False
    lines = []
    for cl, idx in runs:
        q = pts[idx]
        if cl == 0:
            lines.append((np.array([0.0, _run_offset(0, q)]), np.array([1.0, 0.0])))
        elif cl == 1:
            lines.append((np.array([_run_offset(1, q), 0.0]), np.array([0.0, 1.0])))
        else:
            mu = q.mean(0)
            _, _, vt = np.linalg.svd(q - mu)
            lines.append((mu, vt[0]))
    out = []
    for i in range(len(lines)):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        den = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(den) < 0.2:          # (near-)parallel neighbours: a square step where they meet
            b = pts[runs[i][1][0]]
            out += [p1 + d1 * np.dot(b - p1, d1), p2 + d2 * np.dot(b - p2, d2)]
            continue
        t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den
        out.append(p1 + t * d1)
    Q = Polygon(out)
    if not Q.is_valid or Q.area <= 0:
        return raw, False
    Q = affinity.translate(affinity.rotate(Q, -(phi - 90.0), origin=(0, 0)), c.x, c.y).simplify(0.05)
    if Q.geom_type != "Polygon" or not Q.is_valid or Q.is_empty:
        return raw, False
    ratio = Q.area / raw.area
    off = max(raw.exterior.distance(Point(p)) for p in Q.exterior.coords)
    dev = Q.symmetric_difference(raw).area / raw.exterior.length
    ok = (dev <= STRAIGHT_MAX_DEV_M and 1.0 - STRAIGHT_AREA_TOL <= ratio <= 1.0 + STRAIGHT_AREA_TOL
          and off <= STRAIGHT_MAX_OFF_M)
    return (Q, True) if ok else (raw, False)


def mrr_bearing(poly):
    """The grid bearing (0-180) of the long axis of the polygon's minimum rectangle."""
    rect = np.asarray(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    e = [rect[1] - rect[0], rect[2] - rect[1]]
    long = max(e, key=lambda d: float(np.hypot(d[0], d[1])))
    return math.degrees(math.atan2(long[0], long[1])) % 180.0


# -- the record ----------------------------------------------------------------------

def _r(v, nd):
    return round(float(v), nd) + 0.0


def _ring_xz(poly):
    """A local (x east, n north) polygon as a FORMAT ring: [[x, z]], 0.1 m, counter-clockwise."""
    return ring_local(orient(Polygon(poly.exterior), sign=1.0).exterior.coords, (0.0, 0.0))


def _planes_xz(planes, at):
    """Absolute (gx, gn, c) planes in (x, north) -> FORMAT [sx, sz, y0] about `at` = [x, z]."""
    ax, az = at
    return [[_r(gx, 4), _r(-gn, 4), _r(gx * ax + gn * (-az) + c, 2)] for gx, gn, c in planes]


def _ring_area_xz(ring):
    """Shoelace area of a FORMAT ring in (x, north): positive when counter-clockwise."""
    return buildingslib.ring_signed_area_local(ring)


def _poly_xz(ring):
    return Polygon([(x, -z) for x, z in ring])


def roof_extremes(shape):
    """(eave, ridge): the lowest and highest drawn roof heights over the outline.

    The roof is concave, so its lowest point is at a ring vertex, and its highest
    at a ring vertex, where a crease crosses the ring, or where three planes meet."""
    ax, az = shape["at"]
    lo, hi = math.inf, -math.inf
    for part in shape["parts"]:
        ring, P = part["ring"], part["planes"]

        def roof(x, z):
            return min(y0 + sx * (x - ax) + sz * (z - az) for sx, sz, y0 in P)
        pts = [tuple(p) for p in ring]
        for p in ring:
            lo = min(lo, roof(*p))
        for i in range(len(P)):
            for j in range(i + 1, len(P)):
                a, b = P[i][0] - P[j][0], P[i][1] - P[j][1]
                c = P[i][2] - P[j][2]
                for k in range(len(ring)):
                    p, q = ring[k], ring[(k + 1) % len(ring)]
                    fp = a * (p[0] - ax) + b * (p[1] - az) + c
                    fq = a * (q[0] - ax) + b * (q[1] - az) + c
                    if (fp > 0 > fq) or (fp < 0 < fq):
                        t = fp / (fp - fq)
                        pts.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
                for m in range(j + 1, len(P)):
                    a2, b2 = P[i][0] - P[m][0], P[i][1] - P[m][1]
                    c2 = P[i][2] - P[m][2]
                    det = a * b2 - b * a2
                    if abs(det) < 1e-12:
                        continue
                    dx = (-c * b2 + b * c2) / det
                    dz = (-a * c2 + a2 * c) / det
                    x, z = ax + dx, az + dz
                    if _poly_xz(ring).covers(Point(x, -z)):
                        pts.append((x, z))
        for p in pts:
            hi = max(hi, roof(*p))
    return lo, hi


def check_shape(shape):
    """Problems with one roof_shape, as strings (empty when sound)."""
    if not isinstance(shape, dict):
        return ["roof_shape is not an object"]
    model = shape.get("model")
    if model not in MODELS:
        return ["roof_shape model {!r} is not one of {}".format(model, ", ".join(MODELS))]
    if model == "none":
        if shape.get("reason") not in REASONS:
            return ["roof_shape reason {!r} is not one of {}".format(shape.get("reason"), REASONS)]
        return []
    problems = []

    def finite(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    for key in ("rms", "inliers", "pitch", "eave", "ridge"):
        if not finite(shape.get(key)):
            problems.append("roof_shape {} missing or not finite".format(key))
    at = shape.get("at")
    if not (isinstance(at, list) and len(at) == 2 and all(finite(v) for v in at)):
        problems.append("roof_shape at is not two finite numbers")
    parts = shape.get("parts")
    if not isinstance(parts, list) or not parts:
        return problems + ["roof_shape has no parts"]
    polys = []
    for i, part in enumerate(parts):
        if not isinstance(part, dict):
            problems.append("roof_shape part {} is not an object".format(i))
            continue
        ring, planes = part.get("ring"), part.get("planes")
        if not (isinstance(ring, list) and len(ring) >= 3 and all(
                isinstance(p, list) and len(p) == 2 and all(finite(v) for v in p) for p in ring)):
            problems.append("roof_shape part {}: ring is not three or more finite points".format(i))
            continue
        if not (isinstance(planes, list) and planes and all(
                isinstance(p, list) and len(p) == 3 and all(finite(v) for v in p) for p in planes)):
            problems.append("roof_shape part {}: planes are not finite [sx, sz, y0]".format(i))
        if part.get("model") not in PART_MODELS:
            problems.append("roof_shape part {}: model {!r}".format(i, part.get("model")))
        if _ring_area_xz(ring) <= 0:
            problems.append("roof_shape part {}: ring is not counter-clockwise".format(i))
        poly = _poly_xz(ring)
        if not poly.is_valid:
            problems.append("roof_shape part {}: ring crosses itself".format(i))
            continue
        polys.append(poly)
    if problems:
        return problems
    union = unary_union(polys)
    total = sum(p.area for p in polys)
    if abs(total - union.area) > 1e-3:
        problems.append("roof_shape parts overlap: their areas sum to {:.4f} m2 against a "
                        "union of {:.4f} m2".format(total, union.area))
    if union.geom_type != "Polygon":
        problems.append("roof_shape parts do not form one outline")
    if finite(shape.get("eave")) and finite(shape.get("ridge")) and shape["eave"] > shape["ridge"]:
        problems.append("roof_shape eave is above its ridge")
    return problems


def _pitch_of(planes):
    """The mean slope (deg) of the pitched planes, 0 when every plane is flat."""
    slopes = [math.degrees(math.atan(math.hypot(sx, sz))) for sx, sz, _ in planes
              if sx != 0 or sz != 0]
    return sum(slopes) / len(slopes) if slopes else 0.0


def _record(fit, pieces, outline):
    """The roof_shape object: pieces are [(polygon in (x, north), model, planes (abs))]."""
    rings = [p if isinstance(p, list) else _ring_xz(p) for p, _, _ in pieces]
    cen = unary_union([_poly_xz(r) for r in rings]).centroid
    at = [_r(cen.x, 1), _r(-cen.y, 1)]
    parts = [{"model": model, "ring": ring, "planes": _planes_xz(planes, at)}
             for ring, (_, model, planes) in zip(rings, pieces)]
    shape = {"model": fit["model"], "quality": fit["quality"], "rms": _r(fit["rms"], 2),
             "inliers": _r(fit["inliers"], 2), "cells": int(fit["cells"]), "outline": outline,
             "at": at, "parts": parts}
    all_planes = [pl for part in parts for pl in part["planes"]]
    uniq = []
    for pl in all_planes:
        if pl not in uniq:
            uniq.append(pl)
    shape["pitch"] = _r(_pitch_of(uniq), 1) if fit["model"] != "flat" else 0.0
    if fit["model"] in ("gable", "hip"):
        shape["ridge_bearing"] = _r(fit["phi"] % 180.0, 1) % 180.0
    elif fit["model"] == "shed":
        gx, gn, _ = fit["planes"][0]
        shape["ridge_bearing"] = _r(math.degrees(math.atan2(-gx, -gn)) % 360.0, 1) % 360.0
    eave, ridge = roof_extremes(shape)
    shape["eave"], shape["ridge"] = _r(eave, 2), _r(ridge, 2)
    return shape


def _snap_cut(Q, off, a, cx, cn):
    """The split line's offset, moved onto an inner (reflex) corner of the drawn outline
    when one lies within SPLIT_SNAP_M of it: an L or T is then cut along its wing's edge,
    not through the other wing's eaves."""
    ring = np.asarray(orient(Polygon(Q.exterior), sign=1.0).exterior.coords)[:-1]
    prev, nxt = np.roll(ring, 1, axis=0), np.roll(ring, -1, axis=0)
    d1, d2 = ring - prev, nxt - ring
    reflex = (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) < -1e-9
    if not reflex.any():
        return off
    v = (ring[reflex, 0] - cx) * math.cos(a) - (ring[reflex, 1] - cn) * math.sin(a)
    k = int(np.argmin(np.abs(v - off)))
    return float(v[k]) if abs(v[k] - off) <= SPLIT_SNAP_M else off


def _clean_pieces(pieces):
    """Split pieces snapped to 1 um, so a zero-area spike (a cut along an outline edge) goes."""
    out = []
    for poly, model, planes in pieces:
        g = shapely.set_precision(poly, 1e-6)
        for part in getattr(g, "geoms", [g]):
            if part.geom_type == "Polygon" and part.area > 0:
                out.append((part, model, planes))
    return out


def _node_pieces(pieces):
    """Each piece's ring with every other piece's vertex that lies on one of its edges put
    in, so that shared edges match vertex for vertex."""
    verts = [np.asarray(p.exterior.coords)[:-1] for p, _, _ in pieces]
    out = []
    for i, (poly, model, planes) in enumerate(pieces):
        others = np.concatenate([v for j, v in enumerate(verts) if j != i]) if len(pieces) > 1 \
            else np.zeros((0, 2))
        ring = verts[i]
        pts = []
        for k in range(len(ring)):
            a, b = ring[k], ring[(k + 1) % len(ring)]
            pts.append(tuple(a))
            d = b - a
            L2 = float(d @ d)
            if L2 <= 0 or not len(others):
                continue
            t = ((others - a) @ d) / L2
            off = np.abs((others[:, 0] - a[0]) * d[1] - (others[:, 1] - a[1]) * d[0]) / math.sqrt(L2)
            on = (t > 1e-9) & (t < 1 - 1e-9) & (off < 1e-6)
            for tt, pt in sorted(zip(t[on].tolist(), map(tuple, others[on].tolist()))):
                if pt != pts[-1]:
                    pts.append(pt)
        out.append((Polygon(pts), model, planes))
    return out


def _merge_slivers(pieces):
    """Merge any split piece under MIN_PART_M2 into the neighbour it shares most edge with."""
    pieces = list(pieces)
    while len(pieces) > 1:
        small = [i for i, p in enumerate(pieces) if p[0].area < MIN_PART_M2]
        if not small:
            break
        i = small[0]
        shared = [(pieces[i][0].boundary.intersection(p[0].boundary).length, j)
                  for j, p in enumerate(pieces) if j != i]
        length, j = max(shared)
        merged = unary_union([pieces[i][0], pieces[j][0]])
        if merged.geom_type != "Polygon":
            break
        pieces[j] = (merged, pieces[j][1], pieces[j][2])
        pieces.pop(i)
    return pieces


def _none(reason):
    return {"model": "none", "reason": reason}


def fit_building(X, N, dom, dtm, comp, core, other, ring_xz, house=False):
    """roof_shape for one building from its crop.

    X, N: cell-centre coordinates (local metres east and north of the origin), as
    2-D arrays like the others; comp, core, other: masks as in the module
    docstring; ring_xz: its FORMAT ring. Returns (shape, info)."""
    traced_house = house and HOUSE_OUTLINE == "traced"
    ring_poly = _poly_xz(ring_xz)
    phi0 = mrr_bearing(ring_poly)
    use = core if core.sum() >= max(MIN_CELLS, CORE_SHARE * comp.sum()) else comp
    if traced_house:
        use = use & contains_xy(ring_poly, X, N)
    if use.sum() < MIN_CELLS:
        return _none("too few cells"), {}
    cx, cn = float(X[use].mean()), float(N[use].mean())
    x, n, z = X[use] - cx, N[use] - cn, dom[use].astype(np.float64)
    s = fit_single(x, n, z, mrr=phi0)
    comp2 = comp
    if not traced_house and s["quality"] != "poor" and s["model"] != "flat":
        comp2 = regrow(X, N, dom, dtm, comp, other, _to_abs(s["planes"], cx, cn), s["rms"])
        added = comp2 & ~comp
        if added.any():
            use = use | added
            x, n, z = X[use] - cx, N[use] - cn, dom[use].astype(np.float64)
            s = fit_single(x, n, z, mrr=phi0)
    fit = dict(model=s["model"], quality=s["quality"], rms=s["rms"], inliers=s["inliers"],
               cells=int(use.sum()), phi=s["phi"], planes=_to_abs(s["planes"], cx, cn))
    split = None
    if s["quality"] == "poor":
        cand = [s["phi"], s["phi"] + 90.0] if s["phi"] is not None else []
        phis = sorted(set(round(p % 180.0, 1) for p in cand + [phi0, phi0 + 90.0]))
        split = _try_split(x, n, z, phis, s)
        if split is not None:
            rms, inl = robust_stats(split["r"])
            fit.update(model="split", quality=quality(rms, inl), rms=rms, inliers=inl,
                       phi=split["phi"])
    if fit["quality"] == "poor":
        return _none("no model fits"), {"model": fit["model"]}
    # the drawn outline
    if traced_house:
        Q, outline = ring_poly, "traced"
    else:
        raw = buildingslib.component_polygons(
            comp2.astype(np.int32), Affine(1.0, 0.0, float(X[0, 0]) - 0.5, 0.0, -1.0,
                                           float(N[0, 0]) + 0.5))[1]
        Q, outline = None, "traced"
        if STRAIGHTEN_OTHERS:
            phi = fit["phi"] if fit["phi"] is not None else phi0
            Q, ok = straighten(raw, phi)
            outline = "straightened" if ok else "traced"
            if not ok:
                Q = None
        if Q is None:
            Q = buildingslib.footprint(raw)
    # the parts: the drawn outline, cut along the split line when there is one
    if split is None:
        pieces = [(list(ring_xz) if traced_house else Q, fit["model"], fit["planes"])]
    else:
        a = math.radians(split["phi"])
        off = _snap_cut(Q, split["off"], a, cx, cn)
        px, pn = cx + off * math.cos(a), cn - off * math.sin(a)
        d = (math.sin(a), math.cos(a))
        line = LineString([(px - 1e4 * d[0], pn - 1e4 * d[1]), (px + 1e4 * d[0], pn + 1e4 * d[1])])
        pieces = []
        for piece in shapely_split(Q, line).geoms:
            m = piece.representative_point()
            k = 0 if (m.x - cx) * math.cos(a) - (m.y - cn) * math.sin(a) >= off else 1
            pieces.append((piece, split["parts"][k]["model"],
                           _to_abs(split["parts"][k]["planes"], cx, cn)))
        pieces = _node_pieces(_merge_slivers(_clean_pieces(pieces)))
    # the plausibility gate, over the roof as drawn on the outline plus a margin: each cell
    # takes the part it lies in, or in the margin the part nearest it
    inside = contains_xy(Q.buffer(GATE_BUFFER_M), X, N)
    xi, ni = X[inside], N[inside]
    if len(pieces) == 1:
        roof = roof_z(pieces[0][2], xi, ni)
    else:
        polys = [_poly_xz(p) if isinstance(p, list) else p for p, _, _ in pieces]
        pts = shapely.points(xi, ni)
        near = np.argmin(np.stack([shapely.distance(poly, pts) for poly in polys]), axis=0)
        roof = np.choose(near, [roof_z(planes, xi, ni) for _, _, planes in pieces])
    lowest = float(np.min(roof - dtm[inside]))
    top = float(np.max(roof) - np.max(dom[comp2]))
    info = {"model": fit["model"], "clearance": lowest, "over_top": top, "outline": outline,
            "grown": int((comp2 & ~comp).sum())}
    if lowest < CLEARANCE_M or top > TOP_MARGIN_M:
        return _none("implausible"), info
    shape = _record(fit, pieces, outline)
    problems = check_shape(shape)
    if problems:
        info["problems"] = problems
        return _none("implausible"), info
    return shape, info


def fit_all(found, dom, dtm, grid, labels, origin, details=None):
    """({label: roof_shape}, stats) for every building in `found`.

    `details`, when a dict, receives {label: what the fit found} for reports."""
    t0 = time.perf_counter()
    oe, on = origin
    dom = np.asarray(dom, dtype=np.float64)
    dtm = np.asarray(dtm, dtype=np.float64)
    shapes = {}
    for b in sorted(found, key=lambda b: b.label):
        minx, miny, maxx, maxy = b.raw.bounds
        q0 = max(int(math.floor(minx - grid.west)) - CROP_MARGIN, 0)
        q1 = min(int(math.ceil(maxx - grid.west)) + CROP_MARGIN, dom.shape[1])
        r0 = max(int(math.floor(grid.north - maxy)) - CROP_MARGIN, 0)
        r1 = min(int(math.ceil(grid.north - miny)) + CROP_MARGIN, dom.shape[0])
        d, t, lab = dom[r0:r1, q0:q1], dtm[r0:r1, q0:q1], labels[r0:r1, q0:q1]
        high = np.isfinite(d - t) & ((d - t) > buildingslib.MIN_HEIGHT_M)
        planar = high & (buildingslib.plane_rms(d) < buildingslib.PLANE_RMS_M)
        closed = ndimage.binary_closing(planar, structure=np.ones((3, 3), dtype=bool)) & high
        comp = lab == b.label
        xs = grid.west + np.arange(q0, q1) + 0.5 - oe
        ns = grid.north - np.arange(r0, r1) - 0.5 - on
        X, N = np.meshgrid(xs, ns)
        ring = ring_local(b.polygon.exterior.coords, origin)
        shapes[b.label], info = fit_building(X, N, d, t, comp, comp & closed, (lab > 0) & ~comp,
                                             ring, house=bool(b.house))
        if details is not None:
            details[b.label] = info
    return shapes, roof_stats(shapes.values(), time.perf_counter() - t0)


def roof_stats(shapes, seconds):
    """manifest stats.map.buildings.roofs."""
    by_model, by_quality, reasons, rms = {}, {}, {}, []
    for s in shapes:
        by_model[s["model"]] = by_model.get(s["model"], 0) + 1
        if s["model"] == "none":
            reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
        else:
            by_quality[s["quality"]] = by_quality.get(s["quality"], 0) + 1
            rms.append(s["rms"])
    return {"by_model": dict(sorted(by_model.items())), "by_quality": dict(sorted(by_quality.items())),
            "fallback_reasons": dict(sorted(reasons.items())),
            "median_rms": round(float(np.median(rms)), 2) if rms else None,
            "fit_seconds": round(seconds, 1)}
