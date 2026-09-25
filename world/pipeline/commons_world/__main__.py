"""Command line: python -m commons_world {build,synthetic,check,facts} ...

    build      --listing PATH [--out DIR] [--offline] [--cache DIR] [--no-plugins]
    synthetic  [--out DIR]
    check      DIR
    facts      --world DIR [--offline] [--cache DIR] [--compare-pvgis CSV]

`--out` is the world folder itself. build defaults to world/out/<id>/ and
synthetic to world/out/synthetic/, both gitignored. Nothing is published. An
--out or --cache inside a git checkout that git does not ignore is refused.
"""

import argparse
import sys
from pathlib import Path

from . import __version__
from .build import (DEFAULT_CACHE, DEFAULT_OUT_ROOT, BuildError, build, default_log,
                    load_plugins)
from .gitguard import UnsafeDestination
from .http import (HostNotAllowed, HTTPError, OfflineCacheMiss, RobotsDisallowed,
                   TooManyRedirects, TransportError)
from .listing import LeakError, ListingInvalid
from .manifest import check_world, pipeline_commit
from .parcel import GeocodeError, ParcelError
from .terrain import TerrainError

EXPECTED_ERRORS = (BuildError, GeocodeError, ParcelError, LeakError, ListingInvalid,
                   HostNotAllowed, RobotsDisallowed, OfflineCacheMiss, TooManyRedirects,
                   TransportError, HTTPError, TerrainError, NotImplementedError,
                   UnsafeDestination)


def _summary(folder):
    files = [p for p in Path(folder).rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m commons_world",
                                     description="Build Commons World folders.")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build", help="build the world for one listing record")
    p_build.add_argument("--listing", required=True, type=Path, help="listing JSON file")
    p_build.add_argument("--out", type=Path, default=None,
                         help="world folder to write (default world/out/<id>)")
    p_build.add_argument("--offline", action="store_true",
                         help="use only cached responses; fail on anything not cached")
    p_build.add_argument("--cache", type=Path, default=DEFAULT_CACHE,
                         help="response cache folder (default world/pipeline/.cache)")
    p_build.add_argument("--no-plugins", action="store_true",
                         help="run the core steps only, without commons_world.features")

    p_syn = sub.add_parser("synthetic", help="write the synthetic test world (no network)")
    p_syn.add_argument("--out", type=Path, default=DEFAULT_OUT_ROOT / "synthetic",
                       help="world folder to write (default world/out/synthetic)")

    p_check = sub.add_parser("check", help="check a built world folder against its manifest")
    p_check.add_argument("folder", type=Path)

    p_facts = sub.add_parser("facts", help="compute facts.json for a built world folder")
    p_facts.add_argument("--world", required=True, type=Path, help="the world folder")
    p_facts.add_argument("--offline", action="store_true",
                         help="use only cached responses; fail on anything not cached")
    p_facts.add_argument("--cache", type=Path, default=DEFAULT_CACHE,
                         help="response cache folder (default world/pipeline/.cache)")
    p_facts.add_argument("--compare-pvgis", type=Path, default=None, metavar="CSV",
                         help="print a comparison with a PVGIS horizon file (never stored)")

    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            if not args.no_plugins:
                for name in load_plugins():
                    default_log("loaded plugin {}".format(name))
            folder = build(args.listing, args.out, cache_dir=args.cache, offline=args.offline,
                           log=default_log)
        elif args.command == "synthetic":
            from .facts import synthetic_pipeline
            from .synthetic import build_synthetic
            folder = build_synthetic(args.out, commit=pipeline_commit(), log=default_log,
                                     pipeline=synthetic_pipeline())
        elif args.command == "facts":
            from .facts import run_cli
            folder, _, _ = run_cli(args.world, cache_dir=args.cache, offline=args.offline,
                                   compare_pvgis=args.compare_pvgis, log=default_log)
        else:
            problems = check_world(args.folder)
            for problem in problems:
                print(problem)
            print("{}: {}".format(args.folder, "ok" if not problems else
                                  "{} problem(s)".format(len(problems))))
            return 1 if problems else 0
    except EXPECTED_ERRORS as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 2
    count, size = _summary(folder)
    print("wrote {}: {} files, {} bytes".format(folder, count, size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
