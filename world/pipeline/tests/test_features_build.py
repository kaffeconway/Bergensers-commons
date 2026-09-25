"""The real build with map features, end to end, against fake Kartverket services.

Every service the feature steps use is faked from the synthetic place (origin
in the open North Sea, kommune 9999, which does not exist): the municipality
lookup, the download API with N50 and NVDB zips written from the synthetic
shapes, the trails and building-point WFS, place names, and the surface model.
Nothing here touches the network.
"""

import gzip
import json

import numpy as np
import pytest

from commons_world import build, classes, codec, features, grid, manifest, n50, synthetic, trees
from commons_world.grid import Level
from commons_world.sources import CREDIT_KARTVERKET_MAP, CREDIT_SSR, DATASETS

from conftest import FakeTransport, export_image_handler
import gml_fixtures as fx
from test_real_build import fake_kartverket

ORIGIN = synthetic.origin()
LEVELS = (Level("h1", 1, 300, 240, 1, grid.NEAREST),
          Level("h5", 5, 1500, 240, 1, grid.BILINEAR),
          Level("h20", 20, 5000, 240, 1, grid.BILINEAR))
DOM_PATH = "/arcgis/rest/services/NHM_DOM_25832/ImageServer/exportImage"
N50_UUID = DATASETS["n50"]["uuid"]
NVDB_UUID = DATASETS["nvdb"]["uuid"]
UNKNOWN_TYPE = "Fjellblotning"   # not an N50 type: must be counted as unknown


def n50_zip():
    """An N50 zip holding the synthetic land cover, water, paths, roads and spot heights."""
    e0, n0 = ORIGIN
    areas = []
    for area in synthetic.synthetic_areas(ORIGIN):
        kind = area.source_type if area.source_type != "synthetic rock" else UNKNOWN_TYPE
        holes = [list(h.coords)[:-1] for h in area.polygon.interiors]
        areas.append(fx.n50_surface(kind, list(area.polygon.exterior.coords)[:-1], holes))
    roads = []
    for line in synthetic.synthetic_lines(ORIGIN):
        if line.kind == "stream":
            areas.append(fx.n50_line("ElvBekk", line.coords.tolist()))
            continue
        type_veg = {"road": "enkelBilveg", "footway": "gangOgSykkelveg", "path": "sti"}[line.kind]
        if line.source == "turrutebasen":
            continue
        extra = "<app:medium>{}</app:medium>".format(line.medium or "T")
        tail = "<app:typeVeg>{}</app:typeVeg>".format(type_veg)
        if line.category:
            tail += ("<app:vegsystem><app:Vegsystem><app:vegkategori>{}</app:vegkategori>"
                     "</app:Vegsystem></app:vegsystem>").format(line.category)
        roads.append(fx.n50_line("Veglenke", line.coords.tolist(), extra=extra)
                     .replace("</app:Veglenke>", tail + "</app:Veglenke>"))
    heights = [fx.n50_point("Terrengpunkt", s.e, s.n,
                            extra="<app:h\u00f8yde>{:.0f}</app:h\u00f8yde>".format(s.h))
               for s in synthetic.synthetic_spot_heights(ORIGIN)]
    prefix = "Basisdata_9999_Nowhere_25832_N50"
    return fx.make_zip({prefix + "Arealdekke_GML.gml": fx._n50_collection(areas),
                        prefix + "Samferdsel_GML.gml": fx._n50_collection(roads),
                        prefix + "Hoyde_GML.gml": fx._n50_collection(heights)})


def nvdb_zip():
    links = []
    for index, line in enumerate(synthetic.synthetic_lines(ORIGIN)):
        if line.source != "nvdb":
            continue
        type_veg = "bilveg" if line.kind == "road" else "gsv"
        links.append(fx.nvdb_link(type_veg, line.coords.tolist(), category=line.category,
                                  medium=line.medium, ident=str(100 + index)))
    return fx.nvdb_zip(links)


def dom_function():
    """The synthetic surface model as a function of grid (E, N), for a fake exportImage."""
    h1 = LEVELS[0]
    dtm = synthetic.terrain_source(ORIGIN)(h1)
    lgrid, dom = synthetic.surface_mosaic(h1, dtm, ORIGIN)

    def height(e, n):
        r, q = lgrid.rowcol(e, n)
        inside = lgrid.inside(r, q)
        values = synthetic.height_grid(e, n, ORIGIN) + 0 * r + 0 * q
        values = np.array(values, dtype=np.float64)
        rr, qq = np.broadcast_arrays(r, q)
        mask = np.broadcast_to(inside, values.shape)
        values[mask] = dom[rr[mask], qq[mask]]
        return values
    return height


def download_routes(transport, nvdb_formats=("GML", "SOSI")):
    def area_list(formats, projection):
        return json.dumps([{"type": "kommune", "code": "9999", "name": "Nowhere",
                            "projections": [{"code": projection,
                                             "formats": [{"name": f} for f in formats]}]}]
                          ).encode()
    transport.add("nedlasting.geonorge.no", "/api/codelists/area/" + N50_UUID,
                  (200, {}, area_list(("GML",), "25832")))
    transport.add("nedlasting.geonorge.no", "/api/codelists/area/" + NVDB_UUID,
                  (200, {}, area_list(nvdb_formats, "5973")))
    files = {N50_UUID: (fx.n50_zip_name(), "Basisdata/N50Kartdata", n50_zip()),
             NVDB_UUID: (fx.nvdb_zip_name(), "Samferdsel/NVDB-VegnettPluss", nvdb_zip())}

    def order(method, url, query, headers, body):
        line = json.loads(body)["orderLines"][0]
        name, folder, _ = files[line["metadataUuid"]]
        ref = line["metadataUuid"][:8]
        return 200, {}, json.dumps({"referenceNumber": ref, "files": [{
            "downloadUrl": "https://nedlasting.geonorge.no/api/download/order/{}/f".format(ref),
            "name": name, "status": "ReadyForDownload"}]}).encode()
    transport.add("nedlasting.geonorge.no", "/api/order", order, method="POST")
    for uuid, (name, folder, content) in files.items():
        fixed = "/geonorge/{}/GML/{}".format(folder, name)
        transport.add("nedlasting.geonorge.no", "/api/download/order/{}/f".format(uuid[:8]),
                      (302, {"Location": "https://nedlasting.geonorge.no" + fixed}, b""))
        transport.add("nedlasting.geonorge.no", fixed, (200, {}, content))


def wfs_routes(transport):
    oe, on = ORIGIN
    routes = [fx.fotrute(i, line.coords.tolist()) for i, line in
              enumerate(synthetic.synthetic_lines(ORIGIN)) if line.source == "turrutebasen"]
    points = [fx.ruteinfopunkt(1, oe + x, on + n, code) for x, n, code in synthetic.TRAIL_POINTS]
    bygg = [fx.bygning(i, p.e, p.n, p.type, 800000 + i)
            for i, p in enumerate(synthetic.synthetic_building_points(ORIGIN))]

    def trails(method, url, query, headers, body):
        members = routes if query["typeNames"] == "app:Fotrute" else points
        return 200, {}, fx.trails_page(members if query["startIndex"] == "0" else [])

    def buildings(method, url, query, headers, body):
        return 200, {}, fx.bygning_page(bygg if query["startIndex"] == "0" else [])
    transport.add("wfs.geonorge.no", "/skwms1/wfs.turogfriluftsruter", trails)
    transport.add("wfs.geonorge.no", "/skwms1/wfs.matrikkelen-bygningspunkt", buildings)


def other_routes(transport):
    oe, on = ORIGIN
    transport.add("api.kartverket.no", "/kommuneinfo/v1/punkt",
                  (200, {}, json.dumps({"kommunenummer": "9999", "kommunenavn": "Nowhere"})
                   .encode()))
    everything = {"type": "Polygon", "coordinates": [[[oe - 1e5, on - 1e5], [oe + 1e5, on - 1e5],
                                                      [oe + 1e5, on + 1e5], [oe - 1e5, on + 1e5],
                                                      [oe - 1e5, on - 1e5]]]}
    transport.add("api.kartverket.no", "/kommuneinfo/v1/kommuner/9999/omrade",
                  (200, {}, json.dumps({"kommunenummer": "9999", "kommunenavn": "Nowhere",
                                        "omrade": everything}).encode()))
    names = []
    for index, (text, kind, x, n) in enumerate(synthetic.PLACE_NAMES, start=1):
        names.append({"stedsnummer": index, "navneobjekttype": kind, "stedstatus": "aktiv",
                      "representasjonspunkt": {"\u00f8st": oe + x, "nord": on + n},
                      "stedsnavn": [{"skrivem\u00e5te": text, "navnestatus": "hovednavn",
                                     "skrivem\u00e5testatus": "godkjent og prioritert"}]})

    def punkt(method, url, query, headers, body):
        ce, cn, radius = float(query["ost"]), float(query["nord"]), float(query["radius"])
        hits = [p for p in names if np.hypot(p["representasjonspunkt"]["\u00f8st"] - ce,
                                             p["representasjonspunkt"]["nord"] - cn) <= radius]
        page = int(query["side"])
        return 200, {}, json.dumps({"metadata": {"totaltAntallTreff": len(hits)},
                                    "navn": hits[(page - 1) * 500:page * 500]}).encode()
    transport.add("api.kartverket.no", "/stedsnavn/v1/punkt", punkt)
    transport.add("hoydedata.no", DOM_PATH, export_image_handler(dom_function()))


def fake_everything(nvdb_formats=("GML", "SOSI")):
    transport = fake_kartverket()
    download_routes(transport, nvdb_formats)
    wfs_routes(transport)
    other_routes(transport)
    return transport


@pytest.fixture
def listing_file(tmp_path):
    path = tmp_path / "listing.json"
    path.write_text(json.dumps(synthetic.synthetic_listing()), encoding="utf-8")
    return path


def run(listing_path, out, cache, transport, **kwargs):
    pipeline = features.install(build.core_build_pipeline())
    return build.build(listing_path, out, cache_dir=cache, transport=transport, levels=LEVELS,
                       commit="test", generated_at="2026-01-01T00:00:00Z", min_interval=0.0,
                       pipeline=pipeline, **kwargs)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("features")
    listing = tmp / "listing.json"
    listing.write_text(json.dumps(synthetic.synthetic_listing()), encoding="utf-8")
    transport = fake_everything()
    folder = run(listing, tmp / "world", tmp / "cache", transport)
    return {"folder": folder, "tmp": tmp, "listing": listing, "transport": transport,
            "manifest": json.loads((folder / "manifest.json").read_text(encoding="ascii"))}


def test_the_plugin_registers_its_steps_between_fetch_and_write():
    names = features.install(build.core_build_pipeline()).names()
    start, end = names.index("terrain_fetch"), names.index("terrain")
    assert names[start + 1:end] == [name for name, _ in features.STEPS]
    assert build.BUILD.names()[start + 1:end] == names[start + 1:end]


def test_the_world_is_complete_and_checks(built):
    m = built["manifest"]
    assert manifest.check_world(built["folder"]) == []
    assert {"buildings", "trees", "places", "plot", "listing", "notice"} <= set(m["files"])
    assert all(level["class_band"] for level in m["levels"])
    names = {s["name"].split(" (")[0] for s in m["sources"]}
    for expected in ("N50 Kartdata", "NVDB Vegnett Pluss", "Turrutebasen",
                     "Matrikkelen bygningspunkt", "Stedsnavn API", "Kommuneinfo API"):
        assert any(n.startswith(expected) for n in names), expected
    assert any("surface model" in s["name"] for s in m["sources"])
    assert CREDIT_SSR in m["credits"] and CREDIT_KARTVERKET_MAP in m["credits"]
    hosts = {r["host"] for r in m["robots"]}
    assert {"api.kartverket.no", "hoydedata.no", "wfs.geonorge.no",
            "nedlasting.geonorge.no"} <= hosts
    assert all(r["policy"] == "allow-all" for r in m["robots"])


def test_what_the_map_steps_used(built):
    stats = built["manifest"]["stats"]["map"]
    assert stats["inputs"]["kommuner"] == ["9999"]
    assert stats["kommuner"]["outline_requests"] == 1 and stats["kommuner"]["point_lookups"] == 1
    assert stats["n50"]["unknown_area_types"] == {UNKNOWN_TYPE: 1}
    # Seven NVDB lines, less the E road, which lies beyond this small world's h20 grid.
    assert stats["roads"]["n50_fallback"] == [] and stats["roads"]["lines"] == 6
    kinds = stats["inputs"]["lines_by_source_and_kind"]
    assert kinds["nvdb:road"] == 5 and kinds["nvdb:footway"] == 1
    assert kinds["n50:path"] == 1 and kinds["turrutebasen:path"] == 1
    assert "n50:road" not in kinds                  # N50 roads only as a fallback
    assert stats["buildings"]["house"]["house"] is True
    # The synthetic forest lies beyond this small world's 300 m h1 radius: a valid, empty file.
    assert stats["trees"]["trees"] == trees.decode(
        (built["folder"] / "trees.bin.gz").read_bytes())["count"] == 0
    # Four of the named hills lie within this small world's 5 km h20 radius.
    assert stats["places"]["kept"] == 4 and stats["places"]["places"] == 4


def test_classes_and_house_match_the_synthetic_shapes(built):
    folder, m = built["folder"], built["manifest"]
    oe, on = ORIGIN

    def class_at(level_name, x, n):
        level = next(l for l in LEVELS if l.name == level_name)
        record = next(r for r in m["levels"] if r["name"] == level_name)
        i, j = int((oe + x) // level.side), int((on + n) // level.side)
        chunk = codec.decode((folder / record["chunks"][grid.chunk_key(i, j)]["file"]).read_bytes())
        east, north = grid.sample_centres(level, i, j)
        return int(chunk["classes"][int(np.argmin(np.abs(north - (on + n)))),
                                    int(np.argmin(np.abs(east - (oe + x))))])
    assert class_at("h1", 110, 200) == classes.ROAD        # NVDB, reprojected and back
    assert class_at("h1", 122, 200) == classes.FOOTWAY
    assert class_at("h1", -100, 100) == classes.BUILT_UP
    assert class_at("h1", 5, -8) == classes.BUILDING
    assert class_at("h5", 900, -800) == classes.LAKE
    assert class_at("h5", 520, 650) == classes.FOREST
    assert class_at("h5", 550, 800) == classes.FOREST      # paths are h1 only
    data = json.loads(gzip.decompress((folder / "buildings.json.gz").read_bytes()))
    assert sum(f["house"] for f in data["features"]) == 1


def test_an_offline_rebuild_is_identical(built):
    silent = FakeTransport()
    again = run(built["listing"], built["tmp"] / "again", built["tmp"] / "cache", silent,
                offline=True)
    assert silent.calls == []
    first = built["folder"]
    for path in first.rglob("*"):
        if path.is_file() and path.name != "manifest.json":
            assert (again / path.relative_to(first)).read_bytes() == path.read_bytes(), path


def test_nvdb_that_cannot_be_read_falls_back_to_n50_roads(tmp_path, listing_file):
    transport = fake_everything(nvdb_formats=("SOSI",))
    folder = run(listing_file, tmp_path / "w", tmp_path / "cache", transport)
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    fallback = m["stats"]["map"]["roads"]["n50_fallback"]
    assert [f["kommune"] for f in fallback] == ["9999"] and fallback[0]["n50_lines"] == 6
    assert any("N50 Samferdsel instead" in w for w in m["stats"]["warnings"])
    kinds = m["stats"]["map"]["inputs"]["lines_by_source_and_kind"]
    assert kinds["n50:road"] == 5 and kinds["n50:footway"] == 1 and "nvdb:road" not in kinds
    assert not any(s["name"].startswith("NVDB") for s in m["sources"])
    assert manifest.check_world(folder) == []
    assert n50.N50_ROAD_KINDS["enkelBilveg"] == "road"
