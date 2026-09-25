"""The absolute chunk grid of world/FORMAT.md section 2.

Chunk (i, j) of a level covers E in [i*S, (i+1)*S) and N in [j*S, (j+1)*S) in
absolute grid coordinates, where S = K * c is the chunk side. So chunks line up
across levels and across listings: every h5 chunk is 5 x 5 h1 squares and every
h20 chunk is 4 x 4 h5 squares.

Each chunk stores (K+2) x (K+2) samples: its own K x K cell centres plus a
one-sample apron on every side that repeats the neighbouring chunk's edge
samples. Stored row r and column q (0..K+1) sit at

    E = i*S - c + (q + 0.5)*c
    N = (j+1)*S + c - (r + 0.5)*c

with row 0 the northmost.
"""

import math
from dataclasses import dataclass

import numpy as np

NEAREST = "RSP_NearestNeighbor"
BILINEAR = "RSP_BilinearInterpolation"


@dataclass(frozen=True)
class Level:
    """One height level: cell size, radius around O, and chunk shape."""

    name: str
    cell: int            # metres
    radius: int          # metres from O
    samples: int = 240   # K, samples per chunk side (without the apron)
    apron: int = 1
    interpolation: str = BILINEAR  # hoydedata exportImage resampling
    fetch_cell: float = None       # ask the server for this finer cell, then average

    @property
    def fetch_factor(self):
        """How many fetched cells make one level cell along a side (1 unless fetch_cell)."""
        if not self.fetch_cell:
            return 1
        factor = self.cell / self.fetch_cell
        if factor < 2 or abs(factor - round(factor)) > 1e-9:
            raise ValueError("fetch_cell {} does not divide cell {} into whole cells".format(
                self.fetch_cell, self.cell))
        return int(round(factor))

    @property
    def side(self):
        """Chunk side S = K * c in metres."""
        return self.samples * self.cell

    @property
    def stored(self):
        """Samples per side of the stored array, apron included (242)."""
        return self.samples + 2 * self.apron

    @property
    def cell_cm(self):
        return int(round(self.cell * 100))


# h5 is fetched at 2.5 m and averaged 2 x 2. On 25 Sept 2026 the service's own
# 4 m and 5 m output (bilinear or nearest) was found displaced by exactly 2 m, north
# at some places and west at others, even within one 10 km square; its 2 m, 2.5 m,
# 10 m and 20 m output was not, where tested. Averaging 2.5 m cells gave the true 5 m
# cell mean to within the 0.1 m rounding at all 13 places tested. The build checks
# every coarse level against every finer one (terrain.registration_check) and warns on a
# shift.
LEVELS = (
    Level("h1", 1, 1500, 240, 1, NEAREST),
    Level("h5", 5, 5000, 240, 1, BILINEAR, 2.5),
    Level("h20", 20, 11000, 240, 1, BILINEAR),
)
LEVELS_BY_NAME = {level.name: level for level in LEVELS}


def chunk_side(level):
    """Chunk side in metres."""
    return level.side


def chunk_key(i, j):
    """The manifest key of a chunk, "<i>_<j>"."""
    return "{}_{}".format(i, j)


def square_distance(level, i, j, e0, n0):
    """Distance from (e0, n0) to the nearest point of chunk (i, j)'s square."""
    s = level.side
    dx = max(i * s - e0, 0.0, e0 - (i + 1) * s)
    dy = max(j * s - n0, 0.0, n0 - (j + 1) * s)
    return math.hypot(dx, dy)


def chunks_for_disk(level, e0, n0):
    """Sorted (i, j) of every chunk whose square comes within `radius` of (e0, n0).

    The square is taken as closed for the distance test, so a chunk whose edge
    or corner is exactly `radius` away is included, on every side alike.
    """
    s = level.side
    r = level.radius
    out = []
    for i in range(math.floor((e0 - r) / s) - 1, math.floor((e0 + r) / s) + 1):
        for j in range(math.floor((n0 - r) / s) - 1, math.floor((n0 + r) / s) + 1):
            if square_distance(level, i, j, e0, n0) <= r:
                out.append((i, j))
    return sorted(out)


def chunk_bounds(level, i, j):
    """(west, south, east, north) of the chunk's own square, without the apron."""
    s = level.side
    return (i * s, j * s, (i + 1) * s, (j + 1) * s)


def stored_array_bounds(level, i, j):
    """(west, south, east, north) outer cell edges of the stored array, apron included."""
    s, c, a = level.side, level.cell, level.apron
    return (i * s - a * c, j * s - a * c, (i + 1) * s + a * c, (j + 1) * s + a * c)


def sample_centre(level, i, j, r, q):
    """Grid (E, N) of stored row r, column q of chunk (i, j)."""
    s, c, a = level.side, level.cell, level.apron
    return (i * s - a * c + (q + 0.5) * c, (j + 1) * s + a * c - (r + 0.5) * c)


def sample_centres(level, i, j):
    """1-D arrays (E of each column west to east, N of each row north to south)."""
    s, c, a = level.side, level.cell, level.apron
    k = np.arange(level.stored, dtype=np.float64)
    east = i * s - a * c + (k + 0.5) * c
    north = (j + 1) * s + a * c - (k + 0.5) * c
    return east, north


def union_bounds(level, keys):
    """(west, south, east, north) covering the stored arrays of all `keys`."""
    if not keys:
        raise ValueError("no chunks")
    bounds = [stored_array_bounds(level, i, j) for i, j in keys]
    return (min(b[0] for b in bounds), min(b[1] for b in bounds),
            max(b[2] for b in bounds), max(b[3] for b in bounds))
