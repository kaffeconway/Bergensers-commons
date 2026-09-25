"""Build one world folder from a listing record.

    python -m commons_world build --listing PATH [--out DIR] [--offline] [--cache DIR]

A build is an ordered list of named steps, each a function of one
BuildContext. The core build is

    load_listing -> geocode -> origin -> parcels -> plot -> terrain_fetch -> terrain
                 -> listing -> manifest

"terrain_fetch" fills ctx.chunks with every level's heights; "terrain" writes
them. Steps that need the heights before the chunks are written (land cover,
buildings, trees, places: commons_world.features) run between the two.

Everything is written into a staging folder beside the destination and moved
into place only when the whole build, including its own check of the finished
manifest, has succeeded. A failed build leaves the previous world untouched.
Neither folder, nor the response cache, may be somewhere git would pick up
(commons_world.gitguard): outside every checkout, or ignored by it.

Adding steps from another module
--------------------------------
Later layers (buildings, trees, land cover, places, facts) register steps
instead of editing this file:

    from commons_world.build import register_step

    def trees(ctx):
        data = make_trees(ctx.client, ctx.origin, ...)
        ctx.write_file("trees", "trees.bin.gz", data)   # listed in manifest.files
        ctx.add_source({...})                          # a licence record
        ctx.add_credit("...")                          # shown on screen

    register_step("trees", trees, after="terrain")

- A step is `fn(ctx) -> None`. Read what earlier steps left on the context
  (ctx.listing, ctx.geocode, ctx.origin, ctx.crs, ctx.parcels, ctx.chunks...)
  and write files only through ctx.write_file / ctx.write_json, so they land in
  the staging folder and in the manifest.
- `after=` or `before=` names an existing step. With neither, the step goes
  just before "manifest", which always runs last.
- Network access goes through ctx.client (commons_world.http.Client) only.
- To give the height chunks a land-cover band, set
  `ctx.class_source = fn(level, i, j, heights) -> (242, 242) uint8 or None`
  in a step that runs before "terrain" (after "terrain_fetch" if it needs
  the heights).
- `pipeline="synthetic"` registers into the synthetic build instead.

The CLI imports every module in PLUGIN_MODULES that exists (for now
`commons_world.features`), so a module's register_step calls take effect
without this file naming its steps. Library callers and tests that want the
core build only pass `pipeline=core_build_pipeline()`.
"""

import importlib
import importlib.util
import os
import shutil
import sys
import time
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import codec, geo, gitguard, grid, listing as listinglib, manifest as manifestlib
from . import parcel as parcellib
from . import terrain as terrainlib
from .http import Client
from .sources import (CREDIT_KARTVERKET, SOURCE_ADDRESS, SOURCE_EIENDOM, SOURCE_NHM_DTM,
                      SOURCE_TEIG)

PIPELINE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CACHE = PIPELINE_DIR / ".cache"
DEFAULT_OUT_ROOT = PIPELINE_DIR.parent / "out"
PLUGIN_MODULES = ("commons_world.features",)

# The register's stored area and the polygon's own area should agree this well.
AREA_TOLERANCE = 0.005


class BuildError(RuntimeError):
    """The build cannot go on, for a reason the message explains."""


@dataclass
class Step:
    name: str
    fn: object


class Pipeline:
    """An ordered list of named steps."""

    def __init__(self, name, steps):
        self.name = name
        self.steps = list(steps)

    def names(self):
        return [s.name for s in self.steps]

    def register(self, name, fn, *, after=None, before=None, replace=False):
        """Insert a step. See the module docstring for the rules."""
        if after is not None and before is not None:
            raise ValueError("give after= or before=, not both")
        if name in self.names():
            if not replace:
                raise ValueError("a step named {!r} is already registered".format(name))
            self.steps[self.names().index(name)].fn = fn
            return
        if after is None and before is None:
            before = "manifest"
        anchor = after if after is not None else before
        if anchor not in self.names():
            raise ValueError("no step named {!r} in the {} pipeline".format(anchor, self.name))
        if after == "manifest":
            raise ValueError("nothing may run after manifest")
        index = self.names().index(anchor) + (1 if after is not None else 0)
        self.steps.insert(index, Step(name, fn))

    def run(self, ctx):
        for step in self.steps:
            started = time.monotonic()
            ctx.log("[{}] {}".format(self.name, step.name))
            step.fn(ctx)
            ctx.timings[step.name] = round(time.monotonic() - started, 3)


class BuildContext:
    """Everything a build step reads and writes."""

    def __init__(self, *, work_dir, out_dir=None, listing_path=None, client=None,
                 levels=grid.LEVELS, epsg=25832, vertical="NN2000", generated_at=None,
                 commit=None, synthetic=False, log=None):
        self.work_dir = Path(work_dir)
        self.out_dir = Path(out_dir) if out_dir is not None else None
        self.listing_path = listing_path
        self.client = client
        self.levels = tuple(levels)
        self.epsg = epsg
        self.vertical = vertical
        self.generated_at = generated_at or default_generated_at()
        self.commit = commit
        self.synthetic = synthetic
        self.log = log or (lambda message: None)
        self.listing = None
        self.geocode = None
        self.geocode_record = None
        self.world_id = None
        self.origin = None
        self.crs = None
        self.parcels = []
        self.register_areas = {}
        self.plot_source = None
        self.terrain_source = None
        self.terrain_source_name = None
        self.class_source = None
        self.chunks = {}           # level name -> ChunkSet, for later steps
        self.level_records = []
        self.files = {}
        self.sources = []
        self.credits = []
        self.warnings = []
        self.stats = {}
        self.timings = {}

    # -- writing ------------------------------------------------------------

    def write_bytes(self, relpath, data):
        """Write a file into the world folder; return its {"file", "bytes", "sha256"}."""
        relpath = Path(relpath).as_posix()
        if relpath.startswith("/") or ".." in Path(relpath).parts:
            raise BuildError("refusing to write outside the world folder: {}".format(relpath))
        path = self.work_dir / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"file": relpath, "bytes": len(data), "sha256": manifestlib.sha256_hex(data)}

    def write_file(self, key, relpath, data):
        """Write a file and list it under manifest.files[key]."""
        if key in self.files:
            raise BuildError("manifest file key {!r} is already used".format(key))
        entry = self.write_bytes(relpath, data)
        self.files[key] = entry
        return entry

    def write_json(self, key, relpath, obj, gz=False):
        """Write ASCII JSON (gzipped deterministically if gz) and list it."""
        data = manifestlib.dumps_json(obj)
        if gz:
            data = codec.gzip_deterministic(data)
        return self.write_file(key, relpath, data)

    def add_source(self, record):
        if record not in self.sources:
            self.sources.append(dict(record))

    def add_credit(self, text):
        if text not in self.credits:
            self.credits.append(text)


def default_generated_at():
    """SOURCE_DATE_EPOCH if set (for reproducible builds), else now, in UTC."""
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    when = (datetime.fromtimestamp(int(epoch), timezone.utc) if epoch
            else datetime.now(timezone.utc))
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


# -- core steps -------------------------------------------------------------

def step_load_listing(ctx):
    ctx.listing = listinglib.load_listing(ctx.listing_path)
    if ctx.listing["country"] != "NO":
        raise BuildError("only Norwegian listings can be built so far (country {})".format(
            ctx.listing["country"]))
    if not ctx.listing.get("approved_text", {}).get("address"):
        raise BuildError("the listing has no approved address to geocode")


def step_geocode(ctx):
    ctx.geocode = parcellib.geocode(ctx.client, ctx.listing["approved_text"]["address"],
                                    ctx.listing["country"])
    if ctx.geocode.placement_verified is False:
        ctx.warnings.append("The register marks the address point's placement as not verified.")
    ctx.add_source(SOURCE_ADDRESS)


def set_origin(ctx, e, n):
    """Origin, frame and geocode record from the geocoded grid point (E, N)."""
    ctx.origin = geo.round_origin(e, n)
    oe, on = ctx.origin
    ctx.crs = {
        "epsg": ctx.epsg,
        "origin_e": oe,
        "origin_n": on,
        "grid_north_offset_deg": round(geo.grid_north_offset_deg(oe, on, ctx.epsg), 4),
        "scale_factor": round(geo.scale_factor(oe, on, ctx.epsg), 7),
        "vertical": ctx.vertical,
    }


def step_origin(ctx):
    g = ctx.geocode
    e, n = geo.to_grid(g.lat, g.lon, ctx.epsg)
    set_origin(ctx, e, n)
    ctx.world_id = "no-{}-{}-{}".format(g.kommunenummer, g.gnr, g.bnr) + (
        "-{}".format(g.festenr) if g.festenr else "")
    ctx.geocode_record = {
        "source": g.source, "lat": round(g.lat, 8), "lon": round(g.lon, 8), "epsg": ctx.epsg,
        "e": round(e, 2), "n": round(n, 2), "property": g.property_text,
        "placement_verified": g.placement_verified,
    }
    if ctx.out_dir is None:
        ctx.out_dir = DEFAULT_OUT_ROOT / ctx.world_id


def step_parcels(ctx):
    g = ctx.geocode
    ctx.parcels = parcellib.parcels(ctx.client, g.kommunenummer, g.gnr, g.bnr, ctx.epsg,
                                    festenr=g.festenr)
    ctx.add_source(SOURCE_EIENDOM)
    ctx.register_areas = parcellib.register_area(ctx.client, g.kommunenummer, g.gnr, g.bnr,
                                                 festenr=g.festenr)
    ctx.add_source(SOURCE_TEIG)


def check_areas(ctx):
    """Warn (not fail) where a polygon's area and the register's stored area disagree."""
    for p in ctx.parcels:
        stored = ctx.register_areas.get(p.teig_id)
        if stored is None:
            ctx.warnings.append("No stored register area for parcel {}.".format(p.teig_id))
        elif stored > 0 and abs(p.polygon.area - stored) / stored > AREA_TOLERANCE:
            ctx.warnings.append("Parcel {}: polygon area {:.1f} m2 differs from the register's "
                                "{:.1f} m2 by more than 0.5%.".format(
                                    p.teig_id, p.polygon.area, stored))


def step_plot(ctx):
    check_areas(ctx)
    stated = (ctx.listing.get("facts") or {}).get("plot_stated_m2")
    record = parcellib.plot_record(ctx.parcels, ctx.register_areas, ctx.origin, stated,
                                   source=ctx.plot_source)
    ctx.write_json("plot", "plot.json", record)


def write_level(ctx, level, chunkset, source_name=None):
    """Write one level's chunks; return its manifest record. All-sea chunks are listed, not written."""
    chunks, sea = {}, []
    with_classes = 0
    level_bytes = 0
    for i, j in sorted(chunkset):
        heights = chunkset[(i, j)]
        dm = codec.height_dm(heights)
        key = grid.chunk_key(i, j)
        if int(dm.max()) <= 0:
            sea.append(key)
            continue
        classes = ctx.class_source(level, i, j, heights) if ctx.class_source else None
        with_classes += classes is not None
        payload = codec.encode_payload(heights, level, i, j, ctx.epsg, classes=classes)
        entry = ctx.write_bytes(codec.chunk_path(level.name, i, j, payload),
                                codec.gzip_deterministic(payload))
        entry["min"] = round(int(dm.min()) / 10.0, 1)
        entry["max"] = round(int(dm.max()) / 10.0, 1)
        level_bytes += entry["bytes"]
        chunks[key] = entry
    ctx.stats.setdefault("levels", {})[level.name] = {
        "chunks": len(chunks), "sea": len(sea), "bytes": level_bytes,
        "tiles": getattr(chunkset, "tiles", 0),
        "nodata_samples": getattr(chunkset, "nodata_samples", 0),
    }
    record = {
        "name": level.name, "cell": level.cell, "radius": level.radius,
        "chunk_samples": level.samples, "apron": level.apron,
        "class_band": bool(chunks) and with_classes == len(chunks),
        "nodata_fraction": round(float(getattr(chunkset, "nodata_fraction", 0.0)), 6),
        "interpolation": level.interpolation,
        "chunks": chunks, "sea": sea,
    }
    if source_name:
        record["source"] = source_name
        if level.fetch_cell:
            record["fetch_cell"] = level.fetch_cell
    return record


def step_terrain_fetch(ctx):
    """Fetch (or generate) every level's heights into ctx.chunks. Nothing is written yet.

    Steps that need the terrain before the chunks are written (land cover,
    buildings, trees, places) run between this step and "terrain".
    """
    source = ctx.terrain_source
    from_service = source is None
    if from_service:
        ctx.terrain_source_name = terrainlib.DTM_SERVICE
        ctx.add_source(SOURCE_NHM_DTM)
        ctx.add_credit(CREDIT_KARTVERKET)

        def source(level):
            return terrainlib.level_chunks(ctx.client, level, *ctx.origin)
    for level in ctx.levels:
        ctx.chunks[level.name] = source(level)
    if from_service:
        check_registration(ctx)


def check_registration(ctx):
    """Compare every coarser level with every finer one where they overlap; warn on a shift.

    The service's resampled output has been found displaced (grid.LEVELS), so
    this runs on every real build: h5 and h20 against h1 over the h1 disk, and
    h20 against h5 over the wider h5 disk. Results go to
    manifest.stats["registration"], keyed "<coarse>_vs_<fine>".
    """
    results = {}
    for level in ctx.levels:
        for finer in ctx.levels:
            if finer.cell >= level.cell or level.cell % finer.cell:
                continue
            result = terrainlib.registration_check(finer, ctx.chunks.get(finer.name),
                                                   level, ctx.chunks.get(level.name))
            results["{}_vs_{}".format(level.name, finer.name)] = result
            if result.get("shifted"):
                ctx.warnings.append(
                    "Level {} matches the {} heights better moved {} m east and {} m north "
                    "(mean difference {} m against {} m unmoved): its heights may be displaced{}."
                    .format(level.name, finer.name, *result["best_shift_m"],
                            result["best_mean_abs_diff_m"], result["mean_abs_diff_m"],
                            "; that is the edge of the search, so the true displacement may be "
                            "larger" if result.get("at_window_edge") else ""))
    ctx.stats["registration"] = results


def step_terrain(ctx):
    """Write every level's chunks, with a class band wherever ctx.class_source gives one."""
    for level in ctx.levels:
        if level.name not in ctx.chunks:
            raise BuildError("no heights for level {}: run terrain_fetch first".format(level.name))
        ctx.level_records.append(write_level(ctx, level, ctx.chunks[level.name],
                                             ctx.terrain_source_name))


def step_listing(ctx):
    record = dict(ctx.listing)
    record["id"] = ctx.world_id
    record["geocode"] = ctx.geocode_record
    listinglib.check_listing(record)
    ctx.write_json("listing", "listing.json", record)


def _retrieved_dates(ctx):
    """Add "retrieved" (and "retrieved_until") to each source from the fetch log."""
    log = ctx.client.fetch_log if ctx.client is not None else []
    out = []
    for source in ctx.sources:
        record = dict(source)
        endpoint = record.get("endpoint")
        dates = sorted({e["fetched_at"][:10] for e in log
                        if endpoint and e["url"].startswith(endpoint) and e["fetched_at"]})
        if dates:
            record["retrieved"] = dates[0]
            if dates[-1] != dates[0]:
                record["retrieved_until"] = dates[-1]
        out.append(record)
    return out


def step_manifest(ctx):
    sources = _retrieved_dates(ctx)
    ctx.write_file("notice", manifestlib.NOTICE_NAME, manifestlib.notice_text(
        world_id=ctx.world_id, generated_at=ctx.generated_at, credits=ctx.credits,
        sources=sources, commit=ctx.commit, synthetic=ctx.synthetic))
    all_entries = list(ctx.files.values()) + [
        e for record in ctx.level_records for e in record["chunks"].values()]
    ctx.stats["files"] = len(all_entries) + 1
    ctx.stats["bytes_without_manifest"] = sum(e["bytes"] for e in all_entries)
    if ctx.client is not None:
        log = ctx.client.fetch_log
        ctx.stats["http"] = {"requests": ctx.client.requests_made, "responses": len(log),
                             "from_cache": sum(1 for e in log if e["from_cache"])}
    ctx.stats["warnings"] = list(ctx.warnings)
    # File names hash the uncompressed payloads, so they do not depend on zlib;
    # the .gz bytes and their sha256 can, on a machine with another zlib build.
    ctx.stats["zlib"] = zlib.ZLIB_RUNTIME_VERSION
    manifest = manifestlib.build_manifest(
        world_id=ctx.world_id, generated_at=ctx.generated_at, crs=ctx.crs,
        levels=ctx.level_records, files=ctx.files, sources=sources, credits=ctx.credits,
        robots=ctx.client.robots_log() if ctx.client is not None else [],
        stats=ctx.stats, commit=ctx.commit)
    manifestlib.write_manifest(ctx.work_dir, manifest)
    problems = manifestlib.check_world(ctx.work_dir)
    if problems:
        raise BuildError("the finished world failed its own check:\n  " + "\n  ".join(problems))


def core_build_pipeline():
    """A fresh copy of the core build, with no registered extras."""
    return Pipeline("build", [
        Step("load_listing", step_load_listing),
        Step("geocode", step_geocode),
        Step("origin", step_origin),
        Step("parcels", step_parcels),
        Step("plot", step_plot),
        Step("terrain_fetch", step_terrain_fetch),
        Step("terrain", step_terrain),
        Step("listing", step_listing),
        Step("manifest", step_manifest),
    ])


BUILD = core_build_pipeline()
PIPELINES = {"build": BUILD}


def register_step(name, fn, *, after=None, before=None, pipeline="build", replace=False):
    """Add a step to the build (or to pipeline="synthetic"). See the module docstring."""
    if pipeline == "synthetic" and "synthetic" not in PIPELINES:
        importlib.import_module("commons_world.synthetic")
    if pipeline not in PIPELINES:
        raise ValueError("no pipeline named {!r}".format(pipeline))
    PIPELINES[pipeline].register(name, fn, after=after, before=before, replace=replace)


def load_plugins(names=PLUGIN_MODULES):
    """Import each plugin module that exists; return the names imported."""
    loaded = []
    for name in names:
        if importlib.util.find_spec(name) is not None:
            importlib.import_module(name)
            loaded.append(name)
    return loaded


# -- running ----------------------------------------------------------------

def _is_world_folder(path):
    path = Path(path)
    if not path.is_dir():
        return False
    if not any(path.iterdir()):
        return True
    try:
        import json
        manifest = json.loads((path / manifestlib.MANIFEST_NAME).read_text(encoding="ascii"))
    except (OSError, ValueError):
        return False
    return manifest.get("format") == manifestlib.FORMAT_NAME


def _staging_dir(parent, name):
    """A fresh staging folder beside parent/name, after checking git would not pick up either."""
    staging = Path(parent) / ".{}.partial-{}".format(name, os.getpid())
    gitguard.check_destination(Path(parent) / name, "a world folder")
    gitguard.check_destination(staging, "a staging folder")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    return staging


def _finalise(staging, final_dir):
    final_dir = Path(final_dir)
    gitguard.check_destination(final_dir, "a world folder")
    if final_dir.exists():
        if not _is_world_folder(final_dir):
            raise BuildError("{} exists and is not a Commons World folder; refusing to "
                             "replace it".format(final_dir))
        shutil.rmtree(final_dir)
    final_dir.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, final_dir)
    return final_dir


def run_pipeline(pipeline, ctx):
    """Run `pipeline` over `ctx` in its staging folder and move the result into place."""
    staging = ctx.work_dir
    try:
        pipeline.run(ctx)
        if ctx.out_dir is None:
            raise BuildError("no destination folder was decided")
        if Path(ctx.out_dir).resolve().parent != staging.resolve().parent:
            final = Path(ctx.out_dir)
            moved = _staging_dir(final.parent, final.name)
            moved.rmdir()
            shutil.move(str(staging), str(moved))
            staging = moved
        return _finalise(staging, ctx.out_dir)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def build(listing_path, out_dir=None, *, cache_dir=DEFAULT_CACHE, offline=False,
          transport=None, client=None, levels=grid.LEVELS, generated_at=None, commit=None,
          pipeline=None, log=None, min_interval=1.0):
    """Build the world for one listing; return the finished world folder.

    `out_dir` is the world folder itself; by default world/out/<id>.
    """
    if client is None:
        if cache_dir is not None:
            gitguard.check_destination(cache_dir, "the response cache")
        client = Client(cache_dir, offline=offline, transport=transport,
                        min_interval=min_interval)
    if out_dir is not None:
        staging = _staging_dir(Path(out_dir).parent, Path(out_dir).name)
    else:
        staging = _staging_dir(DEFAULT_OUT_ROOT, "build")
    ctx = BuildContext(work_dir=staging, out_dir=out_dir, listing_path=listing_path,
                       client=client, levels=levels, generated_at=generated_at,
                       commit=commit if commit is not None else manifestlib.pipeline_commit(),
                       log=log)
    return run_pipeline(pipeline or BUILD, ctx)


def default_log(message):
    print(message, file=sys.stderr, flush=True)
