"""N50 Kartdata (Kartverket, 1:50 000), read from the per-municipality GML download.

What the world uses from it:
- Arealdekke: land-cover polygons, lakes and rivers, as class codes of
  world/FORMAT.md section 3 (table below);
- Arealdekke: stream centre lines (ElvBekk), drawn as narrow rivers at h1;
- Samferdsel: paths and tractor tracks (typeVeg sti, traktorveg) for class 9.
  Its roads are only a fallback for when NVDB cannot be read;
- Hoyde: spot heights (Terrengpunkt, TrigonometriskPunkt), to cross-check
  place heights sampled from the terrain model;
- BygningerOgAnlegg: building points with their type code (parsed and
  counted; the building layer itself uses the Matrikkel register's points).

N50's element names carry Norwegian letters; they are written with \\u
escapes here so this file stays ASCII.

Land-cover class table (N50 object type -> FORMAT.md code, and the tier it is
painted in; tiers are painted lowest first, see commons_world/classes.py):

| N50 type                    | Code | Tier       | Why |
|-----------------------------|------|------------|-----|
| Skog                        | 1    | landcover  | forest |
| Myr                         | 2    | landcover  | bog, marsh |
| DyrketMark                  | 3    | landcover  | farmland |
| Tettbebyggelse              | 6    | landcover  | built-up area |
| BymessigBebyggelse          | 6    | landcover  | town centre |
| Industriomraade             | 6    | landcover  | industrial area |
| Lufthavn, Rullebane         | 6    | landcover  | airport, runway: paved and built |
| AapentOmraade               | 0    | landcover  | see below |
| SportIdrettPlass            | 0    | landcover  | sports ground: open, mostly grass |
| Golfbane, Park, Gravplass   | 0    | landcover  | grass and paths, not built-up |
| Alpinbakke                  | 0    | landcover  | a cleared slope |
| SnoeIsbre                   | 11   | landcover  | snow, glacier |
| Steinbrudd, Steintipp       | 13   | landcover  | quarry, spoil heap |
| FerskvannToerrfall          | 13   | landcover  | exposed bed of a regulated lake |
| Innsjoe, InnsjoeRegulert    | 4    | water      | lake, regulated lake |
| Elv                         | 4    | water      | river drawn as an area |
| ElvBekk (line)              | 4    | stream     | stream centre line (h1 only) |
| Havflate                    | 5    | sea        | only where the terrain is at or below 0 m |

- AapentOmraade ("open area") is N50's residual class: land that is not
  forest, bog, farmland, water or built-up. On the coast that is mostly heath,
  grass and bare rock mixed; in the mountains mostly rock and heath. N50 does
  not say which, so it maps to 0 ("open land, unknown") rather than 10 ("bare
  rock"), which would be a claim the data does not make.
- Havflate is not painted on land: FORMAT.md takes sea from the terrain
  (sample <= 0 m), which at 1 m is far sharper than N50's generalised
  coastline, and painting N50's sea would put sea on dry ground wherever
  that coastline is simplified.
- Any other area type maps to 0 and is counted under "unknown" in the build
  stats, by name, so a new type shows up in the manifest.
"""

from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import LineString, Polygon

from . import gml

TIER_LANDCOVER = "landcover"
TIER_WATER = "water"
TIER_SEA = "sea"

AREA_CLASSES = {
    "Skog": (1, TIER_LANDCOVER),
    "Myr": (2, TIER_LANDCOVER),
    "DyrketMark": (3, TIER_LANDCOVER),
    "Tettbebyggelse": (6, TIER_LANDCOVER),
    "BymessigBebyggelse": (6, TIER_LANDCOVER),
    "Industriomr\u00e5de": (6, TIER_LANDCOVER),
    "Lufthavn": (6, TIER_LANDCOVER),
    "Rullebane": (6, TIER_LANDCOVER),
    "\u00c5pentOmr\u00e5de": (0, TIER_LANDCOVER),
    "SportIdrettPlass": (0, TIER_LANDCOVER),
    "Golfbane": (0, TIER_LANDCOVER),
    "Park": (0, TIER_LANDCOVER),
    "Gravplass": (0, TIER_LANDCOVER),
    "Alpinbakke": (0, TIER_LANDCOVER),
    "Sn\u00f8Isbre": (11, TIER_LANDCOVER),
    "Steinbrudd": (13, TIER_LANDCOVER),
    "Steintipp": (13, TIER_LANDCOVER),
    "FerskvannT\u00f8rrfall": (13, TIER_LANDCOVER),
    "Innsj\u00f8": (4, TIER_WATER),
    "Innsj\u00f8Regulert": (4, TIER_WATER),
    "Elv": (4, TIER_WATER),
    "Havflate": (5, TIER_SEA),
}
STREAM_TYPES = ("ElvBekk",)

# Samferdsel typeVeg -> line kind (see commons_world/nvdb.py for the kinds).
N50_ROAD_KINDS = {
    "enkelBilveg": "road",
    "kanalisertVeg": "road",
    "rampe": "road",
    "rundkj\u00f8ring": "road",
    "gangOgSykkelveg": "footway",
    "gangveg": "footway",
    "sykkelveg": "footway",
    "fortau": "footway",
    "sti": "path",
    "traktorveg": "path",
}
N50_SKIPPED_ROAD_TYPES = ("bilferje", "passasjerferje")

SPOT_HEIGHT_TYPES = ("Terrengpunkt", "TrigonometriskPunkt")


@dataclass
class Area:
    """A land-cover, water or sea polygon with its class code."""

    code: int
    tier: str
    polygon: Polygon
    source_type: str


@dataclass
class Line:
    """A centre line: road, footway, path or stream, in the world's grid.

    kind: "road" (driveable), "footway", "path" or "stream".
    category: NVDB vegkategori (E, R, F, K, P, S) or None.
    medium: SOSI medium: None or "T" on the ground, "L" in the air (bridge),
    "U" underground (tunnel), and others; see classes.py for how each is drawn.
    """

    kind: str
    coords: np.ndarray
    category: object = None
    medium: object = None
    source: str = ""
    source_type: str = ""

    def geometry(self):
        return LineString(self.coords)


@dataclass
class SpotHeight:
    kind: str
    e: float
    n: float
    h: float


@dataclass
class BuildingPoint:
    """A building point: register type code, and optionally number and status."""

    type: int
    e: float
    n: float
    number: object = None
    status: object = None
    source: str = ""


@dataclass
class N50Data:
    areas: list = field(default_factory=list)
    lines: list = field(default_factory=list)
    spot_heights: list = field(default_factory=list)
    buildings: list = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    unknown_area_types: dict = field(default_factory=dict)
    unknown_road_types: dict = field(default_factory=dict)

    def extend(self, other):
        self.areas += other.areas
        self.lines += other.lines
        self.spot_heights += other.spot_heights
        self.buildings += other.buildings
        for target, source in ((self.counts, other.counts),
                               (self.unknown_area_types, other.unknown_area_types),
                               (self.unknown_road_types, other.unknown_road_types)):
            for key, value in source.items():
                target[key] = target.get(key, 0) + value

    def stats(self):
        return {"areas": len(self.areas), "lines": len(self.lines),
                "spot_heights": len(self.spot_heights), "building_points": len(self.buildings),
                "features_by_type": dict(sorted(self.counts.items())),
                "unknown_area_types": dict(sorted(self.unknown_area_types.items())),
                "unknown_road_types": dict(sorted(self.unknown_road_types.items()))}


def _bump(counter, key):
    counter[key] = counter.get(key, 0) + 1


def _polygons(geom):
    out = []
    for exterior, holes in geom.parts:
        poly = Polygon(exterior, holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if not poly.is_empty and poly.area > 0:
            if poly.geom_type == "MultiPolygon":
                out.extend(poly.geoms)
            else:
                out.append(poly)
    return out


def parse(source, clip=None, epsg=25832, data=None, count_unknown=True):
    """Read one N50 GML file into an N50Data, keeping only features within `clip`.

    `clip` is (west, south, east, north) in `epsg`; None keeps everything.
    Coordinates in another grid are reprojected into `epsg`. Polygon features
    of a type not in AREA_CLASSES are counted as unknown when `count_unknown`
    (parse_zip sets it for the Arealdekke theme only).
    """
    data = data if data is not None else N50Data()
    reproject = gml.Reprojector(epsg)
    for feature in gml.iter_features(source):
        name = gml.local(feature.tag)
        _bump(data.counts, name)
        if name in AREA_CLASSES or name in STREAM_TYPES or name in SPOT_HEIGHT_TYPES \
                or name in ("Veglenke", "Bygning"):
            geom = reproject.geometry(gml.geometry(feature))
        else:
            if count_unknown and (gml.find(feature, "Surface") is not None
                                  or gml.find(feature, "Polygon") is not None):
                _bump(data.unknown_area_types, name)
            continue
        if geom is None:
            continue
        if clip is not None and not gml.bounds_overlap(geom.bounds(), clip):
            continue
        if name in AREA_CLASSES and geom.kind == "polygon":
            code, tier = AREA_CLASSES[name]
            for poly in _polygons(geom):
                data.areas.append(Area(code=code, tier=tier, polygon=poly, source_type=name))
        elif name in STREAM_TYPES and geom.kind == "line":
            for part in geom.parts:
                data.lines.append(Line(kind="stream", coords=part, source="n50",
                                       source_type=name))
        elif name in SPOT_HEIGHT_TYPES and geom.kind == "point":
            height = gml.text(feature, "h\u00f8yde")
            if height not in (None, ""):
                e, n = geom.parts[0][0]
                data.spot_heights.append(SpotHeight(kind=name, e=float(e), n=float(n),
                                                    h=float(height)))
        elif name == "Veglenke" and geom.kind == "line":
            road_type = gml.text(feature, "typeVeg") or ""
            kind = N50_ROAD_KINDS.get(road_type)
            if kind is None:
                if road_type not in N50_SKIPPED_ROAD_TYPES:
                    _bump(data.unknown_road_types, road_type)
                continue
            category = gml.text(feature, "vegsystem", "Vegsystem", "vegkategori") or None
            medium = gml.text(feature, "medium") or None
            for part in geom.parts:
                data.lines.append(Line(kind=kind, coords=part, category=category, medium=medium,
                                       source="n50", source_type=road_type))
        elif name == "Bygning":
            code = gml.text(feature, "bygningstype")
            if geom.kind == "point":
                e, n = geom.parts[0][0]
            else:
                polys = _polygons(geom)
                if not polys:
                    continue
                centre = polys[0].representative_point()
                e, n = centre.x, centre.y
            data.buildings.append(BuildingPoint(type=int(code) if code and code.isdigit() else 0,
                                                e=float(e), n=float(n), source="n50"))
    return data


# The themes of the N50 zip that are read; the others (administrative areas,
# restricted areas, place-name text) are skipped.
THEMES = ("Arealdekke", "Samferdsel", "Hoyde", "BygningerOgAnlegg")


def theme_of(member_name):
    """The N50 theme a zip member holds ("..._N50Arealdekke_GML.gml" -> "Arealdekke")."""
    for theme in THEMES:
        if "N50" + theme in member_name:
            return theme
    return None


def parse_zip(content, clip=None, epsg=25832, data=None):
    """Read the themes this world uses from an N50 municipality zip."""
    from .download import zip_members

    data = data if data is not None else N50Data()
    for name, fh in zip_members(content, ".gml"):
        theme = theme_of(name)
        if theme is None:
            continue
        parse(fh, clip=clip, epsg=epsg, data=data, count_unknown=(theme == "Arealdekke"))
    return data


def roads(data):
    """The driveable roads and footways among the N50 lines (the NVDB fallback)."""
    return [line for line in data.lines if line.kind in ("road", "footway")]


def paths(data):
    """Paths and tractor tracks (class 9)."""
    return [line for line in data.lines if line.kind == "path"]
