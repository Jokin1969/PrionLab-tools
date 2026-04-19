"""Research Profile Integration — ORCID, ResearchGate stub, Google Scholar stub.

Pure Python. No geopy, no networkx. Storage via JSON files alongside references.json.
ResearchGate and Google Scholar have no public API; their services are stubs that
return empty/placeholder data with clear status flags so the UI can surface the
limitation honestly.
"""
import json
import logging
import math
import os
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import requests

logger = logging.getLogger(__name__)

ORCID_BASE = "https://pub.orcid.org/v3.0"
_ORCID_HEADERS = {"Accept": "application/json"}
_RATE_DELAY = 0.35


# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class ResearcherProfileData:
    orcid_id: str
    name: str
    email: str = ""
    current_affiliation: str = ""
    historical_affiliations: List[str] = field(default_factory=list)
    research_areas: List[str] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    education: List[Dict] = field(default_factory=list)
    employment: List[Dict] = field(default_factory=list)
    funding: List[Dict] = field(default_factory=list)
    profile_sources: List[str] = field(default_factory=list)
    social_metrics: Dict = field(default_factory=dict)
    collaboration_network: List[str] = field(default_factory=list)
    geographic_location: str = ""
    imported_at: str = ""


@dataclass
class InstitutionProfile:
    institution_id: str
    name: str
    country: str = ""
    city: str = ""
    research_areas: List[str] = field(default_factory=list)
    researcher_count: int = 0
    publication_count: int = 0
    collaboration_strength: Dict = field(default_factory=dict)
    coordinates: Optional[Tuple[float, float]] = None


@dataclass
class CollaborationOpportunity:
    researcher_a: str
    researcher_b: str
    name_a: str
    name_b: str
    similarity_score: float
    complementarity_score: float
    shared_interests: List[str]
    complementary_areas: List[str]
    affiliation_a: str = ""
    affiliation_b: str = ""
    collaboration_potential: str = "low"  # 'high' | 'medium' | 'low'


# ── Storage helpers ────────────────────────────────────────────────────────────

def _data_dir() -> str:
    try:
        import config
        return config.DATA_DIR
    except Exception:
        return os.path.join(os.path.dirname(__file__), "..", "..", "data")


def _profiles_path() -> str:
    return os.path.join(_data_dir(), "researcher_profiles.json")


def _institutions_path() -> str:
    return os.path.join(_data_dir(), "institutions.json")


def _load_profiles() -> List[Dict]:
    path = _profiles_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_profiles(data: List[Dict]) -> None:
    path = _profiles_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _load_institutions() -> List[Dict]:
    path = _institutions_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_institutions(data: List[Dict]) -> None:
    path = _institutions_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ── Utility ────────────────────────────────────────────────────────────────────

def _str_val(obj) -> str:
    if isinstance(obj, dict):
        return (obj.get("value") or "").strip()
    return str(obj).strip() if obj else ""


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


# Known institution coordinates (city, country, lat, lon) for common research centres.
_INSTITUTION_GEO: Dict[str, Tuple[str, str, float, float]] = {
    "harvard": ("Cambridge", "US", 42.3770, -71.1167),
    "mit": ("Cambridge", "US", 42.3601, -71.0942),
    "stanford": ("Stanford", "US", 37.4275, -122.1697),
    "cambridge": ("Cambridge", "GB", 52.2054, 0.1132),
    "oxford": ("Oxford", "GB", 51.7548, -1.2544),
    "ucl": ("London", "GB", 51.5245, -0.1340),
    "cnrs": ("Paris", "FR", 48.8566, 2.3522),
    "pasteur": ("Paris", "FR", 48.8407, 2.3108),
    "mrc": ("London", "GB", 51.4975, -0.1357),
    "embl": ("Heidelberg", "DE", 49.3988, 8.6724),
    "max planck": ("Munich", "DE", 48.1351, 11.5820),
    "karolinska": ("Stockholm", "SE", 59.3500, 18.0300),
    "toronto": ("Toronto", "CA", 43.6629, -79.3957),
    "ucsf": ("San Francisco", "US", 37.7631, -122.4584),
    "nih": ("Bethesda", "US", 39.0003, -77.1022),
    "ucm": ("Madrid", "ES", 40.4515, -3.7288),
    "uam": ("Madrid", "ES", 40.5487, -3.6325),
    "csic": ("Madrid", "ES", 40.4530, -3.6883),
    "cib": ("Madrid", "ES", 40.4442, -3.6915),
    "cbmso": ("Madrid", "ES", 40.5449, -3.6968),
    "iib": ("Madrid", "ES", 40.4530, -3.6883),
}


def _geo_for_institution(name: str) -> Tuple[str, str, Optional[Tuple[float, float]]]:
    """Return (city, country, (lat, lon)|None) via keyword lookup."""
    lower = name.lower()
    for key, (city, country, lat, lon) in _INSTITUTION_GEO.items():
        if key in lower:
            return city, country, (lat, lon)
    return "", "", None


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(a))


# ── ORCID Profile Service ──────────────────────────────────────────────────────

class ORCIDProfileService:
    """Full ORCID public API profile fetcher."""

    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(_ORCID_HEADERS)
        self._last = 0.0

    def _get(self, url: str) -> Optional[Dict]:
        elapsed = time.time() - self._last
        if elapsed < _RATE_DELAY:
            time.sleep(_RATE_DELAY - elapsed)
        self._last = time.time()
        try:
            r = self._session.get(url, timeout=20)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            logger.warning("ORCID GET %s failed: %s", url, exc)
            return None

    def get_complete_profile(self, orcid_id: str) -> Optional[ResearcherProfileData]:
        orcid_id = orcid_id.strip()
        person = self._get(f"{ORCID_BASE}/{orcid_id}/person")
        if person is None:
            return None

        name = self._parse_name(person)
        email = self._parse_email(person)
        keywords = [_str_val(k) for k in (person.get("keywords", {}) or {}).get("keyword", []) if k]

        employment = self._fetch_employments(orcid_id)
        education = self._fetch_educations(orcid_id)
        funding = self._fetch_fundings(orcid_id)
        research_areas = self._derive_research_areas(keywords, employment)

        current_aff = ""
        hist_affs: List[str] = []
        for emp in employment:
            org = emp.get("organization", "")
            if emp.get("current") and not current_aff:
                current_aff = org
            elif org and org not in hist_affs:
                hist_affs.append(org)

        geo = ""
        if current_aff:
            city, country, _ = _geo_for_institution(current_aff)
            if city:
                geo = f"{city}, {country}"
            elif country:
                geo = country

        from datetime import datetime, timezone
        return ResearcherProfileData(
            orcid_id=orcid_id,
            name=name,
            email=email,
            current_affiliation=current_aff,
            historical_affiliations=hist_affs,
            research_areas=research_areas,
            keywords=keywords,
            education=education,
            employment=employment,
            funding=funding,
            profile_sources=["orcid"],
            geographic_location=geo,
            imported_at=datetime.now(timezone.utc).isoformat(),
        )

    # ── internal parsers ──────────────────────────────────────────────────────

    def _parse_name(self, person: Dict) -> str:
        nd = person.get("name") or {}
        given = _str_val(nd.get("given-names"))
        family = _str_val(nd.get("family-name"))
        return f"{given} {family}".strip() or "Unknown"

    def _parse_email(self, person: Dict) -> str:
        emails = (person.get("emails") or {}).get("email", [])
        for e in emails:
            v = (e.get("email") or "").strip()
            if v:
                return v
        return ""

    def _fetch_employments(self, orcid_id: str) -> List[Dict]:
        data = self._get(f"{ORCID_BASE}/{orcid_id}/employments")
        if not data:
            return []
        out = []
        for group in data.get("affiliation-group", []):
            for summary in group.get("summaries", []):
                es = summary.get("employment-summary", {})
                org_info = es.get("organization", {})
                addr = org_info.get("address", {})
                sd = es.get("start-date") or {}
                ed = es.get("end-date")
                out.append({
                    "organization": org_info.get("name", ""),
                    "department": es.get("department-name", "") or "",
                    "role": es.get("role-title", "") or "",
                    "start_year": _str_val(sd.get("year")) if sd else "",
                    "end_year": _str_val(ed.get("year")) if ed else "",
                    "current": ed is None,
                    "city": addr.get("city", "") or "",
                    "country": addr.get("country", "") or "",
                })
        return out

    def _fetch_educations(self, orcid_id: str) -> List[Dict]:
        data = self._get(f"{ORCID_BASE}/{orcid_id}/educations")
        if not data:
            return []
        out = []
        for group in data.get("affiliation-group", []):
            for summary in group.get("summaries", []):
                es = summary.get("education-summary", {})
                org_info = es.get("organization", {})
                sd = es.get("start-date") or {}
                ed = es.get("end-date") or {}
                out.append({
                    "institution": org_info.get("name", ""),
                    "degree": es.get("role-title", "") or "",
                    "department": es.get("department-name", "") or "",
                    "start_year": _str_val(sd.get("year")) if sd else "",
                    "end_year": _str_val(ed.get("year")) if ed else "",
                })
        return out

    def _fetch_fundings(self, orcid_id: str) -> List[Dict]:
        data = self._get(f"{ORCID_BASE}/{orcid_id}/fundings")
        if not data:
            return []
        out = []
        for group in (data.get("group") or []):
            for summary in (group.get("funding-summary") or []):
                title_obj = (summary.get("title") or {}).get("title") or {}
                org = (summary.get("organization") or {}).get("name", "")
                sd = summary.get("start-date") or {}
                out.append({
                    "title": _str_val(title_obj),
                    "type": summary.get("type", "") or "",
                    "organization": org,
                    "start_year": _str_val(sd.get("year")) if sd else "",
                })
        return out

    def _derive_research_areas(self, keywords: List[str], employment: List[Dict]) -> List[str]:
        areas: List[str] = []
        for kw in keywords:
            kw_clean = kw.strip().lower()
            if kw_clean and kw_clean not in [a.lower() for a in areas]:
                areas.append(kw.strip())
        return areas[:20]


# ── ResearchGate stub ──────────────────────────────────────────────────────────

class ResearchGateService:
    """ResearchGate has no public API. Returns stub data with an explicit note."""

    available = False
    note = "ResearchGate does not provide a public API. Data unavailable."

    def get_researcher_profile(self, researcher_name: str) -> Dict:
        return {
            "available": False,
            "note": self.note,
            "name": researcher_name,
            "rg_score": None,
            "research_interests": [],
            "collaboration_network": [],
            "institution": "",
            "publication_count": None,
            "citation_count": None,
        }


# ── Google Scholar stub ────────────────────────────────────────────────────────

class GoogleScholarService:
    """Google Scholar has no public API and blocks automated scraping.
    Returns stub data with an explicit note.
    """

    available = False
    note = "Google Scholar does not provide a public API. Data unavailable."

    def get_researcher_profile(self, researcher_name: str, affiliation: str = "") -> Dict:
        return {
            "available": False,
            "note": self.note,
            "name": researcher_name,
            "affiliation": affiliation,
            "citations": {"total": None, "h_index": None, "i10_index": None},
            "research_areas": [],
            "co_authors": [],
        }


# ── Institution Mapping Service ────────────────────────────────────────────────

class InstitutionMappingService:
    """Pure-Python institution mapping. Uses a keyword geo-lookup table;
    falls back to empty coordinates for unknown institutions."""

    def get_institution_profile(self, institution_name: str) -> InstitutionProfile:
        inst_id = "inst_" + _slug(institution_name)[:40]
        city, country, coords = _geo_for_institution(institution_name)

        institutions = _load_institutions()
        existing = next((i for i in institutions if i.get("institution_id") == inst_id), None)

        if existing:
            return InstitutionProfile(
                institution_id=existing["institution_id"],
                name=existing.get("name", institution_name),
                country=existing.get("country", country),
                city=existing.get("city", city),
                research_areas=existing.get("research_areas", []),
                researcher_count=existing.get("researcher_count", 0),
                publication_count=existing.get("publication_count", 0),
                collaboration_strength=existing.get("collaboration_strength", {}),
                coordinates=tuple(existing["coordinates"]) if existing.get("coordinates") else coords,
            )

        profile = InstitutionProfile(
            institution_id=inst_id,
            name=institution_name,
            country=country,
            city=city,
            coordinates=coords,
        )
        # Derive researcher count from stored profiles
        profiles = _load_profiles()
        profile.researcher_count = sum(
            1 for p in profiles
            if institution_name.lower() in p.get("current_affiliation", "").lower()
        )
        # Persist
        rec = asdict(profile)
        rec["coordinates"] = list(coords) if coords else None
        institutions.append(rec)
        _save_institutions(institutions)
        return profile

    def get_all_institutions(self) -> List[Dict]:
        return _load_institutions()

    def distance_km(self, inst_a: str, inst_b: str) -> Optional[float]:
        _, _, ca = _geo_for_institution(inst_a)
        _, _, cb = _geo_for_institution(inst_b)
        if ca and cb:
            return round(_haversine(ca[0], ca[1], cb[0], cb[1]), 1)
        return None


# ── Collaboration Discovery Service ───────────────────────────────────────────

class CollaborationDiscoveryService:
    """Finds collaboration opportunities using Jaccard similarity + complementarity."""

    def __init__(self):
        self._institution_svc = InstitutionMappingService()

    def find_opportunities(
        self,
        target: ResearcherProfileData,
        candidates: List[ResearcherProfileData],
        min_potential: str = "medium",
    ) -> List[CollaborationOpportunity]:
        threshold = {"high": 0.7, "medium": 0.4, "low": 0.0}.get(min_potential, 0.4)
        opps = []
        for cand in candidates:
            if cand.orcid_id == target.orcid_id:
                continue
            opp = self._score_pair(target, cand)
            if opp and (opp.similarity_score + opp.complementarity_score) >= threshold:
                opps.append(opp)
        opps.sort(key=lambda o: o.similarity_score + o.complementarity_score, reverse=True)
        return opps[:50]

    def _score_pair(
        self, a: ResearcherProfileData, b: ResearcherProfileData
    ) -> Optional[CollaborationOpportunity]:
        areas_a = [x.lower() for x in a.research_areas + a.keywords if x]
        areas_b = [x.lower() for x in b.research_areas + b.keywords if x]
        if not areas_a and not areas_b:
            return None

        sim = _jaccard(set(areas_a), set(areas_b))
        comp = self._complementarity(set(areas_a), set(areas_b), sim)
        shared = list(set(areas_a) & set(areas_b))
        complementary = list((set(areas_a) | set(areas_b)) - set(areas_a) & set(areas_b))[:8]

        total = sim + comp
        potential = "high" if total >= 0.7 else "medium" if total >= 0.4 else "low"

        return CollaborationOpportunity(
            researcher_a=a.orcid_id or a.name,
            researcher_b=b.orcid_id or b.name,
            name_a=a.name,
            name_b=b.name,
            similarity_score=round(sim, 4),
            complementarity_score=round(comp, 4),
            shared_interests=shared[:10],
            complementary_areas=complementary[:10],
            affiliation_a=a.current_affiliation,
            affiliation_b=b.current_affiliation,
            collaboration_potential=potential,
        )

    @staticmethod
    def _complementarity(a: Set[str], b: Set[str], sim: float) -> float:
        if 0.15 <= sim <= 0.55:
            return 0.8
        if sim < 0.15:
            return 0.2
        return 0.1


# ── Network analysis (pure Python) ────────────────────────────────────────────

class ResearchNetworkAnalyzer:
    """Pure-Python collaboration network: adjacency dict + BFS clustering."""

    def build_network(self, profiles: List[ResearcherProfileData]) -> Dict:
        nodes = {p.orcid_id or p.name: p for p in profiles}
        adj: Dict[str, List[str]] = {k: [] for k in nodes}
        edges = []

        disc = CollaborationDiscoveryService()
        prof_list = list(profiles)
        for i, pa in enumerate(prof_list):
            for pb in prof_list[i + 1:]:
                opp = disc._score_pair(pa, pb)
                if opp and opp.collaboration_potential in ("high", "medium"):
                    ka = pa.orcid_id or pa.name
                    kb = pb.orcid_id or pb.name
                    adj[ka].append(kb)
                    adj[kb].append(ka)
                    edges.append({
                        "source": ka,
                        "target": kb,
                        "weight": round(opp.similarity_score + opp.complementarity_score, 3),
                        "potential": opp.collaboration_potential,
                    })

        clusters = self._bfs_clusters(adj)
        degree = {k: len(v) for k, v in adj.items()}
        key_researchers = sorted(degree, key=lambda k: degree[k], reverse=True)[:5]

        return {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "cluster_count": len(clusters),
            "nodes": [
                {
                    "id": k,
                    "name": p.name,
                    "affiliation": p.current_affiliation,
                    "research_areas": p.research_areas[:5],
                    "degree": degree.get(k, 0),
                    "cluster_id": next(
                        (i for i, cl in enumerate(clusters) if k in cl), -1
                    ),
                }
                for k, p in nodes.items()
            ],
            "edges": edges,
            "clusters": [list(c) for c in clusters],
            "key_researchers": key_researchers,
            "avg_degree": round(sum(degree.values()) / len(degree), 2) if degree else 0,
        }

    @staticmethod
    def _bfs_clusters(adj: Dict[str, List[str]]) -> List[Set[str]]:
        visited: Set[str] = set()
        clusters = []
        for start in adj:
            if start in visited:
                continue
            cluster: Set[str] = set()
            queue = [start]
            while queue:
                node = queue.pop()
                if node in visited:
                    continue
                visited.add(node)
                cluster.add(node)
                queue.extend(adj.get(node, []))
            clusters.append(cluster)
        return clusters


# ── Main orchestrator ──────────────────────────────────────────────────────────

class ResearchProfileIntegrationService:
    """Orchestrates profile import, storage, collaboration discovery, and network analysis."""

    def __init__(self):
        self._orcid = ORCIDProfileService()
        self._rg = ResearchGateService()
        self._scholar = GoogleScholarService()
        self._institution = InstitutionMappingService()
        self._network = ResearchNetworkAnalyzer()
        self._collab = CollaborationDiscoveryService()

    # ── Import ────────────────────────────────────────────────────────────────

    def import_orcid_profile(self, orcid_id: str) -> Dict:
        profile = self._orcid.get_complete_profile(orcid_id)
        if profile is None:
            return {"success": False, "error": "ORCID profile not found or API unavailable"}

        # Persist
        profiles = _load_profiles()
        existing_idx = next(
            (i for i, p in enumerate(profiles) if p.get("orcid_id") == orcid_id), None
        )
        rec = asdict(profile)
        if existing_idx is not None:
            profiles[existing_idx] = rec
        else:
            profiles.append(rec)
        _save_profiles(profiles)

        # Map institution
        inst_profile = None
        if profile.current_affiliation:
            inst_profile = self._institution.get_institution_profile(profile.current_affiliation)

        # Stub enrichments
        rg_data = self._rg.get_researcher_profile(profile.name)
        scholar_data = self._scholar.get_researcher_profile(profile.name, profile.current_affiliation)

        return {
            "success": True,
            "orcid_id": orcid_id,
            "profile": rec,
            "institution": asdict(inst_profile) if inst_profile else None,
            "researchgate": rg_data,
            "google_scholar": scholar_data,
        }

    # ── Collaboration opportunities ───────────────────────────────────────────

    def collaboration_opportunities(self, orcid_id: str) -> Dict:
        profiles = _load_profiles()
        target_rec = next((p for p in profiles if p.get("orcid_id") == orcid_id), None)
        if not target_rec:
            return {"success": False, "error": "Researcher not found. Import their ORCID profile first."}

        target = _dict_to_profile(target_rec)
        candidates = [_dict_to_profile(p) for p in profiles if p.get("orcid_id") != orcid_id]
        opps = self._collab.find_opportunities(target, candidates)
        return {
            "success": True,
            "orcid_id": orcid_id,
            "researcher_name": target.name,
            "opportunities": [asdict(o) for o in opps],
            "count": len(opps),
        }

    # ── Network analysis ──────────────────────────────────────────────────────

    def analyze_network(self, institution_filter: str = "") -> Dict:
        profiles = _load_profiles()
        if institution_filter:
            profiles = [
                p for p in profiles
                if institution_filter.lower() in p.get("current_affiliation", "").lower()
            ]
        if not profiles:
            return {"success": True, "node_count": 0, "edge_count": 0, "nodes": [], "edges": [], "clusters": [], "key_researchers": [], "cluster_count": 0, "avg_degree": 0}

        researcher_list = [_dict_to_profile(p) for p in profiles]
        network = self._network.build_network(researcher_list)
        return {"success": True, **network}

    # ── List stored profiles ──────────────────────────────────────────────────

    def list_profiles(self) -> Dict:
        profiles = _load_profiles()
        return {
            "success": True,
            "profiles": profiles,
            "count": len(profiles),
        }

    # ── Institution mapping ───────────────────────────────────────────────────

    def get_institution(self, name: str) -> Dict:
        prof = self._institution.get_institution_profile(name)
        return {"success": True, "institution": asdict(prof)}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _jaccard(a: Set[str], b: Set[str]) -> float:
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def _dict_to_profile(d: Dict) -> ResearcherProfileData:
    return ResearcherProfileData(
        orcid_id=d.get("orcid_id", ""),
        name=d.get("name", ""),
        email=d.get("email", ""),
        current_affiliation=d.get("current_affiliation", ""),
        historical_affiliations=d.get("historical_affiliations", []),
        research_areas=d.get("research_areas", []),
        keywords=d.get("keywords", []),
        education=d.get("education", []),
        employment=d.get("employment", []),
        funding=d.get("funding", []),
        profile_sources=d.get("profile_sources", []),
        social_metrics=d.get("social_metrics", {}),
        collaboration_network=d.get("collaboration_network", []),
        geographic_location=d.get("geographic_location", ""),
        imported_at=d.get("imported_at", ""),
    )


# ── Singleton ──────────────────────────────────────────────────────────────────

_service: Optional[ResearchProfileIntegrationService] = None


def get_profile_integration_service() -> ResearchProfileIntegrationService:
    global _service
    if _service is None:
        _service = ResearchProfileIntegrationService()
    return _service
