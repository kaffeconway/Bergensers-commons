"""Terrain fetching and cutting, against a fake exportImage serving synthetic GeoTIFFs."""

import math

import numpy as np
import pytest

from commons_world import codec, grid, terrain
from commons_world.grid import Level
from commons_world.terrain import TerrainError, fetch_raster, level_chunks

from conftest import FakeTransport, export_image_handler, make_geotiff

HOST = "hoydedata.no"
PATH = "/arcgis/rest/services/NHM_DTM_25832/ImageServer/exportImage"


def surface(e, n):
    """A synthetic height field with detail at every scale the tests use."""
    e = np.asarray(e, dtype=np.float64)
    n = np.asarray(n, dtype=np.float64)
    return 50.0 + 0.01 * (e - 1000.0) + 0.02 * (n - 2000.0) + 3.0 * np.sin(e / 7.0) * np.cos(n / 11.0)


def fake_server(log=None, **kwargs):
    transport = FakeTransport()
    transport.add(HOST, PATH, export_image_handler(surface, log=log, **kwargs))
    return transport


def centres(bounds, cell):
    west, south, east, north = bounds
    e = west + (np.arange(round((east - west) / cell)) + 0.5) * cell
    n = north - (np.arange(round((north - south) / cell)) + 0.5) * cell
    return e[None, :], n[:, None]


def test_single_tile(make_client):
    log = []
    client = make_client(fake_server(log))
    bounds = (1000, 2000, 1100, 2080)
    out = fetch_raster(client, "NHM_DTM_25832", bounds, 1, grid.NEAREST)
    assert out.shape == (80, 100) and out.dtype == np.float32
    assert np.array_equal(out, surface(*centres(bounds, 1)).astype(np.float32))
    assert log == [{"bbox": "1000,2000,1100,2080", "bboxSR": "25832", "imageSR": "25832",
                    "size": "100,80", "format": "tiff", "pixelType": "F32",
                    "interpolation": "RSP_NearestNeighbor", "f": "image"}]


def test_tiles_are_at_most_max_px_and_mosaic_exactly(make_client):
    log = []
    client = make_client(fake_server(log), min_interval=0.0)
    bounds = (1000, 2000, 1000 + 250 * 5, 2000 + 130 * 5)
    out = fetch_raster(client, "NHM_DTM_25832", bounds, 5, grid.BILINEAR, max_px=100)
    assert out.shape == (130, 250)
    assert np.array_equal(out, surface(*centres(bounds, 5)).astype(np.float32))
    sizes = [tuple(int(v) for v in q["size"].split(",")) for q in log]
    assert len(sizes) == 3 * 2
    assert all(w <= 100 and h <= 100 for w, h in sizes)
    assert sum(w for w, h in sizes) == 250 * 2 and sum(h for w, h in sizes) == 130 * 3
    assert all(q["interpolation"] == "RSP_BilinearInterpolation" for q in log)


def test_extent_must_be_whole_cells(make_client):
    with pytest.raises(ValueError):
        fetch_raster(make_client(fake_server()), "NHM_DTM_25832", (0, 0, 10.5, 10), 1,
                     grid.NEAREST)


def test_shifted_tile_fails_loudly(make_client):
    client = make_client(fake_server(shift=0.5))
    with pytest.raises(TerrainError, match="transform"):
        fetch_raster(client, "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1, grid.NEAREST)


def test_wrong_size_fails_loudly(make_client):
    transport = FakeTransport()
    transport.add(HOST, PATH, lambda *a: (200, {}, make_geotiff(np.zeros((9, 10)), 1000, 2010, 1)))
    with pytest.raises(TerrainError, match="px"):
        fetch_raster(make_client(transport), "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1,
                     grid.NEAREST)


def test_wrong_crs_fails_loudly(make_client):
    transport = FakeTransport()
    transport.add(HOST, PATH, lambda *a: (200, {}, make_geotiff(np.zeros((10, 10)), 1000, 2010, 1,
                                                                   epsg=25833)))
    with pytest.raises(TerrainError, match="25832"):
        fetch_raster(make_client(transport), "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1,
                     grid.NEAREST)


def test_error_json_with_status_200_fails_and_is_not_cached(make_client):
    body = b'{"error":{"code":400,"message":"The requested image exceeds the size limit."}}'
    transport = FakeTransport()
    transport.add(HOST, PATH, (200, {"Content-Type": "application/json"}, body))
    client = make_client(transport)
    with pytest.raises(TerrainError, match="size limit"):
        fetch_raster(client, "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1, grid.NEAREST)
    with pytest.raises(TerrainError):
        fetch_raster(client, "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1, grid.NEAREST)
    assert len(transport.urls(PATH)) == 2  # asked again: the error was not cached


def test_declared_nodata_comes_back_as_nan(make_client):
    values = np.full((10, 10), 5.0, dtype=np.float32)
    values[2, 3] = -9999.0
    transport = FakeTransport()
    transport.add(HOST, PATH, lambda *a: (200, {}, make_geotiff(values, 1000, 2010, 1,
                                                                   nodata=-9999.0)))
    out = fetch_raster(make_client(transport), "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1,
                       grid.NEAREST)
    assert np.isnan(out[2, 3]) and np.count_nonzero(np.isnan(out)) == 1


def test_fill_nodata():
    arr = np.array([[1.0, np.nan], [3.4e38, -2.0]], dtype=np.float32)
    assert terrain.fill_nodata(arr) == 2
    assert arr.tolist() == [[1.0, 0.0], [0.0, -2.0]]


def test_undeclared_minus_9999_is_nodata_but_land_below_sea_level_is_not():
    arr = np.array([[-9999.0, -499.0], [-2.2, -32768.0]], dtype=np.float32)
    assert terrain.fill_nodata(arr) == 2
    assert arr.tolist() == [[0.0, -499.0], [np.float32(-2.2), 0.0]]


def test_undeclared_nodata_through_level_chunks(make_client):
    transport = FakeTransport()
    transport.add(HOST, PATH, export_image_handler(
        lambda e, n: np.where((e < 1010) & (n > 2090), -9999.0, surface(e, n))))
    chunks = level_chunks(make_client(transport), SMALL, 1050, 2050)
    assert chunks.nodata_samples > 0
    assert min(float(a.min()) for a in chunks.values()) > -500


def tiff_bytes(arrays, dtype="float32"):
    from affine import Affine
    from rasterio.io import MemoryFile

    with MemoryFile() as memfile:
        with memfile.open(driver="GTiff", width=10, height=10, count=len(arrays), dtype=dtype,
                          crs="EPSG:25832", transform=Affine(1.0, 0.0, 1000, 0.0, -1.0, 2010)
                          ) as ds:
            for band, array in enumerate(arrays, start=1):
                ds.write(np.asarray(array, dtype=dtype), band)
        return memfile.read()


@pytest.mark.parametrize("content", [
    tiff_bytes([np.zeros((10, 10)), np.zeros((10, 10))]),          # two bands
    tiff_bytes([np.zeros((10, 10))], dtype="int16"),                # not float32
])
def test_a_tile_that_is_not_one_float32_band_fails_loudly(make_client, content):
    transport = FakeTransport()
    transport.add(HOST, PATH, lambda *a: (200, {}, content))
    with pytest.raises(TerrainError, match="band"):
        fetch_raster(make_client(transport), "NHM_DTM_25832", (1000, 2000, 1010, 2010), 1,
                     grid.NEAREST)


SMALL = Level("h1", 1, 250, 100, 1, grid.NEAREST)  # 100 m chunks, 250 m radius


def test_level_chunks_cut_exactly(make_client):
    client = make_client(fake_server(), min_interval=0.0)
    e0, n0 = 1050, 2050
    chunks = level_chunks(client, SMALL, e0, n0)
    assert sorted(chunks) == grid.chunks_for_disk(SMALL, e0, n0)
    for (i, j), arr in chunks.items():
        assert arr.shape == (102, 102)
        east, north = grid.sample_centres(SMALL, i, j)
        assert np.array_equal(arr, surface(east[None, :], north[:, None]).astype(np.float32))
    assert chunks.nodata_fraction == 0.0 and chunks.tiles == 1


def test_level_chunks_aprons_equal_neighbours(make_client):
    chunks = level_chunks(make_client(fake_server(), min_interval=0.0), SMALL, 1050, 2050)
    checked = 0
    for (i, j), arr in chunks.items():
        if (i + 1, j) in chunks:
            assert np.array_equal(arr[:, -1], chunks[(i + 1, j)][:, 1])
            assert np.array_equal(arr[:, -2], chunks[(i + 1, j)][:, 0])
            checked += 1
        if (i, j + 1) in chunks:
            assert np.array_equal(arr[0, :], chunks[(i, j + 1)][-2, :])
            assert np.array_equal(arr[1, :], chunks[(i, j + 1)][-1, :])
            checked += 1
    assert checked > 10


def test_level_chunks_skips_tiles_touching_no_chunk(make_client):
    log = []
    client = make_client(fake_server(log), min_interval=0.0)
    chunks = level_chunks(client, SMALL, 1050, 2050, max_px=102)
    west, south, east, north = chunks.bounds
    total = math.ceil((east - west) / 102) * math.ceil((north - south) / 102)
    assert chunks.tiles == len(log) < total
    stored = [grid.stored_array_bounds(SMALL, i, j) for i, j in chunks]
    for query in log:
        w, s, e, n = (float(v) for v in query["bbox"].split(","))
        assert any(w < b[2] and b[0] < e and s < b[3] and b[1] < n for b in stored)
    # And the cut is the same as with one big tile.
    whole = level_chunks(make_client(fake_server(), min_interval=0.0,
                                     cache_dir=None), SMALL, 1050, 2050)
    for key in chunks:
        assert np.array_equal(chunks[key], whole[key])


def test_level_chunks_fills_and_counts_nodata(make_client):
    hole = lambda e, n: (np.abs(e - 1050) < 5) & (np.abs(n - 2050) < 5)  # 10 x 10 px
    client = make_client(fake_server(nodata_fn=hole), min_interval=0.0)
    chunks = level_chunks(client, SMALL, 1050, 2050)
    assert chunks.nodata_samples == 100
    assert chunks.nodata_fraction == pytest.approx(100 / (len(chunks) * 102 * 102))
    assert not any(np.isnan(a).any() for a in chunks.values())
    assert chunks[(10, 20)][51, 51] == 0.0


def test_level_chunks_uses_the_level_interpolation(make_client):
    log = []
    coarse = Level("h5", 5, 1000, 100, 1, grid.BILINEAR)
    level_chunks(make_client(fake_server(log), min_interval=0.0), coarse, 1050, 2050)
    assert {q["interpolation"] for q in log} == {"RSP_BilinearInterpolation"}


def test_service_epsg():
    assert terrain.service_epsg("NHM_DTM_25832") == 25832
    assert terrain.service_epsg("NHM_DOM_25833") == 25833


# -- a level fetched finer and averaged (h5), and the registration check -------------

COARSE = Level("h5", 5, 400, 20, 1, grid.BILINEAR, 2.5)   # 100 m chunks, fetched at 2.5 m


def cell_means(level, i, j, fn, sub=1.0):
    """Exact-ish cell means of fn over chunk (i, j)'s stored cells, from sub-metre points."""
    east, north = grid.sample_centres(level, i, j)
    k = int(round(level.cell / sub))
    offsets = (np.arange(k) + 0.5) * sub - level.cell / 2.0
    e = east[None, :, None, None] + offsets[None, None, None, :]
    n = north[:, None, None, None] + offsets[None, None, :, None]
    return fn(e, n).mean(axis=(2, 3))


def test_fetch_factor():
    assert COARSE.fetch_factor == 2
    assert Level("h1", 1, 100, 100, 1, grid.NEAREST).fetch_factor == 1
    with pytest.raises(ValueError):
        Level("x", 5, 100, 20, 1, grid.BILINEAR, 2.0).fetch_factor
    assert grid.LEVELS_BY_NAME["h5"].fetch_cell == 2.5
    assert grid.LEVELS_BY_NAME["h1"].fetch_cell is None
    assert grid.LEVELS_BY_NAME["h20"].fetch_cell is None


def test_block_mean_is_rounded_once():
    """The mean stays float64 until the codec rounds it (it used to be cast to float32 first)."""
    a = np.float32(0.35)                      # 0.3499999940...
    b = np.nextafter(a, np.float32(1.0))      # 0.3500000238...
    arr = np.array([[a, a], [a, b]], dtype=np.float32)
    mean = terrain.block_mean(arr, 2)
    assert mean.dtype == np.float64 and 0.35 <= mean[0, 0] < 0.3500000089
    assert codec.height_dm(mean).tolist() == [[4]]
    assert codec.height_dm(mean.astype(np.float32)).tolist() == [[3]]   # the double rounding


def test_block_mean():
    arr = np.arange(16, dtype=np.float32).reshape(4, 4)
    assert terrain.block_mean(arr, 2).tolist() == [[2.5, 4.5], [10.5, 12.5]]
    assert terrain.block_mean(arr, 1) is arr
    arr[0, 0] = np.nan
    assert np.isnan(terrain.block_mean(arr, 2)[0, 0])
    with pytest.raises(ValueError):
        terrain.block_mean(np.zeros((3, 4), dtype=np.float32), 2)


def test_level_with_fetch_cell_is_asked_for_finer_cells_and_averaged(make_client):
    log = []
    chunks = level_chunks(make_client(fake_server(log), min_interval=0.0), COARSE, 1050, 2050)
    for query in log:
        w, s, e, n = (float(v) for v in query["bbox"].split(","))
        width, height = (int(v) for v in query["size"].split(","))
        assert (e - w) / width == 2.5 and (n - s) / height == 2.5
    assert chunks.samples == len(chunks) * 22 * 22
    for (i, j), arr in chunks.items():
        assert arr.shape == (22, 22)
        east, north = grid.sample_centres(COARSE, i, j)
        quarter = [surface(east[None, :] + dx, north[:, None] + dy).astype(np.float32)
                   for dx in (-1.25, 1.25) for dy in (-1.25, 1.25)]
        expected = np.mean(np.asarray(quarter, dtype=np.float64), axis=0)
        assert np.allclose(arr, expected, atol=1e-4)
        # A mean of the cell, not the value at its centre.
        centre = surface(east[None, :], north[:, None])
        assert np.abs(arr - centre).max() > 0.01


def fine_and_coarse(shift_north=0.0, coarse=COARSE):
    """h1-like chunks of `surface`, and coarse chunks holding true cell means moved north."""
    fine = {key: surface(*np.meshgrid(*grid.sample_centres(SMALL, *key), indexing="xy"))
            for key in grid.chunks_for_disk(SMALL, 1050, 2050)}
    moved = lambda e, n: surface(e, n + shift_north)
    coarse_chunks = {key: cell_means(coarse, *key, moved)
                     for key in grid.chunks_for_disk(coarse, 1050, 2050)}
    return fine, coarse_chunks


def test_registration_check_passes_true_cell_means():
    fine, coarse = fine_and_coarse()
    result = terrain.registration_check(SMALL, fine, COARSE, coarse)
    assert result["cells"] >= terrain.REGISTRATION_MIN_CELLS
    assert result["best_shift_m"] == [0, 0] and result["shifted"] is False
    assert result["mean_abs_diff_m"] < 1e-6


def test_registration_check_finds_the_2_m_shift_the_real_service_had():
    # The first real build's h5 matched the 1 m block means best moved 2 m north.
    fine, coarse = fine_and_coarse(shift_north=2.0)
    result = terrain.registration_check(SMALL, fine, COARSE, coarse)
    assert result["best_shift_m"] == [0, 2] and result["shifted"] is True
    assert result["best_mean_abs_diff_m"] < 1e-6 < result["mean_abs_diff_m"]


def test_registration_check_ignores_sea_and_needs_enough_land():
    fine, coarse = fine_and_coarse(shift_north=2.0)
    sea = {key: np.zeros_like(arr) for key, arr in fine.items()}
    result = terrain.registration_check(SMALL, sea, COARSE, coarse)
    assert result["cells"] == 0 and "too few" in result["note"]
    assert "shifted" not in result


# -- the registration check at h20: half-cell and whole-cell displacements ---------

H20ISH = Level("h20", 20, 400, 5, 1, grid.BILINEAR)   # 100 m chunks of 20 m cells


def coarse_means(coarse, shift_east=0.0, shift_north=0.0, noise=0.0, fine_level=SMALL):
    """True cell means of `surface`, displaced, optionally with seeded noise."""
    rng = np.random.default_rng(7)
    moved = lambda e, n: surface(e + shift_east, n + shift_north)  # noqa: E731
    out = {}
    for key in grid.chunks_for_disk(coarse, 1050, 2050):
        arr = cell_means(coarse, *key, moved)
        out[key] = arr + (rng.normal(0.0, noise, arr.shape) if noise else 0.0)
    return out


def fine_chunks(level=SMALL):
    return {key: surface(*np.meshgrid(*grid.sample_centres(level, *key), indexing="xy"))
            for key in grid.chunks_for_disk(level, 1050, 2050)}


@pytest.mark.parametrize("east,north", [(0, 3), (0, 10), (10, 0), (0, 20), (-20, 0)])
def test_registration_check_sees_half_and_whole_cell_shifts_at_h20(east, north):
    """The old +-3 m window found none of 10 m or 20 m; the search now spans one coarse cell."""
    result = terrain.registration_check(SMALL, fine_chunks(), H20ISH,
                                        coarse_means(H20ISH, east, north))
    assert result["cells"] >= terrain.REGISTRATION_MIN_CELLS
    assert result["window_m"] == [-20, 20]
    assert result["best_shift_m"] == [east, north]
    assert result["shifted"] is True
    assert result["at_window_edge"] is (max(abs(east), abs(north)) == 20)


def test_registration_check_does_not_flag_a_noisy_but_correctly_placed_level():
    # Like the server's bilinear 20 m output: well placed, but not an exact cell mean.
    result = terrain.registration_check(SMALL, fine_chunks(), H20ISH,
                                        coarse_means(H20ISH, noise=0.6))
    assert result["mean_abs_diff_m"] > 0.3
    assert result["best_shift_m"] == [0, 0] and result["shifted"] is False


def test_registration_check_h20_against_h5():
    """Beyond the h1 disk, h20 is checked against h5, in 5 m steps."""
    h5 = {key: cell_means(COARSE, *key, surface) for key in grid.chunks_for_disk(COARSE, 1050, 2050)}
    placed = terrain.registration_check(COARSE, h5, H20ISH, coarse_means(H20ISH))
    assert placed["compared_with"] == "h5" and placed["window_m"] == [-20, 20]
    assert placed["best_shift_m"] == [0, 0] and placed["shifted"] is False
    moved = terrain.registration_check(COARSE, h5, H20ISH, coarse_means(H20ISH, 0, 10))
    assert moved["best_shift_m"] == [0, 10] and moved["shifted"] is True
