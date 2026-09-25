"""The NVDB Vegnett Pluss reader: EPSG:5973 in, the world's grid out."""

import io

import numpy as np
import pytest

from commons_world import nvdb, synthetic

import gml_fixtures as fx

E0, N0 = synthetic.origin()


def links():
    return [
        fx.nvdb_link("bilveg", [(E0, N0), (E0 + 100, N0 + 20)], category="K", ident="1"),
        fx.nvdb_link("gsv", [(E0, N0 + 10), (E0 + 100, N0 + 30)], ident="2"),
        fx.nvdb_link("kanalveg", [(E0, N0 + 50), (E0 + 100, N0 + 50)], category="E", detail="KB",
                     ident="3"),
        fx.nvdb_link("bilveg", [(E0, N0 + 55), (E0 + 100, N0 + 55)], category="E", detail="VT",
                     ident="4"),
        fx.nvdb_link("bilveg", [(E0, N0), (E0 + 2, N0)], category="K", connection="true",
                     ident="5"),
        fx.nvdb_link("bilferje", [(E0 - 500, N0), (E0 - 900, N0)], category="F", ident="6"),
        fx.nvdb_link("bilveg", [(E0, N0 + 200), (E0 + 300, N0 + 200)], category="R", medium="U",
                     ident="7"),
        fx.nvdb_link("svevebane", [(E0, N0 + 400), (E0 + 1, N0 + 400)], ident="8"),
        fx.nvdb_link("bilveg", [(E0 + 90000, N0), (E0 + 90100, N0)], category="P", ident="9"),
    ]


def test_links_are_reprojected_into_the_world_grid():
    data = nvdb.parse(io.BytesIO(fx.nvdb_gml(links())))
    road = next(line for line in data.lines if line.category == "K")
    assert road.coords.shape == (2, 2)          # heights dropped
    assert road.coords[0] == pytest.approx([E0, N0], abs=0.001)
    assert road.coords[1] == pytest.approx([E0 + 100, N0 + 20], abs=0.001)


def test_kinds_categories_and_what_is_skipped():
    data = nvdb.parse(io.BytesIO(fx.nvdb_gml(links())))
    got = sorted((line.source_type, line.kind, line.category, line.medium) for line in data.lines)
    assert got == sorted([
        ("bilveg", "road", "K", None),
        ("gsv", "footway", None, None),
        ("kanalveg", "road", "E", None),
        ("bilveg", "road", "R", "U"),
        ("bilveg", "road", "P", None),
    ])
    assert data.skipped == {"ferry": 1, "connection link": 1, "VT centre of a divided road": 1}
    assert data.unknown_types == {"svevebane": 1}
    assert all(line.source == "nvdb" for line in data.lines)
    stats = data.stats()
    assert stats["lines"] == 5 and stats["by_type"]["bilveg"] == 5


def test_clip_and_zip():
    clip = (E0 - 1000, N0 - 1000, E0 + 1000, N0 + 1000)
    data = nvdb.parse_zip(fx.nvdb_zip(links()), clip=clip)
    assert len(data.lines) == 4
    assert all(np.all(line.coords[:, 0] < E0 + 1000) for line in data.lines)


def test_every_mapped_type_has_a_known_kind():
    assert set(nvdb.ROAD_KINDS.values()) <= {"road", "footway", "path"}
    for seen in ("bilveg", "gsv", "gangveg", "kanalveg", "gangfelt", "fortau", "rkj", "trapp",
                 "rampe", "gatetun", "gagate", "sti", "sv", "tv"):
        assert seen in nvdb.ROAD_KINDS, seen


def test_cycleway_and_tractor_road_codes_are_drawn():
    # The first real build dropped these as unknown types; they are the product's
    # sykkelveg and traktorveg.
    lines = [fx.nvdb_link("sv", [(E0, N0), (E0 + 50, N0)], category="F", ident="1"),
             fx.nvdb_link("tv", [(E0, N0 + 20), (E0 + 50, N0 + 20)], category="S", ident="2")]
    data = nvdb.parse(io.BytesIO(fx.nvdb_gml(lines)))
    assert sorted((l.source_type, l.kind, l.category) for l in data.lines) == [
        ("sv", "footway", "F"), ("tv", "path", "S")]
    assert data.unknown_types == {}


def test_road_kinds_has_no_duplicate_keys():
    """A dict literal silently keeps the last of two equal keys; the source must not have any."""
    import ast
    import inspect

    from commons_world import nvdb as nvdb_module

    tree = ast.parse(inspect.getsource(nvdb_module))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "ROAD_KINDS" for t in node.targets):
            keys = [k.value for k in node.value.keys]
            assert len(keys) == len(set(keys))
            break
    else:
        raise AssertionError("ROAD_KINDS not found")
