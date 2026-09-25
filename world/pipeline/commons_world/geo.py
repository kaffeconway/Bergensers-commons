"""Coordinates: geographic to national grid, true north, and the viewer's local frame.

Conventions are those of world/FORMAT.md section 1:

- geographic input is ETRS89 (EPSG:4258), latitude and longitude in degrees;
- the grid is the place's national grid (EPSG:25832 for Vestland);
- the origin O is the geocoded point rounded to whole metres;
- local x = E - origin_e (east), z = -(N - origin_n) (south);
- grid_north_offset_deg is the grid bearing of true north at O, so
  true bearing = grid bearing - offset.
"""

import math
from functools import lru_cache

import numpy as np
from pyproj import CRS, Geod, Proj, Transformer

GEOGRAPHIC_EPSG = 4258
_GEOD = Geod(ellps="GRS80")


@lru_cache(maxsize=None)
def _to_grid_transformer(epsg):
    return Transformer.from_crs(GEOGRAPHIC_EPSG, epsg, always_xy=True)


@lru_cache(maxsize=None)
def _to_geo_transformer(epsg):
    return Transformer.from_crs(epsg, GEOGRAPHIC_EPSG, always_xy=True)


@lru_cache(maxsize=None)
def _proj(epsg):
    return Proj(CRS.from_epsg(epsg))


def to_grid(lat, lon, epsg):
    """ETRS89 latitude/longitude (degrees) to grid (E, N) in metres."""
    e, n = _to_grid_transformer(epsg).transform(lon, lat)
    if isinstance(e, float):
        return float(e), float(n)
    return np.asarray(e), np.asarray(n)


def to_latlon(e, n, epsg):
    """Grid (E, N) in metres to ETRS89 (lat, lon) in degrees."""
    lon, lat = _to_geo_transformer(epsg).transform(e, n)
    if isinstance(lat, float):
        return float(lat), float(lon)
    return np.asarray(lat), np.asarray(lon)


def grid_north_offset_deg(e, n, epsg, distance=1000.0):
    """Grid bearing of true north at (E, N), in degrees, measured geodesically.

    A point `distance` metres due true north on the GRS80 ellipsoid is projected
    into the grid, and the grid bearing to it is returned. West of a UTM zone's
    central meridian, in the northern hemisphere, this is positive.
    """
    lat, lon = to_latlon(e, n, epsg)
    lon2, lat2, _ = _GEOD.fwd(lon, lat, 0.0, distance)
    e2, n2 = to_grid(lat2, lon2, epsg)
    return math.degrees(math.atan2(e2 - e, n2 - n))


def scale_factor(e, n, epsg):
    """Point scale factor of the grid at (E, N): grid metres per ellipsoid metre."""
    lat, lon = to_latlon(e, n, epsg)
    return float(_proj(epsg).get_factors(lon, lat).meridional_scale)


def round_half_up(value):
    """Round to the nearest whole number, halves upward (not banker's rounding)."""
    return int(math.floor(value + 0.5))


def round_origin(e, n):
    """The origin O: grid coordinates rounded to whole metres."""
    return round_half_up(e), round_half_up(n)


def local(e, n, origin):
    """Grid (E, N) to the viewer frame (x east, z south), metres from `origin`."""
    oe, on = origin
    return e - oe, -(n - on)


def from_local(x, z, origin):
    """Viewer frame (x, z) back to grid (E, N)."""
    oe, on = origin
    return x + oe, on - z


def true_from_grid(grid_bearing, offset):
    """True bearing of a direction given its grid bearing (degrees, 0..360)."""
    return (grid_bearing - offset) % 360.0


def grid_from_true(true_bearing, offset):
    """Grid bearing of a direction given its true bearing (degrees, 0..360)."""
    return (true_bearing + offset) % 360.0
