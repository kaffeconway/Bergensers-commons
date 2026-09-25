/* Commons World: where the sun is, and the site's clock. Imports nothing, so Node can test it.
 *
 * The sun: NOAA's spreadsheet equations (Meeus), as pipeline/tests/test_facts_sun.py writes
 * them out, plus the atmospheric refraction formula of pvlib's SPA (its apply condition,
 * the pressure pvlib derives from the altitude, and 12 C), which is what facts.json's
 * sun_path and hours use. Delta T is ignored (under 0.001 deg). Against pvlib's
 * nrel_numpy SPA the elevation and azimuth x cos(elevation) agree to about 0.015 deg.
 *
 * The clock: Intl with an IANA zone, en-GB and a 24 hour cycle, so a label reads
 * "21 Jun 16:20 CEST". Every label built here is ASCII: a zone name that is not two to five
 * capital letters is written as UTC+N instead.
 *
 * Bearings: azimuths are true, clockwise from north. The viewer draws a true azimuth A at
 * grid bearing A + crs.grid_north_offset_deg (world/FORMAT.md section 1): sunVector does
 * that once.
 */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const DAY_MS = 86400000;

// The year the facts are computed for when facts.json does not say: mirrors SUN_YEAR in
// world/pipeline/commons_world/facts/sun.py.
export const SUN_YEAR = 2026;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                            'September', 'October', 'November', 'December'];

// The site's zone by listing country (the pipeline's allow-list; build.py SITE_TIME_ZONES).
export const COUNTRY_ZONES = { NO: 'Europe/Oslo', FR: 'Europe/Paris', IT: 'Europe/Rome', ES: 'Europe/Madrid' };
export const CANARY_ZONE = 'Atlantic/Canary';

// ------------------------------------------------------------------ the sun
export function pressureMbar(altitudeM) {
  return Math.pow((44331.514 - altitudeM) / 11880.516, 1 / 0.1902632);   // pvlib alt2pres / 100
}

// pvlib spa.atmospheric_refraction_correction, with its apply condition
export function refraction(e0, pMbar, tempC = 12) {
  if (e0 < -(0.26667 + 0.5667)) return 0;
  return (pMbar / 1010) * (283 / (273 + tempC)) * 1.02 / (60 * Math.tan(D2R * (e0 + 10.3 / (e0 + 5.11))));
}

/* The sun at a UTC instant (epoch ms) seen from lat, lon (degrees) at altM metres:
 * {azimuth (true), elevation (apparent, of the centre), geometric (without refraction)}. */
export function sunPosition(utcMs, latDeg, lonDeg, altM = 0) {
  const jd = (utcMs - J2000_MS) / DAY_MS + 2451545.0;
  const t = (jd - 2451545.0) / 36525.0;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const mr = m * D2R;
  const c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
            Math.sin(3 * mr) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * D2R;
  const lam = (l0 + c - 0.00569 - 0.00478 * Math.sin(omega)) * D2R;
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * D2R;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const y = Math.tan(eps / 2) ** 2, l0r = l0 * D2R;
  const eot = 4 * R2D * (y * Math.sin(2 * l0r) - 2 * e * Math.sin(mr) + 4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) -
                         0.5 * y * y * Math.sin(4 * l0r) - 1.25 * e * e * Math.sin(2 * mr));
  const minutes = (((utcMs % DAY_MS) + DAY_MS) % DAY_MS) / 60000;
  const tst = (((minutes + eot + 4 * lonDeg) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * D2R;
  const phi = latDeg * D2R;
  const cz = Math.max(-1, Math.min(1, Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)));
  const e0 = 90 - R2D * Math.acos(cz);
  let az = R2D * Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + 180;
  az = ((az % 360) + 360) % 360;
  return { azimuth: az, elevation: e0 + refraction(e0, pressureMbar(altM)), geometric: e0 };
}

/* A true azimuth and elevation as a unit vector in the viewer's frame (x east, y up, z
 * south), drawn at grid bearing b = true + offset: (sin b cos e, sin e, -cos b cos e). */
export function sunVector(azTrue, el, offsetDeg) {
  const b = (azTrue + offsetDeg) * D2R, e = el * D2R;
  return [Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e)];
}

/* The facts' horizon rule: the profile's angle at a true azimuth, linear between rays. */
export function horizonAt(profile, az, step = 0.5) {
  const n = profile.length, x = (((az % 360) + 360) % 360) / step;
  const i0 = Math.floor(x) % n, w = x - Math.floor(x);
  return profile[i0] * (1 - w) + profile[(i0 + 1) % n] * w;
}

/* Sunlit minutes of the `minutes`-minute day starting at dayStartUtcMs, by the facts' rule:
 * each minute sampled at its middle (hh:mm:30), lit when the apparent elevation of the
 * centre is above the profile at the sun's true azimuth (a flat 0 deg horizon when the
 * profile is null). */
export function dailyMinutes(dayStartUtcMs, lat, lon, alt, profile, minutes = 1440) {
  let lit = 0;
  for (let k = 0; k < minutes; k++) {
    const s = sunPosition(dayStartUtcMs + k * 60000 + 30000, lat, lon, alt);
    if (s.elevation > (profile ? horizonAt(profile, s.azimuth) : 0)) lit++;
  }
  return lit;
}

// ------------------------------------------------------------------ the clock
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
                                           hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { fmt(tz); return true; } catch (e) { return false; }
}

/* The local calendar and clock at a UTC instant: {y, mo, d, h, mi, s, zone}. */
export function localParts(utcMs, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(utcMs))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, zone: o.timeZoneName };
}

/* Minutes the zone is ahead of UTC at an instant. */
export function offsetMin(utcMs, tz) {
  const p = localParts(utcMs, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/* The UTC instant of the local midnight that starts the local day y-mo-d. */
export function localMidnight(y, mo, d, tz) {
  let guess = Date.UTC(y, mo - 1, d);
  for (let k = 0; k < 3; k++) guess = Date.UTC(y, mo - 1, d) - offsetMin(guess, tz) * 60000;
  return guess;
}

/* The local day y-mo-d as a UTC interval: {start, end, minutes} (1380, 1440 or 1500 minutes
 * on DST change days). Minutes on the slider are counted from `start`, so a gap or an
 * overlap in the local clock comes out right by construction. */
export function localDay(y, mo, d, tz) {
  const a = localMidnight(y, mo, d, tz);
  const n = new Date(Date.UTC(y, mo - 1, d + 1));
  const b = localMidnight(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), tz);
  return { start: a, end: b, minutes: Math.round((b - a) / 60000) };
}

/* The zone's name at an instant as ASCII: the short name when it is two to five capital
 * letters (CET, CEST, UTC, WEST), else UTC+N or UTC+N:MM. */
export function zoneLabel(utcMs, tz) {
  let name = '';
  try { name = localParts(utcMs, tz).zone || ''; } catch (e) { name = ''; }
  if (/^[A-Z]{2,5}$/.test(name)) return name;
  let off = 0;
  try { off = offsetMin(utcMs, tz); } catch (e) { off = 0; }
  if (!off) return 'UTC';
  const a = Math.abs(off), h = Math.floor(a / 60), m = a % 60;
  return 'UTC' + (off < 0 ? '-' : '+') + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

const pad2 = (v) => String(v).padStart(2, '0');

/* "21 Jun 16:20 CEST" (withYear: "21 Jun 2026, 16:20 CEST"). */
export function formatLocal(utcMs, tz, withYear = false) {
  const p = localParts(utcMs, tz);
  const date = p.d + ' ' + MONTHS[p.mo - 1] + (withYear ? ' ' + p.y + ',' : '');
  return date + ' ' + pad2(p.h) + ':' + pad2(p.mi) + ' ' + zoneLabel(utcMs, tz);
}

export function formatClock(utcMs, tz) {
  const p = localParts(utcMs, tz);
  return pad2(p.h) + ':' + pad2(p.mi);
}

/* The site's IANA zone: {tz, source}. The manifest's crs.time_zone, else the listing
 * country's zone, else UTC (labelled "UTC", never a guessed solar offset). */
export function siteZone(manifest, listing) {
  const tz = manifest && manifest.crs && manifest.crs.time_zone;
  if (validZone(tz)) return { tz, source: 'manifest' };
  const country = listing && listing.country;
  const lat = sitePosition(manifest, listing);
  let z = COUNTRY_ZONES[country];
  if (country === 'ES' && lat && lat.lat < 30) z = CANARY_ZONE;
  if (validZone(z)) return { tz: z, source: 'country' };
  return { tz: 'UTC', source: 'none' };
}

/* Where the sun is computed: {lat, lon, source} from the manifest's crs.lat_deg/lon_deg,
 * else the listing's geocode, else null (then there is no slider). */
export function sitePosition(manifest, listing) {
  const c = manifest && manifest.crs;
  if (c && Number.isFinite(c.lat_deg) && Number.isFinite(c.lon_deg) && Math.abs(c.lat_deg) <= 90) {
    return { lat: c.lat_deg, lon: c.lon_deg, source: 'manifest' };
  }
  const g = listing && listing.geocode;
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon) && Math.abs(g.lat) <= 90) {
    return { lat: g.lat, lon: g.lon, source: 'listing' };
  }
  return null;
}

// ------------------------------------------------------------------ the facts year
export function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
export function daysInYear(y) { return isLeap(y) ? 366 : 365; }

/* The year the slider covers: facts.sun.year, else SUN_YEAR. */
export function factsYear(facts) {
  const y = facts && facts.sun && facts.sun.year;
  return Number.isInteger(y) && y > 1900 && y < 3000 ? y : SUN_YEAR;
}

/* Day of the year (0-based) of month mo (1-12), day d, in year y. */
export function dayOfYear(y, mo, d) { return Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / DAY_MS); }

/* {mo, d} of day index `day` (0-based) of year y. */
export function dateOfDay(y, day) {
  const t = new Date(Date.UTC(y, 0, 1) + day * DAY_MS);
  return { mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/* A local calendar date moved into year y: the month and day kept, 29 Feb becoming 28 Feb
 * in a year without it. */
export function dateInYear(y, mo, d) {
  if (mo === 2 && d === 29 && !isLeap(y)) return { y, mo: 2, d: 28 };
  return { y, mo, d };
}

/* The UTC instant a local clock reading y-mo-d h:mi has in zone tz; in a spring gap the
 * reading is taken with the offset before the change. */
export function utcFromLocal(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive - offsetMin(naive, tz) * 60000;
  guess = naive - offsetMin(guess, tz) * 60000;
  return guess;
}

/* Map a UTC instant into year y: the same local month, day and clock time (29 Feb to 28 Feb
 * when y has none). */
export function mapIntoYear(utcMs, y, tz) {
  const p = localParts(utcMs, tz);
  if (p.y === y) return utcMs;          // already there (and an hour that occurs twice stays itself)
  const t = dateInYear(y, p.mo, p.d);
  return utcFromLocal(t.y, t.mo, t.d, p.h, p.mi, tz);
}

/* ?t= : "2026-12-21T12:00" is site-local, a trailing Z means UTC; either is mapped into
 * year y. null when it does not parse. */
export function parseSiteTime(text, y, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z)?$/.exec(String(text || '').trim());
  if (!m) return null;
  const [Y, MO, D, H, MI] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  if (MO < 1 || MO > 12 || D < 1 || D > 31 || H > 23 || MI > 59) return null;
  if (m[7]) {
    const t = Date.UTC(Y, MO - 1, D, H, MI);
    if (new Date(t).getUTCDate() !== D) return null;
    return mapIntoYear(t, y, tz);
  }
  const d = dateInYear(y, MO, D);
  if (new Date(Date.UTC(d.y, d.mo - 1, d.d)).getUTCDate() !== d.d) return null;
  return utcFromLocal(d.y, d.mo, d.d, H, MI, tz);
}

/* A UTC instant as the slider's (day, minute): the local day's index in its year and the
 * minutes elapsed since that local midnight. */
export function sliderParts(utcMs, tz) {
  const p = localParts(utcMs, tz);
  const day = localDay(p.y, p.mo, p.d, tz);
  return { y: p.y, day: dayOfYear(p.y, p.mo, p.d), minute: Math.round((utcMs - day.start) / 60000), dayMinutes: day.minutes };
}

/* Local solar noon: the instant of the sun's highest (geometric) elevation between startMs
 * and endMs (a local day), to about a second. */
export function solarNoon(startMs, endMs, lat, lon) {
  let best = startMs, bestEl = -Infinity;
  for (let t = startMs; t <= endMs; t += 600000) {
    const el = sunPosition(t, lat, lon, 0).geometric;
    if (el > bestEl) { bestEl = el; best = t; }
  }
  let lo = Math.max(startMs, best - 600000), hi = Math.min(endMs, best + 600000);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 40; k++) {
    const a = hi - g * (hi - lo), b = lo + g * (hi - lo);
    if (sunPosition(a, lat, lon, 0).geometric > sunPosition(b, lat, lon, 0).geometric) hi = b; else lo = a;
  }
  return Math.round((lo + hi) / 2);
}
