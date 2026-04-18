"""Script to generate the complete models.py for the Introduction module."""
import os

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.py")

SEED_APPROACHES = [
    {"approach_id": "app_001", "approach_name": "Methodological Development",
     "description": "Focus on technique/methodology development for prion research",
     "target_manuscript_type": "Methods/Technical papers",
     "opening_strategy": "Sporadic disease incidence + model scarcity",
     "transition_strategy": "Lack of suitable systems",
     "focus_keywords": "methodology development;in vitro systems;spontaneous modeling",
     "literature_emphasis": "PMCA;PMSA;cell-free systems",
     "common_gaps": "Scarcity of reproducible models",
     "objective_bridge_pattern": "demonstrate/develop/establish methodology"},
    {"approach_id": "app_002", "approach_name": "Disease Mechanisms/Strains",
     "description": "Focus on molecular mechanisms and strain formation",
     "target_manuscript_type": "Research articles on mechanisms",
     "opening_strategy": "Prion disease pathophysiology",
     "transition_strategy": "Unknown molecular mechanisms",
     "focus_keywords": "conformational conversion;strain formation;molecular determinants",
     "literature_emphasis": "strain properties;misfolding mechanisms;cofactors",
     "common_gaps": "Molecular mechanisms remain unknown",
     "objective_bridge_pattern": "elucidate/investigate/determine mechanisms"},
    {"approach_id": "app_003", "approach_name": "Evolutionary/Phylogenetic",
     "description": "Focus on species susceptibility and evolution",
     "target_manuscript_type": "Comparative/evolutionary studies",
     "opening_strategy": "Cross-species TSE occurrence",
     "transition_strategy": "Variable species susceptibility",
     "focus_keywords": "phylogeny;species barriers;evolutionary pressure",
     "literature_emphasis": "interspecies transmission;PRNP conservation",
     "common_gaps": "Limited understanding of susceptibility patterns",
     "objective_bridge_pattern": "evaluate/assess/explore evolutionary factors"},
    {"approach_id": "app_004", "approach_name": "Clinical/Diagnostic",
     "description": "Focus on clinical cases and diagnostic challenges",
     "target_manuscript_type": "Clinical studies/case reports",
     "opening_strategy": "Disease phenotype variability",
     "transition_strategy": "Diagnostic difficulties",
     "focus_keywords": "clinical presentation;diagnostic criteria;biomarkers",
     "literature_emphasis": "diagnostic methods;case reports;phenotypic variability",
     "common_gaps": "Underdiagnosis and misclassification",
     "objective_bridge_pattern": "characterize/describe/improve diagnosis"},
    {"approach_id": "app_005", "approach_name": "Spontaneous Formation",
     "description": "Focus on spontaneous misfolding phenomenon",
     "target_manuscript_type": "Sporadic disease studies",
     "opening_strategy": "Sporadic forms prevalence",
     "transition_strategy": "Unknown triggering factors",
     "focus_keywords": "spontaneous misfolding;idiopathic disease;stochastic events",
     "literature_emphasis": "spontaneous generation;sporadic CJD;cofactor-free systems",
     "common_gaps": "Triggers for spontaneous misfolding unknown",
     "objective_bridge_pattern": "understand/model/reproduce spontaneous formation"},
]

SEED_TEMPLATES = [
    {"template_id": "tpl_001", "approach_id": "app_001", "section_type": "opening",
     "template_text": ("Sporadic prion disease in humans, particularly sporadic "
         "Creutzfeldt-Jakob disease (sCJD), accounts for approximately "
         "{sporadic_percentage}% of currently diagnosed transmissible spongiform "
         "encephalopathies (TSE). With {context_factor}, researchers studying the "
         "phenomenon of spontaneous misfolding suffer from scarcity of suitable models."),
     "variable_placeholders": "sporadic_percentage;context_factor",
     "usage_notes": "Use for methodology-focused papers"},
    {"template_id": "tpl_002", "approach_id": "app_001", "section_type": "transition",
     "template_text": ("However, consistently replicating the spontaneous prion formation "
         "phenomenon is still challenging. {previous_attempts} showed {limitation}, "
         "but {gap_description}."),
     "variable_placeholders": "previous_attempts;limitation;gap_description",
     "usage_notes": "Bridge to methodology development"},
    {"template_id": "tpl_003", "approach_id": "app_002", "section_type": "opening",
     "template_text": ("Prion diseases are a group of {disease_scope} neurodegenerative "
         "disorders that affect {affected_species}. The underlying cause of these diseases "
         "is the misfolding of the cellular prion protein (PrPC) into a pathological "
         "conformer (PrPSc)."),
     "variable_placeholders": "disease_scope;affected_species",
     "usage_notes": "Mechanisms-focused opening"},
    {"template_id": "tpl_004", "approach_id": "app_002", "section_type": "transition",
     "template_text": ("While {known_aspects} are understood, the molecular mechanisms "
         "determining {specific_question} remain unknown. {strain_variability} further "
         "complicates {study_focus}."),
     "variable_placeholders": "known_aspects;specific_question;strain_variability;study_focus",
     "usage_notes": "Gap identification for mechanisms"},
    {"template_id": "tpl_005", "approach_id": "app_003", "section_type": "opening",
     "template_text": ("Transmissible spongiform encephalopathies (TSEs) are invariably "
         "fatal neurodegenerative disorders affecting humans and several mammals. "
         "{transmission_context} illustrates the capacity of prions for interspecies "
         "transmission and {barrier_concept}."),
     "variable_placeholders": "transmission_context;barrier_concept",
     "usage_notes": "Evolutionary/phylogenetic focus"},
    {"template_id": "tpl_006", "approach_id": "app_003", "section_type": "transition",
     "template_text": ("Understanding {research_question} could help reduce the risk of "
         "{risk_factors} and provide insights into {evolutionary_insight}. "
         "{conservation_statement} suggests {phylogenetic_implication}."),
     "variable_placeholders": ("research_question;risk_factors;evolutionary_insight;"
         "conservation_statement;phylogenetic_implication"),
     "usage_notes": "Evolutionary gap bridge"},
    {"template_id": "tpl_007", "approach_id": "app_004", "section_type": "opening",
     "template_text": ("{disease_subtype} is {classification_context} with "
         "{distinctive_features} that distinguish it from {comparison_diseases}. "
         "{diagnostic_challenge} and {clinical_presentation}."),
     "variable_placeholders": ("disease_subtype;classification_context;distinctive_features;"
         "comparison_diseases;diagnostic_challenge;clinical_presentation"),
     "usage_notes": "Clinical/diagnostic opening"},
    {"template_id": "tpl_008", "approach_id": "app_004", "section_type": "transition",
     "template_text": ("{current_limitations} remain {diagnostic_problem} during life. "
         "{clinical_need} providing insights for {recognition_goal}."),
     "variable_placeholders": "current_limitations;diagnostic_problem;clinical_need;recognition_goal",
     "usage_notes": "Clinical gap identification"},
    {"template_id": "tpl_009", "approach_id": "app_005", "section_type": "opening",
     "template_text": ("Depending on the origin of the misfolded protein, prion diseases "
         "can be classified as {etiology_types}. Idiopathic, commonly misnamed sporadic, "
         "occurrences involve {spontaneous_description} and account for {prevalence_data}."),
     "variable_placeholders": "etiology_types;spontaneous_description;prevalence_data",
     "usage_notes": "Spontaneous formation focus"},
    {"template_id": "tpl_010", "approach_id": "app_005", "section_type": "transition",
     "template_text": ("Despite {knowledge_limitation} on potential factors triggering "
         "the latter forms, {research_challenge} remains completely unknown. "
         "{model_limitation} has hindered {research_goal}."),
     "variable_placeholders": "knowledge_limitation;research_challenge;model_limitation;research_goal",
     "usage_notes": "Spontaneous formation gap"},
]

SEED_SNIPPETS = [
    {"snippet_id": "lit_001", "approach_id": "app_001", "category": "background",
     "content_type": "statistic",
     "snippet_text": "accounts for approximately 85% of currently diagnosed transmissible spongiform encephalopathies",
     "keywords": "sporadic prevalence", "context_usage": "Opening statistics"},
    {"snippet_id": "lit_002", "approach_id": "app_001", "category": "gap",
     "content_type": "limitation",
     "snippet_text": "the complexity of initial propagation systems left room for alternative explanations",
     "keywords": "methodology limitation", "context_usage": "Transition to new methods"},
    {"snippet_id": "lit_003", "approach_id": "app_002", "category": "background",
     "content_type": "mechanism",
     "snippet_text": "the conformational conversion of the cellular prion protein (PrPC) into a pathological conformer (PrPSc)",
     "keywords": "basic mechanism", "context_usage": "Mechanism explanation"},
    {"snippet_id": "lit_004", "approach_id": "app_002", "category": "gap",
     "content_type": "unknown",
     "snippet_text": "the molecular mechanisms determining if a prion protein will arrange into one conformer or another upon misfolding remain unknown",
     "keywords": "mechanism gap", "context_usage": "Strain formation gap"},
    {"snippet_id": "lit_005", "approach_id": "app_003", "category": "background",
     "content_type": "conservation",
     "snippet_text": "PRNP gene is frequently described as highly conserved across mammals",
     "keywords": "evolutionary background", "context_usage": "Phylogenetic context"},
    {"snippet_id": "lit_006", "approach_id": "app_003", "category": "gap",
     "content_type": "species",
     "snippet_text": "what determines the susceptibility of any given PrPC sequence to acquire a prion conformation remains completely unknown",
     "keywords": "species susceptibility", "context_usage": "Evolutionary question"},
    {"snippet_id": "lit_007", "approach_id": "app_004", "category": "background",
     "content_type": "clinical",
     "snippet_text": "shows a distinct neuroanatomical distribution and immunohistochemical abnormal prion protein conformer (PrPSc) deposition pattern",
     "keywords": "clinical features", "context_usage": "Diagnostic characteristics"},
    {"snippet_id": "lit_008", "approach_id": "app_004", "category": "gap",
     "content_type": "diagnosis",
     "snippet_text": "do not fulfill established sCJD diagnostic criteria and remain underdiagnosed during life",
     "keywords": "diagnostic gap", "context_usage": "Clinical challenge"},
    {"snippet_id": "lit_009", "approach_id": "app_005", "category": "background",
     "content_type": "sporadic",
     "snippet_text": "idiopathic prion disorders are the most prevalent, accounting for 85\u201390% of human cases",
     "keywords": "sporadic prevalence", "context_usage": "Spontaneous focus"},
    {"snippet_id": "lit_010", "approach_id": "app_005", "category": "gap",
     "content_type": "triggers",
     "snippet_text": "the causes that trigger the supposedly spontaneous misfolding of the PrPC are completely unknown",
     "keywords": "spontaneous triggers", "context_usage": "Spontaneous formation gap"},
]

import repr as _repr_mod
import pprint

def r(v):
    return repr(v)

lines = []
lines.append("import csv")
lines.append("import json")
lines.append("import logging")
lines.append("import os")
lines.append("import re")
lines.append("import uuid")
lines.append("from datetime import datetime")
lines.append("")
lines.append("import pandas as pd")
lines.append("")
lines.append("import config")
lines.append("")
lines.append("logger = logging.getLogger(__name__)")
lines.append("")
lines.append("CSV_DIR = config.CSV_DIR")
lines.append("")
lines.append("APPROACHES_CSV  = os.path.join(CSV_DIR, 'introduction_approaches.csv')")
lines.append("TEMPLATES_CSV   = os.path.join(CSV_DIR, 'approach_templates.csv')")
lines.append("SNIPPETS_CSV    = os.path.join(CSV_DIR, 'literature_snippets.csv')")
lines.append("GENERATIONS_CSV = os.path.join(CSV_DIR, 'introduction_generations.csv')")
lines.append("")
lines.append("APPROACHES_COLS = ['approach_id','approach_name','description','target_manuscript_type','opening_strategy','transition_strategy','focus_keywords','literature_emphasis','common_gaps','objective_bridge_pattern']")
lines.append("TEMPLATES_COLS = ['template_id','approach_id','section_type','template_text','variable_placeholders','usage_notes']")
lines.append("SNIPPETS_COLS = ['snippet_id','approach_id','category','content_type','snippet_text','keywords','context_usage']")
lines.append("GENERATIONS_COLS = ['generation_id','user_id','approach_id','manuscript_title','target_journal','parameters_used','generated_content','sections_breakdown','word_count','created_at','is_active']")
lines.append("")

# Emit seed data using pprint
lines.append("_SEED_APPROACHES = " + pprint.pformat(SEED_APPROACHES, width=100))
lines.append("")
lines.append("_SEED_TEMPLATES = " + pprint.pformat(SEED_TEMPLATES, width=100))
lines.append("")
lines.append("_SEED_SNIPPETS = " + pprint.pformat(SEED_SNIPPETS, width=100))
lines.append("")

# CSV helpers
lines.append("""
# ── CSV helpers ───────────────────────────────────────────────────────────────

def _read(path, cols):
    if not os.path.exists(path):
        return pd.DataFrame(columns=cols)
    try:
        return pd.read_csv(path, dtype=str).fillna("")
    except Exception:
        return pd.DataFrame(columns=cols)


def _write(df, path):
    df.to_csv(path, index=False, quoting=csv.QUOTE_ALL)


# ── Seeding ───────────────────────────────────────────────────────────────────

def _seed_if_empty(path, cols, seed_data, label):
    if os.path.exists(path):
        try:
            if not pd.read_csv(path, dtype=str).empty:
                return
        except Exception:
            pass
    pd.DataFrame(seed_data).to_csv(path, index=False, quoting=csv.QUOTE_ALL)
    logger.info("Introduction %s seeded.", label)


def _seed_approaches_if_empty():
    _seed_if_empty(APPROACHES_CSV, APPROACHES_COLS, _SEED_APPROACHES, "approaches")


def _seed_templates_if_empty():
    _seed_if_empty(TEMPLATES_CSV, TEMPLATES_COLS, _SEED_TEMPLATES, "approach templates")


def _seed_snippets_if_empty():
    _seed_if_empty(SNIPPETS_CSV, SNIPPETS_COLS, _SEED_SNIPPETS, "literature snippets")


def _seed_generations_if_empty():
    if not os.path.exists(GENERATIONS_CSV):
        pd.DataFrame(columns=GENERATIONS_COLS).to_csv(
            GENERATIONS_CSV, index=False, quoting=csv.QUOTE_ALL
        )


def bootstrap_introduction_schema():
    _seed_approaches_if_empty()
    _seed_templates_if_empty()
    _seed_snippets_if_empty()
    _seed_generations_if_empty()


# ── Data access ───────────────────────────────────────────────────────────────

def get_all_approaches():
    return _read(APPROACHES_CSV, APPROACHES_COLS).to_dict(orient="records")


def get_approach_details(approach_id):
    df = _read(APPROACHES_CSV, APPROACHES_COLS)
    row = df[df["approach_id"] == approach_id]
    return row.iloc[0].to_dict() if not row.empty else None


def get_approach_name(approach_id):
    a = get_approach_details(approach_id)
    return a["approach_name"] if a else approach_id


def get_approach_templates(approach_id, section_type=None):
    df = _read(TEMPLATES_CSV, TEMPLATES_COLS)
    df = df[df["approach_id"] == approach_id]
    if section_type:
        df = df[df["section_type"] == section_type]
    return df.to_dict(orient="records")


def get_literature_snippets(approach_id, categories=None):
    df = _read(SNIPPETS_CSV, SNIPPETS_COLS)
    df = df[df["approach_id"] == approach_id]
    if categories:
        if isinstance(categories, str):
            categories = [categories]
        df = df[df["category"].isin(categories)]
    return df.to_dict(orient="records")


def get_user_recent_introductions(user_id, limit=10):
    df = _read(GENERATIONS_CSV, GENERATIONS_COLS)
    if df.empty:
        return []
    df = df[(df["user_id"] == user_id) & (df["is_active"] == "true")]
    df = df.sort_values("created_at", ascending=False).head(limit)
    return df.to_dict(orient="records")


def get_introduction_generation(generation_id, user_id):
    df = _read(GENERATIONS_CSV, GENERATIONS_COLS)
    row = df[(df["generation_id"] == generation_id) & (df["user_id"] == user_id)]
    return row.iloc[0].to_dict() if not row.empty else None


def delete_introduction_generation(generation_id, user_id):
    df = _read(GENERATIONS_CSV, GENERATIONS_COLS)
    mask = (df["generation_id"] == generation_id) & (df["user_id"] == user_id)
    if not mask.any():
        return False
    df.loc[mask, "is_active"] = "false"
    _write(df, GENERATIONS_CSV)
    return True


# ── Rate limiting ─────────────────────────────────────────────────────────────

def check_generation_rate_limit(user_id):
    df = _read(GENERATIONS_CSV, GENERATIONS_COLS)
    if df.empty:
        return True
    today = datetime.utcnow().strftime("%Y-%m-%d")
    user_today = df[
        (df["user_id"] == user_id) &
        (df["created_at"].str.startswith(today)) &
        (df["is_active"] == "true")
    ]
    return len(user_today) < 5


# ── Custom exceptions ─────────────────────────────────────────────────────────

class IntroductionGenerationError(Exception):
    pass


class TemplateNotFoundError(Exception):
    pass


class InvalidApproachError(Exception):
    pass


# ── Validation ────────────────────────────────────────────────────────────────

_VALID_APPROACHES = {"app_001", "app_002", "app_003", "app_004", "app_005"}

_SUPPORTED_JOURNALS = {
    "PLoS Pathog", "PNAS", "Mol Neurobiol",
    "Brain Pathol", "Acta Neuropathol Commun", "Nat Commun",
}


def validate_introduction_parameters(data):
    errors, warnings = [], []
    for field in ("approach_id", "manuscript_title", "target_journal"):
        if not data.get(field):
            errors.append(f"Missing required field: {field}")
    if data.get("approach_id") and data["approach_id"] not in _VALID_APPROACHES:
        errors.append("Invalid approach selected.")
    title = data.get("manuscript_title", "")
    if title and len(title) < 10:
        warnings.append("Title seems too short for effective content generation.")
    elif len(title) > 200:
        errors.append("Title too long (max 200 characters).")
    if data.get("target_journal") and data["target_journal"] not in _SUPPORTED_JOURNALS:
        warnings.append("Journal not in enhanced templates; generic formatting will be used.")
    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}
""")

# Content generation engine
lines.append("""
# ── Content generation engine ─────────────────────────────────────────────────

_OPENING_VARS = {
    "app_001": {
        "sporadic_percentage": "85",
        "context_factor": ("the near eradication of TSE acquired from exogenous sources "
                           "and the foreseeable reduction of genetic cases"),
    },
    "app_002": {
        "disease_scope": "ravaging",
        "affected_species": "humans and a wide range of mammals",
    },
    "app_003": {
        "transmission_context": ("The mad cow disease crisis and experimental inoculations "
                                 "across multiple species"),
        "barrier_concept": "the fact that some prion diseases can cross species barriers",
    },
    "app_004": {
        "disease_subtype": "Variably protease-sensitive prionopathy (VPSPr)",
        "classification_context": "the most recently described subtype of sporadic prion diseases",
        "distinctive_features": "atypical neuropathological and biochemical features",
        "comparison_diseases": "other sporadic prion diseases such as sCJD",
        "diagnostic_challenge": "These cases do not fulfill established diagnostic criteria",
        "clinical_presentation": "remain underdiagnosed during life",
    },
    "app_005": {
        "etiology_types": "acquired, genetic, or idiopathic conditions",
        "spontaneous_description": "rare, spontaneous misfolding of wild-type PrPC",
        "prevalence_data": "85\\u201390% of human cases",
    },
}

_TRANSITION_VARS = {
    "app_001": {
        "previous_attempts": "Initial attempts to replicate the prion misfolding phenomenon in vitro",
        "limitation": "low conversion yields and limited reproducibility",
        "gap_description": ("consistently replicating the spontaneous prion formation phenomenon "
                            "is still challenging"),
    },
    "app_002": {
        "known_aspects": "the basic conformational conversion process",
        "specific_question": "strain formation specificity",
        "strain_variability": "The existence of multiple prion strains for a single PrP sequence",
        "study_focus": "the study of spontaneous misfolding events",
    },
    "app_003": {
        "research_question": "whether prion diseases could potentially affect all animal species",
        "risk_factors": "new prion disease outbreaks and interspecies transmission events",
        "evolutionary_insight": "the molecular determinants responsible for species susceptibility",
        "conservation_statement": "The high conservation of the PRNP gene across mammalian species",
        "phylogenetic_implication": ("an evolutionarily conserved function that may predispose "
                                     "all mammals to prion misfolding"),
    },
    "app_004": {
        "current_limitations": "These cases",
        "diagnostic_problem": "difficult to diagnose definitively",
        "clinical_need": ("Improved understanding of the neuropathological and biochemical "
                          "hallmarks is needed"),
        "recognition_goal": "earlier and more accurate clinical recognition",
    },
    "app_005": {
        "knowledge_limitation": "the lack of knowledge",
        "research_challenge": "the study of spontaneous misfolding",
        "model_limitation": "The scarcity and unpredictability of sporadic cases",
        "research_goal": "the development of reproducible in vitro models",
    },
}

_BACKGROUND_TEXT = {
    "app_001": (
        "The protein misfolding cyclic amplification (PMCA) technique and its successor, "
        "the protein misfolding shaking amplification (PMSA), have provided valuable tools "
        "for the in vitro propagation of prion seeds. However, these systems rely on "
        "pre-formed prion templates and do not model de novo formation of the aberrant "
        "conformer. Cell-free spontaneous generation systems represent a promising but "
        "technically demanding alternative, requiring high-purity recombinant substrate "
        "and precise biochemical conditions."
    ),
    "app_002": (
        "The PrPSc isoform propagates by recruiting and converting PrPC molecules, giving "
        "rise to the characteristic self-templating cycle of prion replication. Multiple "
        "distinct prion strains can arise from a single PrP sequence, each encoding a "
        "unique three-dimensional fold that determines their biological and pathological "
        "properties. Cofactors such as polyanions and lipids have been implicated in "
        "facilitating conformational conversion, yet their precise roles in determining "
        "strain specificity remain to be fully elucidated."
    ),
    "app_003": (
        "The PRNP gene is frequently described as highly conserved across mammals, and "
        "prion diseases have been documented in a wide taxonomic range of species, from "
        "cervids to felines and non-human primates. Experimental transmission studies "
        "have demonstrated that the primary sequence of PrP, particularly structural "
        "polymorphisms, plays a decisive role in governing species barriers. Comparative "
        "analyses of PRNP orthologues across the mammalian phylogeny offer a powerful "
        "framework for understanding the evolutionary pressures shaping prion susceptibility."
    ),
    "app_004": (
        "Human prion diseases encompass a heterogeneous group of conditions, including "
        "sporadic CJD, familial forms associated with PRNP mutations, and acquired "
        "diseases such as kuru and variant CJD. Within the sporadic group, molecular "
        "subtypes are defined by PrPSc glycoform pattern and codon 129 polymorphism. "
        "The identification of novel clinicopathological entities with atypical features "
        "challenges established diagnostic frameworks and underscores the phenotypic "
        "diversity of human prionopathies."
    ),
    "app_005": (
        "Idiopathic prion disorders account for the vast majority of human cases, yet "
        "the biological triggers that initiate the spontaneous structural transition of "
        "PrPC to PrPSc remain entirely unknown. Age-dependent cellular stress, oxidative "
        "damage, and stochastic misfolding events have all been proposed as potential "
        "initiating factors. The absence of a transmissible source or identified PRNP "
        "mutation in idiopathic cases defines them operationally, but does not illuminate "
        "the underlying molecular events."
    ),
}

_OBJECTIVE_VERBS = {
    "app_001": "develop and validate",
    "app_002": "elucidate",
    "app_003": "investigate",
    "app_004": "characterize",
    "app_005": "model and reproduce",
}

_OBJECTIVE_GOALS = {
    "app_001": ("a robust, reproducible methodology for {research_focus}, overcoming "
                "current limitations in spontaneous prion generation systems"),
    "app_002": ("the molecular mechanisms governing {research_focus} and their contribution