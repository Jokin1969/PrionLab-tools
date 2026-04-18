import json
import logging

from flask import jsonify, render_template, request, session

from core.decorators import login_required
from tools.introduction import introduction_bp
from tools.introduction.models import (
    IntroductionGenerationError,
    InvalidApproachError,
    TemplateNotFoundError,
    bootstrap_introduction_schema,
    check_generation_rate_limit,
    delete_introduction_generation,
    get_all_approaches,
    get_approach_details,
    get_approach_name,
    get_approach_templates,
    get_introduction_generation,
    get_literature_snippets,
    get_user_recent_introductions,
    generate_introduction_content,
    validate_introduction_parameters,
)

logger = logging.getLogger(__name__)


def _get_relevant_lab_pubs(approach_id: str, keywords: str) -> list:
    try:
        from tools.research.models import get_relevant_lab_publications
        return get_relevant_lab_publications(approach_id, keywords)
    except Exception:
        return []


@introduction_bp.route("/")
@introduction_bp.route("/generator")
@login_required
def generator():
    approaches = get_all_approaches()
    return render_template("introduction/generator.html", approaches=approaches)


@introduction_bp.route("/api/approaches")
@login_required
def api_approaches():
    try:
        return jsonify(get_all_approaches())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@introduction_bp.route("/api/approach-details/<approach_id>")
@login_required
def api_approach_details(approach_id):
    approach = get_approach_details(approach_id)
    if not approach:
        return jsonify({"error": f"Approach {approach_id!r} not found."}), 404
    return jsonify(approach)


@introduction_bp.route("/api/templates/<approach_id>")
@login_required
def api_approach_templates(approach_id):
    try:
        return jsonify(get_approach_templates(approach_id))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@introduction_bp.route("/api/validate", methods=["POST"])
@login_required
def api_validate():
    data = request.get_json(force=True) or {}
    return jsonify(validate_introduction_parameters(data))


@introduction_bp.route("/generate", methods=["POST"])
@login_required
def generate():
    user_id = session.get("username", "")
    role = session.get("role", "reader")

    data = request.get_json(force=True) or {}

    validation = validate_introduction_parameters(data)
    if not validation["valid"]:
        return jsonify({"error": "; ".join(validation["errors"])}), 400

    if role == "reader" and not check_generation_rate_limit(user_id):
        return jsonify({"error": "Daily generation limit reached (5 per day for readers)."}), 429

    try:
        result = generate_introduction_content(data, user_id)
        return jsonify({
            "success": True,
            "full_text": result["full_text"],
            "sections": result["sections"],
            "word_count": result["word_count"],
            "approach_used": result["approach_used"],
            "generation_id": result["generation_id"],
        })
    except InvalidApproachError as e:
        return jsonify({"error": str(e)}), 400
    except TemplateNotFoundError as e:
        return jsonify({"error": str(e)}), 500
    except IntroductionGenerationError as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        logger.error("Introduction generation failed: %s", e)
        return jsonify({"error": "Generation failed. Please try again."}), 500


@introduction_bp.route("/api/recent")
@login_required
def api_recent():
    user_id = session.get("username", "")
    try:
        recent = get_user_recent_introductions(user_id, limit=10)
        return jsonify([{
            "generation_id": r["generation_id"],
            "manuscript_title": r["manuscript_title"],
            "approach_used": get_approach_name(r["approach_id"]),
            "target_journal": r["target_journal"],
            "word_count": r.get("word_count", 0),
            "created_at": r["created_at"],
        } for r in recent])
    except Exception as e:
        logger.error("Error fetching recent introductions: %s", e)
        return jsonify({"error": str(e)}), 500


@introduction_bp.route("/api/load/<generation_id>")
@login_required
def api_load(generation_id):
    user_id = session.get("username", "")
    intro = get_introduction_generation(generation_id, user_id)
    if not intro:
        return jsonify({"error": "Introduction not found."}), 404
    try:
        sections = json.loads(intro.get("sections_breakdown", "{}"))
        params = json.loads(intro.get("parameters_used", "{}"))
    except Exception:
        sections, params = {}, {}
    return jsonify({
        "generation_id": intro["generation_id"],
        "full_text": intro["generated_content"],
        "sections": sections,
        "parameters": params,
        "approach_used": get_approach_name(intro["approach_id"]),
        "word_count": intro.get("word_count", 0),
    })


@introduction_bp.route("/api/delete/<generation_id>", methods=["DELETE"])
@login_required
def api_delete(generation_id):
    user_id = session.get("username", "")
    success = delete_introduction_generation(generation_id, user_id)
    if not success:
        return jsonify({"error": "Introduction not found or access denied."}), 404
    return jsonify({"success": True, "message": "Introduction deleted."})


@introduction_bp.route("/api/lab-publications")
@login_required
def api_lab_publications():
    approach_id = request.args.get("approach_id", "")
    keywords = request.args.get("keywords", "")
    pubs = _get_relevant_lab_pubs(approach_id, keywords)
    return jsonify([{
        "pub_id": p.get("pub_id", ""),
        "title": p.get("title", ""),
        "author_string": p.get("author_string", ""),
        "journal": p.get("journal", ""),
        "year": p.get("year", ""),
        "doi": p.get("doi", ""),
    } for p in pubs])
