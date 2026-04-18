"""AI Writing Assistant — Flask routes."""
import logging
from flask import jsonify, render_template, request, session

from core.decorators import login_required
from . import ai_bp
from .core import AIGenerationRequest, assistant, research_assistant

logger = logging.getLogger(__name__)


@ai_bp.route("/")
@login_required
def dashboard():
    return render_template(
        "ai_assistant/dashboard.html",
        available=assistant.is_available(),
        username=session.get("username", ""),
    )


@ai_bp.route("/generate", methods=["POST"])
@login_required
def generate():
    data = request.get_json(silent=True) or {}
    content_type = data.get("content_type", "abstract")
    context = data.get("context", {})
    source_text = data.get("source_text", "")
    parameters = data.get("parameters", {})
    username = session.get("username", "anonymous")

    req = AIGenerationRequest(
        content_type=content_type,
        context=context,
        source_text=source_text,
        parameters=parameters,
        username=username,
    )
    result = assistant.generate_content(req)
    return jsonify({
        "success": True,
        "generated_text": result.generated_text,
        "confidence_score": result.confidence_score,
        "suggestions": result.suggestions,
        "metadata": result.metadata,
        "processing_time": result.processing_time,
    })


@ai_bp.route("/enhance", methods=["POST"])
@login_required
def enhance():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    instruction = data.get("instruction", "Improve clarity and scientific precision.")
    username = session.get("username", "anonymous")

    if not text:
        return jsonify({"success": False, "error": "No text provided"}), 400

    result = assistant.enhance_text(text, instruction, username=username)
    return jsonify({
        "success": True,
        "enhanced_text": result.generated_text,
        "confidence_score": result.confidence_score,
        "suggestions": result.suggestions,
        "processing_time": result.processing_time,
    })


@ai_bp.route("/quality-check", methods=["POST"])
@login_required
def quality_check():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    context = data.get("context", {})
    username = session.get("username", "anonymous")

    if not text:
        return jsonify({"success": False, "error": "No text provided"}), 400

    req = AIGenerationRequest(
        content_type="quality_assessment",
        context=context,
        source_text=text,
        username=username,
    )
    result = assistant.generate_content(req)
    return jsonify({
        "success": True,
        "assessment": result.generated_text,
        "confidence_score": result.confidence_score,
        "suggestions": result.suggestions,
        "processing_time": result.processing_time,
    })


@ai_bp.route("/literature-synthesis", methods=["POST"])
@login_required
def literature_synthesis():
    data = request.get_json(silent=True) or {}
    publications = data.get("publications", [])
    topic = data.get("topic", "")
    username = session.get("username", "anonymous")

    if not publications:
        return jsonify({"success": False, "error": "No publications provided"}), 400

    result = research_assistant.analyze_literature(publications, topic=topic, username=username)
    return jsonify({
        "success": True,
        "synthesis": result.generated_text,
        "confidence_score": result.confidence_score,
        "suggestions": result.suggestions,
        "processing_time": result.processing_time,
    })


@ai_bp.route("/keywords", methods=["POST"])
@login_required
def extract_keywords():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"success": False, "error": "No text provided"}), 400
    keywords = research_assistant.suggest_keywords(text)
    return jsonify({"success": True, "keywords": keywords})


@ai_bp.route("/status")
@login_required
def status():
    return jsonify({
        "available": assistant.is_available(),
        "model": assistant.MODEL,
        "content_types": list(["abstract", "introduction", "methods", "discussion",
                                "literature_synthesis", "quality_assessment"]),
    })
