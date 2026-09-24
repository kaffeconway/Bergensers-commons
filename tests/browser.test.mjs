/*
 * The checks that need a real browser. Everything else in this suite runs the app's script
 * in a stub DOM under Node, which cannot lay anything out: it has no pixels, no CSS, no
 * viewBox scaling and no network. These tests open index.html from file:// in headless
 * Chromium (the 'playwright' package's library API, not @playwright/test) and drive it the
 * way a person does. See CLAUDE.md, "Testing changes" and "Map pins".
 *
 * WHAT IS COVERED
 *
 *   1. Loading. The home screen and a shared single-answer link load with no uncaught page
 *      error and no console error. (A shared multi-answer link is loaded, and held to the
 *      same standard, by the two results-map checks.)
 *
 *   2. The pin picker's inverse projection. All four regions: the French Alps and Vestland
 *      tapped on a touchscreen at phone width (390px), the Italian Alps and the Pyrenees
 *      clicked with a mouse at desktop width (1280px, where the map is drawn at about 1.75
 *      times its viewBox) and tapped again at 360px in the end-to-end walk. The test taps the
 *      exact pixel where the browser drew a town's dot, then checks the answer the app saved
 *      to localStorage is that town, to within the ~4 km a pin is quantised to anyway. The
 *      dot's position is read from the browser's own layout (getBoundingClientRect), and
 *      the town's coordinates are written out literally below, so neither side of the
 *      comparison is the app's own arithmetic. This is the only check that sees the CSS
 *      pixel to viewBox scaling: the unit tests have no layout to scale. Towns are chosen
 *      at both edges of each inset, where a scaling error is largest. The pin the app then
 *      draws is also checked to land under the finger, so the forward and inverse
 *      projections agree.
 *
 *   3. A whole answer, end to end. Every one of the eleven steps is answered through the
 *      UI (buttons, token steppers, chip taps, keyboard on the sliders, typed text, two map
 *      pins), the review screen must raise no read-back warning, and the code shown on the
 *      "Here is your code" screen is decoded by the page's own decode() and compared field
 *      by field with what was entered. The share link is then opened in a fresh browser
 *      context, the way the collector would, and added to their board.
 *
 *   4. The results map with no network. Every request to the Natural Earth (world-atlas)
 *      CDNs is aborted; the map must still draw the hand-drawn FALLBACK outline, with its
 *      region bubbles, and log nothing but the aborted loads themselves.
 *
 *   5. The results map WITH the network, offline. The first CDN URL is answered with a
 *      tiny TopoJSON fixture (two rings in the frame, one far outside it), so upgradeMap's
 *      real fetch, decodeTopo, window filter and redraw all run without touching the
 *      internet. The map must switch to the fixture's coastline and stop after the first
 *      source that answers.
 *
 *   6. Typed text on the "How would you use it?" step survives a tap on one of that step's
 *      options. grabOwn() exists so that everything a person can type is captured before
 *      the screen is rebuilt under them; the deal-breaker box on the timing step is
 *      explicitly protected the same way.
 *
 * WHAT IS NOT
 *
 *   - Real Natural Earth data from the real CDN. CI must not depend on jsDelivr being up,
 *     so check 5 serves a fixture in its place. The URL list and the TopoJSON decoding are
 *     exercised; the live file's contents are not.
 *   - Other browsers. Chromium only; the in-app browsers the page is really opened in
 *     (WhatsApp and friends) are not available headless.
 *   - The poster image and the clipboard. Both need permissions or canvas output that a
 *     headless run would only fake.
 *   - The page's smooth scrolling. Every context asks for reduced motion, which the page's
 *     own CSS honours, so nothing is mid-scroll between measuring a pixel and tapping it.
 *   - Chromium logs each aborted request as "Failed to load resource". Those lines, and only
 *     those, for the world-atlas URLs a test aborted on purpose, are not counted as errors.
 *
 * RUNNING
 *
 *   Needs the 'playwright' npm package (pinned in package.json) and its Chromium:
 *     npm ci && npx playwright install chromium
 *   Here, the browsers are preinstalled under PLAYWRIGHT_BROWSERS_PATH. The app is read
 *   from INDEX_HTML when set (see harness.mjs), so the suite can be pointed at a broken
 *   copy. There are no fixed sleeps: every wait is on a condition.
 *
 * Fixtures use invented first names only. This file is pure ASCII; non-ASCII text is
 * written as \u escapes.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { INDEX_PATH, LAYOUT, buildCode, sampleAnswer } from "./harness.mjs";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  throw new Error("tests/browser.test.mjs needs the 'playwright' package: run `npm ci`, then " +
    "`npx playwright install chromium`. (" + e.message + ")");
}

const PAGE_URL = pathToFileURL(INDEX_PATH).href;

const VESTLAND = "Vestland, Norway \u2014 the fjords";
const FRENCH = "French Alps, Vercors & Chartreuse";
const ITALIAN = "Italian Alps";
const PYRENEES = "Pyrenees";

/* Real coordinates of towns the pin picker draws, written out here rather than read from
   RCTOWN, so the expected answer is not the app's own number. Two or three per region,
   spread to both edges of the inset, where a wrong scale factor puts a pin furthest out. */
const TOWNS = {
  [VESTLAND]: [["Bergen", 60.39, 5.32], ["Stryn", 61.91, 6.72], ["Odda", 60.07, 6.55]],
  [FRENCH]: [["Valence", 44.93, 4.89], ["Grenoble", 45.19, 5.72], ["Gap", 44.56, 6.08]],
  [ITALIAN]: [["Turin", 45.07, 7.69], ["Bolzano", 46.50, 11.35], ["Udine", 46.06, 13.24]],
  [PYRENEES]: [["Pau", 43.30, -0.37], ["Foix", 42.96, 1.61], ["Perpignan", 42.70, 2.90]],
};
const town = (rg, name) => {
  const t = TOWNS[rg].find((x) => x[0] === name);
  if (!t) throw new Error(`no town ${name} listed for ${rg}`);
  return [t[1], t[2]];
};

/* A tap on a town's dot has to come back as that town to within the quantisation a pin is
   stored at anyway (about 4 km). A broken scale or offset misses by tens of kilometres. */
const TOWN_KM = 4;
/* The pin the app draws after a tap should sit under the finger. */
const DRAWN_PX = 3;
/* Half a quantisation step per axis: MAPWIN is 37 degrees tall and 43 wide, 1023 steps. */
const LAT_HALF_STEP = (LAYOUT.mapwin.la1 - LAYOUT.mapwin.la0) / LAYOUT.pinSteps / 2 + 1e-9;
const LON_HALF_STEP = (LAYOUT.mapwin.lo1 - LAYOUT.mapwin.lo0) / LAYOUT.pinSteps / 2 + 1e-9;

const km = (a, b) => {
  const r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const WORLD_ATLAS = /world-atlas@2\/countries-\d+m\.json/;

/* ------------------------------------------------------------------ browser plumbing */

let browser;
before(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    throw new Error("Chromium did not launch. Run `npx playwright install chromium` (CI: " +
      "`npx playwright install --with-deps chromium`). " + e.message);
  }
});
after(async () => { if (browser) await browser.close(); });

/* A fresh context (so fresh localStorage) per test, with every http(s) request aborted
   unless a test routes it itself: no test may reach the real network. */
async function openContext(opts = {}) {
  /* reducedMotion turns off the page's own smooth scrolling (its prefers-reduced-motion
     rule), so nothing is still moving when a test measures a pixel and then taps it */
  /* locale and time zone are pinned so nothing depends on the machine the suite runs on (a
     CI runner is C.UTF-8 and UTC; a laptop is whatever its owner set). The page reads
     neither today, so this is a guard, not a fix. */
  const ctx = await browser.newContext({ reducedMotion: "reduce", locale: "en-GB", timezoneId: "UTC", ...opts });
  /* Every wait is on a condition, so this only decides how long a genuine failure takes to
     report. It is generous because on CI this file shares a small runner with the CPU-bound
     map and triangle walks, which node --test runs alongside it. */
  ctx.setDefaultTimeout(20000);
  await ctx.route(/^https?:\/\//i, (route) => route.abort());
  return ctx;
}

/* Collects anything the page throws or logs as an error. A failed resource load is only
   forgiven when its URL matches one of `expectedNetFails` - the requests a test aborted on
   purpose. */
function watchErrors(page, expectedNetFails = []) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("uncaught: " + (e && e.stack ? e.stack : e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = (m.location() && m.location().url) || "";
    if (/^Failed to load resource/i.test(m.text()) && expectedNetFails.some((re) => re.test(url))) return;
    errors.push("console.error: " + m.text() + (url ? " (" + url + ")" : ""));
  });
  return errors;
}

/* Which step the questionnaire is showing, 1-based, from the visible "Step N of 11" bar.
   textContent, not innerText: the bar is text-transform:uppercase and innerText applies it. */
const stepShown = (page) => page.evaluate(() => {
  const el = document.querySelector(".stepno");
  const m = el && /step\s+(\d+)\s+of\s+(\d+)/i.exec(el.textContent);
  return m ? { n: +m[1], of: +m[2] } : null;
});

async function waitForStep(page, n) {
  try {
    await page.waitForFunction((want) => {
      const el = document.querySelector(".stepno");
      const m = el && /step\s+(\d+)\s+of/i.exec(el.textContent);
      return !!m && +m[1] === want;
    }, n);
  } catch (e) {
    const err = await page.evaluate(() => (document.getElementById("err") || {}).textContent || "");
    throw new Error(`expected step ${n}, still on ${JSON.stringify(await stepShown(page))}` +
      (err ? `; the page said: ${err}` : ""));
  }
}

/* Press Next on step `from` (1-based) and wait until step from+1 is showing. */
async function next(page, from) {
  await page.click("#next");
  await waitForStep(page, from + 1);
}

/* Where the browser actually drew a town's dot on a region's pin map, in viewport pixels,
   plus the rendered size of the map it sits on. */
async function dotCentre(page, rg, name) {
  const got = await page.evaluate(([rg, name]) => {
    const svg = [...document.querySelectorAll("svg.pinmap")].find((s) => s.dataset.pinrg === rg);
    if (!svg) return { err: `no pin map on screen for ${rg}` };
    const label = [...svg.querySelectorAll("text")].find((t) => t.textContent.trim() === name);
    if (!label) return { err: `no town labelled ${name} on the ${rg} pin map` };
    const dot = label.previousElementSibling;
    if (!dot || dot.tagName.toLowerCase() !== "circle") return { err: `no dot drawn beside ${name}` };
    const r = dot.getBoundingClientRect(), box = svg.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, mapWidth: box.width };
  }, [rg, name]);
  if (got.err) throw new Error(got.err);
  return got;
}

/* The pin the app drew for a region, if any, in viewport pixels. */
const drawnPin = (page, rg) => page.evaluate((rg) => {
  const svg = [...document.querySelectorAll("svg.pinmap")].find((s) => s.dataset.pinrg === rg);
  const c = svg && svg.querySelector('circle[r="5.5"]');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, rg);

/* What the app saved for this person: the draft autosave() writes to localStorage. */
const savedDraft = (page, name) => page.evaluate((key) => {
  const v = localStorage.getItem(key);
  return v ? JSON.parse(v) : null;
}, "commons:" + name.toLowerCase());

/* Tap (or click) the exact pixel of a town's dot and return what the app then saved. */
async function pinTown(page, { rg, name, person, how }) {
  await page.evaluate((rg) => {
    const svg = [...document.querySelectorAll("svg.pinmap")].find((s) => s.dataset.pinrg === rg);
    if (svg) svg.scrollIntoView({ block: "center", behavior: "instant" });
  }, rg);
  const at = await dotCentre(page, rg, name);
  const prev = JSON.stringify(((await savedDraft(page, person)) || {}).pin?.[rg] || null);
  if (how === "tap") await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  await page.waitForFunction(([key, rg, prev]) => {
    const v = localStorage.getItem(key);
    const p = v ? (JSON.parse(v).pin || {})[rg] : null;
    return !!p && JSON.stringify(p) !== prev;
  }, ["commons:" + person.toLowerCase(), rg, prev]).catch(() => {
    throw new Error(`tapping ${name} on the ${rg} map stored no new pin`);
  });
  const saved = (await savedDraft(page, person)).pin[rg];
  const live = await page.evaluate((rg) => S.pin[rg], rg);
  const drawn = await drawnPin(page, rg);
  return { at, saved, live, drawn };
}

function assertPinnedTown(r, rg, name, t) {
  const want = town(rg, name);
  const off = km(r.saved, want);
  if (t && r.drawn) {
    t.diagnostic(`${name}: saved ${off.toFixed(2)} km from the town, pin drawn ` +
      `${Math.hypot(r.drawn.x - r.at.x, r.drawn.y - r.at.y).toFixed(2)}px from the tap, ` +
      `map ${r.at.mapWidth.toFixed(1)}px wide`);
  }
  assert.ok(Array.isArray(r.saved) && r.saved.length === 2, `the ${rg} pin is saved as [lat, lon]`);
  assert.ok(off <= TOWN_KM,
    `tapping ${name}'s dot on the ${rg} map (${r.at.mapWidth.toFixed(0)}px wide) saved ` +
    `${r.saved[0].toFixed(3)}, ${r.saved[1].toFixed(3)}, ${off.toFixed(1)} km from ${name} ` +
    `(${want[0]}, ${want[1]}); allowed ${TOWN_KM} km`);
  assert.deepEqual(r.live, r.saved, "the saved draft matches the live answer");
  assert.ok(r.drawn, `a pin is drawn on the ${rg} map after the tap`);
  const px = Math.hypot(r.drawn.x - r.at.x, r.drawn.y - r.at.y);
  assert.ok(px <= DRAWN_PX, `the ${rg} pin is drawn ${px.toFixed(2)}px from where ${name} was tapped; ` +
    `allowed ${DRAWN_PX}px`);
}

/* From the home screen to the region step with the fewest answers the steps accept. */
async function walkToRegions(page, person) {
  await page.click("#start");
  await waitForStep(page, 1);
  await page.fill("#nm", person);
  await next(page, 1);
  await page.click('[data-style="sep"]');
  await next(page, 2);
  await page.click('[data-sp="land"][data-d="1"]');
  await next(page, 3);
  await next(page, 4);
  await next(page, 5);
  await page.click('[data-use="full"]');
  await page.click('[data-hh="solo"]');
  await next(page, 6);
  await page.click('[data-hz="soon"]');
  await next(page, 7);
  await page.click('[data-debt="No"]');
  await next(page, 8);
  await next(page, 9);
  const h = await page.textContent("#app h2");
  assert.match(h, /where/i, `step 10 is the region step (heading: ${JSON.stringify(h)})`);
}

async function pickRegion(page, rg) {
  await page.locator("[data-rg]").filter({ hasText: rg }).first().click();
  await page.waitForFunction((rg) => [...document.querySelectorAll("svg.pinmap")]
    .some((s) => s.dataset.pinrg === rg), rg);
}

/* ------------------------------------------------------------------ 1. loading */

describe("loading", () => {
  test("the home screen loads with no uncaught error and no console error", async () => {
    const ctx = await openContext(PHONE);
    try {
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(PAGE_URL, { waitUntil: "load" });
      await page.waitForSelector("#start");
      assert.match(await page.textContent("#app h1"), /\S/, "the home screen has a heading");
      assert.ok(await page.isVisible("#comb"), "the board / combine button is there");
      assert.deepEqual(errors, [], "no errors on load");
    } finally { await ctx.close(); }
  });

  test("a shared single-answer link opens on the 'someone shared their answers' screen", async () => {
    const ctx = await openContext(PHONE);
    try {
      const page = await ctx.newPage();
      const errors = watchErrors(page);
      await page.goto(PAGE_URL + "#c=" + buildCode(4, sampleAnswer({ n: "Ada" })), { waitUntil: "load" });
      await page.waitForSelector("#addb");
      assert.match(await page.textContent("#app h2"), /Ada/, "the screen names whose answers they are");
      assert.deepEqual(errors, [], "no errors on load");
    } finally { await ctx.close(); }
  });
});

/* ------------------------------------------------------------------ 2. the pin picker */

describe("pin picker: a tap on a town's dot stores that town", () => {
  const cases = [
    { label: "phone width, tapped", ctx: PHONE, how: "tap", person: "Bo", regions: [FRENCH, VESTLAND] },
    { label: "desktop width, clicked", ctx: DESKTOP, how: "click", person: "Cato", regions: [ITALIAN, PYRENEES] },
  ];
  for (const c of cases) {
    test(`${c.label}: ${c.regions.map((r) => r.split(",")[0]).join(" and ")}`, async (t) => {
      const ctx = await openContext(c.ctx);
      try {
        const page = await ctx.newPage();
        const errors = watchErrors(page);
        await page.goto(PAGE_URL, { waitUntil: "load" });
        await walkToRegions(page, c.person);
        for (const rg of c.regions) await pickRegion(page, rg);
        for (const rg of c.regions) {
          for (const [name] of TOWNS[rg]) {
            const r = await pinTown(page, { rg, name, person: c.person, how: c.how });
            assertPinnedTown(r, rg, name, t);
          }
        }
        /* the scale factor really was exercised: at desktop width the map is drawn much
           larger than its 320-unit viewBox, at phone width close to it */
        const w = (await dotCentre(page, c.regions[0], TOWNS[c.regions[0]][0][0])).mapWidth;
        if (c.ctx === DESKTOP) assert.ok(w > 480, `desktop pin map is ${w}px wide, expected well over 320`);
        else assert.ok(w > 250 && w < 380, `phone pin map is ${w}px wide`);
        assert.deepEqual(errors, [], "no errors while placing pins");
      } finally { await ctx.close(); }
    });
  }
});

/* ------------------------------------------------------------------ 3. end to end */

/* What the person below enters, in the decoded-record shape. Every step gets a non-default
   answer where it has one, so a field that is dropped or read from the wrong place shows. */
const ENTERED = {
  n: "Dag",
  s: "mix",
  sp: { land: 5, build: 2, wild: 1, city: 0, central: 3, known: 0, cheap: 6, sun: 3 },
  a: { garden: 2, bees: 1, hens: 1, carp: 2, ski: 1, quiet: 2, hunt: 3, work: 3 },
  ow: ["Kayaking", "A shared library"],
  t: { tour: 0, dk: 4, lang: 3, far: 1, rough: 2 },
  u: "often", hh: "kids", cz: "Norwegian", lv: "Netherlands",
  tr: "good", hz: "long", st: "No winter road access",
  cp: 6, rn: 5, d: "Maybe",
  sk: ["build", "cook", "lang", "web"],
  /* picked in the opposite order to REGIONS, which is the order a code stores them (and
     their pins) in; the decoded answer is expected back in REGIONS order */
  picks: [PYRENEES, ITALIAN],
  rg: [ITALIAN, PYRENEES],
  pins: { [PYRENEES]: "Foix", [ITALIAN]: "Bolzano" },
  wy: "Room to grow things together",
};

test("a full answer entered through the UI comes back out of the code it produces", async () => {
  const ctx = await openContext({ ...PHONE, viewport: { width: 360, height: 780 } });
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(PAGE_URL, { waitUntil: "load" });
    const E = ENTERED;

    await page.click("#start");
    await waitForStep(page, 1);
    assert.equal((await stepShown(page)).of, 11, "eleven steps");
    await page.fill("#nm", E.n);
    await next(page, 1);

    await page.click(`[data-style="${E.s}"]`);
    await next(page, 2);

    for (const [k, v] of Object.entries(E.sp)) {
      for (let i = 0; i < v; i++) await page.click(`[data-sp="${k}"][data-d="1"]`);
    }
    assert.equal((await page.textContent("#left")).trim(), "0", "all twenty tokens spent");
    await next(page, 3);

    for (const [k, v] of Object.entries(E.a)) {
      for (let i = 0; i < v; i++) await page.click(`[data-act="${k}"]`);
    }
    await page.fill("#own", E.ow.join("\n"));
    await next(page, 4);

    /* the sliders, by keyboard, the way they are actually operated */
    const keys = { 0: "Home", 4: "End", 3: "ArrowRight", 1: "ArrowLeft" };
    for (const [k, v] of Object.entries(E.t)) {
      if (v === 2) continue;                     /* where every slider starts */
      await page.focus(`#tol-${k}`);
      await page.keyboard.press(keys[v]);
      assert.equal(await page.inputValue(`#tol-${k}`), String(v), `slider ${k}`);
    }
    await next(page, 5);

    await page.click(`[data-use="${E.u}"]`);
    await page.click(`[data-hh="${E.hh}"]`);
    await page.fill("#cz", E.cz);
    await page.fill("#lv", E.lv);
    await next(page, 6);

    await page.click(`[data-tr="${E.tr}"]`);
    await page.click(`[data-hz="${E.hz}"]`);
    await page.fill("#stop", E.st);
    await next(page, 7);

    await page.click(`[data-cap="${E.cp}"]`);
    await page.click(`[data-run="${E.rn}"]`);
    await page.click(`[data-debt="${E.d}"]`);
    await next(page, 8);

    for (const k of E.sk) await page.click(`[data-sk="${k}"]`);
    await next(page, 9);

    for (const rg of E.picks) await pickRegion(page, rg);
    const placed = {};
    for (const [rg, name] of Object.entries(E.pins)) {
      const r = await pinTown(page, { rg, name, person: E.n, how: "tap" });
      assertPinnedTown(r, rg, name);
      placed[rg] = r.saved;
    }
    await next(page, 10);

    await page.fill("#why", E.wy);
    await page.click("#next");                   /* "Check my answers" */
    await page.waitForSelector("#rvok");
    const warn = await page.locator("#app .warn").allTextContents();
    assert.deepEqual(warn, [], "the review screen's own read-back check raised nothing");
    const secs = (await page.locator("#app h3.sec").allInnerTexts()).map((s) => s.toLowerCase());
    assert.ok(secs.includes("money") && secs.includes("who"), `review sections: ${secs.join(", ")}`);

    await page.click("#rvok");                   /* "That's right - get my code" */
    await page.waitForSelector("#cd");
    const shown = await page.textContent("#cd");
    const code = shown.replace(/\s+/g, "");
    assert.ok(code.length > 20, "a code is shown");
    assert.ok(/ /.test(shown.trim()), "the code is shown in grouped chunks");
    assert.equal(await page.evaluate(() => location.hash), "#c=" + code, "the share link carries the same code");

    const got = await page.evaluate((c) => { const v = decode(c); return Array.isArray(v) ? v : [v]; }, code);
    assert.equal(got.length, 1, "one answer in the code");
    const d = got[0];
    for (const k of ["n", "s", "u", "hh", "hz", "d", "tr", "st", "wy", "cz", "lv"]) {
      assert.equal(d[k], E[k], `field ${k}`);
    }
    assert.equal(d.rw, "", "no region write-in");
    assert.equal(d.cp, E.cp, "capital band");
    assert.equal(d.rn, E.rn, "monthly band");
    assert.deepEqual(d.ow, E.ow, "activity write-ins");
    assert.deepEqual(d.sp, Object.fromEntries(LAYOUT.spend.map((k) => [k, E.sp[k] || 0])), "tokens");
    assert.deepEqual(d.a, Object.fromEntries(LAYOUT.acts.map((k) => [k, E.a[k] || 0])), "activities");
    assert.deepEqual(d.t, Object.fromEntries(LAYOUT.tol.map((k) => [k, E.t[k]])), "tolerances");
    assert.deepEqual(d.sk, Object.fromEntries(LAYOUT.skills.map((k) => [k, E.sk.includes(k) ? 1 : 0])), "skills");
    assert.deepEqual(d.rg, E.rg, "regions");
    assert.deepEqual(Object.keys(d.pn).sort(), Object.keys(E.pins).sort(), "one pin per picked region, keyed by name");
    for (const [rg, name] of Object.entries(E.pins)) {
      const p = d.pn[rg];
      assert.ok(Math.abs(p[0] - placed[rg][0]) <= LAT_HALF_STEP && Math.abs(p[1] - placed[rg][1]) <= LON_HALF_STEP,
        `the ${rg} pin in the code (${p}) is the placed pin (${placed[rg]}) to within one quantisation step`);
      assert.ok(km(p, town(rg, name)) <= TOWN_KM + 3, `the ${rg} pin in the code is still ${name}`);
    }
    assert.deepEqual(errors, [], "no errors anywhere in the walk");

    /* The collector's side: open the share link fresh and put it on the board. */
    const ctx2 = await openContext(PHONE);
    try {
      const p2 = await ctx2.newPage();
      const errors2 = watchErrors(p2);
      await p2.goto(PAGE_URL + "#c=" + code, { waitUntil: "load" });
      await p2.waitForSelector("#addb");
      assert.match(await p2.textContent("#app h2"), /Dag/, "the shared link names Dag");
      await p2.click("#addb");
      await p2.waitForSelector("#tx");            /* the board */
      const board = await p2.evaluate(() => boardGet());
      assert.equal(board.length, 1, "one row on the board");
      assert.equal(board[0].n, "Dag");
      assert.deepEqual(board[0].rg, E.rg);
      assert.deepEqual(errors2, [], "no errors on the collector's side");
    } finally { await ctx2.close(); }
  } finally { await ctx.close(); }
});

/* ------------------------------------------------------------------ 4 and 5. the results map */

/* Two invented people, as one combined code: opening it lands straight on the results. */
const RESULTS_CODE = buildCode(4, [
  sampleAnswer({ n: "Eli" }),
  sampleAnswer({ n: "Fen", rg: [FRENCH, VESTLAND], pn: { [FRENCH]: [45.19, 5.72] } }),
]);

/* Records every fetch the page makes and whether it has settled, so a test can wait for
   upgradeMap to have finished trying rather than guessing how long that takes. The wrapper
   attaches its handlers before the app awaits the promise, so by the time an entry reads
   as settled the app's own continuation has run too. */
function recordFetches() {
  const real = window.fetch;
  window.__fetches = [];
  window.fetch = function (u) {
    const e = { url: String(u), settled: "" };
    window.__fetches.push(e);
    const p = real.apply(this, arguments);
    p.then(() => { e.settled = "ok"; }, () => { e.settled = "failed"; });
    return p;
  };
}

/* The coastline strokes on the results map, as the browser has them. */
const mapCoast = (page) => page.evaluate(() => {
  const svg = document.querySelector("#mapbox svg");
  if (!svg) return null;
  const box = svg.getBoundingClientRect();
  return {
    width: box.width, height: box.height,
    coast: [...svg.querySelectorAll('polyline[stroke-opacity=".33"]')].map((p) => p.getAttribute("points")),
    fills: svg.querySelectorAll("polygon").length,
    bubbles: [...svg.querySelectorAll("circle > title")].map((t) => t.textContent),
  };
});

test("results map: with the Natural Earth CDNs unreachable it draws the hand-drawn outline", async () => {
  const ctx = await openContext(PHONE);
  try {
    const page = await ctx.newPage();
    const aborted = [];
    await page.route(WORLD_ATLAS, (route) => { aborted.push(route.request().url()); return route.abort(); });
    await page.addInitScript(recordFetches);
    const errors = watchErrors(page, [WORLD_ATLAS]);
    await page.goto(PAGE_URL + "#c=" + RESULTS_CODE, { waitUntil: "load" });
    await page.waitForSelector("#mapbox svg");
    await page.waitForFunction(() => window.__fetches.length >= 3 && window.__fetches.every((e) => e.settled));

    const state = await page.evaluate(() => ({
      src: MAPSRC, isFallback: MAPGEO === FALLBACK, lines: FALLBACK.length,
      tried: window.__fetches.map((e) => [e.url, e.settled]),
      expectFirst: FALLBACK[0].map(([la, lo]) => MPX(la, lo).map((v) => v.toFixed(1)).join(",")).join(" "),
    }));
    assert.equal(state.tried.length, 3, `every source tried once: ${JSON.stringify(state.tried)}`);
    assert.ok(state.tried.every(([u, s]) => WORLD_ATLAS.test(u) && s === "failed"), "and every one failed");
    assert.equal(aborted.length, 3, "all three were aborted by the test, none reached the network");
    assert.equal(state.src, "outline", "the map is still on its hand-drawn outline");
    assert.ok(state.isFallback, "MAPGEO is FALLBACK");

    const m = await mapCoast(page);
    assert.ok(m && m.width > 200 && m.height > 200, `the map is drawn at a real size (${m && m.width}x${m && m.height})`);
    assert.equal(m.coast.length, state.lines, "one coastline stroke per hand-drawn line");
    assert.equal(m.coast[0].replace(/\s+/g, " ").trim(), state.expectFirst, "and they are the hand-drawn lines");
    assert.ok(m.fills >= 1, "the land is filled");
    for (const rg of [VESTLAND, FRENCH, ITALIAN, PYRENEES]) {
      assert.ok(m.bubbles.includes(rg), `a bubble for ${rg}`);
    }
    assert.deepEqual(errors, [], "nothing logged beyond the aborted loads themselves");
  } finally { await ctx.close(); }
});

/* A TopoJSON "countries" object as world-atlas publishes it: quantised, delta-encoded
   arcs, x = longitude and y = latitude after the transform. Two closed rings inside the
   map frame (around the western Alps, and off Vestland) and one far outside it, which
   upgradeMap's window filter has to drop. */
const TOPO = {
  type: "Topology",
  transform: { scale: [0.01, 0.01], translate: [0, 0] },
  arcs: [
    [[500, 4400], [300, 0], [0, 300], [-300, 0], [0, -300]],       /* 44-47N, 5-8E */
    [[450, 6000], [150, 0], [0, 100], [-150, 0], [0, -100]],       /* 60-61N, 4.5-6E */
    [[10000, 1000], [100, 0], [0, 100], [-100, 0], [0, -100]],     /* 10N, 100E: outside */
  ],
  objects: {
    countries: {
      type: "GeometryCollection",
      geometries: [
        { type: "Polygon", arcs: [[0]] },
        { type: "MultiPolygon", arcs: [[[1]], [[2]]] },
      ],
    },
  },
};

test("results map: when a CDN answers, the map redraws from its data (served offline)", async () => {
  const ctx = await openContext(PHONE);
  try {
    const page = await ctx.newPage();
    const served = [], refused = [];
    await page.route(WORLD_ATLAS, (route) => {
      const url = route.request().url();
      if (/cdn\.jsdelivr\.net\/npm\/world-atlas@2\/countries-50m\.json$/.test(url)) {
        served.push(url);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify(TOPO),
        });
      }
      refused.push(url);
      return route.abort();
    });
    const errors = watchErrors(page, [WORLD_ATLAS]);
    await page.goto(PAGE_URL + "#c=" + RESULTS_CODE, { waitUntil: "load" });
    await page.waitForSelector("#mapbox svg");
    await page.waitForFunction(() => MAPSRC === "natural earth").catch(async () => {
      throw new Error("the map never switched to the served data; MAPSRC is " +
        JSON.stringify(await page.evaluate(() => MAPSRC)) + "; served " + JSON.stringify(served));
    });
    assert.deepEqual(served.length, 1, "the first source was asked once");
    assert.deepEqual(refused, [], "and no other source was tried after it answered");

    const state = await page.evaluate(() => ({
      lines: MAPGEO.length,
      first: MAPGEO[0].map(([la, lo]) => [+la.toFixed(6), +lo.toFixed(6)]),
      expectFirst: MAPGEO[0].map(([la, lo]) => MPX(la, lo).map((v) => v.toFixed(1)).join(",")).join(" "),
    }));
    assert.equal(state.lines, 2, "the two rings in the frame were kept and the far one dropped");
    assert.deepEqual(state.first, [[44, 5], [44, 8], [47, 8], [47, 5], [44, 5]],
      "the TopoJSON arcs decode to latitude, longitude");

    const m = await mapCoast(page);
    assert.equal(m.coast.length, 2, "the redrawn map strokes the served coastline, not the outline");
    assert.equal(m.coast[0].replace(/\s+/g, " ").trim(), state.expectFirst, "at the projected positions");
    assert.equal(m.fills, 2, "and fills both rings");
    for (const rg of [VESTLAND, FRENCH, ITALIAN, PYRENEES]) {
      assert.ok(m.bubbles.includes(rg), `the ${rg} bubble survives the redraw`);
    }
    assert.deepEqual(errors, [], "no errors");
  } finally { await ctx.close(); }
});

/* ------------------------------------------------------------------ 6. typed text survives a tap */

test("text typed on the 'How would you use it?' step survives tapping that step's options", async () => {
  const ctx = await openContext(PHONE);
  try {
    const page = await ctx.newPage();
    const errors = watchErrors(page);
    await page.goto(PAGE_URL, { waitUntil: "load" });
    await page.click("#start");
    await waitForStep(page, 1);
    await page.fill("#nm", "Gro");
    await next(page, 1);
    await page.click('[data-style="big"]');
    await next(page, 2);
    await page.click('[data-sp="cheap"][data-d="1"]');
    await next(page, 3);
    await next(page, 4);
    await next(page, 5);

    /* Somebody who fills the boxes first and then answers the buttons above them. */
    await page.fill("#cz", "Danish");
    await page.fill("#lv", "Norway");
    await page.click('[data-use="part"]');
    await page.click('[data-hh="pair"]');
    assert.equal(await page.inputValue("#cz"), "Danish", "the passport box still says what was typed");
    assert.equal(await page.inputValue("#lv"), "Norway", "the country box still says what was typed");
    await next(page, 6);
    const draft = await savedDraft(page, "Gro");
    assert.equal(draft.cz, "Danish", "the passport answer is saved");
    assert.equal(draft.lv, "Norway", "the country answer is saved");
    assert.deepEqual(errors, [], "no errors");
  } finally { await ctx.close(); }
});
