"""Horizons: curvature, the reach rule, a wall at a known bearing, and the cast itself.

Every raster here is invented: flat ground at 0 m with a wall or a step on it.
"""

import math

import numpy as np
import pytest

from commons_world.facts import horizon
from commons_world.facts.horizon import Band, Layer

OFFSET = 3.4   # grid bearing of true north, as in western Vestland (a made-up value here)


def flat_layer(half, cell, fill=0.0):
    size = int(2 * half / cell)
    return Layer(np.full((size, size), fill, dtype=np.float32), -half, half, cell)


def along_true(e, n, true_bearing, offset=OFFSET):
    """(distance along, distance across) a true bearing, for grid offsets (e, n)."""
    g = math.radians(true_bearing + offset)
    u = (math.sin(g), math.cos(g))
    return e * u[0] + n * u[1], -e * u[1] + n * u[0]


def wall_layer(true_bearing, near, depth, half_width, height, half=3000.0, cell=10.0):
    layer = flat_layer(half, cell)
    k = (np.arange(layer.width) + 0.5) * cell
    e = layer.west + k[None, :]
    n = layer.north - k[:, None]
    along, across = along_true(e, n, true_bearing)
    wall = (along >= near) & (along <= near + depth) & (np.abs(across) <= half_width)
    layer.array[wall] = height
    return layer


def test_curvature_and_refraction_drop():
    assert horizon.drop_m(10000.0) == pytest.approx(6.828, abs=0.001)
    assert horizon.drop_m(100000.0) == pytest.approx(682.8, abs=0.1)
    assert horizon.drop_m(0.0) == 0.0


def test_the_reach_is_where_relief_falls_to_a_quarter_degree():
    for relief in (100.0, 600.0, 1500.0, 3000.0):
        d = horizon.reach_for_relief(relief)
        angle = math.degrees(math.atan((relief - horizon.drop_m(d)) / d))
        assert angle == pytest.approx(0.25, abs=1e-9)
    assert horizon.reach_for_relief(1570.0) == pytest.approx(123000, rel=0.02)
    assert horizon.reach_for_relief(-5.0) == 0.0


def test_a_100_m_wall_1_km_true_south():
    layer = wall_layer(180.0, 1000.0, 60.0, 30.0, 100.0)
    bands = [Band(layer, 10.0, 2900.0, 10.0)]
    tan, dist = horizon.cast([0.0], [0.0], [1.5], bands, OFFSET)
    profile = horizon.to_degrees(tan[0])
    south = profile[360]                                  # true 180
    expected = math.degrees(math.atan((100.0 - 1.5 - horizon.drop_m(1000.0)) / 1000.0))
    assert expected == pytest.approx(5.622, abs=0.001)
    assert south == pytest.approx(expected, abs=0.08)
    assert 1000.0 <= dist[0, 360] <= 1020.0
    assert profile[180] < 0.0                             # true 90: nothing there
    assert profile[0] < 0.0 and profile[540] < 0.0
    # The wall is 3.4 deg wide as seen from the eye. Were the grid north offset applied
    # with the wrong sign, it would sit 6.8 deg away, where these rays see nothing.
    assert profile[360 - 14] < 0.0 and profile[360 + 14] < 0.0
    assert profile[360 - 2] > 5.0 and profile[360 + 2] > 5.0


def test_a_wall_due_east_on_the_1_m_layer():
    layer = wall_layer(90.0, 100.0, 5.0, 20.0, 10.0, half=300.0, cell=1.0)
    tan, _ = horizon.cast([0.0], [0.0], [1.5], [Band(layer, 1.0, 200.0, 1.0)], OFFSET)
    east = horizon.to_degrees(tan[0])[180]
    assert east == pytest.approx(math.degrees(math.atan(8.5 / 100.0)), abs=0.1)


def test_the_shared_fraction_path_matches_the_general_one():
    rng = np.random.default_rng(3)
    layer = Layer(rng.normal(20, 5, (400, 400)).astype(np.float32), 0.0, 400.0, 1.0)
    e = np.array([150.0, 151.0, 170.0, 222.0])      # all on cell corners: shared fractions
    n = np.array([250.0, 199.0, 230.0, 210.0])
    eye = np.array([25.0, 26.0, 20.0, 30.0])
    band = Band(layer, 1.0, 100.0, 1.0)
    together, _ = horizon.cast(e, n, eye, [band], OFFSET)
    for k in range(len(e)):
        alone, _ = horizon.cast(e[k:k + 1], n[k:k + 1], eye[k:k + 1], [band], OFFSET)
        assert together[k] == pytest.approx(alone[0], abs=1e-5)


def test_the_shared_far_field_matches_casting_from_each_eye():
    layer = wall_layer(200.0, 3000.0, 100.0, 400.0, 250.0, half=12000.0, cell=10.0)
    layer.array += 30.0 * (np.arange(layer.width)[None, :] % 7 == 0)
    bands = [Band(layer, 1010.0, 10000.0, 10.0)]
    eyes = np.array([5.0, 20.0, 60.0])
    lowered, dist = horizon.ray_samples(0.0, 0.0, bands, OFFSET)
    shared = horizon.shared_far_tan(lowered, dist, eyes)
    exact, _ = horizon.cast(np.zeros(3), np.zeros(3), eyes, bands, OFFSET)
    assert shared == pytest.approx(exact, abs=1e-9)


def test_profiles_interpolate_and_wrap():
    profile = np.zeros(720)
    profile[0] = 2.0
    profile[719] = 1.0
    assert horizon.interpolate_profile(profile, [0.0, 0.25, 359.75, 360.0, 720.0]) == \
        pytest.approx([2.0, 1.0, 1.5, 2.0, 2.0])
    assert horizon.sector_mean(np.ones(720)) == 1.0
    assert horizon.sector_mean(np.arange(720) * 0.5) == pytest.approx(180.0)


def test_layer_sampling_is_bilinear_between_centres_and_nan_outside():
    layer = Layer(np.array([[0.0, 10.0], [20.0, 30.0]]), 0.0, 2.0, 1.0)
    assert layer.sample(np.array([0.5, 1.5, 1.0]), np.array([1.5, 1.5, 1.0])) == \
        pytest.approx([0.0, 10.0, 15.0])
    assert np.isnan(layer.sample(np.array([2.5]), np.array([1.0]))[0])
    assert layer.max_within(1.0, 1.0, 1.0) == (30.0, 1.5, 0.5)


def test_square_bounds_sit_on_the_lattice():
    b = horizon.square_bounds(12345.6, 67890.1, 15000.0, 10.0)
    assert b[2] - b[0] == 30000.0 and b[3] - b[1] == 30000.0
    assert all(v % 10.0 == 0.0 for v in b)


PVGIS_SAMPLE = """Latitude (deg.): 1.000
Longitude (deg.): 2.000

A\t\tH_hor\t\tA_sun(w)\t\tH_sun(w)
-180.0\t\t3.0\t\t-180.0\t\t0.0
-90.0\t\t2.0\t\t-90.0\t\t0.0
0.0\t\t1.0\t\t0.0\t\t5.0
90.0\t\t0.5\t\t90.0\t\t0.0

A: Azimuth (0 = S, 90 = W, -90 = E) (degree)
H_hor: Horizon height (degree)
"""


def test_a_pvgis_file_is_read_with_its_azimuths_turned_to_true_bearings(tmp_path):
    path = tmp_path / "horizon.csv"
    path.write_text(PVGIS_SAMPLE, encoding="ascii")
    lat, lon, rows = horizon.read_pvgis_horizon(path)
    assert (lat, lon) == (1.0, 2.0)
    assert rows == [(0.0, 3.0), (90.0, 2.0), (180.0, 1.0), (270.0, 0.5)]
    ours = np.zeros(720)
    ours[0], ours[180], ours[360], ours[540] = 3.0, 2.0, 1.0, 0.5
    result = horizon.compare_profiles(ours, rows)
    assert result["all"]["mean_abs_diff_deg"] == 0.0
    ours[360] = 2.0
    result = horizon.compare_profiles(ours, rows)
    assert result["south"]["mean_diff_deg"] == 1.0 and result["worst"]["true_bearing"] == 180.0
    assert result["north"]["mean_abs_diff_deg"] == 0.0
