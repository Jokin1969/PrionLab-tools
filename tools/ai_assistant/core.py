"""AI Writing Assistant — Claude-powered scientific content generation."""
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


# ── Data structures ────────────────────────────────────────────────────────────

@dataclass
class AIGenerationRequest:
    """Request for AI content generation."""
    content_type: str
    context: Dict
    source_text: str = ""
    parameters: Dict = field(default_factory=dict)
    username: str = "anonymous"


@dataclass
class AIGenerationResult:
    """Result from AI content generation."""
    generated_text: str
    confidence_score: float
    suggestions: List[str]
    metadata: Dict
    processing_time: float


# ── System prompt ──────────────────────────────────────────────────────────────

_SYSTEM = (
    "You are an expert scientific writing assistant specialising in life sciences "
    "and biomedical research. Produce clear, precise, and well-structured scientific "
    "text that follows standard academic conventions."
)

# ── Per-content-type user prompts ──────────────────────────────────────────────

_ABSTRACT = """Generate a structured scientific abstract (250-300 words).

Research context: {context}{source_block}

Format with these labelled sections:
**Background:** (1-2 sentences — research problem and knowledge gap)
**Methods:** (2-3 sentences — experimental approach)
**Results:** (2-3 sentences — key quantitative findings)
**Conclusions:** (1-2 sentences — significance and implications)

Use active voice where appropriate. Be specific and quantitative."""

_INTRODUCTION = """Write a scientific introduction (600-900 words).

Research context: {context}{source_block}

Structure:
1. Broad significance and background (2 paragraphs)
2. Current state of knowledge — key established facts (2-3 paragraphs)
3. Knowledge gap or unresolved problem (1 paragraph)
4. Study objectives and hypothesis (1 paragraph)

Use formal scientific language and clear paragraph transitions."""

_METHODS = """Write a Methods section with subheadings.

Experimental details: {context}{source_block}

Required subheadings:
**Study Design** — overview and rationale
**Materials and Reagents** — key items with sources and concentrations
**Experimental Procedures** — step-by-step with specific conditions
**Data Analysis** — software, statistical tests, significance thresholds

Use past tense. Be specific enough for reproducibility."""
_DISCUSSION = """Write a Discussion section (700-1000 words).

Research context: {context}{source_block}

Structure:
1. Summary of key findings in relation to the hypothesis (1 paragraph)
2. Comparison with existing literature — agreements and contradictions (2-3 paragraphs)
3. Mechanistic explanation or interpretation of results (1-2 paragraphs)
4. Limitations of the study (1 paragraph)
5. Future directions (1 paragraph)
6. Concluding statement (2-3 sentences)

Avoid repeating the Results section. Focus on interpretation and context."""

_LIT_SYNTH = """Synthesize the following research publications into a coherent narrative.

Publications:
{context}{source_block}

Requirements:
- Identify common themes, contradictions, and knowledge gaps
- Group findings by topic or chronology as appropriate
- Highlight methodological differences that may explain conflicting results
- Conclude with an assessment of the current state of knowledge
- Length: 400-600 words
- Use formal academic language with clear transitions between topics"""

_QUALITY = """Assess the following scientific text for writing quality.

Text to assess:
{source_block}

Additional context: {context}

Provide structured feedback:
**Overall Score:** X/10

**Clarity** (X/10): Assessment of sentence structure and comprehensibility.

**Scientific Precision** (X/10): Use of correct terminology, specificity of claims.

**Structure & Flow** (X/10): Logical organisation and paragraph transitions.

**Conciseness** (X/10): Absence of redundancy and filler phrases.

**Specific Improvements:**
- [List 3-5 concrete, actionable suggestions with example rewrites where helpful]

**Strengths:**
- [List 2-3 things the text does well]"""

_PROMPTS: Dict[str, str] = {
    "abstract": _ABSTRACT,
    "introduction": _INTRODUCTION,
    "methods": _METHODS,
    "discussion": _DISCUSSION,
    "literature_synthesis": _LIT_SYNTH,
    "quality_assessment": _QUALITY,
}


class AIWritingAssistant:
    """Claude-powered assistant for scientific writing tasks."""

    MODEL = "claude-sonnet-4-6"
    MAX_TOKENS = 2048

    def __init__(self):
        self._client = None
        self._api_key = os.getenv("ANTHROPIC_API_KEY", "")

    # ── Public API ────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        return bool(self._api_key)

    def generate_content(self, request: AIGenerationRequest) -> AIGenerationResult:
        start = time.time()
        if not self.is_available():
            return self._template_fallback(request, time.time() - start)
        try:
            prompt = self._format_prompt(request)
            text = self._call_claude(prompt)
            text = self._post_process(text, request.content_type)
            elapsed = time.time() - start
            return AIGenerationResult(
                generated_text=text,
                confidence_score=self._confidence(text, request.content_type),
                suggestions=self._suggestions(text, request.content_type),
                metadata={
                    "model": self.MODEL,
                    "content_type": request.content_type,
                    "username": request.username,
                    "elapsed_s": round(elapsed, 2),
                },
                processing_time=elapsed,
            )
        except Exception as exc:
            logger.error("AIWritingAssistant.generate_content: %s", exc)
            return self._template_fallback(request, time.time() - start, error=str(exc))

    def enhance_text(self, text: str, instruction: str, username: str = "anonymous") -> AIGenerationResult:
        start = time.time()
        if not self.is_available():
            return AIGenerationResult(
                generated_text=text,
                confidence_score=0.0,
                suggestions=["AI enhancement unavailable — ANTHROPIC_API_KEY not set."],
                metadata={"error": "no_api_key"},
                processing_time=time.time() - start,
            )
        prompt = (
            f"Improve the following scientific text according to this instruction: {instruction}\n\n"
            f"Original text:\n{text}\n\n"
            "Return only the improved text with no preamble or explanation."
        )
        try:
            enhanced = self._call_claude(prompt)
            elapsed = time.time() - start
            return AIGenerationResult(
                generated_text=enhanced,
                confidence_score=self._confidence(enhanced, "enhancement"),
                suggestions=self._suggestions(enhanced, "enhancement"),
                metadata={"model": self.MODEL, "username": username, "elapsed_s": round(elapsed, 2)},
                processing_time=elapsed,
            )
        except Exception as exc:
            logger.error("AIWritingAssistant.enhance_text: %s", exc)
            elapsed = time.time() - start
            return AIGenerationResult(
                generated_text=text,
                confidence_score=0.0,
                suggestions=[f"Enhancement failed: {exc}"],
                metadata={"error": str(exc)},
                processing_time=elapsed,
            )

    # ── Private helpers ───────────────────────────────────────────────────────

    def _call_claude(self, user_prompt: str) -> str:
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(api_key=self._api_key)
        message = self._client.messages.create(
            model=self.MODEL,
            max_tokens=self.MAX_TOKENS,
            system=_SYSTEM,
            messages=[{"role": "user", "content": user_prompt}],
        )
        return message.content[0].text

    def _format_prompt(self, request: AIGenerationRequest) -> str:
        template = _PROMPTS.get(request.content_type, _PROMPTS["abstract"])
        ctx_str = self._context_to_str(request.context)
        source_block = (
            f"\n\nSource material:\n{request.source_text}" if request.source_text.strip() else ""
        )
        return template.format(context=ctx_str, source_block=source_block)

    @staticmethod
    def _context_to_str(context: dict) -> str:
        if not context:
            return "(no additional context provided)"
        parts = []
        for k, v in context.items():
            if v:
                label = k.replace("_", " ").title()
                parts.append(f"{label}: {v}")
        return "; ".join(parts) if parts else "(no additional context provided)"

    @staticmethod
    def _post_process(text: str, content_type: str) -> str:
        text = text.strip()
        # Collapse triple+ blank lines
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text

    @staticmethod
    def _confidence(text: str, content_type: str) -> float:
        if not text:
            return 0.0
        words = len(text.split())
        # Heuristic: penalise very short or very long outputs
        min_words = {"abstract": 200, "introduction": 400, "methods": 200,
                     "discussion": 400, "literature_synthesis": 250, "quality_assessment": 100}
        target = min_words.get(content_type, 150)
        if words < target * 0.5:
            return 0.55
        if words < target * 0.8:
            return 0.70
        # Check for expected structural markers
        has_headers = bool(re.search(r"\*\*[A-Z][^*]+\*\*", text))
        base = 0.82 if has_headers else 0.75
        return min(base + (words / 10000), 0.97)

    @staticmethod
    def _suggestions(text: str, content_type: str) -> List[str]:
        tips: List[str] = []
        if re.search(r"\b(very|quite|rather|somewhat)\b", text, re.I):
            tips.append("Replace vague intensifiers ('very', 'quite') with precise quantifiers.")
        if re.search(r"\b(is shown|was found|it was observed)\b", text, re.I):
            tips.append("Prefer active voice: 'Our results show…' over 'It was found that…'.")
        if len(text.split()) > 150 and not re.search(r"\d+[%\s]", text):
            tips.append("Include quantitative values (percentages, p-values, fold-changes) to strengthen claims.")
        if content_type in ("abstract", "introduction") and not re.search(r"\bcite\b|\bref\b|\bet al\b", text, re.I):
            tips.append("Consider citing key references to support major claims.")
        if not tips:
            tips.append("Text looks well-structured. Review for journal-specific formatting requirements.")
        return tips[:4]

    def _template_fallback(self, request: AIGenerationRequest, elapsed: float, error: str = "") -> AIGenerationResult:
        msg = (
            f"[AI content generation unavailable — {'ANTHROPIC_API_KEY not configured' if not self._api_key else error}]\n\n"
            f"Content type requested: {request.content_type}\n"
            "Please configure your API key or paste your draft text into the source material field."
        )
        return AIGenerationResult(
            generated_text=msg,
            confidence_score=0.0,
            suggestions=["Set ANTHROPIC_API_KEY environment variable to enable AI generation."],
            metadata={"fallback": True, "error": error or "no_api_key"},
            processing_time=elapsed,
        )


class ResearchAssistant:
    """Literature-focused assistant for citation and synthesis tasks."""

    MODEL = "claude-sonnet-4-6"
    MAX_TOKENS = 1500

    def __init__(self):
        self._client = None
        self._api_key = os.getenv("ANTHROPIC_API_KEY", "")

    def is_available(self) -> bool:
        return bool(self._api_key)

    def analyze_literature(self, publications: List[Dict], topic: str = "", username: str = "anonymous") -> AIGenerationResult:
        start = time.time()
        if not self.is_available():
            return AIGenerationResult(
                generated_text="[Literature analysis unavailable — ANTHROPIC_API_KEY not set.]",
                confidence_score=0.0,
                suggestions=["Configure ANTHROPIC_API_KEY to enable literature analysis."],
                metadata={"error": "no_api_key"},
                processing_time=time.time() - start,
            )
        pub_text = self._format_publications(publications)
        context = {"topic": topic} if topic else {}
        request = AIGenerationRequest(
            content_type="literature_synthesis",
            context=context,
            source_text=pub_text,
            username=username,
        )
        return assistant.generate_content(request)

    def suggest_keywords(self, text: str) -> List[str]:
        """Extract likely MeSH / keyword candidates using regex heuristics (no API call)."""
        # Capitalised multi-word terms or words after 'of', 'for', etc.
        candidates = re.findall(r"\b[A-Z][a-z]{3,}(?:\s+[A-Za-z]{3,}){0,2}", text)
        # Lowercase scientific terms (prion, protein, alpha-synuclein style)
        lower = re.findall(r"\b(?:protein|disease|pathway|receptor|mutation|gene|cell|factor|syndrome|disorder|therapy|analysis|model)\b", text, re.I)
        combined = list(dict.fromkeys(candidates + [w.title() for w in lower]))
        return combined[:10]

    @staticmethod
    def _format_publications(pubs: List[Dict]) -> str:
        lines = []
        for i, p in enumerate(pubs[:20], 1):
            title = p.get("title", "Untitled")
            authors = p.get("authors", "Unknown authors")
            year = p.get("year", "")
            journal = p.get("journal", "")
            abstract = p.get("abstract", "")
            doi = p.get("doi", "")
            line = f"{i}. {authors} ({year}). {title}. {journal}."
            if doi:
                line += f" DOI: {doi}"
            if abstract:
                line += f"\n   Abstract: {abstract[:300]}{'…' if len(abstract) > 300 else ''}"
            lines.append(line)
        return "\n\n".join(lines)

    def _call_claude(self, prompt: str) -> str:
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(api_key=self._api_key)
        message = self._client.messages.create(
            model=self.MODEL,
            max_tokens=self.MAX_TOKENS,
            system=_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        return message.content[0].text


# Module-level singletons
assistant = AIWritingAssistant()
research_assistant = ResearchAssistant()
