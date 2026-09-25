"""Buildings within the h1 radius: footprints from the surface model, anchored to register points.

Kartverket's building footprints (FKB) are not open data, so footprints are
segmented from the 1 m surface model (NHM DOM) minus the 1 m terrain model
(NHM DTM), and kept only where the building register has a point:

1. nDSM = DOM - DTM.
2. Roof cells: nDSM > 2.5 m, and the surface is locally planar there: the
   RMS residual of a least-squares plane through the 3 x 3 cells around the
   cell is under 0.25 m. Tree crowns are rough and fail this; roofs pass
   except along ridges, hips and eaves.
3. A 3 x 3 closing rejoins roof faces split along a ridge or hip (gaps of
   up to two cells), and components are labelled (4-connected). Each
   component of at least 12 m2 is a candidate.
4. Each candidate grows by one cell into neighbouring cells above 2.5 m,
   which puts back the eaves that failed the planarity test.
5. Each register point is assigned to the nearest candidate within 6 m (0 if
   it lies inside). Candidates with a point are buildings; the rest are
   dropped (an unregistered roof, or a flat patch of canopy).
6. Each building becomes a polygon: the component's outline, simplified with
   a 0.5 m tolerance, holes dropped, counter-clockwise seen from above.
   ground = median DTM under the component; roof = 90th percentile DOM.
7. type = the register type of its chosen point: a point inside the
   footprint before one outside, a dwelling point before any other, then the
   one nearest the footprint's centroid. "Dwelling" is the register's
   residential group 111-199 without 181-183 (garages, outbuildings, annexes
   and boathouses that belong to a dwelling).
8. house = true on exactly one building, or none: among buildings with a
   dwelling point whose footprint lies at least half inside the registered
   parcel, the one nearest the address point. The stats say why when none is.

Register points come from the Matrikkelen bygningspunkt WFS. Only the type
code, building number, status and point are read; the number and status are
used in the build and never written into the world.
"""

import io
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from shapely.geometry import Point, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import gml
from .n50 import BuildingPoint
from .parcel import ring_local

WFS_URL = "https://wfs.geonorge.no/skwms1/wfs.matrikkelen-bygningspunkt"
NAMESPACE = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Bygningspunkt/20211101"
PAGE_SIZE = 1000
MAX_PAGES = 100
PROPERTIES = "app:bygningsnummer,app:bygningstype,app:bygningsstatus,app:representasjonspunkt"

MIN_HEIGHT_M = 2.5
PLANE_RMS_M = 0.25
PLANE_WINDOW = 3
MIN_AREA_M2 = 12.0
ANCHOR_M = 6.0
SIMPLIFY_M = 0.5
# Dwellings: the register's group 1 ("bolig", 111-199) without 181-183, which are
# garages, outbuildings, annexes and boathouses belonging to a dwelling.
RESIDENTIAL = frozenset(range(111, 200)) - {181, 182, 183}
HOUSE_MIN_INSIDE = 0.5

_CROSS = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


class BuildingsError(RuntimeError):
    """The building-point service answered with something unexpected."""


# -- register points ----------------------------------------------------------

def _params(bounds, epsg, start):
    srs = "urn:ogc:def:crs:EPSG::{}".format(epsg)
    return {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": "app:Bygning", "namespaces": "xmlns(app,{})".format(NAMESPACE),
            "srsName": srs, "propertyName": PROPERTIES,
            "bbox": "{},{},{},{},{}".format(*(int(round(v)) for v in bounds), srs),
            "count": PAGE_SIZE, "startIndex": start}


def parse_points(content, epsg=25832):
    """Building points in one WFS page: type, number, status and position only."""
    out = []
    reproject = gml.Reprojector(epsg)
    for feature in gml.iter_features(io.BytesIO(content)):
        if gml.local(feature.tag) != "Bygning":
            continue
        geom = reproject.geometry(gml.geometry(feature, default_epsg=epsg))
        if geom is None or geom.kind != "point":
            continue
        code = gml.text(feature, "bygningstype") or ""
        number = gml.text(feature, "bygningsnummer") or ""
        e, n = geom.parts[0][0]
        out.append(BuildingPoint(type=int(code) if code.isdigit() else 0, e=float(e), n=float(n),
                                 number=int(number) if number.isdigit() else None,
                                 status=gml.text(feature, "bygningsstatus") or None,
                                 source="matrikkel"))
    return out


def fetch_points(client, bounds, epsg=25832):
    """Every register point within `bounds` (west, south, east, north); (points, requests)."""
    points, requests, start = [], 0, 0
    seen = set()
    for _ in range(MAX_PAGES):
        resp = client.get(WFS_URL, params=_params(bounds, epsg, start)).raise_for_status()
        requests += 1
        if b"ExceptionReport" in resp.content[:2000]:
            raise BuildingsError("the building-point WFS refused the request: {}".format(
                resp.content[:300].decode("utf-8", errors="replace")))
        returned = resp.content.count(b"<wfs:member")
        for p in parse_points(resp.content, epsg):
            key = (p.number, round(p.e, 2), round(p.n, 2))
            if key not in seen:
                seen.add(key)
                points.append(p)
        if returned < PAGE_SIZE:
            return points, requests
        start += returned
    raise BuildingsError("more than {} pages of building points".format(MAX_PAGES))


# -- segmentation ---------------------------------------------------------------

def plane_rms(surface, window=PLANE_WINDOW):
    """RMS residual (m) of a least-squares plane fitted to each window x window neighbourhood.

    Cells whose window would run off the grid, or holds a NaN, get infinity.
    """
    z = np.asarray(surface, dtype=np.float64)
    finite = np.isfinite(z)
    ref = float(np.median(z[finite])) if finite.any() else 0.0
    z = np.where(finite, z - ref, 0.0)
    k = window // 2
    offsets = np.arange(-k, k + 1, dtype=np.float64)
    xk = np.tile(offsets, (window, 1))
    yk = xk.T.copy()
    n = float(window * window)
    sxx = float((xk ** 2).sum())
    ones = np.ones((window, window))
    s = ndimage.correlate(z, ones, mode="nearest")
    sx = ndimage.correlate(z, xk, mode="nearest")
    sy = ndimage.correlate(z, yk, mode="nearest")
    szz = ndimage.correlate(z * z, ones, mode="nearest")
    ss = szz - s * s / n - sx * sx / sxx - sy * sy / sxx
    rms = np.sqrt(np.maximum(ss, 0.0) / n)
    bad = ndimage.correlate((~finite).astype(np.float64), ones, mode="nearest") > 0
    rms[bad] = np.inf
    # A window that runs off the grid is not a fit; call those cells not planar.
    rms[:k, :] = rms[-k:, :] = np.inf
    rms[:, :k] = rms[:, -k:] = np.inf
    return rms


def roof_labels(dom, dtm, cell=1.0, min_height=MIN_HEIGHT_M, plane_rms_m=PLANE_RMS_M,
                min_area=MIN_AREA_M2):
    """(labels, count): candidate roof components of at least `min_area`, eaves grown back."""
    ndsm = np.asarray(dom, dtype=np.float64) - np.asarray(dtm, dtype=np.float64)
    high = np.isfinite(ndsm) & (ndsm > min_height)
    planar = high & (plane_rms(dom) < plane_rms_m)
    closed = ndimage.binary_closing(planar, structure=np.ones((3, 3), dtype=bool)) & high
    labels, count = ndimage.label(closed, structure=_CROSS)
    if count == 0:
        return labels, 0
    areas = np.bincount(labels.ravel()) * cell * cell
    keep = areas >= min_area
    keep[0] = False
    remap = np.zeros(count + 1, dtype=np.int32)
    remap[keep] = np.arange(1, int(keep.sum()) + 1, dtype=np.int32)
    labels = remap[labels]
    grown = ndimage.grey_dilation(labels, footprint=np.ones((3, 3), dtype=bool))
    labels = np.where(labels > 0, labels, np.where(high & (grown > 0), grown, 0)).astype(np.int32)
    return labels, int(keep.sum())


def component_polygons(labels, transform):
    """{label: shapely polygon (largest part, grid coordinates)} of a label raster."""
    from rasterio.features import shapes

    parts = {}
    for geom, value in shapes(labels.astype(np.int32), mask=labels > 0, transform=transform,
                              connectivity=4):
        value = int(value)
        parts.setdefault(value, []).append(shape(geom))
    out = {}
    for value, polys in parts.items():
        merged = unary_union(polys)
        if merged.geom_type == "MultiPolygon":
            merged = max(merged.geoms, key=lambda p: p.area)
        out[value] = merged
    return out


@dataclass
class Building:
    """One segmented building, in grid coordinates."""

    label: int
    polygon: object           # simplified footprint (exterior only, CCW)
    raw: object               # the component's own outline
    ground: float
    roof: float
    area: float
    points: list = field(default_factory=list)
    type: int = 0
    residential: bool = False
    house: bool = False


def _primary_point(building):
    centroid = building.raw.centroid

    def rank(p):
        inside = building.raw.contains(Point(p.e, p.n))
        return (not inside, p.type not in RESIDENTIAL,
                round(centroid.distance(Point(p.e, p.n)), 6), p.type)
    return min(building.points, key=rank)


def segment(dom, dtm, grid, points, *, within=None, return_labels=False):
    """Buildings from surface and terrain mosaics on `grid`, anchored to register `points`.

    `within` is (e0, n0, radius): only buildings whose centroid lies within it
    are kept, and only points within it are counted. Returns (buildings, stats),
    or (buildings, stats, labels) with the raster of every roof candidate,
    anchored or not, when `return_labels`.
    """
    labels, candidates = roof_labels(dom, dtm, grid.cell)
    polygons = component_polygons(labels, grid.transform) if candidates else {}
    order = sorted(polygons)
    raws = [polygons[k] for k in order]
    pts = list(points)
    if within is not None:
        e0, n0, radius = within
        pts = [p for p in pts if (p.e - e0) ** 2 + (p.n - n0) ** 2 <= radius * radius]
    assigned = {}
    unmatched = 0
    if raws:
        tree = STRtree(raws)
        for p in pts:
            here = Point(p.e, p.n)
            hits = tree.query(here, predicate="dwithin", distance=ANCHOR_M)
            if len(hits) == 0:
                unmatched += 1
                continue
            best = min(hits, key=lambda idx: (raws[idx].distance(here), idx))
            assigned.setdefault(int(best), []).append(p)
    else:
        unmatched = len(pts)
    flat_labels = labels.ravel()
    dom_flat = np.asarray(dom, dtype=np.float64).ravel()
    dtm_flat = np.asarray(dtm, dtype=np.float64).ravel()
    index = np.argsort(flat_labels, kind="stable")
    sorted_labels = flat_labels[index]
    buildings = []
    outside = 0
    for idx, label in enumerate(order):
        if idx not in assigned:
            continue
        raw = raws[idx]
        if within is not None:
            c = raw.centroid
            if (c.x - within[0]) ** 2 + (c.y - within[1]) ** 2 > within[2] ** 2:
                outside += 1
                continue
        lo = np.searchsorted(sorted_labels, label, side="left")
        hi = np.searchsorted(sorted_labels, label, side="right")
        cells = index[lo:hi]
        b = Building(label=label, polygon=footprint(raw), raw=raw,
                     ground=float(np.median(dtm_flat[cells])),
                     roof=float(np.percentile(dom_flat[cells], 90)),
                     area=float(len(cells) * grid.cell * grid.cell),
                     points=assigned[idx])
        primary = _primary_point(b)
        b.type = int(primary.type)
        b.residential = any(p.type in RESIDENTIAL for p in b.points)
        buildings.append(b)
    statuses = {}
    for p in pts:
        statuses[str(p.status)] = statuses.get(str(p.status), 0) + 1
    stats = {
        "register_points": len(pts),
        "register_points_by_status": dict(sorted(statuses.items())),
        "roof_candidates": candidates,
        "buildings": len(buildings),
        "candidates_without_register_point": candidates - len(assigned),
        "register_points_without_roof": unmatched,
        "register_points_matched": sum(len(b.points) for b in buildings),
        "buildings_outside_radius": outside,
    }
    if return_labels:
        return buildings, stats, labels
    return buildings, stats


def footprint(raw):
    """A component outline simplified to SIMPLIFY_M, holes dropped, counter-clockwise."""
    simple = raw.simplify(SIMPLIFY_M, preserve_topology=True)
    if simple.geom_type == "MultiPolygon":
        simple = max(simple.geoms, key=lambda p: p.area)
    if simple.is_empty or simple.area <= 0 or simple.geom_type != "Polygon":
        simple = raw
    return orient(type(simple)(simple.exterior), sign=1.0)


def choose_house(buildings, parcel_polygons, address_en):
    """Mark the listing's house; return a stats dict saying what was chosen and why."""
    for b in buildings:
        b.house = False
    if not parcel_polygons:
        return {"house": False, "note": "no registered parcel to look in"}
    parcel = unary_union(parcel_polygons)
    here = Point(*address_en)
    candidates = []
    for b in buildings:
        inside = b.polygon.intersection(parcel).area / b.polygon.area if b.polygon.area else 0.0
        if inside >= HOUSE_MIN_INSIDE and b.residential:
            candidates.append(b)
    if not candidates:
        in_parcel = sum(1 for b in buildings
                        if b.polygon.area and b.polygon.intersection(parcel).area
                        / b.polygon.area >= HOUSE_MIN_INSIDE)
        return {"house": False, "buildings_in_parcel": in_parcel,
                "note": "no building with a dwelling register point (type 111-199 except "
                        "181-183) and a surface-model footprint lies inside the registered "
                        "parcel"}
    best = min(candidates, key=lambda b: (round(b.polygon.distance(here), 6), -b.area))
    best.house = True
    note = "the one dwelling inside the registered parcel"
    if len(candidates) > 1:
        note = ("{} dwellings inside the registered parcel; the one nearest the "
                "address point was marked".format(len(candidates)))
    return {"house": True, "candidates": len(candidates),
            "distance_to_address_m": round(best.polygon.distance(here), 1), "note": note}


def buildings_record(buildings, origin, shapes=None):
    """The buildings.json object of FORMAT.md section 4, sorted north to south, west to east.

    `shapes`, when given, is {label: roof_shape} from commons_world.roofs; a building
    with an entry gets it as its `roof_shape`. Nothing else in a feature depends on it."""
    def key(b):
        c = b.polygon.centroid
        return (round(-c.y, 3), round(c.x, 3))
    features = []
    for number, b in enumerate(sorted(buildings, key=key), start=1):
        feature = {
            "id": number, "type": int(b.type), "source": "dom",
            "ground": round(b.ground, 1), "roof": round(b.roof, 1), "house": bool(b.house),
            "ring": ring_local(b.polygon.exterior.coords, origin),
        }
        if shapes is not None and b.label in shapes:
            feature["roof_shape"] = shapes[b.label]
        features.append(feature)
    return {"version": 1, "features": features}


def ring_signed_area_local(ring):
    """Shoelace area of a local [[x, z]] ring in (x, north) terms: positive = counter-clockwise."""
    pts = np.asarray(ring, dtype=np.float64)
    x, north = pts[:, 0], -pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(north, -1) - np.roll(x, -1) * north))


@dataclass
class H1Surface:
    """The h1 terrain and surface mosaics, shared by buildings and trees."""

    grid: object
    dtm: np.ndarray
    dom: np.ndarray
    footprints: list = field(default_factory=list)
    roofs: object = None       # boolean raster: every roof candidate, anchored or not

    @property
    def ndsm(self):
        return self.dom.astype(np.float64) - self.dtm.astype(np.float64)
