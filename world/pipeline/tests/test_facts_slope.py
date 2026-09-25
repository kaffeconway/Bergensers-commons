"""Slope and flat ground: Horn's method, bands, the plane fit, patches and circles.

All terrain here is made up: planes, ramps and a cone on a 1 m grid.
"""

import math

import numpy as np
import pytest

from commons_world import geo
from commons_world.facts import slope


def grid_xy(size=41, cell=1.0):
    """E (west to east) and N (north to south) of cell centres, as 2-D arrays."""
    k = np.arange(size) * cell
    e = np.broadcast_to(k[None, :], (size, size))
    n = np.broadcast_to(k[::-1][:, None], (size, size))
    return e, n


def interior(a):
    return a[1:-1, 1:-1]


def test_a_flat_plane_has_no_slope():
    s, a = slope.horn(np.full((20, 20), 42.0))
    assert np.all(np.isnan(s[0])) and np.all(np.isnan(s[:, -1]))
    assert np.all(interior(s) == 0.0)
    assert np.all(interior(slope.horn(slope.smooth3(np.full((20, 20), 42.0)))[0])[1:-1, 1:-1]
                  == 0.0)


def test_a_ten_percent_ramp_is_5_71_degrees_facing_downhill():
    e, n = grid_xy()
    rising_east = 0.1 * e
    s, a = slope.horn(rising_east)
    assert interior(s) == pytest.approx(np.full(interior(s).shape, 5.7106), abs=1e-4)
    assert interior(a) == pytest.approx(np.full(interior(a).shape, 270.0))   # faces west
    s, a = slope.horn(0.1 * n)                                                 # rises north
    assert interior(a) == pytest.approx(np.full(interior(a).shape, 180.0))   # faces south
    s, a = slope.horn(-0.1 * e - 0.1 * n)                                      # falls north-east
    assert interior(a) == pytest.approx(np.full(interior(a).shape, 45.0))
    assert interior(s) == pytest.approx(np.full(interior(s).shape,
                                                math.degrees(math.atan(0.1 * math.sqrt(2)))))


def test_the_plane_fit_and_its_true_bearing():
    e, n = grid_xy()
    slope_deg, aspect = slope.plane_fit(e.ravel(), n.ravel(), (0.1 * n).ravel())
    assert slope_deg == pytest.approx(5.7106, abs=1e-4)
    assert aspect == pytest.approx(180.0)
    # A slope facing grid south faces true 180 - offset: grid north lies east of true north
    # west of a zone's central meridian, where the offset is positive.
    assert geo.true_from_grid(aspect, 3.4) == pytest.approx(176.6)
    assert geo.true_from_grid(2.0, 3.4) == pytest.approx(358.6)
    assert geo.grid_from_true(176.6, 3.4) == pytest.approx(180.0)


def test_a_cone_has_its_flank_angle_and_faces_away_from_the_top():
    size = 201
    e, n = grid_xy(size)
    c = (size - 1) / 2.0
    r = np.hypot(e - c, n - c)
    z = 100.0 - math.tan(math.radians(30.0)) * r
    s, a = slope.horn(z)
    ring = (r > 20) & (r < 80)
    assert float(np.nanmean(s[ring])) == pytest.approx(30.0, abs=0.2)
    east_of_top = (np.abs(n - c) < 1) & (e - c > 20) & (e - c < 80)
    assert np.all(np.abs(a[east_of_top] - 90.0) < 1.0)
    north_of_top = (np.abs(e - c) < 1) & (n - c > 20) & (n - c < 80)
    assert np.all(np.minimum(a[north_of_top], 360 - a[north_of_top]) < 1.0)


def test_bands_and_nibio_ratios():
    s = np.array([[0.0, 4.99, 5.0, 11.0, 11.5, 18.3, 18.6, 30.0, 45.0, np.nan]])
    mask = np.ones_like(s, dtype=bool)
    assert slope.band_areas(s, mask) == [2.0, 1.0, 2.0, 2.0, 0.0, 2.0]
    assert slope.ratio_areas(s, mask) == [4.0, 2.0, 3.0]
    assert slope.RATIO_LABELS == ("gentler than 1 in 5", "1 in 5 to 1 in 3",
                                  "steeper than 1 in 3")
    assert math.degrees(math.atan(slope.RATIO_1_IN_5)) == pytest.approx(11.31, abs=0.01)
    assert math.degrees(math.atan(slope.RATIO_1_IN_3)) == pytest.approx(18.43, abs=0.01)


def test_patches_are_eight_connected():
    m = np.zeros((6, 6), dtype=bool)
    m[0, 0] = m[1, 1] = m[2, 2] = True        # a diagonal: one patch of three
    m[5, 5] = m[5, 4] = True
    cells, patch = slope.largest_patch(m)
    assert cells == 3 and patch[1, 1] and not patch[5, 5]
    assert slope.largest_patch(np.zeros((3, 3), dtype=bool))[0] == 0


def test_the_largest_circle_that_fits():
    e, n = grid_xy(61)
    disk = np.hypot(e - 30, n - 30) <= 10.0
    diameter, centre = slope.inscribed_circle(disk)
    assert 19.0 <= diameter <= 21.0
    assert centre == (30, 30)
    square = np.zeros((30, 30), dtype=bool)
    square[5:15, 5:15] = True                 # 10 m square: a 10 m circle fits
    diameter, _ = slope.inscribed_circle(square)
    assert 9.0 <= diameter <= 10.0            # errs low by up to a cell
    assert slope.inscribed_circle(np.zeros((4, 4), dtype=bool)) == (0.0, None)


def test_smoothing_steadies_rounded_heights():
    e, n = grid_xy(101)
    rng = np.random.default_rng(1)
    flat = np.floor((5.0 + rng.normal(0, 0.03, e.shape)) * 10 + 0.5) / 10   # 0.1 m steps
    raw = np.nanmean(slope.horn(flat)[0])
    smooth = np.nanmean(slope.horn(slope.smooth3(flat))[0])
    assert smooth < raw
