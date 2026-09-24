/*
 * The share-code codec: C4 (what encode() writes today), the three older formats that must
 * keep decoding (C3, C2, C1) and the raw-JSON fallback, the transport details that keep a
 * code intact through WhatsApp, and the strictness that stops a corrupted paste from
 * turning into phantom rows. See CLAUDE.md, "Things worth knowing before editing" and
 * "Testing changes".
 *
 * Old-format codes are built by the independent encoder in harness.mjs, from the layout
 * written out literally there, never by the app's own encoder - otherwise a change to the
 * app would change the "old" code along with the decoder and the test would prove nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadApp, EXPORTS, LAYOUT, REGIONS_V2_FROZEN, REGIONS_C3,
  BITS_CORE_EXPECTED, BITS_C4_EXPECTED, NFIX_CORE, NFIX_C4,
  packRecord, packRaw, buildCode, buildC1Code, c1Line, buildJsonCode, b64bin, insertHyphens,
  sampleAnswer,
} from "./harness.mjs";

const app = loadApp();
const { encode, decode, bin64, unbin64, grp, unpackRecs, unpackC2, unpackC3, unpackC4 } = app;

const OFFLIST = "Somewhere not on this list";
const VESTLAND = "Vestland, Norway \u2014 the fjords";
const FRENCH_OLD = "French Alps & Vercors";
const FRENCH_NOW = "French Alps, Vercors & Chartreuse";
/* half a quantisation step, plus a hair: 37 and 43 degrees over 1023 steps */
const LAT_TOL = 37 / 1023 / 2 + 1e-9;
const LON_TOL = 43 / 1023 / 2 + 1e-9;

const byList = (list) => (a, b) => list.indexOf(a) - list.indexOf(b);
const one = (v) => (Array.isArray(v) ? v : [v]);

/* Every fixed field and every tail field of a decoded record against what was encoded. */
function assertSameAnswer(got, want, { regions = REGIONS_C3, pins = true, trial = true } = {}) {
  assert.ok(got && typeof got === "object", "decoded to an object");
  for (const k of ["n", "st", "wy", "rw", "cz", "lv"]) {
    assert.equal(got[k], want[k] || "", `free-text field ${k}`);
  }
  assert.deepEqual(got.ow, want.ow || [], "activity write-ins");
  for (const k of ["s", "u", "hh", "hz", "d"]) assert.equal(got[k], want[k], `fixed field ${k}`);
  assert.equal(got.cp, want.cp, "capital band");
  assert.equal(got.rn, want.rn, "monthly band");
  for (const [field, keys] of [["sp", LAYOUT.spend], ["a", LAYOUT.acts], ["t", LAYOUT.tol], ["sk", LAYOUT.skills]]) {
    const expect = Object.fromEntries(keys.map((k) => [k,
      field === "t" ? (want.t[k] !== undefined ? want.t[k] : 2) : (want[field][k] || 0)]));
    assert.deepEqual(got[field], expect, `fixed block ${field}`);
  }
  assert.deepEqual(got.rg, want.rg.slice().sort(byList(regions)), "regions, in list order");
  if (trial) assert.equal(got.tr, want.tr, "trial-year answer");
  if (pins) assertPins(got.pn, want.pn || {});
}
function assertPins(got, want) {
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), "pins are keyed by region name");
  for (const [rg, [la, lo]] of Object.entries(want)) {
    const p = got[rg];
    assert.ok(Array.isArray(p) && p.length === 2, `pin for ${rg} is a [lat, lon] pair`);
    assert.ok(Math.abs(p[0] - la) <= LAT_TOL, `latitude of the ${rg} pin: got ${p[0]}, want ${la}`);
    assert.ok(Math.abs(p[1] - lo) <= LON_TOL, `longitude of the ${rg} pin: got ${p[1]}, want ${lo}`);
  }
}

/* One answer that uses every tail field, with non-ASCII in each of them. */
const FULL = sampleAnswer({
  n: "Zo\u00eb",
  st: "Ikke uten vei om vinteren \u2014 no road in winter",
  wy: "Grow food together \u{1F332}\u{1F41D} and \u00e9t\u00e9 in the hills",
  ow: ["Kajakk p\u00e5 fjorden", "P\u00e9tanque", "\u{1F3BB} folk nights"],
  rg: [OFFLIST, "Pyrenees"],                     /* pick order is the reverse of REGIONS order */
  rw: "Sm\u00e5land, Sweden",
  cz: "Norsk / Fran\u00e7aise",
  lv: "Espa\u00f1a",
  tr: "must",
  cp: 7,
  rn: 7,
  pn: { [OFFLIST]: [57.0, 14.5], "Pyrenees": [42.96, 1.61] },
});

describe("harness", () => {
  test("every app name the suite relies on resolves in index.html", () => {
    const missing = EXPORTS.filter((n) => !app.has(n));
    assert.deepEqual(missing, [], `index.html no longer defines: ${missing.join(", ")}`);
  });

  test("the page booted into the home screen without touching a real DOM", () => {
    assert.equal(app.mode, "home");
    assert.match(app.dom.appHTML(), /id="start"/);
  });
});

describe("fixed-block layout", () => {
  test("C1/C2/C3 fixed block is 154 bits (20 bytes); C4 is 199 bits (25 bytes)", () => {
    assert.equal(app.BITS_CORE, BITS_CORE_EXPECTED);
    assert.equal(app.BITS_C4, BITS_C4_EXPECTED);
    assert.equal(app.NFIX(app.BITS_CORE), NFIX_CORE);
    assert.equal(app.NFIX(app.BITS_C4), NFIX_C4);
    assert.equal(NFIX_CORE, 20);
    assert.equal(NFIX_C4, 25);
  });

  test("every positionally-stored list is still in the order existing codes were written in", () => {
    /* Each of these travels as a POSITION. Reordering or inserting into any of them in
       place silently changes what every code already sent means. */
    const keys = (l) => l.map((x) => x[0]);
    assert.deepEqual(keys(app.STYLES), LAYOUT.styles, "STYLES");
    assert.deepEqual(keys(app.USES), LAYOUT.uses, "USES");
    assert.deepEqual(keys(app.HOUSE), LAYOUT.house, "HOUSE");
    assert.deepEqual(keys(app.HORIZON), LAYOUT.horizon, "HORIZON");
    assert.deepEqual(keys(app.SPEND), LAYOUT.spend, "SPEND");
    assert.deepEqual(keys(app.ALLACTS), LAYOUT.acts, "ALLACTS");
    assert.deepEqual(keys(app.TOL), LAYOUT.tol, "TOL");
    assert.deepEqual(keys(app.SKILLS), LAYOUT.skills, "SKILLS");
    assert.deepEqual(keys(app.TRIAL), LAYOUT.trial, "TRIAL");
    assert.deepEqual({ ...app.MAPWIN }, LAYOUT.mapwin, "MAPWIN is the pin quantisation range");
    assert.equal(app.PIN_STEPS, LAYOUT.pinSteps);
    /* The region mask of every C3 and C4 code is a bit index into REGIONS. CLAUDE.md: if the
       list ever has to change, freeze this one the way REGIONS_V2 is frozen, decode C3 and C4
       against the frozen copy, and add a C5 - never edit it in place. When that is done,
       point this line at the frozen copy. */
    assert.deepEqual([...app.REGIONS], [...REGIONS_C3],
      "REGIONS, which every C3 and C4 region pick is stored as a position in");
  });
});

describe("C4 roundtrip", () => {
  test("encode() always writes C4, for one answer and for a board of several", () => {
    for (const input of [FULL, sampleAnswer({ rg: [], pn: {} }), [FULL, sampleAnswer({ n: "Bo" })], {}]) {
      assert.equal(unbin64(encode(input)).charCodeAt(0), 4);
    }
  });

  test("a full answer comes back intact: every fixed field, regions, write-in, pins, trial year, both bands, all seven tail fields", () => {
    const got = decode(encode(FULL));
    assert.ok(!Array.isArray(got), "a single answer decodes to a single record");
    assertSameAnswer(got, FULL);
    /* spelled out as well, so a failure names the field that went */
    assert.equal(got.n, "Zo\u00eb");
    assert.equal(got.wy, FULL.wy, "emoji in why");
    assert.equal(got.rw, "Sm\u00e5land, Sweden");
    assert.equal(got.cz, "Norsk / Fran\u00e7aise");
    assert.equal(got.lv, "Espa\u00f1a");
    assert.equal(got.tr, "must");
    assert.equal(app.CAP[got.cp], app.CAP[7]);
    assert.equal(app.RUN[got.rn], app.RUN[7]);
  });

  test("the app's C4 bytes match the documented wire layout exactly", () => {
    /* The independent builder writes pins in REGIONS order, the order the mask decodes in. */
    for (const a of [FULL, sampleAnswer(), sampleAnswer({ rg: [VESTLAND], pn: { [VESTLAND]: [60.63, 6.42] } })]) {
      assert.equal(encode(a), buildCode(4, a));
    }
  });

  test("pins for two regions come back on the right regions when picked out of list order", () => {
    const a = sampleAnswer({
      n: "Bo",
      rg: ["Pyrenees", "Italian Alps"],          /* REGIONS order is Italian Alps, then Pyrenees */
      pn: { "Pyrenees": [42.96, 1.61], "Italian Alps": [46.07, 11.12] },
    });
    const got = decode(encode(a));
    assertPins(got.pn, a.pn);
    /* and the other way round, so a swap cannot hide behind a symmetric fixture */
    const b = sampleAnswer({
      n: "Bo",
      rg: [FRENCH_NOW, VESTLAND],
      pn: { [FRENCH_NOW]: [45.19, 5.72], [VESTLAND]: [61.23, 7.10] },
    });
    assertPins(decode(encode(b)).pn, b.pn);
  });

  test("a pin on only the second region stays on the second region", () => {
    const a = sampleAnswer({ rg: ["Italian Alps", "Pyrenees"], pn: { "Pyrenees": [43.23, 0.08] } });
    const got = decode(encode(a));
    assertPins(got.pn, { "Pyrenees": [43.23, 0.08] });
  });

  test("every band in CAP and RUN, and every band the form offers, comes back out of a code as the band that went in", () => {
    /* By label, over the whole of each array rather than a fixed 0..7, so a band appended
       past the eighth - which a 3-bit field cannot hold - shows up as the band it silently
       turns into, not just as a length. */
    for (const [name, bands, offer, key] of [["CAP", app.CAP, app.CAPOFFER, "cp"], ["RUN", app.RUN, app.RUNOFFER, "rn"]]) {
      const every = new Set([...bands.keys(), ...offer]);
      for (const i of every) {
        const got = decode(encode(sampleAnswer({ [key]: i })));
        assert.equal(got[key], i, `${name}[${i}] (${JSON.stringify(bands[i])}) went into a code and came back as ` +
          `${name}[${got[key]}] (${JSON.stringify(bands[got[key]])})`);
      }
    }
  });

  test("every capital and monthly band, including the two appended at the top, survives the 3-bit field", () => {
    for (let i = 0; i < 8; i++) {
      const got = decode(encode(sampleAnswer({ cp: i, rn: 7 - i })));
      assert.equal(got.cp, i, `capital band ${i}`);
      assert.equal(got.rn, 7 - i, `monthly band ${7 - i}`);
    }
  });

  test("an unanswered style or borrowing question comes back blank, not as the first option", () => {
    const got = decode(encode(sampleAnswer({ s: "", d: "" })));
    assert.equal(got.s, "");
    assert.equal(got.d, "");
  });

  test("a combined code carries several answers, in order", () => {
    const list = [FULL, sampleAnswer({ n: "Bo" }), sampleAnswer({ n: "Cato", rg: [] , pn: {} })];
    const got = decode(encode(list));
    assert.ok(Array.isArray(got));
    assert.deepEqual(got.map((x) => x.n), ["Zo\u00eb", "Bo", "Cato"]);
    assertSameAnswer(got[0], FULL);
  });
});

describe("older formats still decode", () => {
  test("a C3 code reports the regions picked and reads its tail from the shorter 20-byte block", () => {
    const rec = sampleAnswer({
      n: "Dag", rg: [VESTLAND, "Italian Alps"], pn: {}, tr: undefined,
      st: "Nothing yet", wy: "The fjords, and people to share them with",
      ow: ["Rowing"], rw: "", cz: "Dansk", lv: "Norge",
    });
    const code = buildCode(3, rec);
    assert.equal(unbin64(code).charCodeAt(0), 3, "fixture is a C3 code");
    const got = decode(code);
    assertSameAnswer(got, rec, { pins: false, trial: false });
    assert.deepEqual(got.rg, [VESTLAND, "Italian Alps"]);
    assert.equal(got.tr, app.TRIAL[0][0], "a C3 code has no trial answer: the default");
    assert.deepEqual(got.pn, {}, "a C3 code has no pins");

    /* Control: the same record read with the C4 width loses its tail. This is what the
       test above would see if the two formats ever shared one N_FIX. */
    const bytes = packRecord(3, rec);
    assert.notEqual(app.recRead(bytes, app.REGIONS, true).n, "Dag");
  });

  test("a C3 code with non-ASCII in every tail field reads back exactly", () => {
    const rec = sampleAnswer({
      n: "\u00c5se", rg: ["Pyrenees"], pn: {},
      st: "\u00c6rlig talt", wy: "\u{1F333} og \u00f8l", ow: ["Str\u00f8m"], rw: "",
      cz: "Svensk", lv: "\u00d6sterreich",
    });
    assertSameAnswer(decode(buildCode(3, rec)), rec, { pins: false, trial: false });
  });

  test("a C2 code decodes against the frozen eight-region list, not the live one", () => {
    const rec = sampleAnswer({
      n: "Eli", rg: [FRENCH_OLD, "Northern Germany & Denmark"], pn: {},
      tail: ["Eli", "A long commute", "Close to the sea", "Sailing"],   /* a four-field C2-era tail */
    });
    const code = buildCode(2, rec);
    assert.equal(unbin64(code).charCodeAt(0), 2, "fixture is a C2 code");
    const got = decode(code);
    /* bit 2 is "French Alps & Vercors" in REGIONS_V2 but "Italian Alps" in REGIONS */
    assert.deepEqual(got.rg, [FRENCH_OLD, "Northern Germany & Denmark"]);
    assert.equal(got.n, "Eli");
    assert.equal(got.st, "A long commute");
    assert.equal(got.wy, "Close to the sea");
    assert.deepEqual(got.ow, ["Sailing"]);
    assert.equal(got.rw, "");
    assert.equal(got.cz, "");
    assert.equal(got.lv, "");
    assert.equal(got.s, rec.s);
    assert.deepEqual(got.sp, rec.sp);
    assert.equal(got.cp, rec.cp);
    assert.equal(got.rn, rec.rn);
  });

  test("each single C2 region bit decodes to that position in REGIONS_V2", () => {
    REGIONS_V2_FROZEN.forEach((r, i) => {
      const got = decode(buildCode(2, sampleAnswer({ n: "Fen", rg: [r], pn: {} })));
      assert.deepEqual(got.rg, [r], `C2 bit ${i}`);
    });
  });

  test("each single C3 and C4 region bit decodes to that position in the list they were written against", () => {
    REGIONS_C3.forEach((r, i) => {
      for (const v of [3, 4]) {
        const got = decode(buildCode(v, sampleAnswer({ n: "Fen", rg: [r], pn: {} })));
        assert.deepEqual(got.rg, [r], `C${v} bit ${i}`);
      }
    });
  });

  test("a C1 code still decodes, regions read against the frozen list", () => {
    const rec = sampleAnswer({
      n: "Gro", s: "big", rg: ["Vosges & Alsace", "Pyrenees"],
      st: "Leaving my job", wy: "Mountains and a big kitchen", ow: ["Choir", "Bread oven"],
    });
    const got = decode(buildC1Code(rec));
    assert.ok(!Array.isArray(got));
    assert.equal(got.n, "Gro");
    assert.equal(got.s, "big");
    assert.deepEqual(got.rg, ["Vosges & Alsace", "Pyrenees"]);
    assert.equal(got.st, "Leaving my job");
    assert.equal(got.wy, "Mountains and a big kitchen");
    assert.deepEqual(got.ow, ["Choir", "Bread oven"]);
    for (const k of ["u", "hh", "hz", "cp", "rn", "d"]) assert.equal(got[k], rec[k], k);
    assert.deepEqual(got.sp, rec.sp);
    assert.deepEqual(got.a, rec.a);
    assert.deepEqual(got.t, rec.t);
    assert.deepEqual(got.sk, rec.sk);
  });

  test("a multi-line C1 code decodes to one record per line", () => {
    const got = decode(buildC1Code([sampleAnswer({ n: "Gro", rg: [] }), sampleAnswer({ n: "Hal", rg: [VESTLAND] })]));
    assert.ok(Array.isArray(got));
    assert.deepEqual(got.map((x) => x.n), ["Gro", "Hal"]);
    assert.deepEqual(got[1].rg, [VESTLAND]);
  });

  test("the raw JSON fallback still decodes, both a plain object and a list of C1 lines", () => {
    const obj = { n: "Ivo", s: "mix", sp: { land: 4, cheap: 4 }, a: { bees: 2 }, rg: ["Pyrenees"], wy: "Bees" };
    assert.deepEqual(decode(buildJsonCode(obj)), obj);
    const lines = [c1Line(sampleAnswer({ n: "Ivo", rg: [] })), c1Line(sampleAnswer({ n: "Jo", rg: [FRENCH_OLD] }))];
    const got = decode(buildJsonCode(lines));
    assert.deepEqual(got.map((x) => x.n), ["Ivo", "Jo"]);
    assert.deepEqual(got[1].rg, [FRENCH_OLD]);
  });

  test("an old code with fewer tail separators decodes with the missing fields as empty strings", () => {
    /* name only: no separators at all */
    const bare = decode(buildCode(3, sampleAnswer({ n: "Kai", rg: [], tail: ["Kai"] })));
    assert.equal(bare.n, "Kai");
    for (const k of ["st", "wy", "rw", "cz", "lv"]) assert.equal(bare[k], "", k);
    assert.deepEqual(bare.ow, []);
    /* a C3 code from before the region write-in: four fields */
    const four = decode(buildCode(3, sampleAnswer({ n: "Kai", rg: [OFFLIST], tail: ["Kai", "x", "y", "z"] })));
    assert.deepEqual([four.n, four.st, four.wy, four.ow, four.rw, four.cz, four.lv], ["Kai", "x", "y", ["z"], "", "", ""]);
    /* a C4 code from before passport and country: five fields */
    const five = decode(buildCode(4, sampleAnswer({ n: "Kai", rg: [OFFLIST], pn: {}, tail: ["Kai", "", "", "", "Jutland"] })));
    assert.equal(five.rw, "Jutland");
    assert.equal(five.cz, "");
    assert.equal(five.lv, "");
  });

  test("the split money bands still decode to exactly what an older code said", () => {
    const got = decode(buildCode(3, sampleAnswer({ n: "Liv", cp: app.CAPSPLIT, rn: app.RUNSPLIT, rg: [] })));
    assert.equal(got.cp, 4);
    assert.equal(got.rn, 3);
    assert.equal(app.CAP[got.cp], "Over \u20ac150k");
    assert.equal(app.RUN[got.rn], "Over \u20ac400");
  });
});

describe("regions", () => {
  test("REGIONS_V2 is exactly the frozen eight-item list", () => {
    assert.deepEqual([...app.REGIONS_V2], [
      "Vestland, Norway \u2014 the fjords",
      "German & Austrian northern Alps",
      "French Alps & Vercors",
      "Vosges & Alsace",
      "Ardennes & Eifel",
      "Pyrenees",
      "Northern Germany & Denmark",
      "Somewhere not on this list",
    ]);
  });

  test("RENAMED is applied at display time, never inside decode", () => {
    assert.equal(app.RENAMED[FRENCH_OLD], FRENCH_NOW);
    const c2 = decode(buildCode(2, sampleAnswer({ n: "Mo", rg: [FRENCH_OLD], pn: {} })));
    assert.deepEqual(c2.rg, [FRENCH_OLD], "C2 reports the name the person picked");
    const c1 = decode(buildC1Code(sampleAnswer({ n: "Mo", rg: [FRENCH_OLD] })));
    assert.deepEqual(c1.rg, [FRENCH_OLD], "C1 reports the name the person picked");
    assert.deepEqual(app.rgOf(c2), [FRENCH_NOW], "rgOf maps it for tallying");
    assert.equal(app.rgNow(FRENCH_OLD), FRENCH_NOW);
  });

  test("RETIRED is the four regions genuinely dropped, not the renamed one", () => {
    assert.deepEqual([...app.RETIRED].sort(), [
      "Ardennes & Eifel", "German & Austrian northern Alps", "Northern Germany & Denmark", "Vosges & Alsace",
    ]);
    const got = decode(buildCode(2, sampleAnswer({ n: "Nils", rg: ["Ardennes & Eifel"], pn: {} })));
    assert.deepEqual(got.rg, ["Ardennes & Eifel"], "a retired pick is still reported, not dropped");
  });
});

describe("money bands", () => {
  test("CAP and RUN each fit in three bits", () => {
    /* The assertion CLAUDE.md describes lives here. A ninth band needs a C5. */
    assert.ok(app.CAP.length <= 8, `CAP has ${app.CAP.length} bands; a 3-bit field holds 8`);
    assert.ok(app.RUN.length <= 8, `RUN has ${app.RUN.length} bands; a 3-bit field holds 8`);
  });

  test("existing bands are never redrawn in place (only ever appended)", () => {
    assert.deepEqual(app.CAP.slice(0, 8), [
      "Under \u20ac10k", "\u20ac10\u201330k", "\u20ac30\u201375k", "\u20ac75\u2013150k", "Over \u20ac150k",
      "Rather not say", "\u20ac150\u2013250k", "Over \u20ac250k",
    ]);
    assert.deepEqual(app.RUN.slice(0, 8), [
      "Under \u20ac50", "\u20ac50\u2013150", "\u20ac150\u2013400", "Over \u20ac400", "Not sure yet",
      "\u20ac400\u2013600", "\u20ac600\u2013900", "Over \u20ac900",
    ]);
  });

  test("CAPEUR and RUNEUR are index-aligned, null exactly where the answer is not a number", () => {
    for (const [name, bands, eur, blank] of [["CAP", app.CAP, app.CAPEUR, "Rather not say"], ["RUN", app.RUN, app.RUNEUR, "Not sure yet"]]) {
      assert.equal(eur.length, bands.length, `${name}EUR has one entry per ${name} band`);
      bands.forEach((label, i) => {
        if (label === blank) {
          assert.equal(eur[i], null, `${name}[${i}] "${label}" pools as no number`);
        } else {
          assert.ok(Array.isArray(eur[i]) && eur[i].length === 2, `${name}EUR[${i}] is a [lo, hi] range for "${label}"`);
          assert.ok(eur[i][0] < eur[i][1], `${name}EUR[${i}] runs low to high`);
        }
      });
    }
  });

  test("the retired split bands are kept for old codes and never offered again", () => {
    assert.equal(app.CAPSPLIT, 4);
    assert.equal(app.RUNSPLIT, 3);
    assert.equal(app.CAP[4], "Over \u20ac150k");
    assert.equal(app.RUN[3], "Over \u20ac400");
    for (const [name, bands, offer, split] of [["CAP", app.CAP, app.CAPOFFER, app.CAPSPLIT], ["RUN", app.RUN, app.RUNOFFER, app.RUNSPLIT]]) {
      offer.forEach((i) => assert.ok(Number.isInteger(i) && i >= 0 && i < bands.length, `${name}OFFER entry ${i} is a real band`));
      assert.equal(new Set(offer).size, offer.length, `${name}OFFER has no duplicates`);
      assert.ok(!offer.includes(split), `${name}OFFER does not offer the split band ${split}`);
      const everyOther = bands.map((_, i) => i).filter((i) => i !== split);
      assert.deepEqual([...offer].sort((a, b) => a - b), everyOther, `${name}OFFER offers every band but the split one`);
    }
  });
});

describe("transport: alphabet, hyphens, grouping", () => {
  test("the share-code base64 alphabet has no hyphen", () => {
    let all = "";
    for (let i = 0; i < 256; i++) all += String.fromCharCode(i);
    for (let r = 0; r < 3; r++) {
      const s = bin64(all.slice(r) + all.slice(0, r));
      assert.match(s, /^[A-Za-z0-9._]*$/);
      assert.ok(!s.includes("-"));
    }
    for (const a of [FULL, sampleAnswer(), [FULL, sampleAnswer({ n: "Bo" })]]) {
      assert.ok(!encode(a).includes("-"), "an encoded code contains no hyphen");
    }
  });

  test("a code with stray hyphens inserted, as WhatsApp does, still decodes to the same answer", () => {
    const code = encode(FULL);
    const want = decode(code);
    for (const every of [1, 7, 20, 33]) {
      assert.deepEqual(decode(insertHyphens(code, every)), want, `a hyphen every ${every} characters`);
    }
    assert.deepEqual(decode(insertHyphens(grp(code), 9)), want, "hyphens and grouping spaces together");
    /* a C3 code too - hyphen-stripping is in unbin64, shared by every binary format */
    const c3 = buildCode(3, sampleAnswer({ n: "Ola", rg: ["Pyrenees"], pn: {} }));
    assert.deepEqual(decode(insertHyphens(c3, 5)), decode(c3));
  });

  test("grp() puts a space every 20 characters and nowhere else", () => {
    assert.equal(grp("a".repeat(45)), "a".repeat(20) + " " + "a".repeat(20) + " " + "aaaaa");
    assert.equal(grp("b".repeat(40)), "b".repeat(20) + " " + "b".repeat(20), "no trailing space");
    assert.equal(grp("c".repeat(20)), "c".repeat(20));
    assert.equal(grp("short"), "short");
    const code = encode(FULL);
    const g = grp(code);
    assert.equal(g.replace(/ /g, ""), code);
    g.split(" ").forEach((chunk, i, arr) => {
      if (i < arr.length - 1) assert.equal(chunk.length, 20);
      else assert.ok(chunk.length >= 1 && chunk.length <= 20);
    });
  });

  test("a grouped code decodes", () => {
    assert.deepEqual(decode(grp(encode(FULL))), decode(encode(FULL)));
  });
});

describe("the board's paste handler", () => {
  test("a grouped code pasted as one blob imports as a single code", () => {
    const a = loadApp();
    const res = a.paste(grp(a.encode(sampleAnswer({ n: "Ada" }))));
    assert.equal(res.err, "");
    assert.equal(res.board.length, 1);
    assert.equal(res.board[0].n, "Ada");
    assert.equal(res.pending.length, 0);
  });

  test("a grouped code that a chat app wrapped onto several lines still imports as one", () => {
    const a = loadApp();
    const g = grp(a.encode(FULL));
    let k = 0;
    const wrapped = g.replace(/ /g, () => (k++ % 2 ? "\n" : " "));
    assert.ok(wrapped.includes("\n"), "fixture spans several lines");
    const res = a.paste(wrapped);
    assert.equal(res.board.length, 1);
    assertSameAnswer(res.board[0], FULL);
  });

  test("a shared link pasted whole imports its code", () => {
    const a = loadApp();
    const res = a.paste("https://example.invalid/Bergensers-commons/#c=" + a.encode(sampleAnswer({ n: "Bo" })));
    assert.deepEqual(res.board.map((x) => x.n), ["Bo"]);
  });

  test("two codes on two lines still import as two", () => {
    const a = loadApp();
    const raw = grp(a.encode(sampleAnswer({ n: "Ada" }))) + "\n" + grp(a.encode(sampleAnswer({ n: "Bo" })));
    const res = a.paste(raw);
    assert.deepEqual(res.board.map((x) => x.n), ["Ada", "Bo"]);
  });

  test("a truncated code adds nothing and says so", () => {
    const a = loadApp();
    const code = a.encode(sampleAnswer({ n: "Ada" }));
    const res = a.paste(grp(code.slice(0, -6)));
    assert.equal(res.board.length, 0);
    assert.notEqual(res.err, "", "the screen reports that nothing could be read");
  });
});

describe("strict unpacking", () => {
  const recs = [packRecord(4, sampleAnswer({ n: "Ada" })), packRecord(4, sampleAnswer({ n: "Bo" }))];
  const good = packRaw(4, recs);

  test("control: the well-formed pack reads as two records", () => {
    assert.deepEqual(unpackC4(good).map((x) => x.n), ["Ada", "Bo"]);
  });

  const bad = {
    "truncated by one byte": good.slice(0, -1),
    "truncated to the header": good.slice(0, 2),
    "count says three, two present": packRaw(4, recs, { count: 3 }),
    "count of zero": packRaw(4, recs, { count: 0 }),
    "record length shorter than the fixed block": packRaw(4, [recs[0].slice(0, NFIX_C4 - 1)]),
    "record length field shorter than the fixed block": packRaw(4, recs, { lengths: [NFIX_C4 - 1] }),
    "record length field past the end": packRaw(4, recs, { lengths: [undefined, recs[1].length + 1] }),
    "record length field too short, leaving bytes over": packRaw(4, recs, { lengths: [recs[0].length - 1] }),
    "one trailing byte": good + "\u0000",
    "trailing garbage": good + "garbage",
  };
  for (const [what, bin] of Object.entries(bad)) {
    test(`unpackRecs throws on ${what}, and so does decode()`, () => {
      assert.throws(() => unpackRecs(bin, app.REGIONS, true));
      assert.throws(() => unpackC4(bin));
      assert.throws(() => decode(b64bin(bin)), `decode() returned rows for a pack with ${what}`);
    });
  }

  test("a record shorter than its own version's fixed block is refused at every length, C4's 20 to 24 bytes included", () => {
    /* The five lengths from 20 to 24 are long enough for a C2/C3 record and too short for a
       C4 one. They are what an N_FIX shared across versions lets through: a C4 record whose
       pins, trial answer and name are simply missing, read back as an anonymous answer. */
    const full = {
      4: packRecord(4, sampleAnswer({ n: "Ada" })),
      3: packRecord(3, sampleAnswer({ n: "Ada", rg: [VESTLAND] })),
      2: packRecord(2, sampleAnswer({ n: "Ada", rg: [FRENCH_OLD] })),
    };
    const unpack = { 4: unpackC4, 3: unpackC3, 2: unpackC2 };
    for (const [v, nfix] of [[4, NFIX_C4], [3, NFIX_CORE], [2, NFIX_CORE]]) {
      for (let len = 0; len < nfix; len++) {
        const bin = packRaw(v, [full[v].slice(0, len)]);
        assert.throws(() => unpack[v](bin), `a ${len}-byte C${v} record was read (its fixed block is ${nfix})`);
        assert.throws(() => decode(b64bin(bin)), `decode() returned a row for a ${len}-byte C${v} record`);
      }
      /* control: exactly the fixed block, with an empty tail, is a real (nameless) record */
      assert.equal(unpack[v](packRaw(v, [full[v].slice(0, nfix)])).length, 1, `a bare ${nfix}-byte C${v} record reads`);
    }
  });

  test("the older widths are just as strict", () => {
    const r3 = packRecord(3, sampleAnswer({ n: "Cato", rg: [VESTLAND] }));
    const r2 = packRecord(2, sampleAnswer({ n: "Cato", rg: [FRENCH_OLD] }));
    assert.equal(unpackC3(packRaw(3, [r3])).length, 1);
    assert.equal(unpackC2(packRaw(2, [r2])).length, 1);
    assert.throws(() => unpackC3(packRaw(3, [r3]) + "x"));
    assert.throws(() => unpackC2(packRaw(2, [r2]) + "x"));
    assert.throws(() => unpackC3(packRaw(3, [r3.slice(0, NFIX_CORE - 1)])));
    assert.throws(() => unpackC2(packRaw(2, [r2], { count: 2 })));
  });

  test("a corrupted code never comes back as an anonymous row", () => {
    const code = encode([sampleAnswer({ n: "Ada" }), sampleAnswer({ n: "Bo" })]);
    for (const cut of [1, 3, 5, 9, 17]) {
      let got;
      try { got = decode(code.slice(0, -cut)); } catch (e) { continue; }
      for (const row of one(got)) {
        assert.ok(row && row.n, `a code missing its last ${cut} characters decoded to a row with no name`);
      }
    }
  });
});
