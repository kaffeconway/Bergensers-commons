"""Roof shapes fitted to the surface model (commons_world.roofs).

Every scene is synthetic: a gently tilted terrain plane on an invented 60 x 60 m
grid, a roof of known shape built on it, and the whole run through the real
segmentation (buildings.segment) before the fitter sees it.
"""

import gzip
import json
import math
import shutil

import numpy as np
import pytest
from affine import Affine
from rasterio.features import rasterize
from shapely import affinity
from shapely.geometry import Point, Polygon, box

from commons_world import buildings, manifest, roofs
from commons_world.__main__ import main
from commons_world.n50 import BuildingPoint

SIZE = 60


class Grid:
    """What segment() and fit_all() need from a LevelGrid: origin (0, 0) at the centre."""

    def __init__(self, size=SIZE):
        self.cell = 1.0
        self.west, self.north = -size / 2, size / 2
        self.transform = Affine(1.0, 0.0, self.west, 0.0, -1.0, self.north)
        self.shape = (size, size)


def scene(kind, width, depth, rot, eave, rise, noise=0.03, slope=(0.05, -0.02), trees=0,
          seed=1, wing=None, strip=None, surface=None):
    """A building of `width` along its ridge and `depth` across it, turned `rot` degrees
    anticlockwise from east, its eave `eave` above the highest ground under it.

    kind: flat, shed, gable, hip (d = 0 when width == depth: a pyramid), wings (a second
    gable `wing` = (along, across, width, depth) crossing the first: an L or a T), or
    surface (`surface(X, N, dtm)` over the footprint). `strip` makes that many metres
    along one eave rough enough to fail the planarity test, as a truncated face."""
    rng = np.random.default_rng(seed)
    xs = np.arange(SIZE) + 0.5 - SIZE / 2
    ns = SIZE / 2 - np.arange(SIZE) - 0.5
    X, N = np.meshgrid(xs, ns)
    dtm = 20.0 + slope[0] * X + slope[1] * N
    a = math.radians(rot)
    along = X * math.cos(a) + N * math.sin(a)
    across = -X * math.sin(a) + N * math.cos(a)
    inside = (np.abs(along) <= width / 2) & (np.abs(across) <= depth / 2)
    inside2 = np.zeros_like(inside)
    if wing is not None:
        wa, wc, ww, wd = wing
        inside2 = (np.abs(along - wa) <= ww / 2) & (np.abs(across - wc) <= wd / 2)
    m = inside | inside2
    base = dtm[m].max() + eave
    p = rise / (depth / 2)
    if kind == "flat":
        z = np.full_like(X, base)
    elif kind == "shed":
        z = base + rise * (across + depth / 2) / depth
    elif kind == "gable":
        z = base + rise * np.clip(1 - np.abs(across) / (depth / 2), 0, 1)
    elif kind == "hip":
        z = base + np.clip(np.minimum(depth / 2 - np.abs(across), width / 2 - np.abs(along)),
                           0, None) * p
    elif kind == "wings":
        wa, wc, ww, wd = wing
        za = base + np.clip(depth / 2 - np.abs(across), 0, None) * p
        zb = base + np.clip(ww / 2 - np.abs(along - wa), 0, None) * p
        z = np.where(inside & inside2, np.maximum(za, zb), np.where(inside, za, zb))
    else:
        z = surface(X, N, dtm)
    dom = dtm.copy()
    dom[m] = z[m] + rng.normal(0.0, noise, int(m.sum()))
    if strip:
        sel = m & (across > depth / 2 - strip)
        dom[sel] += np.where((np.floor(X[sel]) + np.floor(N[sel])) % 2 == 0, 0.3, -0.3)
    for _ in range(trees):                        # crowns overhanging an eave
        cx, cn = rng.uniform(-width / 2, width / 2), rng.choice([-1, 1]) * (depth / 2 + rng.uniform(0, 2))
        tx, tn = cx * math.cos(a) - cn * math.sin(a), cx * math.sin(a) + cn * math.cos(a)
        hgt, rad = rng.uniform(9, 14), rng.uniform(2.5, 4)
        d = np.hypot(X - tx, N - tn)
        crown = np.where(d < rad, dtm + hgt * (1 - 0.5 * (d / rad) ** 2)
                         + rng.normal(0, 0.5, X.shape), -1e9)
        dom = np.maximum(dom, crown)
    return {"dom": dom, "dtm": dtm, "X": X, "N": N, "base": base, "p": p, "a": a,
            "along": along, "across": across, "inside": m}


def fit(sc, house=False):
    """(roof_shape, the Building, the fit's details) of the one building in a scene."""
    grid = Grid()
    found, _, labels = buildings.segment(sc["dom"], sc["dtm"], grid,
                                         [BuildingPoint(111, 0.0, 0.0, 1, "TB")],
                                         return_labels=True)
    assert len(found) == 1
    found[0].house = house
    details = {}
    shapes, stats = roofs.fit_all(found, sc["dom"], sc["dtm"], grid, labels, (0, 0),
                                  details=details)
    assert stats["by_model"] == {shapes[found[0].label]["model"]: 1}
    return shapes[found[0].label], found[0], details[found[0].label]


def truth_planes(kind, sc, rise, width, depth):
    """The true roof as planes (gx, gn, c) in (x east, n north)."""
    a, base, p = sc["a"], sc["base"], sc["p"]
    s, c = math.sin(a), math.cos(a)
    if kind == "flat":
        return [(0.0, 0.0, base)]
    if kind == "shed":
        k = rise / depth
        return [(-k * s, k * c, base + rise / 2)]
    planes = [(p * s, -p * c, base + p * depth / 2), (-p * s, p * c, base + p * depth / 2)]
    if kind == "hip":
        planes += [(-p * c, -p * s, base + p * width / 2), (p * c, p * s, base + p * width / 2)]
    return planes


def truth_extremes(shape, planes):
    """The true roof's lowest and highest points over the drawn outline."""
    at = shape["at"]
    true = dict(shape, parts=[dict(part, planes=[[gx, -gn, gx * at[0] - gn * at[1] + c]
                                                 for gx, gn, c in planes])
                              for part in shape["parts"]])
    return roofs.roof_extremes(true)


def bearing_error(a, b, period=180.0):
    d = abs((a - b) % period)
    return min(d, period - d)


def part_pitch(part):
    return max(math.degrees(math.atan(math.hypot(sx, sz))) for sx, sz, _ in part["planes"])


KNOWN = [
    # label, kind, width, depth, rot, eave, rise
    ("gable 10x10 at 0", "gable", 10, 10, 0, 3.2, 3.0),
    ("gable 7x6 at 15, low", "gable", 7, 6, 15, 2.8, 0.8),
    ("gable 12x9 at 25", "gable", 12, 9, 25, 3.0, 2.5),
    ("gable 8x6 at 40", "gable", 8, 6, 40, 2.8, 2.2),
    ("gable 20x8 at 15, steep", "gable", 20, 8, 15, 3.0, 3.2),
    ("hip 14x9 at 20", "hip", 14, 9, 20, 3.0, 2.6),
    ("pyramid 9x9 at 10", "hip", 9, 9, 10, 3.0, 2.6),
    ("shed 12x8 at 30", "shed", 12, 8, 30, 3.0, 2.0),
    ("flat 14x10", "flat", 14, 10, 0, 6.0, 0.0),
]


@pytest.mark.parametrize("label,kind,width,depth,rot,eave,rise", KNOWN, ids=[k[0] for k in KNOWN])
def test_known_shapes(label, kind, width, depth, rot, eave, rise):
    sc = scene(kind, width, depth, rot, eave, rise)
    shape, _, _ = fit(sc)
    assert shape["model"] == kind and shape["quality"] == "good", shape
    true_pitch = {"flat": 0.0, "shed": math.degrees(math.atan(rise / depth))}.get(
        kind, math.degrees(math.atan(rise / (depth / 2))))
    assert shape["pitch"] == pytest.approx(true_pitch, abs=2.5 if depth < 8 else 2.0)
    if kind in ("gable", "hip"):
        assert bearing_error(shape["ridge_bearing"], 90.0 - rot) <= 3.5
    elif kind == "shed":                      # the downhill bearing, 0-360
        assert bearing_error(shape["ridge_bearing"], 180.0 - rot, 360.0) <= 3.5
    else:
        assert "ridge_bearing" not in shape
    eave_t, ridge_t = truth_extremes(shape, truth_planes(kind, sc, rise, width, depth))
    assert shape["eave"] == pytest.approx(eave_t, abs=0.3)
    assert shape["ridge"] == pytest.approx(ridge_t, abs=0.3)
    assert roofs.check_shape(shape) == []


def test_noise_crowns_and_a_steep_slope_still_give_the_gable():
    true_pitch = math.degrees(math.atan(2.5 / 4.5))
    noisy, _, _ = fit(scene("gable", 12, 9, 25, 3.0, 2.5, noise=0.15, seed=4))
    assert noisy["model"] == "gable" and noisy["quality"] in ("good", "fair")
    assert noisy["pitch"] == pytest.approx(true_pitch, abs=2.0)
    crowned, _, _ = fit(scene("gable", 12, 9, 25, 3.0, 2.5, trees=2, seed=3))
    assert crowned["model"] == "gable" and crowned["inliers"] < 1.0
    assert crowned["pitch"] == pytest.approx(true_pitch, abs=2.0)
    sloped, _, _ = fit(scene("gable", 12, 9, 25, 3.0, 2.5, slope=(0.2, 0.05)))
    assert sloped["model"] == "gable"
    assert sloped["pitch"] == pytest.approx(true_pitch, abs=2.0)


@pytest.mark.parametrize("rot,wing", [(0, (3.5, 7.0, 7.0, 8.0)), (30, (3.5, 7.0, 7.0, 8.0)),
                                      (0, (0.0, 7.0, 6.0, 8.0))], ids=["L", "L at 30", "T"])
def test_l_and_t_shapes_split_into_two_gables_that_tile_the_outline(rot, wing):
    shape, _, _ = fit(scene("wings", 14, 8, rot, 3.0, 2.3, wing=wing))
    assert shape["model"] == "split" and len(shape["parts"]) == 2
    true_pitch = math.degrees(math.atan(2.3 / 4))
    for part in shape["parts"]:
        assert part["model"] == "gable"
        assert part_pitch(part) == pytest.approx(true_pitch, abs=2.0)
    assert "ridge_bearing" not in shape
    polys = [Polygon([(x, -z) for x, z in part["ring"]]) for part in shape["parts"]]
    from shapely.ops import unary_union
    union = unary_union(polys)
    assert abs(sum(p.area for p in polys) - union.area) < 1e-3
    assert polys[0].intersection(polys[1]).area < 1e-9
    assert union.geom_type == "Polygon"
    assert roofs.check_shape(shape) == []


def test_a_truncated_face_is_grown_back():
    # the outer 2 m of one face fail the planarity test, as on a real roof whose eave
    # cells mix roof and ground: the traced outline falls short on that side
    sc = scene("gable", 12, 9, 25, 3.0, 2.5, strip=2)
    shape, building, info = fit(sc)
    truth = affinity.rotate(box(-6, -4.5, 6, 4.5), 25, origin=(0, 0))
    drawn = Polygon([(x, -z) for x, z in shape["parts"][0]["ring"]])
    assert info["grown"] > 0
    assert building.polygon.hausdorff_distance(truth) > 1.5      # the traced ring is short
    assert drawn.hausdorff_distance(truth) <= 1.0                 # within a cell of the truth
    assert shape["pitch"] == pytest.approx(math.degrees(math.atan(2.5 / 4.5)), abs=2.0)


def test_the_house_is_drawn_over_its_traced_ring_and_not_regrown(monkeypatch):
    monkeypatch.setattr(roofs, "HOUSE_OUTLINE", "traced")
    sc = scene("gable", 12, 9, 25, 3.0, 2.5, strip=2)
    shape, building, info = fit(sc, house=True)
    ring = buildings.buildings_record([building], (0, 0))["features"][0]["ring"]
    assert shape["outline"] == "traced" and len(shape["parts"]) == 1
    assert shape["parts"][0]["ring"] == ring
    assert info["grown"] == 0
    assert shape["pitch"] == pytest.approx(math.degrees(math.atan(2.5 / 4.5)), abs=2.0)
    # as another building it would be regrown and straightened
    other, _, info = fit(sc, house=False)
    assert other["outline"] == "straightened" and info["grown"] > 0


def _sawtooth(width, depth, period, amp):
    """A thin building along the grid whose roof is a sawtooth no single model explains."""
    def saw(X, N, dtm):
        return dtm.max() + 4.0 + amp * ((X % period) / period)
    return scene("surface", width, depth, 0, 0.0, 0.0, surface=saw, noise=0.02)


@pytest.mark.parametrize("width,depth,period,amp", [(16, 4, 5, 1.5), (16, 4, 8, 2.0),
                                                    (20, 5, 5, 1.5), (24, 6, 5, 1.5)])
def test_a_thin_building_along_the_grid_that_fits_poorly_never_stops_the_build(
        monkeypatch, width, depth, period, amp):
    # Split lines along a raster row leave one side a single row of cells, which does not
    # fix a plane: the batched shed solve must answer as the per-offset path does, not raise
    batched, _, _ = fit(_sawtooth(width, depth, period, amp))
    monkeypatch.setattr(roofs, "SPLIT_BATCH_CELLS", 0)
    per_offset, _, _ = fit(_sawtooth(width, depth, period, amp))
    assert batched == per_offset
    assert batched["model"] in ("split", "none")


def test_the_batched_shed_solve_takes_the_minimum_norm_answer_on_one_row_of_cells():
    # one row of cells along x: the plane's slope across it is not fixed by the data
    x = np.arange(12) - 5.5
    n = np.zeros(12)
    z = 30.0 + 0.2 * x
    A = np.stack([x, n, np.ones(12)], axis=1)
    W = np.vstack([np.ones(12), np.r_[np.ones(6), np.zeros(6)]])
    got = roofs._shed_rows(W, A, z)
    for k in range(2):
        sw = np.sqrt(W[k])
        want = np.linalg.lstsq(A * sw[:, None], z * sw, rcond=None)[0]
        assert np.allclose(got[k], want, atol=1e-9)
    assert np.allclose(got[0], [0.2, 0.0, 30.0], atol=1e-9)


def test_a_split_whose_parts_fold_when_rounded_falls_back_instead_of_stopping_the_build(
        monkeypatch):
    # With no reflex corner to snap to, the cut can leave a part thin enough that the
    # 0.1 m rounding folds it over itself: that building is refused, the build goes on
    monkeypatch.setattr(roofs, "SPLIT_SNAP_M", 0.0)
    shape, _, info = fit(scene("wings", 14, 8, 10, 3.0, 2.3, wing=(3.5, 7.0, 7.0, 8.0)),
                         house=True)
    assert shape == {"model": "none", "reason": "implausible"}
    assert any("could not be recorded" in p for p in info["problems"])


def test_a_reproducible_build_records_no_clock_reading(monkeypatch):
    from types import SimpleNamespace

    from commons_world import mapsteps
    monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
    assert mapsteps.reproducible(SimpleNamespace(synthetic=True))
    assert not mapsteps.reproducible(SimpleNamespace(synthetic=False))
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1700000000")
    assert mapsteps.reproducible(SimpleNamespace(synthetic=False))


def test_a_roof_that_comes_down_to_the_ground_is_refused():
    # the ground rises under one corner, to within half a metre of the eave: the drawn
    # roof over that corner would stand on the ground
    sc = scene("gable", 12, 9, 25, 3.0, 2.5)
    corner = (sc["along"] > 3) & (sc["across"] > 1.5) & sc["inside"]
    sc["dtm"] = sc["dtm"] + np.where(corner, 2.5, 0.0)
    shape, _, info = fit(sc)
    assert shape == {"model": "none", "reason": "implausible"}
    assert info["clearance"] < roofs.CLEARANCE_M


def test_a_canopy_patch_fits_no_model():
    # locally planar (so segmentation accepts it) but undulating: no roof explains it
    def canopy(X, N, dtm):
        return dtm + 12.0 + np.sin(2 * np.pi * X / 8) * np.sin(2 * np.pi * N / 8)
    shape, _, _ = fit(scene("surface", 14, 14, 0, 0.0, 0.0, noise=0.02, surface=canopy))
    assert shape == {"model": "none", "reason": "no model fits"}


def staircase(true):
    """The traced cell outline of a true shape, as the segmentation would give it."""
    tr = Affine(1, 0, -30, 0, -1, 30)
    m = rasterize([(true, 1)], out_shape=(60, 60), transform=tr, fill=0, dtype="uint8")
    return buildings.component_polygons(m.astype(np.int32), tr)[1]


@pytest.mark.parametrize("true,bearing", [
    (affinity.rotate(box(-6, -4.5, 6, 4.5), 25, origin=(0, 0)), 65),
    (affinity.rotate(box(-4, -3, 4, 3), 40, origin=(0.3, 0.2)), 50),
    (affinity.rotate(box(-10, -4, 10, 4), -10, origin=(0, 0)), 100),
    (affinity.rotate(box(-3.5, -3, 3.5, 3), 3, origin=(0, 0)), 87),
], ids=["12x9 at 25", "8x6 at 40", "20x8 at -10", "7x6 at 3"])
def test_straightened_rectangles_have_four_corners_on_the_truth(true, bearing):
    q, ok = roofs.straighten(staircase(true), bearing)
    assert ok and len(q.exterior.coords) - 1 == 4
    assert max(true.exterior.distance(Point(p)) for p in q.exterior.coords) <= 0.15


def test_a_straightened_l_has_six_corners():
    true = affinity.rotate(Polygon([(-7, -4), (7, -4), (7, 11), (0, 11), (0, 4), (-7, 4)]), 30,
                           origin=(0, 0))
    q, ok = roofs.straighten(staircase(true), 60)
    assert ok and len(q.exterior.coords) - 1 == 6
    assert max(true.exterior.distance(Point(p)) for p in q.exterior.coords) <= 0.15


def test_a_disc_is_never_drawn_further_from_its_cells_than_the_limits():
    # A disc has no edge along any bearing. Under the acceptance limits the straightening
    # may still replace its staircase by a polygon close to it; whatever it draws stays
    # within those limits of the traced cells, and it never claims a rectangle.
    for radius in (4.0, 6.0, 10.0):
        raw = staircase(Point(0.3, 0.2).buffer(radius, 64))
        for bearing in range(0, 180, 15):
            q, ok = roofs.straighten(raw, bearing)
            if not ok:
                assert q.equals(raw)
                continue
            assert len(q.exterior.coords) - 1 > 4
            assert abs(q.area / raw.area - 1) <= roofs.STRAIGHT_AREA_TOL
            assert max(raw.exterior.distance(Point(p)) for p in q.exterior.coords) \
                <= roofs.STRAIGHT_MAX_OFF_M
            assert q.symmetric_difference(raw).area / raw.exterior.length \
                <= roofs.STRAIGHT_MAX_DEV_M


def test_the_same_input_gives_the_same_bytes():
    sc = scene("wings", 14, 8, 30, 3.0, 2.3, wing=(3.5, 7.0, 7.0, 8.0))
    first = json.dumps(fit(sc)[0], sort_keys=True)
    assert json.dumps(fit(sc)[0], sort_keys=True) == first


def test_numbers_are_rounded_as_format_md_says():
    for sc in (scene("hip", 14, 9, 20, 3.0, 2.6),
               scene("wings", 14, 8, 30, 3.0, 2.3, wing=(3.5, 7.0, 7.0, 8.0))):
        shape = fit(sc)[0]
        assert all(round(v, 1) == v for v in shape["at"])
        for key, nd in (("eave", 2), ("ridge", 2), ("pitch", 1), ("rms", 2), ("inliers", 2),
                        ("ridge_bearing", 1)):
            if key in shape:
                assert round(shape[key], nd) == shape[key], key
        for part in shape["parts"]:
            assert all(round(v, 1) == v for p in part["ring"] for v in p)
            assert buildings.ring_signed_area_local(part["ring"]) > 0      # counter-clockwise
            for sx, sz, y0 in part["planes"]:
                assert round(sx, 4) == sx and round(sz, 4) == sz and round(y0, 2) == y0


def test_eave_and_ridge_are_the_drawn_roofs_extremes():
    shape = fit(scene("hip", 14, 9, 20, 3.0, 2.6))[0]
    at, part = shape["at"], shape["parts"][0]
    poly = Polygon([(x, -z) for x, z in part["ring"]])
    minx, miny, maxx, maxy = poly.bounds
    top, low = -1e9, 1e9
    for x in np.arange(minx, maxx, 0.05):
        for n in np.arange(miny, maxy, 0.05):
            if poly.contains(Point(x, n)):
                y = min(y0 + sx * (x - at[0]) + sz * (-n - at[1]) for sx, sz, y0 in part["planes"])
                top, low = max(top, y), min(low, y)
    assert top <= shape["ridge"] + 1e-6 and top > shape["ridge"] - 0.1
    assert low >= shape["eave"] - 1e-6 and low < shape["eave"] + 0.1


def test_check_shape_finds_what_a_reader_would_trip_on():
    good = fit(scene("wings", 14, 8, 0, 3.0, 2.3, wing=(3.5, 7.0, 7.0, 8.0)))[0]
    assert roofs.check_shape(good) == []
    assert roofs.check_shape({"model": "none", "reason": "implausible"}) == []
    assert roofs.check_shape({"model": "dome"})
    assert roofs.check_shape({"model": "none", "reason": "bad weather"})
    overlap = dict(good, parts=good["parts"] + [good["parts"][0]])
    assert any("overlap" in p for p in roofs.check_shape(overlap))
    flipped = dict(good, parts=[dict(good["parts"][0], ring=good["parts"][0]["ring"][::-1]),
                                good["parts"][1]])
    assert any("counter-clockwise" in p for p in roofs.check_shape(flipped))
    upside = dict(good, eave=good["ridge"] + 1)
    assert any("eave" in p for p in roofs.check_shape(upside))
    nan = dict(good, parts=[dict(good["parts"][0], planes=[[float("nan"), 0.0, 1.0]]),
                            good["parts"][1]])
    assert any("finite" in p for p in roofs.check_shape(nan))


def _rewrite_buildings(folder, edit):
    """Edit the world's buildings.json.gz in place and keep the manifest's entry true."""
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    entry = m["files"]["buildings"]
    doc = json.loads(gzip.decompress((folder / entry["file"]).read_bytes()))
    edit(doc)
    data = gzip.compress(json.dumps(doc, sort_keys=True).encode("ascii"), mtime=0)
    (folder / entry["file"]).write_bytes(data)
    entry.update(bytes=len(data), sha256=manifest.sha256_hex(data))
    (folder / "manifest.json").write_bytes(manifest.dumps_json(m))
    return m


def test_check_world_refuses_parts_that_overlap(synthetic_world, tmp_path):
    folder = tmp_path / "w"
    shutil.copytree(synthetic_world, folder)
    assert manifest.check_world(folder) == []

    def overlap(doc):
        shape = next(f["roof_shape"] for f in doc["features"] if f["roof_shape"]["model"] != "none")
        shape["parts"].append(dict(shape["parts"][0]))
    _rewrite_buildings(folder, overlap)
    problems = manifest.check_world(folder)
    assert any("files.buildings" in p and "overlap" in p for p in problems), problems


def test_the_facts_do_not_read_the_roof_shapes(synthetic_world, tmp_path):
    # roof_shape only adds keys (test_synthetic_build checks ring, ground and roof), so the
    # facts computed from a copy without it must be the build's own facts
    folder = tmp_path / "synthetic"
    shutil.copytree(synthetic_world, folder)
    before = json.loads((folder / "facts.json").read_text(encoding="ascii"))

    def strip(doc):
        for f in doc["features"]:
            f.pop("roof_shape", None)
    m = _rewrite_buildings(folder, strip)
    (folder / "facts.json").unlink()
    del m["files"]["facts"]
    (folder / "manifest.json").write_bytes(manifest.dumps_json(m))
    assert main(["facts", "--world", str(folder), "--cache", str(tmp_path / "cache")]) == 0
    after = json.loads((folder / "facts.json").read_text(encoding="ascii"))
    before.pop("generated_at")
    after.pop("generated_at")
    assert after == before


def test_no_roof_fitting_leaves_the_record_as_it_was(monkeypatch):
    sc = scene("gable", 12, 9, 25, 3.0, 2.5)
    grid = Grid()
    found, _, labels = buildings.segment(sc["dom"], sc["dtm"], grid,
                                         [BuildingPoint(111, 0.0, 0.0, 1, "TB")],
                                         return_labels=True)
    plain = buildings.buildings_record(found, (0, 0))
    shapes, _ = roofs.fit_all(found, sc["dom"], sc["dtm"], grid, labels, (0, 0))
    fitted = buildings.buildings_record(found, (0, 0), shapes)
    assert "roof_shape" not in plain["features"][0]
    assert {k: v for k, v in fitted["features"][0].items() if k != "roof_shape"} == \
        plain["features"][0]
