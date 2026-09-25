"""Place names: which types are kept, spelling, tiling the disk, and heights from the chunks."""

import json
import math

import numpy as np
import pytest

from commons_world import grid, places, synthetic
from commons_world.grid import Level
from commons_world.manifest import dumps_json
from commons_world.terrain import ChunkSet

from conftest import FakeTransport

E0, N0 = synthetic.origin()
PATH = "/stedsnavn/v1/punkt"


def name(text, status="godkjent og prioritert", role="hovednavn"):
    return {"skrivem\u00e5te": text, "skrivem\u00e5testatus": status, "navnestatus": role,
            "spr\u00e5k": "Norsk", "stedsnavnnummer": 1}


def test_spelling_prefers_the_main_prioritised_name_and_skips_history():
    assert places.choose_spelling([name("Old", "historisk og prioritert"),
                                   name("Side", role="sidenavn"),
                                   name("Main")]) == "Main"
    assert places.choose_spelling([name("A", "godkjent"), name("B", "vedtatt og prioritert")]) \
        == "B"
    assert places.choose_spelling([name("Idea", "foresl\u00e5tt"), name("Gone", "historisk")]) \
        is None


def test_kept_types():
    for kept in ("Fjell", "Topp", "Haug", "\u00c5s", "Berg", "H\u00f8yde", "Rygg"):
        assert kept in places.PLACE_TYPES
    for dropped in ("Vik i sj\u00f8", "Bakke", "Li", "Varde", "Adressenavn", "Vidde", "Holme"):
        assert dropped not in places.PLACE_TYPES


def test_squares_cover_the_disk():
    squares = places.squares_for_disk(E0, N0, 11000)
    assert len(squares) == 16
    for ce, cn, half in squares:
        assert half * math.sqrt(2) == pytest.approx(5000)
    for k in range(400):
        r, a = 11000 * math.sqrt(k / 400), k * 2.399963
        e, n = E0 + r * math.cos(a), N0 + r * math.sin(a)
        assert any(abs(e - ce) <= h + 1e-6 and abs(n - cn) <= h + 1e-6
                   for ce, cn, h in squares)
    assert len(places.squares_for_disk(E0, N0, 3000)) == 1


def item(number, kind, e, n, text=None, status="aktiv"):
    return {"stedsnummer": number, "navneobjekttype": kind, "stedstatus": status,
            "representasjonspunkt": {"koordsys": 25832, "\u00f8st": e, "nord": n},
            "stedsnavn": [name(text or "Place {}".format(number))]}


def fake_stedsnavn(items, log, total=None):
    def handler(method, url, query, headers, body):
        log.append(query)
        assert query["koordsys"] == "25832" and query["utkoordsys"] == "25832"
        assert int(query["radius"]) <= 5000
        page, size = int(query["side"]), int(query["treffPerSide"])
        ce, cn, radius = float(query["ost"]), float(query["nord"]), float(query["radius"])
        hits = [i for i in items if math.hypot(i["representasjonspunkt"]["\u00f8st"] - ce,
                                               i["representasjonspunkt"]["nord"] - cn) <= radius]
        body = {"metadata": {"side": page, "totaltAntallTreff": total or len(hits),
                             "treffPerSide": size},
                "navn": hits[(page - 1) * size:page * size]}
        return 200, {"Content-Type": "application/json"}, json.dumps(body).encode()
    transport = FakeTransport()
    transport.add("api.kartverket.no", PATH, handler)
    return transport


def test_fetch_filters_types_pages_and_deduplicates(make_client, monkeypatch):
    monkeypatch.setattr(places, "PAGE_SIZE", 3)
    items = [item(1, "Fjell", E0 + 100, N0 + 100), item(2, "Haug", E0 - 200, N0 + 50),
             item(3, "Vik i sj\u00f8", E0 + 10, N0 + 10), item(4, "Topp", E0 + 50, N0 - 50),
             item(5, "Adressenavn", E0, N0), item(6, "Fjell", E0 + 3000, N0),   # outside disk
             item(7, "Berg", E0 + 5, N0 + 5, status="planlagt")]
    log = []
    search = places.fetch_names(make_client(fake_stedsnavn(items, log)), E0, N0, 2000)
    assert sorted(c.number for c in search.candidates) == [1, 2, 4]
    assert search.squares == 1 and search.requests == 3        # 7 names at 3 a page
    assert [q["side"] for q in log] == ["1", "2", "3"]
    assert search.names_seen == 7        # the far Fjell is in the square, then outside the disk
    c = next(c for c in search.candidates if c.number == 1)
    assert (c.e, c.n, c.type, c.name) == (E0 + 100, N0 + 100, "Fjell", "Place 1")


def test_a_crowded_square_is_split(make_client):
    log = []
    items = [item(1, "Fjell", E0 + 100, N0 + 100)]
    search = places.fetch_names(make_client(fake_stedsnavn(items, log, total=6000)), E0, N0, 2000)
    assert search.splits >= 1 and len(search.candidates) == 1


def cone_chunks(level, top_e, top_n, top_h, keys):
    out = ChunkSet()
    for i, j in keys:
        east, north = grid.sample_centres(level, i, j)
        d = np.hypot(east[None, :] - top_e, north[:, None] - top_n)
        out[(i, j)] = (top_h - 0.1 * d).astype(np.float32)
    return out


def test_heights_are_the_highest_sample_within_30_m_on_the_finest_level():
    h1 = Level("h1", 1, 300, 240, 1, grid.NEAREST)
    h5 = Level("h5", 5, 1500, 240, 1, grid.BILINEAR)
    top = (E0 + 0.5, N0 + 0.5, 250.0)                 # on an h1 cell centre
    keys1 = grid.chunks_for_disk(h1, E0, N0)
    keys5 = grid.chunks_for_disk(h5, E0, N0)
    chunks = {"h1": cone_chunks(h1, *top, keys1), "h5": cone_chunks(h5, *top, keys5)}
    near = places.Candidate("Near Fjell", "Fjell", E0 + 20.5, N0 + 0.5)
    far = places.Candidate("Far Haug", "Haug", E0 + 1200.0, N0)
    found = places.sample_heights([near, far], chunks, [h5, h1])
    by_name = {p.name: p for p in found}
    assert by_name["Near Fjell"].level == "h1"
    assert (by_name["Near Fjell"].e, by_name["Near Fjell"].n) == (top[0], top[1])
    assert by_name["Near Fjell"].h == pytest.approx(250.0, abs=1e-4)
    assert by_name["Near Fjell"].offset_m == pytest.approx(20.0)
    assert by_name["Far Haug"].level == "h5"
    # The highest h5 sample within 30 m of the far name point is 30 m nearer the top.
    assert by_name["Far Haug"].h == pytest.approx(250.0 - 0.1 * 1170.0, abs=0.6)


def test_a_name_near_the_edge_of_h1_is_not_measured_on_half_its_summit():
    h1 = Level("h1", 1, 300, 240, 1, grid.NEAREST)
    h5 = Level("h5", 5, 1500, 240, 1, grid.BILINEAR)
    keys1 = grid.chunks_for_disk(h1, E0, N0)
    j = math.floor(N0 / h1.side)
    edge = (max(i for i, jj in keys1 if jj == j) + 1) * h1.side   # east edge of h1 coverage
    n = (j + 0.5) * h1.side + 0.5
    top = (edge + 12.5, n, 180.0)                                   # the summit is beyond h1
    chunks = {"h1": cone_chunks(h1, *top, keys1),
              "h5": cone_chunks(h5, *top, grid.chunks_for_disk(h5, E0, N0))}
    name = places.Candidate("Edge Fjell", "Fjell", edge - 10.0, n)
    found = places.sample_heights([name], chunks, [h1, h5])
    assert found[0].level == "h5"
    assert found[0].h == pytest.approx(180.0, abs=0.3)
    assert not places.covers_disk(h1, chunks["h1"], name.e, name.n, 30.0)
    assert places.covers_disk(h1, chunks["h1"], name.e - 40.0, name.n, 30.0)


def test_places_record_is_ascii_json_sorted_by_height():
    found = [places.Place("Low \u00c5s", "\u00c5s", E0 + 10, N0 - 20, 12.345, "h1", 0.0),
             places.Place("High Fjell", "Fjell", E0 - 5, N0 + 5, 300.06, "h5", 3.0)]
    record = places.places_record(found, (E0, N0))
    assert [f["name"] for f in record["features"]] == ["High Fjell", "Low \u00c5s"]
    low = record["features"][1]
    assert (low["x"], low["z"], low["h"]) == (10.0, 20.0, 12.3)
    text = dumps_json(record)
    text.decode("ascii")
    assert b"\\u00c5s" in text


def test_spot_height_check():
    found = [places.Place("A", "Fjell", 0.0, 0.0, 101.0, "h1", 0.0),
             places.Place("B", "Topp", 1000.0, 0.0, 50.0, "h1", 0.0)]
    from commons_world.n50 import SpotHeight
    check = places.spot_height_check(found, [SpotHeight("Terrengpunkt", 10.0, 0.0, 100.0)])
    assert check["compared"] == 1 and check["median_abs_diff_m"] == 1.0
    assert places.spot_height_check(found, []) == {"compared": 0}
