import ast, os

target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.py")

_OPENING_VARS = {
    "app_001": {"sporadic_percentage": "85",
                "context_factor": "the near eradication of TSE acquired from exogenous sources and the foreseeable reduction of genetic cases"},
    "app_002": {"disease_scope": "ravaging", "affected_species": "humans and a wide range of mammals"},
    "app_003": {"transmission_context": "The mad cow disease crisis and experimental inoculations across multiple species",
                "barrier_concept": "the fact that some prion diseases can cross species barriers"},
    "app_004": {"disease_subtype": "Variably protease-sensitive prionopathy (VPSPr)",
                "classification_context": "the most recently described subtype of sporadic prion diseases",
                "distinctive_features": "atypical neuropathological and biochemical features",
                "comparison_diseases": "other sporadic prion diseases such as sCJD",
                "diagnostic_challenge": "These cases do not fulfill established diagnostic criteria",
                "clinical_presentation": "remain underdiagnosed during life"},
    "app_005": {"etiology_types": "acquired, genetic, or idiopathic conditions",
                "spontaneous_description": "rare, spontaneous misfolding of wild-type PrPC",
                "prevalence_data": "85\u201390% of human cases"},
}

_TRANSITION_VARS = {
    "app_001": {"previous_attempts": "Initial attempts to replicate the prion misfolding phenomenon in vitro",
                "limitation": "low conversion yields and limited reproducibility",
                "gap_description": "consistently replicating the spontaneous prion formation phenomenon is still challenging"},
    "app_002": {"known_aspects": "the basic conformational conversion process",
                "specific_question": "strain formation specificity",
                "strain_variability": "The existence of multiple prion strains for a single PrP sequence",
                "study_focus": "the study of spontaneous misfolding events"},
    "app_003": {"research_question": "whether prion diseases could potentially affect all animal species",
                "risk_factors": "new prion disease outbreaks and interspecies transmission events",
                "evolutionary_insight": "the molecular determinants responsible for species susceptibility",
                "conservation_statement": "The high conservation of the PRNP gene across mammalian species",
                "phylogenetic_implication": "an evolutionarily conserved function predisposing all mammals to prion misfolding"},
    "app_004": {"current_limitations": "These cases", "diagnostic_problem": "difficult to diagnose definitively",
                "clinical_need": "Improved understanding of the neuropathological and biochemical hallmarks is needed",
                "recognition_goal": "earlier and more accurate clinical recognition"},
    "app_005": {"knowledge_limitation": "the lack of knowledge", "research_challenge": "the study of spontaneous misfolding",
                "model_limitation": "The scarcity and unpredictability of sporadic cases",
                "research_goal": "the development of reproducible in vitro models"},
}

_BACKGROUND_TEXT = {
    "app_001": ("The protein misfolding cyclic amplification (PMCA) and its successor, the protein "
                "misfolding shaking amplification (PMSA), have provided tools for in vitro propagation "
                "of prion seeds. However, these systems rely on pre-formed templates and do not model "
                "de novo formation of the aberrant conformer. Cell-free spontaneous generation systems "
                "represent a promising but technically demanding alternative."),
    "app_002": ("The PrPSc isoform propagates by recruiting and converting PrPC molecules, giving rise "
                "to the self-templating cycle of prion replication. Multiple distinct prion strains can "
                "arise from a single PrP sequence, each encoding a unique three-dimensional fold. "
                "Cofactors such as polyanions and lipids facilitate conformational conversion, yet "
                "their precise roles in strain specificity remain to be fully elucidated."),
    "app_003": ("The PRNP gene is frequently described as highly conserved across mammals, and prion "
                "diseases have been documented in a wide range of species. Experimental transmission "
                "studies have demonstrated that PrP primary sequence, particularly structural "
                "polymorphisms, plays a decisive role in governing species barriers. Comparative "
                "analyses of PRNP orthologues across the mammalian phylogeny offer a powerful framework "
                "for understanding the evolutionary pressures shaping prion susceptibility."),
    "app_004": ("Human prion diseases encompass a heterogeneous group including sporadic CJD, familial "
                "forms associated with PRNP mutations, and acquired diseases such as kuru and variant "
                "CJD. Within the sporadic group, molecular subtypes are defined by PrPSc glycoform "
                "pattern and codon 129 polymorphism. Novel clinicopathological entities with atypical "
                "features challenge established diagnostic frameworks."),
    "app_005": ("Idiopathic prion disorders account for the vast majority of human cases, yet the "
                "biological triggers that initiate the spontaneous structural transition of PrPC to PrPSc "
                "remain entirely unknown. Age-dependent cellular stress, oxidative damage, and stochastic "
                "misfolding events have been proposed as potential initiating factors."),
}

_OBJECTIVE_VERBS = {
    "app_001": "develop and validate", "app_002": "elucidate",
    "app_003": "investigate", "app_004": "characterize", "app_005": "model and reproduce",
}

_OBJECTIVE_GOALS = {
    "app_001": "a robust, reproducible methodology for {research_focus}, overcoming current limitations in spontaneous prion generation systems",
    "app_002": "the molecular mechanisms governing {research_focus} and their contribution to prion strain diversity",
    "app_003": "the evolutionary determinants of {research_focus} and their implications for cross-species prion transmission",
    "app_004": "the clinicopathological features of {research_focus} to improve diagnostic criteria and patient recognition",
    "app_005": "the spontaneous misfolding process underlying {research_focus}, shedding light on the triggers of idiopathic prion disease",
}

import pprint

addition = (
    "\n\n# \u2500\u2500 Content generation engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n"
    + "_OPENING_VARS = " + pprint.pformat(_OPENING_VARS, width=110) + "\n\n"
    + "_TRANSITION_VARS = " + pprint.pformat(_TRANSITION_VARS, width=110) + "\n\n"
    + "_BACKGROUND_TEXT = " + pprint.pformat(_BACKGROUND_TEXT, width=110) + "\n\n"
    + "_OBJECTIVE_VERBS = " + pprint.pformat(_OBJECTIVE_VERBS, width=110) + "\n\n"
    + "_OBJECTIVE_GOALS = " + pprint.pformat(_OBJECTIVE_GOALS, width=110) + "\n"
)

with open(target, "a") as f:
    f.write(addition)

with open(target) as f:
    src = f.read()
try:
    ast.parse(src)
    print("OK - models.py valid,", len(src.splitlines()), "lines")
except SyntaxError as e:
    print("SYNTAX ERROR:", e)
