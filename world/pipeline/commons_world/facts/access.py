"""Peaks, trailheads and walking routes from the house, on Kartverket's path network.

The network
-----------
Centre lines, all in the world's grid:
- NVDB Vegnett Pluss road links: roads, footways and cycleways (and the few
  paths and tractor roads it holds), including its short connection links,
  which join footways to the carriageway network;
- Turrutebasen foot routes;
- N50 Kartdata paths and tractor tracks (typeVeg sti, traktorveg), since
  Vegnett Pluss holds almost none.
Ferries are never read. Lines underground or inside buildings (SOSI medium U,
B, J: tunnels) are left out. Bridges (medium L) are kept, and their heights
are interpolated between the ends of the line rather than draped over the
water or valley below.

Every road is taken as walkable. NVDB's walking bans and motorway status are
not read.

Joining lines: a line's end within 2 m of the inside of another line's
segment is joined to it (a vertex is inserted there), and then any vertices
within 2 m of each other are merged (single linkage). The inside of a bridge
takes part in neither, so a bridge never joins a road passing under it.

Heights along the lines are sampled every 5 m or closer: from the world's 1 m
terrain within 1.5 km of the origin, else from a 10 m raster covering the
15 km disk, else from the 50 m raster. The route records how far it ran on
each. Climb on coarse terrain is understated: small ups and downs between
samples, and the tops of short rises, are smoothed away.

Routes
------
Shortest by length (networkx Dijkstra). The start is the house (the centre
of its footprint, or the address point if no house was identified), joined
to the nearest point of the network among connected parts holding at least
1 km of lines; the join's length is reported, not added. Each summit is
joined to the nearest point of the start's connected network, and that
point is the route's end.

- climb_m: the sum of every rise along the route's samples;
- naismith_h: 5 km/h, plus 1 h per 600 m of climb (Naismith 1892);
- tobler_h: the route's time at Tobler's (1993) hiking speed,
  6 exp(-3.5 |s + 0.05|) km/h, on each sample step's signed slope s;
- reaches_summit: the route's end lies within 50 m horizontally and 20 m in
  height of the summit; gap_m is the horizontal distance.

Peaks and trailheads
--------------------
Peaks are named places (Kartverket's place-name register, as in places.json)
of the types in PEAK_TYPES within 15 km of the house in a straight line. The
nearest five and the highest five are reported. Heights are re-measured on a
fresh 1 m terrain square of 200 m around each shortlisted place's point,
because the 5 m and 20 m levels flatten summits; the highest five are chosen
after that. The summit is the highest ground in the square that can be
reached from the place's point without dropping more than 2 m below it (so a
separate hill across a valley is not taken), provided it is a top: the
highest ground within 20 m all round, read beyond the square where the
square stops short. If it is not (the ground rises on past the square), the
highest such ground within 30 m of the place's point is tried; if that is no
top either, there is no distinct top near the name, and the height at the
place's point is kept. h_basis says which, and flags a summit more than 50 m
from the place's point, which may be a neighbouring top rather than the one
named.

A trailhead is a junction where a path, track or marked route (kind "path")
meets a road or footway and leads onto at least 500 m of path, or a
Turrutebasen route information point whose facility code is a parking code.
The five nearest by route are reported, no two within 50 m of each other.
"""

import math
from dataclasses import dataclass, field

import networkx as nx
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

PEAK_TYPES = ("Fjell", "Topp", "Haug", "\u00c5s", "Berg", "H\u00f8yde", "Rygg", "Egg", "Hei")
PEAK_RADIUS_M = 15000.0
NEAREST_COUNT = 5
HIGHEST_COUNT = 5
NEAREST_SHORTLIST = 8
HIGHEST_SHORTLIST = 10
SUMMIT_SQUARE_M = 200
SUMMIT_SAME_M = 50.0
SUMMIT_NEAR_M = 30.0
SUMMIT_TOP_M = 20          # a summit is the highest ground within this distance all round
SUMMIT_DROP_M = 2.0        # how far below the place's point the way up to its summit may dip
SUMMIT_FAR_M = 50.0        # a summit further than this from the place's point is flagged
SNAP_M = 2.0
SAMPLE_M = 5.0
H1_ELEVATION_RADIUS_M = 1500.0
REACH_H_M = 50.0
REACH_V_M = 20.0
SIMPLIFY_M = 5.0
TRAILHEAD_COUNT = 5
TRAILHEAD_MIN_TRAIL_M = 500.0
TRAILHEAD_SEPARATION_M = 50.0
# Turrutebasen's tilrettelegging codes are not documented in its schema; 22 was
# seen on points at car parks (commons_world/trails.py).
PARKING_CODES = (22,)
MIN_START_COMPONENT_M = 1000.0
WALK_KINDS = ("road", "footway", "path")
EXCLUDED_MEDIA = ("U", "B", "J")
BRIDGE_MEDIA = ("L",)
ROAD_SIDE = ("road", "footway")
TRAIL_SIDE = ("path",)


# -- walking-time rules ---------------------------------------------------------------

def tobler_kmh(slope):
    """Tobler's hiking function: walking speed in km/h on a signed slope (rise over run)."""
    return 6.0 * np.exp(-3.5 * np.abs(np.asarray(slope, dtype=np.float64) + 0.05))


def naismith_h(length_m, climb_m):
    """Naismith's rule: 5 km/h plus 1 h per 600 m of climb."""
    return length_m / 5000.0 + climb_m / 600.0


def reaches_summit(gap_h_m, gap_v_m, max_h=REACH_H_M, max_v=REACH_V_M):
    """Does a route ending gap_h_m away and gap_v_m below (or above) the summit reach it?"""
    if gap_h_m is None or gap_v_m is None:
        return False
    return bool(gap_h_m <= max_h and abs(gap_v_m) <= max_v)


def route_metrics(coords, heights):
    """(length m, climb m, descent m, tobler h) along sampled points, in travel order."""
    coords = np.asarray(coords, dtype=np.float64)
    heights = np.asarray(heights, dtype=np.float64)
    if len(coords) < 2:
        return 0.0, 0.0, 0.0, 0.0
    step = np.hypot(*np.diff(coords, axis=0).T)
    dh = np.diff(heights)
    keep = step > 1e-9
    slope = np.where(keep, dh / np.where(keep, step, 1.0), 0.0)
    hours = np.where(keep, step / 1000.0 / tobler_kmh(slope), 0.0)
    return (float(step.sum()), float(dh[dh > 0].sum()), float(-dh[dh < 0].sum()),
            float(hours.sum()))


# -- heights along the network ---------------------------------------------------------

class Elevation:
    """Terrain heights for network points: 1 m near the origin, else 10 m, else 50 m.

    `layers` is a list of (Layer, resolution m, max distance from the origin or None).
    """

    def __init__(self, layers, origin):
        self.layers = layers
        self.origin = origin

    def __call__(self, e, n):
        e = np.asarray(e, dtype=np.float64)
        n = np.asarray(n, dtype=np.float64)
        h = np.full(e.shape, np.nan)
        res = np.zeros(e.shape, dtype=np.int16)
        dist = np.hypot(e - self.origin[0], n - self.origin[1])
        for layer, resolution, max_dist in self.layers:
            todo = ~np.isfinite(h)
            if max_dist is not None:
                todo &= dist <= max_dist
            if not todo.any():
                continue
            values = layer.sample(e[todo], n[todo])
            got = np.isfinite(values)
            idx = np.flatnonzero(todo)[got]
            h[idx] = values[got]
            res[idx] = resolution
        missing = ~np.isfinite(h)
        h[missing] = 0.0
        return h, res


# -- the network ------------------------------------------------------------------------

@dataclass
class Edge:
    u: int
    v: int
    coords: np.ndarray
    heights: np.ndarray
    res: np.ndarray
    kind: str
    source: str
    length: float
    parent: int = -1


@dataclass
class Network:
    graph: nx.Graph
    nodes: list                    # [(e, n)]
    edges: list                    # [Edge]
    children: dict = field(default_factory=dict)   # split edge id -> [edge ids]
    stats: dict = field(default_factory=dict)

    def add_node(self, e, n):
        self.nodes.append((float(e), float(n)))
        return len(self.nodes) - 1

    def add_edge(self, edge):
        self.edges.append(edge)
        eid = len(self.edges) - 1
        if edge.u == edge.v:
            return eid
        g = self.graph
        if g.has_edge(edge.u, edge.v) and g[edge.u][edge.v]["length"] <= edge.length:
            return eid
        g.add_edge(edge.u, edge.v, length=edge.length, eid=eid)
        return eid

    def pieces(self, eid):
        """The current edges that edge `eid` has been split into (itself if never split)."""
        if eid not in self.children:
            return [eid]
        out = []
        for child in self.children[eid]:
            out += self.pieces(child)
        return out

    def geometry(self, eid):
        return LineString(self.edges[eid].coords)


def clean_lines(lines):
    """Walkable lines as (coords, kind, is_bridge, source); tunnels and the like left out."""
    out, dropped = [], {}
    for line in lines:
        if line.kind not in WALK_KINDS:
            continue
        if (line.medium or "") in EXCLUDED_MEDIA:
            dropped["underground or in a building"] = dropped.get(
                "underground or in a building", 0) + 1
            continue
        coords = np.asarray(line.coords, dtype=np.float64)[:, :2]
        if len(coords) < 2:
            continue
        keep = np.ones(len(coords), dtype=bool)
        keep[1:] = np.hypot(*np.diff(coords, axis=0).T) > 1e-6
        coords = coords[keep]
        if len(coords) < 2:
            continue
        out.append((coords, line.kind, (line.medium or "") in BRIDGE_MEDIA,
                    "{}:{}".format(line.source, line.kind)))
    return out, dropped


def insert_t_junctions(lines, snap=SNAP_M):
    """Insert a vertex wherever another line's end lies within `snap` of a segment's inside."""
    segs, owners = [], []
    for li, (coords, _, bridge, _) in enumerate(lines):
        if bridge:
            continue
        for si in range(len(coords) - 1):
            segs.append(LineString(coords[si:si + 2]))
            owners.append((li, si))
    if not segs:
        return lines, 0
    tree = STRtree(segs)
    inserts = {}
    ends = []
    for li, (coords, _, _, _) in enumerate(lines):
        ends.append((li, coords[0]))
        ends.append((li, coords[-1]))
    points = [Point(p) for _, p in ends]
    hits_src, hits_seg = tree.query(points, predicate="dwithin", distance=snap)
    for pi, si in zip(hits_src, hits_seg):
        li_end, p = ends[pi]
        li, seg = owners[si]
        coords = lines[li][0]
        a, b = coords[seg], coords[seg + 1]
        ab = b - a
        t = float(np.dot(p - a, ab) / np.dot(ab, ab))
        if t <= 0.0 or t >= 1.0:
            continue
        q = a + t * ab
        if np.hypot(*(q - p)) > snap or np.hypot(*(q - a)) <= snap or np.hypot(*(q - b)) <= snap:
            continue
        inserts.setdefault((li, seg), []).append((t, q))
    count = 0
    out = []
    for li, (coords, kind, bridge, source) in enumerate(lines):
        pts = [coords[0]]
        for seg in range(len(coords) - 1):
            for t, q in sorted(inserts.get((li, seg), []), key=lambda item: item[0]):
                if np.hypot(*(q - pts[-1])) > 1e-6:
                    pts.append(q)
                    count += 1
            pts.append(coords[seg + 1])
        out.append((np.asarray(pts), kind, bridge, source))
    return out, count


def _union_find(n, pairs):
    parent = np.arange(n)

    def find(x):
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb
    return np.array([find(i) for i in range(n)])


def _densify(a, b, sample):
    length = float(np.hypot(*(b - a)))
    m = max(1, int(math.ceil(length / sample - 1e-9)))
    t = np.linspace(0.0, 1.0, m + 1)
    return a[None, :] + t[:, None] * (b - a)[None, :], length


def build_network(lines, elevation, snap=SNAP_M, sample=SAMPLE_M):
    """A Network from Line objects: nodes at (merged) vertices, one edge per segment."""
    cleaned, dropped = clean_lines(lines)
    cleaned, inserted = insert_t_junctions(cleaned, snap)
    # Vertices that may merge: every vertex, except the inside of a bridge.
    vert_xy, vert_line, snappable = [], [], []
    for li, (coords, _, bridge, _) in enumerate(cleaned):
        for vi in range(len(coords)):
            vert_xy.append(coords[vi])
            vert_line.append(li)
            snappable.append(not bridge or vi in (0, len(coords) - 1))
    vert_xy = np.asarray(vert_xy, dtype=np.float64).reshape(-1, 2)
    snappable = np.asarray(snappable, dtype=bool)
    idx = np.flatnonzero(snappable)
    pairs = []
    if len(idx) > 1:
        tree = cKDTree(vert_xy[idx])
        pairs = [(idx[a], idx[b]) for a, b in tree.query_pairs(snap, output_type="ndarray")]
    roots = _union_find(len(vert_xy), pairs)
    node_of_root = {}
    net = Network(graph=nx.Graph(), nodes=[], edges=[])
    vert_node = np.empty(len(vert_xy), dtype=np.int64)
    for k in range(len(vert_xy)):
        r = int(roots[k])
        if r not in node_of_root:
            node_of_root[r] = net.add_node(*vert_xy[r])
        vert_node[k] = node_of_root[r]
    # Dense samples for every segment, heights in one call.
    dense_all, seg_ranges = [], []
    start = 0
    for li, (coords, kind, bridge, source) in enumerate(cleaned):
        for si in range(len(coords) - 1):
            pts, length = _densify(coords[si], coords[si + 1], sample)
            dense_all.append(pts)
            seg_ranges.append((li, si, start, start + len(pts), length))
            start += len(pts)
    if not dense_all:
        net.stats = {"lines": 0, "edges": 0, "nodes": 0}
        return net
    dense = np.concatenate(dense_all)
    heights, res = elevation(dense[:, 0], dense[:, 1])
    # Bridges: heights interpolated along the whole line between its two ends.
    line_segments = {}
    for rec in seg_ranges:
        line_segments.setdefault(rec[0], []).append(rec)
    for li, (coords, kind, bridge, source) in enumerate(cleaned):
        if not bridge:
            continue
        recs = line_segments[li]
        idx_all = np.concatenate([np.arange(a, b) for _, _, a, b, _ in recs])
        pts = dense[idx_all]
        along = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        h0, h1 = heights[idx_all[0]], heights[idx_all[-1]]
        total = along[-1] if along[-1] > 0 else 1.0
        heights[idx_all] = h0 + (h1 - h0) * along / total
    vert_offset = np.cumsum([0] + [len(c[0]) for c in cleaned])
    for li, si, a, b, length in seg_ranges:
        coords, kind, bridge, source = cleaned[li]
        u = int(vert_node[vert_offset[li] + si])
        v = int(vert_node[vert_offset[li] + si + 1])
        net.add_edge(Edge(u=u, v=v, coords=dense[a:b].copy(), heights=heights[a:b].copy(),
                          res=res[a:b].copy(), kind=kind, source=source, length=length))
    total_length = sum(e.length for e in net.edges)
    by_source = {}
    for e in net.edges:
        by_source[e.source] = by_source.get(e.source, 0.0) + e.length
    net.stats = {"lines": len(cleaned), "t_junctions_inserted": inserted,
                 "vertices_merged": int(len(vert_xy) - len(net.nodes)),
                 "nodes": net.graph.number_of_nodes(), "edges": net.graph.number_of_edges(),
                 "length_km": round(total_length / 1000.0, 1),
                 "length_km_by_source": {k: round(v / 1000.0, 1)
                                         for k, v in sorted(by_source.items())},
                 "lines_left_out": dropped}
    return net


# -- joining points to the network ---------------------------------------------------------

def _project(coords, p):
    """(distance, segment index, t, point) of the nearest point of a polyline to p."""
    a = coords[:-1]
    ab = coords[1:] - a
    denom = np.einsum("ij,ij->i", ab, ab)
    t = np.where(denom > 0, np.einsum("ij,ij->i", p[None, :] - a, ab) / np.where(denom > 0, denom, 1), 0.0)
    t = np.clip(t, 0.0, 1.0)
    q = a + t[:, None] * ab
    d = np.hypot(*(q - p[None, :]).T)
    j = int(np.argmin(d))
    return float(d[j]), j, float(t[j]), q[j]


def split_edge(net, eid, p):
    """Join point p to edge `eid` at its nearest point: (node, distance, point)."""
    edge = net.edges[eid]
    dist, j, t, q = _project(edge.coords, np.asarray(p, dtype=np.float64))
    if np.hypot(*(q - edge.coords[0])) < 0.01:
        return edge.u, dist, edge.coords[0]
    if np.hypot(*(q - edge.coords[-1])) < 0.01:
        return edge.v, dist, edge.coords[-1]
    hq = float(edge.heights[j] + t * (edge.heights[j + 1] - edge.heights[j]))
    rq = int(edge.res[j] if t < 0.5 else edge.res[j + 1])
    node = net.add_node(*q)
    first = np.vstack([edge.coords[:j + 1], q])
    second = np.vstack([q, edge.coords[j + 1:]])
    parts = []
    for coords, hs, rs, (u, v) in (
            (first, np.append(edge.heights[:j + 1], hq), np.append(edge.res[:j + 1], rq),
             (edge.u, node)),
            (second, np.insert(edge.heights[j + 1:], 0, hq), np.insert(edge.res[j + 1:], 0, rq),
             (node, edge.v))):
        keep = np.ones(len(coords), dtype=bool)
        keep[1:] = np.hypot(*np.diff(coords, axis=0).T) > 1e-9
        coords, hs, rs = coords[keep], hs[keep], rs[keep]
        length = float(np.hypot(*np.diff(coords, axis=0).T).sum())
        parts.append(Edge(u=u, v=v, coords=coords, heights=hs, res=rs, kind=edge.kind,
                          source=edge.source, length=length, parent=eid))
    g = net.graph
    if g.has_edge(edge.u, edge.v) and g[edge.u][edge.v]["eid"] == eid:
        g.remove_edge(edge.u, edge.v)
    net.children[eid] = [net.add_edge(parts[0]), net.add_edge(parts[1])]
    return node, dist, q


class Joiner:
    """Joins points to the nearest point of a chosen set of original edges."""

    def __init__(self, net, edge_ids):
        self.net = net
        self.ids = list(edge_ids)
        self.tree = STRtree([net.geometry(e) for e in self.ids]) if self.ids else None

    def join(self, e, n):
        if self.tree is None:
            return None
        p = Point(e, n)
        hit = int(self.tree.query_nearest(p)[0])
        original = self.ids[hit]
        best = None
        for piece in self.net.pieces(original):
            d = self.net.geometry(piece).distance(p)
            if best is None or d < best[0]:
                best = (d, piece)
        return split_edge(self.net, best[1], (e, n))


def components(net):
    """{node: component id}, {component id: total length m}."""
    comp_of, length = {}, {}
    for k, nodes in enumerate(nx.connected_components(net.graph)):
        for node in nodes:
            comp_of[node] = k
        length[k] = 0.0
    for u, v, data in net.graph.edges(data=True):
        length[comp_of[u]] += data["length"]
    return comp_of, length


def graph_edge_ids(net):
    return [data["eid"] for _, _, data in net.graph.edges(data=True)]


def choose_start(net, e, n, min_component=MIN_START_COMPONENT_M):
    """Join the start to the nearest edge of a connected part with at least `min_component` m."""
    comp_of, length = components(net)
    big = [eid for eid in graph_edge_ids(net)
           if length[comp_of[net.edges[eid].u]] >= min_component]
    if not big:
        big = graph_edge_ids(net)
    if not big:
        return None
    nearest_any = Joiner(net, graph_edge_ids(net)).tree
    any_d = float(Point(e, n).distance(
        net.geometry(graph_edge_ids(net)[int(nearest_any.query_nearest(Point(e, n))[0])])))
    node, dist, q = Joiner(net, big).join(e, n)
    return {"node": node, "snap_m": dist, "point": q, "nearest_any_m": any_d}


def component_edges(net, node):
    """Original ids of the graph edges in the connected part holding `node`."""
    nodes = nx.node_connected_component(net.graph, node)
    return [data["eid"] for u, v, data in net.graph.edges(nodes, data=True)]


def route(net, pred, start, target):
    """(coords, heights, res) along the shortest path from start to target, in travel order."""
    path = [target]
    while path[-1] != start:
        path.append(pred[path[-1]][0])
    path.reverse()
    parts_c, parts_h, parts_r = [], [], []
    for a, b in zip(path[:-1], path[1:]):
        edge = net.edges[net.graph[a][b]["eid"]]
        if edge.u == a:
            c, h, r = edge.coords, edge.heights, edge.res
        else:
            c, h, r = edge.coords[::-1], edge.heights[::-1], edge.res[::-1]
        if parts_c and np.hypot(*(c[0] - parts_c[-1][-1])) < 1e-6:
            c, h, r = c[1:], h[1:], r[1:]      # a shared end; a joined gap (<= 2 m) is kept
        parts_c.append(c)
        parts_h.append(h)
        parts_r.append(r)
    if not parts_c:
        p = np.asarray([net.nodes[start]])
        return p, np.zeros(1), np.zeros(1, dtype=np.int16)
    return np.concatenate(parts_c), np.concatenate(parts_h), np.concatenate(parts_r)


def resolution_lengths(coords, res):
    """{"1": m, "10": m, ...}: route length on each terrain resolution (coarser end counts)."""
    if len(coords) < 2:
        return {}
    step = np.hypot(*np.diff(coords, axis=0).T)
    r = np.maximum(res[:-1], res[1:])
    return {str(int(k)): round(float(step[r == k].sum()), 1) for k in np.unique(r)}


def local_polyline(coords, origin, tolerance=SIMPLIFY_M):
    """Local [x, z] pairs, simplified (Douglas-Peucker) to `tolerance` m, rounded to 0.1 m."""
    if len(coords) == 0:
        return []
    x = coords[:, 0] - origin[0]
    z = -(coords[:, 1] - origin[1])
    if len(coords) == 1:
        return [[round(float(x[0]), 1), round(float(z[0]), 1)]]
    simple = LineString(np.column_stack([x, z])).simplify(tolerance, preserve_topology=False)
    return [[round(float(a), 1) + 0.0, round(float(b), 1) + 0.0] for a, b in simple.coords]


# -- trailheads ----------------------------------------------------------------------------

def trailhead_candidates(net, reachable, min_trail=TRAILHEAD_MIN_TRAIL_M):
    """[(node, trail length m)] where a path meets a road or footway and leads onto enough path."""
    kinds = {}
    for u, v, data in net.graph.edges(data=True):
        kind = net.edges[data["eid"]].kind
        kinds.setdefault(u, set()).add(kind)
        kinds.setdefault(v, set()).add(kind)
    trail_edges = [(u, v) for u, v, data in net.graph.edges(data=True)
                   if net.edges[data["eid"]].kind in TRAIL_SIDE]
    trail = net.graph.edge_subgraph(trail_edges)
    trail_len = {}
    for nodes in nx.connected_components(trail):
        sub = trail.subgraph(nodes)
        total = sum(d["length"] for _, _, d in sub.edges(data=True))
        for node in nodes:
            trail_len[node] = total
    out = []
    for node, ks in kinds.items():
        if node not in reachable or not (ks & set(ROAD_SIDE)) or not (ks & set(TRAIL_SIDE)):
            continue
        if trail_len.get(node, 0.0) >= min_trail:
            out.append((node, trail_len[node]))
    return out


# -- the whole access block -------------------------------------------------------------------

@dataclass
class PeakCandidate:
    name: str
    type: str
    e: float
    n: float
    h: float
    source: str


def peak_candidates(view, extra, house, radius=PEAK_RADIUS_M):
    """Named terrain features of PEAK_TYPES within `radius` of the house."""
    out = []
    for p in view.places:
        if p.type in PEAK_TYPES:
            out.append(PeakCandidate(p.name, p.type, p.e, p.n, p.h, "places.json"))
    out += [c for c in extra if c.type in PEAK_TYPES]
    return [c for c in out if math.hypot(c.e - house[0], c.n - house[1]) <= radius]


def remeasure(provider, e, n, square=SUMMIT_SQUARE_M, near=SUMMIT_NEAR_M, top=SUMMIT_TOP_M,
              drop=SUMMIT_DROP_M, far=SUMMIT_FAR_M):
    """(height, e, n, basis) of the summit near a place's point (e, n), on fresh 1 m terrain.

    The ground that counts is what can be reached from the place's point without
    dropping more than `drop` m below it (8-connected), so a separate hill across a
    valley is never taken for this one. Its highest sample in a `square` m square is
    the summit if it is a top: the highest reachable ground within `top` m all round
    (read beyond the square where the square stops short). If it is not, the ground
    rises on past the square, and the highest reachable sample within `near` m of
    (e, n) is tried the same way. If that is no top either, the ground at the place's
    point is still rising: there is no distinct top near the name, and the height at
    the place's point itself is returned. None where the square has no data there.
    """
    half = square // 2
    west = int(round(e)) - half
    north = int(round(n)) + half
    arr = provider.dtm((west, north - square, west + square, north), 1)
    if arr is None:
        return None
    arr = np.asarray(arr, dtype=np.float64)
    rows, cols = arr.shape
    r0 = min(max(int(math.floor(north - n)), 0), rows - 1)
    q0 = min(max(int(math.floor(e - west)), 0), cols - 1)
    h0 = arr[r0, q0]
    if not np.isfinite(h0):
        return None
    eight = np.ones((3, 3), dtype=bool)
    floor = h0 - drop
    labels, _ = ndimage.label(np.isfinite(arr) & (arr >= floor), structure=eight)
    reach = labels == labels[r0, q0]
    east = west + np.arange(cols) + 0.5
    northing = north - np.arange(rows) - 0.5
    k = int(math.ceil(top))
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    disk = yy * yy + xx * xx <= top * top

    def is_top(r, q):
        h = arr[r, q]
        if k <= r < rows - k and k <= q < cols - k:
            win = arr[r - k:r + k + 1, q - k:q + k + 1]
        else:
            x0, y1 = west + q - k, north - r + k      # a (2k+1) m square centred on the sample
            win = provider.dtm((x0, y1 - 2 * k - 1, x0 + 2 * k + 1, y1), 1)
            if win is None:
                return False
            win = np.asarray(win, dtype=np.float64)
        lab, _ = ndimage.label(np.isfinite(win) & (win >= floor), structure=eight)
        mine = (lab == lab[k, k]) & disk
        return bool(np.all(win[mine] <= h + 1e-6))

    def highest(mask):
        values = np.where(mask, arr, -np.inf)
        r, q = np.unravel_index(int(np.argmax(values)), values.shape)
        return r, q

    r, q = highest(reach)
    basis = "highest in the 200 m square"
    if not is_top(r, q):
        d2 = (east[None, :] - e) ** 2 + (northing[:, None] - n) ** 2
        r, q = highest(reach & (d2 <= near * near))
        basis = ("highest within {:.0f} m (the square's highest ground rises on past its "
                 "edge)").format(near)
        if not is_top(r, q):
            r, q = r0, q0
            basis = ("no distinct top within {:.0f} m of the place's point (the ground rises on "
                     "past it): the height at the place's point").format(near)
    se, sn = float(east[q]), float(northing[r])
    offset = math.hypot(se - e, sn - n)
    if offset > far:
        # whole metres rounded half up, as the viewer shows summit_offset_m
        basis += ("; {:d} m from the place's point, so possibly a neighbouring top rather "
                  "than the one named").format(int(math.floor(round(offset, 1) + 0.5)))
    return float(arr[r, q]), se, sn, basis


def select_peaks(candidates, provider, house, log=lambda m: None):
    """The nearest and the highest peaks, re-measured on 1 m terrain, as dicts."""
    def straight(c):
        return math.hypot(c.e - house[0], c.n - house[1])

    by_near = sorted(candidates, key=lambda c: (straight(c), c.name))[:NEAREST_SHORTLIST]
    by_high = sorted(candidates, key=lambda c: (-c.h, c.name))[:HIGHEST_SHORTLIST]
    shortlist = []
    for c in by_near + by_high:
        if c not in shortlist:
            shortlist.append(c)
    measured = []
    for c in shortlist:
        found = remeasure(provider, c.e, c.n)
        if found is None:
            h, e, n, basis = c.h, c.e, c.n, "not re-measured (no 1 m terrain)"
            fine = False
        else:
            h, e, n, basis = found
            fine = True
        measured.append({"cand": c, "h": h, "e": e, "n": n, "fine": fine, "basis": basis,
                         "offset": math.hypot(e - c.e, n - c.n)})
    log("peaks: {} candidates, {} re-measured".format(len(candidates), len(measured)))
    # Two names can sit on one summit: keep the name whose point is nearest it.
    kept = []
    for m in sorted(measured, key=lambda m: m["offset"]):
        if any(math.hypot(m["e"] - k["e"], m["n"] - k["n"]) <= SUMMIT_SAME_M for k in kept):
            continue
        kept.append(m)
    for m in kept:
        m["straight"] = math.hypot(m["e"] - house[0], m["n"] - house[1])
    nearest = sorted(kept, key=lambda m: (m["straight"], m["cand"].name))[:NEAREST_COUNT]
    highest = sorted(kept, key=lambda m: (-m["h"], m["cand"].name))[:HIGHEST_COUNT]
    near_ids = [id(m) for m in nearest]
    high_ids = [id(m) for m in highest]
    chosen = []
    for m in nearest + highest:
        if not any(m is c for c in chosen):
            chosen.append(m)
    for m in chosen:
        m["lists"] = (["nearest"] if id(m) in near_ids else []) + (
            ["highest"] if id(m) in high_ids else [])
        m["rank_nearest"] = near_ids.index(id(m)) + 1 if id(m) in near_ids else None
        m["rank_highest"] = high_ids.index(id(m)) + 1 if id(m) in high_ids else None
    return sorted(chosen, key=lambda m: m["straight"])


def access_facts(view, provider, net_inputs, elevation, log=lambda m: None):
    """The access block of facts.json."""
    origin = view.origin
    house_b = view.house
    if house_b is not None:
        c = house_b.polygon.centroid
        house = (float(c.x), float(c.y))
        basis = "centre of the house footprint"
    else:
        house = (float(origin[0]), float(origin[1]))
        basis = "address point (no house was identified)"
    net = build_network(net_inputs.lines, elevation)
    log("network: {} nodes, {} edges, {} km".format(net.stats.get("nodes"),
                                                   net.stats.get("edges"),
                                                   net.stats.get("length_km")))
    start = choose_start(net, *house)
    block_start = {"x": round(house[0] - origin[0], 1) + 0.0,
                   "z": round(-(house[1] - origin[1]), 1) + 0.0, "basis": basis}
    candidates = peak_candidates(view, net_inputs.extra_places, house)
    peaks = select_peaks(candidates, provider, house, log)
    if start is None:
        block_start["snap_m"] = None
        return {"start": block_start, "graph": net.stats, "peaks": [], "trailheads": [],
                "unreachable": "no walking network was found"}, net
    block_start["snap_m"] = round(start["snap_m"], 1)
    block_start["nearest_line_m"] = round(start["nearest_any_m"], 1)
    joiner = Joiner(net, component_edges(net, start["node"]))
    for m in peaks:
        node, dist, q = joiner.join(m["e"], m["n"])
        m["target"] = (node, dist, q)
    parking = []
    for p in net_inputs.info_points:
        if p.code in PARKING_CODES and math.hypot(p.e - house[0], p.n - house[1]) <= PEAK_RADIUS_M:
            node, dist, q = joiner.join(p.e, p.n)
            parking.append((node, dist, p))
    pred, dist_map = nx.dijkstra_predecessor_and_distance(net.graph, start["node"],
                                                          weight="length")
    out_peaks = []
    for m in peaks:
        node, gap, q = m["target"]
        c = m["cand"]
        straight = m["straight"]
        bearing = view.true_bearing(math.degrees(math.atan2(m["e"] - house[0],
                                                            m["n"] - house[1])) % 360.0)
        entry = {"name": c.name, "type": c.type, "h": round(m["h"], 1),
                 "h_places": round(c.h, 1), "h_measured_on_1m": m["fine"],
                 "h_basis": m["basis"],
                 "x": round(m["e"] - origin[0], 1) + 0.0,
                 "z": round(-(m["n"] - origin[1]), 1) + 0.0,
                 "summit_offset_m": round(m["offset"], 1),
                 "straight_m": round(straight, 1), "bearing_true_deg": round(bearing, 1),
                 "lists": m["lists"], "rank_nearest": m["rank_nearest"],
                 "rank_highest": m["rank_highest"]}
        if node not in dist_map:
            entry.update({"route_m": None, "climb_m": None, "naismith_h": None, "tobler_h": None,
                          "reaches_summit": False, "gap_m": round(gap, 1), "route": []})
            out_peaks.append(entry)
            continue
        coords, heights, res = route(net, pred, start["node"], node)
        length, climb, descent, tobler = route_metrics(coords, heights)
        end_h = float(heights[-1])
        entry.update({"route_m": round(length, 1), "climb_m": round(climb, 1),
                      "descent_m": round(descent, 1),
                      "naismith_h": round(naismith_h(length, climb), 2),
                      "tobler_h": round(tobler, 2),
                      "reaches_summit": reaches_summit(gap, m["h"] - end_h),
                      "gap_m": round(gap, 1), "gap_up_m": round(m["h"] - end_h, 1),
                      "route_m_by_terrain_cell": resolution_lengths(coords, res),
                      "route": local_polyline(coords, origin)})
        out_peaks.append(entry)
    candidates_th = [(node, "path leaves road", trail)
                     for node, trail in trailhead_candidates(net, dist_map)]
    candidates_th += [(node, "parking (Turrutebasen route information point)", None)
                      for node, _, p in parking if node in dist_map]
    candidates_th.sort(key=lambda item: dist_map[item[0]])
    chosen = []
    for node, kind, trail in candidates_th:
        e, n = net.nodes[node]
        if any(math.hypot(e - net.nodes[o][0], n - net.nodes[o][1]) < TRAILHEAD_SEPARATION_M
               for o, _, _ in chosen):
            continue
        chosen.append((node, kind, trail))
        if len(chosen) >= TRAILHEAD_COUNT:
            break
    trailheads = []
    for node, kind, trail in chosen:
        coords, heights, res = route(net, pred, start["node"], node)
        length, climb, descent, _ = route_metrics(coords, heights)
        e, n = net.nodes[node]
        entry = {"kind": kind, "x": round(e - origin[0], 1) + 0.0,
                 "z": round(-(n - origin[1]), 1) + 0.0,
                 "route_m": round(length, 1), "climb_m": round(climb, 1),
                 "straight_m": round(math.hypot(e - house[0], n - house[1]), 1)}
        if trail is not None:
            entry["path_network_m"] = round(trail, 1)
        trailheads.append(entry)
    block = {"start": block_start, "graph": net.stats, "peaks": out_peaks,
             "trailheads": trailheads,
             "candidates": {"peaks_within_15km": len(candidates),
                            "trailhead_junctions": len(candidates_th)}}
    return block, net
