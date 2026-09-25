"""The chunk grid: level table, nesting, inclusion, aprons."""

import math

import numpy as np
import pytest

from commons_world import grid
from commons_world.grid import LEVELS, LEVELS_BY_NAME, Level


def test_levels_are_exactly_format_md():
    table = [(l.name, l.cell, l.radius, l.samples, l.side, l.stored, l.apron, l.cell_cm)
             for l in LEVELS]
    assert table == [("h1", 1, 1500, 240, 240, 242, 1, 100),
                     ("h5", 5, 5000, 240, 1200, 242, 1, 500),
                     ("h20", 20, 11000, 240, 4800, 242, 1, 2000)]
    assert LEVELS_BY_NAME["h1"].interpolation == grid.NEAREST
    assert LEVELS_BY_NAME["h5"].interpolation == grid.BILINEAR
    assert LEVELS_BY_NAME["h20"].interpolation == grid.BILINEAR
    assert grid.chunk_side(LEVELS_BY_NAME["h5"]) == 1200


@pytest.mark.parametrize("coarse,fine,ratio", [("h5", "h1", 5), ("h20", "h5", 4)])
def test_nesting(coarse, fine, ratio):
    big, small = LEVELS_BY_NAME[coarse], LEVELS_BY_NAME[fine]
    for i, j in [(0, 0), (-3, 7), (183, 5551)]:
        west, south, east, north = grid.chunk_bounds(big, i, j)
        parts = [grid.chunk_bounds(small, ratio * i + a, ratio * j + b)
                 for a in range(ratio) for b in range(ratio)]
        assert min(p[0] for p in parts) == west and max(p[2] for p in parts) == east
        assert min(p[1] for p in parts) == south and max(p[3] for p in parts) == north
        assert sum((p[2] - p[0]) * (p[3] - p[1]) for p in parts) == (east - west) * (north - south)


def brute_force_inclusion(level, e0, n0, step=None):
    """Chunks with any point within the radius, found by dense sampling of each square."""
    s, r = level.side, level.radius
    out = []
    for i in range(math.floor((e0 - r) / s) - 1, math.floor((e0 + r) / s) + 2):
        for j in range(math.floor((n0 - r) / s) - 1, math.floor((n0 + r) / s) + 2):
            xs = np.linspace(i * s, (i + 1) * s, 41)
            ys = np.linspace(j * s, (j + 1) * s, 41)
            edge = np.concatenate([np.stack([xs, np.full_like(xs, ys[0])], 1),
                                   np.stack([xs, np.full_like(xs, ys[-1])], 1),
                                   np.stack([np.full_like(ys, xs[0]), ys], 1),
                                   np.stack([np.full_like(ys, xs[-1]), ys], 1)])
            inside = (i * s <= e0 <= (i + 1) * s) and (j * s <= n0 <= (j + 1) * s)
            if inside or np.hypot(edge[:, 0] - e0, edge[:, 1] - n0).min() <= r:
                out.append((i, j))
    return out


@pytest.mark.parametrize("level", LEVELS, ids=lambda l: l.name)
def test_inclusion_matches_brute_force(level):
    e0, n0 = 221289, 6661953  # the synthetic origin, in open sea
    found = grid.chunks_for_disk(level, e0, n0)
    assert found == sorted(found)
    expected = set(brute_force_inclusion(level, e0, n0))
    # Dense sampling can only miss a corner that just grazes the circle.
    missed = set(found) - expected
    assert set(expected) <= set(found)
    for i, j in missed:
        assert grid.square_distance(level, i, j, e0, n0) > level.radius - level.side / 40


def test_inclusion_edges():
    level = Level("t", 10, 100, 10)  # 100 m chunks, radius 100 m
    found = set(grid.chunks_for_disk(level, 0.0, 0.0))
    assert (1, 0) in found            # its west edge is exactly 100 m away
    assert (1, 1) not in found        # its nearest corner is 141 m away
    assert (-2, -1) in found          # east edge at -100 m, touching
    assert (-2, -2) not in found
    assert len(found) == 12


def test_sample_centres_and_stored_bounds():
    level = LEVELS_BY_NAME["h1"]
    i, j = 900, 27700
    assert grid.sample_centre(level, i, j, 0, 0) == (i * 240 - 1 + 0.5, (j + 1) * 240 + 1 - 0.5)
    west, south, east, north = grid.stored_array_bounds(level, i, j)
    assert (west, north) == (i * 240 - 1, (j + 1) * 240 + 1)
    assert (east - west, north - south) == (242, 242)
    e, n = grid.sample_centres(level, i, j)
    assert e[0] == west + 0.5 and e[-1] == east - 0.5
    assert n[0] == north - 0.5 and n[-1] == south + 0.5
    assert np.all(np.diff(e) == 1.0) and np.all(np.diff(n) == -1.0)
    # h1 centres fall on x.5 m, the centres of Kartverket's native 1 m pixels.
    assert np.all(np.mod(e, 1.0) == 0.5)


@pytest.mark.parametrize("level", LEVELS, ids=lambda l: l.name)
def test_apron_repeats_the_neighbours_edge_samples(level):
    i, j = 11, -4
    last = level.stored - 1   # 241
    inner = level.samples     # 240, the last interior row or column
    for r in range(0, level.stored, 37):
        # East apron column = first interior column of the east neighbour.
        assert grid.sample_centre(level, i, j, r, last) == grid.sample_centre(level, i + 1, j, r, 1)
        # West apron column = last interior column of the west neighbour.
        assert grid.sample_centre(level, i, j, r, 0) == grid.sample_centre(level, i - 1, j, r, inner)
    for q in range(0, level.stored, 37):
        # North apron row = last interior row of the north neighbour.
        assert grid.sample_centre(level, i, j, 0, q) == grid.sample_centre(level, i, j + 1, inner, q)
        # South apron row = first interior row of the south neighbour.
        assert grid.sample_centre(level, i, j, last, q) == grid.sample_centre(level, i, j - 1, 1, q)


def test_union_bounds():
    level = LEVELS_BY_NAME["h5"]
    keys = [(1, 1), (2, 3)]
    assert grid.union_bounds(level, keys) == (1200 - 5, 1200 - 5, 3600 + 5, 4800 + 5)
    with pytest.raises(ValueError):
        grid.union_bounds(level, [])


def test_chunk_key():
    assert grid.chunk_key(-3, 27948) == "-3_27948"
