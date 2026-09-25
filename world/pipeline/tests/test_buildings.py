"""Buildings: register points, roof segmentation, rings, and choosing the house.

The scenes are synthetic: a tilted terrain plane, box and gable roofs, and
noisy tree crowns, on an invented 200 x 200 m grid.
"""

import gzip
import json

import numpy as np
import pytest
from affine import Affine
from shapely.geometry import Point, box

from commons_world import buildings, synthetic
from commons_world.n50 import BuildingPoint

from conftest import FakeTransport
import gml_fixtures as fx

E0, N0 = synthetic.origin()
# Real canopy in a 1 m surface model is rough; with 0.5 m of noise no crown in these
# scenes passes the planarity test. (At 0.15 - 0.3 m a few low, broad crowns do, and
# only the anchoring to register points keeps them out.)
CANOPY_ROUGHNESS_M = 0.5


class Grid:
    """The two things segment() needs from a LevelGrid."""

    def __init__(self, west, north, size, cell=1.0):
        self.cell = cell
        self.transform = Affine(cell, 0.0, west, 0.0, -cell, north)
        self.shape = (size, size)


def scene(trees=True, seed=1):
    """(grid, dtm, dom, truth): a gable house, a flat garage and noisy trees."""
    size, west, north = 200, 1000.0, 5200.0
    g = Grid(west, north, size)
    rows, cols = np.mgrid[0:size, 0:size]
    e = west + cols + 0.5
    n = north - rows - 0.5
    dtm = 20.0 + 0.05 * (e - west) + 0.08 * (n - north + size)
    dom = dtm.copy()
    house = (west + 60, north - 50, 12.0, 9.0)      # centre e, n, width, depth
    m = (np.abs(e - house[0]) < house[2] / 2) & (np.abs(n - house[1]) < house[3] / 2)
    dom[m] = dtm[m].max() + 3.0 + 3.0 * (1.0 - np.abs(n[m] - house[1]) / (house[3] / 2))
    garage = (west + 140, north - 140, 8.0, 6.0)
    m = (np.abs(e - garage[0]) < garage[2] / 2) & (np.abs(n - garage[1]) < garage[3] / 2)
    dom[m] = dtm[m].max() + 3.2
    rng = np.random.default_rng(seed)
    crowns = []
    canopy = np.zeros_like(dtm)
    if trees:
        while len(crowns) < 40:
            tx, tn = rng.uniform(west + 10, west + 190), rng.uniform(north - 190, north - 10)
            if abs(tx - house[0]) < 20 and abs(tn - house[1]) < 18:
                continue
            if abs(tx - garage[0]) < 16 and abs(tn - garage[1]) < 14:
                continue
            h, cr = rng.uniform(6, 18), rng.uniform(1.5, 3.5)
            crowns.append((tx, tn))
            d = np.hypot(e - tx, n - tn)
            canopy = np.maximum(canopy, np.where(d < cr * np.sqrt(2),
                                                 h * (1 - 0.5 * (d / cr) ** 2), 0.0))
        rough = canopy > 0.5
        canopy[rough] += rng.normal(0.0, CANOPY_ROUGHNESS_M, int(rough.sum()))
    dom = np.maximum(dom, dtm + canopy)
    return g, dtm, dom, {"house": house, "garage": garage, "crowns": crowns}


def test_plane_rms_is_zero_on_planes_and_large_on_curved_surfaces():
    rows, cols = np.mgrid[0:20, 0:20].astype(float)
    tilted = buildings.plane_rms(400.0 + 0.3 * cols - 0.7 * rows)
    assert np.max(tilted[1:-1, 1:-1]) < 1e-6
    assert np.all(np.isinf(tilted[0])) and np.all(np.isinf(tilted[:, -1]))   # no full window
    assert np.max(buildings.plane_rms(np.full((20, 20), 400.0))[1:-1, 1:-1]) < 1e-6
    bowl = 0.5 * ((cols - 10) ** 2 + (rows - 10) ** 2)
    assert np.min(buildings.plane_rms(bowl)[1:-1, 1:-1]) > 0.25
    holed = np.full((20, 20), 400.0)
    holed[10, 10] = np.nan
    assert np.isinf(buildings.plane_rms(holed)[9:12, 9:12]).all()


def test_two_boxes_and_noisy_trees_make_exactly_two_buildings():
    g, dtm, dom, truth = scene()
    points = [BuildingPoint(111, truth["house"][0] + 1, truth["house"][1] - 1, 1, "TB"),
              BuildingPoint(181, truth["garage"][0], truth["garage"][1], 2, "TB")]
    found, stats = buildings.segment(dom, dtm, g, points)
    assert len(found) == 2
    by_type = {b.type: b for b in found}
    house, garage = by_type[111], by_type[181]
    assert house.area == pytest.approx(12 * 8, abs=6)      # cells whose centres are inside
    assert garage.area == pytest.approx(8 * 6, abs=4)
    assert house.polygon.contains(Point(truth["house"][0], truth["house"][1]))
    assert house.roof - house.ground > 5.0
    # A flat roof 3.2 m above the highest ground, over ground sloping ~0.9 m across it.
    assert garage.roof - garage.ground == pytest.approx(3.2 + 0.44, abs=0.3)
    for tx, tn in truth["crowns"]:
        assert not any(b.polygon.contains(Point(tx, tn)) for b in found)
    assert stats["register_points_without_roof"] == 0
    assert stats["buildings"] == 2


def test_tree_crowns_are_not_roof_candidates():
    g, dtm, dom, truth = scene()
    labels, count = buildings.roof_labels(dom, dtm)
    assert count == 2                                   # the house and the garage, nothing else
    for tx, tn in truth["crowns"]:
        r, q = int(g.transform.f - tn), int(tx - g.transform.c)
        assert labels[r, q] == 0
    # Even a register point on every tree top finds no roof.
    points = [BuildingPoint(111, tx, tn, i, "TB") for i, (tx, tn) in enumerate(truth["crowns"])]
    found, stats = buildings.segment(dom, dtm, g, points)
    assert found == [] and stats["register_points_without_roof"] == len(truth["crowns"])


def test_unanchored_roofs_are_dropped_and_roofless_points_counted():
    g, dtm, dom, truth = scene(trees=False)
    points = [BuildingPoint(111, truth["house"][0], truth["house"][1], 1, "TB"),
              BuildingPoint(111, 1100.0, 5190.0, 3, "IG")]        # nothing there
    found, stats = buildings.segment(dom, dtm, g, points)
    assert [b.type for b in found] == [111]
    assert stats["roof_candidates"] == 2
    assert stats["candidates_without_register_point"] == 1
    assert stats["register_points_without_roof"] == 1
    assert stats["register_points_by_status"] == {"IG": 1, "TB": 1}


def test_type_prefers_a_point_inside_then_a_dwelling():
    g, dtm, dom, truth = scene(trees=False)
    he, hn = truth["house"][:2]
    both_inside = [BuildingPoint(181, he - 3, hn, 1, "TB"), BuildingPoint(111, he + 3, hn, 2, "TB")]
    found, _ = buildings.segment(dom, dtm, g, both_inside)
    assert next(b for b in found if b.polygon.contains(Point(he, hn))).type == 111
    garage_inside = [BuildingPoint(181, he, hn, 1, "TB"), BuildingPoint(111, he, hn + 9, 2, "TB")]
    found, _ = buildings.segment(dom, dtm, g, garage_inside)
    house = next(b for b in found if b.polygon.contains(Point(he, hn)))
    assert house.type == 181 and house.residential


def test_rings_are_counter_clockwise_unclosed_and_rounded():
    g, dtm, dom, truth = scene(trees=False)
    points = [BuildingPoint(111, truth["house"][0], truth["house"][1], 1, "TB"),
              BuildingPoint(181, truth["garage"][0], truth["garage"][1], 2, "TB")]
    found, _ = buildings.segment(dom, dtm, g, points)
    origin = (1000, 5000)
    record = buildings.buildings_record(found, origin)
    assert record["version"] == 1 and [f["id"] for f in record["features"]] == [1, 2]
    for feature in record["features"]:
        ring = feature["ring"]
        assert ring[0] != ring[-1] and len(ring) >= 4
        assert buildings.ring_signed_area_local(ring) > 0
        assert all(round(v, 1) == v for point in ring for v in point)
        assert feature["source"] == "dom" and feature["house"] is False
        assert set(feature) == {"id", "type", "source", "ground", "roof", "house", "ring"}
    # North first: the house (50 m below the top edge) before the garage (140 m).
    assert [f["type"] for f in record["features"]] == [111, 181]
    text = json.dumps(record)
    assert "TB" not in text          # status and building numbers are not written


def make_building(label, polygon, types):
    b = buildings.Building(label=label, polygon=polygon, raw=polygon, ground=0.0, roof=5.0,
                           area=polygon.area,
                           points=[BuildingPoint(t, polygon.centroid.x, polygon.centroid.y)
                                   for t in types])
    b.type = types[0]
    b.residential = any(t in buildings.RESIDENTIAL for t in types)
    return b


def test_the_house_is_the_dwelling_in_the_parcel_nearest_the_address():
    parcel = box(0, 0, 60, 40)
    dwelling = make_building(1, box(30, 10, 42, 19), [111])
    garage = make_building(2, box(2, 2, 8, 8), [181])              # nearer, but a garage
    outside = make_building(3, box(-20, -20, -8, -10), [111])      # a dwelling, not in the parcel
    found = [dwelling, garage, outside]
    stats = buildings.choose_house(found, [parcel], (5.0, 5.0))
    assert stats["house"] is True and stats["candidates"] == 1
    assert [b.house for b in found] == [True, False, False]
    second = make_building(4, box(10, 25, 20, 35), [121])
    stats = buildings.choose_house(found + [second], [parcel], (5.0, 5.0))
    assert second.house and not dwelling.house and stats["candidates"] == 2
    assert "nearest the address point" in stats["note"]
    stats = buildings.choose_house([garage, outside], [parcel], (5.0, 5.0))
    assert stats["house"] is False and "dwelling" in stats["note"]
    assert not garage.house and not outside.house
    assert 181 not in buildings.RESIDENTIAL and 111 in buildings.RESIDENTIAL
    assert 161 in buildings.RESIDENTIAL and 211 not in buildings.RESIDENTIAL


def test_register_points_keep_only_type_number_status_and_position():
    page = fx.bygning_page([fx.bygning(1, E0 + 1.5, N0 + 2.5, 111, 900001),
                            fx.bygning(2, E0 + 10, N0 + 20, 181, 900002, status="IG")])
    points = buildings.parse_points(page)
    assert [(p.type, p.number, p.status) for p in points] == [(111, 900001, "TB"),
                                                              (181, 900002, "IG")]
    assert points[0].e == pytest.approx(E0 + 1.5) and points[0].n == pytest.approx(N0 + 2.5)
    assert set(vars(points[0])) == {"type", "e", "n", "number", "status", "source"}


def test_fetch_points_pages_and_asks_for_few_properties(make_client, monkeypatch):
    monkeypatch.setattr(buildings, "PAGE_SIZE", 2)
    members = [fx.bygning(i, E0 + i, N0 + i, 111, 900000 + i) for i in range(5)]
    log = []

    def handler(method, url, query, headers, body):
        log.append(query)
        start, count = int(query["startIndex"]), int(query["count"])
        return 200, {}, fx.bygning_page(members[start:start + count])
    transport = FakeTransport()
    transport.add("wfs.geonorge.no", "/skwms1/wfs.matrikkelen-bygningspunkt", handler)
    bounds = (E0 - 100, N0 - 100, E0 + 100, N0 + 100)
    points, requests = buildings.fetch_points(make_client(transport), bounds)
    assert len(points) == 5 and requests == 3
    assert log[0]["typeNames"] == "app:Bygning"
    assert log[0]["propertyName"] == buildings.PROPERTIES
    assert log[0]["bbox"].endswith(",urn:ogc:def:crs:EPSG::25832")


def test_buildings_json_is_written_gzipped_by_the_build(tmp_path):
    from commons_world import build as buildlib
    ctx = buildlib.BuildContext(work_dir=tmp_path)
    entry = ctx.write_json("buildings", "buildings.json.gz", {"version": 1, "features": []},
                           gz=True)
    data = json.loads(gzip.decompress((tmp_path / entry["file"]).read_bytes()))
    assert data == {"version": 1, "features": []}
