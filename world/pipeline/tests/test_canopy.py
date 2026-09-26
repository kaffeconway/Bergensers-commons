"""Canopy taken for a roof is not drawn (commons_world.roofs.drop_canopy).

Joseph's answer P2: where the surface is rough like tree crowns and no roof plane fits,
draw no building; where such a footprint holds a real roof part, draw only that part.
Every scene is synthetic: invented crowns, roofs and terrain on the 60 x 60 m grid of
test_roofs.py, run through the real segmentation and roof fit before the drop.
"""

import gzip
import json
import math
from types import SimpleNamespace

import numpy as np
import pytest
from shapely.geometry import Point, box

from commons_world import buildings, mapsteps, roofs, trees
from commons_world.grid import NEAREST, Level
from commons_world.n50 import BuildingPoint
from commons_world.parcel import ring_local
from test_roofs import SIZE, Grid, bearing_error, part_pitch, scene


def crowns(X, N, dtm, seed, n=9, spread=6.0):
    """A clump of `n` overlapping tree crowns, 10-14 m tall, around (0, 0); the ground
    elsewhere."""
    rng = np.random.default_rng(seed)
    z = np.full_like(X, -np.inf)
    for _ in range(n):
        tx, tn = rng.uniform(-spread, spread, 2)
        h, r = rng.uniform(10, 14), rng.uniform(3.0, 4.5)
        d = np.hypot(X - tx, N - tn)
        z = np.maximum(z, np.where(d < r * 1.3, dtm + h * (1 - 0.35 * (d / r) ** 2), -np.inf))
    return np.maximum(z, dtm)


def gable(X, N, base, centre, width, depth, rise):
    """A gable roof along x (ridge bearing 90), and -inf outside it."""
    across = N - centre[1]
    inside = (np.abs(X - centre[0]) <= width / 2) & (np.abs(across) <= depth / 2)
    return np.where(inside, base + rise * np.clip(1 - np.abs(across) / (depth / 2), 0, 1), -np.inf)


def plain(seed=1):
    """(X, N, dtm, noise) on the test grid: a gently tilted terrain plane."""
    xs = np.arange(SIZE) + 0.5 - SIZE / 2
    X, N = np.meshgrid(xs, SIZE / 2 - np.arange(SIZE) - 0.5)
    dtm = 20.0 + 0.05 * X - 0.02 * N
    return X, N, dtm, np.random.default_rng(seed).normal(0.0, 0.03, X.shape)


def canopy_scene(seed=2):
    return scene("surface", 16, 16, 0, 0.0, 0.0, noise=0.08, seed=seed,
                 surface=lambda X, N, dtm: crowns(X, N, dtm, seed=seed))


def sine_canopy():
    # test_roofs.py's canopy patch: locally planar enough for the segmentation, undulating
    def surface(X, N, dtm):
        return dtm + 12.0 + np.sin(2 * np.pi * X / 8) * np.sin(2 * np.pi * N / 8)
    return scene("surface", 14, 14, 0, 0.0, 0.0, noise=0.02, surface=surface)


def stairs_scene():
    # three flat steps 1.5 m apart: every cell on a plane, and no one roof explains them
    def surface(X, N, dtm):
        return dtm.max() + 3.0 + 1.5 * np.clip(np.floor((X + 9) / 4), 0, 4)
    return scene("surface", 16, 8, 0, 0.0, 0.0, noise=0.03, surface=surface)


def corner_scene():
    # test_roofs.py's gable whose eave comes down to rising ground: refused as implausible
    sc = scene("gable", 12, 9, 25, 3.0, 2.5)
    corner = (sc["along"] > 3) & (sc["across"] > 1.5) & sc["inside"]
    sc["dtm"] = sc["dtm"] + np.where(corner, 2.5, 0.0)
    return sc


def partial_scene(seed=1):
    """A 8 x 6 m gable at (-5, 1), ridge along x, 2 m rise, with a clump of crowns
    growing against its east end, so the segmentation takes both as one footprint."""
    def surface(X, N, dtm):
        roof = gable(X, N, dtm.max() + 3.0, (-5.0, 1.0), 8.0, 6.0, 2.0)
        trees_ = np.where(X > -1.2, crowns(X - 5.0, N, dtm, seed=seed, n=14, spread=6.0), -np.inf)
        return np.maximum(np.maximum(roof, trees_), dtm)
    return scene("surface", 26, 18, 0, 0.0, 0.0, noise=0.03, surface=surface)


def run(sc, points, house=None):
    """Segment, fit and drop; returns (grid, found, labels before, labels after, shapes,
    roof stats, summary)."""
    grid = Grid()
    found, _, labels = buildings.segment(sc["dom"], sc["dtm"], grid, points, return_labels=True)
    for b in found:
        b.house = house is not None and b.polygon.contains(Point(*house))
    shapes, _ = roofs.fit_all(found, sc["dom"], sc["dtm"], grid, labels, (0, 0))
    before = {b.label: dict(shapes[b.label]) for b in found}
    after, stats, summary = roofs.drop_canopy(found, shapes, sc["dom"], sc["dtm"], grid, labels,
                                              (0, 0), 0.0)
    return SimpleNamespace(grid=grid, found=found, labels=labels, after=after, shapes=shapes,
                           before=before, stats=stats, summary=summary)


def one_point(x=0.0, n=0.0, kind=181):
    return [BuildingPoint(kind, x, n, 1, "TB")]


@pytest.mark.parametrize("make", [canopy_scene, sine_canopy], ids=["crowns", "undulating"])
def test_a_footprint_rough_like_tree_crowns_is_not_drawn(make):
    r = run(make(), one_point())
    (b,) = r.found
    assert r.before[b.label] == {"model": "none", "reason": "no model fits"}
    assert b.dropped == roofs.CANOPY_DROPPED and not b.trimmed
    assert b.label not in r.shapes
    assert not (r.after == b.label).any() and (r.labels == b.label).any()
    record = buildings.buildings_record(r.found, (0, 0), r.shapes)
    assert record["features"] == []
    assert b.id == 1
    assert roofs.canopy_stats(r.found, r.summary) == {
        "dropped": [{"id": 1, "reason": roofs.CANOPY_DROPPED}], "trimmed": [],
        "house_canopy_like": False}
    assert r.stats["by_model"] == {} and r.stats["fallback_reasons"] == {}


@pytest.mark.parametrize("make,reason", [(stairs_scene, "no model fits"),
                                         (corner_scene, "implausible")],
                         ids=["steps", "eave on the ground"])
def test_a_roof_that_fits_no_model_but_lies_on_planes_is_still_drawn(make, reason):
    r = run(make(), one_point())
    (b,) = r.found
    assert r.before[b.label] == {"model": "none", "reason": reason}
    assert not b.dropped and not b.trimmed
    assert r.shapes[b.label] == {"model": "none", "reason": reason}
    assert (r.after == r.labels).all()
    (feature,) = buildings.buildings_record(r.found, (0, 0), r.shapes)["features"]
    assert feature["roof_shape"] == {"model": "none", "reason": reason}
    assert r.stats["fallback_reasons"] == {reason: 1}


def test_canopy_around_a_roof_part_is_cut_down_to_the_part():
    sc = partial_scene()
    r = run(sc, one_point(-5.0, 1.0))
    (b,) = r.found
    assert r.before[b.label] == {"model": "none", "reason": "no model fits"}
    assert b.trimmed == roofs.CANOPY_TRIMMED and not b.dropped
    # the part: the gable's cells and one ring of eaves, nothing of the crowns beyond that
    truth = box(-9.0, -2.0, -1.0, 4.0)
    assert b.segmented.area > 3 * b.polygon.area
    assert b.polygon.difference(truth.buffer(1.01, join_style=2)).area == 0
    assert b.polygon.intersection(truth).area > 0.9 * truth.area
    kept = r.after == b.label
    assert kept.any() and not (kept & (r.labels != b.label)).any()
    assert kept.sum() == b.area
    shape = r.shapes[b.label]
    assert shape["model"] == "gable"
    assert bearing_error(shape["ridge_bearing"], 90.0) <= 3.5
    assert abs(part_pitch(shape["parts"][0]) - math.degrees(math.atan(2.0 / 3.0))) <= 2.5
    assert b.ground == float(np.median(sc["dtm"][kept]))
    assert b.roof == float(np.percentile(sc["dom"][kept], 90))
    (feature,) = buildings.buildings_record(r.found, (0, 0), r.shapes)["features"]
    assert feature["id"] == 1
    assert feature["ring"] == ring_local(b.polygon.exterior.coords, (0, 0))
    assert feature["roof_shape"] == shape
    assert roofs.canopy_stats(r.found, r.summary)["trimmed"] == [
        {"id": 1, "reason": roofs.CANOPY_TRIMMED}]
    assert r.stats["by_model"] == {"gable": 1}


def test_a_roof_part_that_fits_no_roof_is_dropped_with_the_canopy():
    X, N, dtm, noise = plain(seed=1)
    steps = np.where((np.abs(X + 5) <= 5) & (np.abs(N - 1) <= 3),
                     dtm.max() + 3.0 + 1.5 * np.clip(np.floor((X + 10) / 3.4), 0, 2), -np.inf)
    clump = np.where(X > -0.2, crowns(X - 6.0, N, dtm, seed=1, n=14, spread=6.0), -np.inf)
    dom = np.maximum(np.maximum(steps, clump), dtm) + noise
    r = run({"dom": dom, "dtm": dtm}, one_point(-5.0, 1.0))
    (b,) = r.found
    assert r.before[b.label] == {"model": "none", "reason": "no model fits"}
    assert b.dropped == roofs.CANOPY_PART_UNFIT
    assert buildings.buildings_record(r.found, (0, 0), r.shapes)["features"] == []


def test_the_house_is_never_dropped_and_is_reported_when_it_looks_like_canopy():
    r = run(canopy_scene(), one_point(kind=111), house=(0.0, 0.0))
    (b,) = r.found
    assert b.house
    assert not b.dropped and not b.trimmed
    assert r.shapes[b.label] == {"model": "none", "reason": "no model fits"}
    assert (r.after == r.labels).all()
    assert r.summary == {"house_canopy_like": True}
    (feature,) = buildings.buildings_record(r.found, (0, 0), r.shapes)["features"]
    assert feature["house"] is True
    assert roofs.canopy_stats(r.found, r.summary) == {"dropped": [], "trimmed": [],
                                                      "house_canopy_like": True}


def two_buildings(seed):
    """A: a clump of crowns centred 14 m north of a gable part at its south end (x 10);
    B: a plain gable 6 m north of the axis, well west. A's footprint as segmented lies
    north of B, its roof part south of B."""
    X, N, dtm, noise = plain(seed=seed)
    base = dtm.max() + 3.0
    a = gable(X, N, base, (10.0, 2.0), 8.0, 6.0, 2.0)
    a_trees = np.where(N > 4.8, crowns(X - 10.0, N - 14.0, dtm, seed=seed, n=14, spread=6.0), -np.inf)
    b = gable(X, N, base, (-18.0, 6.0), 8.0, 6.0, 2.0)
    dom = np.maximum(np.maximum(np.maximum(a, a_trees), b), dtm) + noise
    return {"dom": dom, "dtm": dtm}, [BuildingPoint(181, 10.0, 2.0, 1, "TB"),
                                      BuildingPoint(181, -18.0, 6.0, 2, "TB")]


def test_ids_do_not_depend_on_what_was_dropped_or_cut(monkeypatch):
    sc, points = two_buildings(seed=2)
    r = run(sc, points)
    a = next(b for b in r.found if b.polygon.distance(Point(10.0, 2.0)) < 1)
    other = next(b for b in r.found if b is not a)
    assert a.trimmed and not other.dropped and not other.trimmed
    # cut down, A's centroid is south of B's; its id still comes from its footprint as segmented
    assert a.polygon.centroid.y < other.polygon.centroid.y < a.segmented.centroid.y
    ids = [f["id"] for f in buildings.buildings_record(r.found, (0, 0), r.shapes)["features"]]
    assert (a.id, other.id) == (1, 2) and ids == [1, 2]
    # dropping A outright leaves B its id
    a.trimmed, a.dropped = None, roofs.CANOPY_DROPPED
    ids = [f["id"] for f in buildings.buildings_record(r.found, (0, 0), r.shapes)["features"]]
    assert ids == [2]
    # and with nothing dropped, the same ids
    monkeypatch.setattr(roofs, "DROP_CANOPY", False)
    grid = Grid()
    found, _, labels = buildings.segment(sc["dom"], sc["dtm"], grid, points, return_labels=True)
    shapes, _ = roofs.fit_all(found, sc["dom"], sc["dtm"], grid, labels, (0, 0))
    record = buildings.buildings_record(found, (0, 0), shapes)
    assert [(f["id"], round(f["ring"][0][0])) for f in record["features"]] == [
        (1, round(ring_local(a.segmented.exterior.coords, (0, 0))[0][0])),
        (2, round(ring_local(other.polygon.exterior.coords, (0, 0))[0][0]))]


def test_the_stats_name_ids_and_reasons_only():
    r = run(canopy_scene(), one_point())
    buildings.buildings_record(r.found, (0, 0), r.shapes)
    stats = roofs.canopy_stats(r.found, r.summary)
    assert set(stats) == {"dropped", "trimmed", "house_canopy_like"}
    for row in stats["dropped"] + stats["trimmed"]:
        assert set(row) == {"id", "reason"}
    assert "polygon" not in json.dumps(stats) and "ring" not in json.dumps(stats)


# -- through the build step: trees stand where a dropped footprint was -------------------

H1 = Level("h1", 1, 200, 60, 1, NEAREST)     # one invented 60 m chunk, (0, 0)
ORIGIN = (30.0, 30.0)


class Ctx(SimpleNamespace):
    def write_json(self, key, relpath, obj, gz=False):
        self.out[key] = obj
        return {"file": relpath}

    def write_file(self, key, relpath, data):
        self.out[key] = data
        return {"file": relpath, "bytes": len(data)}


def build_steps(dom_local, dtm_local, points_local):
    """step_buildings and step_trees on one chunk of the given heights (local x, north
    arrays over the stored 62 x 62 window); returns (buildings.json, trees, stats)."""
    oe, on = ORIGIN
    ctx = Ctx(levels=[H1], chunks={"h1": {(0, 0): dtm_local.astype(np.float32)}},
              map=mapsteps.MapInputs(surface={(0, 0): dom_local.astype(np.float32)},
                                     building_points=[BuildingPoint(181, oe + x, on + n, 1, "TB")
                                                      for x, n in points_local]),
              origin=ORIGIN, parcels=[], geocode_record=None, synthetic=True, class_band=None,
              warnings=[], log=lambda message: None, out={})
    mapsteps.step_buildings(ctx)
    mapsteps.step_trees(ctx)
    return ctx.out["buildings"], trees.decode(gzip.decompress(ctx.out["trees"])), \
        ctx.map.stats["buildings"]


def test_trees_are_found_under_a_footprint_that_is_not_drawn(monkeypatch):
    k = np.arange(H1.stored, dtype=np.float64)
    x = -H1.apron + k + 0.5 - ORIGIN[0]
    north = 60 + H1.apron - k - 0.5 - ORIGIN[1]
    X, N = np.meshgrid(x, north)
    dtm = 20.0 + 0.05 * X - 0.02 * N
    inside = (np.abs(X) <= 8) & (np.abs(N) <= 8)
    dom = np.where(inside, crowns(X, N, dtm, seed=2), dtm)
    dom = dom + np.where(inside, np.random.default_rng(2).normal(0.0, 0.08, X.shape), 0.0)

    def trees_inside(found, ring):
        poly = box(*np.min(ring, axis=0), *np.max(ring, axis=0))
        return sum(poly.contains(Point(tx, tz)) for tx, tz in zip(found["x"], found["z"]))

    monkeypatch.setattr(roofs, "DROP_CANOPY", False)
    drawn, before, stats = build_steps(dom, dtm, [(0.0, 0.0)])
    (feature,) = drawn["features"]
    assert feature["roof_shape"] == {"model": "none", "reason": "no model fits"}
    assert "canopy" not in stats
    ring = feature["ring"]
    assert trees_inside(before, ring) == 0

    monkeypatch.setattr(roofs, "DROP_CANOPY", True)
    dropped, after, stats = build_steps(dom, dtm, [(0.0, 0.0)])
    assert dropped["features"] == []
    assert stats["canopy"]["dropped"] == [{"id": 1, "reason": roofs.CANOPY_DROPPED}]
    assert trees_inside(after, ring) >= 2
    assert after["count"] > before["count"]
