"""Where the sun is, minute by minute, and how many minutes of it clear a horizon.

Sun positions come from pvlib's implementation of NREL's Solar Position
Algorithm (Reda and Andreas 2004), method "nrel_numpy", at the origin's
latitude and longitude, for every minute of SUN_YEAR (UTC), sampled at the
middle of each minute (hh:mm:30). The elevation used is pvlib's
apparent_elevation: the sun's centre, with atmospheric refraction at the
pressure pvlib derives from the ground height and its default 12 C.

A minute is sunlit when the apparent elevation of the sun's centre is above
the horizon at the sun's true azimuth (linear between the 0.5 deg rays). The
astronomical figure uses a flat horizon at 0 deg. Days are UTC calendar
days; at Norwegian longitudes the sun is down at 00:00 UTC for most of the
year and the split changes nothing there, but at midnight-sun latitudes a
UTC day is not a solar day.
"""

import calendar

import numpy as np
import pandas as pd

from .horizon import STEP_DEG

SUN_YEAR = 2026
DEC21 = (12, 21)
JUN21 = (6, 21)
PATH_STEP_MIN = 10


def solar_position(times, lat, lon, altitude=0.0):
    """pvlib's SPA (nrel_numpy) for a DatetimeIndex: a DataFrame."""
    import pvlib

    return pvlib.solarposition.get_solarposition(times, lat, lon, altitude=altitude,
                                                 method="nrel_numpy")


class SunYear:
    """Apparent elevation and true azimuth of the sun for every minute of a year."""

    def __init__(self, lat, lon, altitude=0.0, year=SUN_YEAR):
        self.year = year
        self.lat = lat
        self.lon = lon
        days = 366 if calendar.isleap(year) else 365
        times = pd.date_range("{}-01-01 00:00:30".format(year), periods=days * 1440,
                              freq="min", tz="UTC")
        sp = solar_position(times, lat, lon, altitude)
        self.elevation = sp["apparent_elevation"].to_numpy(dtype=np.float64)
        self.azimuth = sp["azimuth"].to_numpy(dtype=np.float64)
        self.days = days
        self.day_index = np.repeat(np.arange(days), 1440)
        dates = pd.date_range("{}-01-01".format(year), periods=days, freq="D")
        self.months = dates.month.to_numpy()
        self.day_of = {(int(d.month), int(d.day)): k for k, d in enumerate(dates)}
        self._sorted = None

    def daily_minutes(self, profiles, batch=64, step_deg=STEP_DEG):
        """Sunlit minutes per day for each horizon profile: an int32 array (profiles x days).

        A profile of None means a flat horizon at 0 deg. Profiles are worked in
        batches of similar highest horizon: a minute with the sun above every
        profile of a batch is lit for all of them and one below every profile
        is lit for none, so only the minutes in between are tested one by one.
        """
        n_rays = int(round(360.0 / step_deg))
        H = np.asarray([np.zeros(n_rays) if p is None else np.asarray(p, dtype=np.float64)
                        for p in profiles], dtype=np.float64).reshape(-1, n_rays)
        out = np.zeros((len(H), self.days), dtype=np.int32)
        if not len(H):
            return out
        if self._sorted is None:
            self._sorted = np.sort(self.elevation.reshape(self.days, 1440), axis=1)
        x = np.mod(self.azimuth, 360.0) / step_deg
        i0_all = np.floor(x).astype(np.int64) % n_rays
        w_all = x - np.floor(x)
        order = np.argsort(H.max(axis=1), kind="stable")
        day_range = np.arange(self.days)
        for b0 in range(0, len(H), batch):
            rows = order[b0:b0 + batch]
            h = H[rows]
            lo, hi = float(h.min()), float(h.max())
            above = 1440 - np.array([np.searchsorted(self._sorted[d], hi, side="right")
                                     for d in day_range])
            amb = np.flatnonzero((self.elevation > lo) & (self.elevation <= hi))
            counts = np.zeros((len(rows), self.days), dtype=np.int64)
            if len(amb):
                i0 = i0_all[amb]
                i1 = (i0 + 1) % n_rays
                w = w_all[amb]
                hz = h[:, i0] * (1.0 - w) + h[:, i1] * w
                lit = self.elevation[amb][None, :] > hz
                day = self.day_index[amb]
                starts = np.searchsorted(day, day_range, side="left")
                ends = np.searchsorted(day, day_range, side="right")
                cs = np.concatenate([np.zeros((len(rows), 1), dtype=np.int64),
                                     np.cumsum(lit, axis=1)], axis=1)
                counts = cs[:, ends] - cs[:, starts]
            out[rows] = (above[None, :] + counts).astype(np.int32)
        return out

    def summary(self, minutes):
        """The facts.json hours for one profile's daily minutes."""
        hours = np.asarray(minutes, dtype=np.float64) / 60.0
        monthly = [round(float(hours[self.months == m].mean()), 2) for m in range(1, 13)]
        decjan = hours[(self.months == 12) | (self.months == 1)]
        return {"dec21_h": round(float(hours[self.day_of[DEC21]]), 2),
                "decjan_mean_h": round(float(decjan.mean()), 2),
                "jun21_h": round(float(hours[self.day_of[JUN21]]), 2),
                "monthly_h": monthly}

    def median_summary(self, minutes_matrix):
        """Per-quantity medians over many profiles (each quantity's median separately)."""
        rows = [self.summary(m) for m in minutes_matrix]
        if not rows:
            return None
        return {"dec21_h": round(float(np.median([r["dec21_h"] for r in rows])), 2),
                "decjan_mean_h": round(float(np.median([r["decjan_mean_h"] for r in rows])), 2),
                "jun21_h": round(float(np.median([r["jun21_h"] for r in rows])), 2),
                "monthly_h": [round(float(np.median([r["monthly_h"][k] for r in rows])), 2)
                              for k in range(12)]}


def sun_path(lat, lon, year, month, day, altitude=0.0, step_min=PATH_STEP_MIN):
    """[[true azimuth, apparent elevation]] every `step_min` minutes while the sun is up."""
    times = pd.date_range("{}-{:02d}-{:02d} 00:00:00".format(year, month, day),
                          periods=24 * 60 // step_min, freq="{}min".format(step_min), tz="UTC")
    sp = solar_position(times, lat, lon, altitude)
    out = []
    for az, el in zip(sp["azimuth"].to_numpy(), sp["apparent_elevation"].to_numpy()):
        if el > 0.0:
            out.append([round(float(az), 2), round(float(el), 2)])
    return out
