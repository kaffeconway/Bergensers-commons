"""The observed input (commons_world.observed): the house's roof colour and its credit.

Joseph's answer P3. The colour comes from a per-world private file; the committed
fixture's colour, source and credit are made up. The build is the real one, against
the fake Kartverket services of test_features_build.py; nothing touches the network.
"""

import gzip
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from commons_world import build, manifest, observed, synthetic
from commons_world.__main__ import main

from conftest import FakeTransport
from test_features_build import LEVELS, fake_everything, run

FIXTURE = Path(__file__).parent / "fixtures" / "observed-synthetic.json"
GOOD = {"version": 1, "house_roof_colour": "#A1B2C3", "source": "made up",
        "credit": "Roof colour: made up"}


def buildings_of(folder):
    return json.loads(gzip.decompress((folder / "buildings.json.gz").read_bytes()))


def manifest_of(folder):
    return json.loads((folder / "manifest.json").read_text(encoding="ascii"))


@pytest.fixture(scope="module")
def worlds(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("observed")
    listing = tmp / "listing.json"
    listing.write_text(json.dumps(synthetic.synthetic_listing()), encoding="utf-8")
    plain = run(listing, tmp / "plain", tmp / "cache", fake_everything())
    silent = FakeTransport()
    seen = run(listing, tmp / "seen", tmp / "cache", silent, offline=True, observed=FIXTURE)
    assert silent.calls == []
    return SimpleNamespace(plain=plain, seen=seen, tmp=tmp, listing=listing,
                           fixture=json.loads(FIXTURE.read_text(encoding="utf-8")))


def test_the_committed_fixture_is_made_up():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert "made up" in fixture["source"].lower() and "made up" in fixture["credit"].lower()
    assert observed.load_observed(FIXTURE)["house_roof_colour"] == \
        fixture["house_roof_colour"].lower()


def test_the_house_carries_the_observed_roof_colour_and_the_credit_is_given(worlds):
    fixture = worlds.fixture
    features = buildings_of(worlds.seen)["features"]
    (house,) = [f for f in features if f["house"]]
    assert house["roof_colour"] == fixture["house_roof_colour"].lower()
    assert house["roof_colour_source"] == fixture["source"]
    assert not any("roof_colour" in f or "roof_colour_source" in f
                   for f in features if not f["house"])
    m = manifest_of(worlds.seen)
    assert m["credits"].count(fixture["credit"]) == 1
    notice = (worlds.seen / "NOTICE.txt").read_text(encoding="ascii")
    assert manifest.ascii_fold(fixture["credit"]) in notice
    assert m["stats"]["map"]["buildings"]["observed_roof_colour"] is True
    assert m["stats"]["map"]["buildings"]["observed_credit"] == fixture["credit"]
    assert manifest.check_world(worlds.seen) == []


def test_nothing_else_changes_and_without_the_input_nothing_does(worlds):
    fixture = worlds.fixture
    plain, seen = buildings_of(worlds.plain), buildings_of(worlds.seen)
    for f in seen["features"]:
        f.pop("roof_colour", None)
        f.pop("roof_colour_source", None)
    assert seen == plain
    assert not any("roof_colour" in f for f in plain["features"])
    m = manifest_of(worlds.plain)
    assert fixture["credit"] not in m["credits"]
    assert "observed_roof_colour" not in m["stats"]["map"]["buildings"]
    assert "observed_credit" not in m["stats"]["map"]["buildings"]
    assert manifest.ascii_fold(fixture["credit"]) not in \
        (worlds.plain / "NOTICE.txt").read_text(encoding="ascii")
    assert manifest_of(worlds.seen)["credits"] == m["credits"] + [fixture["credit"]]
    for path in worlds.plain.rglob("*"):
        if path.is_file() and path.name not in ("manifest.json", "NOTICE.txt",
                                                "buildings.json.gz"):
            assert (worlds.seen / path.relative_to(worlds.plain)).read_bytes() == \
                path.read_bytes(), path


def broken(**change):
    obj = dict(GOOD)
    for key, value in change.items():
        if value is KeyError:
            del obj[key]
        else:
            obj[key] = value
    return obj


@pytest.mark.parametrize("obj,message", [
    (broken(house_roof_colour=KeyError), "missing house_roof_colour"),
    (broken(credit=KeyError), "missing credit"),
    (broken(extra="x"), "unknown key"),
    (broken(version=2), "version 2"),
    (broken(version=True), "version True"),
    (broken(version="1"), "version '1'"),
    (broken(house_roof_colour="grey"), "not a colour"),
    (broken(house_roof_colour="#abc"), "not a colour"),
    (broken(house_roof_colour="#12345g"), "not a colour"),
    (broken(house_roof_colour=" #a1b2c3"), "not a colour"),
    (broken(house_roof_colour=0xa1b2c3), "not a colour"),
    (broken(source=""), "source must be non-empty"),
    (broken(source="   "), "source must be non-empty"),
    (broken(source=None), "source must be non-empty"),
    (broken(credit="two\nlines"), "control character"),
    (broken(credit=" padded"), "starts or ends with a space"),
    (broken(credit="x" * 301), "longer than"),
    ([GOOD], "JSON object"),
], ids=lambda v: v if isinstance(v, str) else None)
def test_a_malformed_input_is_refused(obj, message):
    with pytest.raises(observed.ObservedInvalid, match=message):
        observed.validate(obj)


@pytest.mark.parametrize("text,message", [
    ('{"version": 1, "version": 1, "house_roof_colour": "#a1b2c3", "source": "s", '
     '"credit": "c"}', "repeats the key"),
    ("{not json", "not UTF-8 JSON"),
    (b"\xff\xfe{}", "not UTF-8 JSON"),
    (" " * (observed.MAX_BYTES + 1), "larger than"),
])
def test_a_file_that_is_not_one_object_of_json_is_refused(tmp_path, text, message):
    path = tmp_path / "observed.json"
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text, encoding="utf-8")
    with pytest.raises(observed.ObservedInvalid, match=message):
        observed.load_observed(path)
    with pytest.raises(observed.ObservedInvalid):
        observed.load_observed(tmp_path / "missing.json")


def test_a_bad_input_stops_the_build_before_anything_is_fetched_or_written(tmp_path, worlds,
                                                                          capsys):
    bad = tmp_path / "observed.json"
    bad.write_text(json.dumps(broken(house_roof_colour="light grey")), encoding="utf-8")
    silent = FakeTransport()
    with pytest.raises(observed.ObservedInvalid, match="not a colour"):
        run(worlds.listing, tmp_path / "w", tmp_path / "cache", silent, observed=bad)
    assert silent.calls == []
    assert list(tmp_path.iterdir()) == [bad]
    code = main(["build", "--listing", str(worlds.listing), "--out", str(tmp_path / "w"),
                 "--cache", str(tmp_path / "cache"), "--offline", "--observed", str(bad)])
    assert code == 2
    assert "not a colour" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == [bad]


def test_with_no_house_the_colour_is_not_used_and_the_build_says_so():
    ctx = SimpleNamespace(observed=observed.validate(GOOD), warnings=[], credits=[],
                          add_credit=lambda text: ctx.credits.append(text))
    record = {"features": [{"id": 1, "house": False}]}
    stats = {}
    observed.apply(ctx, record, stats)
    assert record == {"features": [{"id": 1, "house": False}]}
    assert ctx.credits == [] and stats == {"observed_roof_colour": False}
    assert "not used" in ctx.warnings[0]
    nothing = SimpleNamespace(observed=None)
    observed.apply(nothing, record, stats)
    assert stats == {"observed_roof_colour": False}


def test_when_the_buildings_step_skips_the_colour_is_not_used_and_the_build_says_so():
    """No h1 level or no surface model: the step skips, and a given observed input is
    recorded as not used, with a warning and no credit (FORMAT.md)."""
    from commons_world import mapsteps
    for observed_input in (observed.validate(GOOD), None):
        ctx = SimpleNamespace(observed=observed_input, warnings=[], credits=[], levels=[],
                              chunks={}, map=None, add_credit=lambda text: ctx.credits.append(text))
        mapsteps.step_buildings(ctx)
        stats = ctx.map.stats["buildings"]
        assert stats["skipped"] == "no h1 level or no surface model"
        assert ctx.credits == []
        if observed_input is None:
            assert "observed_roof_colour" not in stats and ctx.warnings == []
        else:
            assert stats["observed_roof_colour"] is False
            assert len(ctx.warnings) == 1 and "not used" in ctx.warnings[0]
            assert "skipped" in ctx.warnings[0]


def test_a_build_without_a_surface_model_records_the_input_as_not_used(worlds, tmp_path):
    """The same end to end: the surface model step does nothing, so the buildings step
    skips; the finished world says the input was not used and passes its check."""
    from commons_world import features
    pipeline = features.install(build.core_build_pipeline())
    pipeline.register("surface", lambda ctx: None, replace=True)
    folder = build.build(worlds.listing, tmp_path / "w", cache_dir=worlds.tmp / "cache",
                         transport=FakeTransport(), offline=True, levels=LEVELS,
                         commit="test", generated_at="2026-01-01T00:00:00Z", min_interval=0.0,
                         pipeline=pipeline, observed=FIXTURE)
    m = manifest_of(folder)
    stats = m["stats"]["map"]["buildings"]
    assert "skipped" in stats and stats["observed_roof_colour"] is False
    assert any("observed house roof colour was not used" in w for w in m["stats"]["warnings"])
    assert worlds.fixture["credit"] not in m["credits"]
    assert manifest.check_world(folder) == []


def test_a_build_that_cannot_use_the_input_refuses_it_before_anything_happens(worlds, tmp_path):
    """A pipeline with no buildings step (build --no-plugins) cannot use an observed
    input; it is refused up front rather than validated and silently ignored."""
    silent = FakeTransport()
    with pytest.raises(observed.ObservedInvalid, match="buildings step"):
        build.build(worlds.listing, tmp_path / "w", cache_dir=tmp_path / "cache",
                    transport=silent, offline=True, pipeline=build.core_build_pipeline(),
                    observed=FIXTURE)
    assert silent.calls == []
    assert list(tmp_path.iterdir()) == []


def rewrite(folder, edit):
    """Edit buildings.json.gz in place and put its new size and hash into the manifest."""
    path = folder / "buildings.json.gz"
    doc = json.loads(gzip.decompress(path.read_bytes()))
    edit(doc["features"])
    data = gzip.compress(json.dumps(doc).encode("ascii"))
    path.write_bytes(data)
    m = manifest_of(folder)
    m["files"]["buildings"].update(bytes=len(data), sha256=manifest.sha256_hex(data))
    (folder / "manifest.json").write_text(json.dumps(m), encoding="ascii")


@pytest.mark.parametrize("edit,message", [
    (lambda fs: next(f for f in fs if not f["house"]).update(roof_colour="#a1b2c3",
                                                              roof_colour_source="x"),
     "only the listing house"),
    (lambda fs: next(f for f in fs if f["house"]).update(roof_colour="#A1B2C3"),
     "lower case"),
    (lambda fs: next(f for f in fs if f["house"]).pop("roof_colour_source"), "together"),
    (lambda fs: next(f for f in fs if f["house"]).update(roof_colour_source=""), "non-empty"),
    (lambda fs: fs[1].update(id=fs[0]["id"]), "each once"),
    (lambda fs: fs.reverse(), "in order"),
], ids=["not the house", "upper case", "no source", "empty source", "repeated id",
        "out of order"])
def test_check_world_refuses_a_malformed_observed_colour_or_ids(worlds, tmp_path, edit, message):
    import shutil

    folder = tmp_path / "copy"
    shutil.copytree(worlds.seen, folder)
    rewrite(folder, edit)
    problems = manifest.check_world(folder)
    assert any(message in p for p in problems), problems


def test_ids_may_skip_a_dropped_building(worlds, tmp_path):
    import shutil

    folder = tmp_path / "copy"
    shutil.copytree(worlds.seen, folder)
    rewrite(folder, lambda fs: fs.pop(0))
    assert manifest.check_world(folder) == []
    assert build.BuildContext(work_dir=tmp_path).observed is None


def edit_manifest(folder, edit):
    m = manifest_of(folder)
    edit(m)
    (folder / "manifest.json").write_text(json.dumps(m), encoding="ascii")


@pytest.mark.parametrize("world,edit_buildings,edit,messages", [
    ("seen", None, lambda m: m["credits"].remove(m["stats"]["map"]["buildings"]["observed_credit"]),
     ["not among the credits"]),
    ("seen", None, lambda m: m["stats"]["map"]["buildings"].update(observed_credit="made up too"),
     ["not among the credits"]),
    ("seen", None, lambda m: m["stats"]["map"]["buildings"].pop("observed_credit"),
     ["not among the credits"]),
    ("seen", None, lambda m: m["stats"]["map"]["buildings"].update(observed_roof_colour=False),
     ["observed_roof_colour is not true"]),
    ("plain", lambda fs: next(f for f in fs if f["house"]).update(roof_colour="#a1b2c3",
                                                                   roof_colour_source="x"),
     None, ["observed_roof_colour is not true", "not among the credits"]),
], ids=["credit removed", "another credit named", "no credit named", "not marked used",
        "colour added by hand"])
def test_check_world_refuses_an_observed_colour_drawn_without_its_credit(worlds, tmp_path, world,
                                                                          edit_buildings, edit,
                                                                          messages):
    """The colour is drawn on screen, so a world whose credits lack its credit line fails its
    check, however it came to lack it (PRIV-5 of the final review)."""
    import shutil

    folder = tmp_path / "copy"
    shutil.copytree(getattr(worlds, world), folder)
    if edit_buildings is not None:
        rewrite(folder, edit_buildings)
    if edit is not None:
        edit_manifest(folder, edit)
    problems = manifest.check_world(folder)
    for message in messages:
        assert any(message in p for p in problems), problems
