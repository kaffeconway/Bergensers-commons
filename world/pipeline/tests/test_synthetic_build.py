"""End to end: the synthetic world, built once through the CLI, then taken apart.

The synthetic build uses the same writers as a real one (plot, terrain,
listing, manifest), so these tests cover the file formats a viewer reads.
"""

import gzip
import json

import numpy as np
import pytest

from commons_world import build, buildings, classes, codec, grid, listing, manifest, synthetic, trees
from commons_world.__main__ import main
from commons_world.grid import LEVELS, Level


@pytest.fixture(scope="session")
def world(synthetic_world):
    return synthetic_world


@pytest.fixture(scope="session")
def world_manifest(world):
    return json.loads((world / "manifest.json").read_text(encoding="ascii"))


def test_world_passes_its_own_check(world):
    assert manifest.check_world(world) == []
    assert main(["check", str(world)]) == 0


def test_manifest_shape(world_manifest):
    m = world_manifest
    assert m["format"] == "commons-world" and m["version"] == 1 and m["id"] == "zz-synthetic"
    assert m["generated_at"] == synthetic.GENERATED_AT
    oe, on = synthetic.origin()
    assert (m["crs"]["origin_e"], m["crs"]["origin_n"], m["crs"]["epsg"]) == (oe, on, 25832)
    assert m["crs"]["grid_north_offset_deg"] == pytest.approx(4.333, abs=0.001)  # 4 E is west of 9 E
    assert [level["name"] for level in m["levels"]] == ["h1", "h5", "h20"]
    assert set(m["files"]) == {"plot", "listing", "notice", "buildings", "trees", "places",
                               "facts"}
    assert m["files"]["buildings"]["file"] == "buildings.json.gz"
    assert m["files"]["trees"]["file"] == "trees.bin.gz"
    assert m["files"]["places"]["file"] == "places.json"
    assert m["robots"] == []
    assert m["credits"] == [synthetic.SYNTHETIC_CREDIT]


def test_every_chunk_decodes_to_the_height_function(world, world_manifest):
    oe, on = synthetic.origin()
    decoded_chunks = 0
    for level_record in world_manifest["levels"]:
        level = grid.LEVELS_BY_NAME[level_record["name"]]
        assert level_record["class_band"] is True
        for key, entry in level_record["chunks"].items():
            i, j = (int(v) for v in key.split("_"))
            data = (world / entry["file"]).read_bytes()
            chunk = codec.decode(data)
            assert entry["file"] == "{}/{}_{}.{}.cwh.gz".format(
                level.name, i, j, codec.hash8(gzip.decompress(data)))
            assert (chunk["width"], chunk["height"], chunk["epsg"]) == (242, 242, 25832)
            assert chunk["corner_e"] == i * level.side - level.cell
            assert chunk["corner_n"] == (j + 1) * level.side + level.cell
            assert chunk["cell_cm"] == level.cell_cm
            east, north = grid.sample_centres(level, i, j)
            x, n = east[None, :] - oe, north[:, None] - on
            truth = synthetic.height_local(x, n)
            assert np.array_equal(chunk["heights_dm"], np.floor(truth * 10.0 + 0.5).astype(np.int64))
            assert np.max(np.abs(chunk["heights_dm"] / 10.0 - truth)) <= 0.05 + 1e-9
            codes = set(np.unique(chunk["classes"]).tolist())
            assert codes <= set(classes.CODES)
            if level.name != "h1":
                assert not codes & {classes.FOOTWAY, classes.PATH, classes.BUILDING}
            assert entry["min"] == chunk["heights_dm"].min() / 10.0
            assert entry["max"] == chunk["heights_dm"].max() / 10.0
            decoded_chunks += 1
    assert decoded_chunks == sum(len(l["chunks"]) for l in world_manifest["levels"])


def test_every_chunk_in_the_disk_is_a_file_or_sea(world_manifest):
    oe, on = synthetic.origin()
    for level_record in world_manifest["levels"]:
        level = grid.LEVELS_BY_NAME[level_record["name"]]
        expected = {grid.chunk_key(i, j) for i, j in grid.chunks_for_disk(level, oe, on)}
        files, sea = set(level_record["chunks"]), set(level_record["sea"])
        assert files | sea == expected and not files & sea
        assert sea, "the synthetic place should have all-sea chunks at {}".format(level.name)
        for key in sea:
            i, j = (int(v) for v in key.split("_"))
            east, north = grid.sample_centres(level, i, j)
            heights = synthetic.height_local(east[None, :] - oe, north[:, None] - on)
            assert np.floor(heights * 10 + 0.5).max() <= 0


def test_lake_and_sea_classes_present(world, world_manifest):
    seen = set()
    for entry in world_manifest["levels"][0]["chunks"].values():
        seen |= set(np.unique(codec.decode((world / entry["file"]).read_bytes())["classes"]))
    assert {classes.LAKE, classes.SEA, classes.FOREST} <= seen
    assert set(range(10)) | {12, 13} <= seen          # everything the synthetic place has at h1


def class_at(world, world_manifest, level_name, x, n):
    """The class band's value at local (x east, n north) on one level."""
    oe, on = synthetic.origin()
    level = grid.LEVELS_BY_NAME[level_name]
    record = next(r for r in world_manifest["levels"] if r["name"] == level_name)
    e, north = oe + x, on + n
    i, j = int(e // level.side), int(north // level.side)
    key = grid.chunk_key(i, j)
    if key in record["sea"]:
        return classes.SEA
    chunk = codec.decode((world / record["chunks"][key]["file"]).read_bytes())
    east, norths = grid.sample_centres(level, i, j)
    q = int(np.argmin(np.abs(east - e)))
    r = int(np.argmin(np.abs(norths - north)))
    return int(chunk["classes"][r, q])


# (level, local x, local n, expected class) at points chosen well inside each feature.
CLASS_POINTS = [
    ("h1", 520, 650, classes.FOREST),
    ("h1", -335, -700, classes.FARMLAND),
    ("h1", 750, -250, classes.BOG),
    ("h1", 900, -800, classes.LAKE),
    ("h1", -1300, 0, classes.SEA),
    ("h1", -100, 100, classes.BUILT_UP),
    ("h1", 1300, 200, classes.GRAVEL),
    ("h1", 110, 500, classes.ROAD),
    ("h1", 122, 500, classes.FOOTWAY),
    ("h1", 550, 800, classes.PATH),
    ("h1", 1325, -850, classes.LAKE),          # the stream, drawn as a 2 m river
    ("h1", 5, -8, classes.BUILDING),           # the house
    ("h1", 900, -1120, classes.ROAD),          # the bridge where it is on land
    ("h1", 1100, 400, classes.OPEN),           # the tunnel is not drawn
    ("h1", -680, 0, classes.OPEN),             # N50-style sea polygon over dry land
    ("h5", 110, 500, classes.ROAD),
    ("h5", 1000, -380, classes.ROAD),
    ("h5", 900, -800, classes.LAKE),           # the bridge is not drawn over the lake
    ("h5", 2600, 1800, classes.ROCK),
    ("h5", 5, -8, classes.BUILT_UP),           # no footprints below h1
    ("h20", 5000, -1400, classes.ROAD),        # a county road (F)
    ("h20", 4000, 6000, classes.ROAD),         # a European road (E)
    ("h20", 110, 500, classes.OPEN),           # municipal roads are not drawn at h20
]


@pytest.mark.parametrize("level,x,n,expected", CLASS_POINTS)
def test_class_band_at_known_points(world, world_manifest, level, x, n, expected):
    assert class_at(world, world_manifest, level, x, n) == expected


def test_buildings_file(world, world_manifest):
    data = json.loads(gzip.decompress((world / "buildings.json.gz").read_bytes()))
    features = data["features"]
    assert data["version"] == 1 and len(features) >= 6
    assert [f["id"] for f in features] == list(range(1, len(features) + 1))
    registered_with_roof = [b for b in synthetic.BUILDINGS if b[8] and b[9]]
    assert len(features) == len(registered_with_roof)
    houses = [f for f in features if f["house"]]
    assert len(houses) == 1 and houses[0]["type"] == 111
    parcel = synthetic.parcel_polygon((0, 0))
    from shapely.geometry import Polygon
    house = Polygon([(x, -z) for x, z in houses[0]["ring"]])
    assert parcel.contains(house.centroid)
    for f in features:
        assert buildings.ring_signed_area_local(f["ring"]) > 0
        assert f["source"] == "dom" and f["roof"] > f["ground"] + 2.5
    stats = world_manifest["stats"]["map"]["buildings"]
    assert stats["register_points_without_roof"] == 1        # the demolished one
    assert stats["house"]["house"] is True and stats["house"]["id"] == houses[0]["id"]


def test_trees_file(world):
    t = trees.decode((world / "trees.bin.gz").read_bytes())
    assert 280 <= t["count"] <= synthetic.TREE_TARGET
    keys = list(zip(t["records"]["z"].tolist(), t["records"]["x"].tolist()))
    assert keys == sorted(keys)
    assert np.all(np.hypot(t["x"], t["z"]) <= 1500)
    assert t["height"].min() >= synthetic.TREE_HEIGHT_M[0] - 1.0
    assert t["height"].max() <= synthetic.TREE_HEIGHT_M[1] + 1.5
    footprints = [synthetic.building_footprint(b) for b in synthetic.BUILDINGS]
    from shapely.geometry import Point
    for x, z in zip(t["x"], t["z"]):
        assert not any(fp.contains(Point(x, -z)) for fp in footprints)


def test_places_file(world, world_manifest):
    data = json.loads((world / "places.json").read_text(encoding="ascii"))
    names = [f["name"] for f in data["features"]]
    assert sorted(names) == sorted(n for n, kind, x, y in synthetic.PLACE_NAMES
                                   if kind != "Vik i sj\u00f8" and x < 15000)
    assert [f["h"] for f in data["features"]] == sorted((f["h"] for f in data["features"]),
                                                        reverse=True)
    for f in data["features"]:
        spec = next(p for p in synthetic.PLACE_NAMES if p[0] == f["name"])
        assert f["type"] == spec[1]
        assert np.hypot(f["x"] - spec[2], -f["z"] - spec[3]) <= 30.0 + 1e-6
        truth = synthetic.height_local(f["x"], -f["z"])
        assert abs(f["h"] - truth) <= 0.1
    stats = world_manifest["stats"]["map"]["places"]
    assert stats["spot_height_check"]["compared"] >= 5


def test_all_json_is_ascii_and_the_listing_validates(world):
    for path in world.rglob("*.json"):
        path.read_bytes().decode("ascii")
    (world / "NOTICE.txt").read_bytes().decode("ascii")
    record = json.loads((world / "listing.json").read_text(encoding="ascii"))
    listing.check_listing(record)
    assert record["id"] == "zz-synthetic"
    assert record["geocode"]["lat"] == 60.0 and record["geocode"]["lon"] == 4.0


def test_plot(world):
    plot = json.loads((world / "plot.json").read_text(encoding="ascii"))
    assert plot["version"] == 1 and len(plot["parcels"]) == 1
    parcel = plot["parcels"][0]
    assert parcel["area_polygon_m2"] == pytest.approx(3600.0, abs=0.1)
    assert parcel["area_register_m2"] == pytest.approx(3600.0, abs=0.1)
    assert len(parcel["ring"]) == 4 and parcel["holes"] == []
    assert plot["stated_plot_m2"] == synthetic.STATED_PLOT_M2
    assert plot["note"].endswith("The listing states a larger plot.")
    # The parcel sits on a slope near the origin.
    xs = [p[0] for p in parcel["ring"]]
    zs = [p[1] for p in parcel["ring"]]
    assert max(map(abs, xs + zs)) < 70  # 90 x 40 m, turned 25 degrees, centred 18 m out
    heights = [synthetic.height_local(x, -z) for x, z in parcel["ring"]]
    assert max(heights) - min(heights) > 5.0


def test_notice(world):
    text = (world / "NOTICE.txt").read_text(encoding="ascii")
    assert "synthetic world" in text and "zz-synthetic" in text


SMALL_LEVELS = (Level("h1", 1, 300, 240, 1, grid.NEAREST),
                Level("h5", 5, 1500, 240, 1, grid.BILINEAR),
                Level("h20", 20, 5000, 240, 1, grid.BILINEAR))


def all_bytes(folder):
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def test_two_builds_are_byte_identical(tmp_path):
    a = synthetic.build_synthetic(tmp_path / "a", levels=SMALL_LEVELS, commit="test")
    b = synthetic.build_synthetic(tmp_path / "b", levels=SMALL_LEVELS, commit="test")
    assert all_bytes(a) == all_bytes(b)


def test_rebuild_replaces_the_previous_world(tmp_path):
    out = tmp_path / "w"
    synthetic.build_synthetic(out, levels=SMALL_LEVELS[:1])
    first = set(all_bytes(out))
    synthetic.build_synthetic(out, levels=SMALL_LEVELS[1:])
    second = set(all_bytes(out))
    assert not any(name.startswith("h1/") for name in second)
    assert first != second
    assert not list(tmp_path.glob(".*partial*"))


def test_refuses_to_replace_a_folder_that_is_not_a_world(tmp_path):
    out = tmp_path / "precious"
    out.mkdir()
    (out / "keep.txt").write_text("mine")
    with pytest.raises(build.BuildError, match="not a Commons World folder"):
        synthetic.build_synthetic(out, levels=SMALL_LEVELS[:1])
    assert (out / "keep.txt").read_text() == "mine"
    assert not list(tmp_path.glob(".*partial*"))


def test_failed_build_leaves_nothing_behind(tmp_path):
    pipeline = synthetic.core_synthetic_pipeline()

    def explode(ctx):
        raise RuntimeError("boom")
    pipeline.register("explode", explode, after="terrain")
    with pytest.raises(RuntimeError, match="boom"):
        synthetic.build_synthetic(tmp_path / "w", levels=SMALL_LEVELS[:1], pipeline=pipeline)
    assert list(tmp_path.iterdir()) == []


def test_registered_step_output_lands_in_the_manifest(tmp_path):
    pipeline = synthetic.core_synthetic_pipeline()
    order = []

    def extra(ctx):
        order.append(("extra", sorted(ctx.chunks)))
        ctx.write_json("extra", "extra.json", {"version": 1, "features": []})
        ctx.add_credit("Test credit \u00e5")
    pipeline.register("extra", extra, after="terrain")
    assert pipeline.names() == ["synthetic", "plot", "terrain_fetch", "synthetic_map", "classes",
                                "buildings", "trees", "places", "map_stats", "terrain", "extra",
                                "listing", "manifest"]
    folder = synthetic.build_synthetic(tmp_path / "w", levels=SMALL_LEVELS[:1], pipeline=pipeline)
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    assert m["files"]["extra"]["file"] == "extra.json"
    assert "Test credit \u00e5" in m["credits"]
    assert "Test credit aa" in (folder / "NOTICE.txt").read_text(encoding="ascii")
    assert order == [("extra", ["h1"])]
    assert manifest.check_world(folder) == []


def test_pipeline_registration_rules():
    pipeline = build.core_build_pipeline()
    pipeline.register("late", lambda ctx: None)
    assert pipeline.names()[-2:] == ["late", "manifest"]
    pipeline.register("early", lambda ctx: None, before="geocode")
    assert pipeline.names()[:3] == ["load_listing", "early", "geocode"]
    with pytest.raises(ValueError):
        pipeline.register("late", lambda ctx: None)
    with pytest.raises(ValueError):
        pipeline.register("after_manifest", lambda ctx: None, after="manifest")
    with pytest.raises(ValueError):
        pipeline.register("nowhere", lambda ctx: None, after="no-such-step")
    replacement = lambda ctx: None  # noqa: E731
    pipeline.register("late", replacement, replace=True)
    assert pipeline.steps[pipeline.names().index("late")].fn is replacement
    # The shared pipelines are untouched by work on copies.
    assert "late" not in build.BUILD.names()


def test_register_step_on_the_shared_pipelines():
    before = list(synthetic.SYNTHETIC.steps)
    try:
        build.register_step("probe", lambda ctx: None, pipeline="synthetic")
        assert synthetic.SYNTHETIC.names()[-2:] == ["probe", "manifest"]
    finally:
        synthetic.SYNTHETIC.steps[:] = before
    with pytest.raises(ValueError):
        build.register_step("probe", lambda ctx: None, pipeline="no-such-pipeline")


def test_write_bytes_stays_inside_the_world(tmp_path):
    ctx = build.BuildContext(work_dir=tmp_path)
    with pytest.raises(build.BuildError):
        ctx.write_bytes("../escape.txt", b"x")
    with pytest.raises(build.BuildError):
        ctx.write_bytes("/abs.txt", b"x")
    ctx.write_file("a", "a.txt", b"x")
    with pytest.raises(build.BuildError):
        ctx.write_file("a", "b.txt", b"y")
