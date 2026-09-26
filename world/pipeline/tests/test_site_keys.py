"""The site keys the viewer's sun needs: crs.lat_deg, crs.lon_deg and crs.time_zone.

The synthetic world is invented (commons_world/synthetic.py, 60 N 4 E); nothing here is
real data. Every key is additive: a world without them, or without the far-gate horizon
in its facts, still passes its check.
"""

import json
import shutil

import pytest

from commons_world import build, geo, manifest


def read(folder, name):
    return json.loads((folder / name).read_text(encoding="ascii"))


def write_manifest(folder, data):
    (folder / manifest.MANIFEST_NAME).write_bytes(manifest.dumps_json(data))


@pytest.fixture
def world_copy(synthetic_world, tmp_path):
    folder = tmp_path / "world"
    shutil.copytree(synthetic_world, folder)
    return folder


def test_the_synthetic_crs_has_its_latitude_longitude_and_zone(synthetic_world):
    crs = read(synthetic_world, "manifest.json")["crs"]
    lat, lon = geo.to_latlon(float(crs["origin_e"]), float(crs["origin_n"]), crs["epsg"])
    assert crs["lat_deg"] == pytest.approx(lat, abs=1e-4)
    assert crs["lon_deg"] == pytest.approx(lon, abs=1e-4)
    assert crs["lat_deg"] == pytest.approx(60.0, abs=1e-4)
    assert crs["lon_deg"] == pytest.approx(4.0, abs=1e-4)
    assert crs["time_zone"] == "Europe/Oslo"
    for key in ("lat_deg", "lon_deg"):
        assert round(crs[key], 6) == crs[key]


def test_the_zone_follows_the_country():
    assert build.site_time_zone("NO", 60.0) == "Europe/Oslo"
    assert build.site_time_zone("FR", 45.0) == "Europe/Paris"
    assert build.site_time_zone("IT", 45.0) == "Europe/Rome"
    assert build.site_time_zone("ES", 40.0) == "Europe/Madrid"
    assert build.site_time_zone("ES", 28.0) == "Atlantic/Canary"
    assert build.site_time_zone(None, 60.0) is None
    assert build.site_time_zone("SE", 60.0) is None
    assert sorted(build.ALLOWED_TIME_ZONES) == sorted(
        ["Europe/Oslo", "Europe/Paris", "Europe/Rome", "Europe/Madrid", "Atlantic/Canary"])


def test_a_listing_without_a_country_writes_no_zone():
    class Ctx:
        epsg = 25832
        vertical = "NN2000"
        listing = {}

    ctx = Ctx()
    e, n = geo.to_grid(60.0, 4.0, 25832)
    build.set_origin(ctx, e, n)
    assert "time_zone" not in ctx.crs
    assert ctx.crs["lat_deg"] == pytest.approx(60.0, abs=1e-4)
    ctx.listing = {"country": "NO"}
    build.set_origin(ctx, e, n)
    assert ctx.crs["time_zone"] == "Europe/Oslo"


def test_check_world_rejects_a_wrong_latitude(world_copy):
    data = read(world_copy, "manifest.json")
    data["crs"]["lat_deg"] = round(data["crs"]["lat_deg"] + 0.01, 6)
    write_manifest(world_copy, data)
    problems = manifest.check_world(world_copy)
    assert len(problems) == 1 and "not the origin's" in problems[0]


def test_check_world_rejects_half_a_position(world_copy):
    data = read(world_copy, "manifest.json")
    del data["crs"]["lon_deg"]
    write_manifest(world_copy, data)
    problems = manifest.check_world(world_copy)
    assert len(problems) == 1 and "must both be present" in problems[0]


def test_check_world_rejects_a_zone_outside_the_list(world_copy):
    data = read(world_copy, "manifest.json")
    data["crs"]["time_zone"] = "Europe/Stockholm"
    write_manifest(world_copy, data)
    problems = manifest.check_world(world_copy)
    assert len(problems) == 1 and "crs.time_zone 'Europe/Stockholm'" in problems[0]


def test_a_world_without_the_site_keys_passes(world_copy):
    data = read(world_copy, "manifest.json")
    for key in ("lat_deg", "lon_deg", "time_zone"):
        del data["crs"][key]
    write_manifest(world_copy, data)
    assert manifest.check_world(world_copy) == []


def replace_facts(folder, edit):
    """Rewrite facts.json through `edit`, and its manifest entry with it."""
    facts = read(folder, "facts.json")
    edit(facts)
    data = manifest.dumps_json(facts)
    (folder / "facts.json").write_bytes(data)
    record = read(folder, "manifest.json")
    record["files"]["facts"] = {"file": "facts.json", "bytes": len(data),
                                "sha256": manifest.sha256_hex(data)}
    write_manifest(folder, record)


def test_facts_without_the_far_horizon_pass(world_copy):
    replace_facts(world_copy, lambda f: f["sun"]["horizon"].pop("beyond_world"))
    assert "beyond_world" not in read(world_copy, "facts.json")["sun"]["horizon"]
    assert manifest.check_world(world_copy) == []


@pytest.mark.parametrize("key", ["from_m", "profile_deg", "distance_m"])
def test_a_short_far_horizon_is_rejected(world_copy, key):
    def edit(facts):
        facts["sun"]["horizon"]["beyond_world"][key] = \
            facts["sun"]["horizon"]["beyond_world"][key][:719]
    replace_facts(world_copy, edit)
    problems = manifest.check_world(world_copy)
    assert problems == ["files.facts: sun.horizon.beyond_world.{} must hold 720 values"
                        .format(key)]
