"""Coordinates, true north and the local frame, at neutral open-sea points."""

import math

import pytest
from pyproj import Geod

from commons_world import geo

# Open sea: the North Sea west of Vestland, and the Skagerrak.
SEA_WEST = (60.0, 4.0)     # west of UTM 32's central meridian (9 E)
SEA_EAST = (58.0, 10.0)    # east of it


def closed_form(lat, lon, central=9.0):
    """atan(tan(lon - central) * sin(lat)), the textbook meridian convergence."""
    return math.degrees(math.atan(math.tan(math.radians(lon - central)) *
                                  math.sin(math.radians(lat))))


def test_to_grid_round_trip():
    e, n = geo.to_grid(*SEA_WEST, 25832)
    lat, lon = geo.to_latlon(e, n, 25832)
    assert lat == pytest.approx(SEA_WEST[0], abs=1e-9)
    assert lon == pytest.approx(SEA_WEST[1], abs=1e-9)


def test_central_meridian_maps_to_false_easting():
    e, _ = geo.to_grid(60.0, 9.0, 25832)
    assert e == pytest.approx(500000.0, abs=1e-6)


@pytest.mark.parametrize("lat,lon", [SEA_WEST, SEA_EAST])
def test_grid_north_offset_matches_closed_form(lat, lon):
    e, n = geo.to_grid(lat, lon, 25832)
    offset = geo.grid_north_offset_deg(e, n, 25832)
    # The grid bearing of true north is the negative of the closed form.
    assert offset == pytest.approx(-closed_form(lat, lon), abs=0.01)


def test_grid_north_offset_sign_convention():
    """FORMAT.md: west of the central meridian true north has a positive grid bearing."""
    west = geo.grid_north_offset_deg(*geo.to_grid(*SEA_WEST, 25832), 25832)
    east = geo.grid_north_offset_deg(*geo.to_grid(*SEA_EAST, 25832), 25832)
    centre = geo.grid_north_offset_deg(*geo.to_grid(60.0, 9.0, 25832), 25832)
    assert west > 4.0 and east < -0.5 and abs(centre) < 1e-6


def test_true_and_grid_bearings_follow_format_md():
    """A point due true north must plot at grid bearing +offset; true = grid - offset."""
    e, n = geo.to_grid(*SEA_WEST, 25832)
    offset = geo.grid_north_offset_deg(e, n, 25832)
    lon2, lat2, _ = Geod(ellps="GRS80").fwd(SEA_WEST[1], SEA_WEST[0], 90.0, 5000.0)  # due east
    e2, n2 = geo.to_grid(lat2, lon2, 25832)
    grid_bearing = math.degrees(math.atan2(e2 - e, n2 - n)) % 360.0
    assert geo.true_from_grid(grid_bearing, offset) == pytest.approx(90.0, abs=0.01)
    assert geo.grid_from_true(90.0, offset) == pytest.approx(grid_bearing, abs=0.01)


def test_scale_factor():
    e, n = geo.to_grid(60.0, 9.0, 25832)
    assert geo.scale_factor(e, n, 25832) == pytest.approx(0.9996, abs=1e-7)
    e, n = geo.to_grid(*SEA_WEST, 25832)
    k = geo.scale_factor(e, n, 25832)
    # Cross-check against a short geodesic: grid length over ellipsoid length.
    lon2, lat2, _ = Geod(ellps="GRS80").fwd(SEA_WEST[1], SEA_WEST[0], 45.0, 100.0)
    e2, n2 = geo.to_grid(lat2, lon2, 25832)
    assert k == pytest.approx(math.hypot(e2 - e, n2 - n) / 100.0, abs=2e-6)


def test_round_origin_is_half_up():
    assert geo.round_origin(10.5, -10.5) == (11, -10)
    assert geo.round_origin(10.49, 20.51) == (10, 21)
    assert all(isinstance(v, int) for v in geo.round_origin(1.2, 3.4))


def test_local_frame():
    origin = (1000, 2000)
    assert geo.local(1010.0, 2000.0, origin) == (10.0, 0.0)     # east is +x
    assert geo.local(1000.0, 2010.0, origin) == (0.0, -10.0)    # north is -z
    assert geo.local(1000.0, 1990.0, origin) == (0.0, 10.0)     # south is +z
    assert geo.from_local(*geo.local(1234.5, 1876.25, origin), origin) == (1234.5, 1876.25)
