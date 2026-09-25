"""Turrutebasen: marked foot routes and route information points, from Kartverket's WFS.

    https://wfs.geonorge.no/skwms1/wfs.turogfriluftsruter
    app:Fotrute        foot routes (lines)
    app:RuteInfoPunkt  route information points (parking, huts, fire pits...)

Both are asked for over a bounding box in the world's grid, a page at a
time (WFS 2.0 count/startIndex; the server reports numberMatched as
"unknown", so paging stops at the first short page).

Kept from each route: its geometry, whether it is marked, and what it
follows (ruteFoelger). Names, route numbers and maintainers are not kept.
Kept from each information point: its position and its facility code
(tilrettelegging, e.g. 22 appears to be parking; the codes are not
documented in the schema).
"""

import io
from dataclasses import dataclass, field

import numpy as np

from . import gml
from .n50 import Line

WFS_URL = "https://wfs.geonorge.no/skwms1/wfs.turogfriluftsruter"
NAMESPACE = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/TurOgFriluftsruter/20171210"
PAGE_SIZE = 1000
MAX_PAGES = 50


class TrailsError(RuntimeError):
    """The trails service answered with something unexpected."""


@dataclass
class InfoPoint:
    e: float
    n: float
    code: object


@dataclass
class TrailData:
    routes: list = field(default_factory=list)
    points: list = field(default_factory=list)
    requests: int = 0

    def stats(self):
        length = sum(float(np.hypot(*np.diff(r.coords, axis=0).T).sum()) for r in self.routes)
        codes = {}
        for p in self.points:
            codes[str(p.code)] = codes.get(str(p.code), 0) + 1
        return {"routes": len(self.routes), "route_length_m": round(length, 1),
                "info_points": len(self.points), "info_point_codes": dict(sorted(codes.items())),
                "requests": self.requests}


def _params(type_name, bounds, epsg, start):
    srs = "urn:ogc:def:crs:EPSG::{}".format(epsg)
    return {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "app:" + type_name,
            "namespaces": "xmlns(app,{})".format(NAMESPACE),
            "srsName": srs,
            "bbox": "{},{},{},{},{}".format(*(int(round(v)) for v in bounds), srs),
            "count": PAGE_SIZE, "startIndex": start}


def fetch_pages(client, type_name, bounds, epsg=25832):
    """Yield each page's bytes for one feature type over `bounds`."""
    start = 0
    for _ in range(MAX_PAGES):
        resp = client.get(WFS_URL, params=_params(type_name, bounds, epsg, start))
        resp.raise_for_status()
        if b"ExceptionReport" in resp.content[:2000]:
            raise TrailsError("the trails WFS refused the request: {}".format(
                resp.content[:300].decode("utf-8", errors="replace")))
        yield resp.content
        returned = resp.content.count(b"<wfs:member")
        if returned < PAGE_SIZE:
            return
        start += returned
    raise TrailsError("more than {} pages of {}".format(MAX_PAGES, type_name))


def parse_routes(content, epsg=25832):
    """Foot routes in one WFS page, as Line(kind="path", source="turrutebasen")."""
    out = []
    reproject = gml.Reprojector(epsg)
    for feature in gml.iter_features(io.BytesIO(content)):
        if gml.local(feature.tag) != "Fotrute":
            continue
        geom = reproject.geometry(gml.geometry(feature, default_epsg=epsg))
        if geom is None or geom.kind != "line":
            continue
        follows = gml.text(feature, "ruteF\u00f8lger") or None
        marked = gml.text(feature, "merking") or None
        for part in geom.parts:
            out.append(Line(kind="path", coords=part, source="turrutebasen",
                            source_type="Fotrute follows={} marked={}".format(follows, marked)))
    return out


def parse_points(content, epsg=25832):
    """Route information points in one WFS page."""
    out = []
    reproject = gml.Reprojector(epsg)
    for feature in gml.iter_features(io.BytesIO(content)):
        if gml.local(feature.tag) != "RuteInfoPunkt":
            continue
        geom = reproject.geometry(gml.geometry(feature, default_epsg=epsg))
        if geom is None or geom.kind != "point":
            continue
        code = gml.text(feature, "tilrettelegging")
        e, n = geom.parts[0][0]
        out.append(InfoPoint(e=float(e), n=float(n),
                             code=int(code) if code and code.isdigit() else code))
    return out


def fetch(client, bounds, epsg=25832):
    """Every foot route and route information point touching `bounds`."""
    data = TrailData()
    seen = set()
    for page in fetch_pages(client, "Fotrute", bounds, epsg):
        data.requests += 1
        for line in parse_routes(page, epsg):
            key = line.coords.tobytes()
            if key not in seen:
                seen.add(key)
                data.routes.append(line)
    for page in fetch_pages(client, "RuteInfoPunkt", bounds, epsg):
        data.requests += 1
        data.points += parse_points(page, epsg)
    return data
