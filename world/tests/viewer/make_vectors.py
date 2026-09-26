"""Write CWH1 decoder test vectors, and sun position vectors, for the viewer tests.

    python make_vectors.py --world ../../out/synthetic --out /tmp/vectors.json
    python make_vectors.py --sun-out /tmp/sun-vectors.json

Reads chunks from a built world with the pipeline's own decoder
(commons_world.codec, imported read-only) and writes, for a handful of chunks per
level: the header fields, the height in decimetres and the class at the four
corners, points on the apron and points inside, the highest and lowest samples,
and a checksum over every sample. The viewer's JavaScript decoder must reproduce
all of it exactly (world/tests/viewer/viewer.test.mjs).

Run it on the synthetic world only: the vectors hold heights, which for a real
world would be a precise description of a place.

--sun-out writes the sun's position from commons_world.facts.sun.solar_position (pvlib's
SPA, the call facts.json is computed with) as rows [utc_ms, lat, lon, alt, azimuth,
apparent_elevation, elevation], for sun.test.mjs to hold world/js/sun.js against. The
places are round numbers that describe no listing. This mode needs numpy, pandas and
pvlib (the pipeline's requirements.txt); without them it exits with status 2.
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PIPELINE = HERE.parents[1] / "pipeline"
sys.path.insert(0, str(PIPELINE))
sys.dont_write_bytecode = True  # leave no __pycache__ behind in the pipeline package

try:
    from commons_world import codec  # noqa: E402  (after the path is set)
except ImportError as _codec_error:   # only the decoder mode needs it; --sun-out says its own
    codec = None
    CODEC_ERROR = _codec_error

SUN_NEEDS = ("make_vectors --sun-out needs numpy, pandas and pvlib (the pipeline's requirements); "
             "set CW_PYTHON")
# (lat, lon, altitude m): round numbers, no listing's place
SUN_PLACES = [(60.0, 4.0, 0.0), (60.0, 4.0, 900.0), (45.0, 6.0, 1500.0), (42.5, 0.5, 1000.0),
              (70.0, 20.0, 0.0), (36.0, -5.0, 50.0), (69.0, 18.0, 0.0)]
SUN_SEED = 20260925

FIXED_POINTS = [
    (0, 0), (0, 241), (241, 0), (241, 241),          # corners of the stored array (apron)
    (0, 120), (241, 77), (60, 0), (180, 241),        # apron rows and columns
    (1, 1), (1, 240), (240, 1), (240, 240),          # the chunk's own corner samples
    (120, 120), (37, 203), (200, 19), (99, 150),     # inside
]


def checksum(values):
    """sum(value * ((index % 1000) + 1)) over row-major order, as a Python int."""
    flat = [int(v) for v in values.reshape(-1).tolist()]
    return sum(v * ((i % 1000) + 1) for i, v in enumerate(flat))


def pick_keys(level):
    keys = sorted(level["chunks"])
    if not keys:
        return []
    picked = [keys[0], keys[len(keys) // 2], keys[-1]]
    return list(dict.fromkeys(picked))


def vectors_for(world, key, level_name, entry):
    data = (world / entry["file"]).read_bytes()
    d = codec.decode(data)
    dm = d["heights_dm"]
    cls = d["classes"]
    points = list(FIXED_POINTS)
    hi = divmod(int(dm.argmax()), dm.shape[1])
    lo = divmod(int(dm.argmin()), dm.shape[1])
    points += [hi, lo]
    if cls is not None:
        for code in (4, 5, 7, 12):
            where = (cls == code).nonzero()
            if len(where[0]):
                points.append((int(where[0][0]), int(where[1][0])))
    out_points = []
    for r, q in points:
        out_points.append([int(r), int(q), int(dm[r, q]), None if cls is None else int(cls[r, q])])
    return {
        "level": level_name,
        "key": key,
        "file": entry["file"],
        "header": {
            "version": int(d["version"]), "flags": int(d["flags"]), "width": int(d["width"]),
            "height": int(d["height"]), "cellCm": int(d["cell_cm"]), "cornerEdm": int(d["corner_e_dm"]),
            "cornerNdm": int(d["corner_n_dm"]), "base": int(d["base_dm"]), "epsg": int(d["epsg"]),
        },
        "points": out_points,
        "checksum": checksum(dm),
        "classChecksum": None if cls is None else checksum(cls),
        "min_dm": int(dm.min()),
        "max_dm": int(dm.max()),
    }


def sun_vectors(out):
    """Rows [utc_ms, lat, lon, alt, azimuth, apparent_elevation, elevation] from pvlib's SPA."""
    try:
        import numpy as np
        import pandas as pd
        import pvlib  # noqa: F401  (solar_position imports it when called)
        from commons_world.facts.sun import solar_position
    except ImportError:
        print(SUN_NEEDS)
        return 2
    rng = np.random.default_rng(SUN_SEED)
    t0 = pd.Timestamp("2020-01-01", tz="UTC").value // 10**6
    t1 = pd.Timestamp("2036-01-01", tz="UTC").value // 10**6
    days = [(m, d) for m in range(1, 13) for d in (1, 21)]
    dst_days = [(3, 29), (10, 25)]             # the two DST change days of 2026 in Europe
    rows = []
    for lat, lon, alt in SUN_PLACES:
        ms = [int(v) for v in rng.integers(t0, t1, 1000)]
        for m, d in days:
            # every minute from 40 minutes before to 40 minutes after each sunrise and sunset
            start = pd.Timestamp(2026, m, d, tz="UTC").value // 10**6
            minutes = start + 60000 * np.arange(-12 * 60, 36 * 60)
            sp = solar_position(pd.to_datetime(minutes, unit="ms", utc=True), lat, lon, alt)
            el = sp["apparent_elevation"].to_numpy()
            cross = np.flatnonzero(np.sign(el[1:]) != np.sign(el[:-1]))
            for k in cross:
                lo, hi = max(0, k - 40), min(len(minutes), k + 41)
                ms += [int(v) for v in minutes[lo:hi]]
        for m, d in dst_days:
            start = pd.Timestamp(2026, m, d, tz="UTC").value // 10**6
            ms += [int(start + 600000 * k) for k in range(144)]
        ms = sorted(set(ms))
        sp = solar_position(pd.to_datetime(ms, unit="ms", utc=True), lat, lon, alt)
        for t, az, ae, ge in zip(ms, sp["azimuth"], sp["apparent_elevation"], sp["elevation"]):
            rows.append([t, lat, lon, alt, float(az), float(ae), float(ge)])
    out.write_text(json.dumps(rows), encoding="ascii")
    print("wrote {} sun vectors to {}".format(len(rows), out))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--world", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--sun-out", type=Path, help="write sun position vectors to this file")
    args = parser.parse_args(argv)
    if args.sun_out is not None:
        return sun_vectors(args.sun_out)
    if args.world is None or args.out is None:
        parser.error("give --world and --out (decoder vectors), or --sun-out FILE")
    if codec is None:
        raise CODEC_ERROR
    manifest = json.loads((args.world / "manifest.json").read_text(encoding="ascii"))
    if not str(manifest.get("id", "")).startswith("zz-"):
        parser.error("refusing to write vectors for a world that is not synthetic ({})".format(manifest.get("id")))
    oe, on = manifest["crs"]["origin_e"], manifest["crs"]["origin_n"]
    chunks = []
    for level in manifest["levels"]:
        keys = pick_keys(level)
        side = level["cell"] * level["chunk_samples"]
        home = "{}_{}".format(oe // side, on // side)
        if home in level["chunks"] and home not in keys:
            keys.append(home)
        for key in keys:
            chunks.append(vectors_for(args.world, key, level["name"], level["chunks"][key]))
    args.out.write_text(json.dumps({"world": manifest["id"], "chunks": chunks}, indent=1), encoding="ascii")
    print("wrote {} chunks of vectors to {}".format(len(chunks), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
