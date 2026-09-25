"""Live checks against the real services. Deselected by default; run with -m network.

They use only allowlisted hosts through commons_world.http.Client, cache into a
temporary folder, and touch neutral public reference points: Galdhoepiggen's
summit and Kartverket's own office address. No listing is involved.
"""

import pytest

from commons_world import geo, grid, parcel, terrain
from commons_world.http import Client
from commons_world.robots import POLICY_DISALLOW_ALL
from commons_world.sources import ALLOWED_HOSTS

pytestmark = pytest.mark.network

GALDHOPIGGEN = (61.6364, 8.3125)   # Norway's highest summit, 2469 m
KARTVERKET_OFFICE = "Kartverksveien 21, 3511 H\u00f8nefoss"


@pytest.fixture
def client(tmp_path):
    return Client(tmp_path / "cache")


@pytest.mark.parametrize("host", sorted(ALLOWED_HOSTS))
def test_allowed_hosts_do_not_forbid_us(client, host):
    policy = client.check_robots(host)
    assert policy.policy != POLICY_DISALLOW_ALL, client.robots_log()


def test_export_image_on_an_exact_grid(client):
    e, n = geo.to_grid(*GALDHOPIGGEN, 25832)
    west, north = 20 * round(e / 20) - 160, 20 * round(n / 20) + 160
    heights = terrain.fetch_raster(client, terrain.DTM_SERVICE,
                                   (west, north - 320, west + 320, north), 20, grid.BILINEAR)
    assert heights.shape == (16, 16)
    assert 2400 < float(heights.max()) < 2475


def test_address_parcel_and_register_area_agree(client):
    g = parcel.geocode(client, KARTVERKET_OFFICE)
    found = parcel.parcels(client, g.kommunenummer, g.gnr, g.bnr, 25832, festenr=g.festenr)
    areas = parcel.register_area(client, g.kommunenummer, g.gnr, g.bnr, festenr=g.festenr)
    assert found and areas
    for p in found:
        if p.teig_id in areas:
            assert abs(p.polygon.area - areas[p.teig_id]) / areas[p.teig_id] < 0.005
