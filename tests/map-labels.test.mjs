/*
 * The Europe results map: region bubbles, their labels in fixed margin slots (MAPLAB), and
 * the leader lines between the two. See CLAUDE.md, "The Europe map's region names sit in
 * fixed margin slots".
 *
 * CLAUDE.md has long said there is a test that "walks all 816 possible fifteen-person
 * divisions and checks no label lands in a bubble and no leader crosses one". There was
 * not; this is it.
 *
 * WHAT IS MEASURED, AND HOW
 *
 *   Nothing about the drawing is recomputed here. Every check renders the app's own
 *   mapSVG(rgT) and reads the result back out of the SVG markup: bubble centres and radii
 *   from the <circle> elements whose <title> is a region name, labels from the <text>
 *   elements, leaders from the <line> elements. So the radius formula, the projection, the
 *   leader geometry and the slot table are all the app's, exactly as a browser would get
 *   them. The markup rounds coordinates to 0.1 unit, far below any margin that matters here.
 *
 *   The one thing SVG markup cannot say is how wide a label's text is. That is modelled the
 *   way the app itself models it when it places the leader: monospace, 0.6 em per character
 *   (the app's "8px monospace advance" of 4.8), and vertically from 0.8 em above the
 *   baseline to 0.25 em below it, which holds the ascenders and descenders of every common
 *   monospace face. "Touching" is judged on ink: a bubble counts out to its radius plus half
 *   its stroke, a leader to half its own stroke width.
 *
 * WHICH VOTE SPLITS
 *
 *   1. Every division of fifteen single votes across the map's regions, as CLAUDE.md
 *      describes. The regions are read from the app (Object.keys(RCPOS)), not assumed.
 *      There are four today - "somewhere not on this list" and the retired picks have no
 *      bubble - so fifteen votes divide C(15+4-1, 4-1) = C(18,3) = 816 ways, which is where
 *      CLAUDE.md's 816 comes from. If a region is added the count changes with it, and the
 *      test's name says the new number.
 *
 *   2. Every board of up to fifteen people however many regions each of them picked: each
 *      region's count anywhere from 0 to 15, independently, 16^4 = 65,536 tallies. The
 *      816 are not the whole story, because the form lets each person pick up to TWO regions
 *      ("Pick up to two regions"), and an old C1/C2 code can carry more than that. So a
 *      realistic board can have fifteen votes on the French Alps and fifteen on the Italian
 *      Alps at once, which no single-vote division reaches - and those are exactly the two
 *      largest bubbles side by side. Drawing the coastline 65,536 times would take about
 *      sixteen seconds on its own, so the grid runs on a second instance with the coastline
 *      switched off (MAPGEO = []) and takes about five; the first check in that block proves
 *      the coastline changes nothing measured here.
 *
 *   The tightest spot in either walk, as of Sept 2026: the French Alps leader passes 4.7
 *   units of ink clear of a full-size Pyrenees bubble. No label comes within 20 units of
 *   any bubble.
 *
 * DELIBERATELY NOT CHECKED
 *
 *   - Bubbles overlapping each other. They do, whenever two neighbours share the top count:
 *     the French Alps and Italian Alps bubbles overlap, and so do the French Alps and the
 *     Pyrenees. CLAUDE.md records that as part of the original problem, but the fix it
 *     describes is for the labels; the bubbles sit on the regions' real coordinates and grow
 *     with the votes, and stopping them touching would mean moving or shrinking them - a
 *     decision about the chart, not something for a test to settle.
 *   - Pins against labels. A pin is somebody's answer about where, and can be anywhere in
 *     the map window, off-list pins included; no slot can promise to avoid it.
 *   - The real rendered width of text in a browser. Covered by the model above; since no
 *     label comes within twenty units of a bubble, the model's margin of error does not
 *     decide anything.
 *
 * Fixtures use invented first names only. This file is pure ASCII.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadApp, buildCode, sampleAnswer } from "./harness.mjs";

const app = loadApp();
const { mapSVG, MAPLAB, RCPOS, SHORT, MW, MH, MPX, REGIONS, OFFLIST } = app;
const MAP_REGIONS = RCPOS && typeof RCPOS === "object" ? Object.keys(RCPOS) : [];
const K = MAP_REGIONS.length;

const PEOPLE = 15;
const MIDDOT = "\u00b7";
const SAME_SIDE_MIN = 30;            /* CLAUDE.md: "at least 30 units clear of the others on its side" */
const ADVANCE_EM = 0.6;              /* monospace advance; the app uses 4.8 at 8px */
const ASCENT_EM = 0.8, DESCENT_EM = 0.25;
const LEADER_REACH = 12;             /* a leader's near end sits this close to its own label */
const LEADER_LAND = 8;               /* and its far end this close to its own bubble's edge */

const short = (nm) => (SHORT && SHORT[nm]) || nm;
const binom = (n, r) => { let x = 1; for (let i = 1; i <= r; i++) x = x * (n - r + i) / i; return Math.round(x); };

/* ------------------------------------------------------------------ vote splits */

/* Every way `total` single votes can divide across k regions (compositions into k parts). */
function divisions(total, k) {
  const out = [], cur = new Array(k).fill(0);
  const rec = (i, left) => {
    if (i === k - 1) { cur[i] = left; out.push(cur.slice()); return; }
    for (let v = 0; v <= left; v++) { cur[i] = v; rec(i + 1, left - v); }
  };
  if (k > 0) rec(0, total);
  return out;
}
/* Every tally with each of k regions between 0 and max, independently. */
function* grid(max, k) {
  const cur = new Array(k).fill(0);
  for (;;) {
    yield cur.slice();
    let i = k - 1;
    while (i >= 0 && cur[i] === max) { cur[i] = 0; i--; }
    if (i < 0) return;
    cur[i]++;
  }
}
const tallyOf = (vec) => Object.fromEntries(MAP_REGIONS.map((nm, i) => [nm, vec[i]]));
const describeVotes = (vec) => MAP_REGIONS.map((nm, i) => `${short(nm)} ${vec[i]}`).join(", ");

/* ------------------------------------------------------------------ reading the SVG back */

const unesc = (s) => (String(s).indexOf("&") < 0 ? String(s) : String(s).replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, "&"));
/* One attribute by name. Targeted rather than a general attribute parser because the grid
   test below reads 65,536 maps, and parsing every attribute (the inspector's data-items
   JSON included) was most of its running time. */
const ATTR_RE = new Map();
const attr = (tag, name, dflt) => {
  if (!ATTR_RE.has(name)) ATTR_RE.set(name, new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  const m = ATTR_RE.get(name).exec(tag);
  return m ? unesc(m[1]) : dflt;
};
/* Attribute values in the app's SVG are esc()'d, so a raw ">" never appears inside a tag. */
function readMap(svg) {
  const circles = [], lines = [], texts = [];
  for (const m of svg.matchAll(/<circle\b([^>]*?)\/?>(?:\s*<title>([^<]*)<\/title>)?/g)) {
    const a = m[1];
    circles.push({ cx: +attr(a, "cx"), cy: +attr(a, "cy"), r: +attr(a, "r"), sw: +attr(a, "stroke-width", "1"),
      title: m[2] === undefined ? null : unesc(m[2]).trim(), at: m.index });
  }
  for (const m of svg.matchAll(/<line\b([^>]*?)\/?>/g)) {
    const a = m[1];
    lines.push({ x1: +attr(a, "x1"), y1: +attr(a, "y1"), x2: +attr(a, "x2"), y2: +attr(a, "y2"),
      sw: +attr(a, "stroke-width", "1"), at: m.index });
  }
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = m[1], rawX = attr(a, "x"), rawY = attr(a, "y");
    texts.push({ x: +rawX, y: +rawY, rawX, rawY, anchor: attr(a, "text-anchor", "start"),
      fs: +attr(a, "font-size", "16"), text: unesc(m[2]), at: m.index });
  }
  return { circles, lines, texts };
}
/* The ink box of a label, from the monospace model described at the top. */
function textBox(t) {
  const w = [...t.text].length * ADVANCE_EM * t.fs;
  const x0 = t.anchor === "end" ? t.x - w : t.anchor === "middle" ? t.x - w / 2 : t.x;
  return { x0, x1: x0 + w, y0: t.y - ASCENT_EM * t.fs, y1: t.y + DESCENT_EM * t.fs };
}

/* ------------------------------------------------------------------ plane geometry */

const hyp = Math.hypot;
function segPointDist(px, py, L) {
  const dx = L.x2 - L.x1, dy = L.y2 - L.y1, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - L.x1) * dx + (py - L.y1) * dy) / len2)) : 0;
  return hyp(px - (L.x1 + t * dx), py - (L.y1 + t * dy));
}
const boxPointDist = (px, py, b) => hyp(Math.max(b.x0 - px, 0, px - b.x1), Math.max(b.y0 - py, 0, py - b.y1));
const boxesOverlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/* Liang-Barsky: does the segment enter the box at all? */
function segHitsBox(L, b) {
  let t0 = 0, t1 = 1;
  const dx = L.x2 - L.x1, dy = L.y2 - L.y1;
  for (const [p, q] of [[-dx, L.x1 - b.x0], [dx, b.x1 - L.x1], [-dy, L.y1 - b.y0], [dy, b.y1 - L.y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
function segsCross(A, B) {
  const o = (ax, ay, bx, by, cx, cy) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const d1 = o(A.x1, A.y1, A.x2, A.y2, B.x1, B.y1), d2 = o(A.x1, A.y1, A.x2, A.y2, B.x2, B.y2);
  const d3 = o(B.x1, B.y1, B.x2, B.y2, A.x1, A.y1), d4 = o(B.x1, B.y1, B.x2, B.y2, A.x2, A.y2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
const f1 = (x) => x.toFixed(1);

/* ------------------------------------------------------------------ one rendered map, judged */

/*
 * Reads a rendered map for a given tally and returns what it found plus a list of problems,
 * each tagged with a kind so the tests below can each own one rule:
 *   text          a region's label is missing, doubled, or does not read "Region \u00b7 N"
 *                 (U+00B7, a middle dot);
 *                 or there is text on the map that is not a region label
 *   bubble        a region has no bubble, or more than one
 *   slot          a label is not at its MAPLAB slot
 *   label-bubble  a label's ink box touches a bubble (its own or any other)
 *   leader-bubble a leader touches a bubble other than its own
 *   leader-own    a label has no leader, or its leader does not reach its own bubble
 *   frame         a label runs outside the map frame, which is clipped
 *   label-label   two labels overlap
 *   leader-label  a leader runs through a label, its own included
 *   leader-leader two leaders cross
 *   radius        a region with more votes has a smaller bubble than one with fewer
 */
function judge(svg, vec) {
  const map = readMap(svg);
  const problems = [];
  const bad = (kind, msg) => problems.push({ kind, msg: `${describeVotes(vec)}: ${msg}` });
  const R = {};

  for (const [i, nm] of MAP_REGIONS.entries()) {
    const v = vec[i], s = short(nm);
    const bubbles = map.circles.filter((c) => c.title === nm);
    if (bubbles.length !== 1) { bad("bubble", `${bubbles.length} bubbles titled ${JSON.stringify(nm)}`); continue; }
    const labels = map.texts.filter((t) => t.text === s || t.text.startsWith(s + " "));
    if (labels.length !== 1) { bad("text", `${labels.length} labels for ${s}`); continue; }
    const b = bubbles[0], t = labels[0];
    const want = `${s} ${MIDDOT} ${v}`;
    if (v > 0 && t.text !== want) bad("text", `label reads ${JSON.stringify(t.text)}, want ${JSON.stringify(want)}`);
    if (v === 0 && !(t.text === s || t.text === `${s} ${MIDDOT} 0`)) {
      bad("text", `label for a region nobody picked reads ${JSON.stringify(t.text)}`);
    }
    R[nm] = { v, s, b, t, box: textBox(t), ink: b.r + b.sw / 2 };
  }
  const found = MAP_REGIONS.filter((nm) => R[nm]);
  const labelTexts = new Set(found.map((nm) => R[nm].t));
  for (const t of map.texts) {
    if (!labelTexts.has(t)) bad("text", `stray text ${JSON.stringify(t.text)} at ${t.rawX},${t.rawY}`);
  }

  /* slots: exactly the MAPLAB entry, whatever the votes */
  for (const nm of found) {
    const { t } = R[nm], sl = MAPLAB && MAPLAB[nm];
    if (!sl) { bad("slot", `${R[nm].s} has no MAPLAB slot`); continue; }
    if (t.x !== sl[0] || t.y !== sl[1] || t.anchor !== sl[2]) {
      bad("slot", `${R[nm].s} label at ${t.rawX},${t.rawY} anchored ${t.anchor}, slot is ${sl.join(",")}`);
    }
  }

  /* leaders: each line goes to the label its near end is closest to */
  const claimed = new Map(found.map((nm) => [nm, []]));
  for (const L of map.lines) {
    let best = null, bestD = Infinity, nearEnd = null;
    for (const nm of found) {
      const bx = R[nm].box;
      const d1 = boxPointDist(L.x1, L.y1, bx), d2 = boxPointDist(L.x2, L.y2, bx);
      const d = Math.min(d1, d2);
      if (d < bestD) { bestD = d; best = nm; nearEnd = d1 <= d2 ? 1 : 2; }
    }
    if (best && bestD <= LEADER_REACH) claimed.get(best).push({ L, nearEnd });
  }
  for (const nm of found) {
    const c = claimed.get(nm), { b, s } = R[nm];
    if (c.length !== 1) { bad("leader-own", `${s} label has ${c.length} leaders starting at it`); continue; }
    const { L, nearEnd } = c[0];
    const fx = nearEnd === 1 ? L.x2 : L.x1, fy = nearEnd === 1 ? L.y2 : L.y1;
    const gap = hyp(fx - b.cx, fy - b.cy) - b.r;
    if (Math.abs(gap) > LEADER_LAND) {
      bad("leader-own", `${s} leader ends ${f1(gap)} units from the edge of its own bubble`);
    }
    R[nm].lead = L;
  }

  for (const a of found) {
    const A = R[a];
    const bx = A.box;
    if (bx.x0 < 0 || bx.x1 > MW || bx.y0 < 0 || bx.y1 > MH) {
      bad("frame", `${A.s} label spans ${f1(bx.x0)}..${f1(bx.x1)} x ${f1(bx.y0)}..${f1(bx.y1)}, frame is ${MW}x${MH}`);
    }
    for (const b of found) {
      const B = R[b];
      const d = boxPointDist(B.b.cx, B.b.cy, bx);
      if (d < B.ink) {
        bad("label-bubble", `label "${A.t.text}" is ${f1(B.ink - d)} units inside the ${B.s} bubble (r ${B.b.r})`);
      }
      if (A.lead && b !== a) {
        const dl = segPointDist(B.b.cx, B.b.cy, A.lead);
        if (dl < B.ink + A.lead.sw / 2) {
          bad("leader-bubble", `the ${A.s} leader runs ${f1(B.ink + A.lead.sw / 2 - dl)} units into the ${B.s} bubble (r ${B.b.r})`);
        }
      }
      if (A.lead && segHitsBox(A.lead, B.box)) bad("leader-label", `the ${A.s} leader runs through the label "${B.t.text}"`);
      if (a < b) {
        if (boxesOverlap(bx, B.box)) bad("label-label", `labels "${A.t.text}" and "${B.t.text}" overlap`);
        if (A.lead && B.lead && segsCross(A.lead, B.lead)) bad("leader-leader", `the ${A.s} and ${B.s} leaders cross`);
      }
      if (A.v > B.v && A.b.r < B.b.r) {
        bad("radius", `${A.s} has ${A.v} votes and radius ${A.b.r}; ${B.s} has ${B.v} and radius ${B.b.r}`);
      }
    }
  }
  return { map, regions: R, problems };
}

/* Fail with the first few problems and a count, rather than one assertion per division. */
function assertNone(problems, kinds, what) {
  const hits = problems.filter((p) => kinds.includes(p.kind));
  if (!hits.length) return;
  const shown = hits.slice(0, 8).map((p) => "  - " + p.msg).join("\n");
  assert.fail(`${hits.length} ${what}:\n${shown}${hits.length > 8 ? `\n  ... and ${hits.length - 8} more` : ""}`);
}

/* The 816 (today) single-vote divisions, rendered once and shared by the tests that read them. */
let single = null;
function singleVoteMaps() {
  if (!single) {
    assert.equal(typeof mapSVG, "function", "index.html defines mapSVG(rgT)");
    single = divisions(PEOPLE, K).map((vec) => ({ vec, ...judge(mapSVG(tallyOf(vec)), vec) }));
  }
  return single;
}
const problemsOf = (maps) => maps.flatMap((m) => m.problems);
const NDIV = binom(PEOPLE + K - 1, K - 1);

/* ------------------------------------------------------------------ the tests */

describe("Europe map: which regions have a bubble and a label slot", () => {
  test("the map draws the live shortlist: every region except 'somewhere not on this list'", () => {
    assert.ok(K > 0, "RCPOS lists the map's regions");
    assert.ok(Array.isArray(REGIONS), "REGIONS is readable");
    const live = REGIONS.filter((r) => r !== OFFLIST);
    assert.deepEqual(MAP_REGIONS.slice().sort(), live.slice().sort(),
      "RCPOS holds exactly the live regions - a live region with no bubble would silently drop its votes from the map");
  });

  test("every map region has a short name and a MAPLAB slot, and MAPLAB has no stale entries", () => {
    for (const nm of MAP_REGIONS) {
      assert.equal(typeof (SHORT || {})[nm], "string", `SHORT names ${nm}`);
      const sl = (MAPLAB || {})[nm];
      assert.ok(Array.isArray(sl) && sl.length === 3, `MAPLAB has a [x, y, anchor] slot for ${nm} - without one the region gets no label at all`);
      assert.equal(typeof sl[0], "number", `${nm} slot x is a number`);
      assert.equal(typeof sl[1], "number", `${nm} slot y is a number`);
      assert.ok(sl[2] === "start" || sl[2] === "end", `${nm} slot anchors to a margin ("start" or "end"), got ${sl[2]}`);
    }
    for (const nm of Object.keys(MAPLAB || {})) {
      assert.ok(MAP_REGIONS.includes(nm), `MAPLAB entry ${JSON.stringify(nm)} is a region on the map`);
    }
  });

  test("slots sit in the margins, left-anchored on the left and right-anchored on the right", () => {
    for (const nm of MAP_REGIONS) {
      const [x, y, anchor] = MAPLAB[nm];
      assert.ok(x >= 0 && x <= MW && y >= 0 && y <= MH, `${short(nm)} slot ${x},${y} is inside the ${MW}x${MH} frame`);
      if (anchor === "start") assert.ok(x < MW / 2, `${short(nm)} is start-anchored, so it belongs in the left margin (x ${x})`);
      else assert.ok(x > MW / 2, `${short(nm)} is end-anchored, so it belongs in the right margin (x ${x})`);
    }
  });

  test(`slots on the same side are at least ${SAME_SIDE_MIN} units apart`, () => {
    for (let i = 0; i < K; i++) {
      for (let j = i + 1; j < K; j++) {
        const a = MAPLAB[MAP_REGIONS[i]], b = MAPLAB[MAP_REGIONS[j]];
        if (a[2] !== b[2]) continue;
        const dy = Math.abs(a[1] - b[1]);
        assert.ok(dy >= SAME_SIDE_MIN,
          `${short(MAP_REGIONS[i])} (y ${a[1]}) and ${short(MAP_REGIONS[j])} (y ${b[1]}) share the ${a[2]} margin ${dy} units apart`);
      }
    }
  });

  test("the SVG reader agrees with the app's own projection (bubble centres at MPX of RCPOS)", () => {
    const vec = MAP_REGIONS.map((_, i) => i + 1);
    const { regions } = judge(mapSVG(tallyOf(vec)), vec);
    for (const nm of MAP_REGIONS) {
      const [x, y] = MPX(...RCPOS[nm]);
      assert.ok(regions[nm], `found the ${short(nm)} bubble and label`);
      assert.ok(Math.abs(regions[nm].b.cx - x) <= 0.051 && Math.abs(regions[nm].b.cy - y) <= 0.051,
        `${short(nm)} bubble at ${regions[nm].b.cx},${regions[nm].b.cy}, projection says ${f1(x)},${f1(y)}`);
    }
  });
});

describe(`Europe map: every one of the ${NDIV} ways ${PEOPLE} single votes divide across the ${K} map regions`, () => {
  test(`there are C(${PEOPLE}+${K}-1, ${K}-1) = ${NDIV} divisions, each counted once`, () => {
    const all = divisions(PEOPLE, K);
    assert.equal(all.length, NDIV);
    assert.equal(new Set(all.map((v) => v.join(","))).size, NDIV, "no division repeats");
    assert.ok(all.every((v) => v.length === K && v.reduce((a, b) => a + b, 0) === PEOPLE && v.every((x) => x >= 0)));
    /* CLAUDE.md's figure: four bubbles on the map today. */
    if (K === 4) assert.equal(NDIV, 816);
  });

  test("each region's label reads 'Region \u00b7 N' with its own count, and the map has no other text", () => {
    assertNone(problemsOf(singleVoteMaps()), ["text", "bubble"], "divisions with a wrong or stray label");
  });

  test("label slots do not depend on the votes: every label sits at its MAPLAB slot in every division", () => {
    const maps = singleVoteMaps();
    assertNone(problemsOf(maps), ["slot"], "divisions with a label off its slot");
    for (const nm of MAP_REGIONS) {
      const seen = new Set(maps.filter((m) => m.regions[nm]).map((m) => {
        const t = m.regions[nm].t;
        return [t.rawX, t.rawY, t.anchor, t.fs].join(",");
      }));
      assert.equal(seen.size, 1, `${short(nm)} label position varies with the votes: ${[...seen].join(" | ")}`);
    }
  });

  test("no label lands in a bubble", () => {
    assertNone(problemsOf(singleVoteMaps()), ["label-bubble"], "divisions with a label inside a bubble");
  });

  test("no leader crosses a bubble other than its own", () => {
    assertNone(problemsOf(singleVoteMaps()), ["leader-bubble"], "divisions with a leader through another bubble");
  });

  test("every label has one leader, and it reaches that region's own bubble", () => {
    assertNone(problemsOf(singleVoteMaps()), ["leader-own"], "divisions with a missing or misdirected leader");
  });

  test("labels stay inside the clipped frame, clear of each other, and no leader runs through a label or across another leader", () => {
    assertNone(problemsOf(singleVoteMaps()), ["frame", "label-label", "leader-label", "leader-leader"],
      "divisions with labels or leaders in each other's way");
  });

  test("a region with more votes never gets a smaller bubble", () => {
    assertNone(problemsOf(singleVoteMaps()), ["radius"], "divisions where the bubble sizes disagree with the votes");
  });
});

describe(`Europe map: every board of up to ${PEOPLE} people, however many regions each picked`, () => {
  /* A second instance with no coastline, so 16^4 renders take seconds rather than tens of them. */
  const fast = loadApp();
  const GRID = (PEOPLE + 1) ** K;

  test("switching the coastline off changes nothing this suite measures", () => {
    fast.MAPGEO = [];
    assert.deepEqual(fast.MAPGEO, [], "the coastline binding can be emptied");
    const samples = [
      MAP_REGIONS.map(() => 0), MAP_REGIONS.map(() => PEOPLE), MAP_REGIONS.map((_, i) => i * 4),
      MAP_REGIONS.map((_, i) => (i % 2 ? PEOPLE : 1)), MAP_REGIONS.map((_, i) => PEOPLE - i * 3),
    ];
    for (const vec of samples) {
      const full = readMap(mapSVG(tallyOf(vec))), bare = readMap(fast.mapSVG(tallyOf(vec)));
      const strip = (m) => ({
        circles: m.circles.map(({ at, ...c }) => c), lines: m.lines.map(({ at, ...l }) => l),
        texts: m.texts.map(({ at, ...t }) => t),
      });
      assert.deepEqual(strip(bare), strip(full), `bubbles, labels and leaders identical for ${describeVotes(vec)}`);
    }
  });

  test(`all ${GRID} tallies (each region 0 to ${PEOPLE}): every rule above holds`, () => {
    fast.MAPGEO = [];
    const problems = [];
    let n = 0;
    for (const vec of grid(PEOPLE, K)) {
      n++;
      const { problems: p } = judge(fast.mapSVG(tallyOf(vec)), vec);
      if (p.length) problems.push(...p);
    }
    assert.equal(n, GRID);
    assertNone(problems, ["text", "bubble", "slot", "label-bubble", "leader-bubble", "leader-own",
      "frame", "label-label", "leader-label", "leader-leader", "radius"], "problems across the grid");
  });
});

describe("Europe map on the results page, from real answers", () => {
  const VEST = "Vestland, Norway \u2014 the fjords";
  const FRENCH_NOW = "French Alps, Vercors & Chartreuse";
  const FRENCH_OLD = "French Alps & Vercors";
  const ITALY = "Italian Alps", PYR = "Pyrenees";
  const RETIRED_PICK = "Vosges & Alsace";
  /* Pins placed on the bubble centres themselves: the worst case for anything drawn inside a
     bubble, which is why the count lives in the label. Region centres, nobody's home. */
  const at = (nm) => RCPOS[nm].slice();

  /* Fifteen invented people. Thirteen answered on the current form (C4, up to two picks,
     some with pins); two sent C2 codes from the old eight-region list, one of them with a
     region since retired. Tally by hand:
       Vestland      Cato Gro Liv                          3
       French Alps   Bo Eir Ines Liv + Nora Oda (old name) 6
       Italian Alps  Ada Bo Dag Finn Gro Ines Kari Mats    8
       Pyrenees      Ada Eir Hal Kari Oda                  5
       off the list  Dag Jens                              2  (no bubble)
       Vosges        Nora                                  1  (retired: no bubble) */
  const C4 = [
    ["Ada", [ITALY, PYR], { [ITALY]: [46.07, 11.12], [PYR]: [42.96, 1.61] }],
    ["Bo", [FRENCH_NOW, ITALY], { [FRENCH_NOW]: at(FRENCH_NOW), [ITALY]: at(ITALY) }],
    ["Cato", [VEST], { [VEST]: at(VEST) }],
    ["Dag", [ITALY, OFFLIST], { [ITALY]: at(ITALY) }],
    ["Eir", [FRENCH_NOW, PYR], { [PYR]: at(PYR) }],
    ["Finn", [ITALY], {}],
    ["Gro", [VEST, ITALY], { [VEST]: at(VEST), [ITALY]: at(ITALY) }],
    ["Hal", [PYR], { [PYR]: at(PYR) }],
    ["Ines", [FRENCH_NOW, ITALY], { [FRENCH_NOW]: at(FRENCH_NOW) }],
    ["Jens", [OFFLIST], {}],
    ["Kari", [ITALY, PYR], {}],
    ["Liv", [VEST, FRENCH_NOW], { [FRENCH_NOW]: at(FRENCH_NOW) }],
    ["Mats", [ITALY], { [ITALY]: at(ITALY) }],
  ];
  const C2 = [
    ["Nora", [FRENCH_OLD, RETIRED_PICK]],
    ["Oda", [FRENCH_OLD, PYR]],
  ];
  const EXPECT = { [VEST]: 3, [FRENCH_NOW]: 6, [ITALY]: 8, [PYR]: 5 };

  function resultsMap() {
    const page = loadApp();
    const codes = [
      ...C4.map(([n, rg, pn]) => page.decode(buildCode(4, sampleAnswer({ n, rg, pn })))),
      ...C2.map(([n, rg]) => page.decode(buildCode(2, sampleAnswer({ n, rg, pn: {}, cp: 2, rn: 1 })))),
    ];
    assert.equal(codes.length, PEOPLE);
    page.codes = codes;
    page.mode = "result";
    page.render();
    const html = page.dom.appHTML();
    const m = html.match(/<div id="mapbox">\s*(<svg[\s\S]*?<\/svg>)/);
    assert.ok(m, "the results page has the map in #mapbox");
    return { svg: m[1], codes };
  }

  test("each label carries the tally of real answers, renamed picks counted under the new name", () => {
    const { svg } = resultsMap();
    const { texts } = readMap(svg);
    for (const [nm, v] of Object.entries(EXPECT)) {
      const want = `${short(nm)} ${MIDDOT} ${v}`;
      assert.ok(texts.some((t) => t.text === want), `the map says ${JSON.stringify(want)}; it has ${JSON.stringify(texts.map((t) => t.text))}`);
    }
  });

  test("retired and off-list picks get no bubble and no label on the map", () => {
    const { svg } = resultsMap();
    const { circles, texts } = readMap(svg);
    const titles = circles.map((c) => c.title);
    for (const nm of [RETIRED_PICK, OFFLIST, FRENCH_OLD]) {
      assert.ok(!titles.includes(nm), `no bubble titled ${JSON.stringify(nm)}`);
      assert.ok(!texts.some((t) => t.text.includes(nm)), `no label for ${JSON.stringify(nm)}`);
    }
    assert.deepEqual(titles.filter((t) => MAP_REGIONS.includes(t)).sort(), MAP_REGIONS.slice().sort(),
      "one bubble for each map region");
  });

  test("pins sit on top of the bubbles and no numeral sits inside any bubble", () => {
    const { svg, codes } = resultsMap();
    const { circles, texts } = readMap(svg);
    const bubbles = circles.filter((c) => MAP_REGIONS.includes(c.title));
    const pins = circles.filter((c) => !MAP_REGIONS.includes(c.title));
    const placed = codes.reduce((s, c) => s + Object.keys(c.pn || {}).length, 0);
    assert.ok(placed >= 10, `fixture places pins (${placed})`);
    assert.equal(pins.length, placed, "one pin drawn per pin placed");
    const lastBubble = Math.max(...bubbles.map((b) => b.at));
    assert.ok(pins.every((p) => p.at > lastBubble), "every pin is drawn after every bubble, so it sits on top");
    for (const b of bubbles) {
      assert.ok(!/\d/.test(b.title), `the ${b.title} bubble carries no count in its title`);
      for (const t of texts) {
        assert.ok(boxPointDist(b.cx, b.cy, textBox(t)) >= b.r + b.sw / 2,
          `text ${JSON.stringify(t.text)} is not drawn inside the ${b.title} bubble`);
      }
    }
    const vec = MAP_REGIONS.map((nm) => EXPECT[nm]);
    assertNone(judge(svg, vec).problems, ["text", "bubble", "slot", "label-bubble", "leader-bubble", "leader-own",
      "frame", "label-label", "leader-label", "leader-leader", "radius"], "problems on the rendered results page");
  });
});
