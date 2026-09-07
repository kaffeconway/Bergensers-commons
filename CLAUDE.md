# Bergensers Commons — build-your-commons tool

## What this is

A single self-contained HTML file (`index.html`) — no build step, no dependencies,
no framework. It's a small survey/visualization app for a group of ~15 friends deciding
where to buy a shared property in Europe. People fill out a questionnaire on their own
phone, get a short code, send it to whoever's collecting, and the codes combine into
a results dashboard (charts, maps, alignment scoring, per-person breakdowns).

Everything — HTML, CSS, JS — lives in that one file. Keep it that way unless explicitly
asked to split it up; the whole point is that anyone can open it with no server.

`where-we-landed.html` sits beside it: a static recap of the September call, quietly
linked from the home screen. It is a separate file, has no shared code with `index.html`,
and is **not** under the pure-ASCII rule below.

## Deploy

Hosted on **GitHub Pages**, served straight from the repo. Settings → Pages: source is
**Deploy from a branch**, branch `main`, folder `/ (root)`. **Enforce HTTPS** is on and
cannot be turned off on the default `github.io` domain. Every push to `main` rebuilds and
republishes automatically, usually within about a minute. No build command, no manual
upload step.

Live at **https://kaffeconway.github.io/Bergensers-commons/** — that is the one address
to share. The old EdgeOne address (`bergensers-commons.edgeone.dev`) is retired; see
`README.md` for why.

So the workflow is just: edit `index.html` → commit → push to `main`. That's the whole
deploy pipeline.

```
git add index.html
git commit -m "describe the change"
git push
```

If asked to "deploy," "push," "ship this," or similar — that's it, there's no separate
deploy command to run.

Serving from the repo root means **every file here is on the public web**, this file and
`README.md` included. Two standing rules for anything published here: **first names only,
never surnames**, and **no specific home locations for anyone**. GitHub Pages runs Jekyll
over the repo, so don't introduce `{{` or `{%` into any HTML file.

## Things worth knowing before editing

- **Pure ASCII output required.** The file is escaped to contain zero non-ASCII bytes
  (accented characters, em dashes, etc. are stored as `\uXXXX` in JS strings and `&#NNN;`
  in HTML/CSS). This was a deliberate fix for a mojibake bug on the previous host's CDN,
  which didn't reliably serve a charset header. GitHub Pages does send one, but keep the
  rule: it costs nothing, and the file gets passed around as a saved copy too, where no
  header applies. If you add any literal non-ASCII character
  when editing, re-escape it the same way before committing — don't let raw UTF-8 bytes
  back into the file.

- **Forced light color scheme.** `color-scheme: light` plus a `prefers-color-scheme: dark`
  override block. Some in-app browsers (e.g. opened from WhatsApp) auto-dark-mode pages
  that don't declare a scheme, which broke readability. Don't remove this.

- **The share-code format is bit-packed, not JSON.** Every fixed-choice
  field (activities, token spends, tolerances, skills, region picks) is packed into a
  handful of bits each rather than stored as a JSON key. Free text (name, deal-breakers,
  why, activity write-ins, region write-in) is stored as raw UTF-8 after the packed block,
  as five `\x1f`-joined fields. Encoder is `encode()` / `packC3()` / `recBin()`; decoder is
  `decode()` / `unpackRecs()` / `recRead()`. There's a fallback chain so older-format codes
  still decode — don't break that fallback.

- **Four formats coexist: C1, C2, C3 and C4.** The leading byte of the decoded blob says
  which. `encode()` always writes **C4**; `decode()` tries C4, then C3, then C2, then C1 (a
  prior JSON-based format), then raw JSON, in that order.

  **C4 lengthened the fixed block**, which C3 and the write-in did not. `BITS_CORE` is the
  original width (C1/C2/C3, 20 bytes); `BITS_C4` adds a 3-bit trial-year answer and two
  21-bit map pins (25 bytes). `recRead` and `unpackRecs` take an `ext` flag and derive
  `N_FIX` from the right constant — never share one N_FIX across versions, or an older
  record's free-text tail is read five bytes late and comes back as garbage.

  Region picks are stored **positionally** — C2 as a bit index into the region array
  (`mask |= 1 << i`), C1 as a base36 character. So editing the region list in place does
  not throw: the record still validates, and every existing code silently comes back
  meaning a *different* region than the person picked. That is why the old eight-item list
  is frozen as **`REGIONS_V2`** and never touched. **C2 and C1 codes are decoded against
  `REGIONS_V2`; C3 codes against the current `REGIONS`.** If the region list ever changes
  again, freeze the current array the same way and add a C4 — do not edit `REGIONS` in
  place.

  `RENAMED` maps a region that was only relabelled (`French Alps & Vercors` →
  `French Alps, Vercors & Chartreuse`) onto its new name. It is applied at display and
  tally time only (`rgNow` / `rgOf`), never inside `decode` — an old code still reports
  exactly what the person picked. `RETIRED` is the set of regions that were genuinely
  dropped; the results page shows those picks with a "no longer on the shortlist" note
  rather than hiding them or folding them into "somewhere not on this list".

  Adding a **free-text** field costs nothing in format terms: append it to the `\x1f`-joined
  tail. Old codes simply have fewer separators, so the new `parts[n]` comes back `undefined`
  and defaults to `""`, `N_FIX` doesn't move, and `unpackRecs`'s strict length validation
  still passes. That's how the region write-in (`rw`) was added without a format bump.
  Adding a **fixed-width** field is the opposite: it moves `N_FIX`, so it needs a new
  version byte and a new `BITS_*` constant.

- **Map pins (`pn`) are keyed by region name, never by position.** In state and in a decoded
  record `pn` is `{"Italian Alps": [lat, lon]}`. On the wire they are written in `REGIONS`
  order, because that is the order the 8-bit region mask decodes in — `rgPicks()` sorts to
  match, and `recRead` re-keys them by name on the way out. Write them in pick order instead
  and two pins silently swap regions. Coordinates are quantised to 1023 steps across
  `MAPWIN` (about 4 km), and `MAPWIN` is declared up with the content because it is the
  quantisation range as well as the map frame.

  The picker (`insetFit`/`pinSVG`) uses a plain equirectangular fit with a `cos(lat)`
  correction, not the Lambert conic the Europe map uses: over a few degrees the difference
  is invisible and it inverts in one line, which is what tap-to-place needs. Inland alpine
  insets have no coastline to draw, so `RCTOWN` supplies towns to steer by; `SUBAREA` is a
  first-match-wins list of bounding boxes used only to put a readable name on a pin.
  Accented names in both live in JS strings as `\uXXXX`, never as HTML entities — they get
  `esc()`'d into HTML and JSON-encoded into inspector attributes, and an entity survives
  neither trip.

- **No hyphen in the base64 alphabet.** WhatsApp inserts a literal `-` character when it
  line-wraps a long string with no spaces, which corrupts pasted codes. The custom base64
  alphabet used here (`bin64`/`unbin64`) uses `.` instead of `-` for that reason, and the
  decoder strips any stray `-` on the assumption it's always corruption, never a real
  character. If you touch the codec, preserve this — don't reintroduce `-`.

- **Codes are displayed/copied in grouped chunks** (`grp()`, spaces every 20 chars) so
  chat apps have natural wrap points and don't need to hyphenate at all. The paste/import
  handler tries the *whole pasted blob* as one code before falling back to splitting by
  line — grouped codes contain spaces on purpose, so naive whitespace-splitting will
  shred a single code into garbage fragments. If you touch the paste handler, keep that
  "try whole blob first" order.

- **`unpackRecs` validates strictly** — wrong record length or leftover bytes throws,
  rather than silently producing garbage/"anon" entries. Both `unpackC2` and `unpackC3` are
  thin wrappers over it, differing only in which region array they read. Keep it strict; a
  previous looser version produced phantom empty submissions from corrupted paste input.

- **The board (`localStorage`, key prefix `commons:`)** persists submissions on whoever's
  device is collecting them, so codes can be added incrementally over days without
  re-pasting old ones.

- **Map data**: tries to fetch real Natural Earth coastline/border data from a CDN at
  runtime (`upgradeGeo`/`upgradeMap` functions) and falls back to a hand-drawn simplified
  outline if that fetch fails (e.g. offline, or a restrictive sandbox). Both paths must
  keep working.

## Style

Warm, editorial, slightly old-fashioned — serif headings (Iowan Old Style / Palatino
fallback stack), monospace for labels/data, sage-green/paper color palette defined as
CSS custom properties at the top of the `<style>` block. Match this rather than
introducing a different visual language.

## Testing changes

There's no test suite. Before committing a change to the codec or paste logic, sanity-
check with a quick Node script: extract the `<script>` contents, `new Function(...)`
them with stub DOM globals, and roundtrip a sample answer through `encode`/`decode`.
This has caught real bugs before (see the strict-validation and hyphen fixes above) —
don't skip it for anything touching
`packOne`/`packC3`/`recBin`/`recRead`/`unpackRecs`/`decode`/`encode`.

Things worth asserting every time the codec changes: a new answer roundtrips through C4
with its regions, write-in, pins and trial-year answer intact; a **C3** and a **C2** code
still decode, still report the regions the person actually picked, and still read their
free-text tail from the *shorter* fixed block (build them in the test by writing the old
bit layout with a leading byte 2 or 3 and the right region array); a **C1** code still
decodes; and a grouped code pasted as one blob still imports as a single code.

There is also a Playwright pass worth running for anything touching the pin picker —
Chromium is preinstalled at `/opt/pw-browsers`. Open `index.html` from `file://`, walk to
the region step, click the pixel where a known town's dot is drawn, and check the app
stores that town's coordinates. That is the only way to catch a broken inverse projection;
the unit tests cannot see the CSS-pixel-to-viewBox scaling. Note that Chromium's
`innerText` applies `text-transform`, so match `.sec` and `.ct` labels case-insensitively.
