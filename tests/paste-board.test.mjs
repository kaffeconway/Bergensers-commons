/*
 * The collector's side of the app: pasting codes onto the board, and the board itself.
 * See CLAUDE.md: "No hyphen in the base64 alphabet", "Codes are displayed/copied in grouped
 * chunks", "The board", "Losing somebody's answers" and "Whose answers these are".
 *
 * Everything here drives the app's own handlers through the stub DOM in harness.mjs: the
 * "Add to the board" button, the clash screen's three buttons, the "keep both" form, the
 * board's remove / put-back / edit / clear / results buttons, and the entry points that
 * start a fresh identity. The stub's querySelectorAll finds nothing, so the per-row buttons
 * (data-rm, data-ed) and the resume screen's name buttons (data-nm) would never be wired;
 * rowButtons() below answers exactly those three selectors from the rendered markup, so the
 * app's real handlers are the ones being clicked. Nothing in index.html is replaced.
 *
 * Fixtures are invented first names only. This file is pure ASCII.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadApp, sampleAnswer, buildCode, buildC1Code, b64bin, packRecord, packRaw, insertHyphens }
  from "./harness.mjs";

/* One instance for building fixtures. Each test that touches state loads its own. */
const base = loadApp();
const { encode, decode, grp, unbin64, stateFrom, sameName, hasInitial } = base;

const BOARD = "commons:board";
const one = (v) => (Array.isArray(v) ? v : [v]);
const names = (list) => list.map((x) => x.n);
/* A decoded record, exactly as the board stores what a paste decoded. */
const rec = (overrides) => decode(encode(sampleAnswer(overrides)));
const codeFor = (overrides) => encode(sampleAnswer(overrides));

const ADA = rec({ n: "Ada", wy: "Room to grow things together" });
const ADA2 = rec({ n: "Ada", wy: "A second opinion", rg: ["Italian Alps"], pn: {}, cp: 2 });
const BO = rec({ n: "Bo", s: "big", rg: ["Pyrenees"], pn: {} });
const CATO = rec({ n: "Cato", s: "sep", rg: [], pn: {} });
const DAG = rec({ n: "Dag", s: "mix", rg: ["Italian Alps"], pn: {} });

function loadBoard(rows, opts = {}) {
  return loadApp(Object.assign({}, opts, {
    storage: Object.assign({ [BOARD]: JSON.stringify(rows) }, opts.storage || {}),
  }));
}
const html = (app) => app.dom.appHTML();
function click(app, id) {
  const el = app.dom.byId(id);
  assert.ok(el && typeof el.onclick === "function", `#${id} is on screen and wired`);
  return el.click();
}
const onScreen = (app, id) => new RegExp(`\\bid="${id}"`).test(html(app));
const isClash = (app) => ["rep", "both", "skip"].every((id) => onScreen(app, id)) && !onScreen(app, "tx");
const showBoard = (app) => { app.mode = "combine"; app.render(); };

/* The per-row buttons. Answers [data-rm], [data-ed] and [data-nm] from the markup the app
   just rendered, with elements the app then wires; click(attr, value) presses one. */
function rowButtons(app) {
  const doc = app.dom.document, El = app.dom.El, live = new Map();
  doc.querySelectorAll = (sel) => {
    const m = /^\[data-(rm|ed|nm)\]$/.exec(String(sel).trim());
    if (!m) return [];
    const attr = m[1], els = [];
    for (const mm of html(app).matchAll(new RegExp(`data-${attr}="([^"]*)"`, "g"))) {
      const el = new El("button");
      el.dataset[attr] = mm[1];
      el.attributes["data-" + attr] = mm[1];
      els.push(el);
    }
    live.set(attr, els);
    return els;
  };
  return {
    click(attr, value) {
      const el = (live.get(attr) || []).find((e) => e.dataset[attr] === String(value));
      assert.ok(el && typeof el.onclick === "function", `a [data-${attr}="${value}"] button is on screen and wired`);
      return el.onclick({ stopPropagation() {}, preventDefault() {}, target: el });
    },
  };
}
/* Storage that worked at boot and starts refusing writes now: a full quota mid-session. */
function breakStorage(app) {
  Object.defineProperty(app.storage, "setItem", {
    configurable: true, enumerable: false, writable: true,
    value() { const e = new Error("QuotaExceededError (stubbed)"); e.name = "QuotaExceededError"; throw e; },
  });
}
/* The text of the div holding the "put them back" button, or null. */
function undoOffer(app) {
  const m = /<div[^>]*>((?:(?!<\/div>)[\s\S])*\bid="undo"(?:(?!<\/div>)[\s\S])*)<\/div>/.exec(html(app));
  return m ? m[1] : null;
}
/* A deterministic generator, so a failure names an input that can be reproduced. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ======================================================================================= */

describe("pasting: one code is one submission, and the whole blob is tried first", () => {
  test("a grouped code pasted as one blob lands as exactly one submission, intact", () => {
    const a = loadApp();
    const code = codeFor({ n: "Ada", wy: "Bees, and a long table outside" });
    assert.ok(grp(code).includes(" "), "fixture is long enough to be grouped");
    const res = a.paste(grp(code));
    assert.equal(res.err, "");
    assert.equal(res.board.length, 1, "one submission, not one per group");
    assert.deepEqual(res.board[0], decode(code));
  });

  test("a combined code holding several answers, pasted grouped, lands as those answers in order", () => {
    const a = loadApp();
    const code = encode([sampleAnswer({ n: "Ada" }), sampleAnswer({ n: "Bo" }), sampleAnswer({ n: "Cato" })]);
    const res = a.paste(grp(code));
    assert.deepEqual(names(res.board), ["Ada", "Bo", "Cato"]);
    assert.deepEqual(res.board, decode(code));
  });

  test("whole blob first: a wrapped code whose middle line reads as a code on its own lands as the one code it is", () => {
    /* The raw-JSON fallback will read any 45 bytes of JSON with an "sp" key as an answer.
       Put exactly such bytes inside the "why" text, on a 15-byte boundary, so that three of
       the code's 20-character groups are their base64 - then wrap the code onto lines at
       those groups. Tried line by line, the middle line alone is a (phantom) answer named
       Fragment. Tried whole first, it is Ada's code and nothing else. */
    const JSON_BYTES = '{"n":"Fragment","sp":{"land":1}             }';
    assert.equal(JSON_BYTES.length, 45);
    let code = null, at = -1;
    for (let pad = 0; pad < 15 && code === null; pad++) {
      const c = codeFor({ n: "Ada", st: "Rough roads" + "!".repeat(pad), wy: JSON_BYTES + " and the rest of why" });
      const i = unbin64(c).indexOf(JSON_BYTES);
      if (i > 0 && i % 15 === 0) { code = c; at = i; }
    }
    assert.ok(code, "found a padding that puts the JSON on a group boundary");
    const g = grp(code).split(" "), k = at / 15;
    const lines = [g.slice(0, k).join(" "), g.slice(k, k + 3).join(" "), g.slice(k + 3).join(" ")];
    /* precondition: the fixture really does separate the two orders */
    const alone = one(decode(lines[1]));
    assert.equal(alone.length, 1);
    assert.equal(alone[0].n, "Fragment", "the middle line on its own decodes as an answer");

    const a = loadApp();
    const res = a.paste(lines.join("\n"));
    assert.deepEqual(names(res.board), ["Ada"], "no phantom row from the middle line");
    assert.deepEqual(res.board[0], decode(code));
  });

  test("several codes on separate lines land as several, in order, whatever format each is in", () => {
    const a = loadApp();
    const c3 = buildCode(3, sampleAnswer({ n: "Dag", rg: ["Pyrenees"], pn: {} }));
    const c1 = buildC1Code(sampleAnswer({ n: "Eli", rg: [] }));
    const raw = [
      "  " + grp(codeFor({ n: "Ada" })) + "  ",
      "",
      codeFor({ n: "Bo" }),
      "https://example.invalid/Bergensers-commons/#c=" + codeFor({ n: "Cato" }),
      c3,
      "",
      c1,
    ].join("\r\n");
    const res = a.paste(raw);
    assert.equal(res.err, "");
    assert.deepEqual(names(res.board), ["Ada", "Bo", "Cato", "Dag", "Eli"]);
    assert.deepEqual(res.board[3], decode(c3));
    assert.deepEqual(res.board[4], decode(c1));
  });

  test("pasting more later adds to the board and leaves the rows already there alone", () => {
    const a = loadBoard([ADA, BO]);
    const res = a.paste(grp(codeFor({ n: "Cato" })) + "\n" + grp(codeFor({ n: "Dag" })));
    assert.deepEqual(names(res.board), ["Ada", "Bo", "Cato", "Dag"]);
    assert.deepEqual(res.board.slice(0, 2), [ADA, BO]);
  });
});

describe("hyphens a chat app put in", () => {
  const code = codeFor({ n: "Ada", wy: "Winter light \u2014 and a kiln" });
  const want = decode(code);
  const variants = {
    "a hyphen every 7 characters": insertHyphens(code, 7),
    "a hyphen every 33 characters": insertHyphens(code, 33),
    "hyphens inside a grouped code": insertHyphens(grp(code), 9),
    "a hyphen and a line break at each wrap": code.replace(/(.{30})(?=.)/g, "$1-\n"),
    "a shared link with hyphens in its code":
      "https://example.invalid/Bergensers-commons/#c=" + insertHyphens(code, 11),
  };
  for (const [what, pasted] of Object.entries(variants)) {
    test(`a code with ${what} still lands as the one answer it was`, () => {
      assert.ok(pasted.includes("-"));
      const a = loadApp();
      const res = a.paste(pasted);
      assert.equal(res.err, "");
      assert.equal(res.board.length, 1);
      assert.deepEqual(res.board[0], want);
    });
  }
});

describe("garbage never becomes a row", () => {
  const good = codeFor({ n: "Bo" });
  const bin = unbin64(good);
  const g = grp(good).split(" ");
  const garbage = {
    "chat text": "Here is my code, sorry it took a while!",
    "one word": "hello",
    "only whitespace": "   \n\t  \n",
    "only hyphens": "----- - -",
    "a link with no code": "https://example.invalid/Bergensers-commons/",
    "a link with an empty code": "https://example.invalid/Bergensers-commons/#c=",
    "a code missing its last character": good.slice(0, -1),
    "a code missing its last six characters, grouped": grp(good.slice(0, -6)),
    "half a code": good.slice(0, Math.floor(good.length / 2)),
    "a grouped code with one group missing": g.slice(0, 2).concat(g.slice(3)).join(" "),
    "a code with a version byte nothing writes": b64bin(String.fromCharCode(9) + bin.slice(1)),
    "a code whose count byte says two, holding one": b64bin(packRaw(4, [packRecord(4, sampleAnswer({ n: "Bo" }))], { count: 2 })),
    "a code with trailing bytes": b64bin(bin + "\u0000\u0000\u0000"),
    /* long enough for a C2/C3 fixed block, five bytes short of a C4 one: only a C4-width
       length check refuses it, and without one it lands as a nameless row */
    "a C4 code whose record stops at the older 20-byte fixed block":
      b64bin(packRaw(4, [packRecord(4, sampleAnswer({ n: "Bo" })).slice(0, 20)])),
    "two codes run together with nothing between": good + codeFor({ n: "Cato" }),
  };
  for (const [what, pasted] of Object.entries(garbage)) {
    test(`${what}: adds nothing and says so`, () => {
      const a = loadBoard([ADA]);
      const before = a.storageData()[BOARD];
      const res = a.paste(pasted);
      assert.deepEqual(res.board, [ADA], "the board is exactly as it was");
      assert.equal(a.storageData()[BOARD], before, "nothing was written");
      assert.equal(res.pending.length, 0);
      assert.notEqual(res.err, "", "the screen says nothing could be read");
    });
  }

  test("three hundred seeded random pastes add nothing", () => {
    const r = rng(20260924);
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._";
    const pick = (s) => s[Math.floor(r() * s.length)];
    const inputs = [];
    for (let i = 0; i < 150; i++) {              /* text in the code alphabet, with the noise chats add */
      let s = "";
      const n = 1 + Math.floor(r() * 300);
      for (let j = 0; j < n; j++) s += r() < 0.06 ? pick(" \n-") : pick(ALPHA);
      inputs.push(s);
    }
    for (let i = 0; i < 150; i++) {              /* random bytes behind a real version byte, so the strict unpacker is what refuses them */
      let s = String.fromCharCode(2 + (i % 3));
      const n = 1 + Math.floor(r() * 120);
      for (let j = 0; j < n; j++) s += String.fromCharCode(Math.floor(r() * 256));
      inputs.push(i % 2 ? grp(b64bin(s)) : b64bin(s));
    }
    const a = loadBoard([ADA]);
    for (const s of inputs) {
      const res = a.paste(s);
      assert.deepEqual(res.board, [ADA], `this paste changed the board: ${JSON.stringify(s)}`);
    }
  });

  test("a paste mixing good codes with an unreadable line lands only the good ones, every one named", () => {
    const a = loadApp();
    const raw = [grp(codeFor({ n: "Ada" })), "Here is mine, sorry it is late", codeFor({ n: "Bo" }).slice(0, -5),
      codeFor({ n: "Cato" })].join("\n");
    const res = a.paste(raw);
    assert.deepEqual(names(res.board), ["Ada", "Cato"]);
    for (const row of res.board) assert.ok(row && row.n && row.sp, "no anonymous or empty row");
  });

  test("a paste with an unreadable line among good ones says that a line could not be read", () => {
    /* CLAUDE.md, "Whose answers these are": if an answer can't be carried forward, surface it.
       Wording-agnostic: the screen must not report this paste exactly as it reports the same
       good codes pasted cleanly, unless the unreadable text is kept on screen. */
    const ada = grp(codeFor({ n: "Ada" })), cato = codeFor({ n: "Cato" });
    const broken = codeFor({ n: "Bo" }).slice(0, -5);
    const clean = loadApp().paste([ada, cato].join("\n"));
    const a = loadApp();
    const mixed = a.paste([ada, broken, cato].join("\n"));
    assert.deepEqual(names(mixed.board), ["Ada", "Cato"]);
    const said = (r) => `${r.ok}|${r.err}`;
    assert.ok(said(mixed) !== said(clean) || html(a).includes(broken),
      `Bo's damaged code was dropped without a word: the screen said "${mixed.ok}" (err "${mixed.err}"), ` +
      `exactly what it says for a clean paste of the two good codes`);
  });
});

describe("a name already on the board is a question, not an instruction", () => {
  test("the code is held, and nothing is written until the collector picks", () => {
    const a = loadBoard([ADA, BO]);
    const before = a.storageData()[BOARD];
    const res = a.paste(codeFor({ n: "ADA", wy: "A second opinion" }));
    assert.deepEqual(res.board, [ADA, BO], "the row already there is untouched");
    assert.equal(a.storageData()[BOARD], before, "nothing was written to storage");
    assert.equal(res.pending.length, 1, "the pasted code is held");
    assert.equal(res.pending[0].inc.n, "ADA");
    assert.ok(isClash(a), "the collector is asked: replace, keep both, or skip");
    assert.match(html(a), /<h2>[^<]*ADA/);
  });

  test("a new name in the same paste lands straight away while the clash waits", () => {
    const a = loadBoard([ADA]);
    const res = a.paste(codeFor({ n: "Bo" }) + "\n" + codeFor({ n: "Ada", wy: "A second opinion" }));
    assert.deepEqual(res.board, [ADA, rec({ n: "Bo" })]);
    assert.deepEqual(res.pending.map((c) => c.inc.n), ["Ada"]);
  });

  test("replace: the row is replaced in place with the new answers, and nothing else moves", () => {
    const a = loadBoard([ADA, BO]);
    a.paste(encode(ADA2));
    click(a, "rep");
    assert.deepEqual(a.boardGet(), [ADA2, BO]);
    assert.equal(a.pend.length, 0);
    assert.equal(a.mode, "combine");
    assert.ok(onScreen(a, "tx"), "back on the board");
  });

  test("skip: the board is left exactly as it was and the code is dropped", () => {
    const a = loadBoard([ADA, BO]);
    const before = a.storageData()[BOARD];
    a.paste(encode(ADA2));
    click(a, "skip");
    assert.deepEqual(a.boardGet(), [ADA, BO]);
    assert.equal(a.storageData()[BOARD], before);
    assert.equal(a.pend.length, 0);
    assert.ok(onScreen(a, "tx"), "back on the board");
  });

  test("keep both: refused until both rows carry a last initial, and two different ones", () => {
    const a = loadBoard([ADA, BO]);
    a.paste(encode(ADA2));
    click(a, "both");
    assert.ok(onScreen(a, "n1") && onScreen(a, "n2") && onScreen(a, "save"), "the keep-both form is shown");
    assert.deepEqual(a.boardGet(), [ADA, BO], "choosing keep both writes nothing yet");
    const attempt = (v1, v2) => {
      a.dom.byId("n1").value = v1;
      a.dom.byId("n2").value = v2;
      const err = a.dom.byId("err");
      err.textContent = "";
      click(a, "save");
      return err.textContent;
    };
    for (const [v1, v2, why] of [
      ["Ada", "Ada B", "only the newcomer initialled"],
      ["Ada A", "Ada", "only the row already there initialled"],
      ["Ada ", "Ada ", "neither initialled"],
      ["Ada Bo", "Ada Ka", "two letters is not an initial"],
      ["Ada B", "ada b", "the same initial twice"],
      ["Ada  B", "Ada b", "the same initial, spaced differently"],
    ]) {
      const said = attempt(v1, v2);
      assert.notEqual(said, "", `refused with a reason: ${why}`);
      assert.deepEqual(a.boardGet(), [ADA, BO], `nothing written: ${why}`);
      assert.equal(a.pend.length, 1, `still held: ${why}`);
    }
    assert.equal(attempt("Ada A", "Ada B"), "");
    const b = a.boardGet();
    assert.deepEqual(names(b), ["Ada A", "Bo", "Ada B"]);
    assert.deepEqual(Object.assign({}, b[0], { n: "Ada" }), ADA, "the first Ada's answers are unchanged, only relabelled");
    assert.deepEqual(Object.assign({}, b[2], { n: "Ada" }), ADA2, "the newcomer's answers are exactly what was pasted");
    assert.equal(a.pend.length, 0);
  });

  test("keep both refuses two names that differ only by a full stop after the initial", () => {
    /* hasInitial accepts "Ada B." as well as "Ada B", so both pass the initial check - but a
       reader cannot tell "Ada B" from "Ada B." any better than from plain "Ada". */
    const a = loadBoard([ADA]);
    a.paste(encode(ADA2));
    click(a, "both");
    a.dom.byId("n1").value = "Ada B";
    a.dom.byId("n2").value = "Ada B.";
    click(a, "save");
    assert.deepEqual(names(a.boardGet()), ["Ada"], `"Ada B" and "Ada B." were accepted as two different people`);
  });

  test("several clashes are asked one at a time, in the order pasted", () => {
    const a = loadBoard([ADA, BO]);
    const BO2 = rec({ n: "Bo", wy: "Changed my mind", rg: [], pn: {} });
    const res = a.paste(encode(ADA2) + "\n" + encode(BO2));
    assert.equal(res.pending.length, 2);
    assert.match(html(a), /<h2>[^<]*Ada/);
    click(a, "skip");
    assert.ok(isClash(a), "the second clash follows");
    assert.match(html(a), /<h2>[^<]*Bo/);
    click(a, "rep");
    assert.deepEqual(a.boardGet(), [ADA, BO2]);
    assert.equal(a.pend.length, 0);
  });

  test("a clash whose row has moved is re-found by name, never written over whoever now has that index", () => {
    const a = loadBoard([CATO, ADA]);
    a.paste(encode(ADA2));
    assert.equal(a.pend[0].row, 1);
    a.boardSet([ADA, CATO]);                   /* the board changed underneath, e.g. in another tab */
    a.render();
    click(a, "rep");
    assert.deepEqual(a.boardGet(), [ADA2, CATO], "Cato, now at the old index, is untouched");
  });

  test("a clash whose row has gone lands the code rather than losing it", () => {
    const a = loadBoard([ADA]);
    a.paste(encode(ADA2));
    a.boardSet([]);
    a.render();
    assert.deepEqual(a.boardGet(), [ADA2]);
    assert.equal(a.pend.length, 0);
  });

  test("a shared link whose name is on the board is held the same way; a new name lands", () => {
    const held = loadBoard([ADA], { hash: "#c=" + encode(ADA2) });
    assert.equal(held.mode, "incoming");
    click(held, "addb");
    assert.deepEqual(held.boardGet(), [ADA]);
    assert.equal(held.pend.length, 1);
    assert.ok(isClash(held));

    const fresh = loadBoard([ADA], { hash: "#c=" + encode(BO) });
    click(fresh, "addb");
    assert.deepEqual(fresh.boardGet(), [ADA, BO]);
    assert.equal(fresh.pend.length, 0);
  });

  test("two codes with the same name in one paste do not both land as that name unasked", () => {
    /* Neither name is on the board before the paste, so nameSplit (which checks only the
       board) passes both as fresh, and the board ends with two rows called plain "Ada" -
       the state keep-both exists to prevent. A corrected resend pasted alongside the
       original lands as a duplicate the same way. */
    const a = loadApp();
    const res = a.paste(encode(ADA) + "\n" + encode(ADA2));
    const rows = res.board;
    const dupes = rows.filter((x, i) => rows.some((y, j) => j < i && sameName(x.n, y.n)));
    assert.deepEqual(names(dupes), [], `two rows share a name without the collector choosing: ${JSON.stringify(names(rows))}`);
    assert.equal(rows.length + res.pending.length, 2, "both codes are accounted for, on the board or held");
  });

  test("a name that differs from a row only in its spacing is held like any other clash", () => {
    /* nameSplit compares lowercased, trimmed names; sameName (used by the clash screen, the
       keep-both check and a board rename) also collapses inner spaces. A browser draws
       "Ada  B" and "Ada B" identically. */
    const a = loadBoard([rec({ n: "Ada B" })]);
    const res = a.paste(codeFor({ n: "Ada  B" }));
    assert.equal(res.board.length, 1, `both landed: ${JSON.stringify(names(res.board))}`);
    assert.equal(res.pending.length, 1);
  });
});

describe("hasInitial and sameName", () => {
  test("hasInitial: a name, whitespace, then one letter (a full stop after it is allowed)", () => {
    for (const n of ["Ada B", "Ada B.", "Ada   b", " Ada B ", "Mary Ann K", "Bo C"]) {
      assert.equal(hasInitial(n), true, JSON.stringify(n));
    }
    for (const n of ["", "Ada", "Ada ", "AdaB", "Ada Bo", "Ada B.C", "Ada 7", "Ada -", "B", " B", null, undefined]) {
      assert.equal(hasInitial(n), false, JSON.stringify(n));
    }
  });

  test("hasInitial counts a letter outside A-Z as a letter", () => {
    /* "a name, a space and one letter". Norwegian surnames start with \u00d8, \u00c5, \u00c6. */
    for (const n of ["Ivo \u00d8", "Ada \u00c5", "Ada \u00c6.", "Zo\u00eb \u00c9"]) {
      assert.equal(hasInitial(n), true, `refused ${JSON.stringify(n)} as having no initial`);
    }
  });

  test("sameName ignores case and surrounding or repeated whitespace, and nothing else", () => {
    assert.equal(sameName("Ada", "ada"), true);
    assert.equal(sameName("  Ada  B ", "ada b"), true);
    assert.equal(sameName("Ada\tB", "Ada B"), true);
    assert.equal(sameName("Ada A", "Ada B"), false);
    assert.equal(sameName("Ada", "Ada B"), false);
    assert.equal(sameName("Ada", "Ida"), false);
  });
});

describe("removing a row, and putting it back", () => {
  const setup = () => {
    const a = loadBoard([ADA, BO, CATO]);
    const rows = rowButtons(a);
    showBoard(a);
    return { a, rows };
  };

  test("a removed row is offered back by name, and goes back where it was", () => {
    const { a, rows } = setup();
    rows.click("rm", 1);
    assert.deepEqual(a.boardGet(), [ADA, CATO]);
    const offer = undoOffer(a);
    assert.ok(offer, "a put-back offer is on screen");
    assert.match(offer, /\bBo\b/, "it names who was removed");
    click(a, "undo");
    assert.deepEqual(a.boardGet(), [ADA, BO, CATO]);
    assert.equal(a.undoRow, null);
    assert.equal(undoOffer(a), null, "the offer is gone once used");
  });

  test("the offer holds the last row removed", () => {
    const { a, rows } = setup();
    rows.click("rm", 1);
    rows.click("rm", 1);                       /* Cato, now at index 1 */
    assert.deepEqual(a.boardGet(), [ADA]);
    assert.match(undoOffer(a), /\bCato\b/);
    click(a, "undo");
    assert.deepEqual(a.boardGet(), [ADA, CATO]);
  });

  test("put back at min(at, length) when the board has shrunk since", () => {
    const { a, rows } = setup();
    rows.click("rm", 2);                       /* Cato, from the end */
    a.boardSet([ADA]);                         /* Bo removed elsewhere meanwhile */
    click(a, "undo");
    const b = a.boardGet();
    assert.deepEqual(b, [ADA, CATO], "reinserted at the end, not at a slot that no longer exists");
    assert.ok(b.every((x) => x && x.n), "no hole in the board");
  });

  const actions = {
    "leaving the board": (a) => click(a, "hm"),
    "pasting a code": (a) => { a.dom.byId("tx").value = codeFor({ n: "Dag" }); click(a, "add"); },
    "editing a row": (a, rows) => rows.click("ed", 0),
    "tapping Clear the board": (a) => click(a, "clr"),
    "going to the results": (a) => {
      const go = a.dom.byId("go");
      assert.ok(go && typeof go.onclick === "function", "#go is on screen and wired");
      /* Drawing the results page belongs to its own tests; this one is about the offer only,
         so a fault in the charts must not show up here as a fault in the board. */
      try { go.click(); } catch (e) { /* see above */ }
    },
  };
  for (const [what, act] of Object.entries(actions)) {
    test(`the offer lapses on the next action: ${what}`, () => {
      const { a, rows } = setup();
      rows.click("rm", 1);
      assert.ok(a.undoRow, "offer made");
      act(a, rows);
      assert.equal(a.undoRow, null, "the offer is withdrawn");
      showBoard(a);
      assert.equal(undoOffer(a), null, "and is not shown when the board is next drawn");
    });
  }

  const stale = {
    "a paste that could not be read": (a) => { a.dom.byId("tx").value = "not a code at all"; click(a, "add"); },
    "the first tap of Clear the board": (a) => click(a, "clr"),
  };
  for (const [what, act] of Object.entries(stale)) {
    test(`a put-back button still on screen after ${what} still puts the row back`, () => {
      /* CLAUDE.md: the offer lapses on the next action "so it is never a stale button over a
         board that has moved on". Both of these withdraw the offer without redrawing the
         screen, so the button stays, and tapping it silently does nothing. */
      const { a, rows } = setup();
      rows.click("rm", 1);
      act(a, rows);
      if (!onScreen(a, "undo")) return;       /* offer withdrawn from the screen: fine */
      click(a, "undo");
      assert.deepEqual(names(a.boardGet()), ["Ada", "Bo", "Cato"],
        `"Put them back" was still on screen and was tapped, but Bo was not put back`);
    });
  }
});

describe("storage that refuses to save", () => {
  test("a working device: no warning, and the screens say answers are saved", () => {
    const a = loadApp();
    assert.equal(a.lsFailed, false);
    assert.equal(a.storeWarn(), "");
    showBoard(a);
    assert.match(html(a), /saved on this device/i);
    assert.ok(!/class="warn"/.test(html(a)));
  });

  test("storage refusing from the start: flagged at boot, the board still works in memory, and no screen promises saving", () => {
    const ok = loadApp(), a = loadApp({ storageFails: true });
    assert.equal(a.lsFailed, true);
    const res = a.paste(codeFor({ n: "Ada" }));
    assert.deepEqual(names(res.board), ["Ada"], "the board works for this tab");
    assert.equal(a.storageData()[BOARD], undefined, "nothing reached storage");
    const warn = a.storeWarn();
    assert.notEqual(warn, "");

    showBoard(ok); showBoard(a);
    assert.match(html(ok), /saved on this device/i, "control: the working board claims it is saved");
    assert.ok(html(a).includes(warn), "the board shows the warning");
    assert.ok(!/saved on this device/i.test(html(a)), "the board does not claim to be saved");

    ok.mode = "home"; ok.render(); a.mode = "home"; a.render();
    assert.match(html(ok), /saves as you go/i, "control: the working home screen promises saving");
    assert.ok(html(a).includes(warn), "home shows the warning");
    assert.ok(!/saves as you go/i.test(html(a)), "home does not promise saving");

    for (const x of [ok, a]) { x.S = x.stateFrom(ADA); x.mode = "done"; x.render(); }
    assert.match(html(ok), /Saved on this device/, "control: the working code screen claims it is saved");
    assert.ok(!/Saved on this device|Saved straight back/.test(html(a)), "the code screen drops its claim");
    assert.match(html(a), /class="warn"/, "and warns instead");
  });

  test("a write failing mid-session sets lsFailed, keeps the value in memory, and the board starts warning", () => {
    const a = loadApp();
    assert.equal(a.lsFailed, false);
    breakStorage(a);
    assert.doesNotThrow(() => a.lsSet("probe-key", "kept"));
    assert.equal(a.lsFailed, true);
    assert.equal(a.lsGet("probe-key"), "kept");
    assert.notEqual(a.storeWarn(), "");
    showBoard(a);
    assert.ok(html(a).includes(a.storeWarn()));
  });

  test("after storage starts refusing mid-session, the board still shows and packs what was pasted since", () => {
    /* lsGet reads storage before memory, so once a key has been saved successfully, every
       later write that falls back to memory is shadowed by the stale stored copy. */
    const a = loadBoard([ADA]);
    breakStorage(a);
    const res = a.paste(codeFor({ n: "Bo" }));
    assert.equal(a.lsFailed, true);
    assert.deepEqual(names(res.board), ["Ada", "Bo"],
      `Bo was pasted after storage failed; the board reads ${JSON.stringify(names(res.board))} and said "${res.ok}"`);
    assert.deepEqual(names(one(decode(a.packBoard()))), ["Ada", "Bo"],
      "the combined code the warning tells the collector to copy carries Bo");
  });
});

describe("editing a row of the board", () => {
  const openRow = (rows0, i) => {
    const a = loadBoard(rows0);
    const rows = rowButtons(a);
    showBoard(a);
    rows.click("ed", i);
    return a;
  };

  test("tapping a name opens that row, bound to it by index and name", () => {
    const a = openRow([ADA, BO], 1);
    assert.equal(a.mode, "review");
    assert.equal(a.boardEdit, 1);
    assert.equal(a.boardEditKey, "bo");
    assert.deepEqual(a.S, stateFrom(BO));
  });

  test("an edit is written back to that row, nowhere else, and the binding follows a rename", () => {
    const a = openRow([ADA, BO], 1);
    a.S.why = "Changed on the board";
    a.autosave();
    let b = a.boardGet();
    assert.deepEqual(b[0], ADA, "the other row is untouched");
    assert.equal(b[1].n, "Bo");
    assert.equal(b[1].wy, "Changed on the board");
    assert.equal(a.storageData()["commons:bo"], undefined, "no personal draft was written");

    assert.equal(a.setName("Bo K"), null);
    a.autosave();
    assert.equal(a.boardEditKey, "bo k");
    a.S.why = "And again";
    a.autosave();
    b = a.boardGet();
    assert.deepEqual(names(b), ["Ada", "Bo K"]);
    assert.equal(b[1].wy, "And again");
    assert.equal(b.length, 2);
  });

  test("if the row is removed underneath the edit, the work falls back to a draft", () => {
    const a = openRow([ADA, BO], 1);
    a.boardSet([ADA]);
    a.S.why = "Keep this";
    a.autosave();
    assert.deepEqual(a.boardGet(), [ADA], "the board is not written");
    assert.equal(a.boardEdit, -1, "the binding is dropped");
    const draft = JSON.parse(a.storageData()["commons:bo"] || "null");
    assert.ok(draft, "the edit is saved as a draft");
    assert.equal(draft.why, "Keep this");
  });

  test("if somebody else now has that row, they are not overwritten", () => {
    const a = openRow([ADA, BO], 1);
    a.boardSet([BO, CATO]);                    /* Ada removed elsewhere: Cato now sits at index 1 */
    a.S.why = "Keep this";
    a.autosave();
    assert.deepEqual(a.boardGet(), [BO, CATO], "Cato's answers are untouched, and so are Bo's");
    assert.equal(a.boardEdit, -1);
    assert.equal(JSON.parse(a.storageData()["commons:bo"]).why, "Keep this");
  });

  test("renaming a board row onto another row's name is refused", () => {
    const a = openRow([ADA, BO], 1);
    assert.notEqual(a.setName("  ADA "), null);
    assert.equal(a.S.n, "Bo");
    a.autosave();
    assert.deepEqual(a.boardGet(), [ADA, BO]);
  });

  test("every way of starting a fresh identity drops the binding", () => {
    const bound = (a) => { a.boardEdit = 1; a.boardEditKey = "bo"; };
    const cleared = (a, how) => {
      assert.equal(a.boardEdit, -1, `${how}: boardEdit cleared`);
      assert.equal(a.boardEditKey, "", `${how}: boardEditKey cleared`);
    };
    let a = loadBoard([ADA, BO]);
    bound(a); a.mode = "home"; a.render(); click(a, "start");
    cleared(a, "Start building");

    a = loadBoard([ADA, BO]);
    a.S = stateFrom(BO); bound(a); a.mode = "build"; a.step = 1; a.render(); click(a, "notyou");
    cleared(a, "Back to the board");
    assert.equal(a.mode, "combine");

    a = loadBoard([ADA, BO], { storage: { "commons:cato": JSON.stringify(stateFrom(CATO)) } });
    const rows = rowButtons(a);
    bound(a); a.mode = "resume"; a.render(); rows.click("nm", "Cato");
    cleared(a, "Open or edit mine");
    assert.equal(a.S.n, "Cato");

    for (const id of ["mine", "hmx"]) {
      a = loadBoard([ADA, BO], { hash: "#c=" + encode(DAG) });
      bound(a); a.render(); click(a, id);
      cleared(a, `a shared link's #${id}`);
    }

    a = loadBoard([ADA, BO]);
    a.S = stateFrom(BO); bound(a); a.mode = "done"; a.render(); click(a, "comb");
    cleared(a, "Combine codes from the code screen");
  });
});

describe("a shared link", () => {
  test("changing an answer after the code screen takes the older code out of the address", () => {
    const a = loadApp();
    a.S = stateFrom(rec({ n: "Ada", wy: "First thoughts" }));
    a.mode = "done";
    a.render();
    assert.match(a.location.hash, /^#c=/, "the code screen put the code in the address");
    a.mode = "review";
    a.S.why = "Second thoughts";
    a.autosave();
    assert.equal(a.location.hash, "", "the address still held the older code after an answer changed");
  });

  test("reloading on an older code's address does not overwrite answers saved since", () => {
    /* The code screen writes "#c=<code>" into the address bar. Going back to change an
       answer autosaves a newer draft but leaves that address in place, so a reload - which a
       phone does to a background tab on its own - boots from the older code. boot() then
       calls autosave() on it before anyone has chosen anything, writing the older answers
       over the newer draft under the same name. Opening anyone's link with the same first
       name does the same, even if they then press "Ignore it, start fresh". */
    const a = loadApp();
    a.S = stateFrom(rec({ n: "Ada", wy: "First thoughts" }));
    a.mode = "done";
    a.render();
    const calls = a.history.calls;
    const address = calls.length ? calls[calls.length - 1][2] : "";
    assert.match(address, /^#c=/, "the code screen put the code in the address");

    a.S.why = "Second thoughts";               /* changed from "Check or change my answers" */
    a.autosave();
    const saved = a.storageData();
    assert.equal(JSON.parse(saved["commons:ada"]).why, "Second thoughts");

    const reloaded = loadApp({ hash: address, storage: saved });
    assert.equal(reloaded.mode, "incoming");
    assert.equal(JSON.parse(reloaded.storage.getItem("commons:ada")).why, "Second thoughts",
      "the newer saved answers were overwritten by the older code in the address bar");
  });
});
