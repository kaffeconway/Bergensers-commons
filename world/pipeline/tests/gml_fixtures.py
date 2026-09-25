"""Small hand-written GML and WFS documents for the map-feature tests.

Everything here is synthetic: coordinates are offsets from the synthetic
origin (60 N 4 E, open North Sea), kommune numbers are 9998 and 9999 (which do
not exist), and names are invented. The documents are built as Python strings
with \\u escapes and encoded to UTF-8 at run time, because N50's element names
contain Norwegian letters and this file must stay ASCII.
"""

import io
import zipfile

from pyproj import Transformer

N50_NS = "https://skjema.geonorge.no/SOSI/produktspesifikasjon/N50/20230401"
NVDB_NS = "https://skjema.geonorge.no/SOSI/produktspesifikasjon/NVDBVegnettPluss/1.1"
TUR_NS = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/TurOgFriluftsruter/20171210"
BYGG_NS = "http://skjema.geonorge.no/SOSI/produktspesifikasjon/Matrikkelen-Bygningspunkt/20211101"
GML_NS = "http://www.opengis.net/gml/3.2"
WFS_NS = "http://www.opengis.net/wfs/2.0"

OE = "\u00f8"     # o with stroke
AA = "\u00e5"     # a with ring
AA_UP = "\u00c5"


def pos_list(coords, z=None):
    """"x y x y ..." (or with a z after each pair)."""
    out = []
    for x, y in coords:
        out.append("{:.3f} {:.3f}".format(x, y) if z is None
                   else "{:.3f} {:.3f} {:.3f}".format(x, y, z))
    return " ".join(out)


def ring(coords):
    """Close a ring."""
    coords = list(coords)
    return coords + [coords[0]]


def square(cx, cn, half):
    return [(cx - half, cn - half), (cx + half, cn - half), (cx + half, cn + half),
            (cx - half, cn + half)]


# -- N50 --------------------------------------------------------------------------

def _n50_collection(members, srs=25832):
    head = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gml:FeatureCollection xmlns:app="{app}" xmlns:gml="{gml}" gml:id="fc">\n'
            .format(app=N50_NS, gml=GML_NS))
    body = "".join("  <gml:featureMember>\n{}\n  </gml:featureMember>\n".format(m.replace(
        "SRS", "urn:ogc:def:crs:EPSG::{}".format(srs))) for m in members)
    return (head + body + "</gml:FeatureCollection>\n").encode("utf-8")


def n50_surface(kind, exterior, holes=(), extra=""):
    inner = "".join(
        "<gml:interior><gml:LinearRing><gml:posList>{}</gml:posList></gml:LinearRing>"
        "</gml:interior>".format(pos_list(ring(h))) for h in holes)
    return ("<app:{k} gml:id=\"id-{k}\"><app:oppdateringsdato>2020-01-01</app:oppdateringsdato>"
            "<app:omr{aa}de><gml:Surface gml:id=\"s-{k}\" srsName=\"SRS\" srsDimension=\"2\">"
            "<gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing><gml:posList>{ext}"
            "</gml:posList></gml:LinearRing></gml:exterior>{inner}</gml:PolygonPatch>"
            "</gml:patches></gml:Surface></app:omr{aa}de>{extra}</app:{k}>").format(
                k=kind, aa=AA, ext=pos_list(ring(exterior)), inner=inner, extra=extra)


def n50_line(kind, coords, prop="senterlinje", extra=""):
    return ("<app:{k} gml:id=\"id-{k}\">{extra}<app:{p}><gml:LineString gml:id=\"l-{k}\" "
            "srsName=\"SRS\" srsDimension=\"2\"><gml:posList>{c}</gml:posList></gml:LineString>"
            "</app:{p}></app:{k}>").format(k=kind, p=prop, c=pos_list(coords), extra=extra)


def n50_point(kind, x, y, extra=""):
    return ("<app:{k} gml:id=\"id-{k}\"><app:posisjon><gml:Point gml:id=\"p-{k}\" srsName=\"SRS\" "
            "srsDimension=\"2\"><gml:pos>{x:.2f} {y:.2f}</gml:pos></gml:Point></app:posisjon>"
            "{extra}</app:{k}>").format(k=kind, x=x, y=y, extra=extra)


def n50_arealdekke(e0, n0, srs=25832):
    """Land cover around (e0, n0): forest with a hole, bog, lake, sea, open land, an unknown
    type, a stream, plus lines and points the reader must ignore."""
    return _n50_collection([
        n50_surface("Skog", square(e0 + 100, n0 + 100, 50), holes=[square(e0 + 100, n0 + 100, 10)]),
        n50_surface("Myr", square(e0 - 100, n0 + 100, 30)),
        n50_surface("Innsj" + OE, square(e0 + 100, n0 - 100, 40),
                    extra="<app:h" + OE + "yde>12</app:h" + OE + "yde>"),
        n50_surface("Havflate", square(e0 - 300, n0, 100)),
        n50_surface(AA_UP + "pentOmr" + AA + "de", square(e0, n0 + 300, 60)),
        n50_surface("Fantasiflate", square(e0, n0 - 300, 20)),
        n50_surface("Skog", square(e0 + 90000, n0, 50)),          # far away: clipped out
        n50_line("ElvBekk", [(e0 + 60, n0 - 100), (e0 - 50, n0 - 150)],
                 extra="<app:vannbredde>2</app:vannbredde>"),
        n50_line("Kystkontur", [(e0 - 200, n0 - 200), (e0 - 200, n0 + 200)], prop="grense"),
        n50_point("Skj" + "\u00e6" + "r", e0 - 350, n0),
    ], srs)


def n50_samferdsel(e0, n0):
    def road(type_veg, coords, category=None, medium="T"):
        extra = "<app:medium>{}</app:medium>".format(medium) if medium else ""
        tail = "<app:typeVeg>{}</app:typeVeg>".format(type_veg)
        if category:
            tail += ("<app:vegsystem><app:Vegsystem><app:vegkategori>{}</app:vegkategori>"
                     "<app:vegfase>V</app:vegfase></app:Vegsystem></app:vegsystem>").format(category)
        return n50_line("Veglenke", coords, extra=extra).replace("</app:Veglenke>",
                                                                 tail + "</app:Veglenke>")
    return _n50_collection([
        road("enkelBilveg", [(e0, n0), (e0 + 200, n0)], "F"),
        road("enkelBilveg", [(e0, n0 + 50), (e0 + 200, n0 + 50)], "K", medium="U"),
        road("gangOgSykkelveg", [(e0, n0 + 10), (e0 + 200, n0 + 10)]),
        road("sti", [(e0, n0 + 100), (e0 + 100, n0 + 150)]),
        road("traktorveg", [(e0, n0 + 200), (e0 + 100, n0 + 250)]),
        road("bilferje", [(e0 - 500, n0), (e0 - 900, n0)]),
        road("hesteveg", [(e0, n0 + 300), (e0 + 10, n0 + 300)]),
    ])


def n50_hoyde(e0, n0):
    h = "<app:h" + OE + "yde>{}</app:h" + OE + "yde>"
    return _n50_collection([
        n50_point("Terrengpunkt", e0 + 10, n0 + 20, extra=h.format(58)),
        n50_point("TrigonometriskPunkt", e0 + 30, n0 + 40, extra=h.format(84)),
        n50_line("H" + OE + "ydekurve", [(e0, n0), (e0 + 10, n0)], extra=h.format(20)),
    ])


def n50_bygninger(e0, n0):
    return _n50_collection([
        n50_point("Bygning", e0 + 5, n0 + 5, extra="<app:bygningstype>111</app:bygningstype>"),
        n50_surface("Bygning", square(e0 + 50, n0 + 50, 10),
                    extra="<app:bygningstype>219</app:bygningstype>"),
    ])


def n50_administrative(e0, n0):
    return _n50_collection([n50_surface("Kommune", square(e0, n0, 5000))])


def n50_zip(e0, n0, kommune="9999", name="Nowhere"):
    """An N50 municipality zip, named the way Geonorge names them."""
    prefix = "Basisdata_{}_{}_25832_N50".format(kommune, name)
    files = {prefix + "Arealdekke_GML.gml": n50_arealdekke(e0, n0),
             prefix + "Samferdsel_GML.gml": n50_samferdsel(e0, n0),
             prefix + "Hoyde_GML.gml": n50_hoyde(e0, n0),
             prefix + "BygningerOgAnlegg_GML.gml": n50_bygninger(e0, n0),
             prefix + "AdministrativeOmrader_GML.gml": n50_administrative(e0, n0),
             "Mer_informasjon_om_N50Kartdata.txt": b"synthetic"}
    return make_zip(files)


def make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zf.writestr(info, files[name])
    return buf.getvalue()


# -- NVDB Vegnett Pluss -------------------------------------------------------------

_TO_5973 = Transformer.from_crs(25832, 25833, always_xy=True)


def to_utm33(coords):
    xs, ys = _TO_5973.transform([c[0] for c in coords], [c[1] for c in coords])
    return list(zip(xs, ys))


def nvdb_link(type_veg, coords25832, category=None, detail="VTKB", connection="false",
              medium=None, ident="1"):
    """One Veglenke, its line given in 25832 and written in 5973 with a height per vertex."""
    ref = ""
    if category:
        ref = ("<vegsystemreferanse><Vegsystemreferanse><vegsystem><Vegsystem>"
               "<vegkategori>{}</vegkategori><fase>V</fase><vegnummer>1</vegnummer>"
               "</Vegsystem></vegsystem></Vegsystemreferanse></vegsystemreferanse>").format(category)
    med = "<medium>{}</medium>".format(medium) if medium else ""
    return ("<wfs:member><Veglenke gml:id=\"Veglenke.{i}\"><nvdbId>{i}_0</nvdbId>"
            "<kommunenummer>9999</kommunenummer><typeVeg>{t}</typeVeg>"
            "<detaljniv{aa}>{d}</detaljniv{aa}><konnekteringslenke>{c}</konnekteringslenke>"
            "{ref}{med}<senterlinje><gml:LineString srsName=\"http://www.opengis.net/def/crs/EPSG/"
            "0/5973\" srsDimension=\"3\" gml:id=\"ku.{i}\"><gml:posList>{p}</gml:posList>"
            "</gml:LineString></senterlinje></Veglenke></wfs:member>\n").format(
                i=ident, t=type_veg, aa=AA, d=detail, c=connection, ref=ref, med=med,
                p=pos_list(to_utm33(coords25832), z=12.5))


def nvdb_gml(links):
    head = ('<?xml version="1.0" encoding="UTF-8"?>\n<wfs:FeatureCollection timeStamp='
            '"2026-01-01T00:00:00" numberMatched="0" numberReturned="0" xmlns="{ns}" '
            'xmlns:wfs="{wfs}" xmlns:gml="{gml}">\n').format(ns=NVDB_NS, wfs=WFS_NS, gml=GML_NS)
    other = ("<wfs:member><Fartsgrense gml:id=\"Fartsgrense.1\"><fartsgrenseVerdi>50"
             "</fartsgrenseVerdi></Fartsgrense></wfs:member>\n")
    return (head + other + "".join(links) + "</wfs:FeatureCollection>\n").encode("utf-8")


def nvdb_zip(links, kommune="9999", name="Nowhere"):
    member = "{}NVDBVegnettPluss.gml".format(kommune)
    return make_zip({member: nvdb_gml(links)})


def nvdb_zip_name(kommune="9999", name="Nowhere"):
    return "Samferdsel_{}_{}_5973_NVDB-VegnettPluss_GML.zip".format(kommune, name)


def n50_zip_name(kommune="9999", name="Nowhere"):
    return "Basisdata_{}_{}_25832_N50Kartdata_GML.zip".format(kommune, name)


# -- WFS pages --------------------------------------------------------------------

def _wfs_page(ns, members):
    head = ("<?xml version='1.0' encoding='UTF-8'?>\n<wfs:FeatureCollection xmlns:wfs=\"{wfs}\" "
            "xmlns:gml=\"{gml}\" numberMatched=\"unknown\" numberReturned=\"0\">\n").format(
                wfs=WFS_NS, gml=GML_NS)
    body = "".join("  <wfs:member>\n{}\n  </wfs:member>\n".format(m) for m in members)
    return (head + body + "</wfs:FeatureCollection>\n").encode("utf-8")


def fotrute(ident, coords, marked="JA", follows="ST"):
    return ("<app:Fotrute xmlns:app=\"{ns}\" gml:id=\"fotrute.{i}\"><app:opphav>test</app:opphav>"
            "<app:senterlinje><gml:LineString gml:id=\"fotrute.{i}_L\" srsName=\"urn:ogc:def:crs:"
            "EPSG::25832\"><gml:posList>{p}</gml:posList></gml:LineString></app:senterlinje>"
            "<app:merking>{m}</app:merking><app:ruteF{oe}lger>{f}</app:ruteF{oe}lger>"
            "<app:fotruteInfo><app:FotruteInfo><app:rutenavn>Invented route</app:rutenavn>"
            "</app:FotruteInfo></app:fotruteInfo></app:Fotrute>").format(
                ns=TUR_NS, i=ident, p=pos_list(coords), m=marked, f=follows, oe=OE)


def ruteinfopunkt(ident, x, y, code):
    return ("<app:RuteInfoPunkt xmlns:app=\"{ns}\" gml:id=\"ruteinfopunkt.{i}\"><app:posisjon>"
            "<gml:Point gml:id=\"r{i}\" srsName=\"urn:ogc:def:crs:EPSG::25832\"><gml:pos>"
            "{x:.3f} {y:.3f}</gml:pos></gml:Point></app:posisjon><app:tilrettelegging>{c}"
            "</app:tilrettelegging></app:RuteInfoPunkt>").format(ns=TUR_NS, i=ident, x=x, y=y,
                                                                   c=code)


def trails_page(members):
    return _wfs_page(TUR_NS, members)


def bygning(ident, x, y, type_code, number, status="TB"):
    """A register building point with the extra fields the real service returns."""
    return ("<app:Bygning xmlns:app=\"{ns}\" gml:id=\"bygning.{i}\">"
            "<app:stedfestingVerifisert>true</app:stedfestingVerifisert>"
            "<app:bygningsnummer>{nr}</app:bygningsnummer><app:bygningsstatus>{st}"
            "</app:bygningsstatus><app:kommunenummer>9999</app:kommunenummer>"
            "<app:kommunenavn>Nowhere</app:kommunenavn><app:bruksenhet><app:Bruksenhet>"
            "<app:bruksenhetId>1</app:bruksenhetId><app:matrikkelenhetId>2</app:matrikkelenhetId>"
            "</app:Bruksenhet></app:bruksenhet><app:representasjonspunkt><gml:Point "
            "gml:id=\"b{i}\" srsName=\"urn:ogc:def:crs:EPSG::25832\"><gml:pos>{x:.3f} {y:.3f}"
            "</gml:pos></gml:Point></app:representasjonspunkt><app:bygningstype>{t}"
            "</app:bygningstype></app:Bygning>").format(ns=BYGG_NS, i=ident, nr=number, st=status,
                                                       x=x, y=y, t=type_code)


def bygning_page(members):
    return _wfs_page(BYGG_NS, members)


def exception_report(text="InvalidParameterValue"):
    return ("<?xml version='1.0' encoding='UTF-8'?>\n<ows:ExceptionReport "
            "xmlns:ows=\"http://www.opengis.net/ows/1.1\" version=\"2.0.0\"><ows:Exception "
            "exceptionCode=\"{}\"/></ows:ExceptionReport>\n".format(text)).encode("utf-8")
