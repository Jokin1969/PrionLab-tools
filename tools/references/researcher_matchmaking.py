"""Pure-Python researcher matchmaking service for the PrionLab Flask app."""

import json
import logging
import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

STOPWORDS = {
    "the", "and", "for", "that", "with", "from", "this", "are", "has", "been",
    "have", "was", "not", "but", "can", "may", "use", "used", "using", "data",
    "based", "show", "results", "study", "analysis", "between", "research",
    "paper", "work",
}


def _data_dir():
    try:
        import config
        return config.DATA_DIR
    except Exception:
        return os.path.join(os.path.dirname(__file__), "..", "..", "data")


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class CompatibilityResult:
    researcher_a: str
    researcher_b: str
    overall_score: float
    research_interest_score: float
    expertise_complement_score: float
    geographic_score: float
    career_stage_score: float
    shared_interests: List[str]
    complementary_areas: List[str]
    collaboration_potential: str
    success_prediction: float
    opportunities: List[str]
    rationale: str


@dataclass
class SynergyResult:
    participants: List[str]
    synergy_score: float
    innovation_potential: float
    expertise_diversity: float
    methodological_compatibility: float
    synergy_areas: List[str]
    predicted_outcomes: List[str]
    risk_factors: List[str]
    recommended_roles: Dict[str, str]


@dataclass
class PartnerRecommendation:
    rank: int
    orcid_id: str
    name: str
    affiliation: str
    compatibility_score: float
    collaboration_type: str
    shared_interests: List[str]
    complementary_areas: List[str]
    rationale: str
    estimated_success: float


@dataclass
class NetworkResult:
    node_count: int
    edge_count: int
    density: float
    avg_degree: float
    key_nodes: List[str]
    communities: List[List[str]]
    community_count: int
    growth_potential: float
    optimization_tips: List[str]


# ---------------------------------------------------------------------------
# Pure-Python text / math helpers
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> List[str]:
    return [t for t in re.findall(r'[a-z]{3,}', text.lower()) if t not in STOPWORDS]


def _tfidf_vector(tokens: List[str], idf: Dict[str, float]) -> Dict[str, float]:
    total = len(tokens) or 1
    tf = Counter(tokens)
    return {t: (tf[t] / total) * idf.get(t, 1.0) for t in tf}


def _build_idf(docs: List[List[str]]) -> Dict[str, float]:
    N = len(docs) or 1
    df: Counter = Counter()
    for doc in docs:
        df.update(set(doc))
    return {term: math.log(N / (count + 1)) + 1 for term, count in df.items()}


def _cosine(va: Dict[str, float], vb: Dict[str, float]) -> float:
    common = set(va) & set(vb)
    if not common:
        return 0.0
    dot = sum(va[k] * vb[k] for k in common)
    mag_a = math.sqrt(sum(v * v for v in va.values()))
    mag_b = math.sqrt(sum(v * v for v in vb.values()))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def _jaccard(a: set, b: set) -> float:
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def _shannon_entropy_normalized(items: List[str]) -> float:
    if len(items) < 2:
        return 0.0
    counts = Counter(items)
    total = len(items)
    H = -sum((c / total) * math.log2(c / total) for c in counts.values())
    return H / math.log2(len(items))


def _career_stage(profile: Dict) -> str:
    text = " ".join(
        " ".join([e.get("role", ""), e.get("department", "")]) for e in profile.get("employment", [])
    ).lower()
    for kw in ("professor", "principal investigator", "director", "senior"):
        if kw in text:
            return "senior"
    for kw in ("associate", "assistant professor", "researcher", "scientist", "lecturer"):
        if kw in text:
            return "mid"
    return "early"


_CAREER_COMPAT = {
    ("early", "mid"): 0.90,
    ("mid", "early"): 0.90,
    ("mid", "mid"): 0.85,
    ("mid", "senior"): 0.80,
    ("senior", "mid"): 0.80,
    ("early", "early"): 0.75,
    ("senior", "senior"): 0.75,
    ("early", "senior"): 0.70,
    ("senior", "early"): 0.70,
}


def _geo_score(pa: Dict, pb: Dict) -> float:
    if pa.get("current_affiliation") and pa["current_affiliation"] == pb.get("current_affiliation"):
        return 1.0
    loc_a = set(_tokenize(pa.get("geographic_location", "")))
    loc_b = set(_tokenize(pb.get("geographic_location", "")))
    if loc_a & loc_b:
        return 0.85
    aff_a = set(_tokenize(pa.get("current_affiliation", "")))
    aff_b = set(_tokenize(pb.get("current_affiliation", "")))
    region_kws = {"europe", "asia", "africa", "america", "oceania", "north", "south", "east", "west"}
    if (aff_a | loc_a) & (aff_b | loc_b) & region_kws:
        return 0.75
    return 0.55


def _expertise_complementarity(jaccard: float) -> float:
    if jaccard < 0.1:
        return jaccard * 3
    if jaccard <= 0.5:
        return 0.3 + jaccard * 0.8
    return 1.0 - (jaccard - 0.5) * 0.6


def _profile_text(p: Dict) -> str:
    parts = (
        p.get("research_areas", [])
        + p.get("keywords", [])
        + [e.get("organization", "") + " " + e.get("role", "") + " " + e.get("department", "")
           for e in p.get("employment", [])]
    )
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Main service
# ---------------------------------------------------------------------------

class ResearcherMatchmakingService:

    def __init__(self):
        self._profiles_cache: Optional[List[Dict]] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_profiles(self) -> List[Dict]:
        if self._profiles_cache is not None:
            return self._profiles_cache
        path = os.path.join(_data_dir(), "researcher_profiles.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                self._profiles_cache = json.load(fh)
        except Exception as exc:
            logger.error("Failed to load researcher profiles: %s", exc)
            self._profiles_cache = []
        return self._profiles_cache

    def assess_compatibility(self, orcid_a: str, orcid_b: str) -> Dict:
        profiles = {p["orcid_id"]: p for p in self.get_profiles()}
        if orcid_a not in profiles:
            return {"success": False, "error": f"Profile not found: {orcid_a}"}
        if orcid_b not in profiles:
            return {"success": False, "error": f"Profile not found: {orcid_b}"}
        result = self._pairwise_compatibility(
            orcid_a, profiles[orcid_a], orcid_b, profiles[orcid_b]
        )
        return {"success": True, "compatibility": asdict(result)}

    def find_partners(
        self,
        target_orcid: str,
        limit: int = 10,
        collab_type: Optional[str] = None,
    ) -> Dict:
        all_profiles = self.get_profiles()
        by_id = {p["orcid_id"]: p for p in all_profiles}
        if target_orcid not in by_id:
            return {"success": False, "error": f"Profile not found: {target_orcid}"}
        target = by_id[target_orcid]
        recs: List[PartnerRecommendation] = []
        for p in all_profiles:
            if p["orcid_id"] == target_orcid:
                continue
            compat = self._pairwise_compatibility(target_orcid, target, p["orcid_id"], p)
            ct = collab_type or self._best_collab_type(target, p, compat.overall_score, compat.career_stage_score)
            recs.append(PartnerRecommendation(
                rank=0,
                orcid_id=p["orcid_id"],
                name=p.get("name", ""),
                affiliation=p.get("current_affiliation", ""),
                compatibility_score=round(compat.overall_score, 4),
                collaboration_type=ct,
                shared_interests=compat.shared_interests,
                complementary_areas=compat.complementary_areas,
                rationale=compat.rationale,
                estimated_success=round(compat.success_prediction, 4),
            ))
        recs.sort(key=lambda r: r.compatibility_score, reverse=True)
        recs = self._diversity_filter(recs)
        recs = recs[:limit]
        for i, r in enumerate(recs, 1):
            r.rank = i
        return {
            "success": True,
            "target_orcid": target_orcid,
            "target_name": target.get("name", ""),
            "recommendations": [asdict(r) for r in recs],
            "count": len(recs),
        }

    def analyze_synergy(self, orcid_list: List[str]) -> Dict:
        by_id = {p["orcid_id"]: p for p in self.get_profiles()}
        missing = [o for o in orcid_list if o not in by_id]
        if missing:
            return {"success": False, "error": f"Profiles not found: {missing}"}
        profiles = [by_id[o] for o in orcid_list]

        all_tokens: List[str] = []
        per_profile_tokens: List[List[str]] = []
        for p in profiles:
            toks = _tokenize(_profile_text(p))
            per_profile_tokens.append(toks)
            all_tokens.extend(toks)

        idf = _build_idf(per_profile_tokens)
        vectors = [_tfidf_vector(toks, idf) for toks in per_profile_tokens]

        n = len(profiles)
        pair_cosines = []
        for i in range(n):
            for j in range(i + 1, n):
                pair_cosines.append(_cosine(vectors[i], vectors[j]))
        avg_cosine = sum(pair_cosines) / len(pair_cosines) if pair_cosines else 0.0

        all_terms: List[str] = []
        for toks in per_profile_tokens:
            all_terms.extend(set(toks))
        diversity = _shannon_entropy_normalized(all_terms)

        innovation_potential = round((1.0 - avg_cosine) * 0.6 + diversity * 0.4, 4)
        methodological_compatibility = round(avg_cosine * 0.7 + (1.0 - diversity) * 0.3, 4)
        synergy_score = round((innovation_potential + methodological_compatibility) / 2, 4)

        term_counter: Counter = Counter(all_terms)
        synergy_areas = [t for t, _ in term_counter.most_common(10)]

        stages = [_career_stage(p) for p in profiles]
        stage_counts = Counter(stages)
        predicted_outcomes = []
        if stage_counts.get("senior", 0) >= 1 and stage_counts.get("early", 0) >= 1:
            predicted_outcomes.append("High mentorship value")
        if len(set(stages)) >= 2:
            predicted_outcomes.append("Cross-career-stage collaboration")
        if diversity > 0.6:
            predicted_outcomes.append("High interdisciplinary output potential")
        if avg_cosine > 0.5:
            predicted_outcomes.append("Strong thematic convergence likely")
        if not predicted_outcomes:
            predicted_outcomes.append("Moderate collaborative output expected")

        risk_factors = []
        if n > 5:
            risk_factors.append("Large group may face coordination overhead")
        if avg_cosine < 0.1:
            risk_factors.append("Low thematic overlap may reduce cohesion")
        if diversity < 0.2:
            risk_factors.append("Low expertise diversity limits innovation")

        recommended_roles: Dict[str, str] = {}
        for p, stage in zip(profiles, stages):
            if stage == "senior":
                recommended_roles[p["orcid_id"]] = "Principal Investigator"
            elif stage == "mid":
                recommended_roles[p["orcid_id"]] = "Co-Investigator"
            else:
                recommended_roles[p["orcid_id"]] = "Research Associate"

        result = SynergyResult(
            participants=orcid_list,
            synergy_score=synergy_score,
            innovation_potential=innovation_potential,
            expertise_diversity=round(diversity, 4),
            methodological_compatibility=methodological_compatibility,
            synergy_areas=synergy_areas,
            predicted_outcomes=predicted_outcomes,
            risk_factors=risk_factors,
            recommended_roles=recommended_roles,
        )
        return {"success": True, "synergy": asdict(result)}

    def analyze_network(self, refs: List[Dict]) -> Dict:
        adj: Dict[str, set] = defaultdict(set)
        nodes: set = set()
        for ref in refs:
            authors = ref.get("authors", [])
            for a in authors:
                nodes.add(a)
            for i in range(len(authors)):
                for j in range(i + 1, len(authors)):
                    adj[authors[i]].add(authors[j])
                    adj[authors[j]].add(authors[i])

        node_count = len(nodes)
        edge_count = sum(len(v) for v in adj.values()) // 2
        max_edges = node_count * (node_count - 1) / 2 if node_count > 1 else 1
        density = round(edge_count / max_edges, 4) if max_edges else 0.0
        avg_degree = round(sum(len(v) for v in adj.values()) / node_count, 4) if node_count else 0.0

        degree_sorted = sorted(nodes, key=lambda n: len(adj.get(n, set())), reverse=True)
        key_nodes = degree_sorted[:5]

        communities = self._bfs_communities(adj, nodes)

        growth_potential = round(max(0.0, 1.0 - density) * (1.0 - 1.0 / (node_count + 1)), 4)

        tips = []
        if density < 0.2:
            tips.append("Network is sparse; encourage more cross-group collaborations")
        if len(communities) > node_count / 3:
            tips.append("Many isolated clusters; bridge-builders could improve connectivity")
        if avg_degree < 2:
            tips.append("Low average connectivity; targeted introductions recommended")
        if not tips:
            tips.append("Network is well-connected; maintain current collaboration patterns")

        result = NetworkResult(
            node_count=node_count,
            edge_count=edge_count,
            density=density,
            avg_degree=avg_degree,
            key_nodes=key_nodes,
            communities=communities,
            community_count=len(communities),
            growth_potential=growth_potential,
            optimization_tips=tips,
        )
        return {"success": True, "network": asdict(result)}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _pairwise_compatibility(
        self,
        oa: str,
        pa: Dict,
        ob: str,
        pb: Dict,
    ) -> CompatibilityResult:
        text_a = _profile_text(pa)
        text_b = _profile_text(pb)
        toks_a = _tokenize(text_a)
        toks_b = _tokenize(text_b)
        idf = _build_idf([toks_a, toks_b])
        va = _tfidf_vector(toks_a, idf)
        vb = _tfidf_vector(toks_b, idf)
        interest_score = _cosine(va, vb)

        set_a = set(toks_a)
        set_b = set(toks_b)
        jac = _jaccard(set_a, set_b)
        expertise_score = _expertise_complementarity(jac)

        geo = _geo_score(pa, pb)

        stage_a = _career_stage(pa)
        stage_b = _career_stage(pb)
        career_score = _CAREER_COMPAT.get((stage_a, stage_b), 0.75)

        overall = (
            0.35 * interest_score
            + 0.25 * expertise_score
            + 0.15 * career_score
            + 0.10 * geo
            + 0.15
        )
        overall = round(min(1.0, overall), 4)

        shared_terms = sorted(set_a & set_b, key=lambda t: va.get(t, 0) + vb.get(t, 0), reverse=True)
        shared_interests = shared_terms[:8]
        complementary = sorted(set_a ^ set_b, key=lambda t: va.get(t, vb.get(t, 0)), reverse=True)
        complementary_areas = complementary[:6]

        if overall >= 0.65:
            potential = "high"
        elif overall >= 0.45:
            potential = "medium"
        else:
            potential = "low"

        success_prediction = round(
            overall * 0.7 + (len(shared_interests) / 20) * 0.2 + geo * 0.1, 4
        )

        opportunities = []
        if career_score >= 0.90:
            opportunities.append("Mentorship program")
        if interest_score > 0.4:
            opportunities.append("Joint publication")
        if expertise_score > 0.5:
            opportunities.append("Complementary grant application")
        if geo == 1.0:
            opportunities.append("On-site collaboration")
        if not opportunities:
            opportunities.append("Exploratory research exchange")

        rationale = (
            f"{pa.get('name', oa)} and {pb.get('name', ob)} share "
            f"{len(shared_interests)} overlapping research terms with a "
            f"{potential} collaboration potential (score {overall:.2f}). "
            f"Career stages: {stage_a}/{stage_b}. Geographic proximity: {geo:.2f}."
        )

        return CompatibilityResult(
            researcher_a=oa,
            researcher_b=ob,
            overall_score=overall,
            research_interest_score=round(interest_score, 4),
            expertise_complement_score=round(expertise_score, 4),
            geographic_score=round(geo, 4),
            career_stage_score=round(career_score, 4),
            shared_interests=shared_interests,
            complementary_areas=complementary_areas,
            collaboration_potential=potential,
            success_prediction=success_prediction,
            opportunities=opportunities,
            rationale=rationale,
        )

    def _diversity_filter(
        self,
        recs: List[PartnerRecommendation],
        max_per_institution: int = 2,
    ) -> List[PartnerRecommendation]:
        inst_count: Counter = Counter()
        filtered = []
        for r in recs:
            key = r.affiliation.strip().lower() or "__unknown__"
            if inst_count[key] < max_per_institution:
                filtered.append(r)
                inst_count[key] += 1
        return filtered

    def _best_collab_type(
        self,
        pa: Dict,
        pb: Dict,
        overall: float,
        career_score: float,
    ) -> str:
        stage_a = _career_stage(pa)
        stage_b = _career_stage(pb)
        if career_score >= 0.90 and {stage_a, stage_b} == {"early", "mid"}:
            return "mentorship"
        if overall >= 0.65:
            return "grant"
        if overall >= 0.55:
            return "publication"
        return "research"

    def _bfs_communities(
        self,
        adj: Dict[str, set],
        nodes: set,
    ) -> List[List[str]]:
        visited: set = set()
        communities: List[List[str]] = []
        for start in nodes:
            if start in visited:
                continue
            component = []
            queue = [start]
            visited.add(start)
            while queue:
                node = queue.pop(0)
                component.append(node)
                for neighbor in adj.get(node, set()):
                    if neighbor not in visited:
                        visited.add(neighbor)
                        queue.append(neighbor)
            communities.append(sorted(component))
        return communities


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_service: Optional[ResearcherMatchmakingService] = None


def get_matchmaking_service() -> ResearcherMatchmakingService:
    global _service
    if _service is None:
        _service = ResearcherMatchmakingService()
    return _service
