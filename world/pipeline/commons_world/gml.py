"""Small GML helpers shared by the N50, NVDB and WFS readers.

- `iter_features` walks a GML or WFS document with lxml's iterparse and yields
  each feature element (the child of a gml:featureMember or wfs:member), then
  frees it, so a large municipality file never sits in memory whole.
- `geometry` reads the first geometry under an element into plain numpy
  arrays: points, lines, or polygons with holes.
- `Reprojector` moves coordinates into the world's grid when a file is in
  another one (NVDB Vegnett Pluss comes in EUREF89 UTM 33 + NN2000 only).

Entities are never resolved and nothing is fetched while parsing.
"""

import re

import numpy as np
from pyproj import Transformer

GML_NS = "http://www.opengis.net/gml/3.2"
WFS_NS = "http://www.opengis.net/wfs/2.0"

_MEMBER_TAGS = ("{%s}featureMember" % GML_NS, "{%s}featureMembers" % GML_NS,
                "{%s}member" % WFS_NS)

# Compound (grid + NN2000 height) codes and the horizontal grid each one uses.
HORIZONTAL_EPSG = {5972: 25832, 5973: 25833, 5975: 25835}

_EPSG_RE = re.compile(r"EPSG(?::|/0/|::)+(\d+)\s*$", re.IGNORECASE)


class GMLError(ValueError):
    """The document is not the GML this reader expects."""


def local(tag):
    """The local part of a namespaced tag ("{ns}name" -> "name")."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def find(element, name):
    """First descendant (depth first) whose local name is `name`, or None."""
    for child in element.iter():
        if child is not element and local(child.tag) == name:
            return child
    return None


def child(element, name):
    """First direct child whose local name is `name`, or None."""
    for c in element:
        if local(c.tag) == name:
            return c
    return None


def text(element, *path):
    """Stripped text at the chain of local names below `element`, or None.

    Each step prefers a direct child and falls back to any descendant.
    """
    current = element
    for name in path:
        found = child(current, name)
        if found is None:
            found = find(current, name)
        if found is None:
            return None
        current = found
    value = (current.text or "").strip()
    return value


def epsg_of(srs_name):
    """EPSG code from an srsName (urn:ogc:def:crs:EPSG::25832, .../EPSG/0/5973, EPSG:25832)."""
    if not srs_name:
        return None
    match = _EPSG_RE.search(srs_name.strip())
    return int(match.group(1)) if match else None


def horizontal_epsg(epsg):
    """The horizontal grid of a code: 5973 -> 25833; anything else unchanged."""
    return HORIZONTAL_EPSG.get(epsg, epsg)


def iter_features(source, huge_tree=True):
    """Yield every feature element of a GML/WFS document, freeing each after use.

    `source` is a path or a binary file object.
    """
    from lxml import etree

    context = etree.iterparse(source, events=("end",), tag=_MEMBER_TAGS,
                              resolve_entities=False, no_network=True, huge_tree=huge_tree,
                              remove_comments=True)
    for _, member in context:
        for feature in list(member):
            if isinstance(feature.tag, str):
                yield feature
        member.clear()
        parent = member.getparent()
        if parent is not None:
            while member.getprevious() is not None:
                del parent[0]


def _dimension(element, default):
    node = element
    while node is not None:
        dim = node.get("srsDimension")
        if dim:
            return int(dim)
        node = node.getparent()
    return default


def _srs(element):
    node = element
    while node is not None:
        name = node.get("srsName")
        if name:
            return name
        node = node.getparent()
    return None


def _coords(element, default_dim):
    """(n, 2) float64 array from a gml:posList or gml:pos (x, y only)."""
    raw = (element.text or "").split()
    dim = _dimension(element, default_dim)
    if not raw:
        return np.zeros((0, 2), dtype=np.float64)
    values = np.asarray(raw, dtype=np.float64)
    if values.size % dim:
        raise GMLError("coordinate list of {} values is not a multiple of {}".format(
            values.size, dim))
    return values.reshape(-1, dim)[:, :2]


def _ring(ring_parent, default_dim):
    pos_list = find(ring_parent, "posList")
    if pos_list is not None:
        return _coords(pos_list, default_dim)
    points = [_coords(p, default_dim) for p in ring_parent.iter() if local(p.tag) == "pos"]
    return np.vstack(points) if points else np.zeros((0, 2))


class Geometry:
    """One feature's geometry: kind is "point", "line" or "polygon".

    - point: `parts` is [array (1, 2)]
    - line: `parts` is [array (n, 2)] (one per line string)
    - polygon: `parts` is [(exterior (n, 2), [holes (m, 2)])] (one per patch)
    """

    def __init__(self, kind, parts, epsg):
        self.kind = kind
        self.parts = parts
        self.epsg = epsg

    def bounds(self):
        arrays = []
        for part in self.parts:
            arrays.append(part[0] if self.kind == "polygon" else part)
        allc = np.vstack(arrays)
        return (float(allc[:, 0].min()), float(allc[:, 1].min()),
                float(allc[:, 0].max()), float(allc[:, 1].max()))


_GEOMETRY_TAGS = {"Point", "LineString", "Curve", "Surface", "Polygon", "MultiSurface",
                  "MultiCurve", "MultiPoint", "MultiLineString", "MultiPolygon"}


def geometry(element, default_epsg=None):
    """The first geometry below `element` as a Geometry, or None if there is none."""
    geom = None
    for node in element.iter():
        if node is not element and local(node.tag) in _GEOMETRY_TAGS:
            geom = node
            break
    if geom is None:
        return None
    epsg = epsg_of(_srs(geom)) or default_epsg
    default_dim = 3 if epsg in HORIZONTAL_EPSG else 2
    kind = local(geom.tag)
    if kind in ("Point", "MultiPoint"):
        parts = [_coords(p, default_dim) for p in geom.iter() if local(p.tag) == "pos"]
        return Geometry("point", parts, epsg) if parts else None
    if kind in ("LineString", "Curve", "MultiCurve", "MultiLineString"):
        parts = [_coords(p, default_dim) for p in geom.iter() if local(p.tag) == "posList"]
        parts = [p for p in parts if len(p) >= 2]
        return Geometry("line", parts, epsg) if parts else None
    parts = []
    for patch in geom.iter():
        if local(patch.tag) not in ("PolygonPatch", "Polygon"):
            continue
        exterior = child(patch, "exterior")
        if exterior is None:
            continue
        holes = [_ring(h, default_dim) for h in patch if local(h.tag) == "interior"]
        parts.append((_ring(exterior, default_dim), [h for h in holes if len(h) >= 4]))
    parts = [p for p in parts if len(p[0]) >= 4]
    return Geometry("polygon", parts, epsg) if parts else None


class Reprojector:
    """Moves Geometry coordinates into `target_epsg` (horizontal only), with caching."""

    def __init__(self, target_epsg):
        self.target = int(target_epsg)
        self._transformers = {}

    def _transformer(self, source):
        if source not in self._transformers:
            self._transformers[source] = Transformer.from_crs(source, self.target,
                                                              always_xy=True)
        return self._transformers[source]

    def coords(self, array, epsg):
        """(n, 2) array from `epsg` (or its horizontal part) into the target grid."""
        source = horizontal_epsg(epsg) if epsg is not None else self.target
        if source == self.target:
            return array
        x, y = self._transformer(source).transform(array[:, 0], array[:, 1])
        return np.column_stack([x, y])

    def geometry(self, geom):
        """The same Geometry in the target grid."""
        if geom is None or horizontal_epsg(geom.epsg or self.target) == self.target:
            if geom is not None:
                geom.epsg = self.target
            return geom
        if geom.kind == "polygon":
            parts = [(self.coords(ext, geom.epsg), [self.coords(h, geom.epsg) for h in holes])
                     for ext, holes in geom.parts]
        else:
            parts = [self.coords(p, geom.epsg) for p in geom.parts]
        return Geometry(geom.kind, parts, self.target)


def bounds_overlap(a, b):
    """True when two (west, south, east, north) boxes overlap or touch."""
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]
