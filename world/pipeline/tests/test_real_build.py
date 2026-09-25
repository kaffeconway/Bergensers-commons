"""The real build path, end to end, against fake Kartverket services.

Geocoding, parcels, the register area and the terrain all come from fake
responses built from the synthetic place (origin in the open North Sea,
kommune 9999, which does not exist). Nothing here touches the network.
"""

import json

import numpy as np
import pytest

from commons_world import build, codec, geo, grid, manifest, synthetic
from commons_world.grid import Level
from commons_world.listing import LeakError
from commons_world.parcel import GeocodeError
from commons_world.sources import CREDIT_KARTVERKET

from conftest import FakeTransport, export_image_handler
from test_parcel import (address_hit, address_response, eiendom_response, teig_feature,
                         wfs_response)

ORIGIN = synthetic.origin()
LEVELS = (Level("h1", 1, 300, 240, 1, grid.NEAREST),
          Level("h5", 5, 1500, 240, 1, grid.BILINEAR),
          Level("h20", 20, 5000, 240, 1, grid.BILINEAR))
EXPORT = "/arcgis/rest/services/NHM_DTM_25832/ImageServer/exportImage"


def height(e, n):
    return synthetic.height_grid(e, n, ORIGIN)


def fake_kartverket(terrain_log=None, hits=None):
    polygon = synthetic.parcel_polygon(ORIGIN)
    transport = FakeTransport()
    transport.add("api.kartverket.no", "/adresser/v1/sok",
                  address_response(*(hits or [address_hit(lat=60.0, lon=4.0)])))
    transport.add("api.kartverket.no", "/eiendom/v1/geokoding",
                  eiendom_response([teig_feature([[list(c) for c in polygon.exterior.coords]],
                                                 lokalid=101)]))
    transport.add("wfs.geonorge.no", "/skwms1/wfs.matrikkelen-eiendomskart-teig", wfs_response(
        [{"tid": 101, "kommune": "9999", "text": "1/2", "area": "{:.1f}".format(polygon.area)}]))
    transport.add("hoydedata.no", EXPORT, export_image_handler(height, log=terrain_log))
    return transport


@pytest.fixture
def listing_file(tmp_path):
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(synthetic.synthetic_listing()), encoding="utf-8")
    return path


def run(listing_path, out, cache, transport, **kwargs):
    return build.build(listing_path, out, cache_dir=cache, transport=transport, levels=LEVELS,
                       commit="test", generated_at="2026-01-01T00:00:00Z", min_interval=0.0,
                       pipeline=build.core_build_pipeline(), **kwargs)


def test_real_build_with_fake_services(tmp_path, listing_file):
    terrain_log = []
    transport = fake_kartverket(terrain_log)
    folder = run(listing_file, tmp_path / "world", tmp_path / "cache", transport)
    assert folder == tmp_path / "world"
    assert manifest.check_world(folder) == []
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    assert m["id"] == "no-9999-1-2"
    assert (m["crs"]["origin_e"], m["crs"]["origin_n"]) == ORIGIN
    assert m["crs"]["vertical"] == "NN2000"
    assert [(r["host"], r["status"], r["policy"], r["from_cache"]) for r in m["robots"]] == [
        ("api.kartverket.no", 404, "allow-all", False),
        ("hoydedata.no", 404, "allow-all", False),
        ("wfs.geonorge.no", 404, "allow-all", False)]
    assert m["credits"] == [CREDIT_KARTVERKET]
    assert len(m["sources"]) == 4
    assert all(len(s["retrieved"]) == 10 and s["licence"] == "CC BY 4.0" for s in m["sources"])
    assert any("not verified" in w for w in m["stats"]["warnings"])
    assert m["stats"]["http"]["from_cache"] == 0

    # Terrain was asked for in tiles no bigger than 3000 px, on the level grids.
    for query in terrain_log:
        width, height_px = (int(v) for v in query["size"].split(","))
        assert width <= 3000 and height_px <= 3000
    for record in m["levels"]:
        level = next(l for l in LEVELS if l.name == record["name"])
        assert record["source"] == "NHM_DTM_25832" and record["class_band"] is False
        assert record["nodata_fraction"] == 0.0
        keys = {grid.chunk_key(i, j) for i, j in grid.chunks_for_disk(level, *ORIGIN)}
        assert set(record["chunks"]) | set(record["sea"]) == keys
        for key, entry in record["chunks"].items():
            i, j = (int(v) for v in key.split("_"))
            chunk = codec.decode((folder / entry["file"]).read_bytes())
            east, north = grid.sample_centres(level, i, j)
            served = height(east[None, :], north[:, None]).astype(np.float32)
            expected = np.floor(served.astype(np.float64) * 10 + 0.5).astype(np.int64)
            assert np.array_equal(chunk["heights_dm"], expected)
            assert chunk["classes"] is None

    record = json.loads((folder / "listing.json").read_text(encoding="ascii"))
    assert record["id"] == "no-9999-1-2"
    g = record["geocode"]
    assert (g["property"], g["placement_verified"], g["epsg"]) == ("9999-1/2", False, 25832)
    e, n = geo.to_grid(60.0, 4.0, 25832)
    assert g["e"] == pytest.approx(e, abs=0.01) and g["n"] == pytest.approx(n, abs=0.01)
    plot = json.loads((folder / "plot.json").read_text(encoding="ascii"))
    assert plot["parcels"][0]["area_register_m2"] == pytest.approx(3600.0, abs=0.1)
    assert plot["parcels"][0]["accuracy_class"] == "Gult"
    notice = (folder / "NOTICE.txt").read_text(encoding="ascii")
    assert "(c) Kartverket" in notice and "Retrieved:" in notice


def test_offline_rebuild_from_the_cache_is_identical(tmp_path, listing_file):
    first = run(listing_file, tmp_path / "a", tmp_path / "cache", fake_kartverket())
    silent = FakeTransport()
    second = run(listing_file, tmp_path / "b", tmp_path / "cache", silent, offline=True)
    assert silent.calls == []
    for path in first.rglob("*"):
        if path.is_file() and path.name not in ("manifest.json",):
            assert (second / path.relative_to(first)).read_bytes() == path.read_bytes(), path
    m = json.loads((second / "manifest.json").read_text(encoding="ascii"))
    assert all(r["from_cache"] for r in m["robots"]) and len(m["robots"]) == 3
    assert m["stats"]["http"]["requests"] == 0


def test_offline_without_a_cache_fails_cleanly(tmp_path, listing_file):
    from commons_world.http import OfflineCacheMiss
    with pytest.raises(OfflineCacheMiss):
        run(listing_file, tmp_path / "w", tmp_path / "empty-cache", FakeTransport(), offline=True)
    assert not (tmp_path / "w").exists()
    assert not list(tmp_path.glob(".*partial*"))


def test_leaking_listing_stops_before_any_request(tmp_path):
    record = synthetic.synthetic_listing()
    record["approved_text"]["nickname"] = "from issue #3 by @someone"
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    transport = fake_kartverket()
    with pytest.raises(LeakError):
        run(path, tmp_path / "w", tmp_path / "cache", transport)
    assert transport.calls == []
    assert not (tmp_path / "w").exists()


def test_ambiguous_address_stops_the_build(tmp_path, listing_file):
    transport = fake_kartverket(hits=[address_hit(gnr=1, bnr=2), address_hit(gnr=3, bnr=4)])
    with pytest.raises(GeocodeError, match="matched 2"):
        run(listing_file, tmp_path / "w", tmp_path / "cache", transport)
    assert not (tmp_path / "w").exists()
    assert not any("exportImage" in u for u in transport.urls())


def test_non_norwegian_listing_is_refused(tmp_path):
    record = synthetic.synthetic_listing()
    record["country"] = "FR"
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    with pytest.raises(build.BuildError, match="Norwegian"):
        run(path, tmp_path / "w", tmp_path / "cache", FakeTransport())


# -- a height service whose 5 m output is displaced, as the real one's was -------

def displaced_5m_handler(log, shift_north=2.0):
    """exportImage that answers 5 m requests with cell means from 2 m further north.

    Every other cell size gets exact point samples. On 25 Sept 2026 the real
    service's 5 m output matched the 1 m data's cell means moved 2 m north.
    """
    from conftest import make_geotiff

    exact = export_image_handler(height)

    def handler(method, url, query, headers, body):
        west, south, east, north = (float(v) for v in query["bbox"].split(","))
        width, rows = (int(v) for v in query["size"].split(","))
        cell = (east - west) / width
        log.append(cell)
        if abs(cell - 5.0) > 1e-9:
            return exact(method, url, query, headers, body)
        e = west + (np.arange(width) + 0.5) * cell
        n = north - (np.arange(rows) + 0.5) * cell + shift_north
        offsets = np.arange(5) + 0.5 - 2.5
        values = height(e[None, :, None, None] + offsets[None, None, None, :],
                        n[:, None, None, None] + offsets[None, None, :, None]).mean(axis=(2, 3))
        return 200, {"Content-Type": "image/tiff"}, make_geotiff(values.astype(np.float32),
                                                                 west, north, cell)
    return handler


@pytest.mark.parametrize("fetch_cell", [None, 2.5])
def test_displaced_5m_output_is_caught_and_avoided(tmp_path, listing_file, fetch_cell):
    cells = []
    transport = fake_kartverket()
    transport.add("hoydedata.no", EXPORT, displaced_5m_handler(cells))
    levels = (Level("h1", 1, 300, 240, 1, grid.NEAREST),
              Level("h5", 5, 600, 240, 1, grid.BILINEAR, fetch_cell))
    folder = build.build(listing_file, tmp_path / "w", cache_dir=tmp_path / "cache",
                         transport=transport, levels=levels, commit="test",
                         generated_at="2026-01-01T00:00:00Z", min_interval=0.0,
                         pipeline=build.core_build_pipeline())
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    check = m["stats"]["registration"]["h5_vs_h1"]
    assert check["cells"] >= 200
    h5 = next(r for r in m["levels"] if r["name"] == "h5")
    if fetch_cell is None:
        # Asked for 5 m directly: the displacement is found and reported.
        assert check["best_shift_m"] == [0, 2] and check["shifted"] is True
        assert any(w.startswith("Level h5 matches the h1 heights better moved 0 m east and "
                                "2 m north") for w in m["stats"]["warnings"])
        assert "fetch_cell" not in h5
    else:
        # Asked for 2.5 m and averaged: no 5 m request is made, nothing is displaced.
        assert h5["fetch_cell"] == 2.5
        assert check["best_shift_m"] == [0, 0] and check["shifted"] is False
        assert not any(w.startswith("Level h5") for w in m["stats"]["warnings"])
        assert set(cells) == {1.0, 2.5}
