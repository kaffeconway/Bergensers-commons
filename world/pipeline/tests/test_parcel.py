"""Geocoding and parcels against fake Kartverket responses.

The response shapes mirror what api.kartverket.no and the teig WFS return; the
addresses, kommune number (9999, which does not exist), property numbers,
coordinates and areas are all invented.
"""

import json

import pytest
from shapely.geometry import Polygon

from commons_world import parcel
from commons_world.parcel import GeocodeError, ParcelError

from conftest import FakeTransport

API = "api.kartverket.no"
WFS = "wfs.geonorge.no"
E0, N0 = 221289.0, 6661953.0  # the synthetic origin, in open sea


def address_hit(number=1, letter="", street="Synthetic Road", kommune="9999", gnr=1, bnr=2,
                lat=60.0, lon=4.0, verified=False):
    return {"adressenavn": street, "adressetekst": "{} {}{}".format(street, number, letter),
            "adressetilleggsnavn": None, "adressekode": 1, "nummer": number, "bokstav": letter,
            "kommunenummer": kommune, "kommunenavn": "NOWHERE", "gardsnummer": gnr,
            "bruksnummer": bnr, "festenummer": 0, "undernummer": None, "bruksenhetsnummer": [],
            "objtype": "Vegadresse", "poststed": "NOWHERE", "postnummer": "0000",
            "adressetekstutenadressetilleggsnavn": "{} {}{}".format(street, number, letter),
            "stedfestingverifisert": verified,
            "representasjonspunkt": {"epsg": "EPSG:4258", "lat": lat, "lon": lon},
            "oppdateringsdato": "2020-01-01T00:00:00"}


def address_response(*hits):
    return (200, {"Content-Type": "application/json"}, json.dumps(
        {"metadata": {"treffPerSide": 10, "side": 0, "totaltAntallTreff": len(hits)},
         "adresser": list(hits)}).encode("utf-8"))


def square(cx, cy, half):
    return [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half],
            [cx - half, cy + half], [cx - half, cy - half]]


def teig_feature(coords, gnr=1, bnr=2, lokalid=101, main=True, kind="Polygon"):
    return {"type": "Feature", "geometry": {"type": kind, "coordinates": coords},
            "properties": {"bruksnummer": bnr, "festenummer": 0, "gardsnummer": gnr,
                           "hovedomr\u00e5de": main, "kommunenummer": "9999", "lokalid": lokalid,
                           "matrikkelnummertekst": "{}/{}".format(gnr, bnr),
                           "n\u00f8yaktighetsklasseteig": "Gult", "objekttype": "Teig",
                           "oppdateringsdato": "2020-01-01T00:00:00", "seksjonsnummer": 0,
                           "teigmedflerematrikkelenheter": False,
                           "uregistrertjordsameie": False}}


def eiendom_response(features, crs="EPSG:25832"):
    body = {"crs": {"properties": {"name": crs}, "type": "name"},
            "features": features, "type": "FeatureCollection"}
    return (200, {"Content-Type": "application/json"}, json.dumps(body).encode("utf-8"))


TEIG_MEMBER = """
  <wfs:member>
    <app:Teig gml:id="teig.{tid}">
      <app:identTeig><app:IdentTeig><app:teigId>{tid}</app:teigId>
        <app:navnerom>https://data.geonorge.no/sosi/matrikkel/eiendomskart_teig</app:navnerom>
        <app:versjonId>1</app:versjonId></app:IdentTeig></app:identTeig>
      <app:representasjonspunkt><gml:Point gml:id="p{tid}" srsName="urn:ogc:def:crs:EPSG::25832">
        <gml:pos>221290.000 6661950.000</gml:pos></gml:Point></app:representasjonspunkt>
      <app:kommunenummer>{kommune}</app:kommunenummer>
      <app:kommunenavn>NOWHERE</app:kommunenavn>
      <app:matrikkelenhet><app:Matrikkelenhet>
        <app:kommunenummer>0000</app:kommunenummer>
        <app:gardsnummer>1</app:gardsnummer><app:bruksnummer>2</app:bruksnummer>
        <app:avklartEiere>false</app:avklartEiere>
      </app:Matrikkelenhet></app:matrikkelenhet>
      <app:matrikkelnummerTekst>{text}</app:matrikkelnummerTekst>
      <app:avklartEiere>false</app:avklartEiere>
      <app:teigareal><app:Areal><app:lagretBeregnetAreal>{area}</app:lagretBeregnetAreal></app:Areal></app:teigareal>
      <app:noyaktighetsklasseTeig>Gult</app:noyaktighetsklasseTeig>
    </app:Teig>
  </wfs:member>"""


def wfs_response(members):
    body = ("<?xml version='1.0' encoding='UTF-8'?>\n"
            '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" '
            'xmlns:gml="http://www.opengis.net/gml/3.2" '
            'xmlns:app="{}" numberMatched="unknown" numberReturned="0">'.format(parcel.TEIG_NAMESPACE)
            + "".join(TEIG_MEMBER.format(**m) for m in members) + "\n</wfs:FeatureCollection>")
    return (200, {"Content-Type": "text/xml"}, body.encode("utf-8"))


# -- address parsing ---------------------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("Synthetic Road 1, 0000 Nowhere", ("Synthetic Road", 1, "", "0000", "Nowhere")),
    ("Testgata 12b, 9999 Some Place", ("Testgata", 12, "B", "9999", "Some Place")),
    ("  \u00d8vre  Test\u00f8yvegen 7 A ,  0001   Nowhere  ",
     ("\u00d8vre Test\u00f8yvegen", 7, "A", "0001", "Nowhere")),
])
def test_parse_address(text, expected):
    a = parcel.parse_address(text)
    assert (a.street, a.number, a.letter, a.postcode, a.place) == expected


@pytest.mark.parametrize("text", ["Synthetic Road 1", "Synthetic Road, 0000 Nowhere",
                                  "1, 0000 Nowhere", "", None])
def test_parse_address_refuses_other_forms(text):
    with pytest.raises(GeocodeError):
        parcel.parse_address(text)


# -- geocoding ---------------------------------------------------------------

def test_geocode_one_hit(make_client):
    seen = []

    def handler(method, url, query, headers, body):
        seen.append(query)
        return address_response(address_hit(), address_hit(number=10), address_hit(number=1,
                                                                                  letter="A"))
    transport = FakeTransport()
    transport.add(API, "/adresser/v1/sok", handler)
    g = parcel.geocode(make_client(transport), "Synthetic Road 1, 0000 Nowhere")
    assert seen == [{"sok": "Synthetic Road 1", "postnummer": "0000", "treffPerSide": "10"}]
    assert (g.lat, g.lon, g.kommunenummer, g.gnr, g.bnr, g.festenr) == (60.0, 4.0, "9999", 1, 2, 0)
    assert g.placement_verified is False
    assert g.property_text == "9999-1/2"


def test_geocode_no_hit_fails_clearly(make_client):
    transport = FakeTransport()
    transport.add(API, "/adresser/v1/sok", address_response())
    with pytest.raises(GeocodeError, match="(?s)matched 0.*\\(none\\)"):
        parcel.geocode(make_client(transport), "Synthetic Road 1, 0000 Nowhere")


def test_geocode_two_hits_fails_listing_candidates(make_client):
    transport = FakeTransport()
    transport.add(API, "/adresser/v1/sok", address_response(
        address_hit(kommune="9998", gnr=5, bnr=6), address_hit(kommune="9999", gnr=7, bnr=8)))
    with pytest.raises(GeocodeError) as info:
        parcel.geocode(make_client(transport), "Synthetic Road 1, 0000 Nowhere")
    message = str(info.value)
    assert "matched 2" in message and "gnr 5 / bnr 6" in message and "gnr 7 / bnr 8" in message


def test_geocode_letter_must_match(make_client):
    transport = FakeTransport()
    transport.add(API, "/adresser/v1/sok", address_response(address_hit(letter="A")))
    with pytest.raises(GeocodeError):
        parcel.geocode(make_client(transport), "Synthetic Road 1, 0000 Nowhere")


def test_geocode_only_norway():
    with pytest.raises(NotImplementedError):
        parcel.geocode(None, "Rue Synthetique 1, 00000 Nulle Part", country="FR")


# -- parcels -----------------------------------------------------------------

def test_parcels(make_client):
    main = square(E0, N0, 30)
    hole = square(E0, N0, 5)
    other = square(E0 + 100, N0, 10)
    features = [teig_feature([main, hole], lokalid=101),
                teig_feature([[other]], lokalid=102, main=False, kind="MultiPolygon"),
                teig_feature([square(E0 + 500, N0, 10)], bnr=3, lokalid=103)]
    seen = []

    def handler(method, url, query, headers, body):
        seen.append(query)
        return eiendom_response(features)
    transport = FakeTransport()
    transport.add(API, "/eiendom/v1/geokoding", handler)
    found = parcel.parcels(make_client(transport), "9999", 1, 2, 25832)
    assert seen == [{"kommunenummer": "9999", "gardsnummer": "1", "bruksnummer": "2",
                     "omrade": "true", "utkoordsys": "25832"}]
    assert [p.teig_id for p in found] == [101, 102]
    assert [p.main for p in found] == [True, False]
    assert all(p.accuracy_class == "Gult" for p in found)
    assert found[0].polygon.area == pytest.approx(60 * 60 - 10 * 10)
    assert set(vars(found[0])) == {"polygon", "accuracy_class", "teig_id", "main"}


def test_parcels_wrong_crs(make_client):
    transport = FakeTransport()
    transport.add(API, "/eiendom/v1/geokoding",
                  eiendom_response([teig_feature([square(E0, N0, 5)])], crs="EPSG:4258"))
    with pytest.raises(ParcelError, match="25832"):
        parcel.parcels(make_client(transport), "9999", 1, 2, 25832)


def test_parcels_none_found(make_client):
    transport = FakeTransport()
    transport.add(API, "/eiendom/v1/geokoding", eiendom_response([]))
    with pytest.raises(ParcelError):
        parcel.parcels(make_client(transport), "9999", 1, 2, 25832)


def test_register_area(make_client):
    seen = []

    def handler(method, url, query, headers, body):
        seen.append(query)
        return wfs_response([
            {"tid": 101, "kommune": "9999", "text": "1/2", "area": "3587.4"},
            {"tid": 102, "kommune": "9999", "text": "1/2", "area": "100.0"},
            {"tid": 103, "kommune": "9999", "text": "1/20", "area": "999.0"},
            {"tid": 104, "kommune": "9998", "text": "1/2", "area": "999.0"},
        ])
    transport = FakeTransport()
    transport.add(WFS, "/skwms1/wfs.matrikkelen-eiendomskart-teig", handler)
    areas = parcel.register_area(make_client(transport), "9999", 1, 2)
    assert areas == {101: 3587.4, 102: 100.0}
    query = seen[0]
    assert query["request"] == "GetFeature" and query["typeNames"] == "app:Teig"
    assert parcel.TEIG_NAMESPACE in query["namespaces"]
    assert "<fes:Literal>9999</fes:Literal>" in query["filter"]
    assert "<fes:Literal>1/2</fes:Literal>" in query["filter"]


def test_no_owner_services_are_called(make_client):
    transport = FakeTransport()
    transport.add(API, "/eiendom/v1/geokoding", eiendom_response([teig_feature([square(E0, N0, 5)])]))
    transport.add(WFS, "/skwms1/wfs.matrikkelen-eiendomskart-teig", wfs_response([]))
    client = make_client(transport)
    parcel.parcels(client, "9999", 1, 2, 25832)
    parcel.register_area(client, "9999", 1, 2)
    for url in transport.urls():
        assert "eier" not in url.lower() and "owner" not in url.lower()


# -- plot.json ---------------------------------------------------------------

def signed_area_grid(ring):
    """Shoelace area of a local ring, measured in grid (E, N): x = E - oe, -z = N - on."""
    total = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]):
        total += x1 * (-z2) - x2 * (-z1)
    return total / 2.0


def test_plot_record_rings(make_client):
    clockwise = Polygon(list(reversed(square(E0 + 10.04, N0 - 5.06, 20)[:-1])),
                        [square(E0 + 10, N0 - 5, 4)[:-1]])
    parcels = [parcel.Parcel(clockwise, "Gult", 101, True)]
    record = parcel.plot_record(parcels, {101: 1540.0}, (int(E0), int(N0)), stated_plot_m2=1800)
    ring = record["parcels"][0]["ring"]
    assert len(ring) == 4                     # not closed
    assert signed_area_grid(ring) > 0         # counter-clockwise seen from above
    assert signed_area_grid(record["parcels"][0]["holes"][0]) > 0
    assert all(round(v, 1) == v for pt in ring for v in pt)
    xs = sorted({pt[0] for pt in ring})
    zs = sorted({pt[1] for pt in ring})
    assert xs == [-10.0, 30.0]                # x east, rounded to 0.1 m
    assert zs == [-14.9, 25.1]                # z south: N0 - 5.06 + 20 is z = -14.94
    p = record["parcels"][0]
    assert p["area_polygon_m2"] == 1536.0 and p["area_register_m2"] == 1540.0
    assert p["accuracy_class"] == "Gult"
    assert record["stated_plot_m2"] == 1800
    assert record["note"] == "Registered parcel for the address. The listing states a larger plot."
    assert record["version"] == 1


def test_ring_local_drops_vertices_that_round_together():
    # Two corners 0.07 m apart round to the same 0.1 m point; so do the last and
    # the first. A real parcel had exactly this, which left a zero-length edge.
    origin = (int(E0), int(N0))
    coords = [(E0 + 0.02, N0 + 0.03), (E0 + 30.0, N0), (E0 + 30.0, N0 + 20.0),
              (E0 + 30.0, N0 + 20.04), (E0, N0 + 20.0), (E0 + 0.04, N0 + 0.01),
              (E0 + 0.02, N0 + 0.03)]
    ring = parcel.ring_local(coords, origin)
    assert ring == [[0.0, 0.0], [30.0, 0.0], [30.0, -20.0], [0.0, -20.0]]
    record = parcel.plot_record([parcel.Parcel(Polygon(coords), "Gult", 7, True)], {7: 600.0},
                                origin)
    out = record["parcels"][0]["ring"]
    assert all(a != b for a, b in zip(out, out[1:] + out[:1]))
    assert signed_area_grid(out) == pytest.approx(600.0, rel=0.01)


@pytest.mark.parametrize("stated,note", [
    (None, "Registered parcel for the address."),
    (1600, "Registered parcel for the address."),
    (1400, "Registered parcel for the address. The listing states a smaller plot."),
])
def test_plot_record_note(stated, note):
    parcels = [parcel.Parcel(Polygon(square(E0, N0, 20)), "Gult", 1, True)]
    assert parcel.plot_record(parcels, {1: 1600.0}, (int(E0), int(N0)), stated)["note"] == note
