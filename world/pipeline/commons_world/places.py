"""Named places for labels and facts: terrain features from Kartverket's place-name register.

The Stedsnavn API's /punkt answers "names within R of a point" with R at most
5000 m and 500 names a page, all types together (it has no type filter). The
h20 disk is covered with squares whose circumscribed circle has that radius
(side 5000 * sqrt 2), one query per square, paging until the stated total is
reached. A square whose total exceeds the API's cap of 5000 is split in four.
Names are then kept only if they lie inside their own square (so overlapping
circles do not double them) and inside the disk, and only for these types:

| Kept (terrain heights)  | Seen within 5 km of a test site, 24 Sept 2026 |
|-------------------------|------------------------------------------------|
| Fjell, Topp, Haug, Aas (\\u00c5s), Berg, Hoeyde (H\\u00f8yde), Rygg | yes: Haug 48, Aas 19, Fjell 17, Berg 5, Topp 4, Hoeyde 2, Rygg 1 |
| Egg, Hei, Fjellomraade (Fjellomr\\u00e5de) | not there, but in the register's type list |

Left out on purpose: slopes and cliffs (Bakke, Li, Fjellside, Hammar, Stup,
Fjellvegg), bare rock (Fjell i dagen), plateaus (Vidde), cairns (Varde, a
navigation-mark type), islands and everything at sea. "Nut" and "Tind" are
not types in the register, only parts of names.

Heights are sampled from the terrain model, not taken from anywhere else: the
highest sample within 30 m of the name point, on the finest level whose
chunks hold the whole 30 m disk (so a name near the edge of h1 is not
measured on the part of its summit that h1 happens to cover). x and z are
that sample's position, so (x, z, h) is a point on the terrain (for a peak,
the summit rather than the label anchor).

Spelling: the register can hold several spellings per place. The one used is
the first that is neither historical nor merely proposed, preferring the main
name (hovednavn) and a spelling marked "prioritert".
"""

import math
from dataclasses import dataclass, field

import numpy as np

from . import grid as gridlib

PUNKT_URL = "https://api.kartverket.no/stedsnavn/v1/punkt"
QUERY_RADIUS_M = 5000
PAGE_SIZE = 500
MAX_RESULTS = 5000
MAX_SPLIT_DEPTH = 3
SAMPLE_RADIUS_M = 30.0

PLACE_TYPES = ("Fjell", "Topp", "Haug", "\u00c5s", "Berg", "H\u00f8yde", "Rygg", "Egg", "Hei",
               "Fjellomr\u00e5de")


@dataclass
class Candidate:
    name: str
    type: str
    e: float
    n: float
    number: object = None


@dataclass
class Place:
    name: str
    type: str
    e: float
    n: float
    h: float
    level: str
    offset_m: float


@dataclass
class NameSearch:
    candidates: list = field(default_factory=list)
    requests: int = 0
    squares: int = 0
    splits: int = 0
    truncated: int = 0
    names_seen: int = 0
    types_seen: dict = field(default_factory=dict)

    def stats(self):
        kept = {}
        for c in self.candidates:
            kept[c.type] = kept.get(c.type, 0) + 1
        return {"requests": self.requests, "squares": self.squares, "splits": self.splits,
                "truncated_squares": self.truncated,
                "names_seen": self.names_seen, "kept": len(self.candidates),
                "kept_by_type": dict(sorted(kept.items()))}


def choose_spelling(names):
    """The spelling to show from a place's list of stedsnavn entries, or None."""
    usable = []
    for index, entry in enumerate(names or []):
        status = (entry.get("skrivem\u00e5testatus") or "").lower()
        if "historisk" in status or status.startswith("foresl"):
            continue
        text = entry.get("skrivem\u00e5te")
        if not text:
            continue
        usable.append(((entry.get("navnestatus") != "hovednavn", "prioritert" not in status,
                        index), text))
    return min(usable)[1] if usable else None


def squares_for_disk(e0, n0, radius, query_radius=QUERY_RADIUS_M):
    """(centre e, centre n, half side) of squares covering the disk, circumradius query_radius."""
    half = query_radius / math.sqrt(2.0)
    side = 2.0 * half
    count = int(math.ceil(2.0 * radius / side))
    start_e = e0 - count * side / 2.0
    start_n = n0 - count * side / 2.0
    out = []
    for a in range(count):
        for b in range(count):
            ce = start_e + (a + 0.5) * side
            cn = start_n + (b + 0.5) * side
            dx = max(abs(ce - e0) - half, 0.0)
            dy = max(abs(cn - n0) - half, 0.0)
            if math.hypot(dx, dy) <= radius:
                out.append((ce, cn, half))
    return out


def _query_square(client, ce, cn, half, epsg, search, depth=0):
    radius = int(math.ceil(half * math.sqrt(2.0)))
    page, found, total = 1, [], None
    while True:
        params = {"nord": int(round(cn)), "ost": int(round(ce)), "koordsys": epsg,
                  "utkoordsys": epsg, "radius": radius, "treffPerSide": PAGE_SIZE, "side": page}
        data = client.get(PUNKT_URL, params=params).raise_for_status().json()
        search.requests += 1
        meta = data.get("metadata") or {}
        total = int(meta.get("totaltAntallTreff") or 0)
        if total > MAX_RESULTS and depth >= MAX_SPLIT_DEPTH and page == 1:
            search.truncated += 1
        if total > MAX_RESULTS and depth < MAX_SPLIT_DEPTH:
            search.splits += 1
            quarter = half / 2.0
            out = []
            for de in (-quarter, quarter):
                for dn in (-quarter, quarter):
                    out += _query_square(client, ce + de, cn + dn, quarter, epsg, search, depth + 1)
            return out
        names = data.get("navn") or []
        found += names
        if not names or len(found) >= min(total, MAX_RESULTS) or page * PAGE_SIZE >= total:
            break
        page += 1
    kept = []
    for item in found:
        point = item.get("representasjonspunkt") or {}
        e = point.get("\u00f8st")
        n = point.get("nord")
        if e is None or n is None:
            continue
        if abs(e - ce) > half + 1e-6 or abs(n - cn) > half + 1e-6:
            continue            # another square owns it (a point on a shared edge: both)
        kept.append((item, float(e), float(n)))
    return kept


def fetch_names(client, e0, n0, radius, epsg=25832):
    """Terrain-feature names within `radius` of (e0, n0), in grid coordinates."""
    search = NameSearch()
    seen = set()
    for ce, cn, half in squares_for_disk(e0, n0, radius):
        search.squares += 1
        for item, e, n in _query_square(client, ce, cn, half, epsg, search):
            key = (item.get("stedsnummer"), round(e, 1), round(n, 1))
            if key in seen:
                continue
            seen.add(key)
            search.names_seen += 1
            kind = item.get("navneobjekttype") or ""
            search.types_seen[kind] = search.types_seen.get(kind, 0) + 1
            if kind not in PLACE_TYPES or item.get("stedstatus", "aktiv") != "aktiv":
                continue
            if (e - e0) ** 2 + (n - n0) ** 2 > radius * radius:
                continue
            name = choose_spelling(item.get("stedsnavn"))
            if name:
                search.candidates.append(Candidate(name=name, type=kind, e=e, n=n,
                                                   number=item.get("stedsnummer")))
    return search


def keep_candidates(candidates, e0, n0, radius):
    """Candidates of a kept type inside the disk (for sources other than the API)."""
    return [c for c in candidates if c.type in PLACE_TYPES
            and (c.e - e0) ** 2 + (c.n - n0) ** 2 <= radius * radius]


def highest_nearby(level, chunkset, e, n, radius=SAMPLE_RADIUS_M):
    """(height, e, n) of the highest sample within `radius` of (e, n), or None.

    Only the chunks' own samples are used (not the aprons, which repeat them).
    Ties go to the northmost, then westmost sample.
    """
    s, c = level.side, level.cell
    best = None
    for i in range(math.floor((e - radius) / s), math.floor((e + radius) / s) + 1):
        for j in range(math.floor((n - radius) / s), math.floor((n + radius) / s) + 1):
            heights = chunkset.get((i, j))
            if heights is None:
                continue
            east, north = gridlib.sample_centres(level, i, j)
            a = level.apron
            east, north = east[a:-a or None], north[a:-a or None]
            inner = np.asarray(heights, dtype=np.float64)[a:-a or None, a:-a or None]
            d2 = (east[None, :] - e) ** 2 + (north[:, None] - n) ** 2
            mask = d2 <= radius * radius
            if not mask.any():
                continue
            values = np.where(mask, inner, -np.inf)
            r, q = np.unravel_index(int(np.argmax(values)), values.shape)
            candidate = (float(values[r, q]), float(north[r]), -float(east[q]))
            if best is None or candidate > best:
                best = candidate
    if best is None:
        return None
    h, north_best, minus_east = best
    return h, -minus_east, north_best


def covers_disk(level, chunkset, e, n, radius):
    """Does `chunkset` hold every chunk of `level` that the disk of `radius` around (e, n) touches?"""
    s = level.side
    for i in range(math.floor((e - radius) / s), math.floor((e + radius) / s) + 1):
        for j in range(math.floor((n - radius) / s), math.floor((n + radius) / s) + 1):
            if gridlib.square_distance(level, i, j, e, n) <= radius and (i, j) not in chunkset:
                return False
    return True


def sample_heights(candidates, chunks, levels, radius=SAMPLE_RADIUS_M):
    """Places with heights from the finest level whose chunks hold each candidate's whole disk."""
    ordered = sorted(levels, key=lambda lv: lv.cell)
    out = []
    for cand in candidates:
        for level in ordered:
            chunkset = chunks.get(level.name) or {}
            if not covers_disk(level, chunkset, cand.e, cand.n, radius):
                continue
            found = highest_nearby(level, chunkset, cand.e, cand.n, radius)
            if found is None:
                continue
            h, e, n = found
            out.append(Place(name=cand.name, type=cand.type, e=e, n=n, h=h, level=level.name,
                             offset_m=math.hypot(e - cand.e, n - cand.n)))
            break
    return out


def places_record(places, origin):
    """The places.json object of FORMAT.md section 4, highest first."""
    oe, on = origin
    features = []
    for p in sorted(places, key=lambda p: (-round(p.h, 1), p.name, p.e, p.n)):
        features.append({"name": p.name, "type": p.type,
                         "x": round(p.e - oe, 1) + 0.0, "z": round(-(p.n - on), 1) + 0.0,
                         "h": round(p.h, 1) + 0.0})
    return {"version": 1, "features": features}


def spot_height_check(places, spot_heights, max_distance=50.0):
    """Compare sampled place heights with N50 spot heights near the same summit."""
    diffs = []
    for p in places:
        near = [s for s in spot_heights if math.hypot(s.e - p.e, s.n - p.n) <= max_distance]
        if near:
            nearest = min(near, key=lambda s: math.hypot(s.e - p.e, s.n - p.n))
            diffs.append(p.h - nearest.h)
    if not diffs:
        return {"compared": 0}
    diffs = np.asarray(diffs)
    return {"compared": int(len(diffs)),
            "median_abs_diff_m": round(float(np.median(np.abs(diffs))), 2),
            "max_abs_diff_m": round(float(np.max(np.abs(diffs))), 2),
            "note": "sampled terrain height minus the nearest N50 spot height within 50 m"}
