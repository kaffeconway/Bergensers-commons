"""The class band: FORMAT.md section 3's precedence, widths and per-level rules.

Each test rasterises one synthetic chunk. The chunk's square is invented
(E 216000-216240, N 6648000-6648240 at 1 m, near the synthetic origin in the
open sea) and the shapes are drawn relative to its north-west corner.
"""

import numpy as np
import pytest
from shapely.geometry import box

from commons_world import classes, grid
from commons_world.grid import Level
from commons_world.n50 import Area, Line
from commons_world.raster import LevelGrid
from commons_world.terrain import ChunkSet

I, J = 900, 27700
H1 = Level("h1", 1, 100, 240, 1, grid.NEAREST)
H5 = Level("h5", 5, 500, 240, 1, grid.BILINEAR)
H20 = Level("h20", 20, 2000, 240, 1, grid.BILINEAR)


def setup(level, sea_columns=0):
    g = LevelGrid(level, [(I, J)])
    heights = np.full(g.shape, 10.0)
    heights[:, :sea_columns] = 0.0
    return g, heights


def xy(g, dx, dy):
    """Grid point dx metres east and dy metres south of the grid's north-west corner."""
    return g.west + dx, g.north - dy


def at(result, dx, dy):
    g = result.grid
    r, q = g.rowcol(*xy(g, dx, dy))
    return int(result.classes[r, q])


def line(g, kind, points, category=None, medium=None, source="nvdb"):
    return Line(kind=kind, coords=np.array([xy(g, *p) for p in points]), category=category,
                medium=medium, source=source)


def area(g, code, tier, x0, y0, x1, y1):
    (w, n), (e, s) = xy(g, x0, y0), xy(g, x1, y1)
    return Area(code=code, tier=tier, polygon=box(w, s, e, n), source_type="test")


def test_precedence_sea_landcover_water_roads_buildings():
    g, heights = setup(H1, sea_columns=40)
    areas = [area(g, classes.FOREST, "landcover", 20, 20, 200, 200),
             area(g, classes.LAKE, "water", 60, 60, 120, 120)]
    lines = [line(g, "road", [(10, 90), (230, 90)], category="K")]
    (w, n), (e, s) = xy(g, 150, 80), xy(g, 170, 100)
    footprint = box(w, s, e, n)
    result = classes.rasterise_level(H1, g, heights, areas, lines, buildings=[footprint])
    assert at(result, 5, 5) == classes.SEA            # sea: nothing else there
    assert at(result, 30, 30) == classes.SEA          # land cover never overwrites sea (FORMAT.md)
    assert at(result, 35, 90) == classes.SEA          # nor does a road running out over it
    assert at(result, 100, 30) == classes.FOREST
    assert at(result, 80, 70) == classes.LAKE         # water wins over land cover
    assert at(result, 80, 90) == classes.ROAD         # roads win over water
    assert at(result, 160, 97) == classes.BUILDING    # buildings win over everything
    assert at(result, 210, 210) == classes.OPEN
    assert result.stats["land_classes_reset_to_sea"] > 0


def test_n50_sea_never_paints_dry_land():
    g, heights = setup(H1, sea_columns=40)
    sea = area(g, classes.SEA, "sea", 0, 0, 80, 242)       # overlaps 40 m of land
    result = classes.rasterise_level(H1, g, heights, [sea], [])
    assert at(result, 20, 100) == classes.SEA
    assert at(result, 60, 100) == classes.OPEN


def column_run(result, dx, code):
    g = result.grid
    _, q = g.rowcol(*xy(g, dx, 0))
    return int((result.classes[:, q] == code).sum())


@pytest.mark.parametrize("kind,code,width", [("road", 7, 6), ("footway", 8, 3), ("path", 9, 2),
                                             ("stream", 4, 2)])
def test_h1_widths(kind, code, width):
    g, heights = setup(H1)
    # A straight east-west line, on a cell edge for an even width and through cell centres
    # for an odd one, so no centre sits exactly on the buffer's edge: the buffer then covers
    # exactly `width` cell centres across.
    y = 100.0 if width % 2 == 0 else 100.5
    lines = [line(g, kind, [(0, y), (242, y)], category="K")]
    result = classes.rasterise_level(H1, g, heights, [], lines)
    assert column_run(result, 120, code) == width


def test_road_wins_over_footway_and_path_where_they_cross():
    g, heights = setup(H1)
    lines = [line(g, "road", [(0, 100), (242, 100)], category="K"),
             line(g, "footway", [(100, 0), (100, 242)]),
             line(g, "path", [(150, 0), (150, 242)])]
    result = classes.rasterise_level(H1, g, heights, [], lines)
    assert at(result, 100.5, 100.5) == classes.ROAD
    assert at(result, 150.5, 100.5) == classes.ROAD
    assert at(result, 100.5, 50.5) == classes.FOOTWAY
    assert at(result, 150.5, 50.5) == classes.PATH


def test_h5_draws_driveable_roads_only_as_thin_lines():
    g, heights = setup(H5)
    lines = [line(g, "road", [(0, 500.5), (1210, 500.5)], category="P"),
             line(g, "footway", [(0, 700.5), (1210, 700.5)]),
             line(g, "path", [(0, 900.5), (1210, 900.5)]),
             line(g, "stream", [(0, 300.5), (1210, 300.5)])]
    result = classes.rasterise_level(H5, g, heights, [], lines)
    assert set(np.unique(result.classes)) == {classes.OPEN, classes.ROAD}
    assert column_run(result, 600, classes.ROAD) == 1


def test_h20_draws_national_and_county_roads_only():
    g, heights = setup(H20)
    lines = [line(g, "road", [(0, y), (4840, y)], category=cat)
             for y, cat in ((500.5, "E"), (1500.5, "R"), (2500.5, "F"), (3500.5, "K"),
                            (4500.5, "P"))]
    result = classes.rasterise_level(H20, g, heights, [], lines)
    assert at(result, 2000, 500.5) == classes.ROAD
    assert at(result, 2000, 1500.5) == classes.ROAD
    assert at(result, 2000, 2500.5) == classes.ROAD
    assert at(result, 2000, 3500.5) == classes.OPEN
    assert at(result, 2000, 4500.5) == classes.OPEN


def test_tunnels_are_not_drawn_and_bridges_do_not_cross_water():
    g, heights = setup(H1)
    lake = area(g, classes.LAKE, "water", 80, 0, 160, 242)
    lines = [line(g, "road", [(0, 50), (242, 50)], category="R", medium="U"),
             line(g, "road", [(0, 150), (242, 150)], category="K", medium="L")]
    result = classes.rasterise_level(H1, g, heights, [lake], lines)
    assert column_run(result, 40, classes.ROAD) == 6            # the bridge on land
    assert at(result, 40, 50) == classes.OPEN                   # the tunnel is not drawn
    assert at(result, 120, 150) == classes.LAKE                 # the bridge over the lake
    for level in (H1, H5, H20):
        assert classes.lines_for_level(lines[:1], classes.level_rule(level))["road"] == []


def test_class_band_cuts_chunks_and_counts():
    chunks = ChunkSet()
    g = LevelGrid(H1, [(I, J), (I + 1, J)])
    heights = np.full(g.shape, 10.0)
    for key in ((I, J), (I + 1, J)):
        chunks[key] = g.cut(heights, *key).astype(np.float32)
    lines = [line(g, "road", [(0, 100), (482, 100)], category="K")]
    band = classes.build_class_band([H1, H5], {"h1": chunks}, [], lines)
    assert band.get("h5") is None and band.source(H5, I, J, None) is None
    left = band.source(H1, I, J, chunks[(I, J)])
    right = band.source(H1, I + 1, J, chunks[(I + 1, J)])
    assert left.shape == right.shape == (242, 242) and left.dtype == np.uint8
    assert np.array_equal(left[:, -2:], right[:, :2])      # aprons agree across the seam
    assert (left == classes.ROAD).sum() == 6 * 242
    footprint = box(g.west + 10, g.north - 40, g.west + 30, g.north - 20)
    assert band.add_buildings("h1", [footprint]) == 400
    stats = band.stats()["h1"]
    assert stats["class_cells"][str(classes.BUILDING)] == 400
    assert stats["rule"] == "h1"
