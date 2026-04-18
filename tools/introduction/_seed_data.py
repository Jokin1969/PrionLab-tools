SEED_TEMPLATES = [
    {"template_id": "tpl_001", "approach_id": "app_001", "section_type": "opening",
     "template_text": ("Sporadic prion disease in humans, particularly sporadic Creutzfeldt-Jakob "
         "disease (sCJD), accounts for approximately {sporadic_percentage}% of currently diagnosed "
         "transmissible spongiform encephalopathies (TSE). With {context_factor}, researchers "
         "studying the phenomenon of spontaneous misfolding suffer from scarcity of suitable models."),
     "variable_placeholders": "sporadic_percentage;context_factor",
     "usage_notes": "Use for methodology-focused papers"},
    {"template_id": "tpl_002", "approach_id": "app_001", "section_type": "transition",
     "template_text": ("However, consistently replicating the spontaneous prion formation phenomenon "
         "is still challenging. {previous_attempts} showed {limitation}, but {gap_description}."),
     "variable_placeholders": "previous_attempts;limitation;gap_description",
     "usage_notes": "Bridge to methodology development"},
    {"template_id": "tpl_003", "approach_id": "app_002", "section_type": "opening",
     "template_text": ("Prion diseases are a group of {disease_scope} neurodegenerative disorders "
         "that affect {affected_species}. The underlying cause of these diseases is the misfolding "
         "of the cellular prion protein (PrPC) into a pathological conformer (PrPSc)."),
     "variable_placeholders": "disease_scope;affected_species",
     "usage_notes": "Mechanisms-focused opening"},
    {"template_id": "tpl_004", "approach_id": "app_002", "section_type": "transition",
     "template_text": ("While {known_aspects} are understood, the molecular mechanisms determining "
         "{specific_question} remain unknown. {strain_variability} further complicates {study_focus}."),
     "variable_placeholders": "known_aspects;specific_question;strain_variability;study_focus",
     "usage_notes": "Gap identification for mechanisms"},
    {"template_id": "tpl_005", "approach_id": "app_003", "section_type": "opening",
     "template_text": ("Transmissible spongiform encephalopathies (TSEs) are invariably fatal "
         "neurodegenerative disorders affecting humans and several mammals. {transmission_context} "
         "illustrates the capacity of prions for interspecies transmission and {barrier_concept}."),
     "variable_placeholders": "transmission_context;barrier_concept",
     "usage_notes": "Evolutionary/phylogenetic focus"},
    {"template_id": "tpl_006", "approach_id": "app_003", "section_type": "transition",
     "template_text": ("Understanding {research_question} could help reduce the risk of {risk_factors} "
         "and provide insights into {evolutionary_insight}. {conservation_statement} suggests "
         "{phylogenetic_implication}."),
     "variable_placeholders": "research_question;risk_factors;evolutionary_insight;conservation_statement;phylogenetic_implication",
     "usage_notes": "Evolutionary gap bridge"},
    {"template_id": "tpl_007", "approach_id": "app_004", "section_type": "opening",
     "template_text": ("{disease_subtype} is {classification_context} with {distinctive_features} "
         "that distinguish it from {comparison_diseases}. "
         "{diagnostic_challenge} and {clinical_presentation}."),
     "variable_placeholders": "disease_subtype;classification_context;distinctive_features;comparison_diseases;diagnostic_challenge;clinical_presentation",
     "usage_notes": "Clinical/diagnostic opening"},
    {"template_id": "tpl_008", "approach_id": "app_004", "section_type": "transition",
     "template_text": ("{current_limitations} remain {diagnostic_problem} during life. "
         "{clinical_need} providing insights for {recognition_goal}."),
     "variable_placeholders": "current_limitations;diagnostic_problem;clinical_need;recognition_goal",
     "usage_notes": "Clinical gap identification"},
    {"template_id": "tpl_009", "approach_id": "app_005", "section_type": "opening",
     "template_text": ("Depending on the origin of the misfolded protein, prion diseases can be "
         "classified as {etiology_types}. Idiopathic, commonly misnamed sporadic, occurrences "
         "involve {spontaneous_description} and account for {prevalence_data}."),
     "variable_placeholders": "etiology_types;spontaneous_description;prevalence_data",
     "usage_notes": "Spontaneous formation focus"},
    {"template_id": "tpl_010", "approach_id": "app_005", "section_type": "transition",
     "template_text": ("Despite {knowledge_limitation} on potential factors triggering the latter "
         "forms, {research_challenge} remains completely unknown. "
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
