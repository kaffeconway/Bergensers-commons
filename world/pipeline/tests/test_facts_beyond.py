"""The garden point's horizon from terrain beyond the drawn world (sun.horizon.beyond_world),
and the sun's altitude (sun.altitude_m): the keys the viewer's far gate and refraction use.

Every raster here is invented, and the synthetic world is too (commons_world/synthetic.py).
"""

import json
import math

import numpy as np
import pytest

from commons_world import facts as factslib
from commons_world.facts import horizon
from commons_world.facts.horizon import Band, Layer
from commons_world.facts.world import load_world

OFFSET = 3.4   # a made-up grid north offset


def flat_layer(half, cell, fill=0.0):
    size = int(2 * half / cell)
    return Layer(np.full((size, size), fill, dtype=np.float32), -half, half, cell)


def block(layer, true_bearing, dist, depth, half_width, height, offset=OFFSET):
    """Raise a block `height` m high, `depth` deep, at `dist` m along a true bearing."""
    k = (np.arange(layer.width) + 0.5) * layer.cell
    e = layer.west + k[None, :]
    n = layer.north - k[:, None]
    g = math.radians(true_bearing + offset)
    along = e * math.sin(g) + n * math.cos(g)
    across = -e * math.cos(g) + n * math.sin(g)
    layer.array[(along >= dist) & (along <= dist + depth) & (np.abs(across) <= half_width)] = height


# -- the helpers, on invented rasters ---------------------------------------------------------

def test_a_ray_leaves_one_square_at_its_edge():
    squares = {(0, 0)}
    out = horizon.ray_exit_m(250.0, 500.0, squares, 1000, 0.0)
    assert out.dtype.kind == "i" and len(out) == horizon.N_AZ
    assert out[0] == 500            # true north
    assert out[180] == 750          # east
    assert out[360] == 500          # south
    assert out[540] == 250          # west
    # 45 deg true: north-east, leaves through the north edge at 500 / cos 45
    assert out[90] == math.ceil(500 / math.cos(math.radians(45)) - 1e-9)


def test_a_ray_walks_across_a_union_and_uses_the_grid_bearing():
    squares = {(0, 0), (1, 0), (1, 1)}
    out = horizon.ray_exit_m(500.0, 500.0, squares, 1000, 0.0)
    assert out[180] == 1500         # east, through (1, 0)
    assert out[0] == 500            # north: (0, 1) is not in the union
    # with an offset, true bearing b is drawn at grid bearing b + offset
    shifted = horizon.ray_exit_m(500.0, 500.0, squares, 1000, 10.0)
    assert shifted[160] == out[180]  # true 80 + 10 = grid 90
    assert horizon.ray_exit_m(-5.0, 500.0, squares, 1000, 0.0).tolist() == [0] * horizon.N_AZ


def test_only_terrain_beyond_the_edge_counts():
    # a fake 100 m layer: a 400 m block 5 km true south and a 700 m block 20 km true south
    layer = flat_layer(30000.0, 100.0)
    block(layer, 180.0, 5000.0, 300.0, 400.0, 400.0)
    block(layer, 180.0, 20000.0, 300.0, 1500.0, 700.0)
    bands = [Band(layer, 100.0, 29000.0, 100.0)]
    eye = 1.5
    full, full_d = horizon.cast([0.0], [0.0], [eye], bands, OFFSET)
    from_m = np.full(horizon.N_AZ, 11000)
    tan, dist = horizon.beyond_profile(0.0, 0.0, eye, bands, from_m, OFFSET)
    south = 360
    assert 5000.0 <= full_d[0, south] <= 5300.0                  # the near block sets it
    assert 20000.0 <= dist[south] <= 20300.0                     # only the far one shows
    far = math.degrees(math.atan((700.0 - horizon.drop_m(dist[south]) - eye) / dist[south]))
    assert horizon.to_degrees(tan)[south] == pytest.approx(far, abs=1e-9)
    assert horizon.to_degrees(tan)[south] < horizon.to_degrees(full[0])[south]
    assert np.all(dist[dist > 0] >= 11000)
    assert np.all(tan <= full[0] + 1e-15)


def test_it_equals_the_full_horizon_where_that_is_set_beyond_the_edge():
    rng = np.random.default_rng(7)
    layer = flat_layer(30000.0, 100.0)
    layer.array[:] = rng.uniform(0.0, 40.0, layer.array.shape).astype(np.float32)
    for bearing in (20.0, 150.0, 181.0, 300.0):
        block(layer, bearing, 15000.0, 500.0, 800.0, 1500.0)
    block(layer, 90.0, 3000.0, 200.0, 300.0, 300.0)
    bands = [Band(layer, 210.0, 10000.0, 10.0), Band(layer, 10050.0, 29000.0, 50.0)]
    full, full_d = horizon.cast([0.0], [0.0], [30.0], bands, OFFSET)
    squares = {(i, j) for i in range(-3, 3) for j in range(-3, 3)}    # 24 km square
    from_m = horizon.ray_exit_m(0.0, 0.0, squares, 4000, OFFSET)
    tan, dist = horizon.beyond_profile(0.0, 0.0, 30.0, bands, from_m, OFFSET)
    beyond = full_d[0] >= from_m
    assert beyond.sum() > 20 and (~beyond).sum() > 20
    assert np.array_equal(tan[beyond], full[0][beyond])
    assert np.array_equal(dist[beyond], full_d[0][beyond])
    assert np.all(tan <= full[0])


# -- the synthetic world --------------------------------------------------------------------

@pytest.fixture(scope="module")
def facts(synthetic_world):
    return json.loads((synthetic_world / "facts.json").read_text(encoding="ascii"))


@pytest.fixture(scope="module")
def recomputed(synthetic_world):
    """compute() again on the built world, for what facts.json does not keep: the distance
    of each ray's horizon."""
    manifest = json.loads((synthetic_world / "manifest.json").read_text(encoding="ascii"))
    view = load_world(synthetic_world)
    provider = factslib._provider_for(view, None)
    return factslib.compute(view, provider, generated_at="2026-01-01T00:00:00Z",
                            levels=manifest["levels"])


def test_the_synthetic_far_horizon_has_its_keys(facts):
    beyond = facts["sun"]["horizon"]["beyond_world"]
    assert beyond["observer"] == "garden point, eye 1.5 m above the terrain"
    assert beyond["from"] == "where each ray leaves the world's h20 squares (land and sea)"
    for key in ("from_m", "profile_deg", "distance_m"):
        assert len(beyond[key]) == 720
    assert all(isinstance(v, int) for v in beyond["from_m"] + beyond["distance_m"])
    # the drawn world reaches at least 11 km (the h20 radius) on every bearing
    assert min(beyond["from_m"]) >= 11000
    for d, f in zip(beyond["distance_m"], beyond["from_m"]):
        assert d == 0 or d >= f


def test_the_far_horizon_is_never_above_the_full_one(facts):
    h = facts["sun"]["horizon"]
    assert all(b <= p for b, p in zip(h["beyond_world"]["profile_deg"], h["profile_deg"]))


def test_the_far_horizon_equals_the_full_one_where_that_is_set_beyond_the_edge(facts,
                                                                                recomputed):
    new, report = recomputed
    assert new["sun"]["horizon"] == facts["sun"]["horizon"]
    h = facts["sun"]["horizon"]
    beyond = h["beyond_world"]
    far = np.asarray(report["garden_horizon_distance_m"]) >= np.asarray(beyond["from_m"])
    assert far.any()
    for k in np.flatnonzero(far):
        assert beyond["profile_deg"][k] == h["profile_deg"][k]


def test_the_sun_altitude_is_the_mean_plot_ground(facts, synthetic_world):
    view = load_world(synthetic_world)
    h1 = Layer(np.where(np.isfinite(view.dtm1), view.dtm1, np.nan).astype(np.float32),
               view.h1.west, view.h1.north, view.h1.cell)
    pm = facts["sun"]["plot_map"]
    oe, on = view.origin
    cells = np.asarray(pm["dec21_min_terrain"]).reshape(pm["rows"], pm["cols"])
    r, q = np.nonzero(cells >= 0)
    e = oe + pm["x0"] + (q + 0.5) * pm["cell_m"]
    n = on - (pm["z0"] + (r + 0.5) * pm["cell_m"])
    mean = float(np.nanmean(h1.sample(e, n)))
    assert facts["sun"]["altitude_m"] == pytest.approx(max(mean, 0.0), abs=0.01)
    assert facts["sun"]["altitude_m"] == round(facts["sun"]["altitude_m"], 2)
