"""What the facts read from a world folder, or from a build that is still running.

A WorldView holds, in the world's national grid:
- the origin, the grid north offset and the origin's latitude and longitude;
- the h1 terrain (1 m) as one raster over every h1 chunk, decoded from the
  chunk files exactly as the viewer decodes them (so heights are rounded to
  0.1 m), with all-sea chunks filled with 0 m, and its land-cover class band;
- the registered parcels (plot.json), building footprints (buildings.json.gz)
  and named places (places.json).

`load_world(folder)` reads a finished world through its manifest.json. During
a build the manifest is not written yet, so `load_world(folder, manifest=...)`
takes a manifest-shaped record made from the build context (see
`commons_world.facts.step_facts`); the chunk files are already in the staging
folder by then.
"""

import gzip
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

from .. import codec, geo, grid
from ..raster import LevelGrid


class WorldError(RuntimeError):
    """The world folder lacks something the facts need."""


@dataclass
class Building:
    polygon: Polygon          # grid coordinates
    house: bool
    type: int
    ground: float
    roof: float


@dataclass
class PlaceRecord:
    name: str
    type: str
    e: float
    n: float
    h: float


@dataclass
class WorldView:
    folder: Path
    world_id: str
    epsg: int
    origin: tuple
    offset_deg: float
    lat: float
    lon: float
    synthetic: bool
    h1_level: object
    h1: LevelGrid
    dtm1: np.ndarray               # float32, NaN where no chunk
    classes1: object               # uint8 array or None
    parcels: list                  # shapely Polygons, grid
    stated_plot_m2: object
    buildings: list = field(default_factory=list)
    places: list = field(default_factory=list)
    places_radius: float = 0.0
    kommuner: list = field(default_factory=list)
    # plot.json's area_polygon_m2 per parcel: the polygon before its ring was rounded to
    # 0.1 m for storage (None where a record lacks it)
    parcel_areas: list = field(default_factory=list)

    # -- frames ---------------------------------------------------------------

    def to_local(self, e, n):
        """Grid (E, N) to viewer (x, z)."""
        return geo.local(e, n, self.origin)

    def to_grid(self, x, z):
        """Viewer (x, z) to grid (E, N)."""
        return geo.from_local(x, z, self.origin)

    def true_bearing(self, grid_bearing):
        return geo.true_from_grid(grid_bearing, self.offset_deg)

    def grid_bearing(self, true_bearing):
        return geo.grid_from_true(true_bearing, self.offset_deg)

    @property
    def parcel_union(self):
        return unary_union(self.parcels)

    @property
    def house(self):
        for b in self.buildings:
            if b.house:
                return b
        return None


def _ring_to_grid(ring, origin):
    oe, on = origin
    return [(oe + float(x), on - float(z)) for x, z in ring]


def _level_from_record(record):
    return grid.Level(record["name"], int(record["cell"]), int(record["radius"]),
                      int(record["chunk_samples"]), int(record["apron"]))


def load_h1(folder, level_record):
    """(Level, LevelGrid, heights, classes) for the h1 level, decoded from its chunk files."""
    level = _level_from_record(level_record)
    chunks = level_record.get("chunks") or {}
    sea = level_record.get("sea") or []
    keys = [tuple(int(v) for v in key.split("_")) for key in list(chunks) + list(sea)]
    if not keys:
        raise WorldError("the h1 level has no chunks")
    lgrid = LevelGrid(level, keys)
    heights = np.full(lgrid.shape, np.nan, dtype=np.float32)
    classes = np.full(lgrid.shape, 255, dtype=np.uint8)
    any_classes = False
    for key, entry in chunks.items():
        i, j = (int(v) for v in key.split("_"))
        data = codec.decode((Path(folder) / entry["file"]).read_bytes())
        rows, cols = lgrid.window(i, j)
        heights[rows, cols] = data["heights_m"]
        if data["classes"] is not None:
            classes[rows, cols] = data["classes"]
            any_classes = True
    for key in sea:
        i, j = (int(v) for v in key.split("_"))
        rows, cols = lgrid.window(i, j)
        heights[rows, cols] = 0.0
        classes[rows, cols] = 5
    return level, lgrid, heights, (classes if any_classes else None)


def load_world(folder, manifest=None, synthetic=None):
    """A WorldView of the world in `folder` (manifest.json, or a manifest-shaped record)."""
    folder = Path(folder)
    if manifest is None:
        try:
            manifest = json.loads((folder / "manifest.json").read_text(encoding="ascii"))
        except (OSError, ValueError) as exc:
            raise WorldError("cannot read {}/manifest.json: {}".format(folder, exc)) from exc
    crs = manifest["crs"]
    epsg = int(crs["epsg"])
    origin = (int(crs["origin_e"]), int(crs["origin_n"]))
    lat, lon = geo.to_latlon(float(origin[0]), float(origin[1]), epsg)
    levels = {record["name"]: record for record in manifest["levels"]}
    if "h1" not in levels:
        raise WorldError("the world has no h1 level; the facts need the 1 m terrain")
    level, lgrid, heights, classes = load_h1(folder, levels["h1"])
    files = manifest.get("files") or {}

    def read_json(key, gz=False):
        entry = files.get(key)
        if not entry:
            return None
        data = (folder / entry["file"]).read_bytes()
        if gz:
            data = gzip.decompress(data)
        return json.loads(data.decode("ascii"))

    plot = read_json("plot")
    if not plot or not plot.get("parcels"):
        raise WorldError("the world has no plot.json parcels")
    parcels = []
    parcel_areas = []
    for p in plot["parcels"]:
        area = p.get("area_polygon_m2")
        parcel_areas.append(float(area) if isinstance(area, (int, float)) else None)
        poly = Polygon(_ring_to_grid(p["ring"], origin),
                       [_ring_to_grid(h, origin) for h in p.get("holes") or []])
        if not poly.is_valid:
            poly = poly.buffer(0)
        parcels.append(poly)
    buildings = []
    record = read_json("buildings", gz=True)
    for f in (record or {}).get("features", []):
        ring = f.get("ring") or []
        if len(ring) < 3:
            continue
        poly = Polygon(_ring_to_grid(ring, origin))
        if not poly.is_valid:
            poly = poly.buffer(0)
        buildings.append(Building(polygon=poly, house=bool(f.get("house")),
                                  type=int(f.get("type") or 0),
                                  ground=float(f.get("ground") or 0.0),
                                  roof=float(f.get("roof") or 0.0)))
    places = []
    for f in (read_json("places") or {}).get("features", []):
        e, n = geo.from_local(float(f["x"]), float(f["z"]), origin)
        places.append(PlaceRecord(name=f["name"], type=f["type"], e=e, n=n, h=float(f["h"])))
    outer = max(manifest["levels"], key=lambda r: r["radius"])
    kommuner = list(((manifest.get("stats") or {}).get("map") or {}).get("inputs", {})
                    .get("kommuner") or [])
    if synthetic is None:
        from ..synthetic import SYNTHETIC_ID
        synthetic = manifest.get("id") == SYNTHETIC_ID
    return WorldView(folder=folder, world_id=manifest.get("id"), epsg=epsg, origin=origin,
                     offset_deg=float(crs["grid_north_offset_deg"]), lat=float(lat),
                     lon=float(lon), synthetic=bool(synthetic), h1_level=level, h1=lgrid,
                     dtm1=heights, classes1=classes, parcels=parcels,
                     stated_plot_m2=plot.get("stated_plot_m2"), buildings=buildings,
                     places=places, places_radius=float(outer["radius"]), kommuner=kommuner,
                     parcel_areas=parcel_areas)
