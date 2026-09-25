"""Walking routes, peaks and trailheads on toy networks with made-up terrain."""

import io
import math

import networkx as nx
import numpy as np
import pytest

from commons_world import nvdb, synthetic
from commons_world.facts import access
from commons_world.n50 import Line

import gml_fixtures as fx


def valley(e, n):
    """Ground at 50 m, with a valley 0 m deep between E 100 and 300 (steep 20 m sides)."""
    e = np.asarray(e, dtype=np.float64)
    inside = np.clip(np.minimum(e - 100.0, 300.0 - e) / 20.0, 0.0, 1.0)
    return 50.0 - 50.0 * inside, np.ones(e.shape, dtype=np.int16)


def line(kind, coords, medium=None, source="test"):
    return Line(kind=kind, coords=np.asarray(coords, dtype=np.float64), medium=medium,
                source=source)


def shortest(lines, start, end, elevation=valley):
    """(route length, climb, coords) between two points, as access_facts would route it."""
    net = access.build_network(lines, elevation)
    s = access.choose_start(net, *start, min_component=0.0)
    joiner = access.Joiner(net, access.component_edges(net, s["node"]))
    target, gap, _ = joiner.join(*end)
    pred, dist = nx.dijkstra_predecessor_and_distance(net.graph, s["node"], weight="length")
    if target not in dist:
        return None, None, None
    coords, heights, _ = access.route(net, pred, s["node"], target)
    length, climb, _, _ = access.route_metrics(coords, heights)
    return length, climb, coords


def test_naismith_and_tobler():
    assert access.naismith_h(5000.0, 600.0) == pytest.approx(2.0)
    assert float(access.tobler_kmh(0.0)) == pytest.approx(5.04, abs=0.005)
    assert float(access.tobler_kmh(-0.05)) == pytest.approx(6.0)
    assert float(access.tobler_kmh(0.3)) < float(access.tobler_kmh(-0.3)) < 6.0


def test_reaches_summit_needs_50_m_across_and_20_m_up():
    assert access.reaches_summit(10.0, 5.0)
    assert access.reaches_summit(50.0, 20.0)
    assert access.reaches_summit(49.0, -19.0)
    assert not access.reaches_summit(51.0, 0.0)
    assert not access.reaches_summit(10.0, 21.0)
    assert not access.reaches_summit(None, 0.0)


def test_route_metrics_count_rises_and_falls():
    coords = np.column_stack([np.arange(0, 1001, 5.0), np.zeros(201)])
    heights = np.concatenate([np.linspace(0, 100, 101), np.linspace(100, 50, 101)[1:]])
    length, climb, descent, hours = access.route_metrics(coords, heights)
    assert length == pytest.approx(1000.0)
    assert climb == pytest.approx(100.0) and descent == pytest.approx(50.0)
    assert access.route_metrics(coords[:, :], np.zeros(201))[3] == pytest.approx(1.0 / 5.0381,
                                                                                 rel=1e-3)


def test_a_bridge_beats_the_detour_and_is_not_draped_over_the_valley():
    lines = [line("road", [(0, 0), (100, 0)]),
             line("road", [(100, 0), (300, 0)], medium="L"),
             line("road", [(300, 0), (400, 0)]),
             line("path", [(100, 0), (200, -150), (300, 0)])]
    length, climb, coords = shortest(lines, (0.0, 0.0), (400.0, 0.0))
    assert length == pytest.approx(400.0)
    assert climb == pytest.approx(0.0, abs=1e-6)          # 50 m to 50 m along the bridge
    assert np.all(coords[:, 1] == 0.0)
    detour, detour_climb, _ = shortest([l for l in lines if l.medium != "L"],
                                       (0.0, 0.0), (400.0, 0.0))
    assert detour == pytest.approx(200.0 + 2 * math.hypot(100, 150))
    assert detour_climb == pytest.approx(50.0, abs=0.5)   # down into the valley and up


def test_tunnels_and_ferries_are_not_walked():
    lines = [line("road", [(0, 0), (50, 20), (100, 0)]),
             line("road", [(100, 0), (400, 0)]),
             line("road", [(0, 0), (400, 0)], medium="U")]
    length, _, _ = shortest(lines, (0.0, 0.0), (400.0, 0.0), elevation=lambda e, n: (
        np.zeros(np.shape(e)), np.ones(np.shape(e), dtype=np.int16)))
    assert length == pytest.approx(2 * math.hypot(50, 20) + 300.0)
    cleaned, dropped = access.clean_lines(lines)
    assert len(cleaned) == 2 and dropped == {"underground or in a building": 1}
    data = nvdb.parse(io.BytesIO(fx.nvdb_gml([
        fx.nvdb_link("bilferje", [(0, 0), (500, 0)], category="F", ident="1")])))
    assert data.lines == []


def test_a_path_ending_beside_a_road_is_joined_to_it():
    flat = lambda e, n: (np.zeros(np.shape(e)), np.ones(np.shape(e), dtype=np.int16))  # noqa
    road = line("road", [(0, 0), (200, 0)])
    near = line("path", [(100, 1.5), (100, 300)])
    length, _, coords = shortest([road, near], (0.0, 0.0), (100.0, 300.0), elevation=flat)
    assert length == pytest.approx(100.0 + 1.5 + 298.5)   # the 1.5 m step is walked too
    assert [100.0, 1.5] in coords.tolist()
    far = line("path", [(100, 2.5), (100, 300)])
    net = access.build_network([road, far], flat)
    assert nx.number_connected_components(net.graph) == 2


def test_vertices_within_2_m_merge_but_not_inside_a_bridge():
    flat = lambda e, n: (np.zeros(np.shape(e)), np.ones(np.shape(e), dtype=np.int16))  # noqa
    net = access.build_network([line("road", [(0, 0), (100, 0)]),
                                line("path", [(101.5, 0.5), (200, 0)])], flat)
    assert nx.is_connected(net.graph)
    bridge = line("road", [(0, 50), (100, 50), (200, 50)], medium="L")
    under = line("road", [(100, 0), (100, 50), (100, 100)])
    net = access.build_network([bridge, under], flat)
    assert nx.number_connected_components(net.graph) == 2


def test_trailheads_need_a_road_side_a_trail_side_and_500_m_of_trail():
    flat = lambda e, n: (np.zeros(np.shape(e)), np.ones(np.shape(e), dtype=np.int16))  # noqa
    lines = [line("road", [(0, 0), (1000, 0)]),
             line("path", [(200, 0), (200, 600)]),
             line("path", [(600, 0), (600, 300)])]
    net = access.build_network(lines, flat)
    start = access.choose_start(net, 0.0, 0.0)
    pred, dist = nx.dijkstra_predecessor_and_distance(net.graph, start["node"], weight="length")
    found = access.trailhead_candidates(net, dist)
    assert len(found) == 1
    node, trail = found[0]
    assert net.nodes[node] == pytest.approx((200.0, 0.0)) and trail == pytest.approx(600.0)
    assert dist[node] == pytest.approx(200.0)


def test_polylines_are_local_simplified_and_rounded():
    coords = np.column_stack([1000.0 + np.arange(0, 101, 1.0), 2000.0 + np.zeros(101)])
    coords[50, 1] += 1.0                                   # a 1 m wiggle: simplified away
    out = access.local_polyline(coords, (1000, 2050))
    assert out == [[0.0, 50.0], [100.0, 50.0]]             # z is south of the origin


class ConeProvider:
    """1 m terrain of two made-up cones: a small top at (0, 0) and a big one to the east."""

    def dtm(self, bounds, cell):
        west, south, east, north = bounds
        e = west + (np.arange(int(east - west)) + 0.5)
        n = north - (np.arange(int(north - south)) + 0.5)
        ee, nn = np.meshgrid(e, n)
        small = 100.0 - 0.3 * np.hypot(ee, nn)
        big = 400.0 - 0.3 * np.hypot(ee - 2000.0, nn)
        return np.maximum(small, big).astype(np.float32)


def test_summits_are_re_measured_on_1_m_terrain():
    provider = ConeProvider()
    h, e, n, basis = access.remeasure(provider, 40.0, -30.0)
    assert h == pytest.approx(100.0 - 0.3 * math.hypot(0.5, 0.5), abs=0.01)
    assert (abs(e), abs(n)) == (0.5, 0.5)                   # one of the four top cells
    assert basis.startswith("highest in the 200 m square")


def test_a_place_on_a_slope_with_no_top_near_it_keeps_its_own_point():
    # A name point on the big cone's flank: the ground rises on past the square, and past
    # the 30 m disk too, so the highest sample of either is a point on the slope, not a
    # summit. The place's own point and its 1 m height are kept, and h_basis says why.
    h, e, n, basis = access.remeasure(ConeProvider(), 1500.0, 0.0)
    assert basis.startswith("no distinct top within 30 m of the place's point")
    assert (e, n) == (1500.5, -0.5)
    assert h == pytest.approx(400.0 - 0.3 * math.hypot(499.5, 0.5), abs=0.01)


class Terrain:
    """1 m terrain from a function of (e, n), counting the requests."""

    def __init__(self, f):
        self.f = f
        self.calls = []

    def dtm(self, bounds, cell):
        self.calls.append(tuple(bounds))
        west, south, east, north = bounds
        e = west + (np.arange(int(east - west)) + 0.5)
        n = north - (np.arange(int(north - south)) + 0.5)
        ee, nn = np.meshgrid(e, n)
        return self.f(ee, nn).astype(np.float32)


def bump(ee, nn, e0, n0, height, sigma):
    return height * np.exp(-((ee - e0) ** 2 + (nn - n0) ** 2) / (2.0 * sigma * sigma))


def test_a_higher_hill_across_a_valley_is_not_taken_for_the_named_knoll():
    # The knoll the name is on tops out at 58 m; a 70 m hill 70 m away, well inside the
    # 200 m square, is the square's highest ground, but the way to it drops into a
    # valley at about 51 m.
    terrain = Terrain(lambda ee, nn: 50.0 + bump(ee, nn, 0.0, 0.0, 8.0, 12.0)
                      + bump(ee, nn, 70.0, 0.0, 20.0, 12.0))
    h, e, n, basis = access.remeasure(terrain, 4.0, 3.0)
    assert (e, n) == (0.5, 0.5) or (abs(e), abs(n)) == (0.5, 0.5)
    assert h == pytest.approx(58.0, abs=0.05)
    assert basis == "highest in the 200 m square"


def test_a_bump_on_a_higher_top_s_flank_counts_as_that_top_and_is_flagged():
    # A 2 m bump on ground rising to a top 70 m away: the dip between them is under the
    # 2 m allowed, so they are one hill and its top is the summit. It is more than 50 m
    # from the place's point, so h_basis says it may be a neighbouring top.
    terrain = Terrain(lambda ee, nn: 80.0 - 0.25 * np.hypot(ee - 70.0, nn)
                      + bump(ee, nn, 0.0, 0.0, 2.0, 3.0))
    h, e, n, basis = access.remeasure(terrain, 0.0, 0.0)
    assert (e, abs(n)) == (69.5, 0.5) or (e, abs(n)) == (70.5, 0.5)
    assert basis.startswith("highest in the 200 m square; 70 m from the place's point")
    assert "possibly a neighbouring top" in basis


def test_a_top_at_or_near_the_square_s_edge_is_checked_beyond_it():
    # A cone whose top sits on the square's last column: the square alone cannot tell a
    # top from a slope running on, so the ground beyond is read, and the top is kept.
    for top_e in (99.5, 94.5):
        terrain = Terrain(lambda ee, nn: 300.0 - 0.3 * np.hypot(ee - top_e, nn - 0.5))
        h, e, n, basis = access.remeasure(terrain, 0.0, 0.0)
        assert (e, n) == (top_e, 0.5), top_e
        assert h == pytest.approx(300.0, abs=0.01)
        assert basis.startswith("highest in the 200 m square")
        assert len(terrain.calls) == 2, "one extra read, around the top"
        west, south, east, north = terrain.calls[1]
        assert east - west == 41 and north - south == 41
        assert (west + east) / 2.0 == top_e and (south + north) / 2.0 == 0.5


def test_nearest_and_highest_peaks_share_one_list_without_doubles():
    cands = [access.PeakCandidate("Small", "Haug", 20.0, 10.0, 95.0, "test"),
             access.PeakCandidate("Small again", "Topp", 10.0, -15.0, 96.0, "test"),
             access.PeakCandidate("Big", "Fjell", 2000.0, 0.0, 390.0, "test")]
    chosen = access.select_peaks(cands, ConeProvider(), (500.0, 0.0))
    names = [m["cand"].name for m in chosen]
    assert len(names) == 2 and "Big" in names             # one name per summit
    big = next(m for m in chosen if m["cand"].name == "Big")
    assert big["lists"] == ["nearest", "highest"] and big["rank_highest"] == 1
    assert big["h"] == pytest.approx(400.0 - 0.3 * math.hypot(0.5, 0.5), abs=0.01)


def test_nvdb_connection_links_are_kept_only_for_walking():
    e0, n0 = synthetic.origin()
    links = [fx.nvdb_link("bilveg", [(e0, n0), (e0 + 100, n0)], category="K", ident="1"),
             fx.nvdb_link("gsv", [(e0, n0 + 2), (e0 + 1, n0 + 5)], connection="true",
                          ident="2")]
    default = nvdb.parse(io.BytesIO(fx.nvdb_gml(links)))
    assert [l.source_type for l in default.lines] == ["bilveg"]
    walking = nvdb.parse(io.BytesIO(fx.nvdb_gml(links)), keep_connections=True)
    assert sorted(l.source_type for l in walking.lines) == ["bilveg", "gsv connection"]
