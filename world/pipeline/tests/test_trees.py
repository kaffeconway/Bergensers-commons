"""Trees: canopy tops on synthetic crowns, exclusions, and the CWT1 file."""

import gzip
import struct

import numpy as np
import pytest
from affine import Affine

from commons_world import codec, trees


class Grid:
    """What find_trees needs from a LevelGrid: cell size and cell-centre positions."""

    def __init__(self, west, north, cell=1.0):
        self.cell = cell
        self.transform = Affine(cell, 0.0, west, 0.0, -cell, north)
        self.west, self.north = west, north

    def xy(self, r, q):
        return (self.west + (np.asarray(q) + 0.5) * self.cell,
                self.north - (np.asarray(r) + 0.5) * self.cell)


def crowns(count=40, size=300, seed=3, spacing=14.0, roughness=0.1):
    """(grid, dtm, canopy, truth): `count` well-spaced crowns with half-height radius cr."""
    g = Grid(5000.0, 9000.0)
    rows, cols = np.mgrid[0:size, 0:size]
    e = g.west + cols + 0.5
    n = g.north - rows - 0.5
    dtm = 10.0 + 0.02 * (e - g.west)
    canopy = np.zeros((size, size))
    rng = np.random.default_rng(seed)
    truth = []
    while len(truth) < count:
        tx = rng.uniform(g.west + 15, g.west + size - 15)
        tn = rng.uniform(g.north - size + 15, g.north - 15)
        if any(np.hypot(tx - a, tn - b) < spacing for a, b, _, _ in truth):
            continue
        h, cr = rng.uniform(6, 20), rng.uniform(1.5, 3.5)
        truth.append((tx, tn, h, cr))
        d = np.hypot(e - tx, n - tn)
        canopy = np.maximum(canopy, np.where(d < cr * np.sqrt(2), h * (1 - 0.5 * (d / cr) ** 2),
                                             0.0))
    canopy[canopy > 0.5] += rng.normal(0.0, roughness, int((canopy > 0.5).sum()))
    return g, dtm, canopy, truth


def test_one_top_per_crown_with_height_and_radius():
    g, dtm, canopy, truth = crowns()
    found, stats = trees.find_trees(canopy, dtm, g)
    assert len(found) == len(truth) == 40
    for tx, tn, h, cr in truth:
        i = int(np.argmin(np.hypot(found.e - tx, found.n - tn)))
        assert np.hypot(found.e[i] - tx, found.n[i] - tn) < 1.0
        assert found.height[i] == pytest.approx(h, abs=0.6)
        assert found.crown[i] == pytest.approx(cr, abs=0.5)
        assert found.ground[i] == pytest.approx(10.0 + 0.02 * (found.e[i] - g.west), abs=1e-6)
    assert stats["trees"] == 40


def test_low_canopy_and_excluded_cells_have_no_trees():
    g, dtm, canopy, truth = crowns(count=10)
    exclude = np.zeros(canopy.shape, dtype=bool)
    tx, tn = truth[0][:2]
    r, q = int(g.north - tn), int(tx - g.west)
    exclude[r - 6:r + 7, q - 6:q + 7] = True
    found, _ = trees.find_trees(canopy, dtm, g, exclude=exclude)
    assert len(found) == 9
    assert np.min(np.hypot(found.e - tx, found.n - tn)) > 5
    bushes = np.minimum(canopy, 2.5)
    assert len(trees.find_trees(bushes, dtm, g)[0]) == 0


def test_within_radius():
    g, dtm, canopy, truth = crowns(count=20)
    centre = (g.west + 150.0, g.north - 150.0)
    found, stats = trees.find_trees(canopy, dtm, g, within=(centre[0], centre[1], 80.0))
    expected = sum(1 for tx, tn, _, _ in truth if np.hypot(tx - centre[0], tn - centre[1]) <= 79)
    assert expected <= len(found) <= expected + 2
    assert stats["tops_outside_radius"] == 20 - len(found)


def test_cwt1_round_trip_sorting_and_header():
    g, dtm, canopy, truth = crowns(count=25)
    found, _ = trees.find_trees(canopy, dtm, g)
    origin = (5150, 8850)
    raw = trees.encode(found, origin)
    magic, version, flags, reserved, count = struct.unpack_from("<4sBBHI", raw, 0)
    assert (magic, version, flags, reserved, count) == (b"CWT1", 1, 0, 0, 25)
    assert len(raw) == 12 + 8 * 25
    decoded = trees.decode(codec.gzip_deterministic(raw))
    recs = decoded["records"]
    keys = list(zip(recs["z"].tolist(), recs["x"].tolist()))
    assert keys == sorted(keys)
    x = np.floor((found.e - origin[0]) * 10 + 0.5) / 10
    z = np.floor(-(found.n - origin[1]) * 10 + 0.5) / 10
    order = np.lexsort((x, z))
    assert np.array_equal(decoded["x"], x[order]) and np.array_equal(decoded["z"], z[order])
    assert np.allclose(decoded["height"], np.floor(found.height[order] / 0.25 + 0.5) * 0.25)
    assert np.allclose(decoded["crown"], np.floor(found.crown[order] / 0.1 + 0.5) * 0.1)
    assert np.allclose(decoded["ground"], np.floor(found.ground[order] * 10 + 0.5) / 10)
    gz = trees.encode_gz(found, origin)
    assert gz == trees.encode_gz(found, origin) and gzip.decompress(gz) == raw


def test_decode_refuses_a_damaged_file():
    raw = trees.encode(trees.TreeSet([1.0], [2.0], [3.0], [10.0], [2.0]), (0, 0))
    with pytest.raises(ValueError, match="magic"):
        trees.decode(b"XXXX" + raw[4:])
    with pytest.raises(ValueError, match="bytes"):
        trees.decode(raw[:-1])


def test_records_refuse_positions_beyond_int16():
    far = trees.TreeSet([4000.0], [0.0], [0.0], [10.0], [2.0])
    with pytest.raises(ValueError, match="int16"):
        trees.encode(far, (0, 0))


def bump(e, n, x, y, h, cr):
    """A crown: height h at (x, y), falling to half height at cr, as in crowns()."""
    d = np.hypot(e - x, n - y)
    return np.where(d < cr * np.sqrt(2), h * (1 - 0.5 * (d / cr) ** 2), 0.0)


def test_touching_crowns_are_split_at_the_dip():
    """Two crowns 6 m apart, each 4 m to half height: the dip between them is above half."""
    g = Grid(5000.0, 9000.0)
    rows, cols = np.mgrid[0:60, 0:60]
    e, n = g.xy(rows, cols)
    canopy = np.maximum(bump(e, n, 5027.5, 8970.5, 15.0, 4.0),
                        bump(e, n, 5033.5, 8970.5, 15.0, 4.0))
    found, _ = trees.find_trees(canopy, np.zeros_like(canopy), g)
    assert len(found) == 2
    assert np.hypot(found.e[0] - found.e[1], found.n[0] - found.n[1]) == pytest.approx(6.0)
    for crown in found.crown:
        assert crown <= 3.0 + 1e-9                  # never past half the gap
        assert crown >= 2.0


def test_continuous_forest_does_not_get_the_maximum_crown():
    """Closed canopy: tops 5 m apart, dips well above half height. No crown near 8 m."""
    g = Grid(5000.0, 9000.0)
    rows, cols = np.mgrid[0:80, 0:80]
    e, n = g.xy(rows, cols)
    canopy = np.full(e.shape, 11.0)
    for x in np.arange(5010.5, 5071.0, 5.0):
        for y in np.arange(8929.5, 8990.0, 5.0):
            canopy = np.maximum(canopy, bump(e, n, x, y, 15.0, 3.0))
    found, _ = trees.find_trees(canopy, np.zeros_like(canopy), g)
    assert len(found) >= 100
    assert found.crown.max() <= 2.5 + 1e-9
    assert np.median(found.crown) >= 1.5
