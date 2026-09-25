/* Commons World: the specs panel and the credits.
 *
 * Everything is built with DOM nodes and textContent, never innerHTML, because the
 * values come from files. A missing value reads "not stated"; it is never shown as 0.
 * Non-ASCII characters are written as \u escapes so this file stays pure ASCII.
 */

const NOT_STATED = 'not stated';
const M2 = ' m\u00b2';
const DASH = '\u2013';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

const has = (v) => v !== null && v !== undefined && !(typeof v === 'number' && !isFinite(v));

export function fmtNumber(v, digits = 0) {
  if (!has(v)) return NOT_STATED;
  return Number(v).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMoney(v, currency) {
  if (!has(v)) return NOT_STATED;
  return fmtNumber(v, Math.abs(v) < 100 && v % 1 ? 2 : 0) + (currency ? ' ' + currency : '');
}
export function fmtArea(v) { return has(v) ? fmtNumber(v, v < 100 && v % 1 ? 1 : 0) + M2 : NOT_STATED; }
function fmtHours(h) { return has(h) ? fmtNumber(h, 1) + ' h' : 'not computed'; }
function fmtDuration(h) {
  if (!has(h)) return 'not computed';
  const mins = Math.round(h * 60);
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + ' h ' + String(mins % 60).padStart(2, '0') + ' min';
}
function fmtDistance(m) {
  if (!has(m)) return 'not computed';
  return m >= 1000 ? fmtNumber(m / 1000, 1) + ' km' : fmtNumber(m) + ' m';
}
function fmtDeg(d) { return has(d) ? fmtNumber(d, 1) + '\u00b0' : 'not computed'; }
function fmtPercent(r) { return has(r) ? fmtNumber(r * 100, r * 100 < 10 ? 1 : 0) + '%' : NOT_STATED; }
function compass(deg) {
  if (!has(deg)) return '';
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function row(dl, label, value, note) {
  dl.append(el('dt', { text: label }), el('dd', { class: has(value) && value !== NOT_STATED ? null : 'none' },
    has(value) ? String(value) : NOT_STATED, note ? el('small', { text: note }) : null));
}

function section(title, id) {
  const s = el('section', { class: 'blk', 'aria-labelledby': id });
  s.append(el('h3', { id, text: title }));
  return s;
}

/* A block of measured facts: its method as a tooltip on the heading, and the same
 * method with the caveats in a details element that works without a pointer. */
function factBlock(title, id, block) {
  const s = section(title, id);
  const h = s.querySelector('h3');
  if (block && block.method) h.title = block.method;
  if (block && (block.method || (block.caveats && block.caveats.length))) {
    const d = el('details', { class: 'method' }, el('summary', { text: 'How this was measured' }));
    if (block.method) d.append(el('p', { text: block.method }));
    if (block.caveats && block.caveats.length) {
      const ul = el('ul');
      for (const c of block.caveats) ul.append(el('li', { text: String(c) }));
      d.append(ul);
    }
    s.append(d);
  }
  return s;
}

function safeLink(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' ? u.href : null;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- specs
export function renderSpecs(root, { listing, plot, facts, manifest }) {
  root.replaceChildren();
  const L = listing || {}, F = L.facts || {}, T = L.approved_text || {}, C = L.costs || {};
  const cur = F.currency || C.currency || '';

  const head = el('header', { class: 'phead' });
  head.append(el('div', { class: 'kicker', text: 'The house' }));
  head.append(el('h2', { id: 'specs-title', tabindex: '-1', text: T.nickname || T.address || 'Listing' }));
  if (T.nickname && T.address) head.append(el('p', { class: 'addr', text: T.address }));
  if (T.municipality) head.append(el('p', { class: 'muted', text: T.municipality }));
  root.append(head);

  // listing facts
  const ls = section('Listing', 'sp-listing');
  const dl = el('dl');
  row(dl, 'Asking price', has(F.asking_price) ? fmtMoney(F.asking_price, cur) : NOT_STATED);
  row(dl, 'Property type', F.property_type);
  row(dl, 'Built', has(F.build_year) ? String(F.build_year) : NOT_STATED);
  row(dl, 'Rooms', has(F.rooms) ? String(F.rooms) : NOT_STATED);
  row(dl, 'Bedrooms', has(F.bedrooms) ? String(F.bedrooms) : NOT_STATED);
  row(dl, 'Interior area (BRA-i)', has(F.bra_i_m2) ? fmtArea(F.bra_i_m2) : NOT_STATED);
  // BRA-e and TBA stand beside BRA-i in every Norwegian listing, and freehold decides the
  // transfer duty, so like the rows above they read "not stated" rather than vanish.
  row(dl, 'External area (BRA-e)', has(F.bra_e_m2) ? fmtArea(F.bra_e_m2) : NOT_STATED);
  row(dl, 'Terrace and balcony (TBA)', has(F.tba_m2) ? fmtArea(F.tba_m2) : NOT_STATED);
  row(dl, 'Condition report', F.condition_report || NOT_STATED);
  row(dl, 'Freehold', has(F.freehold) ? (F.freehold ? 'yes' : 'no') : NOT_STATED);
  if (has(F.plot_ownership)) row(dl, 'Plot ownership', F.plot_ownership);
  if (has(F.shared_debt)) row(dl, 'Shared debt', fmtMoney(F.shared_debt, cur));
  if (has(F.ground_rent)) row(dl, 'Ground rent', fmtMoney(F.ground_rent, cur));
  if (has(F.other_purchase_costs)) row(dl, 'Other purchase costs', fmtMoney(F.other_purchase_costs, cur));
  if (has(F.kommunale_avgifter_monthly)) row(dl, 'Municipal fees, monthly', fmtMoney(F.kommunale_avgifter_monthly, cur));
  if (has(F.eiendomsskatt_monthly)) row(dl, 'Property tax, monthly', fmtMoney(F.eiendomsskatt_monthly, cur));
  const texts = [['use_class', 'Use class'], ['zoning', 'Zoning'], ['services', 'Services'], ['heating', 'Heating'],
                 ['outbuildings', 'Outbuildings'], ['sea_water_access', 'Sea or water access'], ['parking', 'Parking']];
  for (const [k, label] of texts) if (T[k]) row(dl, label, T[k]);
  ls.append(dl);
  root.append(ls);

  // plot
  const ps = section('Plot', 'sp-plot');
  const pdl = el('dl');
  const parcels = (plot && plot.parcels) || [];
  let registered = 0, allRegistered = parcels.length > 0, polygon = 0;
  for (const p of parcels) {
    if (has(p.area_register_m2)) registered += p.area_register_m2; else allRegistered = false;
    if (has(p.area_polygon_m2)) polygon += p.area_polygon_m2;
  }
  const stated = has(F.plot_stated_m2) ? F.plot_stated_m2 : (plot ? plot.stated_plot_m2 : null);
  row(pdl, 'Stated in the listing', has(stated) ? fmtArea(stated) : NOT_STATED);
  row(pdl, 'Registered parcel', parcels.length ? fmtArea(allRegistered ? registered : polygon) : 'no parcel found',
      parcels.length && !allRegistered ? 'area of the drawn polygon; the register gives none' : null);
  ps.append(pdl);
  if (plot && plot.note) ps.append(el('p', { text: plot.note }));
  const classes = [...new Set(parcels.map((p) => p.accuracy_class).filter(Boolean))];
  ps.append(el('p', { class: 'muted', text: 'The boundary on the ground is approximate: it is drawn from the property register' +
    (classes.length ? ', whose accuracy class for it is ' + classes.join(', ') : '') + ', not from a survey.' }));
  if (plot && plot.source) ps.append(el('p', { class: 'src', text: 'Source: ' + plot.source }));
  root.append(ps);

  // cost, whole property, owned outright
  const cs = section('Cost of the whole property, owned outright', 'sp-cost');
  const cdl = el('dl');
  const ccur = C.currency || cur;
  const eur = (v) => has(v) ? fmtMoney(v, 'EUR') : null;
  row(cdl, 'Price and purchase costs', has(C.all_in) ? fmtMoney(C.all_in, ccur) : NOT_STATED, eur(C.all_in_eur));
  if (has(C.transfer_cost)) row(cdl, 'of which transfer duty', fmtMoney(C.transfer_cost, ccur));
  row(cdl, 'Monthly, owned outright', has(C.owned_outright_monthly) ? fmtMoney(C.owned_outright_monthly, ccur) : NOT_STATED,
      eur(C.owned_outright_monthly_eur));
  if (has(C.stated_monthly)) row(cdl, 'of which stated fees and tax', fmtMoney(C.stated_monthly, ccur));
  if (has(C.maintenance_monthly)) row(cdl, 'of which maintenance reserve', fmtMoney(C.maintenance_monthly, ccur));
  cs.append(cdl);
  if (Array.isArray(C.excludes) && C.excludes.length) {
    cs.append(el('p', { class: 'lbl', text: 'Not included' }));
    const ul = el('ul');
    for (const x of C.excludes) ul.append(el('li', { text: String(x) }));
    cs.append(ul);
  }
  const A = C.assumptions || {};
  const assum = [];
  if (has(A.local_per_eur)) assum.push('1 EUR = ' + fmtNumber(A.local_per_eur, 2) + ' ' + ccur + (A.fx_source ? ' (' + A.fx_source + ')' : ''));
  else if (A.fx_source) assum.push('Exchange rate: ' + A.fx_source);
  if (has(A.transfer_rate)) assum.push('transfer duty ' + fmtPercent(A.transfer_rate) + ' of the price');
  if (has(A.maintenance_rate_per_year)) assum.push('maintenance reserve ' + fmtPercent(A.maintenance_rate_per_year) + ' of the price a year');
  if (assum.length) cs.append(el('p', { class: 'muted', text: 'Assumptions: ' + assum.join('; ') + '.' }));
  if (Array.isArray(C.warnings)) for (const w of C.warnings) cs.append(el('p', { class: 'warn', text: String(w) }));
  const asOf = L.export && L.export.assumptions_as_of;
  cs.append(el('p', { class: 'src', text: 'Source: the property tracker\'s cost model' + (C.source ? ' (' + C.source + ')' : '') +
    ', on generic assumptions' + (asOf ? ' as of ' + asOf : '') + '. Figures are for the whole property, not per person.' }));
  root.append(cs);

  const link = L.link ? safeLink(L.link) : null;
  if (link) {
    const a = el('a', { class: 'btnlink', href: link, target: '_blank', rel: 'noopener noreferrer', text: 'Open the listing' });
    root.append(el('p', {}, a));
  }

  root.append(renderFacts(facts, manifest));
  return root;
}

// ---------------------------------------------------------------- measured facts
function sunRows(sun) {
  const pm = sun.plot_median || {};
  const t = pm.terrain || {}, c = pm.terrain_canopy || {}, a = sun.astronomical || {};
  const table = el('table', { class: 'num' });
  table.append(el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: '' }),
    el('th', { scope: 'col', text: 'Terrain only' }), el('th', { scope: 'col', text: 'With trees and buildings' }),
    el('th', { scope: 'col', text: 'Open horizon' }))));
  const body = el('tbody');
  for (const [k, label] of [['dec21_h', '21 Dec'], ['decjan_mean_h', 'Dec' + DASH + 'Jan average'], ['jun21_h', '21 Jun']]) {
    body.append(el('tr', {}, el('th', { scope: 'row', text: label }), el('td', { text: fmtHours(t[k]) }),
      el('td', { text: fmtHours(c[k]) }), el('td', { text: fmtHours(a[k]) })));
  }
  table.append(body);
  return table;
}

function monthlyBars(sun) {
  const pm = sun.plot_median || {};
  const t = (pm.terrain && pm.terrain.monthly_h) || [], c = (pm.terrain_canopy && pm.terrain_canopy.monthly_h) || [];
  if (t.length !== 12) return null;
  const max = Math.max(1, ...t.filter(has), ...c.filter(has));
  const list = el('ol', { class: 'bars', 'aria-label': 'Direct sun, hours a day, by month' });
  t.forEach((h, i) => {
    const li = el('li');
    li.append(el('span', { class: 'm', text: MONTHS[i] }));
    const bar = el('span', { class: 'b', 'aria-hidden': 'true' });
    const tb = el('i', { class: 't' }); tb.style.width = (100 * (has(h) ? h : 0) / max).toFixed(1) + '%';
    bar.append(tb);
    if (has(c[i])) { const cb = el('i', { class: 'c' }); cb.style.width = (100 * c[i] / max).toFixed(1) + '%'; bar.append(cb); }
    li.append(bar);
    li.append(el('span', { class: 'v', text: has(h) ? fmtNumber(h, 1) + (has(c[i]) ? ' / ' + fmtNumber(c[i], 1) : '') : 'n/a' }));
    list.append(li);
  });
  return list;
}

export function renderFacts(facts, manifest) {
  const wrap = el('section', { class: 'facts', 'aria-labelledby': 'sp-facts' });
  wrap.append(el('h3', { id: 'sp-facts', class: 'big', text: 'Measured facts' }));
  if (!facts) {
    wrap.append(el('p', { class: 'muted', text: 'Not computed yet. Slope, sun hours and walking routes are ' +
      'measured by the pipeline\'s facts step, which has not been run for this world.' }));
    return wrap;
  }
  if (facts.version !== 1) {
    wrap.append(el('p', { class: 'warn', text: 'facts.json version ' + facts.version + ' is not one this viewer reads.' }));
    return wrap;
  }
  const offset = manifest && manifest.crs ? manifest.crs.grid_north_offset_deg : null;

  // slope and flat ground
  const p = facts.plot;
  if (p) {
    const s = factBlock('Slope and flat ground', 'sf-plot', p);
    const dl = el('dl');
    if (has(p.analysed_m2)) row(dl, 'Ground analysed', fmtArea(p.analysed_m2), has(p.area_m2) ? 'of ' + fmtArea(p.area_m2) + ' in the parcel' : null);
    if (has(p.open_ground_m2)) row(dl, 'Open ground', fmtArea(p.open_ground_m2));
    if (has(p.elevation_min) && has(p.elevation_max)) row(dl, 'Height above sea', fmtNumber(p.elevation_min, 1) + DASH + fmtNumber(p.elevation_max, 1) + ' m');
    if (has(p.slope_median_deg)) row(dl, 'Typical slope', fmtDeg(p.slope_median_deg),
      has(p.slope_p10_deg) && has(p.slope_p90_deg) ? 'most of it between ' + fmtDeg(p.slope_p10_deg) + ' and ' + fmtDeg(p.slope_p90_deg) : null);
    if (p.plane_fit && has(p.plane_fit.slope_deg)) row(dl, 'Overall tilt', fmtDeg(p.plane_fit.slope_deg),
      has(p.plane_fit.aspect_true_deg) ? 'facing ' + compass(p.plane_fit.aspect_true_deg) + ' (' + fmtNumber(p.plane_fit.aspect_true_deg) + '\u00b0 true)' : null);
    const lp = p.largest_patch || {};
    if (has(lp.under5_m2)) row(dl, 'Largest patch under 5\u00b0', fmtArea(lp.under5_m2), has(lp.circle_under5_m) ? 'fits a circle ' + fmtNumber(lp.circle_under5_m, 1) + ' m across' : null);
    if (has(lp.under10_m2)) row(dl, 'Largest patch under 10\u00b0', fmtArea(lp.under10_m2), has(lp.circle_under10_m) ? 'fits a circle ' + fmtNumber(lp.circle_under10_m, 1) + ' m across' : null);
    s.append(dl);
    if (Array.isArray(p.bands_deg) && p.bands_deg.length) {
      const t = el('table', { class: 'num' });
      t.append(el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Slope' }), el('th', { scope: 'col', text: 'Area' }),
        el('th', { scope: 'col', text: 'Smoothed over 3 m' }))));
      const b = el('tbody');
      for (const band of p.bands_deg) {
        // the last band runs to vertical, which reads better as "over 30\u00b0" than "30-90\u00b0"
        const lab = has(band.to) && band.to < 90 ? fmtNumber(band.from) + DASH + fmtNumber(band.to) + '\u00b0' : 'over ' + fmtNumber(band.from) + '\u00b0';
        b.append(el('tr', {}, el('th', { scope: 'row', text: lab }), el('td', { text: fmtArea(band.m2) }), el('td', { text: fmtArea(band.m2_smoothed) })));
      }
      t.append(b);
      s.append(t);
    }
    if (Array.isArray(p.ratio_bands) && p.ratio_bands.length) {
      const ul = el('ul', { class: 'plain' });
      for (const r of p.ratio_bands) ul.append(el('li', { text: String(r.label) + ': ' + fmtArea(r.m2) }));
      s.append(ul);
    }
    wrap.append(s);
  } else {
    const s = section('Slope and flat ground', 'sf-plot');
    s.append(el('p', { class: 'muted', text: 'Not computed.' }));
    wrap.append(s);
  }

  // sun
  const sun = facts.sun;
  if (sun) {
    const s = factBlock('Sun on the plot, clear sky', 'sf-sun', sun);
    s.append(el('p', { class: 'muted', text: 'Hours of direct sun a day on the plot: the median over its ground, so half of it ' +
      'gets more and half less. With the terrain only, and with trees and buildings as well. Weather is not included.' }));
    s.append(sunRows(sun));
    const bars = monthlyBars(sun);
    if (bars) {
      s.append(el('p', { class: 'lbl', text: 'By month: terrain only / with trees and buildings' }));
      s.append(bars);
    }
    wrap.append(s);
  } else {
    const s = section('Sun on the plot', 'sf-sun');
    s.append(el('p', { class: 'muted', text: 'Not computed.' }));
    wrap.append(s);
  }

  // access
  const acc = facts.access;
  if (acc) {
    const s = factBlock('Peaks and trailheads', 'sf-access', acc);
    if (acc.network) s.append(el('p', { class: 'muted', text: 'Walking network: ' + acc.network }));
    const peaks = Array.isArray(acc.peaks) ? acc.peaks : [];
    if (peaks.length) {
      const ul = el('ul', { class: 'peaks' });
      for (const pk of peaks) {
        const li = el('li');
        li.append(el('b', { text: String(pk.name || 'Unnamed peak') }), ' ',
          el('span', { class: 'muted', text: has(pk.h) ? fmtNumber(pk.h) + ' m' : '' }));
        const bits = [];
        if (has(pk.route_m)) bits.push(fmtDistance(pk.route_m) + ' on foot');
        else if (has(pk.straight_m)) bits.push(fmtDistance(pk.straight_m) + ' away in a straight line');
        if (has(pk.climb_m)) bits.push(fmtNumber(pk.climb_m) + ' m of climb');
        if (has(pk.naismith_h) || has(pk.tobler_h)) {
          bits.push('about ' + [has(pk.naismith_h) ? fmtDuration(pk.naismith_h) + ' (Naismith)' : null,
            has(pk.tobler_h) ? fmtDuration(pk.tobler_h) + ' (Tobler)' : null].filter(Boolean).join(', '));
        }
        if (has(pk.bearing_true_deg)) bits.push('to the ' + compass(pk.bearing_true_deg));
        li.append(el('span', { class: 'line', text: bits.join(' \u00b7 ') }));
        // how sure the summit is (h_basis): a slope with no top near the name, or a top far from it
        const noTop = typeof pk.h_basis === 'string' && pk.h_basis.startsWith('no distinct top');
        const target = noTop ? 'the named point' : 'the summit';
        const reach = pk.reaches_summit === true ? 'The path network reaches ' + target + '.'
          : pk.reaches_summit === false ? 'The path network stops ' + (has(pk.gap_m) ? fmtDistance(pk.gap_m) + ' ' : '') + 'short of ' + target + '.'
          : 'Whether a path reaches ' + target + ' was not computed.';
        li.append(el('span', { class: 'line muted', text: reach }));
        const note = noTop
          ? 'No distinct top near the name: the height is the ground at the place\'s own point.'
          : has(pk.summit_offset_m) && pk.summit_offset_m > 50
            ? 'The top measured is ' + fmtDistance(pk.summit_offset_m) + ' from the place\'s point, so it may be a neighbouring top.'
            : null;
        if (note) li.append(el('span', { class: 'line muted', text: note }));
        ul.append(li);
      }
      s.append(ul);
    } else {
      s.append(el('p', { class: 'muted', text: 'No peaks listed.' }));
    }
    const ths = Array.isArray(acc.trailheads) ? acc.trailheads : [];
    if (ths.length) {
      s.append(el('p', { class: 'lbl', text: 'Trailheads' }));
      const ul = el('ul', { class: 'plain' });
      for (const t of ths) {
        ul.append(el('li', { text: String(t.kind || 'trailhead') + ': ' + fmtDistance(t.route_m) + ' on foot' +
          (has(t.climb_m) ? ', ' + fmtNumber(t.climb_m) + ' m of climb' : '') }));
      }
      s.append(ul);
    }
    wrap.append(s);
  } else {
    const s = section('Peaks and trailheads', 'sf-access');
    s.append(el('p', { class: 'muted', text: 'Not computed.' }));
    wrap.append(s);
  }
  if (facts.generated_at) wrap.append(el('p', { class: 'src', text: 'Measured ' + String(facts.generated_at).slice(0, 10) +
    (has(offset) ? '. Bearings are true; the grid here is turned ' + fmtNumber(offset, 2) + '\u00b0 from true north.' : '.') }));
  return wrap;
}

// ---------------------------------------------------------------- credits
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https:\/\/[^\s)]+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0].replace(/^https:\/\//, '').replace(/\/$/, '') }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

export function renderCredits(body, manifest, noticeHref) {
  body.replaceChildren();
  const ul = el('ul');
  for (const c of (manifest && Array.isArray(manifest.credits) ? manifest.credits : [])) ul.append(el('li', {}, linkify(String(c))));
  ul.append(el('li', {}, 'three.js (MIT)'));
  body.append(ul);
  if (noticeHref) body.append(el('p', {}, el('a', { href: noticeHref, target: '_blank', rel: 'noopener', text: 'Full notice and sources' })));
}
