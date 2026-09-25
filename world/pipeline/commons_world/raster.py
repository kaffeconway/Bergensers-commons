"""A level's chunks as one raster, and back.

Every chunk of a level stores samples on the same lattice of cell centres
(world/FORMAT.md section 2). A LevelGrid is one array over the stored arrays
of a set of chunks, on that lattice: its sample (r, q) is centred at

    E = west + (q + 0.5) * c,   N = north - (r + 0.5) * c

so every chunk's stored 242 x 242 array, apron included, is an exact window of
it. Land cover is rasterised once per level on a LevelGrid and cut into chunks;
buildings and trees are worked out on the h1 LevelGrid.
"""

import numpy as np
from affine import Affine

from .grid import union_bounds


class LevelGrid:
    """The union of some chunks' stored arrays, as one raster on the level's lattice."""

    def __init__(self, level, keys):
        keys = sorted(keys)
        if not keys:
            raise ValueError("a LevelGrid needs at least one chunk")
        self.level = level
        self.keys = keys
        self.cell = float(level.cell)
        self.west, self.south, self.east, self.north = union_bounds(level, keys)
        self.width = int(round((self.east - self.west) / self.cell))
        self.height = int(round((self.north - self.south) / self.cell))

    @property
    def shape(self):
        return (self.height, self.width)

    @property
    def bounds(self):
        return (self.west, self.south, self.east, self.north)

    @property
    def transform(self):
        """The affine transform from (col, row) to grid (E, N), rasterio style."""
        return Affine(self.cell, 0.0, self.west, 0.0, -self.cell, self.north)

    def window(self, i, j):
        """(row slice, column slice) of chunk (i, j)'s stored array within the grid."""
        level = self.level
        pad = level.apron * level.cell
        q0 = int(round((i * level.side - pad - self.west) / self.cell))
        r0 = int(round((self.north - ((j + 1) * level.side + pad)) / self.cell))
        k = level.stored
        if q0 < 0 or r0 < 0 or q0 + k > self.width or r0 + k > self.height:
            raise ValueError("chunk {}_{} lies outside this grid".format(i, j))
        return slice(r0, r0 + k), slice(q0, q0 + k)

    def cut(self, array, i, j):
        """Chunk (i, j)'s stored window of a grid-shaped array (a copy)."""
        rows, cols = self.window(i, j)
        return np.array(array[rows, cols], copy=True)

    def assemble(self, chunkset, fill=np.nan, dtype=np.float32):
        """One grid-shaped array from a ChunkSet (or any {(i, j): array}); gaps get `fill`."""
        out = np.full(self.shape, fill, dtype=dtype)
        for key in self.keys:
            if key in chunkset:
                rows, cols = self.window(*key)
                out[rows, cols] = chunkset[key]
        return out

    def centres(self):
        """1-D arrays: E of each column (west to east), N of each row (north to south)."""
        k = np.arange(self.width, dtype=np.float64)
        east = self.west + (k + 0.5) * self.cell
        k = np.arange(self.height, dtype=np.float64)
        north = self.north - (k + 0.5) * self.cell
        return east, north

    def rowcol(self, e, n):
        """(row, col) of the cell containing grid point (E, N), as integers (may be outside)."""
        q = np.floor((np.asarray(e, dtype=np.float64) - self.west) / self.cell).astype(np.int64)
        r = np.floor((self.north - np.asarray(n, dtype=np.float64)) / self.cell).astype(np.int64)
        return r, q

    def xy(self, r, q):
        """Grid (E, N) of the centre of cell (row, col)."""
        return (self.west + (np.asarray(q) + 0.5) * self.cell,
                self.north - (np.asarray(r) + 0.5) * self.cell)

    def inside(self, r, q):
        """Boolean: which (row, col) pairs fall inside the grid."""
        r = np.asarray(r)
        q = np.asarray(q)
        return (r >= 0) & (r < self.height) & (q >= 0) & (q < self.width)
