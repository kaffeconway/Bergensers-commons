"""Trees within the h1 radius: canopy tops in the surface model minus the terrain model.

1. canopy = DOM - DTM (the nDSM), with excluded cells set to 0 m: in a build,
   building footprints and every other planar roof candidate, grown by one
   cell, and lake and sea cells (commons_world.mapsteps);
2. a Gaussian smooth with sigma 1 m;
3. a tree top is a cell that is the highest of its 5 x 5 neighbourhood and
   above 3 m. A flat plateau of equal highs keeps one cell;
4. height = the highest unsmoothed canopy within the 3 x 3 cells around the
   top (smoothing lowers peaks);
5. crown radius: along 8 directions, the distance at which the smoothed
   canopy first falls below half the top's smoothed height (interpolated
   between cells), or, if sooner, the lowest point before it first rises by
   more than 0.2 m again (the dip between two touching crowns, which in
   continuous forest never falls to half height); the median of the 8, capped
   at half the distance to the nearest other top so neighbouring crowns do not
   overlap, and clamped to 0.5 - 8 m;
6. ground = the terrain model at the top.

trees.bin.gz (world/FORMAT.md section 4) is gzip of a 12-byte header (magic
CWT1, u8 version 1, u8 flags 0, u16 reserved, u32 count) and one 8-byte
record per tree: i16 x and i16 z in decimetres, i16 ground in decimetres,
u8 height in 0.25 m, u8 crown radius in 0.1 m. Records are sorted by (z, x).
"""

import struct

import numpy as np
from scipy import ndimage

from . import codec

MAGIC = b"CWT1"
VERSION = 1
HEADER = struct.Struct("<4sBBHI")
RECORD = np.dtype([("x", "<i2"), ("z", "<i2"), ("ground", "<i2"), ("height", "u1"),
                   ("crown", "u1")])

SIGMA_M = 1.0
WINDOW = 5
MIN_HEIGHT_M = 3.0
CROWN_MIN_M = 0.5
CROWN_MAX_M = 8.0
# How far the smoothed canopy must climb again, past its lowest point along a
# ray, before that lowest point is taken as the edge of the crown.
CROWN_RISE_M = 0.2
_DIRECTIONS = ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))


class TreeSet:
    """Tree tops as parallel arrays in grid coordinates (metres)."""

    def __init__(self, e, n, ground, height, crown):
        self.e = np.asarray(e, dtype=np.float64)
        self.n = np.asarray(n, dtype=np.float64)
        self.ground = np.asarray(ground, dtype=np.float64)
        self.height = np.asarray(height, dtype=np.float64)
        self.crown = np.asarray(crown, dtype=np.float64)

    def __len__(self):
        return len(self.e)

    def stats(self):
        if not len(self):
            return {"trees": 0}
        return {"trees": len(self),
                "height_median_m": round(float(np.median(self.height)), 2),
                "height_p95_m": round(float(np.percentile(self.height, 95)), 2),
                "crown_median_m": round(float(np.median(self.crown)), 2)}


def _crown_radii(smooth, rows, cols, cell):
    """Crown radius (m) of each top: see step 5 of the module docstring."""
    height, width = smooth.shape
    top = smooth[rows, cols]
    half = top / 2.0
    steps = int(np.ceil(CROWN_MAX_M / cell)) + 1
    radii = np.full((len(rows), len(_DIRECTIONS)), CROWN_MAX_M, dtype=np.float64)
    for d, (dr, dq) in enumerate(_DIRECTIONS):
        step = float(np.hypot(dr, dq)) * cell
        found = np.zeros(len(rows), dtype=bool)
        previous = top.copy()
        low = top.copy()                      # lowest value so far along the ray
        low_k = np.zeros(len(rows))           # and the step it was at
        for k in range(1, steps + 1):
            rr = rows + dr * k
            qq = cols + dq * k
            inside = (rr >= 0) & (rr < height) & (qq >= 0) & (qq < width)
            value = np.zeros(len(rows), dtype=np.float64)
            value[inside] = smooth[rr[inside], qq[inside]]
            hit = ~found & (value < half)
            if hit.any():
                drop = previous[hit] - value[hit]
                frac = np.where(drop > 0, (previous[hit] - half[hit]) / np.where(drop > 0, drop, 1),
                                0.5)
                radii[hit, d] = (k - 1 + np.clip(frac, 0.0, 1.0)) * step
            found |= hit
            rise = ~found & (value > low + CROWN_RISE_M)
            if rise.any():
                radii[rise, d] = low_k[rise] * step
            found |= rise
            lower = value < low
            low[lower] = value[lower]
            low_k[lower] = k
            previous = value
            if found.all():
                break
    radius = np.median(radii, axis=1)
    if len(rows) > 1:
        from scipy.spatial import cKDTree

        points = np.column_stack([rows, cols]).astype(np.float64) * cell
        nearest = cKDTree(points).query(points, k=2)[0][:, 1]
        radius = np.minimum(radius, nearest / 2.0)
    return np.clip(radius, CROWN_MIN_M, CROWN_MAX_M)


def find_trees(ndsm, dtm, grid, exclude=None, within=None):
    """Tree tops on `grid` from a canopy-height raster; returns (TreeSet, stats).

    `exclude` is a boolean raster of cells where no tree may stand (buildings,
    water); `within` is (e0, n0, radius) in grid coordinates.
    """
    canopy = np.nan_to_num(np.asarray(ndsm, dtype=np.float64), nan=0.0)
    canopy = np.maximum(canopy, 0.0)
    if exclude is not None:
        canopy[exclude] = 0.0
    sigma = SIGMA_M / grid.cell
    smooth = ndimage.gaussian_filter(canopy, sigma=sigma, mode="nearest")
    peak = ndimage.maximum_filter(smooth, size=WINDOW, mode="nearest")
    tops = (smooth >= peak) & (smooth > MIN_HEIGHT_M)
    if exclude is not None:
        tops &= ~exclude
    labels, count = ndimage.label(tops, structure=np.ones((3, 3), dtype=bool))
    if count == 0:
        return TreeSet([], [], [], [], []), {"trees": 0, "plateau_cells_merged": 0}
    flat = labels.ravel()
    firsts = np.unique(flat, return_index=True)[1][1:]   # first cell of each label, raster order
    rows, cols = np.unravel_index(firsts, labels.shape)
    raw_max = ndimage.maximum_filter(canopy, size=3, mode="nearest")[rows, cols]
    crown = _crown_radii(smooth, rows, cols, grid.cell)
    e, n = grid.xy(rows, cols)
    ground = np.asarray(dtm, dtype=np.float64)[rows, cols]
    keep = np.ones(len(rows), dtype=bool)
    if within is not None:
        e0, n0, radius = within
        keep = (e - e0) ** 2 + (n - n0) ** 2 <= radius * radius
    trees = TreeSet(e[keep], n[keep], ground[keep], raw_max[keep], crown[keep])
    stats = trees.stats()
    stats["plateau_cells_merged"] = int(tops.sum()) - count
    stats["tops_outside_radius"] = int((~keep).sum())
    return trees, stats


def records(trees, origin):
    """The trees as a sorted numpy record array (FORMAT.md's 8-byte records)."""
    oe, on = origin
    out = np.zeros(len(trees), dtype=RECORD)
    x = np.floor((trees.e - oe) * 10.0 + 0.5)
    z = np.floor(-(trees.n - on) * 10.0 + 0.5)
    ground = np.floor(trees.ground * 10.0 + 0.5)
    limit = np.iinfo(np.int16)
    for name, values in (("x", x), ("z", z), ("ground", ground)):
        if len(values) and (values.min() < limit.min or values.max() > limit.max):
            raise ValueError("tree {} does not fit in int16 decimetres".format(name))
    out["x"] = x
    out["z"] = z
    out["ground"] = ground
    out["height"] = np.clip(np.floor(trees.height / 0.25 + 0.5), 0, 255)
    out["crown"] = np.clip(np.floor(trees.crown / 0.1 + 0.5), 0, 255)
    order = np.lexsort((out["x"], out["z"]))
    return out[order]


def encode(trees, origin):
    """Uncompressed trees.bin payload: header and sorted records."""
    recs = records(trees, origin)
    return HEADER.pack(MAGIC, VERSION, 0, 0, len(recs)) + recs.tobytes()


def encode_gz(trees, origin):
    """trees.bin.gz bytes, gzipped deterministically."""
    return codec.gzip_deterministic(encode(trees, origin))


def decode(data):
    """Decode trees.bin (gzipped or not) into a dict of arrays in metres."""
    import gzip

    data = bytes(data)
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    magic, version, flags, reserved, count = HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise ValueError("not a CWT1 tree file (magic {!r})".format(magic))
    if version != VERSION:
        raise ValueError("CWT1 version {} is not supported".format(version))
    if len(data) != HEADER.size + count * RECORD.itemsize:
        raise ValueError("CWT1 file is {} bytes, expected {}".format(
            len(data), HEADER.size + count * RECORD.itemsize))
    recs = np.frombuffer(data, dtype=RECORD, count=count, offset=HEADER.size)
    return {"flags": flags, "reserved": reserved, "count": count, "records": recs,
            "x": recs["x"] / 10.0, "z": recs["z"] / 10.0, "ground": recs["ground"] / 10.0,
            "height": recs["height"] * 0.25, "crown": recs["crown"] * 0.1}
