# Bergensers Commons — build-your-commons tool

## What this is

A single self-contained HTML file (`index.html`) — no build step, no dependencies,
no framework. It's a small survey/visualization app for a group of ~15 friends deciding
where to buy a shared property in Europe. People fill out a questionnaire on their own
phone, get a short code, send it to whoever's collecting, and the codes combine into
a results dashboard (charts, maps, alignment scoring, per-person breakdowns).

Everything — HTML, CSS, JS — lives in that one file. Keep it that way unless explicitly
asked to split it up; the whole point is that anyone can open it with no server.

**On screen it is called The Bergenshire** (renamed 31 Oct 2026): the page title, the link
previews and the line above the home heading. The repo, the web address and the `commons:`
storage prefix keep the old name on
purpose — renaming the repo breaks every link already shared, and changing the storage key
would orphan every saved draft and the collector's board. Two Shire touches were agreed
with the group's organiser before they went in: Bilbo's round green door on the home screen
(an inline drawing in the palette's colours, hidden from screen readers) and "Under the
Party Tree" as the results heading. Any further ones go past him first, and they stay
**hobbit-only** — "the hobbits lived in the Shire, not the elves or dwarves or anyone else":
no runes, no Elvish script, no wizards, no rings.

**The questionnaire is deliberately minimal** (31 Oct 2026, the organiser's decision: "too
much information all at once is paradoxically harmful, not helpful, to a decision"). Each step
shows its question, its answers and at most one short instruction line — no explanations,
context, background or reference material, and the home screen is one line. Everything that
came off, and the research behind the questions, lives in **`RESEARCH.md` in the private repo
`kaffeconway/bergensers-property-search`** — read it before changing what a question asks or
why. It is private because it holds group answers and names; nothing from it is copied here,
since this repo is public on the web. Do not add explanatory text back to the quiz; put it
there. What stays on screen regardless: the one-line reason for asking passport and country
(a consent reason, never hidden behind a disclosure), every storage-failure warning
(`lsFailed`), retired-pick and split-band notices, and every alarm on the review screen.
Answer options and their one-line reasons were **not** cut: rewording an option changes what
everyone who already chose it said, so that is a decision per option, not a tidy-up.

`where-we-landed.html` sits beside it: a static recap of the September call. Since 31 Oct
2026 nothing in the survey links to it (the organiser's decision); it stays published, so
anyone holding its address can still open it. It is a separate file, has no shared code with
`index.html`, and is **not** under the pure-ASCII rule below.

**The survey does not mention the September call on screen** (31 Oct 2026, the organiser's
decision). What came out of that call stays — the trial-year question, the narrowed region
list, the retired-pick note — but none of it says where it came from. Code comments may.

## Deploy

Hosted on **GitHub Pages**, served straight from the repo. Settings → Pages: source is
**GitHub Actions**, and `.github/workflows/pages.yml` publishes the repo root exactly as
committed on every push to `main`, usually within about a minute. **Enforce HTTPS** is on and
cannot be turned off on the default `github.io` domain. No build command, no manual upload
step.

The source was *Deploy from a branch* through the last September deploy. On 31 Oct 2026
PR #18 merged and nothing published: no build ran at all, and the September page stayed live
with no error anywhere. The source was then found set to *GitHub Actions*, with no deploy
workflow in the repo for it to run. When it changed is not known. The
workflow was added to fix that. It also makes every deploy visible in the Actions tab, and
it can be re-run by hand there (*Run workflow*) to republish without a new commit. If the
live site has not updated a few minutes after a push to `main`, look there first. Pages
caches each page for ten minutes, so allow that before calling it stuck.

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
never surnames**, and **no specific home locations for anyone**.

**Jekyll is disabled** by an empty `.nojekyll` file at the repo root, so every file is
served byte-for-byte as committed. Deploying through the workflow skips Jekyll anyway, but
keep that file: it is what protects the site if the source is ever set back to *Deploy from
a branch*. Without it, GitHub Pages runs Jekyll's
Liquid parser over the whole repo — including Markdown like this one — and a single stray
double-brace anywhere fails the build. The failure is quiet in the worst way: the deploy
step is skipped, no error surfaces on the site, and the *previous* build stays live, so
the site simply appears not to have updated. This is not hypothetical. An earlier version
of this very paragraph, warning about that brace hazard, contained the braces and broke
the build.

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
  as `\x1f`-joined fields. Encoder is `encode()` / `packC6()` / `recBin()`; decoder is
  `decode()` / `unpackRecs()` / `recRead()`. There's a fallback chain so older-format codes
  still decode — don't break that fallback.

- **Six formats coexist: C1 to C6.** The leading byte of the decoded blob says which.
  `encode()` always writes **C6**; `decode()` tries C6, then C5, C4, C3, C2, then C1 (a
  prior JSON-based format), then raw JSON, in that order. There is no C4 or C5 writer any
  more: `recBin` writes the C6 layout, so an older header in front of it would describe it
  wrongly. To make a genuine older code for a test, load an earlier commit's `index.html` and
  call its `encode()` — that is the real old encoder, not an imitation of it. (C5 was written
  until 31 Oct 2026; `main` before the C6 merge is a genuine C5 encoder.)

  **C6 (31 Oct 2026) adds 3 bits: how involved somebody wants to be** (`role`, `ROLE`: 0 is
  unanswered, then the `ROLE` index + 1). `ext` level `3`, `BITS_C6 = BITS_C5 + 3`. A record
  older than C6 leaves `role` **absent**; the results count an absent or blank role as
  planning (`isPlan`), the organiser's decision, because those people answered everything.
  That is applied when counting, never inside `decode`.

  **C4 lengthened the fixed block**, which C3 and the write-in did not. `BITS_CORE` is the
  original width (C1/C2/C3, 20 bytes); `BITS_C4` adds a 3-bit trial-year answer and two
  21-bit map pins (25 bytes). `recRead` and `unpackRecs` take an `ext` flag and derive
  `N_FIX` from the right constant — never share one N_FIX across versions, or an older
  record's free-text tail is read five bytes late and comes back as garbage.

  **C5 (31 Oct 2026) lengthened it again**, by 12 bits: the same-town answer (`same`,
  3 bits, `SAMETOWN`), whether you would move to the chosen town before anything is bought
  (`early`, 3 bits, `EARLY`), the hotter-summers tolerance (3 bits, `TOLX`), and one bit each
  saying whether `USES`, `HOUSE` and `HORIZON` were answered at all. Those three fill all four
  values of their two bits, so until C5 an unanswered one was written as its first option and
  came back as somebody saying "Live there full time"; a C5 code carries the blank. `ext` is
  now a level — falsy for C2/C3, truthy for C4, `2` for C5 — and `fixBits(ext)` picks the
  width. A record older than C5 leaves `same` and `early` **absent**, not defaulted: absent
  means "never asked", which is not "No view yet", and the results page counts only codes that
  were asked. The trial year is the cautionary case — its default cannot be told from a real
  answer, and still cannot.

  **`TOLX` is a separate list on purpose.** `TOL.length` is part of `BITS_CORE`, so appending
  a tolerance to `TOL` would move the fixed block of every C1–C4 code ever sent. A tolerance
  added later goes in `TOLX` (and a second one there means a C6, because `BITS_C5` spells its
  widths out as numbers).

  Region picks are stored **positionally** — C2 as a bit index into the region array
  (`mask |= 1 << i`), C1 as a base36 character. So editing the region list in place does
  not throw: the record still validates, and every existing code silently comes back
  meaning a *different* region than the person picked. That is why the old eight-item list
  is frozen as **`REGIONS_V2`** and never touched. **C1 and C2 codes are decoded against
  `REGIONS_V2`; C3 and C4 against `REGIONS_V3`, the five-item list frozen when C5 arrived;
  C5 against the current `REGIONS`.** If the region list ever changes again, freeze the
  current array the same way and add a C6 — do not edit `REGIONS` in place.

  **Oslo & eastern Norway** was added in C5 by *appending* it, never inserting, so every
  earlier region keeps its bit and `REGIONS` begins with `REGIONS_V3` exactly (`WIDTHS`
  refuses to encode if that stops being true). The version byte was still needed: an older
  saved copy of the page reading a C5 code must refuse it rather than drop the sixth bit.
  `REGIONS` stays a literal array because the property search reads it with a regex.
  Storage order is not display order: `RGSHOW` puts "Somewhere not on this list" last and the
  newest region just before it, so no region is offered first by default. Oslo has no row on
  the triangle — the property search has no listings there. The caption no longer says so
  (it was cut to a few lines on 31 Oct 2026); `RESEARCH.md` in the property repo does.

  `RENAMED` maps a region that was only relabelled (`French Alps & Vercors` →
  `French Alps, Vercors & Chartreuse`) onto its new name. It is applied at display and
  tally time only (`rgNow` / `rgOf`), never inside `decode` — an old code still reports
  exactly what the person picked. `RETIRED` is the set of regions that were genuinely
  dropped; the results page shows those picks with a "no longer on the shortlist" note
  rather than hiding them or folding them into "somewhere not on this list".

  Adding a **free-text** field costs nothing in format terms: append it to the `\x1f`-joined
  tail. Old codes simply have fewer separators, so the new `parts[n]` comes back `undefined`
  and defaults to `""`, `N_FIX` doesn't move, and `unpackRecs`'s strict length validation
  still passes. That's how the region write-in (`rw`) was added without a format bump, and
  then passport (`cz`) and country-lived-in (`lv`) after it. **The tail is seven fields now**:
  name, deal-breaker, why, activity write-ins, region write-in, passport, country.
  Adding a **fixed-width** field is the opposite: it moves `N_FIX`, so it needs a new
  version byte and a new `BITS_*` constant.

- **Map pins are switched off** (31 Oct 2026, the organiser's decision: "I do not think we
  need people to pin on the map just yet. I feel we need just to get a region/city picked
  first"). `PINS_ON = false` beside `allPins` turns off the picker on the region step, the pin
  line on the review, the pins on the results map, the "Where exactly" section, the pin
  discount in the *Where* alignment score, and the pins on the shareable image. Hidden pins
  must not move a visible number, which is why the score ignores them too. **Nothing else
  changed**: the share-code format still carries pins, a pin already in somebody's code is
  kept when they re-save (just not shown), and the picker code below is intact. Setting
  `PINS_ON = true` brings all of it back exactly as it was — ask him before doing that.

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
  rather than silently producing garbage/"anon" entries. `unpackC2`, `unpackC3` and `unpackC4` are all
  thin wrappers over it, differing only in which region array they read and whether they
  expect the longer C4 fixed block. Keep it strict; a
  previous looser version produced phantom empty submissions from corrupted paste input.

- **The board (`localStorage`, key prefix `commons:`)** persists submissions on whoever's
  device is collecting them, so codes can be added incrementally over days without
  re-pasting old ones. Tapping a name on the board opens that person's answers for
  editing: `boardEdit` holds the row index and `autosave()` then writes `payload()` back
  to that row instead of creating a personal draft. It is guarded by `boardEditKey`, the
  row's lowercased name — if the row moved or was deleted underneath the edit, the binding
  drops and the work falls back to a draft rather than overwriting a stranger. Every entry
  point that starts a fresh identity must clear both. `stateFrom()` converts a decoded
  record into questionnaire state and is shared with the shared-link boot path so the two
  cannot drift.

- **The two money bands are positional, like the regions were.** `cp` and `rn` travel in
  the code as the *index* into `CAP` / `RUN`, written as bare 3-bit values. So redrawing a
  boundary in place would leave every code already sent carrying its old index and coming
  back meaning a different band — the `REGIONS_V2` trap in a second place, and this one has
  no version byte to hide behind. **Only ever append.**

  Two bands were split in Sept 2026 because the property search found that most of what it
  was tracking cost more than our top bands could describe: 24 of its 30 listings run over
  €400/month per person, up to €854, and a €500k place split four ways is €125k each. Its
  workbook had built its own extended lookup tables to get round ours. So `€150–250k` and
  `Over €250k` were appended for capital, `€400–600`, `€600–900` and `Over €900` for monthly.

  The two that were split — `Over €150k` at index 4, `Over €400` at index 3 — **stay in the
  arrays forever** so older codes still decode to exactly what the person said. They are no
  longer offered: `CAPOFFER` / `RUNOFFER` say what the form shows and in what order, which is
  deliberately not the storage order, and `CAPSPLIT` / `RUNSPLIT` name the retired ones.
  Somebody whose saved answer *is* a retired band sees it on the form, marked, and it is
  replaced only when they choose again — the same order as a dropped region. The results page
  says so too, and pools the answer at the old band's range rather than moving it into a band
  nobody picked.

  `CAPEUR` / `RUNEUR` hold the euro range per band, index-aligned and `null` for the two
  non-numeric answers. Pool from those, never from a bare index cutoff: the previous
  `c.cp < 5` test would have read both appended top bands as "did not answer".

  **Three bits holds exactly eight and both lists now hold eight.** A ninth band in either
  needs a C6. Until 31 Oct 2026 this file said an assertion caught a ninth band; there was no
  such assertion anywhere. There is now: `WIDTHS` lists every positional answer with the most
  options its bits can hold, and `recBin` throws rather than write a code if any list has
  outgrown it — which the review and code screens already report as "could not be written".

- **The Europe map's region names sit in fixed margin slots** (`MAPLAB`), on leader lines,
  not above their bubbles. The bubble radius grows with votes and the three alpine regions
  fall within about 35 viewBox units of each other, so printed labels collided: "French
  Alps" was buried inside the Italian Alps bubble at **four** votes, and at a realistic
  fifteen two more went under and the bubbles themselves overlapped. Fixed slots cannot
  collide however the vote splits. The check for that walks every way the votes can split —
  with five regions, every split of 15 votes and of 30, 50,252 in all — and confirms no label
  lands in a bubble, no leader passes through another bubble, no two labels overlap and no two
  leaders cross. It is a throwaway Playwright script, not committed here; this file used to
  describe it as though it were. If a region is ever added to the map, give it a slot at least
  30 units clear of the others on its side, and re-run that check. Oslo's bubble sits about 20
  units from Vestland's, closer than any other pair, so its label is on the opposite side
  (Vestland's leader runs west, Oslo's east) and the two bubbles overlap at high counts. That
  is the real geography at this scale, and the counts are in the labels.
  The vote count rides **in the label**, as `Italian Alps · 7`, not inside the bubble: individual pins are drawn after the bubbles, so a cluster of them covered the
  numeral at four people as well as fifteen. A pin is somebody's actual answer about *where*
  in a region; it wins, and the number moves out of its way.

- **The triangle under the map** (`TRI` / `triSVG`) plots the four regions against land &
  space, affordability, and being easy to reach. **Two of the three axes now come from the
  property tracker in `kaffeconway/bergensers-property-search`, and one deliberately does
  not** — the caption says so, and it has to keep saying it.

  **The caption is deliberately short (31 Oct 2026, the organiser's decision).** It says the
  dots are placed from real listings the property search is tracking *and from train times*,
  gives one line per corner, and ends "The nearer a corner, the more a region leans that
  way." Those two are the parts that cannot go: naming train times stops anyone reading all
  three corners as listings, and the last line is what stops a high dot reading as "best
  overall". The listing counts, their date and the caveats came off screen. The counts and
  date now live in `TRI_BASIS`, one line of strict JSON beside `TRI`, and nowhere on screen.

  *Land & space* and *affordable* are the mean of the live listings in that tracker,
  computed with its own `load()`, cost model and axis formulas (`tools/make_charts.py`) so
  the two repos cannot drift, then rescaled across the four regions so each axis spans the
  range they actually differ over. Rescaling changes spacing, never order. The listing
  counts are uneven, and `TRI_BASIS` records them **with the date they were computed**:
  as of 25 Sept 2026, 32 scored listings — French Alps 13, Vestland 9, Pyrenees 6, Italian
  Alps 4. (The 15 Sept run was 30: 12, 8, 6, 4.) The values are produced by
  `tools/triangle_regions.py` in the property repo, whose `--check` reproduces the 15 Sept run
  exactly; nothing here is computed by hand any more.

  **The date is there because the numbers drift faster than anyone expects.** The tracker
  gained eleven listings in six days. When that first happened the dots had barely moved
  (the closest pair went 22.8px to 23.4px) while the stated counts were wrong on three
  of the four regions — so the failure mode is a stale *claim*, not a visibly wrong chart.
  Until 25 Sept 2026 this file said a test pinned those counts; none existed. One does now, in
  the property repo's `tools/test_charts.py`: it reads `TRI_BASIS` from this file on `main`
  (the long caption, before it was cut) and compares the counts, their sum and the date with
  the tracker. Since 31 Oct 2026 `CAPTION_DRIFT_IS_FATAL` is on, so a mismatch fails that
  repo's build: when a property is scored or unscored there, re-run `triangle_regions.py` and
  update `TRI` and `TRI_BASIS` here together. It counts SCORED listings — an unassessed
  property is not a low-scoring one.

  *Easy to reach* is **not** from the listings. It is rail hours from Amsterdam on the
  fastest service, scored as `1/hours` — not straight-line distance, which flatters Norway
  badly, and not linear, because 10h against 27h is a different kind of gap from 7h against
  10h. The tracker does have an axis called *connected*, but it is 62% weighted on "near a
  city" and scores each house's **local** situation; Vestland's listings score best of the
  four on it, all being near Bergen. Putting that number under *easy to reach* would say
  Norway is the easy one to get to from the Netherlands, which is false. Keep the two apart.

  Adopting the listing averages corrected a real error here: the old hand-set price bands
  had the Pyrenees as the cheap corner. The listings do not agree — Pyrenees averages
  €516,690 all-in against the French Alps' €515,070, with Vestland €388,157 and the Italian
  Alps €224,910. Only Italy separates, and it separates further than it did. If the tracker
  gains or loses listings, re-run the averages rather than nudging the weights by hand.

  Vestland and the Pyrenees changed places on *affordable* in the 15 Sept re-run, by four
  thousandths (.530 against .525 after rescaling). **Don't write a caption that claims an
  order between those two.** The chart shows balance rather than level, and at that distance
  the honest reading is that they score alike.

  The tracker's own caveats travel with the numbers. They were in the caption until it was
  cut on 31 Oct 2026, and are recorded in the property repo's `RESEARCH.md` now: the priority
  weights behind them are the mean token spend of **four** questionnaire answers out of
  roughly fifteen, renovation is blank on every listing so every price is a floor, the axis
  scores are desk reads of listing text, and the Italian average rests on three listings
  with the widest spread of the four.

  The closest two regions plot about 23px apart (Italian Alps and Vestland, as of the
  15 Sept re-run). Labels sit outside the plot on leader
  lines rather than beside the dots, vote counts live in the labels rather than inside the
  circles, and the dots stay small enough that a near-touch reads as two regions scoring
  alike. Do not spread the dots apart to make it prettier; change the weights only when the
  underlying listing averages or rail figures change.

  A dot's position is the *balance* between the three, not the level of any one. The
  caption's last line says this ("leans that way"), and it needs to keep saying it, or a high
  dot reads as a claim that the region is best overall.

- **Map data**: tries to fetch real Natural Earth coastline/border data from a CDN at
  runtime (`upgradeGeo`/`upgradeMap` functions) and falls back to a hand-drawn simplified
  outline if that fetch fails (e.g. offline, or a restrictive sandbox). Both paths must
  keep working.

## The property search reads this repo

`kaffeconway/bergensers-property-search` evaluates real listings against these answers, and
the coupling runs in both directions now, so a change here can move numbers there.

It **reads `REGIONS` live** and caches it as `docs/questionnaire-regions.json`; its coverage
table generates from that, so a region added or dropped here appears there without anyone
editing prose. Don't rename a region casually — and per the rule above, never edit the array
in place.

It also derives its scoring weights from the mean token spend of the codes collected here
(`/sync-weights`), reads `STYLES` to score the *Buildings* axis, reads the *"unfinished for
years"* tolerance as the ceiling on an acceptable *Condition* score, and reads the *use*
answer as the evidence that year-round residence is required. Four responses are in as of
Sept 2026, and every ranking it publishes carries that caveat. **Only planning-committee
codes count toward its weights** (`isPlan`): somebody following along or visiting spends no
tokens, and averaging them in would drag every weight toward zero.

Three things it says it is blocked on that this questionnaire does **not** yet ask, recorded
here so they are not rediscovered: **who is actually buying in and how many** (its Assumptions
sheet models four sharers, sourced to a verbal remark, and its own profile calls the number of
signers the single biggest lever on affordability); **whether a bank would lend to each
person** (a Norwegian mortgage generally needs Norwegian income or residency, and without it
its 15%-equity model becomes a cash purchase — a 7x swing in the per-person figure); and
**which regions anyone already knows** (its *Somewhere we know* axis is currently assumed —
Vestland 4 by definition, France and Italy 0–1 — and nobody has been asked whether a single
one of us knows the Pyrenees, which now hold six listings and its top-ranked property).
Passport and country-lived-in were the fourth, and are now asked.

## Who is in: planning, following, visiting

**Step 2 asks how involved somebody wants to be** (31 Oct 2026, the organiser's decision and
wording): *On the planning committee* ("I may invest, and want a say in where and how"),
*Keep me posted* ("Not planning, but I'd like to follow along"), *Visiting is enough* ("I'm
happy seeing everyone at Bergensers reunions"). An answer is required to go on. Planning
continues through the questionnaire. The other two finish there with a code ("Thank you.
Here is your code"), so they are counted without being asked about land and money; their
review shows only name and role, and changing the role to planning from the review brings
the full questionnaire back. Because the step sits second, every review row and integrity
check refers to later steps by index one higher than before — use the step's position, and
re-check those numbers whenever a step is added.

**Results.** Everybody is counted once, in a "Who's in" line at the top of the summary, each
count tappable for names; the kicker counts everyone, and the shared link and combined code
carry everyone. **Every chart and score is drawn from the planners only** — `result()` narrows
`codes` to them while it draws, keeping the full list in `crowd`. With fewer than two planners
the page shows who is in and says there is nothing to compare yet, the same rule as the
board's two-code minimum. The board marks who is following or visiting beside their name, and
the shareable image adds a "Who's in" block when anyone is not planning.

**The planning WhatsApp.** `PLANCHAT` holds the planning group's invite link, shown on the code
screen to people who chose planning, and nobody else. It is empty until the organiser sends the
link. This page and repo are public, so the group must have WhatsApp's **Approve new
participants** switched on before a link goes in: whoever finds it can then only ask to join.
That was the condition the organiser agreed to; do not add a link without it.

## Results page

**"Who is closest to whom" is gone** (31 Oct 2026, the organiser's decision): it ranked every
pair of people from most alike to furthest apart, and was more likely to seed resentment than
to help the decision. Do not bring back anything that ranks people against each other without
asking him. **Lone voices stays, named, by his choice** — it was asked about separately — and
is now its own group.

**Folded into groups since 31 Oct 2026.** Only the counts-only summary and the overall
alignment gauge (with at most three headline cards) are open at the top. Every other section
sits in one of nine closed groups, each summary line showing how aligned the group is on that
part: Where · How we'd start, and when · What matters most · What has to be possible · How
much you can take · Shape of the place · Money & commitment · Lone voices · In your own words. Those percentages are the same per-part scores the overall number averages, so the
two cannot disagree; a group with nothing to score says "not scored", and one with fewer than
two answers says "too few answers" rather than showing a number. The grouping is done after
the page is built, by cutting it at its `h3.sec` headings (`RGRP` in `result()`), so a new
section must be named in a group — one that is not is kept, unfolded, after the groups rather
than dropped. The per-part bars and the chip navigation strip were removed: the group lines
are the overview, and a chip pointing into a closed group jumps to nothing.

The alignment score's timing part became **"How we'd start, and when"** on 31 Oct 2026, on the
organiser's decision and knowing it moves scores already given: timing over those who
answered, plus the trial year and the same-town idea compared as for / against, plus whether
people would move early. "No view yet" and a code that never had the question are left out,
not counted as agreement, and do not add to the gauge's unanswered-question note. "Hotter
summers" is still kept out of the score until most respondents have been asked it.

The page explains itself once, not per row. "Tap for names" is a `::after` on `.res.tip1`,
and that class is applied in JS to the first inspectable row on the page — it used to be
on every `.res[data-items]`, which printed the same three words about seventy times.
Headline cards are capped at three. Lone voices groups by person and by what the
disagreement is, so somebody standing alone on nine activities is one row listing nine
things rather than nine rows repeating one sentence. Keep that shape: the page reports,
it does not narrate.

## Losing somebody's answers

Two ways the board could lose a submission quietly, both closed:

Removing a row is one tap with no confirmation, while clearing the whole board asks twice —
the guard was on the less likely action, and a row may be the only copy of what somebody
sent. `undoRow` holds the last row removed and the board offers it back by name. The offer
lapses on the next action (leaving the board, pasting, editing a row, clearing, going to the
results), so it is never a stale button over a board that has moved on, and it reinserts at
`min(at, length)` rather than at an index that may no longer exist.

`lsSet` catches a storage failure and falls back to an in-memory object that dies with the
tab — private browsing, a content blocker, a full quota. That used to be silent, so a
collector gathering codes over days would be told "the board is saved on this device" and
lose everything on reload. `lsFailed` records it, `storeWarn()` says so on the board, and
the code screen drops its claim to have saved anything and tells the person to copy the link
instead. Any screen that promises persistence has to check that flag.

## Style

Warm, editorial, slightly old-fashioned — serif headings (Iowan Old Style / Palatino
fallback stack), monospace for labels/data, sage-green/paper color palette defined as
CSS custom properties at the top of the `<style>` block. Match this rather than
introducing a different visual language.

## Whose answers these are

Every submission is somebody else's answer, held on whoever's device is collecting.
Nothing in the code removes what a person said. If an answer can't be carried forward,
surface it and say why — that is what `REGIONS_V2` being frozen is for, why retired picks
appear with a "no longer on the shortlist" note rather than folded into "somewhere not on
this list", and why a board row whose slot disappears falls back to a draft instead of
vanishing.

Two different people can share a first name, and a first name is all this asks for. So a
pasted code whose name is already on the board is a **question**, not an instruction:
`nameSplit` holds it back and the collector chooses. Replace (a corrected resend), keep
both, or skip — and nothing is written until they pick. Keeping both requires a last
initial on **both** rows, not just the newcomer, because initialling one still leaves a
reader guessing which of them plain "Leon" was; `hasInitial` enforces a name, a space and
one letter, and refuses two names that still match. An initial is not a surname, so this
stays inside the first-names-only rule. This replaced a silent replace-by-name that
reported itself as "1 updated" while destroying the first person's answers — the exact
thing this section forbids.

An entry nobody currently holds is different, and should not accumulate: a write-in for an
option since unticked, a pin for a region since unpicked. Those are dropped from the code
on the next save. The test is whether somebody is actively choosing it now.

The order is the part that matters. An entry goes when the *person* replaces it, never
before. A dropped region is shown on their region step, survives a pass where they choose
nothing, and is released only once they have actually picked again. Same end state either
way; the difference is whether they were there for it.

## Asking before deciding

On anything that changes what the group sees, or what somebody's answers mean, ask
before building rather than explaining afterwards. A judgment call made and then
reported is still a decision somebody else never got to weigh in on.

This includes code edits. A diff shows what changed, not what was weighed — where a
region sits on a chart, which of two conflicting figures to trust, what to leave off a
page. Those are decisions, and they are not the editor's to make quietly.

Small, reversible, obvious things don't need it: a typo, matching a pattern already
here, following a rule already written down. The test is whether somebody would
reasonably want a say, not whether the change is large.

## Reporting back completely

When doing anything for this project that isn't a code edit — summarizing a group call,
searching and comparing property listings, or writing up what a batch of questionnaire
results actually shows — report the whole thing plainly. Don't round off inconvenient
details, don't quietly fold in a judgment call nobody asked for, and don't make a private
side-decision partway through a task that only lives in your head and never gets
surfaced. If something is uncertain or you didn't check it, say so rather than reporting
the version that's easiest to hand over. This applies the same way whether it's Claude or
Joseph doing the work.

## Testing changes

Keyboard focus is styled with `:focus-visible` only (a 2px glacier outline), so a mouse or
a tap shows nothing and a keyboard user gets a visible ring. Every control here is a custom
button, so without it there is only the browser default to go on.

There's no test suite. Before committing a change to the codec or paste logic, sanity-
check with a quick Node script: extract the `<script>` contents, `new Function(...)`
them with stub DOM globals, and roundtrip a sample answer through `encode`/`decode`.
This has caught real bugs before (see the strict-validation and hyphen fixes above) —
don't skip it for anything touching
`packOne`/`packC6`/`recBin`/`recRead`/`unpackRecs`/`decode`/`encode`.

Things worth asserting every time the codec changes: a new answer roundtrips through C6
with its role (each of the three, and blank), regions (Oslo included), write-in, pins,
trial-year, same-town and move-early answers, the hotter-summers slider, and a genuine blank
for use, household and timing; a **C5** code made by an earlier commit's own `encode()` still
decodes, with `role` absent and counted as planning; a **C4** code made the same way still
decodes, with `same` and `early` absent; a **C3** and a **C2** code
still decode, still report the regions the person actually picked, and still read their
free-text tail from the *shorter* fixed block (build them in the test by writing the old
bit layout with a leading byte 2 or 3 and the right region array); a **C1** code still
decodes; a grouped code pasted as one blob still imports as a single code; and an older
saved copy of the page refuses a C6 code rather than misreading it.

If you edit `index.html` with a script, run the ASCII check afterwards whatever the script
was meant to do. Some editing tools decode `\uXXXX` escapes before the text reaches the file,
so a JS string written as `"\u2014"` can land as a real em dash. It happened twice while
building C5, and the grep caught it both times.

There is also a Playwright pass worth running for anything touching the pin picker (while
`PINS_ON` is false, run it against a copy of the page with it set to true) —
Chromium is preinstalled at `/opt/pw-browsers`. Open `index.html` from `file://`, walk to
the region step, click the pixel where a known town's dot is drawn, and check the app
stores that town's coordinates. That is the only way to catch a broken inverse projection;
the unit tests cannot see the CSS-pixel-to-viewBox scaling. Note that Chromium's
`innerText` applies `text-transform`, so match `.sec` and `.ct` labels case-insensitively.
