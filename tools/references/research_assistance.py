"""Pure-Python Research Assistance & Grant Automation service (P24D2)."""
import json
import logging
import math
import os
import re
from collections import Counter
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


def _data_dir() -> str:
    try:
        import config
        return config.DATA_DIR
    except Exception:
        return os.path.join(os.path.dirname(__file__), "..", "..", "data")


# ── Section keywords & optimal proportions ────────────────────────────────────

_SECTIONS = {
    "introduction": ["introduction", "background", "motivation", "problem", "context", "rationale"],
    "literature":   ["literature", "previous", "related", "prior", "review", "existing"],
    "methodology":  ["method", "approach", "design", "protocol", "procedure", "technique"],
    "outcomes":     ["outcome", "result", "deliverable", "expected", "objective", "aim", "hypothesis"],
    "timeline":     ["timeline", "schedule", "milestone", "budget", "cost", "resource", "phase"],
    "impact":       ["impact", "significance", "contribution", "innovation", "novelty", "importance"],
}
_OPTIMAL = {
    "introduction": 0.15, "literature": 0.20, "methodology": 0.25,
    "outcomes": 0.15, "timeline": 0.10, "impact": 0.15,
}

# ── Grant database ─────────────────────────────────────────────────────────────

_GRANT_DB = [
    {"id": "nsf-career", "agency": "NSF", "title": "CAREER: Faculty Early Career Development",
     "areas": ["all"], "career_stage": "early", "min": 400000, "max": 600000,
     "deadline": "2026-07-15", "reqs": ["US institution", "Tenure-track position"],
     "competition": "high",
     "keywords": ["early career", "education", "faculty", "research integration"]},
    {"id": "nsf-core", "agency": "NSF", "title": "Core Research Grants",
     "areas": ["all"], "career_stage": "all", "min": 150000, "max": 500000,
     "deadline": "2026-10-01", "reqs": ["US institution", "PhD required"],
     "competition": "high", "keywords": ["fundamental research", "discovery", "scientific"]},
    {"id": "nih-r01", "agency": "NIH", "title": "R01 Research Project Grant",
     "areas": ["biomedical", "health", "biology", "medicine", "neuroscience", "biochemistry"],
     "career_stage": "all", "min": 250000, "max": 500000,
     "deadline": "2026-06-05", "reqs": ["US institution", "PhD or MD"],
     "competition": "high", "keywords": ["biomedical", "health", "disease", "clinical", "biology"]},
    {"id": "nih-r21", "agency": "NIH", "title": "R21 Exploratory/Developmental Research",
     "areas": ["biomedical", "health", "biology", "medicine"],
     "career_stage": "all", "min": 50000, "max": 275000,
     "deadline": "2026-09-16", "reqs": ["US institution"],
     "competition": "medium", "keywords": ["exploratory", "pilot", "feasibility", "biomedical"]},
    {"id": "nih-k99", "agency": "NIH", "title": "K99/R00 Pathway to Independence",
     "areas": ["biomedical", "health", "biology"],
     "career_stage": "early", "min": 90000, "max": 249000,
     "deadline": "2026-08-12", "reqs": ["Postdoctoral stage", "<4 years postdoc"],
     "competition": "high", "keywords": ["postdoc", "independence", "career transition"]},
    {"id": "erc-stg", "agency": "ERC", "title": "ERC Starting Grant",
     "areas": ["all"], "career_stage": "early", "min": 1000000, "max": 1500000,
     "deadline": "2026-10-14", "reqs": ["PhD 2-7 years ago", "EU host institution"],
     "competition": "high", "keywords": ["frontier research", "pioneering", "early investigator"]},
    {"id": "erc-con", "agency": "ERC", "title": "ERC Consolidator Grant",
     "areas": ["all"], "career_stage": "mid", "min": 1000000, "max": 2000000,
     "deadline": "2026-11-20", "reqs": ["PhD 7-12 years ago", "EU host institution"],
     "competition": "high", "keywords": ["consolidation", "independent", "excellence"]},
    {"id": "erc-adv", "agency": "ERC", "title": "ERC Advanced Grant",
     "areas": ["all"], "career_stage": "senior", "min": 1500000, "max": 2500000,
     "deadline": "2026-09-04", "reqs": ["Senior researcher", "EU host institution"],
     "competition": "high", "keywords": ["senior", "groundbreaking", "ambitious"]},
    {"id": "msca-pf", "agency": "EU Horizon", "title": "Marie Skłodowska-Curie Postdoctoral Fellowships",
     "areas": ["all"], "career_stage": "early", "min": 180000, "max": 220000,
     "deadline": "2026-09-11", "reqs": ["PhD completed", "Mobility requirement"],
     "competition": "high", "keywords": ["mobility", "fellowship", "postdoc", "interdisciplinary"]},
    {"id": "wellcome-disc", "agency": "Wellcome Trust", "title": "Discovery Research Grants",
     "areas": ["biomedical", "health", "biology", "neuroscience"],
     "career_stage": "all", "min": 200000, "max": 3000000,
     "deadline": "2026-03-01", "reqs": ["UK/Ireland institution"],
     "competition": "medium", "keywords": ["biomedical", "discovery", "curiosity-driven", "biology"]},
    {"id": "gates-gcgh", "agency": "Gates Foundation", "title": "Grand Challenges in Global Health",
     "areas": ["global health", "infectious disease", "nutrition", "vaccines"],
     "career_stage": "all", "min": 100000, "max": 500000,
     "deadline": "2026-05-15", "reqs": ["Open to all institutions"],
     "competition": "medium", "keywords": ["global health", "infectious", "vaccines", "poverty"]},
    {"id": "bbsrc-pj", "agency": "BBSRC", "title": "BBSRC Project Grants",
     "areas": ["biology", "biochemistry", "bioscience", "agriculture"],
     "career_stage": "all", "min": 100000, "max": 500000,
     "deadline": "2026-04-22", "reqs": ["UK institution"],
     "competition": "medium", "keywords": ["bioscience", "agriculture", "food", "biotechnology"]},
    {"id": "mrc-pj", "agency": "MRC", "title": "MRC Project Grants",
     "areas": ["medicine", "health", "biomedical", "immunology"],
     "career_stage": "all", "min": 150000, "max": 500000,
     "deadline": "2026-06-17", "reqs": ["UK institution"],
     "competition": "high", "keywords": ["medical", "clinical", "translational", "biomedical"]},
    {"id": "hfsp-rg", "agency": "HFSP", "title": "Research Grants (Human Frontier Science Program)",
     "areas": ["biology", "neuroscience", "biophysics"],
     "career_stage": "mid", "min": 350000, "max": 450000,
     "deadline": "2026-03-30", "reqs": ["International team required", "Interdisciplinary"],
     "competition": "high", "keywords": ["interdisciplinary", "international", "frontier", "neuroscience"]},
    {"id": "embo-ig", "agency": "EMBO", "title": "EMBO Installation Grants",
     "areas": ["biology", "cell biology", "molecular biology"],
     "career_stage": "early", "min": 50000, "max": 50000,
     "deadline": "2026-08-01", "reqs": ["Setting up new lab in eligible country"],
     "competition": "medium", "keywords": ["molecular biology", "cell", "new lab", "early career"]},
    {"id": "alzheimer-soc", "agency": "Alzheimer's Society",
     "title": "Dementia Research Leader Awards",
     "areas": ["neuroscience", "dementia", "neurology"],
     "career_stage": "mid", "min": 500000, "max": 1000000,
     "deadline": "2026-02-28", "reqs": ["UK institution", "Dementia focus"],
     "competition": "medium", "keywords": ["dementia", "alzheimer", "neurodegeneration", "brain"]},
    {"id": "cruk-prog", "agency": "Cancer Research UK", "title": "Programme Grants",
     "areas": ["cancer", "oncology", "biology", "immunology"],
     "career_stage": "senior", "min": 1000000, "max": 3000000,
     "deadline": "2026-01-31", "reqs": ["UK institution", "Cancer research focus"],
     "competition": "high", "keywords": ["cancer", "tumour", "oncology", "immunotherapy"]},
    {"id": "ukri-trans", "agency": "UKRI", "title": "Transformative Research Investment",
     "areas": ["all"], "career_stage": "all", "min": 500000, "max": 5000000,
     "deadline": "2026-12-01", "reqs": ["UK institution", "High-risk high-reward"],
     "competition": "medium", "keywords": ["transformative", "high-risk", "innovative", "breakthrough"]},
]

# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class ProposalAnalysis:
    proposal_id: str
    title: str
    word_count: int
    analysis_score: float
    structure: Dict
    missing_sections: List[str]
    content_recommendations: List[str]
    methodology_suggestions: List[str]
    impact_suggestions: List[str]
    improvement_potential: float


@dataclass
class GrantOpportunity:
    opportunity_id: str
    agency: str
    title: str
    deadline_str: str
    min_amount: int
    max_amount: int
    match_score: float
    career_stage: str
    areas: List[str]
    requirements: List[str]
    success_probability: float
    competition: str
    rationale: str


@dataclass
class MethodologyRecommendation:
    research_question: str
    methodology_type: str
    recommended_approach: str
    specific_methods: List[str]
    statistical_plan: List[str]
    experimental_design: Dict
    data_collection: List[str]
    validation_methods: List[str]
    timeline_months: int
    resources_needed: List[str]


@dataclass
class WritingFeedback:
    document_type: str
    word_count: int
    sentence_count: int
    avg_sentence_length: float
    clarity_score: float
    passive_voice_ratio: float
    suggestions: List[str]
    missing_elements: List[str]
    strengths: List[str]


# ── Main service ───────────────────────────────────────────────────────────────

class ResearchAssistanceService:

    # ── Proposal analysis ─────────────────────────────────────────────────────

    def analyze_proposal(self, text: str, title: str = "",
                         research_area: str = "") -> Dict:
        words = text.split()
        word_count = len(words)
        text_lower = text.lower()

        # Section scoring
        sentences = re.split(r'(?<=[.!?])\s+', text.strip())
        total_sents = len(sentences) or 1
        structure = {}
        for sec, kws in _SECTIONS.items():
            sec_sents = sum(1 for s in sentences if any(k in s.lower() for k in kws))
            ratio = sec_sents / total_sents
            optimal = _OPTIMAL[sec]
            balance = max(0.0, 1.0 - abs(ratio - optimal) / (optimal + 1e-9))
            structure[sec] = {"ratio": round(ratio, 3), "balance_score": round(balance, 3)}

        analysis_score = sum(v["balance_score"] for v in structure.values()) / len(structure)
        missing = [s for s, v in structure.items() if v["ratio"] == 0]

        # Content recommendations
        recs = []
        if word_count < 500:
            recs.append("Proposal is too brief — aim for at least 800 words")
        for sec in missing:
            recs.append(f"Add a {sec.replace('_', ' ')} section")
        if not re.search(r'\b(statistic|regression|anova|t-test|chi|sample size)\b', text_lower):
            recs.append("Strengthen the statistical analysis plan")
        if not re.search(r'(\w+,\s+\d{4}|\[\d+\])', text):
            recs.append("Include literature citations (e.g. Author, Year or [n])")
        if not re.search(r'\b(hypothesis|hypothesize|aim|aims)\b', text_lower):
            recs.append("State explicit hypotheses or research aims")
        if structure["methodology"]["ratio"] < 0.15:
            recs.append("Expand the methodology section (currently under-represented)")

        # Methodology suggestions
        meth = []
        if "sample size" not in text_lower and "power analysis" not in text_lower:
            meth.append("Justify sample size with a power analysis")
        if "control" not in text_lower:
            meth.append("Consider including control groups or comparison conditions")
        if not re.search(r'\b(blind|randomiz|randomis)\b', text_lower):
            meth.append("Consider randomisation or blinding where applicable")
        if "validation" not in text_lower and "validate" not in text_lower:
            meth.append("Describe your validation approach")
        if "limitation" not in text_lower and "bias" not in text_lower:
            meth.append("Acknowledge study limitations and potential biases")

        # Impact suggestions
        impact = []
        area_lower = research_area.lower()
        if any(k in area_lower for k in ("health", "medicine", "clinical")):
            if "translational" not in text_lower and "patient" not in text_lower:
                impact.append("Highlight translational or clinical relevance")
        if "societal" not in text_lower and "society" not in text_lower:
            impact.append("Articulate broader societal or public benefit")
        if "dissemination" not in text_lower and "publish" not in text_lower:
            impact.append("Describe your dissemination and publication strategy")
        if "policy" not in text_lower:
            impact.append("Consider policy implications of your findings")

        pid = f"prop_{hash(text[:60]) & 0xFFFFFF:06x}"
        result = ProposalAnalysis(
            proposal_id=pid,
            title=title or "Untitled Proposal",
            word_count=word_count,
            analysis_score=round(analysis_score, 3),
            structure=structure,
            missing_sections=missing,
            content_recommendations=recs,
            methodology_suggestions=meth,
            impact_suggestions=impact,
            improvement_potential=round(1.0 - analysis_score, 3),
        )
        return {"success": True, "analysis": asdict(result)}

    # ── Grant matching ────────────────────────────────────────────────────────

    def find_grants(self, research_areas: List[str], career_stage: str = "mid",
                    limit: int = 10) -> Dict:
        areas_text = " ".join(a.lower() for a in research_areas)
        results = []
        for g in _GRANT_DB:
            # Career stage filter
            if g["career_stage"] != "all" and g["career_stage"] != career_stage:
                continue
            # Area score: keyword overlap
            g_areas = " ".join(g["areas"] + g["keywords"]).lower()
            matched = [a for a in research_areas if a.lower() in g_areas
                       or any(a.lower() in kw for kw in g["keywords"])]
            area_score = min(1.0, len(matched) / max(len(research_areas), 1))
            # Boost for "all"
            if "all" in g["areas"]:
                area_score = max(area_score, 0.5)
            stage_bonus = 0.0 if g["career_stage"] == "all" else 0.2
            match_score = min(1.0, area_score * 0.8 + stage_bonus)
            comp_map = {"low": 0.3, "medium": 0.2, "high": 0.1}
            success_prob = round(match_score * 0.7 + comp_map.get(g["competition"], 0.1), 3)
            rationale_parts = []
            if matched:
                rationale_parts.append(f"aligns with your areas: {', '.join(matched[:3])}")
            if g["career_stage"] == career_stage:
                rationale_parts.append(f"targets {career_stage}-career researchers")
            rationale = "; ".join(rationale_parts) or "General funding opportunity"
            results.append(GrantOpportunity(
                opportunity_id=g["id"], agency=g["agency"], title=g["title"],
                deadline_str=g["deadline"], min_amount=g["min"], max_amount=g["max"],
                match_score=round(match_score, 3), career_stage=g["career_stage"],
                areas=g["areas"], requirements=g["reqs"],
                success_probability=success_prob, competition=g["competition"],
                rationale=rationale,
            ))
        results.sort(key=lambda x: x.match_score, reverse=True)
        return {
            "success": True,
            "opportunities": [asdict(r) for r in results[:limit]],
            "count": min(len(results), limit),
        }

    # ── Methodology recommendation ────────────────────────────────────────────

    def recommend_methodology(self, research_question: str,
                               objectives: Optional[List[str]] = None,
                               resources: Optional[Dict] = None) -> Dict:
        q = research_question.lower()
        # Classify
        quant_signals = ["how many", "how much", "rate", "frequency", "correlation",
                         "effect of", "impact of", "predict", "measure", "quantify",
                         "compare", "difference between", "association"]
        qual_signals  = ["why", "how do", "experience", "perception", "meaning",
                         "understand", "explore", "describe", "phenomenon", "lived"]
        is_quant = any(s in q for s in quant_signals)
        is_qual  = any(s in q for s in qual_signals)
        if is_quant and is_qual:
            mtype = "mixed"
        elif is_qual:
            mtype = "qualitative"
        else:
            mtype = "quantitative"

        methods = {
            "quantitative": ["Randomized Controlled Trial (if applicable)",
                             "Regression analysis", "ANOVA / t-test",
                             "Survey / questionnaire", "Longitudinal cohort study"],
            "qualitative":  ["Semi-structured interviews", "Thematic analysis",
                             "Grounded theory", "Case study design", "Focus groups"],
            "mixed":        ["Sequential explanatory design", "Convergent parallel design",
                             "Survey + interviews", "Statistical + thematic coding"],
        }
        stats = {
            "quantitative": ["Descriptive statistics (mean, SD, CI)",
                             "Normality testing (Shapiro-Wilk)",
                             "Parametric / non-parametric tests as appropriate",
                             "Effect size (Cohen's d / η²)",
                             "Multiple comparison correction (Bonferroni/FDR)"],
            "qualitative":  ["Thematic coding", "Inter-rater reliability (Cohen's κ)",
                             "Member checking", "Saturation assessment"],
            "mixed":        ["Descriptive statistics + thematic coding",
                             "Integration matrix analysis", "Joint display approach"],
        }
        design_map = {
            "quantitative": {
                "design_type": "Randomized or quasi-experimental",
                "sample_strategy": "Probability sampling (random / stratified)",
                "controls": "Include appropriate control / comparison groups",
                "variables": "Define independent and dependent variables with operationalization",
            },
            "qualitative": {
                "design_type": "Interpretive / phenomenological",
                "sample_strategy": "Purposive sampling until saturation",
                "controls": "Reflexivity and bracketing of researcher bias",
                "variables": "Identify key themes and concepts a priori and emergent",
            },
            "mixed": {
                "design_type": "Sequential explanatory or convergent parallel",
                "sample_strategy": "Probability sampling (quant) + purposive (qual)",
                "controls": "Both experimental controls and reflexivity",
                "variables": "Quantitative variables + qualitative themes",
            },
        }
        data_col = {
            "quantitative": ["Standardised questionnaires / scales",
                             "Physiological / clinical measurements",
                             "Administrative / registry data", "Structured observation"],
            "qualitative":  ["In-depth interviews (recorded, transcribed)",
                             "Field notes and observation", "Document analysis",
                             "Participant diaries"],
            "mixed":        ["Survey instrument", "Follow-up interviews",
                             "Existing datasets", "Mixed data triangulation"],
        }
        validation = {
            "quantitative": ["Internal validity: randomisation or matching",
                             "External validity: representative sampling",
                             "Reliability: test-retest / Cronbach's α",
                             "Confirmatory analysis on held-out data"],
            "qualitative":  ["Member checking with participants",
                             "Peer debriefing / audit trail",
                             "Transferability via thick description",
                             "Negative case analysis"],
            "mixed":        ["Triangulation across data sources",
                             "Cross-validation of quantitative findings with qualitative",
                             "Mixed-method quality criteria matrix"],
        }
        timeline = {"quantitative": 18, "qualitative": 12, "mixed": 24}
        res_needed = ["Research personnel (PI + research assistant)",
                      "Data collection infrastructure / software",
                      "Participant recruitment budget",
                      "Statistical / qualitative analysis software",
                      "Dissemination budget (open-access fees, conference)"]
        approach = (f"{mtype.capitalize()} research using "
                    f"{methods[mtype][0].lower()} as primary method")
        rec = MethodologyRecommendation(
            research_question=research_question,
            methodology_type=mtype,
            recommended_approach=approach,
            specific_methods=methods[mtype],
            statistical_plan=stats[mtype],
            experimental_design=design_map[mtype],
            data_collection=data_col[mtype],
            validation_methods=validation[mtype],
            timeline_months=timeline[mtype],
            resources_needed=res_needed,
        )
        return {"success": True, "recommendation": asdict(rec)}

    # ── Writing feedback ──────────────────────────────────────────────────────

    def analyze_writing(self, text: str, document_type: str = "proposal") -> Dict:
        words = text.split()
        word_count = len(words)
        sentences = re.split(r'(?<=[.!?])\s+', text.strip())
        sentence_count = len(sentences) or 1
        avg_len = word_count / sentence_count
        passive_count = sum(
            1 for s in sentences
            if re.search(r'\b(is|are|was|were|be|been|being)\s+\w+ed\b', s, re.I)
        )
        passive_ratio = passive_count / sentence_count
        clarity = max(0.0, min(1.0,
            1.0 - max(0, (avg_len - 15) / 30) - passive_ratio * 0.3
        ))
        text_lower = text.lower()

        # Suggestions
        sugg = []
        if avg_len > 30:
            sugg.append(f"Average sentence length is {avg_len:.0f} words — break long sentences for clarity")
        if passive_ratio > 0.4:
            sugg.append(f"High passive voice ({passive_ratio*100:.0f}%) — prefer active constructions")
        if word_count < 300 and document_type == "proposal":
            sugg.append("Proposal is very short; elaborate on methodology and objectives")
        if "?" not in text and document_type == "proposal":
            sugg.append("Consider explicitly stating your research questions")
        if not re.search(r'\d+', text):
            sugg.append("Include quantitative evidence or statistics to support key claims")
        if "et al." not in text and not re.search(r'\[\d+\]', text):
            sugg.append("Add inline citations to support key claims")

        # Missing elements (proposal)
        missing = []
        if document_type == "proposal":
            checks = [
                (["hypothesis", "aim", "objective"], "Clear hypothesis or research aim"),
                (["method", "approach", "design"],   "Methodology description"),
                (["data", "sample", "participant", "cohort"], "Data collection plan"),
                (["timeline", "schedule", "phase"],  "Project timeline"),
                (["budget", "cost", "resource"],     "Budget justification"),
                (["impact", "significance", "contribution"], "Impact statement"),
            ]
            for kws, label in checks:
                if not any(k in text_lower for k in kws):
                    missing.append(label)

        # Strengths
        strengths = []
        if re.search(r'(\w+,\s+\d{4}|\[\d+\])', text):
            strengths.append("References included")
        if 15 <= avg_len <= 25:
            strengths.append("Good sentence length")
        if passive_ratio < 0.2:
            strengths.append("Active voice writing")
        if word_count > 800:
            strengths.append("Sufficient detail and depth")
        if re.search(r'\d+', text):
            strengths.append("Quantitative evidence present")

        fb = WritingFeedback(
            document_type=document_type,
            word_count=word_count,
            sentence_count=sentence_count,
            avg_sentence_length=round(avg_len, 1),
            clarity_score=round(clarity, 3),
            passive_voice_ratio=round(passive_ratio, 3),
            suggestions=sugg,
            missing_elements=missing,
            strengths=strengths,
        )
        return {"success": True, "feedback": asdict(fb)}


# ── Singleton ──────────────────────────────────────────────────────────────────

_svc: Optional[ResearchAssistanceService] = None


def get_research_assistance_service() -> ResearchAssistanceService:
    global _svc
    if _svc is None:
        _svc = ResearchAssistanceService()
    return _svc
