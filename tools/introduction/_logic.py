_OPENING_VARS = {
    "app_001": {"sporadic_percentage": "85",
                "context_factor": ("the near eradication of TSE acquired from exogenous sources "
                                   "and the foreseeable reduction of genetic cases")},
    "app_002": {"disease_scope": "ravaging",
                "affected_species": "humans and a wide range of mammals"},
    "app_003": {"transmission_context": ("The mad cow disease crisis and experimental inoculations "
                                         "across multiple species"),
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
                "gap_description": ("consistently replicating the spontaneous prion formation "
                                    "phenomenon is still challenging")},
    "app_002": {"known_aspects": "the basic conformational conversion process",
                "specific_question": "strain formation specificity",
                "strain_variability": "The existence of multiple prion strains for a single PrP sequence",
                "study_focus": "the study of spontaneous misfolding events"},
    "app_003": {"research_question": "whether prion diseases could potentially affect all animal species",
                "risk_factors": "new prion disease outbreaks and interspecies transmission events",
                "evolutionary_insight": "the molecular determinants responsible for species susceptibility",
                "conservation_statement": "The high conservation of the PRNP gene across mammalian species",
                "phylogenetic_implication": ("an evolutionarily conserved function that may predispose "
                                             "all mammals to prion misfolding")},
    "app_004": {"current_limitations": "These cases",
                "diagnostic_problem": "difficult to diagnose definitively",
                "clinical_need": ("Improved understanding of the neuropathological and biochemical "
                                  "hallmarks is needed"),
                "recognition_goal": "earlier and more accurate clinical recognition"},
    "app_005": {"knowledge_limitation": "the lack of knowledge",
                "research_challenge": "the study of spontaneous misfolding",
                "model_limitation": "The scarcity and unpredictability of sporadic cases",
                "research_goal": "the development of reproducible in vitro models"},
}

_BACKGROUND_TEXT = {
    "app_001": ("The protein misfolding cyclic amplification (PMCA) technique and its successor, "
                "the protein misfolding shaking amplification (PMSA), have provided valuable tools "
                "for the in vitro propagation of prion seeds. However, these systems rely on "
                "pre-formed prion templates and do not model de novo formation of the aberrant "
                "conformer. Cell-free spontaneous generation systems represent a promising but "
                "technically demanding alternative, requiring high-purity recombinant substrate "
                "and precise biochemical conditions."),
    "app_002": ("The PrPSc isoform propagates by recruiting and converting PrPC molecules, giving "
                "rise to the characteristic self-templating cycle of prion replication. Multiple "
                "distinct prion strains can arise from a single PrP sequence, each encoding a "
                "unique three-dimensional fold that determines biological and pathological "
                "properties. Cofactors such as polyanions and lipids have been implicated in "
                "facilitating conformational conversion, yet their precise roles in determining "
                "strain specificity remain to be fully elucidated."),
    "app_003": ("The PRNP gene is frequently described as highly conserved across mammals, and "
                "prion diseases have been documented in a wide taxonomic range of species, from "
                "cervids to felines and non-human primates. Experimental transmission studies "
                "have demonstrated that the primary sequence of PrP, particularly structural "
                "polymorphisms, plays a decisive role in governing species barriers. Comparative "
                "analyses of PRNP orthologues across the mammalian phylogeny offer a powerful "
                "framework for understanding the evolutionary pressures shaping prion susceptibility."),
    "app_004": ("Human prion diseases encompass a heterogeneous group of conditions, including "
                "sporadic CJD, familial forms associated with PRNP mutations, and acquired "
                "diseases such as kuru and variant CJD. Within the sporadic group, molecular "
                "subtypes are defined by PrPSc glycoform pattern and codon 129 polymorphism. "
                "The identification of novel clinicopathological entities with atypical features "
                "challenges established diagnostic frameworks and underscores the phenotypic "
                "diversity of human prionopathies."),
    "app_005": ("Idiopathic prion disorders account for the vast majority of human cases, yet "
                "the biological triggers that initiate the spontaneous structural transition of "
                "PrPC to PrPSc remain entirely unknown. Age-dependent cellular stress, oxidative "
                "damage, and stochastic misfolding events have all been proposed as potential "
                "initiating factors. The absence of a transmissible source or identified PRNP "
                "mutation in idiopathic cases defines them operationally, but does not illuminate "
                "the underlying molecular events."),
}

_OBJECTIVE_VERBS = {
    "app_001": "develop and validate",
    "app_002": "elucidate",
    "app_003": "investigate",
    "app_004": "characterize",
    "app_005": "model and reproduce",
}

_OBJECTIVE_GOALS = {
    "app_001": ("a robust, reproducible methodology for {research_focus}, overcoming current "
                "limitations in spontaneous prion generation systems"),
    "app_002": ("the molecular mechanisms governing {research_focus} and their contribution "
                "to prion strain diversity"),
    "app_003": ("the evolutionary determinants of {research_focus} and their implications "
                "for cross-species prion transmission"),
    "app_004": ("the clinicopathological features of {research_focus} to improve diagnostic "
                "criteria and patient recognition"),
    "app_005": ("the spontaneous misfolding process underlying {research_focus}, shedding "
                "light on the triggers of