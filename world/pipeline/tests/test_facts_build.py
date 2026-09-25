"""facts.json end to end: the synthetic world's build writes it, the manifest lists it,
its keys are FORMAT.md's, and the `facts` command gives the same facts on a finished world.

The synthetic world is invented (commons_world/synthetic.py); nothing here is real data.
"""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from commons_world import build, manifest
from commons_world import facts as factslib
from commons_world.__main__ import main

FORMAT_MD = Path(__file__).resolve().parents[2] / "FORMAT.md"


def format_example():
    """The facts.json example in FORMAT.md, parsed."""
    text = FORMAT_MD.read_text(encoding="utf-8")
    section = text[text.index("### `facts.json`"):]
    block = section[section.index("```json") + len("```json"):]
    return json.loads(block[:block.index("```")])


def missing_keys(example, ours, path=""):
    """Keys the example has that ours lacks (lists of objects: every item is checked)."""
    out = []
    if isinstance(example, dict):
        if not isinstance(ours, dict):
            return [path + " (not an object)"]
        for key, value in example.items():
            if key not in ours:
                out.append(path + "/" + key)
            else:
                out += missing_keys(value, ours[key], path + "/" + key)
    elif isinstance(example, list) and example and isinstance(example[0], dict):
        for item in ours:
            out += missing_keys(example[0], item, path + "[]")
    return out


@pytest.fixture(scope="module")
def facts(synthetic_world):
    return json.loads((synthetic_world / "facts.json").read_text(encoding="ascii"))


def test_the_build_lists_facts_json_and_passes_its_check(synthetic_world):
    m = json.loads((synthetic_world / "manifest.json").read_text(encoding="ascii"))
    entry = m["files"]["facts"]
    data = (synthetic_world / "facts.json").read_bytes()
    assert entry == {"file": "facts.json", "bytes": len(data),
                     "sha256": manifest.sha256_hex(data)}
    assert manifest.check_world(synthetic_world) == []
    assert m["stats"]["facts"]["plot_cells"] > 0
    assert m["robots"] == []                                  # no network at all


def test_the_keys_are_format_md_s(facts):
    example = format_example()
    assert missing_keys(example, facts) == []
    assert facts["version"] == 1 and set(example) <= set(facts)
    for block in ("plot", "sun", "access"):
        assert isinstance(facts[block]["method"], str) and facts[block]["method"]
        assert all(isinstance(c, str) for c in facts[block]["caveats"])
        # the methods name Kartverket's data; a synthetic world says it uses none
        assert facts[block]["caveats"][0] == factslib.SYNTHETIC_CAVEAT
    assert "Clear sky: weather is not included." in facts["sun"]["caveats"]


def test_plot_figures_hold_together(facts, synthetic_world):
    p = facts["plot"]
    assert 3550 < p["area_m2"] < 3650                         # the 90 x 40 m synthetic parcel
    # one parcel, one area: plot.json's, not that of its ring after 0.1 m rounding
    plot = json.loads((synthetic_world / "plot.json").read_text(encoding="ascii"))
    assert p["area_m2"] == round(sum(q["area_polygon_m2"] for q in plot["parcels"]), 1)
    assert p["analysed_m2"] + p["excluded_m2"]["buildings_with_1m_margin"] <= p["area_m2"] + 50
    assert sum(b["m2"] for b in p["bands_deg"]) == p["analysed_m2"]
    assert sum(b["m2_smoothed"] for b in p["bands_deg"]) == p["analysed_m2"]
    assert sum(b["m2"] for b in p["ratio_bands"]) == p["analysed_m2"]
    assert p["slope_p10_deg"] <= p["slope_median_deg"] <= p["slope_p90_deg"]
    assert 0 <= p["plane_fit"]["slope_deg"] < 30
    assert 0 <= p["plane_fit"]["aspect_true_deg"] < 360
    assert p["open_ground_m2"] <= p["analysed_m2"]
    assert p["elevation_min"] <= p["elevation_max"]


def test_sun_figures_hold_together(facts):
    s = facts["sun"]
    flat = s["astronomical"]
    for variant in ("terrain", "terrain_canopy"):
        med = s["plot_median"][variant]
        assert med["dec21_h"] <= flat["dec21_h"] and med["jun21_h"] <= flat["jun21_h"]
        assert len(med["monthly_h"]) == 12
    assert s["plot_median"]["terrain_canopy"]["jun21_h"] <= s["plot_median"]["terrain"]["jun21_h"]
    h = s["horizon"]
    assert h["step_deg"] == 0.5 and len(h["profile_deg"]) == 720
    assert 10000 <= h["max_distance_m"] <= 250000
    assert all(c >= t for c, t in zip(h["profile_canopy_deg"], h["profile_deg"]))
    pm = s["plot_map"]
    assert len(pm["dec21_min_terrain"]) == len(pm["dec21_min_canopy"]) == pm["rows"] * pm["cols"]
    t = np.array(pm["dec21_min_terrain"])
    c = np.array(pm["dec21_min_canopy"])
    assert np.array_equal(t < 0, c < 0) and np.all(c <= t)
    assert np.sum(t >= 0) == s["plot_median"]["cells"]
    assert t.max() <= round(flat["dec21_h"] * 60)
    for day in ("dec21", "jun21"):
        path = s["sun_path"][day]
        assert path and all(el > 0 for _, el in path)
    assert s["garden_point"]["terrain_canopy"]["dec21_h"] <= s["garden_point"]["terrain"]["dec21_h"]


def test_access_on_the_synthetic_paths(facts):
    a = facts["access"]
    assert a["network"].startswith("synthetic")
    names = [p["name"] for p in a["peaks"]]
    assert "Synthetic Fjell" in names and "Far Away Fjell" not in names
    assert "Synthetic Vik" not in names                       # not a terrain type
    for p in a["peaks"]:
        assert p["straight_m"] <= 15000
        if p["route_m"] is not None:
            assert p["naismith_h"] == pytest.approx(p["route_m"] / 5000 + p["climb_m"] / 600,
                                                    abs=0.01)
            assert p["reaches_summit"] == (p["gap_m"] <= 50 and abs(p["gap_up_m"]) <= 20)
            assert p["route"] and all(len(v) == 2 for v in p["route"])
    kinds = {t["kind"] for t in a["trailheads"]}
    assert "path leaves road" in kinds
    assert "parking (Turrutebasen route information point)" in kinds  # synthetic code 22
    assert all(t["route_m"] > 0 for t in a["trailheads"])
    assert a["graph"]["lines_left_out"] == {"underground or in a building": 1}  # the tunnel


def test_facts_is_the_last_step_before_the_manifest():
    assert "commons_world.facts" in build.PLUGIN_MODULES
    assert build.BUILD.names()[-2:] == ["facts", "manifest"]
    assert factslib.synthetic_pipeline().names()[-2:] == ["facts", "manifest"]
    from commons_world import synthetic
    assert "facts" not in synthetic.SYNTHETIC.names()         # the shared copy is untouched


def test_the_facts_command_on_a_finished_world(synthetic_world, tmp_path, capsys):
    folder = tmp_path / "synthetic"
    shutil.copytree(synthetic_world, folder)
    before = json.loads((folder / "facts.json").read_text(encoding="ascii"))
    (folder / "facts.json").unlink()
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    del m["files"]["facts"]
    (folder / "manifest.json").write_bytes(manifest.dumps_json(m))
    assert manifest.check_world(folder) == []
    assert main(["facts", "--world", str(folder), "--cache", str(tmp_path / "cache")]) == 0
    after = json.loads((folder / "facts.json").read_text(encoding="ascii"))
    before.pop("generated_at")
    after.pop("generated_at")
    assert after == before                                    # same facts as the build's
    assert manifest.check_world(folder) == []
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    assert m["files"]["facts"]["bytes"] == (folder / "facts.json").stat().st_size
    assert not (tmp_path / "cache").exists()                  # the synthetic world fetches nothing


def test_check_catches_a_broken_facts_file(synthetic_world, tmp_path):
    folder = tmp_path / "w"
    shutil.copytree(synthetic_world, folder)
    data = json.loads((folder / "facts.json").read_text(encoding="ascii"))
    del data["sun"]["method"]
    raw = manifest.dumps_json(data)
    (folder / "facts.json").write_bytes(raw)
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    m["files"]["facts"].update(bytes=len(raw), sha256=manifest.sha256_hex(raw))
    (folder / "manifest.json").write_bytes(manifest.dumps_json(m))
    assert any("block 'sun'" in p for p in manifest.check_world(folder))


def test_a_real_world_without_a_client_is_refused(synthetic_world, tmp_path):
    folder = tmp_path / "w"
    shutil.copytree(synthetic_world, folder)
    m = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
    m["id"] = "no-9999-1-2"
    (folder / "manifest.json").write_bytes(manifest.dumps_json(m))
    with pytest.raises(factslib.FactsError, match="HTTP client"):
        factslib.run(folder, None)


def test_check_refuses_a_listing_that_carries_private_data(synthetic_world, tmp_path):
    # The build refuses such a listing; `check` must too, even when the manifest's size and
    # sha256 were updated to match the edited file.
    world = tmp_path / "copy"
    shutil.copytree(synthetic_world, world)
    assert manifest.check_world(world) == []
    record = json.loads((world / "listing.json").read_text(encoding="ascii"))
    record["notes"] = "made-up private note"
    record["costs"]["per_person_monthly"] = 1.0
    data = manifest.dumps_json(record)
    (world / "listing.json").write_bytes(data)
    m = json.loads((world / "manifest.json").read_text(encoding="ascii"))
    m["files"]["listing"].update({"bytes": len(data), "sha256": manifest.sha256_hex(data)})
    (world / "manifest.json").write_bytes(manifest.dumps_json(m))
    problems = manifest.check_world(world)
    assert len(problems) == 1 and problems[0].startswith("files.listing: listing refused")
    assert "notes" in problems[0] and "per_person" in problems[0]
