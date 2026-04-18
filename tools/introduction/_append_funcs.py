import ast, os

target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models.py")

functions = '''

def _apply_vars(template_text, variables):
    result = template_text
    for key, value in variables.items():
        result = result.replace("{" + key + "}", value)
    result = re.sub(r"\\{[^}]+\\}", "", result)
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
    return "\\n\\n".join(parts)


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
'''

with open(target, "a") as f:
    f.write(functions)

with open(target) as f:
    src = f.read()
try:
    ast.parse(src)
    print("OK - models.py valid,", len(src.splitlines()), "lines")
except SyntaxError as e:
    print("SYNTAX ERROR:", e)
