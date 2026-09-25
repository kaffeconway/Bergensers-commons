"""The Geonorge download API client and the municipality lookup, against fake services."""

import json
import math

import pytest
from shapely.geometry import box, mapping

from commons_world import download, synthetic
from commons_world.http import Client, HTTPError, OfflineCacheMiss

from conftest import FakeTransport
import gml_fixtures as fx

UUID = "ea192681-d039-42ec-b1bc-f3ce04c189ac"
E0, N0 = synthetic.origin()
REF = "00000000-0000-0000-0000-000000000001"
FILE_ID = "00000000-0000-0000-0000-000000000002"
NAME = fx.n50_zip_name()
FIXED = "/geonorge/Basisdata/N50Kartdata/GML/" + NAME


def area_list(projections=(("25832", ("GML", "SOSI")),)):
    return [{"type": "fylke", "code": "99", "name": "Nowhere county", "projections": []},
            {"type": "kommune", "code": "9999", "name": "Nowhere",
             "projections": [{"code": code, "formats": [{"name": f} for f in formats]}
                             for code, formats in projections]}]


def order_response(status="ReadyForDownload"):
    return {"referenceNumber": REF, "files": [{
        "downloadUrl": "https://nedlasting.geonorge.no/api/download/order/{}/{}".format(REF,
                                                                                        FILE_ID),
        "name": NAME, "fileId": FILE_ID, "metadataUuid": UUID, "area": "9999",
        "projection": "25832", "format": "GML", "status": status}]}


def fake_download(zip_bytes, orders=None, link_status=302, status="ReadyForDownload",
                  projections=(("25832", ("GML", "SOSI")),)):
    transport = FakeTransport()
    transport.add("nedlasting.geonorge.no", "/api/codelists/area/" + UUID,
                  (200, {"Content-Type": "application/json"},
                   json.dumps(area_list(projections)).encode()))

    def order(method, url, query, headers, body):
        if orders is not None:
            orders.append(json.loads(body))
        return 200, {"Content-Type": "application/json"}, json.dumps(order_response(status)).encode()
    transport.add("nedlasting.geonorge.no", "/api/order", order, method="POST")
    link = "/api/download/order/{}/{}".format(REF, FILE_ID)
    if link_status == 302:
        transport.add("nedlasting.geonorge.no", link,
                      (302, {"Location": "https://nedlasting.geonorge.no" + FIXED}, b""))
    else:
        transport.add("nedlasting.geonorge.no", link, (link_status, {}, b"gone"))
    transport.add("nedlasting.geonorge.no", FIXED, (200, {"Content-Type": "application/zip"},
                                                    zip_bytes))
    return transport


def test_order_body_and_the_file(make_client):
    content = fx.n50_zip(E0, N0)
    orders = []
    transport = fake_download(content, orders)
    files = download.fetch(make_client(transport), UUID, "9999", "25832")
    assert len(files) == 1 and files[0].content == content and files[0].name == NAME
    assert files[0].url.endswith(FIXED)
    assert orders == [{"orderLines": [{
        "metadataUuid": UUID,
        "areas": [{"code": "9999", "name": "Nowhere", "type": "kommune"}],
        "projections": [{"code": "25832"}],
        "formats": [{"name": "GML"}]}]}]
    assert "email" not in json.dumps(orders)


def test_a_rebuild_comes_from_the_cache(tmp_path, clock):
    content = fx.n50_zip(E0, N0)
    first = Client(tmp_path / "cache", transport=fake_download(content), sleep=clock.sleep,
                   clock=clock)
    download.fetch(first, UUID, "9999", "25832")
    silent = FakeTransport()
    offline = Client(tmp_path / "cache", transport=silent, offline=True)
    files = download.fetch(offline, UUID, "9999", "25832")
    assert files[0].content == content and files[0].from_cache
    assert silent.calls == []


def test_refuses_what_is_not_offered(make_client):
    transport = fake_download(b"PK", projections=(("25833", ("GML",)),))
    with pytest.raises(download.DownloadError, match="not offered as GML in EPSG:25832"):
        download.fetch(make_client(transport), UUID, "9999", "25832")
    with pytest.raises(download.DownloadError, match="not offered for kommune 1234"):
        download.fetch(make_client(transport), UUID, "1234", "25832")
    assert not transport.urls("/api/order")


def test_refuses_a_file_that_is_not_ready(make_client):
    with pytest.raises(download.DownloadError, match="not ReadyForDownload"):
        download.fetch(make_client(fake_download(b"PK", status="WaitingForProcessing")),
                       UUID, "9999", "25832")


def test_an_expired_link_on_a_cached_order_falls_back_to_the_fixed_file(tmp_path, clock):
    content = fx.n50_zip(E0, N0)
    cache = tmp_path / "cache"
    broken = fake_download(content, link_status=500)
    with pytest.raises(HTTPError):
        download.fetch(Client(cache, transport=broken, sleep=clock.sleep, clock=clock),
                       UUID, "9999", "25832")
    expired = fake_download(content, link_status=410)
    files = download.fetch(Client(cache, transport=expired, sleep=clock.sleep, clock=clock),
                           UUID, "9999", "25832")
    assert files[0].content == content
    assert expired.urls("/api/order") == []          # the order came from the cache
    assert expired.urls(FIXED)


def test_fixed_file_url_pattern():
    assert download.fixed_file_url(
        "Samferdsel_9999_Nowhere_5973_NVDB-VegnettPluss_GML.zip", "GML") == (
        "https://nedlasting.geonorge.no/geonorge/Samferdsel/NVDB-VegnettPluss/GML/"
        "Samferdsel_9999_Nowhere_5973_NVDB-VegnettPluss_GML.zip")
    assert download.fixed_file_url("odd.zip", "GML") is None


def test_zip_members_are_sorted_and_filtered():
    names = [name for name, _ in download.zip_members(fx.n50_zip(E0, N0), ".gml")]
    assert names == sorted(names) and len(names) == 5


# -- municipalities ------------------------------------------------------------------

def test_sample_points_cover_rings_with_bounded_spacing():
    points = download.disk_sample_points(1000.0, 2000.0, 3500.0)
    assert points[0] == (1000, 2000)
    radii = sorted({round(math.hypot(e - 1000, n - 2000)) for e, n in points[1:]})
    assert radii == [1000, 2000, 3000, 3500]
    ring = [(e, n) for e, n in points if round(math.hypot(e - 1000, n - 2000)) == 3500]
    assert len(ring) == max(16, math.ceil(2 * math.pi * 3500 / 1000))
    assert len(points) == len(set(points))


def fake_kommuneinfo(e_split, n_sea):
    """West of e_split is 9998, east is 9999; north of n_sea is open sea (404)."""
    def punkt(method, url, query, headers, body):
        e, n = float(query["ost"]), float(query["nord"])
        assert query["koordsys"] == "25832"
        if n > n_sea:
            return 404, {}, b"<p>Ingen treff, sjekk parameterene.</p>"
        nr = "9998" if e < e_split else "9999"
        return 200, {}, json.dumps({"kommunenummer": nr, "kommunenavn": "K" + nr,
                                    "fylkesnummer": "99"}).encode()

    def omrade(nr):
        west = box(e_split - 50000, n_sea - 50000, e_split, n_sea)
        east = box(e_split, n_sea - 50000, e_split + 50000, n_sea)
        shape = west if nr == "9998" else east
        return (200, {}, json.dumps({"kommunenummer": nr, "kommunenavn": "K" + nr,
                                     "omrade": mapping(shape)}).encode())
    transport = FakeTransport()
    transport.add("api.kartverket.no", "/kommuneinfo/v1/punkt", punkt)
    for nr in ("9998", "9999"):
        transport.add("api.kartverket.no", "/kommuneinfo/v1/kommuner/{}/omrade".format(nr),
                      omrade(nr))
    return transport


def test_kommuner_for_disk_finds_both_and_skips_covered_points(make_client):
    transport = fake_kommuneinfo(E0 + 2000, N0 + 3000)
    lookup = download.kommuner_for_disk(make_client(transport), E0, N0, 5000)
    assert lookup.kommuner == ["9998", "9999"]
    assert lookup.names == {"9998": "K9998", "9999": "K9999"}
    assert lookup.outline_requests == 2
    assert lookup.no_kommune > 0
    assert lookup.point_lookups < lookup.sample_points / 2
    assert lookup.requests == lookup.point_lookups + 2
    assert len(transport.urls("/kommuneinfo/v1/punkt")) == lookup.point_lookups


def test_kommuner_offline_rebuild_matches(tmp_path, clock):
    cache = tmp_path / "cache"
    online = download.kommuner_for_disk(
        Client(cache, transport=fake_kommuneinfo(E0 + 2000, N0 + 3000), sleep=clock.sleep,
               clock=clock), E0, N0, 5000)
    offline = download.kommuner_for_disk(Client(cache, transport=FakeTransport(), offline=True),
                                         E0, N0, 5000)
    assert offline.kommuner == online.kommuner
    assert offline.offline_misses == online.no_kommune    # 404s are never cached
    with pytest.raises(OfflineCacheMiss):
        download.kommuner_for_disk(Client(tmp_path / "empty", transport=FakeTransport(),
                                          offline=True), E0, N0, 5000)
