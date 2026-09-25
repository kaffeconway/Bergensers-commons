"""The N50 Kartdata reader, on small hand-written GML (tests/gml_fixtures.py)."""

import io

import numpy as np
import pytest
from pyproj import Transformer

from commons_world import classes, n50, synthetic

import gml_fixtures as fx

E0, N0 = synthetic.origin()


def parse(content, **kwargs):
    return n50.parse(io.BytesIO(content), **kwargs)


def test_class_table_uses_only_format_codes_and_known_tiers():
    for name, (code, tier) in n50.AREA_CLASSES.items():
        assert code in classes.CODES, name
        assert tier in (n50.TIER_LANDCOVER, n50.TIER_WATER, n50.TIER_SEA), name
        name.encode("utf-8")
    assert n50.AREA_CLASSES["Skog"] == (1, "landcover")
    assert n50.AREA_CLASSES["Myr"] == (2, "landcover")
    assert n50.AREA_CLASSES["DyrketMark"] == (3, "landcover")
    assert n50.AREA_CLASSES["Innsj\u00f8"] == (4, "water")
    assert n50.AREA_CLASSES["Havflate"] == (5, "sea")
    assert n50.AREA_CLASSES["Tettbebyggelse"] == (6, "landcover")
    assert n50.AREA_CLASSES["\u00c5pentOmr\u00e5de"] == (0, "landcover")
    assert n50.AREA_CLASSES["Sn\u00f8Isbre"] == (11, "landcover")
    assert n50.AREA_CLASSES["Steinbrudd"] == (13, "landcover")


def test_arealdekke_polygons_holes_and_unknown_types():
    data = parse(fx.n50_arealdekke(E0, N0))
    by_type = {}
    for area in data.areas:
        by_type.setdefault(area.source_type, []).append(area)
    assert sorted(by_type) == sorted(["Skog", "Myr", "Innsj\u00f8", "Havflate",
                                      "\u00c5pentOmr\u00e5de"])
    forest = [a for a in by_type["Skog"] if abs(a.polygon.centroid.x - (E0 + 100)) < 1]
    assert len(forest) == 1
    assert len(forest[0].polygon.interiors) == 1
    assert forest[0].polygon.area == pytest.approx(100 * 100 - 20 * 20)
    assert by_type["Havflate"][0].tier == "sea" and by_type["Havflate"][0].code == 5
    assert by_type["Innsj\u00f8"][0].tier == "water"
    assert data.unknown_area_types == {"Fantasiflate": 1}
    streams = [line for line in data.lines if line.kind == "stream"]
    assert len(streams) == 1 and streams[0].coords.shape == (2, 2)
    assert data.counts["Kystkontur"] == 1 and data.counts["Skj\u00e6r"] == 1
    assert all(line.kind == "stream" for line in data.lines)   # coast lines are not kept


def test_clip_drops_features_outside():
    clip = (E0 - 1000, N0 - 1000, E0 + 1000, N0 + 1000)
    data = parse(fx.n50_arealdekke(E0, N0), clip=clip)
    assert all(a.polygon.bounds[0] < E0 + 1000 for a in data.areas)
    assert len([a for a in data.areas if a.source_type == "Skog"]) == 1
    everything = parse(fx.n50_arealdekke(E0, N0))
    assert len([a for a in everything.areas if a.source_type == "Skog"]) == 2


def test_samferdsel_kinds_categories_and_media():
    data = parse(fx.n50_samferdsel(E0, N0))
    got = sorted((line.source_type, line.kind, line.category, line.medium) for line in data.lines)
    assert got == sorted([
        ("enkelBilveg", "road", "F", "T"),
        ("enkelBilveg", "road", "K", "U"),
        ("gangOgSykkelveg", "footway", None, "T"),
        ("sti", "path", None, "T"),
        ("traktorveg", "path", None, "T"),
    ])
    assert data.unknown_road_types == {"hesteveg": 1}   # ferries are skipped, not unknown
    assert [line.kind for line in n50.paths(data)] == ["path", "path"]
    assert sorted(line.kind for line in n50.roads(data)) == ["footway", "road", "road"]


def test_spot_heights_and_building_points():
    heights = parse(fx.n50_hoyde(E0, N0))
    got = sorted((s.kind, s.e - E0, s.n - N0, s.h) for s in heights.spot_heights)
    assert got == [("Terrengpunkt", 10.0, 20.0, 58.0), ("TrigonometriskPunkt", 30.0, 40.0, 84.0)]
    buildings = parse(fx.n50_bygninger(E0, N0))
    types = sorted(b.type for b in buildings.buildings)
    assert types == [111, 219]
    polygon_point = next(b for b in buildings.buildings if b.type == 219)
    assert abs(polygon_point.e - (E0 + 50)) <= 10 and abs(polygon_point.n - (N0 + 50)) <= 10


def test_zip_reads_only_the_themes_it_uses():
    data = n50.parse_zip(fx.n50_zip(E0, N0))
    assert "Kommune" not in data.counts            # administrative areas are skipped
    assert data.unknown_area_types == {"Fantasiflate": 1}
    assert len(data.spot_heights) == 2 and len(data.buildings) == 2
    assert {line.kind for line in data.lines} == {"road", "footway", "path", "stream"}
    assert n50.theme_of("Basisdata_9999_X_25832_N50Arealdekke_GML.gml") == "Arealdekke"
    assert n50.theme_of("Basisdata_9999_X_25832_N50Stedsnavn_GML.gml") is None


def test_a_file_in_another_grid_is_reprojected():
    to33 = Transformer.from_crs(25832, 25833, always_xy=True)
    e33, n33 = to33.transform(E0, N0)
    data = parse(fx.n50_arealdekke(e33, n33, srs=25833), epsg=25832)
    lake = next(a for a in data.areas if a.source_type == "Innsj\u00f8")
    back = Transformer.from_crs(25833, 25832, always_xy=True)
    ex, ey = back.transform(e33 + 100, n33 - 100)
    assert lake.polygon.centroid.x == pytest.approx(ex, abs=0.05)
    assert lake.polygon.centroid.y == pytest.approx(ey, abs=0.05)
    assert np.isfinite(lake.polygon.area)


def test_entities_are_not_resolved():
    doc = (b'<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>\n'
           b'<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" '
           b'xmlns:app="urn:x"><gml:featureMember><app:Terrengpunkt><app:posisjon><gml:Point '
           b'srsName="urn:ogc:def:crs:EPSG::25832"><gml:pos>1 2</gml:pos></gml:Point>'
           b'</app:posisjon><app:h\xc3\xb8yde>&e;</app:h\xc3\xb8yde></app:Terrengpunkt>'
           b'</gml:featureMember></gml:FeatureCollection>')
    data = parse(doc)
    assert data.spot_heights == []
