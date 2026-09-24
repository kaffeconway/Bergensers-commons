/*
 * The triangle under the map, and the invariants that hold over index.html as a file.
 * See CLAUDE.md, "The triangle under the map", "Pure ASCII output required", "Forced light
 * color scheme", "Deploy" (.nojekyll), "Map data" and "Testing changes" (:focus-visible).
 *
 * THE TRIANGLE CAPTION
 *
 *   CLAUDE.md says a test pins the caption's listing total and per-region counts, and that
 *   two further assertions check the counts sum to the total and that a date is present.
 *   There was no such test; this is it. The caption is read off the results page the app
 *   actually renders for a small invented board - the paragraph straight after the
 *   triangle's own SVG, located by rendering triSVG(tally) and finding that exact markup
 *   on the page - so what is checked is what a reader sees, not a string in the source.
 *
 *   "A re-run fails until the caption is brought with it" works like this: RUN below holds
 *   the 15 Sept 2026 run twice over, as the caption states it (date, total, counts) and as
 *   the chart draws it (the weights in TRI). Re-running the averages changes TRI, which
 *   fails the weights pin, whose message says to bring the caption's date and counts along
 *   and then update RUN to match both.
 *
 *   Beyond what CLAUDE.md lists, the caption is held to the chart it sits under: it names
 *   every corner label the triangle draws, the dots sit exactly where their weights put
 *   them (so nobody spreads them apart in the drawing instead of the data), and the
 *   easy-to-reach weights follow the rail hours the caption states, scored as 1/hours.
 *
 * THE TRIANGLE DRAWING
 *
 *   Every board of up to fifteen people, each region's count 0..15 independently (16^4 =
 *   65,536 tallies, about two seconds): no label lands on a dot, no leader crosses another
 *   region's dot, no two dots overlap, every label stays inside the frame and clear of the
 *   others. Text width is modelled as the app models it (monospace, 0.6 em per character -
 *   its "9px monospace advance" of 5.4), and vertically from 0.92 em above the baseline to
 *   0.23 em below, which is what Chromium's getBBox() reports for these labels.
 *
 *   Separately, CLAUDE.md says the labels "sit outside the plot on leader lines". That is
 *   checked on its own, at an empty board and a full one, against the triangle's outline.
 *
 * DELIBERATELY NOT CHECKED
 *
 *   - Two caveats CLAUDE.md lists as being in the caption and which are not in it: that the
 *     axis scores are desk reads of listing text, and that the Italian average "rests on
 *     three listings". The caption itself says "Two things to hold against it" and carries
 *     the other two, so leaving these out reads as an editorial choice, and the second one
 *     contradicts the caption's own "Italian Alps 4". Which is right is not a test's call;
 *     the two it does carry are pinned so they cannot drop out silently.
 *   - The raw (pre-rescaling) averages and the rescaling itself. They live only in a code
 *     comment; the weights pin covers any change to what is drawn.
 *   - The exact CDN hosts' availability. The network is never touched; the fetch is stubbed
 *     both ways (refused, and answering with a tiny TopoJSON) to prove both paths work.
 *   - where-we-landed.html. CLAUDE.md puts it outside the ASCII rule and it shares no code.
 *
 * Fixtures are invented first names only. This file is pure ASCII; non-ASCII test text is
 * written as \u escapes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  loadApp, INDEX_PATH, REPO_ROOT, readIndexHtml, readIndexBytes, extractScripts,
  buildCode, sampleAnswer,
} from "./harness.mjs";

const VEST = "Vestland, Norway \u2014 the fjords";
const FRENCH = "French Alps, Vercors & Chartreuse";
const ITALY = "Italian Alps";
const PYR = "Pyrenees";
const MIDDOT = "\u00b7";

/* The 15 Sept 2026 run, as CLAUDE.md records it and as the page publishes it.
   Update all of it together, and only after re-running the tracker's averages. */
const RUN = Object.freeze({
  day: 15, month: 9, year: 2026,
  total: 30,
  counts: { [FRENCH]: 12, [VEST]: 8, [PYR]: 6, [ITALY]: 4 },
  /* (land & space, affordable, easy to reach), as TRI holds them */
  weights: {
    [PYR]: [1.00, 0.525, 0.71],
    [ITALY]: [0.743, 1.00, 0.77],
    [FRENCH]: [0.812, 0.470, 1.00],
    [VEST]: [0.600, 0.530, 0.28],
  },
});

/* ------------------------------------------------------------------ text helpers */

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "\u2014",
  ndash: "\u2013", middot: "\u00b7", frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be",
  hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d",
  euro: "\u20ac", times: "\u00d7", sup2: "\u00b2", deg: "\u00b0", minus: "\u2212",
  eacute: "\u00e9", egrave: "\u00e8", aacute: "\u00e1", oslash: "\u00f8", aring: "\u00e5",
};
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}
/* Markup to the text a reader sees: tags dropped, entities decoded, whitespace collapsed. */
const textOf = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, "")).replace(/[\s\u00a0]+/g, " ").trim();
const sentences = (text) => text.split(/(?<=[.!?])\s+(?=[A-Z"\u201c(])/).map((s) => s.trim()).filter(Boolean);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const attrsOf = (s) => {
  const o = {};
  for (const m of String(s).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g)) {
    o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return o;
};
/* ASCII-only rendering of any text, for failure messages. */
const asciiSafe = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => {
  const cp = c.codePointAt(0);
  return c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\u" + cp.toString(16).padStart(4, "0");
});
const lineCol = (text, idx) => {
  const before = text.slice(0, idx);
  const line = before.split("\n").length;
  return { line, col: idx - before.lastIndexOf("\n") };
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
/* The first date in the text, as {day, month, year?}: "15 September", "15 Sept 2026",
   "September 15, 2026" or "2026-09-15". */
function findDate(text) {
  let m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4}))?`, "i"));
  if (m) return { day: +m[1], month: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, year: m[3] ? +m[3] : undefined, text: m[0] };
  m = text.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i"));
  if (m) return { day: +m[2], month: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, year: m[3] ? +m[3] : undefined, text: m[0] };
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return { day: +m[3], month: +m[2], year: +m[1], text: m[0] };
  return null;
}
const hoursOf = (s) => {
  const t = String(s).replace("\u00bd", ".5").replace("\u00bc", ".25").replace("\u00be", ".75");
  return parseFloat(t.startsWith(".") ? "0" + t : t);
};

/* A sentence that names Vestland or the Pyrenees, talks about money, and puts things in
   order. CLAUDE.md: the two changed places on "affordable" by four thousandths, so the
   caption must not claim an order between them. */
const VP = /\b(?:Vestland|Norway|Norwegian|Bergen|Pyrenees|Pyr\u00e9n\u00e9es)\b/i;
const MONEY = /afford|cheap|pric|cost|expens|\bdear|budget|\beuro|\u20ac|money/i;
const ORDER = new RegExp("\\b(?:cheaper|cheapest|dearer|dearest|pricier|priciest|costlier|costliest|" +
  "(?:more|most|less|least)\\s+(?:affordable|expensive|costly)|than|ahead|behind|beats?|beaten|" +
  "outscores?|outranks?|edges?\\s+out|ranks?|ranked|ranking|in\\s+(?:that|this)\\s+order|" +
  "lowest|highest|lower|higher|better|worse|best|worst|tops|trails?)\\b", "i");
const orderingClaims = (text) => sentences(text).filter((s) => VP.test(s) && MONEY.test(s) && ORDER.test(s));

/* ------------------------------------------------------------------ the results page */

const PEOPLE = [
  ["Ada", [PYR, ITALY]],
  ["Bo", [VEST]],
  ["Cato", [FRENCH, ITALY]],
  ["Dag", [VEST, PYR]],
];
function tallyFor(app, codes) {
  const t = {};
  codes.forEach((c) => app.rgOf(c).forEach((r) => { t[r] = (t[r] || 0) + 1; }));
  return t;
}
function renderResults(opts = {}) {
  const app = loadApp(opts);
  const codes = PEOPLE.map(([n, rg]) => app.decode(buildCode(4, sampleAnswer({ n, rg, pn: {} }))));
  app.codes = codes;
  app.mode = "result";
  app.render();
  return { app, codes, html: app.dom.appHTML() };
}
let shared = null;
function resultsPage() {
  if (shared) return shared;
  const { app, codes, html } = renderResults();
  const rgT = tallyFor(app, codes);
  const svg = app.triSVG(rgT);
  const at = typeof svg === "string" ? html.indexOf(svg) : -1;
  let caption = null, intro = null;
  if (at >= 0) {
    const after = html.slice(at + svg.length);
    const next = after.search(/<h[1-6]\b/i);
    const m = (next >= 0 ? after.slice(0, next) : after).match(/<p class="hint">([\s\S]*?)<\/p>/);
    if (m) caption = textOf(m[1]);
  }
  const mb = html.indexOf('id="mapbox"');
  if (mb >= 0) {
    const before = html.slice(0, mb);
    const head = before.lastIndexOf("<h3");
    const hints = [...before.slice(head >= 0 ? head : 0).matchAll(/<p class="hint">([\s\S]*?)<\/p>/g)];
    if (hints.length) intro = textOf(hints[hints.length - 1][1]);
  }
  shared = { app, codes, html, rgT, svg, at, caption, intro };
  return shared;
}
function captionOrFail() {
  const { caption } = resultsPage();
  assert.ok(caption, "the results page has a caption paragraph straight after the triangle");
  return caption;
}
/* The caption's per-region listing counts, keyed by full region name. */
function captionCounts(app, caption) {
  const out = {}, missing = [];
  for (const [nm] of app.TRI) {
    const short = (app.SHORT && app.SHORT[nm]) || nm;
    const hits = [...caption.matchAll(new RegExp(`\\b${reEsc(short)}\\s*(?:${MIDDOT}|:|\u2014|-)?\\s*(\\d+)\\b`, "g"))];
    if (hits.length !== 1) missing.push(`${short} (${hits.length} counts found)`);
    else out[nm] = +hits[0][1];
  }
  return { out, missing };
}
const captionTotal = (caption) => {
  const m = caption.match(/\b(\d+)\s+(?:tracked\s+|live\s+)?listings\b/i);
  return m ? +m[1] : null;
};

describe("Triangle caption, as the results page publishes it", () => {
  test("the triangle, its caption and the section intro are all on the results page", () => {
    const { at, caption, intro } = resultsPage();
    assert.ok(at >= 0, "the results page draws triSVG() of the board's own region tally");
    assert.ok(caption && caption.length > 80, `a caption follows the triangle (got ${JSON.stringify(caption)})`);
    assert.ok(intro, "the map section opens with an intro paragraph");
  });

  test("the triangle plots exactly the regions on the shortlist", () => {
    const { app } = resultsPage();
    const plotted = app.TRI.map((r) => r[0]).slice().sort();
    const shortlist = app.REGIONS.filter((r) => r !== app.OFFLIST).slice().sort();
    assert.deepEqual(plotted, shortlist);
  });

  test("the caption carries a date", () => {
    const caption = captionOrFail();
    const d = findDate(caption);
    assert.ok(d && d.day >= 1 && d.day <= 31 && d.month >= 1,
      `CLAUDE.md: the counts are printed "with the date they were computed". Caption: ${asciiSafe(caption)}`);
  });

  test("the caption's per-region listing counts add up to the total it states", () => {
    const { app } = resultsPage();
    const caption = captionOrFail();
    const total = captionTotal(caption);
    assert.ok(total !== null, `the caption states a listing total ("N tracked listings"): ${asciiSafe(caption)}`);
    const { out, missing } = captionCounts(app, caption);
    assert.deepEqual(missing, [], "every region the triangle plots has exactly one listing count in the caption");
    const sum = Object.values(out).reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `the counts ${JSON.stringify(out)} sum to ${sum}, the caption says ${total}`);
  });

  test("the caption is the 15 Sept 2026 run: 30 listings - French Alps 12, Vestland 8, Pyrenees 6, Italian Alps 4", () => {
    const { app } = resultsPage();
    const caption = captionOrFail();
    const stale = "If the tracker was re-run, update the caption and RUN in this file together.";
    assert.equal(captionTotal(caption), RUN.total, `listing total. ${stale}`);
    assert.deepEqual(captionCounts(app, caption).out, RUN.counts, `per-region listing counts. ${stale}`);
    const d = findDate(caption);
    assert.ok(d, "a date is present");
    assert.deepEqual([d.day, d.month], [RUN.day, RUN.month], `the caption is dated ${JSON.stringify(d.text)}. ${stale}`);
    if (d.year !== undefined) assert.equal(d.year, RUN.year, `the caption's year. ${stale}`);
  });

  test("the triangle's weights are still the 15 Sept 2026 run's", () => {
    const { app } = resultsPage();
    const got = Object.fromEntries(app.TRI.map(([nm, m, a, c]) => [nm, [m, a, c]]));
    assert.deepEqual(got, RUN.weights,
      "TRI no longer holds the averages of the 15 Sept 2026 run. If they were re-run against the tracker, " +
      "the caption's date, listing total and per-region counts have to come with them (CLAUDE.md: the failure " +
      "mode is a stale claim, not a visibly wrong chart). Then update RUN in this file to match both. If they " +
      "were nudged by hand, CLAUDE.md says re-run them instead.");
  });

  test("the caption says which two axes come from the listings, and names every corner the chart draws", () => {
    const { svg } = resultsPage();
    const caption = captionOrFail();
    const measured = sentences(caption).filter((s) => /land & space/i.test(s) && /\baffordable\b/i.test(s) && /\blistings?\b/i.test(s));
    assert.ok(measured.length, `a sentence ties land & space and affordable to the listings: ${asciiSafe(caption)}`);
    assert.ok(measured.every((s) => !/easy to reach/i.test(s)), "that sentence does not put easy to reach among them");
    const corners = readTri(svg).texts.filter((t) => t.text === t.text.toUpperCase() && /[A-Z]{4}/.test(t.text));
    assert.equal(corners.length, 3, `three corner labels on the triangle (${JSON.stringify(corners.map((t) => t.text))})`);
    for (const t of corners) {
      assert.ok(caption.toLowerCase().includes(t.text.toLowerCase()), `the caption names the ${JSON.stringify(t.text)} corner`);
    }
  });

  test("easy to reach is rail hours, and the page says it is not from the listings", () => {
    const { intro } = resultsPage();
    const caption = captionOrFail();
    const reach = sentences(caption).filter((s) => /easy to reach/i.test(s));
    assert.ok(reach.some((s) => /\brail\b/i.test(s) && /\bhours?\b/i.test(s) && /\bnot\b/i.test(s)),
      `the caption says easy to reach is rail hours and not one of the measured axes: ${asciiSafe(caption)}`);
    assert.ok(/\btwo of its three axes\b/i.test(intro) && /\brail\b/i.test(intro),
      `the section intro still says "two of its three axes" and that the third is rail: ${asciiSafe(intro)}`);
  });

  test("the easy-to-reach weights follow the caption's rail hours, scored as 1/hours", () => {
    const { app } = resultsPage();
    const caption = captionOrFail();
    const hrs = (town) => {
      const m = caption.match(new RegExp(`about\\s+(\\d*[.\\d]*[\u00bd\u00bc\u00be]?)\\s*(?:hours?\\s+)?to\\s+${town}\\b`, "i"));
      return m ? hoursOf(m[1]) : NaN;
    };
    const grenoble = hrs("Grenoble"), bergen = hrs("Bergen");
    assert.ok(grenoble > 0 && bergen > 0, `the caption gives rail hours to Grenoble (${grenoble}) and Bergen (${bergen})`);
    const reach = Object.fromEntries(app.TRI.map(([nm, , , c]) => [nm, c]));
    const got = reach[VEST] / reach[FRENCH], want = grenoble / bergen;
    assert.ok(Math.abs(got - want) < 0.02,
      `Vestland/French Alps easy-to-reach is ${got.toFixed(3)}; 1/hours on the caption's ${grenoble}h and ${bergen}h gives ${want.toFixed(3)}`);
  });

  test("the caption says a dot's place is the balance of the three, not the level of any one", () => {
    const caption = captionOrFail();
    assert.ok(sentences(caption).some((s) => /\bbalance\b/i.test(s) && /\blevel\b/i.test(s) && /\bnot\b/i.test(s)),
      `CLAUDE.md: without this "a high dot reads as a claim that the region is best overall". Caption: ${asciiSafe(caption)}`);
  });

  test("nothing orders Vestland and the Pyrenees on affordability", () => {
    /* the detector itself, so a pass means something */
    assert.equal(orderingClaims("Vestland is now slightly more affordable than the Pyrenees.").length, 1);
    assert.equal(orderingClaims("On price the Pyrenees edge out Vestland.").length, 1);
    assert.equal(orderingClaims("Norway comes out cheapest of the four.").length, 1);
    assert.equal(orderingClaims("Vestland and the Pyrenees score alike on affordability.").length, 0);
    const { intro, svg } = resultsPage();
    const caption = captionOrFail();
    const drawn = readTri(svg);
    const svgText = [attrsOf(svg.match(/<svg\b([^>]*)>/)[1])["aria-label"] || "",
      ...drawn.texts.map((t) => t.text), ...drawn.circles.map((c) => c.title)].join(". ");
    for (const [where, text] of [["caption", caption], ["section intro", intro], ["triangle SVG", svgText]]) {
      assert.deepEqual(orderingClaims(text || ""), [], `the ${where} claims an order between Vestland and the Pyrenees`);
    }
  });

  test("the tracker's caveats the caption carries are still there", () => {
    const caption = captionOrFail();
    assert.ok(/\bfour answers\b/i.test(caption),
      `the priority weights rest on four answers out of about fifteen, and the caption says so: ${asciiSafe(caption)}`);
    assert.ok(/\brenovation\b/i.test(caption) && /\bfloor\b/i.test(caption),
      "renovation is blank on every listing, so every price is a floor, and the caption says so");
  });
});

/* ------------------------------------------------------------------ the triangle drawing */

function readTri(svg) {
  const circles = [], texts = [], lines = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)>([\s\S]*?)<\/circle>/g)) {
    const a = attrsOf(m[1]);
    const t = (m[2].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    circles.push({
      cx: +a.cx, cy: +a.cy, r: +a.r, sw: +(a["stroke-width"] || 0),
      title: decodeEntities(t).trim(),
      name: decodeEntities(t).trim().replace(/\s\u2014\s\d+$/, ""),
    });
  }
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = attrsOf(m[1]);
    texts.push({ x: +a.x, y: +a.y, anchor: a["text-anchor"] || "start", size: +a["font-size"], text: textOf(m[2]) });
  }
  for (const m of svg.matchAll(/<line\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    lines.push({ x1: +a.x1, y1: +a.y1, x2: +a.x2, y2: +a.y2, w: +(a["stroke-width"] || 1) });
  }
  const poly = svg.match(/<polygon\b([^>]*)>/);
  const pa = poly ? attrsOf(poly[1]) : {};
  const points = (pa.points || "").trim().split(/\s+/).filter(Boolean).map((p) => p.split(",").map(Number));
  return { circles, texts, lines, points, polyStroke: +(pa["stroke-width"] || 1) };
}
/* The ink box of a label: monospace at 0.6 em a character; 0.92 em up, 0.23 em down. */
function textBox(t) {
  const w = [...t.text].length * t.size * 0.6;
  const x0 = t.anchor === "end" ? t.x - w : t.anchor === "middle" ? t.x - w / 2 : t.x;
  return { x0, x1: x0 + w, y0: t.y - 0.92 * t.size, y1: t.y + 0.23 * t.size };
}
const boxPointDist = (b, x, y) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
const boxesOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function segPointDist(l, x, y) {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((x - l.x1) * dx + (y - l.y1) * dy) / L)) : 0;
  return Math.hypot(l.x1 + t * dx - x, l.y1 + t * dy - y);
}
function segsCross(p, q, r, s) {
  const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p, q, r) !== o(p, q, s) && o(r, s, p) !== o(r, s, q);
}
function inTriangle(pt, [a, b, c]) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s(pt, a, b), d2 = s(pt, b, c), d3 = s(pt, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
/* Does a box (grown by m on every side) touch the triangle, edge or interior? */
function boxTouchesTriangle(b, tri, m) {
  const g = { x0: b.x0 - m, x1: b.x1 + m, y0: b.y0 - m, y1: b.y1 + m };
  const corners = [[g.x0, g.y0], [g.x1, g.y0], [g.x1, g.y1], [g.x0, g.y1]];
  if (corners.some((p) => inTriangle(p, tri))) return true;
  if (tri.some(([x, y]) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1)) return true;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) if (segsCross(tri[i], tri[(i + 1) % 3], corners[j], corners[(j + 1) % 4])) return true;
  }
  return false;
}

describe("Triangle drawing", () => {
  const app = loadApp();
  const { TRI, TRIA, TRIB, TRIC, TRIW, TRIH, SHORT } = app;
  const NAMES = TRI.map((r) => r[0]);
  const tallyOf = (vec) => Object.fromEntries(NAMES.map((nm, i) => [nm, vec[i]]).filter(([, v]) => v));
  const regionLabels = (texts) => texts.filter((t) => NAMES.some((nm) => t.text === SHORT[nm] || t.text.startsWith(`${SHORT[nm]} ${MIDDOT} `)));

  test("each dot sits at the balance of its three weights, toward the corner that names each axis", () => {
    const { circles, texts } = readTri(app.triSVG({}));
    for (const [nm, m, a, c] of TRI) {
      const t = m + a + c;
      const x = (m * TRIA[0] + a * TRIB[0] + c * TRIC[0]) / t, y = (m * TRIA[1] + a * TRIB[1] + c * TRIC[1]) / t;
      const dot = circles.find((d) => d.name === nm);
      assert.ok(dot, `a dot for ${nm}`);
      assert.ok(Math.abs(dot.cx - x) < 0.06 && Math.abs(dot.cy - y) < 0.06,
        `${nm} is drawn at (${dot.cx}, ${dot.cy}); its weights put it at (${x.toFixed(2)}, ${y.toFixed(2)})`);
    }
    const nearest = (lab) => {
      const t = texts.find((x) => x.text === lab);
      assert.ok(t, `the triangle has a ${lab} corner label`);
      const b = textBox(t), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      return [["apex", TRIA], ["bottom left", TRIB], ["bottom right", TRIC]]
        .map(([k, p]) => [k, Math.hypot(p[0] - cx, p[1] - cy)]).sort((p, q) => p[1] - q[1])[0][0];
    };
    /* TRI's columns are (land & space, affordable, easy to reach) onto (A, B, C) */
    assert.equal(nearest("LAND & SPACE"), "apex");
    assert.equal(nearest("AFFORDABLE"), "bottom left");
    assert.equal(nearest("EASY TO REACH"), "bottom right");
  });

  test("vote counts ride in the labels, and nothing is written inside a dot", () => {
    const rgT = { [VEST]: 3, [FRENCH]: 15, [ITALY]: 9 };
    const { circles, texts } = readTri(app.triSVG(rgT));
    for (const nm of NAMES) {
      const want = rgT[nm] ? `${SHORT[nm]} ${MIDDOT} ${rgT[nm]}` : SHORT[nm];
      assert.ok(texts.some((t) => t.text === want), `the ${nm} label reads ${JSON.stringify(want)}`);
    }
    for (const d of circles) for (const t of texts) {
      assert.ok(boxPointDist(textBox(t), d.cx, d.cy) >= d.r + d.sw / 2, `${JSON.stringify(t.text)} is not drawn on the ${d.name} dot`);
    }
  });

  test("on every board of up to fifteen people, labels, leaders and dots stay clear of each other", () => {
    const problems = [];
    let n = 0;
    const push = (p) => { if (problems.length < 12) problems.push(p); };
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let c = 0; c < 16; c++) for (let d = 0; d < 16; d++) {
      const vec = [a, b, c, d];
      if (vec.length !== NAMES.length) continue;
      n++;
      const { circles, texts, lines } = readTri(app.triSVG(tallyOf(vec)));
      const dots = circles.filter((x) => NAMES.includes(x.name));
      const boxes = texts.map((t) => [t, textBox(t)]);
      for (const [t, bx] of boxes) {
        if (bx.x0 < 0 || bx.y0 < 0 || bx.x1 > TRIW || bx.y1 > TRIH) push(`${vec}: ${JSON.stringify(t.text)} leaves the frame`);
        for (const dot of dots) if (boxPointDist(bx, dot.cx, dot.cy) < dot.r + dot.sw / 2) push(`${vec}: ${JSON.stringify(t.text)} lands on the ${dot.name} dot`);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        if (boxesOverlap(boxes[i][1], boxes[j][1])) push(`${vec}: ${JSON.stringify(boxes[i][0].text)} overlaps ${JSON.stringify(boxes[j][0].text)}`);
      }
      for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
        const p = dots[i], q = dots[j];
        if (Math.hypot(p.cx - q.cx, p.cy - q.cy) < p.r + q.r) push(`${vec}: the ${p.name} and ${q.name} dots overlap`);
      }
      /* leaders: every line that is not a median from a vertex; its own dot is the one its end touches */
      const verts = [TRIA, TRIB, TRIC];
      const leaders = lines.filter((l) => !verts.some((v) => v[0] === l.x1 && v[1] === l.y1));
      if (leaders.length !== dots.length) push(`${vec}: ${leaders.length} leaders for ${dots.length} dots`);
      for (const l of leaders) {
        const own = dots.slice().sort((p, q) => Math.hypot(p.cx - l.x2, p.cy - l.y2) - Math.hypot(q.cx - l.x2, q.cy - l.y2))[0];
        for (const dot of dots) {
          if (dot === own) continue;
          if (segPointDist(l, dot.cx, dot.cy) < dot.r + dot.sw / 2 + l.w / 2) push(`${vec}: the ${own.name} leader crosses the ${dot.name} dot`);
        }
      }
    }
    assert.equal(n, 16 ** NAMES.length, "every tally was drawn");
    assert.deepEqual(problems, []);
  });

  test("region labels sit outside the plot, clear of the triangle's outline", () => {
    /* CLAUDE.md: "Labels sit outside the plot on leader lines rather than beside the dots." */
    const tri = [TRIA, TRIB, TRIC];
    const problems = [];
    for (const vec of [[0, 0, 0, 0], [15, 15, 15, 15]]) {
      const { texts, polyStroke } = readTri(app.triSVG(tallyOf(vec)));
      for (const t of regionLabels(texts)) {
        if (boxTouchesTriangle(textBox(t), tri, polyStroke / 2)) {
          const b = textBox(t);
          problems.push(`${JSON.stringify(t.text)} (x ${b.x0.toFixed(1)}..${b.x1.toFixed(1)}, y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}) is crossed by the triangle's outline`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});

/* ------------------------------------------------------------------ index.html as a file */

const html = readIndexHtml();
const scripts = extractScripts(html);
const script = scripts.join("\n;\n");
/* The page with every <script> body blanked: the HTML and CSS a browser parses as such. */
const outsideScript = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, "$1$2");
const styleText = [...outsideScript.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join("\n");

/* A small CSS reader: rules with their selector, declarations and enclosing @media. */
function cssRules(css, media = null, out = []) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).split(";").pop().trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    if (/^@(media|supports|layer|container)\b/i.test(prelude)) cssRules(body, prelude, out);
    else {
      const decls = [];
      for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)) decls.push([m[1].toLowerCase(), m[2].trim()]);
      out.push({ selector: prelude, decls, media });
    }
    i = j;
  }
  return out;
}
const RULES = cssRules(styleText);
const rootVars = Object.fromEntries(RULES.filter((r) => /(^|,)\s*:root\s*(,|$)/.test(r.selector) && !r.media)
  .flatMap((r) => r.decls.filter(([k]) => k.startsWith("--"))));
function colourOf(value) {
  let v = String(value).replace(/!important/i, "").trim();
  const vm = v.match(/var\(\s*(--[\w-]+)\s*\)/);
  if (vm && rootVars[vm[1]]) v = rootVars[vm[1]];
  const hm = v.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hm) {
    const h = hm[1].length === 3 ? hm[1].split("").map((c) => c + c).join("") : hm[1];
    return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
  }
  const rm = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rm) return [+rm[1], +rm[2], +rm[3]];
  if (/\bwhite\b/i.test(v)) return [255, 255, 255];
  if (/\bblack\b/i.test(v)) return [0, 0, 0];
  return null;
}
const luminance = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

describe("index.html as a file", () => {
  test("contains zero non-ASCII bytes", () => {
    const bytes = readIndexBytes();
    const found = [];
    let chars = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] < 0x80) continue;
      if ((bytes[i] & 0xc0) === 0x80 && i > 0 && bytes[i - 1] >= 0x80) continue;   /* continuation byte of the same character */
      chars++;
      if (found.length < 10) {
        let line = 1, ls = 0;
        for (let k = 0; k < i; k++) if (bytes[k] === 0x0a) { line++; ls = k + 1; }
        const ctx = bytes.subarray(Math.max(0, i - 30), Math.min(bytes.length, i + 30)).toString("utf8");
        found.push(`byte ${i} (line ${line}, col ${i - ls + 1}, 0x${bytes[i].toString(16)}): ...${asciiSafe(ctx)}...`);
      }
    }
    assert.equal(chars, 0,
      `${chars} non-ASCII character(s) in ${INDEX_PATH}. Escape them as \\uXXXX in JS strings and &#NNN; in HTML/CSS ` +
      `(CLAUDE.md, "Pure ASCII output required"):\n  ${found.join("\n  ")}`);
  });

  test("the HTML and CSS outside the script carry no \\u escapes, which would print literally", () => {
    const hits = [...outsideScript.matchAll(/\\u[0-9a-f]{4}/gi)].map((m) => {
      const { line, col } = lineCol(outsideScript, m.index);
      return `line ${line}, col ${col}: ${asciiSafe(outsideScript.slice(Math.max(0, m.index - 30), m.index + 36))}`;
    });
    assert.deepEqual(hits, [], "outside <script>, non-ASCII is written &#NNN;, not \\uXXXX");
  });

  test("the test suite's own files are pure ASCII", () => {
    const dir = path.join(REPO_ROOT, "tests");
    const files = readdirSync(dir).filter((f) => /\.(m?js|json)$/.test(f)).map((f) => path.join(dir, f));
    files.push(path.join(REPO_ROOT, "package.json"), path.join(REPO_ROOT, ".github", "workflows", "test.yml"));
    const bad = [];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const b = readFileSync(f);
      const i = b.findIndex((x) => x > 0x7f);
      if (i >= 0) bad.push(`${path.relative(REPO_ROOT, f)} at byte ${i}`);
    }
    assert.deepEqual(bad, []);
  });

  test("declares a light color scheme, and nothing declares dark", () => {
    const meta = [...outsideScript.matchAll(/<meta\b([^>]*)>/gi)].map((m) => attrsOf(m[1]))
      .find((a) => (a.name || "").toLowerCase() === "color-scheme");
    assert.ok(meta, '<meta name="color-scheme"> is present');
    assert.match(meta.content, /^\s*light(\s+only)?\s*$/i, "the meta color-scheme is light");
    const top = RULES.filter((r) => !r.media && /(^|,)\s*(html|:root)\s*(,|$)/.test(r.selector))
      .flatMap((r) => r.decls.filter(([k]) => k === "color-scheme"));
    assert.ok(top.length, "html or :root declares color-scheme in CSS");
    assert.ok(top.every(([, v]) => /^light\b/i.test(v)), `html/:root color-scheme is light (${JSON.stringify(top)})`);
    const all = RULES.flatMap((r) => r.decls.filter(([k]) => k === "color-scheme").map(([, v]) => `${r.selector} { color-scheme: ${v} }`));
    assert.deepEqual(all.filter((d) => /\bdark\b|\bnormal\b/i.test(d)), [], "no rule opts back into a dark or UA-chosen scheme");
  });

  test("has a prefers-color-scheme: dark block that keeps the page light", () => {
    const dark = RULES.filter((r) => r.media && /prefers-color-scheme\s*:\s*dark/i.test(r.media));
    assert.ok(dark.length, "an @media (prefers-color-scheme: dark) override block exists");
    const pageRules = dark.filter((r) => /(^|,)\s*(html|body)\s*(,|$)/.test(r.selector));
    assert.ok(pageRules.length, "the dark block restyles html/body");
    const bg = pageRules.flatMap((r) => r.decls).filter(([k]) => k === "background" || k === "background-color").map(([, v]) => colourOf(v));
    const fg = pageRules.flatMap((r) => r.decls).filter(([k]) => k === "color").map(([, v]) => colourOf(v));
    assert.ok(bg.length && bg.every((c) => c && luminance(c) > 0.6), `in dark mode the page background stays light (${JSON.stringify(bg)})`);
    assert.ok(fg.length && fg.every((c) => c && luminance(c) < 0.1), `in dark mode the text stays dark (${JSON.stringify(fg)})`);
  });

  test(".nojekyll sits at the repo root", () => {
    const p = path.join(REPO_ROOT, ".nojekyll");
    assert.ok(existsSync(p) && statSync(p).isFile(),
      `${p} is missing: without it GitHub Pages runs Jekyll, and a stray double brace anywhere quietly stops the site updating`);
  });

  test("keyboard focus draws a visible :focus-visible ring in glacier", () => {
    const rings = RULES.filter((r) => !r.media && r.selector.split(",").some((s) => /^\s*\*?:focus-visible\s*$/.test(s)));
    assert.ok(rings.length, "a global :focus-visible rule exists");
    const outline = rings.flatMap((r) => r.decls).filter(([k]) => k === "outline").map(([, v]) => v);
    assert.ok(outline.length, "it sets an outline");
    for (const v of outline) {
      assert.ok(!/\bnone\b/i.test(v) && /(^|\s)(\d*\.?\d+)px\b/.test(v) && parseFloat(v.match(/(\d*\.?\d+)px/)[1]) > 0,
        `the ring has a positive width (${v})`);
      assert.match(v, /var\(--glacier\)/, "the ring is glacier (CLAUDE.md, Testing changes)");
    }
    assert.ok(rootVars["--glacier"], "--glacier is defined on :root");
  });

  test("no plain :focus style, and nothing else takes the ring away", () => {
    const plain = RULES.filter((r) => /:focus(?![-\w])/.test(r.selector)).map((r) => r.selector);
    assert.deepEqual(plain, [], ":focus-visible only, so a mouse or a tap shows nothing");
    /* The one documented exception: headings that take focus on every screen change. */
    const killers = RULES.filter((r) => r.decls.some(([k, v]) =>
      (k === "outline" && /^(none|0)\b/i.test(v)) || (k === "outline-style" && /^none\b/i.test(v)) || (k === "outline-width" && /^0\b/.test(v))))
      .filter((r) => !r.selector.split(",").every((s) => /\bh[1-6]\[tabindex\]\s*$/.test(s.trim()) || /:not\(:focus-visible\)/.test(s)))
      .map((r) => r.selector);
    assert.deepEqual(killers, [], "only focusable headings drop the outline");
    const inline = [...script.matchAll(/outline\s*:\s*(?:none|0)\b/gi)].map((m) => asciiSafe(script.slice(Math.max(0, m.index - 40), m.index + 20)));
    assert.deepEqual(inline, [], "no inline style in the script removes an outline");
  });

  test("loads no external script, stylesheet or other resource from its markup", () => {
    const TAGS = /<(script|link|img|iframe|frame|object|embed|video|audio|source|track|image|use|input|portal|applet|meta)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
    const RES = ["src", "srcset", "href", "xlink:href", "data", "poster", "action", "formaction", "background"];
    const local = (v) => v === undefined || v === "" || /^#/.test(v) || /^data:/i.test(v) || /^\$\{\s*[A-Za-z_$][\w$.]*\s*\}$/.test(v);
    const bad = [];
    for (const m of html.matchAll(TAGS)) {
      const tag = m[1].toLowerCase(), a = attrsOf(m[2]);
      const where = () => { const { line } = lineCol(html, m.index); return `line ${line}: ${asciiSafe(m[0].slice(0, 120))}`; };
      if (tag === "meta") {
        if ((a["http-equiv"] || "").toLowerCase() === "refresh") bad.push(`meta refresh, ${where()}`);
        continue;
      }
      for (const k of RES) if (k in a && !local(a[k])) bad.push(`<${tag} ${k}=${JSON.stringify(a[k])}>, ${where()}`);
    }
    assert.deepEqual(bad, [], "everything the page needs is inside index.html");
  });

  test("CSS pulls nothing in: no @import, and url() only to fragments or data:", () => {
    const bad = [];
    for (const m of html.matchAll(/@import\b/gi)) bad.push(`@import at line ${lineCol(html, m.index).line}`);
    for (const m of html.matchAll(/(?<![\w.])url\(\s*(['"]?)([^'")]*)\1\s*\)/g)) {
      const v = m[2].trim();
      if (!/^#/.test(v) && !/^data:/i.test(v)) bad.push(`url(${v}) at line ${lineCol(html, m.index).line}`);
    }
    assert.deepEqual(bad, []);
  });

  test("the script uses no network API but fetch, and fetch only in the map upgrade", () => {
    const NET = [
      ["XMLHttpRequest", /\bXMLHttpRequest\b/], ["WebSocket", /\bWebSocket\b/], ["EventSource", /\bEventSource\b/],
      ["sendBeacon", /\bsendBeacon\b/], ["importScripts", /\bimportScripts\b/], ["a worker", /\bnew\s+(?:Shared)?Worker\s*\(/],
      ["serviceWorker", /\bserviceWorker\b/], ["dynamic import()", /\bimport\s*\(/],
      ["static import", /(?:^|[;\n}])\s*import\s+(?:[\w$*{}\s,]+\s+from\s+)?["'`]/],
      ["a script/link/iframe element", /createElement\(\s*["'`](?:script|link|iframe)["'`]/i],
      [".src set to a literal", /\.src\s*=\s*["'`]/],
    ];
    const bad = NET.flatMap(([what, re]) => {
      const m = script.match(re);
      return m ? [`${what}: ${asciiSafe(script.slice(Math.max(0, m.index - 40), m.index + 40))}`] : [];
    });
    assert.deepEqual(bad, []);
    const sites = [...script.matchAll(/\bfetch\s*\(/g)].map((m) => {
      const fns = [...script.slice(0, m.index).matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([\w$]+)\s*\(/g)];
      return fns.length ? fns[fns.length - 1][1] : "(top level)";
    });
    assert.deepEqual(sites.filter((f) => !["upgradeMap", "upgradeGeo"].includes(f)), [],
      "fetch() is called only from upgradeMap/upgradeGeo, the documented Natural Earth coastline fetch");
  });

  test("every absolute URL in the file is metadata, a namespace, a link, or the Natural Earth CDN", () => {
    const CDN = /^https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/world-atlas@[\w.]+\/[\w.-]+\.json$/;
    const bad = [];
    for (const m of html.matchAll(/(?:https?:)?\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:\/[^\s"'`<>)]*)?/g)) {
      const u = m[0], before = html.slice(Math.max(0, m.index - 200), m.index);
      const metaTag = /<meta\b[^>]*\bcontent\s*=\s*["']$/i.test(before) && /\b(?:property|name)\s*=\s*["'](?:og:|twitter:)/i.test(before.slice(before.lastIndexOf("<meta")));
      const ns = /\bxmlns(?::\w+)?\s*=\s*["']$/.test(before) && /^http:\/\/www\.w3\.org\//.test(u);
      const anchor = /<a\b[^>]*\bhref\s*=\s*["']$/i.test(before);
      if (metaTag || ns || anchor || CDN.test(u)) continue;
      const { line } = lineCol(html, m.index);
      bad.push(`line ${line}: ${asciiSafe(u)}`);
    }
    assert.deepEqual(bad, [], "an absolute URL that is not accounted for (a load the page did not have before?)");
  });

  test("rendering requests only the Natural Earth files over https, and offline the map draws from its outline", async () => {
    const requested = [];
    const offline = (u) => { requested.push(String(u)); return Promise.reject(new TypeError("offline")); };
    const { app, html: page } = renderResults({ fetch: offline });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(requested.length >= 1, "the results page tries the coastline upgrade");
    const CDN = /^https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/world-atlas@[\w.]+\/[\w.-]+\.json$/;
    assert.deepEqual(requested.filter((u) => !CDN.test(u)), [], "nothing but the world-atlas (Natural Earth) files is requested");
    assert.equal(app.MAPSRC, "outline", "with every fetch refused the map stays on the hand-drawn outline");
    assert.equal(app.MAPGEO, app.FALLBACK);
    assert.match(page, /<div id="mapbox"><svg\b/, "and the map is still drawn");
  });

  test("when the CDN answers, the map upgrades to the Natural Earth coastline", async () => {
    /* one square country near Grenoble, as TopoJSON: arcs are delta-encoded [lon, lat] */
    const topo = {
      type: "Topology", transform: { scale: [1, 1], translate: [0, 0] },
      arcs: [[[5, 45], [1, 0], [0, 1], [-1, 0], [0, -1]]],
      objects: { countries: { type: "GeometryCollection", geometries: [{ type: "Polygon", arcs: [[0]] }] } },
    };
    const requested = [];
    const online = async (u) => { requested.push(String(u)); return { ok: true, json: async () => topo }; };
    const { app } = renderResults({ fetch: online });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(requested.length, 1, "the first source answered, so no other is tried");
    assert.equal(app.MAPSRC, "natural earth");
    assert.deepEqual(app.MAPGEO, [[[45, 5], [45, 6], [46, 6], [46, 5], [45, 5]]], "the fetched outline is what the map now holds, as [lat, lon]");
    const box = app.dom.byId("mapbox");
    assert.ok(box && /<svg\b/.test(box.innerHTML), "the map box is redrawn");
  });

  test("the shareable image is drawn in the page and handed over as a data: URL", async () => {
    const { app } = renderResults();
    const btn = app.dom.byId("png");
    assert.ok(btn && typeof btn.onclick === "function", "the results page has its Make-a-shareable-image button wired");
    btn.onclick({ preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    const box = app.dom.byId("sharebox");
    const src = ((box && box.innerHTML) || "").match(/<img\b[^>]*\bsrc="([^"]*)"/);
    assert.ok(src, "an image is shown");
    assert.match(src[1], /^data:image\//, "and it is a data: URL, not a fetched file");
  });

  test("its script parses", () => {
    assert.ok(scripts.length >= 1, "index.html has an inline script");
    scripts.forEach((s, i) => {
      try { new Function(s); } catch (e) { assert.fail(`inline script ${i + 1} of ${scripts.length} does not parse: ${e.name}: ${e.message}`); }
    });
  });
});
