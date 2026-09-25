"""NVDB Vegnett Pluss: road, footway and cycleway centre lines, per municipality.

Downloaded through Geonorge's download API (commons_world.download). The
dataset is offered only in EPSG:5973 (EUREF89 UTM 33 + NN2000, with a height
per vertex), so lines are reprojected into the world's grid and the heights
dropped. Only Veglenke features are read.

What the GML looked like on 25 Sept 2026 (namespace
https://skjema.geonorge.no/SOSI/produktspesifikasjon/NVDBVegnettPluss/1.1):
- typeVeg: bilveg, kanalveg, rkj, gsv, gangveg, fortau, gangfelt, trapp,
  and in a city municipality also rampe, gatetun, gagate, sti, sv and tv
  (others are mapped below from the product's naming and counted if unseen).
  "sv" and "tv" are the only short codes left for the product's sykkelveg
  (cycleway) and traktorveg (tractor road), and they fit: sv lines carry the
  road categories that cycleways alongside roads do, tv lines carry S (forest
  road) or none. They map to footway and path;
- detaljnivaa: VTKB (road line and carriageway are the same line), KB
  (one carriageway of a divided road), KF (a lane), VT (the centre of a
  divided road, between its carriageways);
- konnekteringslenke: true for short technical links that join the network;
- medium: absent on the ground, U underground (tunnel), L in the air (bridge);
- vegsystemreferanse/.../vegkategori: E, R, F, K, P or S (forest road);
  footways often carry none.

Rules applied here:
- VT lines and connection links are skipped: the carriageways are drawn
  instead, and connection links are not road surface;
- ferries are skipped;
- every other type maps to a kind: "road" (driveable), "footway" or "path".
  Unknown types are skipped and counted by name in the build stats.

Paths and tractor tracks are not in Vegnett Pluss; they come from N50 and
Turrutebasen.
"""

from dataclasses import dataclass, field

from . import gml
from .n50 import Line

ROAD_KINDS = {
    "bilveg": "road",
    "enkelBilveg": "road",
    "kanalveg": "road",
    "kanalisertVeg": "road",
    "rkj": "road",
    "rundkj\u00f8ring": "road",
    "rampe": "road",
    "gatetun": "road",
    "gsv": "footway",
    "gangOgSykkelveg": "footway",
    "gangveg": "footway",
    "sykkelveg": "footway",
    "fortau": "footway",
    "gangfelt": "footway",
    "trapp": "footway",
    "gagate": "footway",
    "g\u00e5gate": "footway",
    "sv": "footway",
    "sti": "path",
    "tv": "path",
    "traktorveg": "path",
}
SKIPPED_TYPES = ("bilferje", "passasjerferje", "ferje")
SKIPPED_DETAIL = ("VT",)


@dataclass
class NVDBData:
    lines: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    skipped: dict = field(default_factory=dict)
    unknown_types: dict = field(default_factory=dict)

    def extend(self, other):
        self.lines += other.lines
        for target, source in ((self.counts, other.counts), (self.skipped, other.skipped),
                               (self.unknown_types, other.unknown_types)):
            for key, value in source.items():
                target[key] = target.get(key, 0) + value

    def stats(self):
        return {"lines": len(self.lines), "by_type": dict(sorted(self.counts.items())),
                "skipped": dict(sorted(self.skipped.items())),
                "unknown_types": dict(sorted(self.unknown_types.items()))}


def _bump(counter, key):
    counter[key] = counter.get(key, 0) + 1


def parse(source, clip=None, epsg=25832, data=None, keep_connections=False):
    """Read one Vegnett Pluss GML file; keep Veglenke lines that reach `clip`, in `epsg`.

    With keep_connections, connection links are kept too (their source_type
    gets " connection"): they are not road surface, so the class band leaves
    them out, but a walking network needs them to join footways to roads.
    """
    data = data if data is not None else NVDBData()
    reproject = gml.Reprojector(epsg)
    for feature in gml.iter_features(source):
        if gml.local(feature.tag) != "Veglenke":
            continue
        road_type = gml.text(feature, "typeVeg") or ""
        _bump(data.counts, road_type)
        if road_type in SKIPPED_TYPES:
            _bump(data.skipped, "ferry")
            continue
        kind = ROAD_KINDS.get(road_type)
        if kind is None:
            _bump(data.unknown_types, road_type)
            continue
        connection = (gml.text(feature, "konnekteringslenke") or "").lower() == "true"
        if connection and not keep_connections:
            _bump(data.skipped, "connection link")
            continue
        if (gml.text(feature, "detaljniv\u00e5") or "") in SKIPPED_DETAIL:
            _bump(data.skipped, "VT centre of a divided road")
            continue
        geom = gml.geometry(feature)
        if geom is None or geom.kind != "line":
            continue
        geom = reproject.geometry(geom)
        if clip is not None and not gml.bounds_overlap(geom.bounds(), clip):
            continue
        category = gml.text(feature, "vegsystemreferanse", "Vegsystemreferanse", "vegsystem",
                            "Vegsystem", "vegkategori") or None
        medium = gml.text(feature, "medium") or None
        for part in geom.parts:
            data.lines.append(Line(kind=kind, coords=part, category=category, medium=medium,
                                   source="nvdb",
                                   source_type=road_type + (" connection" if connection else "")))
    return data


def parse_zip(content, clip=None, epsg=25832, data=None, keep_connections=False):
    """Read every GML file in a Vegnett Pluss municipality zip."""
    from .download import zip_members

    data = data if data is not None else NVDBData()
    for _, fh in zip_members(content, ".gml"):
        parse(fh, clip=clip, epsg=epsg, data=data, keep_connections=keep_connections)
    return data
