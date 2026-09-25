"""Write CWH1 decoder test vectors for the viewer tests.

    python make_vectors.py --world ../../out/synthetic --out /tmp/vectors.json

Reads chunks from a built world with the pipeline's own decoder
(commons_world.codec, imported read-only) and writes, for a handful of chunks per
level: the header fields, the height in decimetres and the class at the four
corners, points on the apron and points inside, the highest and lowest samples,
and a checksum over every sample. The viewer's JavaScript decoder must reproduce
all of it exactly (world/tests/viewer/viewer.test.mjs).

Run it on the synthetic world only: the vectors hold heights, which for a real
world would be a precise description of a place.
"""

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PIPELINE = HERE.parents[1] / "pipeline"
sys.path.insert(0, str(PIPELINE))
sys.dont_write_bytecode = True  # leave no __pycache__ behind in the pipeline package

from commons_world import codec  # noqa: E402  (after the path is set)

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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--world", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
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
