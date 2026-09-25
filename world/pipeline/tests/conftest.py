"""Shared test helpers: a fake transport, fake GeoTIFFs, and a network guard.

Every coordinate and number in these tests is synthetic, or a neutral public
reference point. No listing data appears here.
"""

from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import numpy as np
import pytest

import commons_world.http as cw_http

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def no_real_network(request, monkeypatch):
    """Fail any test that would reach the real network unless it is marked network."""
    if request.node.get_closest_marker("network") is None:
        def refuse(method, url, headers, body, timeout):
            raise AssertionError("test tried to reach the network: {} {}".format(method, url))
        monkeypatch.setattr(cw_http, "requests_transport", refuse)


class FakeClock:
    """A clock whose sleep() moves time forward instead of waiting."""

    def __init__(self, start=1000.0):
        self.t = start
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds


class FakeTransport:
    """Routes requests to handlers by (method, host, path).

    A handler is `fn(method, url, query_dict, headers, body) -> (status, headers, content)`
    or a fixed (status, headers, content) tuple. Unrouted robots.txt requests
    answer 404 (allow all); anything else unrouted fails the test.
    """

    def __init__(self, routes=None, robots=None):
        self.routes = dict(routes or {})
        self.robots = dict(robots or {})  # host -> handler for /robots.txt
        self.calls = []

    def add(self, host, path, handler, method="GET"):
        self.routes[(method, host, path)] = handler

    def __call__(self, method, url, headers, body, timeout):
        parts = urlsplit(url)
        self.calls.append({"method": method, "url": url, "headers": dict(headers),
                           "body": body})
        if parts.path == "/robots.txt":
            handler = self.robots.get(parts.hostname, (404, {}, b"not found"))
        else:
            handler = self.routes.get((method, parts.hostname, parts.path))
            if handler is None:
                raise AssertionError("unexpected request {} {}".format(method, url))
        if callable(handler):
            return handler(method, url, dict(parse_qsl(parts.query)), headers, body)
        return handler

    def urls(self, path=None):
        return [c["url"] for c in self.calls
                if path is None or urlsplit(c["url"]).path == path]


def make_geotiff(array, west, north, cell, epsg=25832, nodata=None):
    """A float32 GeoTIFF, as bytes, with pixel (0, 0) at the north-west corner."""
    from affine import Affine
    from rasterio.io import MemoryFile

    array = np.asarray(array, dtype=np.float32)
    profile = {"driver": "GTiff", "width": array.shape[1], "height": array.shape[0],
               "count": 1, "dtype": "float32", "crs": "EPSG:{}".format(epsg),
               "transform": Affine(cell, 0.0, west, 0.0, -cell, north)}
    if nodata is not None:
        profile["nodata"] = nodata
    with MemoryFile() as memfile:
        with memfile.open(**profile) as ds:
            ds.write(array, 1)
        return memfile.read()


def export_image_handler(height_fn, log=None, shift=0.0, nodata_fn=None):
    """An exportImage stand-in: samples height_fn(E, N) at the requested pixel centres.

    `shift` moves the returned grid (to test the transform check). `nodata_fn`
    marks pixels to return as NaN.
    """
    def handler(method, url, query, headers, body):
        west, south, east, north = (float(v) for v in query["bbox"].split(","))
        width, height = (int(v) for v in query["size"].split(","))
        cell = (east - west) / width
        assert abs((north - south) / height - cell) < 1e-9
        e = west + (np.arange(width) + 0.5) * cell
        n = north - (np.arange(height) + 0.5) * cell
        values = height_fn(e[None, :], n[:, None]).astype(np.float32)
        if nodata_fn is not None:
            values = np.where(nodata_fn(e[None, :], n[:, None]), np.nan, values)
        if log is not None:
            log.append(query)
        return 200, {"Content-Type": "image/tiff"}, make_geotiff(values, west + shift, north,
                                                                 cell)
    return handler


@pytest.fixture
def clock():
    return FakeClock()


@pytest.fixture
def make_client(tmp_path, clock):
    """Factory for a Client on a fake transport with a fake clock."""
    def factory(transport, **kwargs):
        kwargs.setdefault("sleep", clock.sleep)
        kwargs.setdefault("clock", clock)
        return cw_http.Client(kwargs.pop("cache_dir", tmp_path / "cache"),
                              transport=transport, **kwargs)
    return factory
