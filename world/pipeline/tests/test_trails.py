"""Turrutebasen over its WFS: request shape, paging and parsing, against a fake service."""

import pytest

from commons_world import synthetic, trails

from conftest import FakeTransport
import gml_fixtures as fx

E0, N0 = synthetic.origin()
PATH = "/skwms1/wfs.turogfriluftsruter"
BOUNDS = (E0 - 1000, N0 - 1000, E0 + 1000, N0 + 1000)


def fake_service(routes, points, log):
    def handler(method, url, query, headers, body):
        log.append(query)
        members = routes if query["typeNames"] == "app:Fotrute" else points
        start, count = int(query["startIndex"]), int(query["count"])
        return 200, {"Content-Type": "text/xml"}, fx.trails_page(members[start:start + count])
    transport = FakeTransport()
    transport.add("wfs.geonorge.no", PATH, handler)
    return transport


def test_routes_and_points_are_paged_and_parsed(make_client, monkeypatch):
    monkeypatch.setattr(trails, "PAGE_SIZE", 2)
    routes = [fx.fotrute(i, [(E0 + i, N0), (E0 + i, N0 + 100)]) for i in range(3)]
    points = [fx.ruteinfopunkt(1, E0 + 5, N0 + 5, 22), fx.ruteinfopunkt(2, E0 + 6, N0 + 6, 13)]
    log = []
    data = trails.fetch(make_client(fake_service(routes, points, log)), BOUNDS)
    assert len(data.routes) == 3 and len(data.points) == 2
    # Routes: a full page of 2, then a short page of 1. Points: a full page, then an empty one.
    assert data.requests == 4
    first = log[0]
    assert first["service"] == "WFS" and first["version"] == "2.0.0"
    assert first["request"] == "GetFeature" and first["typeNames"] == "app:Fotrute"
    assert first["srsName"] == "urn:ogc:def:crs:EPSG::25832"
    assert first["bbox"] == "{},{},{},{},urn:ogc:def:crs:EPSG::25832".format(*BOUNDS)
    assert trails.NAMESPACE in first["namespaces"]
    assert [q["startIndex"] for q in log if q["typeNames"] == "app:Fotrute"] == ["0", "2"]
    route = data.routes[0]
    assert route.kind == "path" and route.source == "turrutebasen"
    assert route.coords[1] == pytest.approx([E0, N0 + 100])
    assert "follows=ST" in route.source_type and "marked=JA" in route.source_type
    assert sorted(p.code for p in data.points) == [13, 22]
    stats = data.stats()
    assert stats["routes"] == 3 and stats["route_length_m"] == pytest.approx(300.0)
    assert stats["info_point_codes"] == {"13": 1, "22": 1}


def test_names_and_maintainers_are_not_kept(make_client):
    routes = [fx.fotrute(1, [(E0, N0), (E0, N0 + 10)])]
    data = trails.fetch(make_client(fake_service(routes, [], [])), BOUNDS)
    assert "Invented" not in repr(data.routes[0])


def test_an_exception_report_stops_the_build(make_client):
    transport = FakeTransport()
    transport.add("wfs.geonorge.no", PATH, (200, {}, fx.exception_report()))
    with pytest.raises(trails.TrailsError):
        trails.fetch(make_client(transport), BOUNDS)
