"""The sun: pvlib's SPA against the textbook noon and an independent NOAA calculation,
and the minute counting against a brute-force count.

The place is the synthetic origin, 60.0 N 4.0 E, in the open North Sea.
"""

import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from commons_world.facts import sun

LAT, LON = 60.0, 4.0


def noaa_elevation(when, lat, lon):
    """Geometric solar elevation (deg) from NOAA's spreadsheet equations (Meeus-based)."""
    jd = (when - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0 \
        + 2451545.0
    t = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    mr = math.radians(m)
    c = (math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * mr) * (0.019993 - 0.000101 * t) + math.sin(3 * mr) * 0.000289)
    omega = math.radians(125.04 - 1934.136 * t)
    lam = math.radians(l0 + c - 0.00569 - 0.00478 * math.sin(omega))
    eps0 = 23.0 + (26.0 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60.0) / 60.0
    eps = math.radians(eps0 + 0.00256 * math.cos(omega))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    y = math.tan(eps / 2.0) ** 2
    l0r = math.radians(l0)
    eot = 4.0 * math.degrees(y * math.sin(2 * l0r) - 2 * e * math.sin(mr)
                             + 4 * e * y * math.sin(mr) * math.cos(2 * l0r)
                             - 0.5 * y * y * math.sin(4 * l0r) - 1.25 * e * e * math.sin(2 * mr))
    minutes = when.hour * 60 + when.minute + when.second / 60.0
    tst = (minutes + eot + 4.0 * lon) % 1440.0
    ha = math.radians(tst / 4.0 - 180.0)
    phi = math.radians(lat)
    cz = math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(ha)
    return 90.0 - math.degrees(math.acos(max(-1.0, min(1.0, cz))))


def test_winter_solstice_noon_is_90_minus_latitude_minus_the_tilt():
    times = pd.date_range("2026-12-21 00:00:00", periods=1440, freq="min", tz="UTC")
    sp = sun.solar_position(times, LAT, LON)
    noon = float(sp["elevation"].max())                     # geometric, no refraction
    assert noon == pytest.approx(90.0 - 60.0 - 23.44, abs=0.05)
    assert float(sp["apparent_elevation"].max()) > noon     # refraction lifts it
    when = times[int(np.argmax(sp["elevation"].to_numpy()))]
    # solar noon at 4 E is about 11:44 UTC on 21 Dec (equation of time about +2 min)
    assert abs((when.hour * 60 + when.minute) - (11 * 60 + 44)) <= 3


def test_spa_matches_the_noaa_equations_over_a_year():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    times = [start + timedelta(days=d, hours=h, minutes=17)
             for d in range(0, 365, 4) for h in range(24)]
    sp = sun.solar_position(pd.DatetimeIndex(times), LAT, LON)
    spa = sp["elevation"].to_numpy()
    noaa = np.array([noaa_elevation(t, LAT, LON) for t in times])
    up = spa > 0
    assert up.sum() > 1000
    assert np.max(np.abs(spa[up] - noaa[up])) < 0.05


@pytest.fixture(scope="module")
def year():
    return sun.SunYear(LAT, LON)


def brute_minutes(sy, profile):
    profile = np.zeros(720) if profile is None else np.asarray(profile)
    x = np.mod(sy.azimuth, 360.0) / 0.5
    i0 = np.floor(x).astype(int) % 720
    w = x - np.floor(x)
    hz = profile[i0] * (1 - w) + profile[(i0 + 1) % 720] * w
    return np.bincount(sy.day_index, weights=sy.elevation > hz, minlength=sy.days).astype(int)


def test_minute_counts_match_a_brute_force_count(year):
    rng = np.random.default_rng(7)
    profiles = [None, np.full(720, 90.0), np.full(720, -2.0)]
    profiles += [np.clip(rng.normal(3, 2, 720), -1, 12) for _ in range(40)]
    profiles += [np.clip(rng.normal(5, 8, 720), -1, 70) for _ in range(40)]
    got = year.daily_minutes(profiles, batch=16)
    for k in (0, 1, 2, 3, 20, 44, 60, 82):
        assert np.array_equal(got[k], brute_minutes(year, profiles[k])), k
    assert got[1].sum() == 0
    assert np.all(got[2] >= got[0])


def test_the_flat_horizon_year_at_60_north(year):
    flat = year.summary(year.daily_minutes([None])[0])
    assert 5.6 < flat["dec21_h"] < 5.9                      # centre above 0 deg
    assert 18.5 < flat["jun21_h"] < 19.0
    assert len(flat["monthly_h"]) == 12
    assert flat["monthly_h"][5] > flat["monthly_h"][2] > flat["monthly_h"][11]
    assert min(flat["monthly_h"][0], flat["monthly_h"][11]) <= flat["decjan_mean_h"] \
        <= max(flat["monthly_h"][0], flat["monthly_h"][11])
    assert year.day_of[sun.DEC21] == 354 and year.day_of[sun.JUN21] == 171


def test_the_sun_path_every_ten_minutes_while_up():
    path = sun.sun_path(LAT, LON, 2026, 12, 21)
    assert 30 <= len(path) <= 36
    assert all(el > 0 for _, el in path)
    assert all(b[0] > a[0] for a, b in zip(path, path[1:]))    # east to west
    assert 135 < path[0][0] < 150 and 210 < path[-1][0] < 225
    summer = sun.sun_path(LAT, LON, 2026, 6, 21)
    assert max(el for _, el in summer) == pytest.approx(90 - 60 + 23.44, abs=0.1)
