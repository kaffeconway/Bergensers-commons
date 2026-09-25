"""Address point and registered parcel, from Kartverket's open APIs.

- `geocode`: the Adresse API (api.kartverket.no/adresser/v1/sok), which gives
  the address point and the property number (kommune, gnr, bnr, festenr);
- `parcels`: the Eiendom API's geokoding with omrade=true, which gives the
  parcel polygons (teiger) and their boundary accuracy class;
- `register_area`: the Matrikkelen teig WFS, the only open source of the
  register's own stored area (lagretBeregnetAreal).

Geometry and areas only. Owner data lives behind restricted services this
module never calls, and fields these services do return beyond geometry,
identifiers and areas are read past, not kept.
"""

import re
from dataclasses import dataclass

from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

ADDRESS_SEARCH = "https://api.kartverket.no/adresser/v1/sok"
EIENDOM_GEOKODING = "https://api.kartverket.no/eiendom/v1/geokoding"
TEIG_WFS = "https://wfs.geonorge.no/skwms1/wfs.matrikkelen-eiendomskart-teig"
TEIG_NAMESPACE = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Eiendomskart-Teig/20211101"

_ADDRESS_RE = re.compile(
    r"^\s*(?P<street>.+?)\s+(?P<number>\d+)\s*(?P<letter>[A-Za-z]?)\s*,\s*"
    r"(?P<postcode>\d{4})\s+(?P<place>.+?)\s*$")


class GeocodeError(ValueError):
    """The address did not resolve to exactly one address point."""


class ParcelError(ValueError):
    """The parcel services did not answer as expected."""


@dataclass(frozen=True)
class Address:
    street: str
    number: int
    letter: str
    postcode: str
    place: str


@dataclass(frozen=True)
class Geocode:
    """One address point and the property it belongs to."""

    lat: float
    lon: float
    kommunenummer: str
    gnr: int
    bnr: int
    festenr: int
    placement_verified: object  # True, False, or None if the register does not say
    source: str = "Kartverket Adresse API (api.kartverket.no/adresser/v1)"

    @property
    def property_text(self):
        """Property number as text: kommune-gnr/bnr, with /festenr when there is one."""
        text = "{}-{}/{}".format(self.kommunenummer, self.gnr, self.bnr)
        return text + ("/{}".format(self.festenr) if self.festenr else "")


@dataclass
class Parcel:
    """One teig: its polygon in the grid, and what the register says about it."""

    polygon: Polygon
    accuracy_class: object
    teig_id: object
    main: object


def parse_address(text):
    """Split 'Street 12B, 1234 Place' into its parts, or raise GeocodeError."""
    match = _ADDRESS_RE.match(text or "")
    if not match:
        raise GeocodeError("address {!r} is not in the form 'Street 12B, 1234 Place'".format(text))
    return Address(street=" ".join(match["street"].split()), number=int(match["number"]),
                   letter=match["letter"].upper(), postcode=match["postcode"],
                   place=" ".join(match["place"].split()))


def _describe(hit):
    return "{}, {} {} (kommune {}, gnr {} / bnr {})".format(
        hit.get("adressetekst"), hit.get("postnummer"), hit.get("poststed"),
        hit.get("kommunenummer"), hit.get("gardsnummer"), hit.get("bruksnummer"))


def geocode(client, address_text, country="NO"):
    """Resolve an address to exactly one address point, or fail listing the candidates."""
    if country != "NO":
        raise NotImplementedError("geocoding is only implemented for Norway (country NO)")
    address = parse_address(address_text)
    params = {"sok": "{} {}{}".format(address.street, address.number, address.letter),
              "postnummer": address.postcode, "treffPerSide": 10}
    resp = client.get(ADDRESS_SEARCH, params=params).raise_for_status()
    hits = resp.json().get("adresser") or []
    matching = [h for h in hits
                if h.get("nummer") == address.number
                and (h.get("bokstav") or "").upper() == address.letter
                and " ".join(str(h.get("adressenavn", "")).split()).casefold()
                == address.street.casefold()]
    if len(matching) != 1:
        found = "\n".join("  - " + _describe(h) for h in hits[:10]) or "  (none)"
        raise GeocodeError("address {!r} matched {} address points, need exactly one. "
                           "The search returned:\n{}".format(address_text, len(matching), found))
    hit = matching[0]
    point = hit.get("representasjonspunkt") or {}
    if str(point.get("epsg", "")).upper() not in ("EPSG:4258", "4258"):
        raise GeocodeError("address point is in {}, expected EPSG:4258".format(point.get("epsg")))
    verified = hit.get("stedfestingverifisert")
    return Geocode(lat=float(point["lat"]), lon=float(point["lon"]),
                   kommunenummer=str(hit["kommunenummer"]), gnr=int(hit["gardsnummer"]),
                   bnr=int(hit["bruksnummer"]), festenr=int(hit.get("festenummer") or 0),
                   placement_verified=verified if isinstance(verified, bool) else None)


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _rings(geometry):
    kind = geometry.get("type")
    coords = geometry.get("coordinates") or []
    if kind == "Polygon":
        return [coords]
    if kind == "MultiPolygon":
        return list(coords)
    raise ParcelError("unexpected parcel geometry type {!r}".format(kind))


def parcels(client, kommunenummer, gnr, bnr, epsg, festenr=0):
    """The property's teiger as grid polygons, with accuracy class, id and main-area flag."""
    params = {"kommunenummer": kommunenummer, "gardsnummer": gnr, "bruksnummer": bnr,
              "omrade": "true", "utkoordsys": epsg}
    if festenr:
        params["festenummer"] = festenr
    data = client.get(EIENDOM_GEOKODING, params=params).raise_for_status().json()
    crs_name = str(((data.get("crs") or {}).get("properties") or {}).get("name", ""))
    if crs_name and not crs_name.endswith(str(epsg)):
        raise ParcelError("parcels came back in {}, asked for EPSG:{}".format(crs_name, epsg))
    out = []
    for feature in data.get("features") or []:
        props = feature.get("properties") or {}
        if (str(props.get("kommunenummer")) != str(kommunenummer)
                or _as_int(props.get("gardsnummer")) != int(gnr)
                or _as_int(props.get("bruksnummer")) != int(bnr)
                or (_as_int(props.get("festenummer")) or 0) != int(festenr or 0)):
            continue
        for rings in _rings(feature.get("geometry") or {}):
            polygon = Polygon(rings[0], rings[1:])
            if not polygon.is_valid or polygon.area <= 0:
                raise ParcelError("parcel {} has an invalid polygon".format(props.get("lokalid")))
            out.append(Parcel(polygon=polygon,
                              accuracy_class=props.get("n\u00f8yaktighetsklasseteig"),
                              teig_id=props.get("lokalid"),
                              main=props.get("hovedomr\u00e5de")))
    if not out:
        raise ParcelError("no parcel found for {} {}/{}".format(kommunenummer, gnr, bnr))
    return out


def _teig_filter(kommunenummer, matrikkel_text):
    return (
        '<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:app="{ns}">'
        "<fes:And>"
        "<fes:PropertyIsEqualTo><fes:ValueReference>app:kommunenummer</fes:ValueReference>"
        "<fes:Literal>{k}</fes:Literal></fes:PropertyIsEqualTo>"
        "<fes:PropertyIsEqualTo><fes:ValueReference>app:matrikkelnummerTekst</fes:ValueReference>"
        "<fes:Literal>{m}</fes:Literal></fes:PropertyIsEqualTo>"
        "</fes:And></fes:Filter>").format(ns=TEIG_NAMESPACE, k=kommunenummer, m=matrikkel_text)


def _local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _child_text(element, *path):
    """Text at the chain of local names `path` below `element`, or None.

    Each step prefers a direct child and falls back to any descendant.
    """
    current = element
    for name in path:
        found = next((c for c in current if _local(c.tag) == name), None)
        if found is None:
            found = next((c for c in current.iter() if c is not current
                          and _local(c.tag) == name), None)
        if found is None:
            return None
        current = found
    return (current.text or "").strip()


def parse_teig_areas(content, kommunenummer, matrikkel_text):
    """{teig id: stored area in m2} from a teig WFS response, for one property."""
    from lxml import etree

    parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)
    root = etree.fromstring(content, parser=parser)
    areas = {}
    for teig in root.iter():
        if _local(teig.tag) != "Teig":
            continue
        kommune = _child_text(teig, "kommunenummer")
        text = _child_text(teig, "matrikkelnummerTekst")
        if kommune != str(kommunenummer) or text != matrikkel_text:
            continue
        teig_id = _child_text(teig, "identTeig", "teigId")
        area = _child_text(teig, "teigareal", "lagretBeregnetAreal")
        if teig_id is None or area in (None, ""):
            continue
        areas[int(teig_id)] = float(area)
    return areas


def register_area(client, kommunenummer, gnr, bnr, festenr=0):
    """The register's stored area of each of the property's teiger, {teig id: m2}."""
    matrikkel_text = "{}/{}".format(gnr, bnr) + ("/{}".format(festenr) if festenr else "")
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
              "typeNames": "app:Teig",
              "namespaces": "xmlns(app,{})".format(TEIG_NAMESPACE),
              "filter": _teig_filter(kommunenummer, matrikkel_text)}
    resp = client.get(TEIG_WFS, params=params).raise_for_status()
    return parse_teig_areas(resp.content, kommunenummer, matrikkel_text)


def ring_local(coords, origin):
    """Grid ring to FORMAT.md's local ring: [[x, z]], 0.1 m, not closed.

    Two vertices closer than 0.1 m can round to the same point. The repeat is
    dropped, wrap-around included, so the ring has no zero-length edge for a
    viewer to take a direction from.
    """
    oe, on = origin
    pts = list(coords)
    if len(pts) > 1 and tuple(pts[0]) == tuple(pts[-1]):
        pts = pts[:-1]
    out = []
    for e, n in pts:
        point = [round(e - oe, 1) + 0.0, round(-(n - on), 1) + 0.0]
        if not out or point != out[-1]:
            out.append(point)
    while len(out) > 1 and out[-1] == out[0]:
        out.pop()
    return out


def plot_record(parcel_list, areas, origin, stated_plot_m2=None, source=None, note=None):
    """The plot.json object of FORMAT.md section 4.

    Every ring, holes included, is counter-clockwise seen from above (north up,
    east right), which is positive area in grid (E, N).
    """
    out = []
    total_polygon = 0.0
    total_register = 0.0
    all_register = True
    for parcel in parcel_list:
        poly = orient(parcel.polygon, sign=1.0)
        holes = [list(reversed(list(h.coords))) for h in poly.interiors]  # CW -> CCW
        area_register = areas.get(parcel.teig_id) if parcel.teig_id is not None else None
        total_polygon += poly.area
        if area_register is None:
            all_register = False
        else:
            total_register += area_register
        out.append({
            "ring": ring_local(poly.exterior.coords, origin),
            "holes": [ring_local(h, origin) for h in holes],
            "area_polygon_m2": round(poly.area, 1),
            "area_register_m2": None if area_register is None else round(area_register, 1),
            "accuracy_class": parcel.accuracy_class,
        })
    registered = total_register if all_register and out else total_polygon
    if note is None:
        note = "Registered parcel for the address."
        if stated_plot_m2:
            diff = (stated_plot_m2 - registered) / registered if registered else 0.0
            if diff > 0.005:
                note += " The listing states a larger plot."
            elif diff < -0.005:
                note += " The listing states a smaller plot."
    return {
        "version": 1,
        "parcels": out,
        "stated_plot_m2": stated_plot_m2,
        "note": note,
        "source": source or "Kartverket, Eiendom API and Matrikkelen teig (CC BY 4.0)",
    }
