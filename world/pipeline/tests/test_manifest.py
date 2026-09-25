"""manifest.json, NOTICE.txt and the structural check of a world folder."""

import json

import numpy as np
import pytest

from commons_world import codec, grid, manifest
from commons_world.sources import (CREDIT_KARTVERKET, CREDIT_SSR, SOURCE_NHM_DTM,
                                   SOURCE_STEDSNAVN)


def test_dumps_json_is_ascii_sorted_and_deterministic():
    data = manifest.dumps_json({"b": 1, "a": "\u00f8", "c": [1.5, None]})
    data.decode("ascii")
    assert data.endswith(b"\n")
    assert json.loads(data) == {"a": "\u00f8", "b": 1, "c": [1.5, None]}
    assert data.index(b'"a"') < data.index(b'"b"') < data.index(b'"c"')
    assert b"\\u00f8" in data
    assert manifest.dumps_json({"b": 1, "a": 2}) == manifest.dumps_json({"a": 2, "b": 1})
    with pytest.raises(ValueError):
        manifest.dumps_json({"x": float("nan")})


def test_ascii_fold_of_the_credits():
    assert manifest.ascii_fold(CREDIT_SSR) == "Alle stadnamn er henta fraa SSR (c)Kartverket"
    assert manifest.ascii_fold(CREDIT_KARTVERKET).startswith("(c) Kartverket")


def test_notice_text():
    source = dict(SOURCE_NHM_DTM, retrieved="2026-01-01")
    text = manifest.notice_text(world_id="zz-test", generated_at="2026-01-01T00:00:00Z",
                                credits=[CREDIT_KARTVERKET], sources=[source], commit="abc1234")
    decoded = text.decode("ascii")
    assert "(c) Kartverket" in decoded
    assert "https://creativecommons.org/licenses/by/4.0/" in decoded
    assert "Retrieved: 2026-01-01" in decoded
    assert "No OpenStreetMap data" in decoded
    assert "synthetic" not in decoded
    synthetic = manifest.notice_text(world_id="zz-test", generated_at="t", credits=[],
                                     sources=[], synthetic=True).decode("ascii")
    assert "synthetic world" in synthetic and "CC BY" not in synthetic


H1 = grid.LEVELS_BY_NAME["h1"]


def write_chunk(folder, i, j, heights, key=None, epsg=25832):
    """Encode a real CWH1 chunk for chunk (i, j) and write it under the name of `key`."""
    payload = codec.encode_payload(heights, H1, i, j, epsg)
    key = key or (i, j)
    rel = codec.chunk_path("h1", key[0], key[1], payload)
    (folder / rel).parent.mkdir(parents=True, exist_ok=True)
    (folder / rel).write_bytes(codec.gzip_deterministic(payload))
    entry = manifest.file_entry(folder, rel)
    dm = codec.height_dm(heights)
    entry.update({"min": round(int(dm.min()) / 10.0, 1), "max": round(int(dm.max()) / 10.0, 1)})
    return entry


def make_world(folder, sources=(), credits=(), level_source=None, chunks=None):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plot.json").write_bytes(b"{}\n")
    ramp = np.add.outer(np.arange(242.0), np.arange(242.0)) / 10.0 + 1.0
    chunks = chunks if chunks is not None else {"1_2": write_chunk(folder, 1, 2, ramp)}
    (folder / "NOTICE.txt").write_bytes(manifest.notice_text(
        world_id="zz-test", generated_at="2026-01-01T00:00:00Z", credits=list(credits),
        sources=list(sources), commit="abc1234"))
    level = {"name": "h1", "cell": 1, "radius": 1500, "chunk_samples": 240, "apron": 1,
             "class_band": False, "nodata_fraction": 0.0, "chunks": chunks, "sea": ["1_3"]}
    if level_source:
        level["source"] = level_source
    record = manifest.build_manifest(
        world_id="zz-test", generated_at="2026-01-01T00:00:00Z",
        crs={"epsg": 25832, "origin_e": 1, "origin_n": 2, "grid_north_offset_deg": 0.0,
             "scale_factor": 1.0, "vertical": "NN2000"},
        levels=[level],
        files={"plot": manifest.file_entry(folder, "plot.json"),
               "notice": manifest.file_entry(folder, "NOTICE.txt")},
        sources=list(sources), credits=list(credits), robots=[], commit="abc1234")
    manifest.write_manifest(folder, record)
    return record


def test_check_world_accepts_a_sound_folder(tmp_path):
    record = make_world(tmp_path)
    assert manifest.check_world(tmp_path) == []
    assert record["format"] == "commons-world" and record["version"] == 1
    assert record["pipeline"]["version"] == "0.1.0"


def test_check_world_finds_problems(tmp_path):
    make_world(tmp_path)
    (tmp_path / "plot.json").write_bytes(b"{} \n")      # size and hash change
    (tmp_path / "stray.bin").write_bytes(b"x")           # not listed
    for chunk in (tmp_path / "h1").iterdir():            # listed, missing
        chunk.unlink()
    problems = "\n".join(manifest.check_world(tmp_path))
    assert "plot.json is 4 bytes" in problems
    assert "sha256" in problems
    assert "stray.bin" in problems
    assert "does not exist" in problems


def test_check_world_rejects_a_bad_manifest(tmp_path):
    make_world(tmp_path)
    data = json.loads((tmp_path / "manifest.json").read_text())
    data["levels"][0]["sea"] = ["1_2"]
    data["levels"][0]["chunks"]["x_y"] = data["levels"][0]["chunks"]["1_2"]
    del data["crs"]["epsg"]
    (tmp_path / "manifest.json").write_text(json.dumps(data))
    problems = "\n".join(manifest.check_world(tmp_path))
    assert "both as sea and as files" in problems
    assert "bad chunk key 'x_y'" in problems
    assert "crs.epsg missing" in problems
    (tmp_path / "manifest.json").write_bytes('{"a": "\u00f8"}'.encode("utf-8"))
    assert "not ASCII" in manifest.check_world(tmp_path)[0]


def test_pipeline_commit_is_short_or_none():
    commit = manifest.pipeline_commit()
    assert commit is None or (4 <= len(commit.replace("-dirty", "")) <= 40)


def test_check_world_reads_every_chunk(tmp_path):
    ramp = np.add.outer(np.arange(242.0), np.arange(242.0)) / 10.0 + 1.0
    folder = tmp_path / "w"
    folder.mkdir()
    moved = write_chunk(folder, 1, 2, ramp, key=(1, 3))       # chunk 1_2 filed under 1_3
    good = write_chunk(folder, 1, 2, ramp)
    good["max"] = 99.0                                         # manifest disagrees
    seabed = write_chunk(folder, 5, 5, np.full((242, 242), -1.0), key=(5, 5))
    make_world(folder, chunks={"1_3": moved, "1_2": good, "5_5": seabed})
    problems = "\n".join(manifest.check_world(folder))
    assert "level h1 chunk 1_3: header corner_n_dm" in problems
    assert "chunk 1_2: manifest max 99.0" in problems
    assert "chunk 5_5: every sample is at or below 0 m" in problems
    renamed = tmp_path / "r"
    entry = write_chunk(renamed, 1, 2, ramp)
    path = renamed / entry["file"]
    other = path.with_name("1_2.00000000.cwh.gz")
    path.rename(other)
    entry = dict(manifest.file_entry(renamed, other.relative_to(renamed).as_posix()),
                 min=entry["min"], max=entry["max"])
    make_world(renamed, chunks={"1_2": entry})
    assert "file name hash does not match" in "\n".join(manifest.check_world(renamed))


def test_check_world_requires_the_notice_and_the_credits(tmp_path):
    kartverket = dict(SOURCE_NHM_DTM)
    make_world(tmp_path / "a", sources=[kartverket], credits=[])
    assert "Kartverket CC BY 4.0 credit" in "\n".join(manifest.check_world(tmp_path / "a"))
    make_world(tmp_path / "b", credits=[], level_source="NHM_DTM_25832")
    assert "Kartverket CC BY 4.0 credit" in "\n".join(manifest.check_world(tmp_path / "b"))
    make_world(tmp_path / "c", sources=[kartverket, SOURCE_STEDSNAVN],
               credits=[CREDIT_KARTVERKET])
    assert "SSR credit" in "\n".join(manifest.check_world(tmp_path / "c"))
    make_world(tmp_path / "d", sources=[kartverket, SOURCE_STEDSNAVN],
               credits=[CREDIT_KARTVERKET, CREDIT_SSR])
    assert manifest.check_world(tmp_path / "d") == []
    data = json.loads((tmp_path / "d" / "manifest.json").read_text())
    del data["files"]["notice"]
    (tmp_path / "d" / "NOTICE.txt").unlink()
    (tmp_path / "d" / "manifest.json").write_text(json.dumps(data))
    assert "NOTICE.txt must be listed" in "\n".join(manifest.check_world(tmp_path / "d"))


def test_pipeline_commit_does_not_take_git_locks(monkeypatch):
    seen = []
    real_run = manifest.subprocess.run

    def spy(args, **kwargs):
        seen.append((args, kwargs.get("env", {}).get("GIT_OPTIONAL_LOCKS")))
        return real_run(args, **kwargs)
    monkeypatch.setattr(manifest.subprocess, "run", spy)
    manifest.pipeline_commit()
    assert seen and all(lock == "0" for _, lock in seen)
