"""Citation network analysis — pure-Python, no networkx/numpy/sklearn dependencies."""
import logging
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ── Stopwords for text overlap ────────────────────────────────────────────────

_STOP = {
    "the", "and", "for", "with", "this", "that", "are", "was", "from", "has",
    "its", "not", "but", "can", "been", "have", "were", "they", "which", "also",
    "into", "more", "than", "using", "used", "study", "result", "results",
    "analysis", "show", "shows", "shown", "found", "novel", "new", "based",
    "between", "both", "role", "may", "our", "these", "their", "here", "after",
    "through", "during", "within", "among", "further", "while", "however",
    "thus", "therefore", "indicate", "suggest", "reveals",
}


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class NetworkNode:
    id: str
    title: str
    authors: List[str]
    journal: str
    year: int
    doi: str
    research_area: str
    degree: int = 0
    cluster_id: Optional[int] = None
    degree_centrality: float = 0.0
    closeness_centrality: float = 0.0
    betweenness_approx: float = 0.0


@dataclass
class NetworkEdge:
    source: str
    target: str
    weight: float
    edge_type: str


@dataclass
class NetworkCluster:
    cluster_id: int
    size: int
    main_topic: str
    representative_ids: List[str]
    key_authors: List[str]
    density: float = 0.0
    modularity_contribution: float = 0.0


# ── DB / data helpers ─────────────────────────────────────────────────────────

def _db():
    try:
        from database.config import db
        return db if db.is_configured() else None
    except Exception:
        return None


def _load_refs(manuscript_id: Optional[str]) -> List[Dict]:
    if manuscript_id:
        try:
            from tools.references.service import get_references
            return get_references(manuscript_id, "", 0, 0, "")
        except Exception:
            return []
    db = _db()
    if db:
        try:
            from database.models import ReferenceEntry
            with db.get_session() as s:
                rows = s.query(ReferenceEntry).limit(300).all()
                return [r.to_dict() for r in rows]
        except Exception as e:
            logger.warning("citation_network DB: %s", e)
    try:
        from tools.references.service import _load_store
        return _load_store()
    except Exception:
        return []


# ── Text analysis helpers ─────────────────────────────────────────────────────

def _tokens(text: str) -> Set[str]:
    return {w for w in re.findall(r"\b[a-z]{3,}\b", text.lower()) if w not in _STOP}


def _text_overlap(t1: str, t2: str) -> float:
    ta, tb = _tokens(t1), _tokens(t2)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# ── Similarity computation ────────────────────────────────────────────────────

def _ref_similarity(r1: Dict, r2: Dict) -> Tuple[float, str]:
    score = 0.0
    etype = "content"

    # Author overlap (weight 0.35)
    a1 = set(r1.get("authors") or [])
    a2 = set(r2.get("authors") or [])
    if a1 and a2:
        overlap = len(a1 & a2)
        if overlap:
            score += 0.35 * overlap / max(len(a1), len(a2))
            etype = "author_overlap"

    # Same journal (0.20)
    j1 = (r1.get("journal") or "").lower().strip()
    j2 = (r2.get("journal") or "").lower().strip()
    if j1 and j1 == j2:
        score += 0.20
        if etype == "content":
            etype = "same_journal"

    # Temporal proximity (0.10)
    y1 = r1.get("year") or 0
    y2 = r2.get("year") or 0
    if y1 and y2:
        score += max(0.0, 0.10 * (1 - abs(y1 - y2) / 5.0))

    # Research area match (0.10)
    if r1.get("research_area") and r1.get("research_area") == r2.get("research_area"):
        score += 0.10

    # Keyword set overlap (0.10)
    kw1 = {k.lower() for k in (r1.get("keywords") or [])}
    kw2 = {k.lower() for k in (r2.get("keywords") or [])}
    if kw1 and kw2:
        score += 0.10 * len(kw1 & kw2) / max(len(kw1), len(kw2))

    # Content text overlap — title + abstract token Jaccard (0.15)
    t1 = f"{r1.get('title') or ''} {r1.get('abstract') or ''}"
    t2 = f"{r2.get('title') or ''} {r2.get('abstract') or ''}"
    score += 0.15 * _text_overlap(t1, t2)

    return score, etype


# ── Graph / community helpers ─────────────────────────────────────────────────

def _bfs_clusters(
    node_ids: List[str], adjacency: Dict[str, List[str]]
) -> Dict[str, int]:
    unvisited = set(node_ids)
    cluster_map: Dict[str, int] = {}
    cid = 0
    while unvisited:
        start = next(iter(unvisited))
        unvisited.discard(start)
        queue = [start]
        cluster_map[start] = cid
        while queue:
            node = queue.pop()
            for nb in adjacency.get(node, []):
                if nb in unvisited:
                    unvisited.discard(nb)
                    cluster_map[nb] = cid
                    queue.append(nb)
        cid += 1
    return cluster_map


def _bfs_distances(start: str, adjacency: Dict[str, List[str]]) -> Dict[str, int]:
    """BFS from start; returns distance dict (start=0)."""
    dist: Dict[str, int] = {start: 0}
    queue = [start]
    while queue:
        node = queue.pop(0)
        for nb in adjacency.get(node, []):
            if nb not in dist:
                dist[nb] = dist[node] + 1
                queue.append(nb)
    return dist


def _calculate_centrality(
    node_ids: List[str], adjacency: Dict[str, List[str]]
) -> Dict[str, Dict[str, float]]:
    """Return degree_centrality and closeness_centrality for every node."""
    n = len(node_ids)
    result: Dict[str, Dict[str, float]] = {}
    for nid in node_ids:
        degree = len(adjacency.get(nid, []))
        deg_c = degree / max(n - 1, 1)
        dists = _bfs_distances(nid, adjacency)
        reachable = len(dists) - 1
        if reachable > 0:
            sum_d = sum(d for nd, d in dists.items() if nd != nid)
            closeness = (reachable / max(sum_d, 1)) * (reachable / max(n - 1, 1))
        else:
            closeness = 0.0
        result[nid] = {"degree": round(deg_c, 4), "closeness": round(closeness, 4)}
    return result


def _approx_betweenness(
    node_ids: List[str], adjacency: Dict[str, List[str]], sample_size: int = 30
) -> Dict[str, float]:
    """Approximate betweenness centrality via Brandes algorithm on a sample of sources."""
    import random
    n = len(node_ids)
    if n <= 2:
        return {nid: 0.0 for nid in node_ids}

    between: Dict[str, float] = defaultdict(float)
    sources = random.sample(node_ids, min(sample_size, n))

    for source in sources:
        dist: Dict[str, int] = {source: 0}
        sigma: Dict[str, float] = defaultdict(float)
        sigma[source] = 1.0
        pred: Dict[str, List[str]] = defaultdict(list)
        queue = [source]
        order: List[str] = []

        while queue:
            v = queue.pop(0)
            order.append(v)
            for w in adjacency.get(v, []):
                if w not in dist:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist.get(w) == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)

        delta: Dict[str, float] = defaultdict(float)
        for w in reversed(order):
            for v in pred[w]:
                delta[v] += (sigma[v] / max(sigma[w], 1e-9)) * (1.0 + delta[w])
            if w != source:
                between[w] += delta[w]

    scale = 1.0 / max(len(sources) * max(n - 1, 1), 1)
    return {nid: round(between.get(nid, 0.0) * scale, 5) for nid in node_ids}


def _cluster_density(cluster_nodes: Set[str], adjacency: Dict[str, List[str]]) -> float:
    """Internal edge density for a cluster."""
    members = cluster_nodes
    m = len(members)
    if m < 2:
        return 0.0
    internal_edges = sum(
        1 for n in members
        for nb in adjacency.get(n, [])
        if nb in members
    ) // 2
    return round(2 * internal_edges / max(m * (m - 1), 1), 4)


def _modularity_contribution(
    cluster_nodes: Set[str],
    adjacency: Dict[str, List[str]],
    total_edges: int,
) -> float:
    """Rough modularity contribution for a cluster."""
    if total_edges == 0:
        return 0.0
    members = cluster_nodes
    internal_edges = sum(
        1 for n in members
        for nb in adjacency.get(n, [])
        if nb in members
    ) // 2
    degree_sum = sum(len(adjacency.get(n, [])) for n in members)
    lc = internal_edges / max(total_edges, 1)
    dc = (degree_sum / max(2 * total_edges, 1)) ** 2
    return round(lc - dc, 4)


# ── Collaboration graph helpers ───────────────────────────────────────────────

def _build_collab_data(refs: List[Dict]) -> Dict:
    """Extract co-authorship data from a list of references."""
    author_papers: Dict[str, List[str]] = defaultdict(list)
    collab_weights: Dict[Tuple[str, str], int] = defaultdict(int)
    collab_papers: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    author_areas: Dict[str, Counter] = defaultdict(Counter)
    author_years: Dict[str, List[int]] = defaultdict(list)

    for ref in refs:
        raw_authors = ref.get("authors") or []
        norm = [a.lower().strip() for a in raw_authors if a]
        rid = ref.get("id", "")
        year = ref.get("year") or 0
        area = ref.get("research_area") or "general"

        for a in norm:
            author_papers[a].append(rid)
            author_areas[a][area] += 1
            if year:
                author_years[a].append(year)

        for i, a1 in enumerate(norm):
            for a2 in norm[i + 1:]:
                key = (min(a1, a2), max(a1, a2))
                collab_weights[key] += 1
                collab_papers[key].append(rid)

    return {
        "author_papers": author_papers,
        "collab_weights": collab_weights,
        "collab_papers": collab_papers,
        "author_areas": author_areas,
        "author_years": author_years,
    }


def _detect_research_groups(
    author_papers: Dict[str, List[str]],
    collab_weights: Dict[Tuple[str, str], int],
    author_areas: Dict[str, Counter],
    min_weight: int = 1,
    max_groups: int = 15,
) -> Tuple[List[Dict], Dict[str, int]]:
    """BFS community detection on co-authorship graph.

    Returns (groups_list, cluster_map).
    """
    adj: Dict[str, List[str]] = defaultdict(list)
    for (a1, a2), w in collab_weights.items():
        if w >= min_weight:
            adj[a1].append(a2)
            adj[a2].append(a1)

    all_authors = list(author_papers.keys())
    cluster_map = _bfs_clusters(all_authors, adj)

    groups: Dict[int, List[str]] = defaultdict(list)
    for author, gid in cluster_map.items():
        groups[gid].append(author)

    result = []
    for gid, members in sorted(groups.items(), key=lambda x: -len(x[1]))[:max_groups]:
        if len(members) < 2:
            continue
        influence = {
            a: len(author_papers.get(a, [])) + len(adj.get(a, [])) * 0.5
            for a in members
        }
        key_authors = sorted(members, key=lambda a: influence.get(a, 0), reverse=True)[:5]
        area_counts: Counter = Counter()
        for a in members:
            area_counts.update(author_areas.get(a, {}))
        main_area = area_counts.most_common(1)[0][0] if area_counts else "general"
        result.append({
            "group_id": gid,
            "size": len(members),
            "key_authors": key_authors,
            "main_area": main_area,
            "total_papers": sum(len(author_papers.get(a, [])) for a in members),
        })

    return result, cluster_map


def _find_bridge_authors(
    author_papers: Dict[str, List[str]],
    collab_weights: Dict[Tuple[str, str], int],
    cluster_map: Dict[str, int],
    max_bridges: int = 10,
) -> List[Dict]:
    """Authors who collaborate across multiple research groups."""
    bridges: List[Dict] = []
    for author in author_papers:
        home = cluster_map.get(author)
        if home is None:
            continue
        foreign: Set[int] = set()
        for (a1, a2) in collab_weights:
            partner = None
            if a1 == author:
                partner = a2
            elif a2 == author:
                partner = a1
            if partner is not None:
                other_group = cluster_map.get(partner)
                if other_group is not None and other_group != home:
                    foreign.add(other_group)
        if foreign:
            bridges.append({
                "author": author,
                "home_group": home,
                "bridges_to_groups": len(foreign),
                "papers": len(author_papers.get(author, [])),
            })
    return sorted(bridges, key=lambda x: -x["bridges_to_groups"])[:max_bridges]


# ── Service class ─────────────────────────────────────────────────────────────

class CitationNetworkService:
    THRESHOLD = 0.20   # reduced slightly so content-text similarity can contribute
    MAX_REFS = 150

    # ── Citation network ──────────────────────────────────────────────────────

    def build_citation_network(self, manuscript_id: Optional[str] = None) -> Dict:
        try:
            refs = _load_refs(manuscript_id)[: self.MAX_REFS]
            if not refs:
                return {"success": True, "nodes": [], "edges": [], "clusters": [], "metrics": {}}

            adjacency: Dict[str, List[str]] = defaultdict(list)
            edges_out = []

            for i, r1 in enumerate(refs):
                for r2 in refs[i + 1:]:
                    score, etype = _ref_similarity(r1, r2)
                    if score >= self.THRESHOLD:
                        id1, id2 = r1.get("id", ""), r2.get("id", "")
                        edges_out.append(
                            {"source": id1, "target": id2,
                             "weight": round(score, 3), "type": etype}
                        )
                        adjacency[id1].append(id2)
                        adjacency[id2].append(id1)

            node_ids = [r.get("id", "") for r in refs]
            clusters_by_id = _bfs_clusters(node_ids, adjacency)

            # Centrality metrics
            centrality = _calculate_centrality(node_ids, adjacency)
            betweenness = _approx_betweenness(node_ids, adjacency)

            # Cluster summaries
            cluster_groups: Dict[int, List[Dict]] = defaultdict(list)
            for ref in refs:
                cid = clusters_by_id.get(ref.get("id", ""))
                if cid is not None:
                    cluster_groups[cid].append(ref)

            total_edges = len(edges_out)
            clusters_out = []
            for cid, crefs in cluster_groups.items():
                member_ids = {r.get("id", "") for r in crefs}
                area_counts: Counter = Counter(
                    r.get("research_area", "general") for r in crefs
                )
                main_topic = area_counts.most_common(1)[0][0]
                auth_counts: Counter = Counter()
                for r in crefs:
                    for a in r.get("authors") or []:
                        auth_counts[a] += 1
                key_authors = [a for a, _ in auth_counts.most_common(3)]
                sorted_by_degree = sorted(
                    crefs,
                    key=lambda r: len(adjacency.get(r.get("id", ""), [])),
                    reverse=True,
                )
                density = _cluster_density(member_ids, adjacency)
                mod_contrib = _modularity_contribution(member_ids, adjacency, total_edges)
                clusters_out.append({
                    "id": cid,
                    "size": len(crefs),
                    "topic": main_topic,
                    "representatives": [r.get("id", "") for r in sorted_by_degree[:3]],
                    "key_authors": key_authors,
                    "density": density,
                    "modularity_contribution": mod_contrib,
                })

            nodes_out = []
            for r in refs:
                nid = r.get("id", "")
                c = centrality.get(nid, {})
                nodes_out.append({
                    "id": nid,
                    "title": (r.get("title") or "")[:80],
                    "authors": r.get("authors") or [],
                    "journal": r.get("journal") or "",
                    "year": r.get("year") or 0,
                    "doi": r.get("doi") or "",
                    "research_area": r.get("research_area") or "",
                    "degree": len(adjacency.get(nid, [])),
                    "cluster_id": clusters_by_id.get(nid),
                    "degree_centrality": c.get("degree", 0.0),
                    "closeness_centrality": c.get("closeness", 0.0),
                    "betweenness_approx": betweenness.get(nid, 0.0),
                })

            n = len(refs)
            degrees = [len(adjacency.get(r.get("id", ""), [])) for r in refs]
            metrics = {
                "node_count": n,
                "edge_count": len(edges_out),
                "avg_degree": round(statistics.mean(degrees), 2) if degrees else 0,
                "density": round(2 * len(edges_out) / max(n * (n - 1), 1), 4),
                "cluster_count": len(clusters_out),
                "avg_degree_centrality": round(
                    statistics.mean(c.get("degree", 0) for c in centrality.values()), 4
                ) if centrality else 0,
                "avg_closeness_centrality": round(
                    statistics.mean(c.get("closeness", 0) for c in centrality.values()), 4
                ) if centrality else 0,
            }

            return {
                "success": True,
                "nodes": nodes_out,
                "edges": edges_out,
                "clusters": clusters_out,
                "metrics": metrics,
            }
        except Exception as e:
            logger.error("build_citation_network: %s", e)
            return {"success": False, "error": str(e)}

    # ── Collaboration network ─────────────────────────────────────────────────

    def build_collaboration_network(self, manuscript_id: Optional[str] = None) -> Dict:
        """Build and analyse co-authorship network with group and bridge detection."""
        try:
            refs = _load_refs(manuscript_id)
            if not refs:
                return {
                    "success": True,
                    "nodes": [], "edges": [],
                    "research_groups": [], "bridge_authors": [],
                    "top_collaborators": [], "collaboration_patterns": {},
                    "metrics": {},
                }

            data = _build_collab_data(refs)
            ap = data["author_papers"]
            cw = data["collab_weights"]
            cp = data["collab_papers"]
            areas = data["author_areas"]
            years = data["author_years"]

            # Research groups + cluster map
            groups, cluster_map = _detect_research_groups(ap, cw, areas)

            # Bridge authors
            bridges = _find_bridge_authors(ap, cw, cluster_map)

            # Top collaborators by influence score
            top_collabs = sorted(
                ap.keys(),
                key=lambda a: len(ap[a]) + len({
                    (min(a, b), max(a, b)) for (a2, b2) in cw if a2 == a or b2 == a
                    for a, b in [((a2, b2)[0], (a2, b2)[1])]
                }) * 0.5,
                reverse=True,
            )[:20]

            nodes_out = []
            for author in ap:
                all_years = years.get(author, [])
                area_top = areas[author].most_common(1)[0][0] if areas[author] else "general"
                collab_count = sum(1 for (a1, a2) in cw if a1 == author or a2 == author)
                nodes_out.append({
                    "id": author,
                    "label": author,
                    "papers": len(ap[author]),
                    "collaborators": collab_count,
                    "main_area": area_top,
                    "group_id": cluster_map.get(author),
                    "active_since": min(all_years) if all_years else None,
                    "active_until": max(all_years) if all_years else None,
                    "influence_score": round(len(ap[author]) + collab_count * 0.5, 2),
                    "size": min(8 + len(ap[author]) * 3, 30),
                })

            seen: Set[Tuple[str, str]] = set()
            edges_out = []
            for (a1, a2), w in cw.items():
                key = (a1, a2)
                if key not in seen:
                    seen.add(key)
                    edges_out.append({
                        "source": a1,
                        "target": a2,
                        "weight": w,
                        "papers": cp.get(key, []),
                    })

            # Collaboration patterns: year distribution of collaborative papers
            year_counter: Counter = Counter()
            for ref in refs:
                authors = ref.get("authors") or []
                if len(authors) >= 2:
                    y = ref.get("year")
                    if y:
                        year_counter[y] += 1

            collab_patterns = {
                "temporal": [
                    {"year": y, "collaborative_papers": c}
                    for y, c in sorted(year_counter.items())
                ][-15:],
                "avg_authors_per_paper": round(
                    statistics.mean(len(r.get("authors") or []) for r in refs), 2
                ) if refs else 0,
                "multi_author_ratio": round(
                    sum(1 for r in refs if len(r.get("authors") or []) >= 2) / max(len(refs), 1), 2
                ),
            }

            metrics = {
                "total_authors": len(ap),
                "total_collaborations": len(edges_out),
                "research_groups": len(groups),
                "bridge_authors": len(bridges),
                "avg_papers_per_author": round(
                    statistics.mean(len(v) for v in ap.values()), 2
                ) if ap else 0,
            }

            return {
                "success": True,
                "nodes": nodes_out,
                "edges": edges_out[:400],
                "research_groups": groups,
                "bridge_authors": bridges,
                "top_collaborators": [
                    {"author": a, "papers": len(ap[a]),
                     "influence_score": round(len(ap[a]) + sum(
                         1 for k in cw if a in k
                     ) * 0.5, 2)}
                    for a in top_collabs
                ],
                "collaboration_patterns": collab_patterns,
                "metrics": metrics,
            }
        except Exception as e:
            logger.error("build_collaboration_network: %s", e)
            return {"success": False, "error": str(e)}

    # ── Author influence network (existing, unchanged API) ────────────────────

    def get_author_influence_network(self, manuscript_id: Optional[str] = None) -> Dict:
        try:
            refs = _load_refs(manuscript_id)
            author_papers: Counter = Counter()
            coauthors: Dict[str, set] = defaultdict(set)

            for ref in refs:
                authors = ref.get("authors") or []
                for a in authors:
                    author_papers[a] += 1
                for i, a1 in enumerate(authors):
                    for a2 in authors[i + 1:]:
                        coauthors[a1].add(a2)
                        coauthors[a2].add(a1)

            nodes_out = []
            for author, count in author_papers.most_common(50):
                collabs = len(coauthors.get(author, set()))
                nodes_out.append({
                    "id": author,
                    "label": author,
                    "papers": count,
                    "collaborators": collabs,
                    "influence_score": round(count + collabs * 0.5, 2),
                    "size": min(8 + count * 3, 30),
                })

            seen: Set[Tuple[str, str]] = set()
            edges_out = []
            for a1, partners in coauthors.items():
                if author_papers.get(a1, 0) < 1:
                    continue
                for a2 in partners:
                    key = tuple(sorted([a1, a2]))
                    if key not in seen:
                        seen.add(key)
                        edges_out.append({"source": a1, "target": a2, "weight": 1})

            return {
                "success": True,
                "nodes": nodes_out,
                "edges": edges_out[:300],
                "metrics": {
                    "total_authors": len(author_papers),
                    "total_collaborations": len(edges_out),
                },
            }
        except Exception as e:
            logger.error("get_author_influence_network: %s", e)
            return {"success": False, "error": str(e)}

    # ── Research landscape (existing, unchanged API) ──────────────────────────

    def analyze_research_landscape(self, manuscript_id: Optional[str] = None) -> Dict:
        try:
            refs = _load_refs(manuscript_id)

            year_counts: Counter = Counter(r.get("year") for r in refs if r.get("year"))
            temporal = [
                {"year": y, "count": c} for y, c in sorted(year_counts.items())
            ][-20:]

            journal_counts: Counter = Counter(
                r.get("journal") for r in refs if r.get("journal")
            )
            top_journals = [
                {"journal": j, "count": c} for j, c in journal_counts.most_common(10)
            ]

            area_counts: Counter = Counter(
                r.get("research_area") or "general" for r in refs
            )

            kw_freq: Counter = Counter()
            for ref in refs:
                for kw in ref.get("keywords") or []:
                    k = kw.lower().strip()
                    if len(k) > 2:
                        kw_freq[k] += 1
            top_kws = [{"keyword": k, "count": c} for k, c in kw_freq.most_common(20)]

            all_authors: Set[str] = set(
                a for r in refs for a in (r.get("authors") or [])
            )

            return {
                "success": True,
                "temporal_trends": temporal,
                "top_journals": top_journals,
                "area_distribution": dict(area_counts),
                "top_keywords": top_kws,
                "summary": {
                    "total_refs": len(refs),
                    "unique_journals": len(journal_counts),
                    "unique_authors": len(all_authors),
                    "year_min": min(year_counts.keys(), default=0),
                    "year_max": max(year_counts.keys(), default=0),
                },
            }
        except Exception as e:
            logger.error("analyze_research_landscape: %s", e)
            return {"success": False, "error": str(e)}


# ── Singleton ─────────────────────────────────────────────────────────────────

_service: Optional[CitationNetworkService] = None


def get_citation_network_service() -> CitationNetworkService:
    global _service
    if _service is None:
        _service = CitationNetworkService()
    return _service
