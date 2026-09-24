/*
 * tests/harness.mjs - loads the app out of index.html so Node can test it.
 *
 * HOW IT WORKS
 *
 *   index.html is one self-contained page with one inline <script>. This file reads the
 *   page, pulls out the inline script text, and evaluates it with `new Function(...)`
 *   inside a small fake browser: a stub `document` (just enough for render() to write
 *   innerHTML and wire onclick handlers), `window`, `localStorage`, `navigator`,
 *   `location`, `history`, an `Image` that never loads, and a `fetch` that always
 *   rejects, so the map stays on its hand-drawn fallback outline and no test touches the
 *   network. The script runs exactly as it would in a browser, including its boot() at
 *   the bottom, which paints the home screen into the stub.
 *
 *   The script is never edited. Its top-level `const`, `let` and `function` bindings are
 *   reached by name through a direct eval() appended after the script, inside the same
 *   function scope, so the names the tests use are the app's own names and nothing here
 *   has to be kept in step with it. A name that does not exist reads as `undefined` rather
 *   than crashing the harness, so a renamed function fails the test that uses it, not
 *   every test in the suite.
 *
 *   Every call to loadApp() evaluates the script afresh, with fresh storage and a fresh
 *   stub DOM, so tests never share state unless they share an instance.
 *
 * WHICH FILE
 *
 *   The app is read from process.env.INDEX_HTML when that is set (resolved against the
 *   current working directory), otherwise from index.html at the repo root, next to this
 *   tests/ folder. So the same suite can be pointed at a deliberately broken copy:
 *
 *       INDEX_HTML=/tmp/mutant.html node --test "tests/*.test.mjs"
 *
 * WHAT IT EXPORTS
 *
 *   INDEX_PATH, REPO_ROOT          where the app was read from, and the repo root
 *   readIndexHtml(), readIndexBytes(), extractScripts(html), readScript()
 *                                  the raw page, its bytes, and its inline script text
 *   loadApp(opts)                  a fresh app instance (see below)
 *   EXPORTS                        the app names the suite relies on; codec.test.mjs checks
 *                                  every one of them resolves
 *   LAYOUT, REGIONS_V2_FROZEN, REGIONS_C3
 *                                  the field order every C2/C3/C4 code was written with,
 *                                  written out literally, independent of the app
 *   packRecord, packRecords, packRaw, buildCode, buildC1Code, c1Line, buildJsonCode,
 *   b64bin, b64utf8, utf8bin, insertHyphens
 *                                  an independent encoder for the old formats, for building
 *                                  C1/C2/C3 (and C4) codes the way older copies of the page
 *                                  wrote them
 *   sampleAnswer(overrides)        a complete, invented answer in the shape encode() takes
 *
 * THE APP INSTANCE
 *
 *   const app = loadApp();
 *   const { encode, decode, REGIONS } = app;  // any top-level name in the script
 *   app.get("lsFailed"); app.set("codes", [...]);    // live read / write of a binding
 *   app.codes = [...];                               // same, via the proxy
 *   app.paste(raw)       drives the board's real "Add to the board" handler with `raw`
 *                        in the paste box, and reports what the screen said
 *   app.dom              the stub DOM: byId(id), appHTML(), body, reset()
 *   app.storage          the stub localStorage; app.storageData() is a plain copy of it
 *   app.html / app.script / app.path   the page, its script text, where it came from
 *
 *   loadApp options:
 *     hash:         location.hash at boot, e.g. "#c=" + code, to exercise the shared-link path
 *     storage:      initial localStorage contents, as a plain object of strings
 *     storageFails: true makes every localStorage write throw (private browsing, full quota)
 *     fetch:        replacement fetch (default: always rejects)
 *
 * Fixtures use invented first names only. Every file in this repo is on the public web.
 * This file is pure ASCII; non-ASCII test text is written as \u escapes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INDEX_PATH = process.env.INDEX_HTML
  ? path.resolve(process.cwd(), process.env.INDEX_HTML)
  : path.join(REPO_ROOT, "index.html");

/* ------------------------------------------------------------------ reading the page */

const cache = new Map();
export function readIndexBytes(p = INDEX_PATH) {
  return readFileSync(p);
}
export function readIndexHtml(p = INDEX_PATH) {
  if (!cache.has(p)) cache.set(p, readFileSync(p, "utf8"));
  return cache.get(p);
}
/* Inline, JavaScript-typed <script> blocks only (no src=, no JSON/template types). */
export function extractScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text|application)\/(java|ecma)script$|^module$/i.test(type)) continue;
    out.push(m[2]);
  }
  return out;
}
export function readScript(p = INDEX_PATH) {
  const scripts = extractScripts(readIndexHtml(p));
  if (!scripts.length) throw new Error(`no inline <script> found in ${p}`);
  return scripts.join("\n;\n");
}

/* The app names the suite relies on. codec.test.mjs asserts every one resolves, so a
   rename in index.html shows up as one clear failure. */
export const EXPORTS = [
  // codec
  "encode", "decode", "packC4", "recBin", "recRead", "unpackRecs", "unpackC2", "unpackC3",
  "unpackC4", "bin64", "unbin64", "b64", "unb64", "enc", "dec", "packOne", "unpackOne",
  "grp", "cut", "U8", "uU8", "BW", "BR", "wPin", "rPin", "rgPicks", "NFIX", "BITS_CORE",
  "BITS_C4", "PIN_BITS", "PIN_STEPS", "payload", "stateFrom", "blank",
  // content
  "REGIONS", "REGIONS_V2", "RENAMED", "RETIRED", "OFFLIST", "rgNow", "rgOf", "CAP", "RUN",
  "CAPEUR", "RUNEUR", "CAPOFFER", "RUNOFFER", "CAPSPLIT", "RUNSPLIT", "STYLES", "USES",
  "HOUSE", "HORIZON", "SPEND", "ACTS", "ALLACTS", "TOL", "SKILLS", "TRIAL", "BANK",
  // maps and charts
  "MAPWIN", "RCWIN", "RCTOWN", "SUBAREA", "subArea", "allPins", "kmApart", "insetFit",
  "pinSVG", "MAPLAB", "RCPOS", "SHORT", "mapSVG", "MPX", "mproj", "MW", "MH", "MAPGEO",
  "FALLBACK", "TRI", "TRIW", "TRIH", "TRIA", "TRIB", "TRIC", "triSVG",
  // board and storage
  "nameSplit", "hasInitial", "sameName", "INITIAL", "boardGet", "boardSet",
  "boardAppend", "lsSet", "lsGet", "lsKeys", "lsFailed", "storeWarn", "BOARD",
  // screens
  "render", "combine", "result", "home", "esc",
];

/* ------------------------------------------------------------------ the fake browser */

function makeStorage(initial, fails) {
  /* Methods on the prototype, items as own enumerable properties, so Object.keys(storage)
     lists the stored keys the way it does on a real Storage object (lsKeys relies on it). */
  const proto = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
    setItem(k, v) {
      if (fails) { const e = new Error("QuotaExceededError (stubbed)"); e.name = "QuotaExceededError"; throw e; }
      this[String(k)] = String(v);
    },
    removeItem(k) {
      if (fails) { const e = new Error("SecurityError (stubbed)"); e.name = "SecurityError"; throw e; }
      delete this[String(k)];
    },
    clear() { for (const k of Object.keys(this)) delete this[k]; },
    key(i) { return Object.keys(this)[i] ?? null; },
  };
  Object.defineProperty(proto, "length", { get() { return Object.keys(this).length; } });
  const s = Object.create(proto);
  for (const [k, v] of Object.entries(initial || {})) s[k] = String(v);
  return s;
}

function makeDom() {
  const found = new Map();        // id -> element found inside some root's innerHTML
  const roots = new Set();        // elements whose innerHTML may contain ids
  const noop = () => {};
  class El {
    constructor(tag, id) {
      this.tagName = String(tag || "div").toUpperCase();
      this._html = "";
      this.textContent = "";
      this.value = "";
      this.id = id || "";
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.children = [];
      this.open = false;
      this.disabled = false;
      this.onclick = null;
      this._root = null;
      const cls = new Set();
      this.classList = {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
        contains: (c) => cls.has(c),
      };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
      this._html = String(v);
      roots.add(this);
      /* a new screen: every element found inside the old markup is gone */
      for (const [id, el] of found) if (el._root === this) found.delete(id);
    }
    get outerHTML() { return this._html; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(c) { this.children.push(c); if (c && c._html !== undefined) roots.add(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); roots.delete(c); return c; }
    remove() { roots.delete(this); }
    click() { if (typeof this.onclick === "function") return this.onclick({ stopPropagation: noop, preventDefault: noop, target: this }); }
    focus() {} blur() {} select() {} scrollIntoView() {}
    addEventListener() {} removeEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    getContext() { return null; }
    toDataURL() { return ""; }
  }
  const body = new El("body");
  const appEl = new El("div", "app");
  const idAttr = (id) => new RegExp(`\\bid\\s*=\\s*(["'])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`);
  const byId = (id) => {
    id = String(id);
    if (id === "app") return appEl;
    if (found.has(id)) return found.get(id);
    for (const c of body.children) if (c && c.id === id) return c;
    const re = idAttr(id);
    for (const r of roots) {
      if (r._html && re.test(r._html)) {
        const el = new El("div", id);
        el._root = r;
        found.set(id, el);
        return el;
      }
    }
    return null;
  };
  const document = {
    body,
    documentElement: new El("html"),
    activeElement: null,
    title: "",
    getElementById: byId,
    createElement: (t) => new El(t),
    createRange: () => ({ selectNodeContents: noop, selectNode: noop }),
    execCommand: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
  };
  return {
    document,
    body,
    El,
    byId,
    appHTML: () => appEl._html,
    reset() { found.clear(); },
  };
}

const PARAMS = ["document", "window", "localStorage", "navigator", "location", "history", "fetch",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "cancelAnimationFrame", "getSelection", "Image", "alert", "confirm"];
const IDENT = /^[A-Za-z_$][\w$]*$/;

export function loadApp(opts = {}) {
  const file = opts.path || INDEX_PATH;
  const html = readIndexHtml(file);
  const script = readScript(file);
  const dom = makeDom();
  const storage = makeStorage(opts.storage, !!opts.storageFails);
  const hash = opts.hash || "";
  const location = {
    hash, search: "", pathname: "/index.html",
    href: "file:///index.html" + hash, origin: "null", protocol: "file:",
  };
  const history = { calls: [], replaceState(...a) { this.calls.push(a); }, pushState(...a) { this.calls.push(a); } };
  const navigator = { userAgent: "node-test", language: "en", clipboard: { writeText: async () => {} } };
  /* timers are unref'd so a pending say() or poster timeout never holds the process open */
  const setT = (f, ms, ...a) => { const t = setTimeout(f, ms, ...a); if (t && t.unref) t.unref(); return t; };
  const setI = (f, ms, ...a) => { const t = setInterval(f, ms, ...a); if (t && t.unref) t.unref(); return t; };
  class Image {
    set src(v) { this._src = v; queueMicrotask(() => { if (typeof this.onerror === "function") this.onerror(new Error("no images in tests")); }); }
    get src() { return this._src; }
  }
  const fetchStub = opts.fetch || (() => Promise.reject(new Error("network disabled in tests")));
  const window = {
    document: dom.document, localStorage: storage, navigator, location, history,
    scrollY: 0, innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    scrollTo() {}, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    fetch: fetchStub,
  };
  window.window = window;
  const args = [dom.document, window, storage, navigator, location, history, fetchStub,
    setT, clearTimeout, setI, clearInterval, (cb) => setT(cb, 0), clearTimeout,
    window.getSelection, Image, () => {}, () => true];

  /* The script runs in an inner function so none of its declarations can collide with the
     stub parameters. The two accessors are appended after it, in the same scope, so a
     direct eval() inside them sees every top-level binding the script made. */
  const body = `return (function(){\n${script}\n;return {` +
    `get:function(__h_n){return eval(__h_n);},` +
    `set:function(__h_n,__h_v){return eval(__h_n+"=__h_v");}};\n})();`;
  let access;
  try {
    access = new Function(...PARAMS, body)(...args);
  } catch (e) {
    e.message = `index.html script failed to load from ${file}: ${e.message}`;
    throw e;
  }

  const has = (name) => {
    if (typeof name !== "string" || !IDENT.test(name)) return false;
    try { access.get(name); return true; } catch (e) { return !(e instanceof ReferenceError); }
  };
  const get = (name) => {
    if (typeof name !== "string" || !IDENT.test(name)) return undefined;
    try { return access.get(name); } catch (e) { if (e instanceof ReferenceError) return undefined; throw e; }
  };
  const set = (name, value) => {
    if (!has(name)) throw new ReferenceError(`index.html has no top-level binding named ${name}`);
    access.set(name, value);
    return value;
  };

  /* The board's real paste handler, driven the way a person drives it: open the board,
     put `raw` in the paste box, press "Add to the board". */
  const paste = (raw) => {
    set("mode", "combine");
    get("render")();
    const tx = dom.byId("tx"), add = dom.byId("add");
    if (!tx || !add || typeof add.onclick !== "function") {
      throw new Error("the board screen has no paste box (#tx) or add button (#add)");
    }
    tx.value = String(raw);
    add.onclick({ stopPropagation() {}, preventDefault() {} });
    const text = (id) => { const el = dom.byId(id); return el ? String(el.textContent || "") : ""; };
    return {
      ok: text("ok"),
      err: text("err"),
      board: get("boardGet")(),
      pending: (get("pend") || []).slice(),
      mode: get("mode"),
    };
  };

  const helpers = {
    html, script, path: file, dom, storage,
    storageData: () => Object.assign({}, storage),
    get, set, has, paste,
  };
  return new Proxy(helpers, {
    get(t, k) {
      if (typeof k !== "string") return t[k];
      if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
      return get(k);
    },
    has(t, k) { return (typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k)) || has(k); },
    set(t, k, v) {
      if (typeof k === "string" && Object.prototype.hasOwnProperty.call(t, k)) { t[k] = v; return true; }
      set(k, v);
      return true;
    },
  });
}

/* ------------------------------------------------------------------ the old formats, written independently */

/* The field order every C2, C3 and C4 code was written with, copied out of index.html as
   it stood when the suite was written. Deliberately literal: every one of these is stored
   by POSITION, so if the app's own lists are ever edited in place, codes built from this
   stop decoding to what they meant and the tests say so. */
export const LAYOUT = Object.freeze({
  styles: ["sep", "clus", "big", "mix", "grow"],
  uses: ["full", "part", "often", "rare"],
  house: ["solo", "pair", "kids", "later"],
  horizon: ["soon", "mid", "long", "some"],
  debt: ["Yes", "Maybe", "No"],
  spend: ["land", "build", "wild", "city", "central", "known", "cheap", "sun"],
  acts: ["garden", "berry", "green", "herb", "mush", "forage", "bees", "hens", "sheep", "cellar",
    "ferment", "carp", "pot", "forge", "text", "studio", "music", "oven", "table", "fril", "fish",
    "hunt", "climb", "ski", "cycle", "swim", "dark", "wood", "guest", "income", "kids", "work",
    "offgrid", "quiet"],
  tol: ["tour", "dk", "lang", "far", "rough"],
  skills: ["build", "wood", "grow", "animal", "cook", "fix", "money", "legal", "lang", "org",
    "teach", "care", "make", "web"],
  trial: ["unsure", "must", "good", "skip", "against"],
  mapwin: { la0: 34, la1: 71, lo0: -11, lo1: 32 },
  pinSteps: 1023,
});
/* The eight-region list every C1 and C2 code was written against. */
export const REGIONS_V2_FROZEN = Object.freeze([
  "Vestland, Norway \u2014 the fjords", "German & Austrian northern Alps", "French Alps & Vercors",
  "Vosges & Alsace", "Ardennes & Eifel", "Pyrenees", "Northern Germany & Denmark",
  "Somewhere not on this list"]);
/* The five-region list every C3 and C4 code was written against. */
export const REGIONS_C3 = Object.freeze([
  "Vestland, Norway \u2014 the fjords", "French Alps, Vercors & Chartreuse", "Italian Alps",
  "Pyrenees", "Somewhere not on this list"]);

export const BITS_CORE_EXPECTED = 3 + 2 + 2 + 2 + 3 + 3 + 2 + LAYOUT.spend.length * 4 +
  LAYOUT.acts.length * 2 + LAYOUT.tol.length * 3 + LAYOUT.skills.length + 8;          // 154
export const BITS_C4_EXPECTED = BITS_CORE_EXPECTED + 3 + 21 * 2;                       // 199
export const NFIX_CORE = Math.ceil(BITS_CORE_EXPECTED / 8);                           // 20
export const NFIX_C4 = Math.ceil(BITS_C4_EXPECTED / 8);                               // 25

class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  w(v, bits) {
    v = Math.trunc(v);
    if (!(v >= 0) || v >= 2 ** bits) throw new Error(`builder: ${v} does not fit in ${bits} bits`);
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((v >> i) & 1);
      if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  done() { if (this.n) { this.bytes.push(this.cur << (8 - this.n)); this.cur = 0; this.n = 0; } return this.bytes; }
}

/* UTF-8 bytes of a JS string, as a binary (one char per byte) string. */
export const utf8bin = (s) => Buffer.from(String(s), "utf8").toString("latin1");
/* The share-code alphabet: standard base64 with "." for "+" and "_" for "/", unpadded. */
export const b64bin = (bin) => Buffer.from(bin, "latin1").toString("base64")
  .replace(/\+/g, ".").replace(/\//g, "_").replace(/=+$/, "");
/* The older C1 / raw-JSON alphabet: "-" for "+" and "_" for "/", unpadded, over UTF-8. */
export const b64utf8 = (s) => Buffer.from(String(s), "utf8").toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const idxOf = (list, v, blank) => {
  if (v === undefined || v === null || v === "") return blank;
  const i = list.indexOf(v);
  if (i < 0) throw new Error(`builder: ${JSON.stringify(v)} is not one of ${list.join(", ")}`);
  return i;
};
const regionList = (version) => (version === 2 ? REGIONS_V2_FROZEN : REGIONS_C3);

/* One record, fixed block plus free-text tail, as a binary string.
   rec uses the decoded-record keys: n s u hh hz cp rn d sp a t sk rg st wy ow rw cz lv tr pn.
   rec.tail (an array of strings) overrides the tail fields outright, for writing an older
   code with fewer of them; rec.mask overrides the region mask. A blank style or debt answer
   is written as the spare value (7, 3), the way the current encoder writes it. */
export function packRecord(version, rec) {
  if (![2, 3, 4].includes(version)) throw new Error(`builder: no bit layout for version ${version}`);
  const L = LAYOUT, w = new Bits(), REG = regionList(version);
  w.w(idxOf(L.styles, rec.s, 7), 3);
  w.w(idxOf(L.uses, rec.u, 0), 2);
  w.w(idxOf(L.house, rec.hh, 0), 2);
  w.w(idxOf(L.horizon, rec.hz, 0), 2);
  w.w(typeof rec.cp === "number" ? rec.cp : 5, 3);
  w.w(typeof rec.rn === "number" ? rec.rn : 4, 3);
  w.w(idxOf(L.debt, rec.d, 3), 2);
  L.spend.forEach((k) => w.w(Math.min(15, (rec.sp && rec.sp[k]) || 0), 4));
  L.acts.forEach((k) => w.w(Math.min(3, (rec.a && rec.a[k]) || 0), 2));
  L.tol.forEach((k) => w.w(Math.min(7, rec.t && rec.t[k] !== undefined ? rec.t[k] : 2), 3));
  L.skills.forEach((k) => w.w(rec.sk && rec.sk[k] ? 1 : 0, 1));
  const picks = (rec.rg || []).map((r) => {
    const i = REG.indexOf(r);
    if (i < 0) throw new Error(`builder: ${JSON.stringify(r)} is not in the version-${version} region list`);
    return i;
  }).sort((x, y) => x - y);
  w.w(rec.mask !== undefined ? rec.mask : picks.reduce((m, i) => m | (1 << i), 0), 8);
  if (version === 4) {
    w.w(idxOf(L.trial, rec.tr, 0), 3);
    /* pins travel in region-list order, the order the mask decodes in */
    const pinned = picks.slice(0, 2).map((i) => REG[i]);
    for (let k = 0; k < 2; k++) {
      const p = pinned[k] && rec.pn ? rec.pn[pinned[k]] : null;
      if (!p) { w.w(0, 1); w.w(0, 10); w.w(0, 10); continue; }
      const M = L.mapwin, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      w.w(1, 1);
      w.w(Math.round((clamp(p[0], M.la0, M.la1) - M.la0) / (M.la1 - M.la0) * L.pinSteps), 10);
      w.w(Math.round((clamp(p[1], M.lo0, M.lo1) - M.lo0) / (M.lo1 - M.lo0) * L.pinSteps), 10);
    }
  }
  const fixed = w.done().map((b) => String.fromCharCode(b)).join("");
  const tail = rec.tail !== undefined ? rec.tail
    : [rec.n || "", rec.st || "", rec.wy || "", (rec.ow || []).join("\u001e"), rec.rw || "",
      rec.cz || "", rec.lv || ""];
  return fixed + utf8bin(tail.join("\u001f"));
}

/* Header + length-prefixed records, with every field overridable so malformed packs can
   be built on purpose: count (the record-count byte) and lengths (per-record length field). */
export function packRaw(version, records, { count, lengths } = {}) {
  let out = String.fromCharCode(version) + String.fromCharCode(count !== undefined ? count : records.length);
  records.forEach((r, i) => {
    const len = lengths && lengths[i] !== undefined ? lengths[i] : r.length;
    out += String.fromCharCode((len >> 8) & 255) + String.fromCharCode(len & 255) + r;
  });
  return out;
}
export const packRecords = (version, recs) => packRaw(version, recs.map((r) => packRecord(version, r)));
/* A share code in version 2, 3 or 4, as an older (or current) copy of the page wrote it. */
export const buildCode = (version, recs) => b64bin(packRecords(version, Array.isArray(recs) ? recs : [recs]));

/* C1: "~"-separated text, regions as base36 positions in the frozen eight-item list. */
const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";
export function c1Line(rec) {
  const L = LAYOUT;
  const clean = (s) => String(s || "").replace(/[|~]/g, " ");
  return ["C1", rec.n || "", idxOf(L.styles, rec.s, 0),
    L.spend.map((k) => B36[Math.min(35, (rec.sp && rec.sp[k]) || 0)]).join(""),
    L.acts.map((k) => String((rec.a && rec.a[k]) || 0)).join(""),
    L.tol.map((k) => String(rec.t && rec.t[k] !== undefined ? rec.t[k] : 2)).join(""),
    idxOf(L.uses, rec.u, 0), idxOf(L.house, rec.hh, 0), idxOf(L.horizon, rec.hz, 0),
    L.skills.map((k) => (rec.sk && rec.sk[k] ? "1" : "0")).join(""),
    typeof rec.cp === "number" ? rec.cp : 5, typeof rec.rn === "number" ? rec.rn : 4,
    L.debt.indexOf(rec.d),
    (rec.rg || []).map((r) => {
      const i = REGIONS_V2_FROZEN.indexOf(r);
      if (i < 0) throw new Error(`builder: ${JSON.stringify(r)} is not in the C1 region list`);
      return B36[i];
    }).join(""),
    clean(rec.st), clean(rec.wy), (rec.ow || []).join("|").replace(/~/g, " ")].join("~");
}
export const buildC1Code = (recs) => b64utf8((Array.isArray(recs) ? recs : [recs]).map(c1Line).join("\n"));
/* The oldest fallback: a JSON value, base64'd with the C1 alphabet. */
export const buildJsonCode = (value) => b64utf8(JSON.stringify(value));

/* What WhatsApp does to a long unbroken string: a literal "-" every so often. */
export const insertHyphens = (code, every = 7) =>
  code.replace(new RegExp(`(.{${every}})(?=.)`, "g"), "$1-");

/* ------------------------------------------------------------------ fixtures */

/* A complete answer in the shape encode() takes (the app's payload()). Invented person;
   pins are on towns the pin picker itself draws, not anybody's home. */
export function sampleAnswer(overrides = {}) {
  const L = LAYOUT;
  const zero = (keys, v = 0) => Object.fromEntries(keys.map((k) => [k, v]));
  const base = {
    n: "Ada",
    s: "clus",
    sp: Object.assign(zero(L.spend), { land: 6, build: 3, wild: 0, city: 2, central: 1, known: 0, cheap: 5, sun: 3 }),
    a: Object.assign(zero(L.acts), { garden: 2, bees: 1, carp: 3, ski: 1, swim: 2, quiet: 3, hunt: 3, work: 2 }),
    t: { tour: 0, dk: 4, lang: 3, far: 1, rough: 2 },
    u: "part",
    hh: "pair",
    hz: "mid",
    st: "A place with no winter road access",
    sk: Object.assign(zero(L.skills), { build: 1, cook: 1, lang: 1, web: 1 }),
    wy: "Room to grow things together",
    cp: 6,
    rn: 5,
    d: "Maybe",
    rg: ["Pyrenees", "Italian Alps"],
    ow: ["Kayaking", "A shared library"],
    rw: "",
    cz: "Norwegian",
    lv: "Netherlands",
    tr: "good",
    pn: { "Pyrenees": [42.96, 1.61], "Italian Alps": [46.07, 11.12] },
  };
  return Object.assign(base, overrides);
}
