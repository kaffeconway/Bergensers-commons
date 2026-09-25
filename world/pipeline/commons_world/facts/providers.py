"""Where the facts get what a world folder does not hold.

The facts need rasters the world does not store (the 1 m surface model
around the plot, 1 m terrain around summits, and 10, 50 and 100 m terrain
for horizons and routes), the path network out to 15 km and place names
between the world's edge and 15 km.

- RealProvider fetches them from Kartverket through commons_world.http.Client
  only (host allowlist, robots.txt, rate limit, disk cache): terrain and
  surface through terrain.fetch_raster (hoydedata.no exportImage, tiles of
  at most 3000 px a side), NVDB Vegnett Pluss and N50 through the Geonorge
  download API (the same cached municipality files a build reads),
  Turrutebasen through its WFS, and place names through the Stedsnavn API.
- SyntheticProvider computes them from commons_world/synthetic.py's
  functions. It never touches the network and describes no real place.

hoydedata.no covers Norway only: outside it the service answers nodata (or
0 m), which is kept as NaN here and taken as sea level by the horizon.
"""

import math
from dataclasses import dataclass, field

import numpy as np

from .. import grid
from .. import terrain as terrainlib
from ..sources import (CC_BY_4, CC_BY_4_URL, SOURCE_KOMMUNEINFO, SOURCE_N50, SOURCE_NVDB,
                       SOURCE_STEDSNAVN, SOURCE_TURRUTER)
from .access import PeakCandidate

NODATA_HIGH_M = terrainlib.NODATA_ABS_LIMIT
NODATA_LOW_M = terrainlib.NODATA_LOW_M
NETWORK_MARGIN_M = 2000.0

SOURCE_FACTS_TERRAIN = {
    "name": "Nasjonal h\u00f8ydemodell, terrain and surface models, read for the measured facts "
            "(facts.json)",
    "publisher": "Kartverket",
    "licence": CC_BY_4,
    "licence_url": CC_BY_4_URL,
    "endpoint": "https://hoydedata.no/arcgis/rest/services/",
    "modified": "terrain resampled by the server to 10, 50 and 100 m (bilinear) for horizons "
                "and route heights, and read at 1 m around summits; surface model read at 1 m "
                "around the plot. Used only to compute facts.json; not written as rasters.",
}


@dataclass
class NetworkInputs:
    lines: list = field(default_factory=list)          # n50.Line
    info_points: list = field(default_factory=list)    # trails.InfoPoint
    extra_places: list = field(default_factory=list)   # access.PeakCandidate (h filled later)
    label: str = ""
    stats: dict = field(default_factory=dict)
    warnings: list = field(default_factory=list)


def _clean(arr):
    arr = np.asarray(arr, dtype=np.float32).copy()
    with np.errstate(invalid="ignore"):
        bad = ~np.isfinite(arr) | (arr > NODATA_HIGH_M) | (arr < NODATA_LOW_M)
    arr[bad] = np.nan
    return arr


class RealProvider:
    """Kartverket's services, through the pipeline's HTTP client."""

    synthetic = False
    network_label = "NVDB Vegnett Pluss + Turrutebasen + N50 paths"

    def __init__(self, client, epsg=25832, log=None):
        if client is None:
            raise ValueError("a real world needs an HTTP client for its facts")
        self.client = client
        self.epsg = epsg
        self.log = log or (lambda message: None)
        self.rasters = []
        self.sources = [SOURCE_FACTS_TERRAIN]

    def _fetch(self, service, bounds, cell, interpolation):
        arr = terrainlib.fetch_raster(self.client, service, bounds, cell, interpolation)
        arr = _clean(arr)
        self.rasters.append({"service": service, "cell": cell,
                             "px": [int(arr.shape[1]), int(arr.shape[0])],
                             "nodata_fraction": round(float(np.isnan(arr).mean()), 6)})
        return arr

    def dtm(self, bounds, cell):
        """Terrain heights over `bounds`, rows north to south; NaN for nodata."""
        interpolation = grid.NEAREST if cell <= 1 else grid.BILINEAR
        return self._fetch(terrainlib.DTM_SERVICE, bounds, cell, interpolation)

    def dom(self, bounds):
        """The 1 m surface model over `bounds`; NaN for nodata."""
        return self._fetch(terrainlib.DOM_SERVICE, bounds, 1, grid.NEAREST)

    def network(self, view, radius):
        """Walkable lines, route information points and extra place names out to `radius`."""
        from .. import download, n50, nvdb, trails
        from .. import places as placeslib
        from ..features import N50_PROJECTIONS, NVDB_PROJECTIONS, READ_ERRORS, fetch_preferred
        from ..sources import DATASETS

        oe, on = view.origin
        out = NetworkInputs(label=self.network_label)
        lookup = download.kommuner_for_disk(self.client, oe, on, radius, epsg=self.epsg)
        kommuner = sorted(set(lookup.kommuner) | set(view.kommuner))
        out.stats["kommuner"] = kommuner
        out.stats["kommuner_beyond_world"] = sorted(set(lookup.kommuner) - set(view.kommuner))
        out.stats["kommune_lookup"] = lookup.stats()
        pad = radius + NETWORK_MARGIN_M
        clip = (oe - pad, on - pad, oe + pad, on + pad)
        counts = {}
        for kommune in kommuner:
            self.log("facts: network for kommune {}".format(kommune))
            n50_data = n50.N50Data()
            _, files = fetch_preferred(self.client, DATASETS["n50"]["uuid"], kommune,
                                       N50_PROJECTIONS)
            for f in files:
                for name, fh in download.zip_members(f.content, ".gml"):
                    if n50.theme_of(name) == "Samferdsel":
                        n50.parse(fh, clip=clip, epsg=self.epsg, data=n50_data,
                                  count_unknown=False)
            paths = n50.paths(n50_data)
            out.lines += paths
            counts["n50:path"] = counts.get("n50:path", 0) + len(paths)
            try:
                _, files = fetch_preferred(self.client, DATASETS["nvdb"]["uuid"], kommune,
                                           NVDB_PROJECTIONS)
                data = nvdb.NVDBData()
                for f in files:
                    nvdb.parse_zip(f.content, clip=clip, epsg=self.epsg, data=data,
                                   keep_connections=True)
                out.lines += data.lines
                counts["nvdb"] = counts.get("nvdb", 0) + len(data.lines)
            except READ_ERRORS as exc:
                fallback = n50.roads(n50_data)
                out.lines += fallback
                counts["n50:road_fallback"] = counts.get("n50:road_fallback", 0) + len(fallback)
                out.warnings.append("NVDB could not be read for kommune {} ({}); its roads "
                                    "come from N50.".format(kommune, type(exc).__name__))
        routes = trails.fetch(self.client, clip, epsg=self.epsg)
        out.lines += routes.routes
        out.info_points += routes.points
        counts["turrutebasen"] = len(routes.routes)
        out.stats["lines"] = counts
        out.stats["info_points"] = len(routes.points)
        search = placeslib.fetch_names(self.client, oe, on, radius, epsg=self.epsg)
        out.stats["place_names"] = search.stats()
        for c in search.candidates:
            if math.hypot(c.e - oe, c.n - on) > view.places_radius:
                out.extra_places.append(PeakCandidate(c.name, c.type, c.e, c.n, float("nan"),
                                                      "place-name query to 15 km"))
        self.sources += [SOURCE_KOMMUNEINFO, SOURCE_N50, SOURCE_NVDB, SOURCE_TURRUTER,
                         SOURCE_STEDSNAVN]
        return out


class SyntheticProvider:
    """The synthetic place's functions (commons_world/synthetic.py). No network."""

    synthetic = True
    network_label = "synthetic lines (commons_world/synthetic.py)"

    def __init__(self, origin, h1_level, surface=None):
        self.origin = tuple(origin)
        self.h1_level = h1_level
        self.surface = surface
        self._dom = None
        self.rasters = []
        self.sources = []

    def dtm(self, bounds, cell):
        from .. import synthetic

        west, south, east, north = bounds
        width = int(round((east - west) / cell))
        height = int(round((north - south) / cell))
        e = west + (np.arange(width) + 0.5) * cell
        n = north - (np.arange(height) + 0.5) * cell
        arr = synthetic.height_grid(e[None, :], n[:, None], self.origin).astype(np.float32)
        self.rasters.append({"service": "synthetic terrain", "cell": cell,
                             "px": [width, height], "nodata_fraction": 0.0})
        return arr

    def _dom_grid(self):
        from .. import synthetic
        from ..raster import LevelGrid

        if self._dom is None:
            level = self.h1_level
            surface = self.surface
            if surface is None:
                terrain = synthetic.terrain_source(self.origin)(level)
                surface = synthetic.surface_chunks(level, terrain, self.origin)
            lgrid = LevelGrid(level, list(surface))
            self._dom = (lgrid, lgrid.assemble(surface))
        return self._dom

    def dom(self, bounds):
        lgrid, dom = self._dom_grid()
        west, south, east, north = bounds
        q0 = int(round((west - lgrid.west) / lgrid.cell))
        r0 = int(round((lgrid.north - north) / lgrid.cell))
        q1 = int(round((east - lgrid.west) / lgrid.cell))
        r1 = int(round((lgrid.north - south) / lgrid.cell))
        out = np.full((r1 - r0, q1 - q0), np.nan, dtype=np.float32)
        rr0, qq0 = max(r0, 0), max(q0, 0)
        rr1, qq1 = min(r1, lgrid.height), min(q1, lgrid.width)
        if rr1 > rr0 and qq1 > qq0:
            out[rr0 - r0:rr1 - r0, qq0 - q0:qq1 - q0] = dom[rr0:rr1, qq0:qq1]
        self.rasters.append({"service": "synthetic surface", "cell": 1,
                             "px": [q1 - q0, r1 - r0], "nodata_fraction": 0.0})
        return out

    def network(self, view, radius):
        from .. import synthetic
        from ..trails import InfoPoint

        oe, on = self.origin
        out = NetworkInputs(label=self.network_label)
        out.lines = synthetic.synthetic_lines(self.origin)
        out.info_points = [InfoPoint(e=oe + x, n=on + n, code=code)
                           for x, n, code in synthetic.TRAIL_POINTS]
        for c in synthetic.synthetic_candidates(self.origin, radius):
            if math.hypot(c.e - oe, c.n - on) > view.places_radius:
                out.extra_places.append(PeakCandidate(c.name, c.type, c.e, c.n, float("nan"),
                                                      "synthetic place names"))
        out.stats = {"lines": {"synthetic": len(out.lines)},
                     "info_points": len(out.info_points)}
        return out
