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
from shapely import contains_xy
from shapely.geometry import Point, Polygon, box

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


def narrow_stairs_scene():
    # steps 3 m wide: only a step's middle column holds a whole 3 x 3 window on it, so its
    # edge cells count as on a plane only through the window beside them
    def surface(X, N, dtm):
        return dtm.max() + 3.0 + 1.5 * np.floor((X + 7.5) / 3)
    return scene("surface", 15, 6, 0, 0.0, 0.0, noise=0.03, surface=surface)


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


@pytest.mark.parametrize("reason,dropped", [("no model fits", True), ("implausible", True),
                                            ("too few cells", False)])
def test_only_a_footprint_no_roof_fits_is_taken_for_crowns(reason, dropped):
    # FORMAT.md: roof_shape "none" for "no model fits" or "implausible" (a roof was found
    # and refused). The same crowns, with the fit's verdict given as each reason.
    sc = canopy_scene()
    grid = Grid()
    found, _, labels = buildings.segment(sc["dom"], sc["dtm"], grid, one_point(), return_labels=True)
    (b,) = found
    b.house = False
    shapes, _ = roofs.fit_all(found, sc["dom"], sc["dtm"], grid, labels, (0, 0))
    assert shapes[b.label] == {"model": "none", "reason": "no model fits"}
    shapes[b.label] = {"model": "none", "reason": reason}
    roofs.drop_canopy(found, shapes, sc["dom"], sc["dtm"], grid, labels, (0, 0), 0.0)
    assert bool(b.dropped) is dropped and not b.trimmed
    assert (b.label in shapes) is not dropped


def test_a_cell_is_on_a_plane_when_a_window_holding_it_is():
    # a flat strip three cells wide across rough ground: only its middle column is the
    # centre of a planar 3 x 3 window, and all three columns lie on that plane
    rng = np.random.default_rng(3)
    dom = rng.normal(0.0, 1.0, (12, 12))
    dom[:, 4:7] = 5.0
    rms = buildings.plane_rms(dom)
    assert (rms[2:-2, 5] < roofs.CANOPY_PATCH_RMS_M).all()
    assert not (rms[2:-2, 4] < roofs.CANOPY_PATCH_RMS_M).any()
    flat = roofs.planar_cells(rms)
    assert flat[2:-2, 4:7].all()
    assert not flat[:, :3].any() and not flat[:, 8:].any()


@pytest.mark.parametrize("make,reason", [(stairs_scene, "no model fits"),
                                         (narrow_stairs_scene, "no model fits"),
                                         (corner_scene, "implausible")],
                         ids=["steps", "narrow steps", "eave on the ground"])
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
    assert b.polygon.difference(truth.buffer(1.02, join_style=2)).area == 0
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


def test_a_roof_part_more_than_6_m_from_the_register_point_is_not_kept():
    # the same gable and crowns, with the register point out in the crowns, 10 m east of
    # the gable (ANCHOR_M is 6 m): the gable is not this point's building
    r = run(partial_scene(), one_point(9.0, 1.0))
    (b,) = r.found
    assert box(-9.0, -2.0, -1.0, 4.0).distance(Point(9.0, 1.0)) > buildings.ANCHOR_M
    assert r.before[b.label] == {"model": "none", "reason": "no model fits"}
    assert b.dropped == roofs.CANOPY_DROPPED and not b.trimmed
    assert not (r.after == b.label).any()


def eaves_scene(seed=1):
    """A 10 x 8 m gable at (-5, 1), ridge along x, 2 m rise, crowns against its east end,
    and its outermost ring of cells 0.5 m low, as cells half over the eave read in a 1 m
    surface model: planar enough for the segmentation, not for planar_cells."""
    def surface(X, N, dtm):
        roof = gable(X, N, dtm.max() + 3.0, (-5.0, 1.0), 10.0, 8.0, 2.0)
        edge = np.isfinite(roof) & ((np.abs(X + 5.0) > 4.0) | (np.abs(N - 1.0) > 3.0))
        roof = np.where(edge, roof - 0.5, roof)
        trees_ = np.where(X > -1.2, crowns(X - 5.0, N, dtm, seed=seed, n=14, spread=6.0), -np.inf)
        return np.maximum(np.maximum(roof, trees_), dtm)
    return scene("surface", 26, 18, 0, 0.0, 0.0, noise=0.03, surface=surface)


def test_a_cut_part_takes_back_its_eaves():
    sc = eaves_scene()
    r = run(sc, one_point(-5.0, 1.0))
    (b,) = r.found
    assert b.trimmed == roofs.CANOPY_TRIMMED
    truth = box(-10.0, -3.0, 0.0, 5.0)
    grid = Grid()
    c = roofs._crop(b.segmented.bounds, sc["dom"], sc["dtm"], r.labels, grid, (0, 0))
    edge = (c.lab == b.label) & ~contains_xy(truth.buffer(-1.0, join_style=2), c.X, c.N) & \
        contains_xy(truth, c.X, c.N)
    # the eave ring is in the footprint as segmented, and almost none of it on a plane ...
    assert edge.sum() >= 20 and roofs.planar_cells(c.rms)[edge].mean() < 0.2
    # ... and the part drawn takes it back: the whole gable, and at most a cell beyond it
    assert b.polygon.intersection(truth).area >= 0.95 * truth.area
    assert b.polygon.difference(truth.buffer(1.02, join_style=2)).area == 0
    assert r.shapes[b.label]["model"] == "gable"


def test_a_cut_part_is_not_drawn_over_a_neighbours_drawn_outline(monkeypatch):
    # The gable and crowns of partial_scene, and 3 m west of the gable a flat roof. Every
    # outline is straightened 1.8 m outward: each stays clear of the other's traced ring,
    # and the cut part's would still meet the flat roof's drawn outline in the gap, so the
    # part keeps its traced ring.
    X, N, dtm, noise = plain(seed=1)
    part = gable(X, N, dtm.max() + 3.0, (-5.0, 1.0), 8.0, 6.0, 2.0)
    clump = np.where(X > -1.2, crowns(X - 5.0, N, dtm, seed=1, n=14, spread=6.0), -np.inf)
    flat = np.where((X > -20) & (X < -12) & (N > -2) & (N < 4), dtm.max() + 4.0, -np.inf)
    dom = np.maximum(np.maximum(np.maximum(part, clump), flat), dtm) + noise
    monkeypatch.setattr(roofs, "straighten",
                        lambda raw, phi: (raw.buffer(1.8, join_style="mitre"), True))
    r = run({"dom": dom, "dtm": dtm}, [BuildingPoint(181, -5.0, 1.0, 1, "TB"),
                                       BuildingPoint(181, -16.0, 1.0, 2, "TB")])
    cut = next(b for b in r.found if b.trimmed)
    other = next(b for b in r.found if b is not cut)
    assert r.shapes[other.label]["outline"] == "straightened" and not other.dropped
    shape = r.shapes[cut.label]
    assert shape["model"] == "gable" and shape["outline"] == "traced"
    drawn = [Polygon([(x, -z) for x, z in r.shapes[b.label]["parts"][0]["ring"]])
             for b in (cut, other)]
    assert drawn[0].intersection(drawn[1]).area < 1e-6


@pytest.mark.xfail(strict=True, reason="B2R-1, open with the owner: a thin planar seam through "
                                       "crowns is taken for a roof plane")
@pytest.mark.parametrize("seed", [2, 4], ids=["cut down to the seam", "kept whole"])
def test_a_crown_clump_crossed_by_a_thin_planar_seam_is_not_drawn(seed):
    # A surface model can carry a line of cells that fits a plane through tree crowns (an
    # interpolation seam, say): here a strip three cells wide across the clump. By P2's
    # words it is still crowns with no roof planes. With the planar share as the only cue
    # it is not dropped: the strip is either cut out as a roof part (seed 2) or lifts the
    # share past CANOPY_PLANAR_SHARE (seed 4).
    sc = canopy_scene(seed=seed)
    X, N = sc["X"], sc["N"]
    seam = (np.abs(X - 0.5) <= 1.0) & (np.abs(N) <= 8.5) & (sc["dom"] - sc["dtm"] > 3)
    noise = np.random.default_rng(5).normal(0.0, 0.03, X.shape)
    dom = np.where(seam, sc["dtm"] + 12.0 + 0.1 * N + noise, sc["dom"])
    r = run({"dom": dom, "dtm": sc["dtm"]}, one_point())
    (b,) = r.found
    assert r.before[b.label] == {"model": "none", "reason": "no model fits"}
    assert b.dropped
    assert buildings.buildings_record(r.found, (0, 0), r.shapes)["features"] == []


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
    assert (stats["buildings"], stats["register_points_matched"], stats["drawn"]) == (1, 1, 1)
    ring = feature["ring"]
    assert trees_inside(before, ring) == 0

    monkeypatch.setattr(roofs, "DROP_CANOPY", True)
    dropped, after, stats = build_steps(dom, dtm, [(0.0, 0.0)])
    assert dropped["features"] == []
    assert stats["canopy"]["dropped"] == [{"id": 1, "reason": roofs.CANOPY_DROPPED}]
    # the segmentation's counts stay as segmented; "drawn" is what the file holds
    assert (stats["buildings"], stats["register_points_matched"], stats["drawn"]) == (1, 1, 0)
    assert trees_inside(after, ring) >= 2
    assert after["count"] > before["count"]
