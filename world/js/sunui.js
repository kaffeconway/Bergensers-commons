/* Commons World: the sun chip, the date and time panel, and their keys.
 *
 * The chip (#btn-sun) shows the date and time the shade is drawn for, whenever the world is
 * loaded, so a shared screenshot always says it. It opens #sun: a date slider over the facts
 * year, a time slider over the local day (minutes since local midnight, so DST days come
 * out right), four buttons, and a readout that keeps what is measured (from facts.json)
 * apart from what is drawn (this world's own heights).
 *
 * Keys: T opens and closes the panel; Comma and Period step the time by 10 minutes (also
 * while the pointer is locked); on a slider PageUp and PageDown step an hour or a week.
 * There is no Shift variant: Shift is a movement key in controls.js.
 * ?t=2026-12-21T12:00 opens at that site-local time (a trailing Z: UTC), mapped into the
 * facts year; the time is written back to the URL on each settled change. Nothing is kept
 * in localStorage. Every label built here is ASCII ("deg", never a degree sign).
 */
import { sunPosition, horizonAt, dailyMinutes, localParts, localDay, zoneLabel, formatLocal,
         dateOfDay, dayOfYear, daysInYear, dateInYear, utcFromLocal, mapIntoYear, parseSiteTime, sliderParts,
         solarNoon, MONTHS, MONTHS_LONG } from './sun.js';

const STEP = 10;                     // minutes per step of the time slider
const SETTLE_MS = 150;               // a keyboard step counts as settled after this long
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (az) => COMPASS[Math.round((((az % 360) + 360) % 360) / 45) % 8];
const fix1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const pad = (v) => String(v).padStart(2, '0');

export const FIXED_LINE = (km) => 'Shade here is drawn from this world\'s own height data, out to about ' + km +
  ' km. The measured hours in Specs also count mountains further away, use finer survey data, and are taken at ' +
  'eye height. Where they differ, trust the measured figure.';

export function createSunUi({ sun, manifest, camera, groundAt, requestFrame, closeOthers, onOpenChange, placeDock, isTouch }) {
  const $ = (id) => document.getElementById(id);
  const chip = $('btn-sun'), chipText = $('sun-chip-text'), panel = $('sun'), title = $('sun-title');
  const daySlider = $('sun-day'), timeSlider = $('sun-time'), dayOut = $('sun-day-out'), timeOut = $('sun-time-out');
  const when = $('sun-when'), linesEl = $('sun-lines'), fixed = $('sun-fixed');
  const tz = sun.zone.tz, year = sun.year, site = sun.site;
  const h20 = manifest.levels.find((l) => l.name === 'h20');
  const km = Math.round(((h20 && h20.radius) || 11000) / 1000);
  if (fixed) fixed.textContent = FIXED_LINE(km);

  let utc = null;                    // the instant shown
  let pending = null;                // a slider value not yet applied (coalesced per frame)
  let settleTimer = 0;
  let drawnLine = null, marchSeq = 0;
  const hoursCache = new Map();

  const enabled = sun.enabled && sun.defaultUtc !== null;
  chip.hidden = true;
  if (!enabled) return { enabled: false, flush() {}, tick() {}, isOpen: () => false, close() {}, open() {}, setTime() {},
                         showChip() {}, readout: () => ({ lines: [] }), sunTime: () => null };

  daySlider.max = String(daysInYear(year) - 1);

  // ---------------------------------------------------------------- time <-> sliders
  function partsOf(t) {
    const p = sliderParts(t, tz);
    return p;
  }
  function utcFor(day, minute) {
    const d = dateOfDay(year, day);
    const ld = localDay(year, d.mo, d.d, tz);
    return ld.start + Math.max(0, Math.min(ld.minutes - STEP, minute)) * 60000;
  }
  function snap(t) {
    const p = partsOf(t);
    return utcFor(p.day, Math.floor(p.minute / STEP) * STEP);
  }
  function sync() {
    const p = partsOf(utc);
    const d = dateOfDay(year, p.day);
    daySlider.value = String(p.day);
    timeSlider.max = String(p.dayMinutes - STEP);
    timeSlider.value = String(Math.round(p.minute / STEP) * STEP);
    const lp = localParts(utc, tz), zl = zoneLabel(utc, tz);
    daySlider.setAttribute('aria-valuetext', d.d + ' ' + MONTHS_LONG[d.mo - 1]);
    timeSlider.setAttribute('aria-valuetext', pad(lp.h) + ':' + pad(lp.mi) + ' ' + zl);
    dayOut.textContent = d.d + ' ' + MONTHS[d.mo - 1];
    timeOut.textContent = pad(lp.h) + ':' + pad(lp.mi) + ' ' + zl;
    chipText.textContent = lp.d + ' ' + MONTHS[lp.mo - 1] + ' ' + pad(lp.h) + ':' + pad(lp.mi);
    chip.classList.toggle('night', sun.night || sun.state.elevation <= 0);
    chip.setAttribute('aria-label', 'Sun and time: ' + lp.d + ' ' + MONTHS_LONG[lp.mo - 1] + ', ' + pad(lp.h) + ':' +
                      pad(lp.mi) + ' ' + zl + '. Change');
    track(p);
    renderLines();
  }

  // the time track: night, sun up but behind the terrain at the garden point, direct sun
  const NIGHT = 'rgba(19,30,27,.35)', BEHIND = 'rgba(53,116,138,.35)', DIRECT = 'rgba(138,106,47,.55)';
  let trackKey = '';
  function track(p) {
    const key = p.y + ':' + p.day;
    if (key === trackKey) return;
    trackKey = key;
    const d = dateOfDay(year, p.day), ld = localDay(year, d.mo, d.d, tz);
    const max = ld.minutes - STEP, prof = sun.profile, alt = sun.cw.altitude_m || 0, stops = [];
    let prev = null, from = 0;
    for (let m = 0; m <= max; m += STEP) {
      const s = sunPosition(ld.start + m * 60000, site.lat, site.lon, alt);
      const kind = s.elevation <= 0 ? NIGHT : prof && !(s.elevation > horizonAt(prof, s.azimuth)) ? BEHIND : DIRECT;
      if (kind !== prev) {
        if (prev !== null) stops.push(prev + ' ' + from + '%', prev + ' ' + (100 * (m - STEP / 2) / max).toFixed(2) + '%');
        prev = kind; from = (100 * Math.max(0, m - STEP / 2) / max).toFixed(2);
      }
    }
    stops.push(prev + ' ' + from + '%', prev + ' 100%');
    timeSlider.style.setProperty('--track', 'linear-gradient(to right, ' + stops.join(', ') + ')');
    // month ticks on the date track
    const days = daysInYear(year), ticks = [];
    for (let mo = 2; mo <= 12; mo++) {
      const x = 100 * dayOfYear(year, mo, 1) / (days - 1);
      ticks.push('transparent ' + (x - 0.25).toFixed(2) + '%', 'rgba(19,30,27,.35) ' + (x - 0.25).toFixed(2) + '%',
                 'rgba(19,30,27,.35) ' + (x + 0.25).toFixed(2) + '%', 'transparent ' + (x + 0.25).toFixed(2) + '%');
    }
    daySlider.style.setProperty('--track', 'linear-gradient(to right, ' + ticks.join(', ') + '), rgba(19,30,27,.16)');
  }

  // ---------------------------------------------------------------- the readout
  function hoursOn(t) {
    const lp = localParts(t, tz), key = lp.mo + '-' + lp.d;
    if (!hoursCache.has(key)) {
      const d = dateInYear(year, lp.mo, lp.d);
      hoursCache.set(key, dailyMinutes(Date.UTC(d.y, d.mo - 1, d.d), site.lat, site.lon, sun.cw.altitude_m || 0, sun.profile) / 60);
    }
    return hoursCache.get(key);
  }
  function lines() {
    const s = sun.cw, out = [];
    const head = formatLocal(utc, tz, true);
    if (s.elevation > 0) out.push(head + ': sun ' + fix1(s.elevation) + ' deg up, ' + compass(s.trueAzimuth) + ' (' + Math.round(s.trueAzimuth) + ' deg true)');
    else out.push(head + ': sun ' + fix1(-s.elevation) + ' deg below the horizon');
    if (sun.profile) {
      const hz = horizonAt(sun.profile, s.trueAzimuth);
      let now;
      if (s.behindFar) now = 'no direct sun now; the sun is behind mountains beyond the edge of this world';
      else if (s.elevation <= 0) now = 'the sun is down';
      else if (s.elevation > hz) now = 'direct sun now';
      else now = 'no direct sun now: the ground to the ' + compass(s.trueAzimuth) + ' stands ' + fix1(hz) + ' deg high';
      out.push('At the garden point (measured, clear sky, terrain only): ' + now + '; ' + fix1(hoursOn(utc)) + ' h of direct sun on this date.');
      if (s.behindFar) out.push('The sun is behind mountains beyond the edge of this world (measured).');
      const g = sun.garden;
      if (g && s.elevation > 0 && !s.behindFar) {
        const drawn = sun.shadeAt(g.x, g.z, 1.5);
        if (drawn.level !== 'none' && drawn.lit !== (s.elevation > hz)) {
          out.push('(drawn shade and measurement differ by under a quarter of a degree here)');
        }
      }
    } else {
      out.push('No measured sun figures for this world.');
    }
    if (drawnLine) out.push(drawnLine);
    return out.filter((l) => typeof l === 'string' && !/undefined|NaN|null/.test(l));
  }
  function renderLines() {
    const ls = lines();
    when.textContent = ls[0];
    linesEl.replaceChildren(...ls.slice(1).map((l) => { const li = document.createElement('li'); li.textContent = l; return li; }));
  }
  function march() {
    if (panel.hidden) return;
    const p = camera.position, g = groundAt(p.x, p.z);
    if (!g) return;
    const seq = ++marchSeq, at = utc;
    sun.march([{ x: p.x, z: p.z, eye: 1.5 }]).then((pts) => {
      if (seq !== marchSeq || at !== utc || !pts || !pts[0] || pts[0].lit === null) return;
      const r = pts[0];
      drawnLine = 'Where you stand, in this drawn world: ' + (r.reason === 'night' ? 'the sun is down.'
        : r.lit ? 'in direct sun.' : r.reason === 'gate' ? 'in shade; the sun is behind mountains beyond the edge of this world.'
        : 'in shade from the terrain.');
      renderLines();
    }, () => {});
  }

  // ---------------------------------------------------------------- applying a time
  function setTime(t, mode) {
    utc = t;
    sun.setTime(t, mode);
    drawnLine = null;
    sync();
    if (mode !== 'drag') { march(); }
  }
  function settleSoon() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_MS);
  }
  function settle() {
    settleTimer = 0;
    sun.setDragging(false);
    sun.settled();
    writeUrl();
    march();
  }
  function writeUrl() {
    try {
      const lp = localParts(utc, tz);
      const u = new URL(location.href);
      u.searchParams.set('t', lp.y + '-' + pad(lp.mo) + '-' + pad(lp.d) + 'T' + pad(lp.h) + ':' + pad(lp.mi));
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) { /* a sandboxed page may refuse; the time still applies */ }
  }
  function stepBy(minutes) {
    const p = partsOf(utc);
    let day = p.day, minute = p.minute + minutes;
    if (minute < 0 && day > 0) { day--; minute += partsOf(utcFor(day, 0)).dayMinutes; }
    else if (minute > p.dayMinutes - STEP && day < daysInYear(year) - 1) { minute -= p.dayMinutes; day++; }
    const t = utcFor(Math.max(0, Math.min(daysInYear(year) - 1, day)), minute);
    sun.setDragging(true);
    setTime(t, 'drag');
    settleSoon();
  }
  function withTimeOfDay(mo, d) {
    const lp = localParts(utc, tz), day = dateInYear(year, mo, d);
    return snap(utcFromLocal(day.y, day.mo, day.d, lp.h, lp.mi, tz));
  }

  // ---------------------------------------------------------------- events
  const onInput = () => { pending = { day: Number(daySlider.value), minute: Number(timeSlider.value) }; sun.setDragging(true); requestFrame(); };
  daySlider.addEventListener('input', onInput);
  timeSlider.addEventListener('input', onInput);
  const onChange = () => { flush(); settleSoon(); };
  daySlider.addEventListener('change', onChange);
  timeSlider.addEventListener('change', onChange);
  timeSlider.addEventListener('keydown', (ev) => {
    if (ev.key === 'PageUp' || ev.key === 'PageDown') { ev.preventDefault(); stepBy(ev.key === 'PageUp' ? 60 : -60); }
  });
  daySlider.addEventListener('keydown', (ev) => {
    if (ev.key === 'PageUp' || ev.key === 'PageDown') {
      ev.preventDefault();
      const p = partsOf(utc);
      const day = Math.max(0, Math.min(daysInYear(year) - 1, p.day + (ev.key === 'PageUp' ? 7 : -7)));
      sun.setDragging(true);
      setTime(utcFor(day, p.minute), 'drag');
      settleSoon();
    }
  });
  $('sun-now').addEventListener('click', () => { setTime(snap(mapIntoYear(Date.now(), year, tz)), 'full'); settle(); });
  $('sun-dec').addEventListener('click', () => { setTime(withTimeOfDay(12, 21), 'full'); settle(); });
  $('sun-jun').addEventListener('click', () => { setTime(withTimeOfDay(6, 21), 'full'); settle(); });
  $('sun-noon').addEventListener('click', () => {
    const p = partsOf(utc), d = dateOfDay(year, p.day), ld = localDay(year, d.mo, d.d, tz);
    const noon = solarNoon(ld.start, ld.end, site.lat, site.lon);
    const m = Math.round((noon - ld.start) / 60000 / STEP) * STEP;
    setTime(utcFor(p.day, m), 'full');
    settle();
  });

  function open() {
    if (!panel.hidden) return;
    closeOthers();
    panel.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    onOpenChange(true);
    placeDock();
    title.focus({ preventScroll: true });
    march();
  }
  function close() {
    if (panel.hidden) return;
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    onOpenChange(false);
    placeDock();
    if (hadFocus) chip.focus({ preventScroll: true });
  }
  chip.addEventListener('click', () => (panel.hidden ? open() : close()));
  $('sun-close').addEventListener('click', () => close());
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape' && !panel.hidden) { close(); chip.focus({ preventScroll: true }); return; }
    if (chip.hidden) return;
    if (ev.code === 'KeyT' && !ev.repeat) {
      ev.preventDefault();
      if (panel.hidden) {
        if (document.pointerLockElement) document.exitPointerLock();
        open();
        timeSlider.focus({ preventScroll: true });
      } else close();
      return;
    }
    if (ev.code === 'Comma' || ev.code === 'Period') {
      ev.preventDefault();
      stepBy(ev.code === 'Period' ? STEP : -STEP);
    }
  });

  // ---------------------------------------------------------------- start
  const q = new URLSearchParams(location.search).get('t');
  const fromUrl = q ? parseSiteTime(q, year, tz) : null;
  setTime(fromUrl !== null ? snap(fromUrl) : sun.defaultUtc, 'full');

  return {
    enabled: true,
    open, close,
    isOpen: () => !panel.hidden,
    // the coalesced slider update, at the top of each frame
    flush() {
      if (!pending) return;
      const p = pending;
      pending = null;
      setTime(utcFor(p.day, p.minute), 'drag');
    },
    tick() { if (!panel.hidden) march(); },
    showChip(show) { chip.hidden = !show; placeDock(); },
    setTime(t) { setTime(t, 'full'); },
    refresh() { sync(); },
    readout: () => ({ lines: lines() }),
    sunTime() {
      const p = partsOf(utc);
      return { utc, local: formatLocal(utc, tz), tz, day: p.day, minute: p.minute };
    },
    get utc() { return utc; }
  };
}
