"""Live checks of the map-feature sources. Deselected by default; run with -m network.

They use only allowlisted hosts through commons_world.http.Client, cache into a
temporary folder, and touch neutral public places: Galdhoepiggen (Norway's
highest summit), the island municipality of Utsira (whole-municipality
downloads, the smallest there are), and the town centre around Kartverket's
own office in Hoenefoss. No listing is involved.
"""

import numpy as np
import pytest

from commons_world import buildings, download, features, geo, grid, n50, nvdb, places, terrain
from commons_world import trails, trees
from commons_world.grid import Level
from commons_world.http import Client
from commons_world.raster import LevelGrid
from commons_world.sources import DATASETS

pytestmark = pytest.mark.network

GALDHOPIGGEN = (61.6364, 8.3125)
HONEFOSS = (60.1667, 10.2556)      # the town centre by Kartverket's office
UTSIRA = "1151"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    return Client(tmp_path_factory.mktemp("network-cache"))


def grid_point(latlon):
    e, n = geo.to_grid(*latlon, 25832)
    return int(round(e)), int(round(n))


def test_municipalities_around_a_summit(client):
    e, n = grid_point(GALDHOPIGGEN)
    lookup = download.kommuner_for_disk(client, e, n, 3000)
    assert "3434" in lookup.kommuner          # Lom
    assert lookup.requests <= 40, lookup.stats()


def test_nvdb_for_a_small_municipality(client):
    projection, files = features.fetch_preferred(client, DATASETS["nvdb"]["uuid"], UTSIRA,
                                                 features.NVDB_PROJECTIONS)
    assert projection == "5973" and len(files) == 1
    data = nvdb.parse_zip(files[0].content)
    assert len(data.lines) >= 50 and data.unknown_types == {}
    allc = np.vstack([line.coords for line in data.lines])
    centre = np.array(geo.to_grid(59.305, 4.885, 25832))
    assert np.max(np.hypot(*(allc - centre).T)) < 15000    # all on and around the island


def test_n50_for_a_small_municipality_maps_every_area_type(client):
    projection, files = features.fetch_preferred(client, DATASETS["n50"]["uuid"], UTSIRA,
                                                 features.N50_PROJECTIONS)
    assert projection == "25832"
    data = n50.parse_zip(files[0].content)
    assert len(data.areas) > 50
    assert data.unknown_area_types == {} and data.unknown_road_types == {}


def test_trails_near_a_summit(client):
    e, n = grid_point(GALDHOPIGGEN)
    data = trails.fetch(client, (e - 2000, n - 2000, e + 2000, n + 2000))
    assert data.routes and all(r.coords.shape[1] == 2 for r in data.routes)


def test_place_names_near_a_summit(client):
    e, n = grid_point(GALDHOPIGGEN)
    search = places.fetch_names(client, e, n, 3000)
    assert any(c.type == "Fjell" for c in search.candidates)
    assert search.requests <= 4


def test_roofs_and_trees_on_real_data(client):
    e, n = grid_point(HONEFOSS)
    level = Level("h1", 1, 200, 240, 1, grid.NEAREST)
    dtm_chunks = terrain.level_chunks(client, level, e, n)
    dom_chunks = terrain.level_chunks(client, level, e, n, service=terrain.DOM_SERVICE)
    lgrid = LevelGrid(level, list(dtm_chunks))
    dtm, dom = lgrid.assemble(dtm_chunks), lgrid.assemble(dom_chunks)
    points, _ = buildings.fetch_points(client, lgrid.bounds)
    assert len(points) > 50
    found, stats, labels = buildings.segment(dom, dtm, lgrid, points, return_labels=True)
    # Most register points in a town centre should find a roof (81% on 25 Sept 2026).
    assert stats["register_points_matched"] >= 0.6 * stats["register_points"], stats
    for b in found:
        assert b.polygon.is_valid and b.roof > b.ground
    found_trees, tree_stats = trees.find_trees(dom - dtm, dtm, lgrid, exclude=labels > 0)
    assert len(found_trees) > 0, tree_stats
