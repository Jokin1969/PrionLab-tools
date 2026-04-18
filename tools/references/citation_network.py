"""Citation network analysis — pure-Python, no networkx dependency."""
import logging
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


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


def _ref_similarity(r1: Dict, r2: Dict) -> Tuple[float, str]:
    score = 0.0
    etype = "content"

    a1 = set(r1.get("authors") or [])
    a2 = set(r2.get("authors") or [])
    if a1 and a2:
        overlap = len(a1 & a2)
        if overlap:
            score += 0.40 * overlap / max(len(a1), len(a2))
            etype = "author_overlap"

    j1 = (r1.get("journal") or "").lower().strip()
    j2 = (r2.get("journal") or "").lower().strip()
    if j1 and j1 == j2:
        score += 0.20
        if etype == "content":
            etype = "same_journal"

    y1 = r1.get("year") or 0
    y2 = r2.get("year") or 0
    if y1 and y2:
        score += max(0.0, 0.10 * (1 - abs(y1 - y2) / 5.0))

    if r1.get("research_area") and r1.get("research_area") == r2.get("research_area"):
        score += 0.15

    kw1 = {k.lower() for k in (r1.get("keywords") or [])}
    kw2 = {k.lower() for k in (r2.get("keywords") or [])}
    if kw1 and kw2:
        score += 0.15 * len(kw1 & kw2) / max(len(kw1), len(kw2))

    return score, etype


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


class CitationNetworkService:
    THRESHOLD = 0.25
    MAX_REFS = 150

    def build_citation_network(self, manuscript_id: Optional[str] = None) -> Dict:
        try:
            refs = _load_refs(manuscript_id)[: self.MAX_REFS]
            if not refs:
                return {"success": True, "nodes": [], "edges": [], "clusters": [], "metrics": {}}

            adjacency: Dict[str, List[str]] = defaultdict(list)
            edges_out = []

            for i, r1 in enumerate(refs):
                for r2 in refs[i + 1 :]:
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

            # Build cluster summaries
            cluster_groups: Dict[int, List[Dict]] = defaultdict(list)
            for ref in refs:
                cid = clusters_by_id.get(ref.get("id", ""))
                if cid is not None:
                    cluster_groups[cid].append(ref)

            clusters_out = []
            for cid, crefs in cluster_groups.items():
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
                    crefs, key=lambda r: len(adjacency.get(r.get("id", ""), [])), reverse=True
                )
                clusters_out.append({
                    "id": cid,
                    "size": len(crefs),
                    "topic": main_topic,
                    "representatives": [r.get("id", "") for r in sorted_by_degree[:3]],
                    "key_authors": key_authors,
                })

            nodes_out = [
                {
                    "id": r.get("id", ""),
                    "title": (r.get("title") or "")[:80],
                    "authors": r.get("authors") or [],
                    "journal": r.get("journal") or "",
                    "year": r.get("year") or 0,
                    "doi": r.get("doi") or "",
                    "research_area": r.get("research_area") or "",
                    "degree": len(adjacency.get(r.get("id", ""), [])),
                    "cluster_id": clusters_by_id.get(r.get("id", "")),
                }
                for r in refs
            ]

            n = len(refs)
            degrees = [len(v) for v in adjacency.values()]
            metrics = {
                "node_count": n,
                "edge_count": len(edges_out),
                "avg_degree": round(statistics.mean(degrees), 2) if degrees else 0,
                "density": round(2 * len(edges_out) / max(n * (n - 1), 1), 4),
                "cluster_count": len(clusters_out),
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
                    for a2 in authors[i + 1 :]:
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

            seen: set = set()
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

            all_authors = set(
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


_service: Optional[CitationNetworkService] = None


def get_citation_network_service() -> CitationNetworkService:
    global _service
    if _service is None:
        _service = CitationNetworkService()
    return _service
