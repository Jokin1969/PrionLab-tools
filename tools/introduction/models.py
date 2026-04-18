import csv
import json
import logging
import os
import re
import uuid
from datetime import datetime

import pandas as pd

import config

logger = logging.getLogger(__name__)

CSV_DIR = config.CSV_DIR

APPROACHES_CSV  = os.path.join(CSV_DIR, "introduction_approaches.csv")
TEMPLATES_CSV   = os.path.join(CSV_DIR, "approach_templates.csv")
SNIPPETS_CSV    = os.path.join(CSV_DIR, "literature_snippets.csv")
GENERATIONS_CSV = os.path.join(CSV_DIR, "introduction_generations.csv")

APPROACHES_COLS = [
    "approach_id", "approach_name", "description", "target_manuscript_type",
    "opening_strategy", "transition_strategy", "focus_keywords",
    "literature_emphasis", "common_gaps", "objective_bridge_pattern",
]
TEMPLATES_COLS = [
    "template_id", "approach_id", "section_type", "template_text",
    "variable_placeholders", "usage_notes",
]
SNIPPETS_COLS = [
    "snippet_id", "approach_id", "category", "content_type",
    "snippet_text", "keywords", "context_usage",
]
GENERATIONS_COLS = [
    "generation_id", "user_id", "approach_id", "manuscript_title",
    "target_journal", "parameters_used", "generated_content",
    "sections_breakdown", "word_count", "created_at", "is_active",
]

# ── Seed data ─────────────────────────────────────────────────────────────────

_SEED_APPROACHES = [
    {"approach_id": "app_001", "approach_name": "Methodological Development",
     "description": "Focus on technique/methodology development for prion research",
     "target_manuscript_type": "Methods/Technical papers",
     "opening_strategy": "Sporadic disease incidence + model scarcity",
     "transition_strategy": "Lack of suitable systems",     "focus_keywords": "methodology development;in vitro systems;spontaneous modeling",
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

_SEED_TEMPLATES = [   {   'approach_id': 'app_001',
        'section_type': 'opening',
        'template_id': 'tpl_001',
        'template_text': 'Sporadic prion disease in humans, particularly sporadic Creutzfeldt-Jakob disease '
                         '(sCJD), accounts for approximately {sporadic_percentage}% of currently diagnosed '
                         'transmissible spongiform encephalopathies (TSE). With {context_factor}, '
                         'researchers studying the phenomenon of spontaneous misfolding suffer from scarcity '
                         'of suitable models.',
        'usage_notes': 'Use for methodology-focused papers',
        'variable_placeholders': 'sporadic_percentage;context_factor'},
    {   'approach_id': 'app_001',
        'section_type': 'transition',
        'template_id': 'tpl_002',
        'template_text': 'However, consistently replicating the spontaneous prion formation phenomenon is '
                         'still challenging. {previous_attempts} showed {limitation}, but {gap_description}.',
        'usage_notes': 'Bridge to methodology development',
        'variable_placeholders': 'previous_attempts;limitation;gap_description'},
    {   'approach_id': 'app_002',
        'section_type': 'opening',
        'template_id': 'tpl_003',
        'template_text': 'Prion diseases are a group of {disease_scope} neurodegenerative disorders that '
                         'affect {affected_species}. The underlying cause of these diseases is the '
                         'misfolding of the cellular prion protein (PrPC) into a pathological conformer '
                         '(PrPSc).',
        'usage_notes': 'Mechanisms-focused opening',
        'variable_placeholders': 'disease_scope;affected_species'},
    {   'approach_id': 'app_002',
        'section_type': 'transition',
        'template_id': 'tpl_004',
        'template_text': 'While {known_aspects} are understood, the molecular mechanisms determining '
                         '{specific_question} remain unknown. {strain_variability} further complicates '
                         '{study_focus}.',
        'usage_notes': 'Gap identification for mechanisms',
        'variable_placeholders': 'known_aspects;specific_question;strain_variability;study_focus'},
    {   'approach_id': 'app_003',
        'section_type': 'opening',
        'template_id': 'tpl_005',
        'template_text': 'Transmissible spongiform encephalopathies (TSEs) are invariably fatal '
                         'neurodegenerative disorders affecting humans and several mammals. '
                         '{transmission_context} illustrates the capacity of prions for interspecies '
                         'transmission and {barrier_concept}.',
        'usage_notes': 'Evolutionary/phylogenetic focus',
        'variable_placeholders': 'transmission_context;barrier_concept'},
    {   'approach_id': 'app_003',
        'section_type': 'transition',
        'template_id': 'tpl_006',
        'template_text': 'Understanding {research_question} could help reduce the risk of {risk_factors} and '
                         'provide insights into {evolutionary_insight}. {conservation_statement} suggests '
                         '{phylogenetic_implication}.',
        'usage_notes': 'Evolutionary gap bridge',
        'variable_placeholders': 'research_question;risk_factors;evolutionary_insight;conservation_statement;phylogenetic_implication'},
    {   'approach_id': 'app_004',
        'section_type': 'opening',
        'template_id': 'tpl_007',
        'template_text': '{disease_subtype} is {classification_context} with {distinctive_features} that '
                         'distinguish it from {comparison_diseases}. {diagnostic_challenge} and '
                         '{clinical_presentation}.',
        'usage_notes': 'Clinical/diagnostic opening',
        'variable_placeholders': 'disease_subtype;classification_context;distinctive_features;comparison_diseases;diagnostic_challenge;clinical_presentation'},
    {   'approach_id': 'app_004',
        'section_type': 'transition',
        'template_id': 'tpl_008',
        'template_text': '{current_limitations} remain {diagnostic_problem} during life. {clinical_need} '
                         'providing insights for {recognition_goal}.',
        'usage_notes': 'Clinical gap identification',
        'variable_placeholders': 'current_limitations;diagnostic_problem;clinical_need;recognition_goal'},
    {   'approach_id': 'app_005',
        'section_type': 'opening',
        'template_id': 'tpl_009',
        'template_text': 'Depending on the origin of the misfolded protein, prion diseases can be classified '
                         'as {etiology_types}. Idiopathic, commonly misnamed sporadic, occurrences involve '
                         '{spontaneous_description} and account for {prevalence_data}.',
        'usage_notes': 'Spontaneous formation focus',
        'variable_placeholders': 'etiology_types;spontaneous_description;prevalence_data'},
    {   'approach_id': 'app_005',
        'section_type': 'transition',
        'template_id': 'tpl_010',
        'template_text': 'Despite {knowledge_limitation} on potential factors triggering the latter forms, '
                         '{research_challenge} remains completely unknown. {model_limitation} has hindered '
                         '{research_goal}.',
        'usage_notes': 'Spontaneous formation gap',
        'variable_placeholders': 'knowledge_limitation;research_challenge;model_limitation;research_goal'}]

_SEED_SNIPPETS = [   {   'approach_id': 'app_001',
        'category': 'background',
        'content_type': 'statistic',
        'context_usage': 'Opening statistics',
        'keywords': 'sporadic prevalence',
        'snippet_id': 'lit_001',
        'snippet_text': 'accounts for approximately 85% of currently diagnosed transmissible spongiform '
                        'encephalopathies'},
    {   'approach_id': 'app_001',
        'category': 'gap',
        'content_type': 'limitation',
        'context_usage': 'Transition to new methods',
        'keywords': 'methodology limitation',
        'snippet_id': 'lit_002',
        'snippet_text': 'the complexity of initial propagation systems left room for alternative '
                        'explanations'},
    {   'approach_id': 'app_002',
        'category': 'background',
        'content_type': 'mechanism',
        'context_usage': 'Mechanism explanation',
        'keywords': 'basic mechanism',
        'snippet_id': 'lit_003',
        'snippet_text': 'the conformational conversion of the cellular prion protein (PrPC) into a '
                        'pathological conformer (PrPSc)'},
    {   'approach_id': 'app_002',
        'category': 'gap',
        'content_type': 'unknown',
        'context_usage': 'Strain formation gap',
        'keywords': 'mechanism gap',
        'snippet_id': 'lit_004',
        'snippet_text': 'the molecular mechanisms determining if a prion protein will arrange into one '
                        'conformer or another upon misfolding remain unknown'},
    {   'approach_id': 'app_003',
        'category': 'background',
        'content_type': 'conservation',
        'context_usage': 'Phylogenetic context',
        'keywords': 'evolutionary background',
        'snippet_id': 'lit_005',
        'snippet_text': 'PRNP gene is frequently described as highly conserved across mammals'},
    {   'approach_id': 'app_003',
        'category': 'gap',
        'content_type': 'species',
        'context_usage': 'Evolutionary question',
        'keywords': 'species susceptibility',
        'snippet_id': 'lit_006',
        'snippet_text': 'what determines the susceptibility of any given PrPC sequence to acquire a prion '
                        'conformation remains completely unknown'},
    {   'approach_id': 'app_004',
        'category': 'background',
        'content_type': 'clinical',
        'context_usage': 'Diagnostic characteristics',
        'keywords': 'clinical features',
        'snippet_id': 'lit_007',
        'snippet_text': 'shows a distinct neuroanatomical distribution and immunohistochemical abnormal '
                        'prion protein conformer (PrPSc) deposition pattern'},
    {   'approach_id': 'app_004',
        'category': 'gap',
        'content_type': 'diagnosis',
        'context_usage': 'Clinical challenge',
        'keywords': 'diagnostic gap',
        'snippet_id': 'lit_008',
        'snippet_text': 'do not fulfill established sCJD diagnostic criteria and remain underdiagnosed '
                        'during life'},
    {   'approach_id': 'app_005',
        'category': 'background',
        'content_type': 'sporadic',
        'context_usage': 'Spontaneous focus',
        'keywords': 'sporadic prevalence',
        'snippet_id': 'lit_009',
        'snippet_text': 'idiopathic prion disorders are the most prevalent, accounting for 85–90% of human '
                        'cases'},
    {   'approach_id': 'app_005',
        'category': 'gap',
        'content_type': 'triggers',
        'context_usage': 'Spontaneous formation gap',
        'keywords': 'spontaneous triggers',
        'snippet_id': 'lit_010',
        'snippet_text': 'the causes that trigger the supposedly spontaneous misfolding of the PrPC are '
                        'completely unknown'}]


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


# ── Exceptions & validation ───────────────────────────────────────────────────

class IntroductionGenerationError(Exception):
    pass

class TemplateNotFoundError(Exception):
    pass

class InvalidApproachError(Exception):
    pass

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


# ── Content generation engine ─────────────────────────────────────────────

_OPENING_VARS = {'app_001': {'context_factor': 'the near eradication of TSE acquired from exogenous sources and the '
                               'foreseeable reduction of genetic cases',
             'sporadic_percentage': '85'},
 'app_002': {'affected_species': 'humans and a wide range of mammals', 'disease_scope': 'ravaging'},
 'app_003': {'barrier_concept': 'the fact that some prion diseases can cross species barriers',
             'transmission_context': 'The mad cow disease crisis and experimental inoculations across '
                                     'multiple species'},
 'app_004': {'classification_context': 'the most recently described subtype of sporadic prion diseases',
             'clinical_presentation': 'remain underdiagnosed during life',
             'comparison_diseases': 'other sporadic prion diseases such as sCJD',
             'diagnostic_challenge': 'These cases do not fulfill established diagnostic criteria',
             'disease_subtype': 'Variably protease-sensitive prionopathy (VPSPr)',
             'distinctive_features': 'atypical neuropathological and biochemical features'},
 'app_005': {'etiology_types': 'acquired, genetic, or idiopathic conditions',
             'prevalence_data': '85–90% of human cases',
             'spontaneous_description': 'rare, spontaneous misfolding of wild-type PrPC'}}

_TRANSITION_VARS = {'app_001': {'gap_description': 'consistently replicating the spontaneous prion formation phenomenon is '
                                'still challenging',
             'limitation': 'low conversion yields and limited reproducibility',
             'previous_attempts': 'Initial attempts to replicate the prion misfolding phenomenon in vitro'},
 'app_002': {'known_aspects': 'the basic conformational conversion process',
             'specific_question': 'strain formation specificity',
             'strain_variability': 'The existence of multiple prion strains for a single PrP sequence',
             'study_focus': 'the study of spontaneous misfolding events'},
 'app_003': {'conservation_statement': 'The high conservation of the PRNP gene across mammalian species',
             'evolutionary_insight': 'the molecular determinants responsible for species susceptibility',
             'phylogenetic_implication': 'an evolutionarily conserved function predisposing all mammals to '
                                         'prion misfolding',
             'research_question': 'whether prion diseases could potentially affect all animal species',
             'risk_factors': 'new prion disease outbreaks and interspecies transmission events'},
 'app_004': {'clinical_need': 'Improved understanding of the neuropathological and biochemical hallmarks is '
                              'needed',
             'current_limitations': 'These cases',
             'diagnostic_problem': 'difficult to diagnose definitively',
             'recognition_goal': 'earlier and more accurate clinical recognition'},
 'app_005': {'knowledge_limitation': 'the lack of knowledge',
             'model_limitation': 'The scarcity and unpredictability of sporadic cases',
             'research_challenge': 'the study of spontaneous misfolding',
             'research_goal': 'the development of reproducible in vitro models'}}

_BACKGROUND_TEXT = {'app_001': 'The protein misfolding cyclic amplification (PMCA) and its successor, the protein misfolding '
            'shaking amplification (PMSA), have provided tools for in vitro propagation of prion seeds. '
            'However, these systems rely on pre-formed templates and do not model de novo formation of the '
            'aberrant conformer. Cell-free spontaneous generation systems represent a promising but '
            'technically demanding alternative.',
 'app_002': 'The PrPSc isoform propagates by recruiting and converting PrPC molecules, giving rise to the '
            'self-templating cycle of prion replication. Multiple distinct prion strains can arise from a '
            'single PrP sequence, each encoding a unique three-dimensional fold. Cofactors such as '
            'polyanions and lipids facilitate conformational conversion, yet their precise roles in strain '
            'specificity remain to be fully elucidated.',
 'app_003': 'The PRNP gene is frequently described as highly conserved across mammals, and prion diseases '
            'have been documented in a wide range of species. Experimental transmission studies have '
            'demonstrated that PrP primary sequence, particularly structural polymorphisms, plays a decisive '
            'role in governing species barriers. Comparative analyses of PRNP orthologues across the '
            'mammalian phylogeny offer a powerful framework for understanding the evolutionary pressures '
            'shaping prion susceptibility.',
 'app_004': 'Human prion diseases encompass a heterogeneous group including sporadic CJD, familial forms '
            'associated with PRNP mutations, and acquired diseases such as kuru and variant CJD. Within the '
            'sporadic group, molecular subtypes are defined by PrPSc glycoform pattern and codon 129 '
            'polymorphism. Novel clinicopathological entities with atypical features challenge established '
            'diagnostic frameworks.',
 'app_005': 'Idiopathic prion disorders account for the vast majority of human cases, yet the biological '
            'triggers that initiate the spontaneous structural transition of PrPC to PrPSc remain entirely '
            'unknown. Age-dependent cellular stress, oxidative damage, and stochastic misfolding events have '
            'been proposed as potential initiating factors.'}

_OBJECTIVE_VERBS = {'app_001': 'develop and validate',
 'app_002': 'elucidate',
 'app_003': 'investigate',
 'app_004': 'characterize',
 'app_005': 'model and reproduce'}

_OBJECTIVE_GOALS = {'app_001': 'a robust, reproducible methodology for {research_focus}, overcoming current limitations in '
            'spontaneous prion generation systems',
 'app_002': 'the molecular mechanisms governing {research_focus} and their contribution to prion strain '
            'diversity',
 'app_003': 'the evolutionary determinants of {research_focus} and their implications for cross-species '
            'prion transmission',
 'app_004': 'the clinicopathological features of {research_focus} to improve diagnostic criteria and patient '
            'recognition',
 'app_005': 'the spontaneous misfolding process underlying {research_focus}, shedding light on the triggers '
            'of idiopathic prion disease'}


def _apply_vars(template_text, variables):
    result = template_text
    for key, value in variables.items():
        result = result.replace("{" + key + "}", value)
    result = re.sub(r"\{[^}]+\}", "", result)
    return result.strip()


def _generate_opening(approach_id, params):
    templates = get_approach_templates(approach_id, "opening")
    if not templates:
        raise TemplateNotFoundError(f"No opening template for {approach_id}")
    vars_ = dict(_OPENING_VARS.get(approach_id, {}))
    if approach_id == "app_004" and params.get("manuscript_title"):
        vars_["disease_subtype"] = params["manuscript_title"]
    return _apply_vars(templates[0]["template_text"], vars_)


def _generate_background(approach_id):
    return _BACKGROUND_TEXT.get(approach_id, "")


def _generate_transition(approach_id):
    templates = get_approach_templates(approach_id, "transition")
    if not templates:
        return ""
    return _apply_vars(templates[0]["template_text"], dict(_TRANSITION_VARS.get(approach_id, {})))


def _generate_literature_note(approach_id):
    snippets = get_literature_snippets(approach_id, "gap")
    if not snippets:
        return ""
    return "Importantly, " + snippets[0]["snippet_text"] + "."


def _generate_objective_bridge(approach_id, params):
    verb = _OBJECTIVE_VERBS.get(approach_id, "investigate")
    goal_tmpl = _OBJECTIVE_GOALS.get(approach_id, "the topic of {research_focus}")
    research_focus = params.get("research_focus", "the phenomenon").replace("_", " ")
    goal = goal_tmpl.replace("{research_focus}", research_focus)
    title = params.get("manuscript_title", "")
    if title:
        return f"Here we {verb} {goal}, using the approach described herein."
    return f"Here we {verb} {goal}."


def _combine_sections(approach_id, sections):
    parts = []
    for key in ("opening", "background", "literature_note", "gap_identification", "objective_bridge"):
        if sections.get(key):
            parts.append(sections[key])
    return "\n\n".join(parts)


def _save_generation(params, sections, full_text, word_count, user_id):
    generation_id = "gen_" + uuid.uuid4().hex[:8]
    record = {
        "generation_id": generation_id,
        "user_id": user_id,
        "approach_id": params.get("approach_id", ""),
        "manuscript_title": params.get("manuscript_title", ""),
        "target_journal": params.get("target_journal", ""),
        "parameters_used": json.dumps(params),
        "generated_content": full_text,
        "sections_breakdown": json.dumps(sections),
        "word_count": str(word_count),
        "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "is_active": "true",
    }
    df = _read(GENERATIONS_CSV, GENERATIONS_COLS)
    df = pd.concat([df, pd.DataFrame([record])], ignore_index=True)
    _write(df, GENERATIONS_CSV)
    return generation_id


def generate_introduction_content(params, user_id):
    approach_id = params.get("approach_id", "")
    approach = get_approach_details(approach_id)
    if not approach:
        raise InvalidApproachError(f"Unknown approach: {approach_id}")
    try:
        sections = {
            "opening": _generate_opening(approach_id, params),
            "background": _generate_background(approach_id),
            "literature_note": _generate_literature_note(approach_id),
            "gap_identification": _generate_transition(approach_id),
            "objective_bridge": _generate_objective_bridge(approach_id, params),
        }
        full_text = _combine_sections(approach_id, sections)
        word_count = len(full_text.split())
        generation_id = _save_generation(params, sections, full_text, word_count, user_id)
        return {
            "full_text": full_text,
            "sections": sections,
            "word_count": word_count,
            "approach_used": approach["approach_name"],
            "generation_id": generation_id,
        }
    except (TemplateNotFoundError, InvalidApproachError):
        raise
    except Exception as e:
        logger.error("Introduction generation failed: %s", e)
        raise IntroductionGenerationError(f"Generation failed: {e}")
