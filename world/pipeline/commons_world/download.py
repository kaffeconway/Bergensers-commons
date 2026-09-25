"""Geonorge's download API (nedlasting.geonorge.no), and which municipalities a world touches.

Downloading one dataset for one municipality takes three requests, all
through commons_world.http.Client and so all cached on disk:

1. GET  /api/codelists/area/<uuid>  - which projections and formats each area
   is offered in (one request per dataset, shared by every municipality);
2. POST /api/order                  - an order line for the dataset, area type
   "kommune", one projection, one format. No e-mail address is sent;
3. GET  each file's downloadUrl     - which redirects to a fixed file under
   /geonorge/<theme>/<dataset>/<format>/<name>. The zip is cached under the
   order's URL.

A rebuild answers all three from the cache. If a cached order's file link has
expired but the file itself was never cached (an interrupted first build),
the fixed URL is tried instead; that pattern was seen on 25 Sept 2026 for
N50 Kartdata and NVDB Vegnett Pluss and is only a fallback.

`kommuner_for_disk` finds the municipalities a disk touches with Kartverket's
kommuneinfo API: a point lookup (/punkt) at sample points on rings around the
centre, skipping every point that already lies well inside a municipality
found earlier (its outline comes from /kommuner/<nr>/omrade).
"""

import io
import math
import zipfile
from dataclasses import dataclass, field

from shapely.geometry import Point, shape
from shapely.prepared import prep

from .http import OfflineCacheMiss

API = "https://nedlasting.geonorge.no/api"
ORDER_URL = API + "/order"
AREA_URL = API + "/codelists/area/{uuid}"
FILE_BASE = "https://nedlasting.geonorge.no/geonorge"

KOMMUNEINFO = "https://api.kartverket.no/kommuneinfo/v1"
PUNKT_URL = KOMMUNEINFO + "/punkt"
OMRADE_URL = KOMMUNEINFO + "/kommuner/{nr}/omrade"

READY = "ReadyForDownload"


class DownloadError(RuntimeError):
    """The download API did not offer or deliver what was asked for."""


@dataclass
class DownloadedFile:
    name: str
    content: bytes
    url: str
    from_cache: bool


def area_list(client, uuid):
    """The dataset's area codelist: a list of {"type", "code", "name", "projections"...}."""
    resp = client.get(AREA_URL.format(uuid=uuid)).raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        raise DownloadError("area list for {} is not a list".format(uuid))
    return data


def offered(areas, kommune):
    """(area entry, {projection code: set of format names}) for one municipality."""
    for entry in areas:
        if entry.get("type") == "kommune" and str(entry.get("code")) == str(kommune):
            out = {}
            for proj in entry.get("projections") or []:
                out[str(proj.get("code"))] = {f.get("name") for f in proj.get("formats") or []}
            return entry, out
    return None, {}


def order_body(uuid, kommune, name, projection, fmt):
    """The JSON body of one order: one order line, one municipality, one projection and format."""
    return {"orderLines": [{
        "metadataUuid": uuid,
        "areas": [{"code": str(kommune), "name": name, "type": "kommune"}],
        "projections": [{"code": str(projection)}],
        "formats": [{"name": fmt}],
    }]}


def fixed_file_url(name, fmt):
    """The fixed file URL an order link redirected to on 25 Sept 2026 (fallback only).

    "Samferdsel_1151_Utsira_5973_NVDB-VegnettPluss_GML.zip" lives at
    /geonorge/Samferdsel/NVDB-VegnettPluss/GML/<name>.
    """
    parts = name.split("_")
    if len(parts) < 6 or not name.endswith("_{}.zip".format(fmt)):
        return None
    theme, dataset = parts[0], parts[-2]
    return "{}/{}/{}/{}/{}".format(FILE_BASE, theme, dataset, fmt, name)


def fetch(client, uuid, kommune, projection, fmt="GML"):
    """Order one dataset for one municipality and return its files as DownloadedFile."""
    areas = area_list(client, uuid)
    entry, formats = offered(areas, kommune)
    if entry is None:
        raise DownloadError("dataset {} is not offered for kommune {}".format(uuid, kommune))
    if fmt not in formats.get(str(projection), set()):
        raise DownloadError("dataset {} for kommune {} is not offered as {} in EPSG:{}; "
                            "offered: {}".format(uuid, kommune, fmt, projection,
                                                 {k: sorted(v) for k, v in formats.items()}))
    body = order_body(uuid, kommune, entry.get("name", ""), projection, fmt)
    order = client.post(ORDER_URL, json=body).raise_for_status()
    files = order.json().get("files") or []
    if not files:
        raise DownloadError("the order for {} / kommune {} returned no files".format(uuid, kommune))
    out = []
    for f in files:
        if f.get("status") != READY:
            raise DownloadError("file {} is {!r}, not {}".format(f.get("name"), f.get("status"),
                                                                 READY))
        resp = client.get(f["downloadUrl"])
        if not resp.ok and order.from_cache:
            fallback = fixed_file_url(f.get("name", ""), fmt)
            if fallback:
                resp = client.get(fallback)
        resp.raise_for_status()
        if resp.content[:2] != b"PK":
            raise DownloadError("{} is not a zip file".format(f.get("name")))
        out.append(DownloadedFile(name=f.get("name", ""), content=resp.content, url=resp.url,
                                  from_cache=resp.from_cache))
    return out


def zip_members(content, suffix=".gml"):
    """Yield (member name, open binary file) for each member ending in `suffix`, sorted."""
    archive = zipfile.ZipFile(io.BytesIO(content))
    for name in sorted(archive.namelist()):
        if name.lower().endswith(suffix.lower()):
            with archive.open(name) as fh:
                yield name, fh


# -- which municipalities a disk touches -------------------------------------

@dataclass
class KommuneLookup:
    """The municipalities found, and what finding them cost."""

    kommuner: list
    names: dict = field(default_factory=dict)
    sample_points: int = 0
    point_lookups: int = 0
    outline_requests: int = 0
    no_kommune: int = 0
    offline_misses: int = 0

    @property
    def requests(self):
        return self.point_lookups + self.outline_requests

    def stats(self):
        return {"kommuner": list(self.kommuner), "sample_points": self.sample_points,
                "point_lookups": self.point_lookups, "outline_requests": self.outline_requests,
                "points_in_no_kommune": self.no_kommune, "offline_misses": self.offline_misses}


def disk_sample_points(e0, n0, radius, ring_step=1000.0, min_bearings=16, max_spacing=1000.0):
    """Sample points: the centre, then rings every `ring_step` out to `radius` (inclusive).

    Each ring has at least `min_bearings` points and no two neighbours further
    apart than `max_spacing` along it; alternate rings are staggered by half a
    step. Points are whole metres, so lookups are cached under stable URLs.
    """
    points = [(int(round(e0)), int(round(n0)))]
    rings = []
    r = ring_step
    while r < radius - 1e-9:
        rings.append(r)
        r += ring_step
    rings.append(float(radius))
    for index, r in enumerate(rings):
        count = max(min_bearings, int(math.ceil(2.0 * math.pi * r / max_spacing)))
        offset = 0.5 if index % 2 else 0.0
        for k in range(count):
            bearing = 2.0 * math.pi * (k + offset) / count
            points.append((int(round(e0 + r * math.sin(bearing))),
                           int(round(n0 + r * math.cos(bearing)))))
    seen, out = set(), []
    for p in points:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def kommune_outline(client, kommunenummer, epsg):
    """The municipality's outline (a shapely geometry in `epsg`), from /kommuner/<nr>/omrade."""
    resp = client.get(OMRADE_URL.format(nr=kommunenummer), params={"utkoordsys": epsg})
    resp.raise_for_status()
    data = resp.json()
    return data.get("kommunenavn"), shape(data["omrade"])


def kommuner_for_disk(client, e0, n0, radius, epsg=25832, ring_step=1000.0, min_bearings=16,
                      max_spacing=1000.0, margin=250.0):
    """Every municipality whose area a sample point of the disk falls in.

    A point is looked up only if it is not at least `margin` metres inside an
    outline already fetched, so most points cost nothing: roughly two requests
    per municipality, plus the points near a boundary and any point at sea
    outside every municipality (the API answers 404 there). A municipality
    that only grazes the disk between sample points (less than about
    `max_spacing` across) can be missed.

    Offline, a point whose lookup is not cached (only 404 answers are never
    cached) counts as outside every municipality, which is what it was when
    the cache was filled; if nothing at all is found, the miss is raised.
    """
    points = disk_sample_points(e0, n0, radius, ring_step, min_bearings, max_spacing)
    result = KommuneLookup(kommuner=[], sample_points=len(points))
    inner = []   # prepared outlines shrunk by `margin`
    names = {}
    first_miss = None
    for e, n in points:
        here = Point(e, n)
        if any(p.contains(here) for p in inner):
            continue
        try:
            resp = client.get(PUNKT_URL, params={"nord": n, "ost": e, "koordsys": epsg})
        except OfflineCacheMiss as exc:
            result.offline_misses += 1
            first_miss = first_miss or exc
            continue
        result.point_lookups += 1
        if resp.status == 404:
            result.no_kommune += 1
            continue
        resp.raise_for_status()
        nr = str(resp.json()["kommunenummer"])
        if nr in names:
            continue
        name, outline = kommune_outline(client, nr, epsg)
        result.outline_requests += 1
        names[nr] = name
        shrunk = outline.buffer(-margin)
        if not shrunk.is_empty:
            inner.append(prep(shrunk))
    if not names and first_miss is not None:
        raise first_miss
    result.kommuner = sorted(names)
    result.names = {k: names[k] for k in result.kommuner}
    return result
