"""Advanced NLP processing — pure Python, no spaCy/transformers/sklearn/numpy."""
import logging
import math
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# ── Stop words ────────────────────────────────────────────────────────────────

_STOP_WORDS: frozenset = frozenset([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "up", "about", "into", "through", "during",
    "is", "was", "are", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "can", "shall", "this", "that", "these", "those", "i", "we", "you",
    "he", "she", "it", "they", "what", "which", "who", "whom", "how",
    "not", "no", "nor", "so", "yet", "both", "either", "each", "more",
    "most", "other", "some", "such", "only", "own", "same", "than",
    "too", "very", "just", "also", "our", "its", "their", "there",
    "then", "when", "where", "while", "as", "if", "because", "since",
    "although", "though", "however", "therefore", "thus", "here",
    "after", "before", "between", "under", "over", "within", "without",
    "further", "once", "all", "any", "few", "new", "use", "used", "using",
    "show", "shows", "shown", "study", "studies", "data", "results",
    "analysis", "based", "found", "suggests", "here", "well", "two", "three",
])

# ── Methodology vocabulary ────────────────────────────────────────────────────

_METHODOLOGY_VOCAB: Dict[str, List[str]] = {
    "molecular_biology": [
        "pcr", "western blot", "elisa", "immunofluorescence", "sequencing",
        "gel electrophoresis", "northern blot", "southern blot", "cloning",
        "transfection", "qpcr", "rt-pcr", "chip-seq", "rna-seq",
    ],
    "cell_biology": [
        "cell culture", "cell line", "flow cytometry", "confocal microscopy",
        "immunohistochemistry", "immunostaining", "fluorescence microscopy",
        "live imaging", "viability assay", "cell proliferation", "apoptosis",
    ],
    "animal_model": [
        "mouse model", "transgenic mouse", "knockout mouse", "in vivo",
        "animal model", "inoculation", "intracerebral", "hamster model",
        "wild-type mouse", "knock-in", "conditional knockout", "primate model",
    ],
    "structural_biology": [
        "cryo-em", "cryo-electron microscopy", "nmr spectroscopy",
        "x-ray crystallography", "crystal structure", "electron microscopy",
        "atomic force microscopy", "saxs", "structural analysis", "fiber diffraction",
    ],
    "computational": [
        "bioinformatics", "machine learning", "molecular dynamics", "docking",
        "simulation", "computational model", "structural prediction",
        "alphafold", "homology modeling", "network analysis", "algorithm",
    ],
    "clinical": [
        "clinical trial", "patient cohort", "case study", "case series",
        "retrospective study", "prospective study", "diagnosis", "neuropathology",
        "autopsy", "cerebrospinal fluid", "csf", "biomarker",
    ],
    "biochemical": [
        "protein purification", "aggregation assay", "misfolding", "fibril formation",
        "amyloid", "prion protein", "conformational change", "recombinant protein",
        "chromatography", "mass spectrometry", "spectroscopy",
    ],
    "in_vitro": [
        "in vitro", "cell-free system", "reconstitution", "purified protein",
        "biochemical assay", "enzyme kinetics", "inhibitor screening", "binding assay",
    ],
}

_STATISTICAL_METHODS: List[str] = [
    "anova", "t-test", "mann-whitney", "fisher exact", "chi-square",
    "logistic regression", "linear regression", "cox regression",
    "kaplan-meier", "log-rank test", "spearman correlation", "pearson correlation",
    "principal component analysis", "random forest", "survival analysis",
]

_TOOLS_SOFTWARE: List[str] = [
    "imagej", "fiji", "graphpad prism", "spss", "matlab", "flowjo",
    "imaris", "volocity", "snapgene", "clustal omega", "mega",
    "blast", "bowtie", "star aligner", "samtools", "gatk",
    "alphafold", "rosetta", "pymol", "chimera ucsf",
]

_GAP_INDICATORS: List[str] = [
    "however,", "limited by", "remains unknown", "poorly understood",
    "lack of", "lacks", "few studies", "limited data", "knowledge gap",
    "understudied", "further research", "requires further", "remains to be",
    "not yet", "still unclear", "unclear whether", "needed", "open question",
    "future work", "future studies", "not well understood",
]

_FINDING_INDICATORS: List[str] = [
    "we found that", "we show that", "we demonstrate", "we report",
    "our results show", "our results indicate", "our findings",
    "the data show", "results suggest", "analysis revealed",
    "showed that", "demonstrated that", "we observed", "we identified",
    "we detected", "our study shows", "here we show",
]

_QUESTION_PATTERNS: List[str] = [
    r"\bwhether\s+\w+",
    r"\bhow\s+\w+(?:\s+\w+){2,12}",
    r"\bwhat\s+(?:is|are|determines|drives|underlies|mediates)\b",
    r"\bthe role of\b",
    r"\bthe function of\b",
    r"\bthe mechanism(?:s)? (?:by which|of|underlying)\b",
    r"\bthe effect of\b",
    r"\bcan\s+\w+(?:\s+\w+){1,8}\?",
    r"\bdo(?:es)?\s+\w+(?:\s+\w+){1,8}\?",
]

_INTENT_KEYWORDS: Dict[str, List[str]] = {
    "investigation": ["investigate", "examine", "explore", "study", "analyze", "characterize"],
    "comparison": ["compare", "contrast", "versus", "compared to", "comparison between"],
    "development": ["develop", "design", "create", "novel approach", "new method", "establish"],
    "evaluation": ["evaluate", "assess", "test", "validate", "determine efficacy"],
    "review": ["review", "survey", "overview", "systematic review", "meta-analysis"],
    "prediction": ["predict", "forecast", "model", "simulate", "estimate probability"],
    "mechanistic": ["mechanism", "signaling pathway", "molecular interaction", "regulation of"],
}

_QUESTION_TYPE_KEYWORDS: Dict[str, List[str]] = {
    "descriptive": ["what is", "characterize", "describe", "identify", "how many", "what are"],
    "explanatory": ["why", "mechanism", "cause", "explain", "reason", "how does"],
    "predictive": ["predict", "forecast", "estimate", "model", "probability", "likelihood"],
    "causal": ["effect of", "impact of", "role of", "influence of", "determine"],
    "comparative": ["compare", "difference between", "versus", "relative to", "compared with"],
}

# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class SemanticAnalysis:
    reference_id: str
    semantic_score: float
    key_concepts: List[str]
    research_intent: str
    novelty_score: float
    methodology_detected: List[str]
    concept_density: float
    top_tfidf_terms: List[str]


@dataclass
class ResearchQuestion:
    question_id: str
    question_text: str
    question_type: str
    significance_score: float
    clarity_score: float
    source_reference: str
    related_concepts: List[str]


@dataclass
class LiteratureSummary:
    summary_id: str
    topic: str
    summary_text: str
    key_findings: List[str]
    methodology_summary: str
    research_gaps: List[str]
    source_references: List[str]
    confidence_score: float
    document_count: int


@dataclass
class MethodologyProfile:
    reference_id: str
    detected_methods: List[Dict]
    experimental_design: str
    statistical_methods: List[str]
    tools_software: List[str]
    methodology_category: str
    confidence: float


# ── Service ───────────────────────────────────────────────────────────────────

class AdvancedNLPProcessingService:
    """Advanced NLP processing for research intelligence — pure Python."""

    MIN_DOCS_FOR_TOPICS = 3

    # ── Tokenization helpers ──────────────────────────────────────────────────

    def _tokenize(self, text: str) -> List[str]:
        text = text.lower()
        text = re.sub(r"[^a-z0-9\s\-]", " ", text)
        return [t for t in text.split() if t not in _STOP_WORDS and len(t) > 2]

    def _sentences(self, text: str) -> List[str]:
        text = re.sub(r"\s+", " ", text.strip())
        parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text)
        return [s.strip() for s in parts if len(s.strip()) > 20]

    # ── TF-IDF core ───────────────────────────────────────────────────────────

    def _tf(self, term: str, tokens: List[str]) -> float:
        if not tokens:
            return 0.0
        return tokens.count(term) / len(tokens)

    def _idf(self, term: str, corpus: List[List[str]]) -> float:
        df = sum(1 for doc in corpus if term in doc)
        return math.log((len(corpus) + 1) / (df + 1)) + 1.0

    def _tfidf_vector(self, tokens: List[str], corpus: List[List[str]]) -> Dict[str, float]:
        term_set = set(tokens)
        return {t: self._tf(t, tokens) * self._idf(t, corpus) for t in term_set}

    def _cosine_sim(self, v1: Dict[str, float], v2: Dict[str, float]) -> float:
        common = set(v1) & set(v2)
        if not common:
            return 0.0
        dot = sum(v1[t] * v2[t] for t in common)
        mag1 = math.sqrt(sum(x ** 2 for x in v1.values()))
        mag2 = math.sqrt(sum(x ** 2 for x in v2.values()))
        if mag1 == 0 or mag2 == 0:
            return 0.0
        return dot / (mag1 * mag2)

    def _top_terms(self, vec: Dict[str, float], n: int = 10) -> List[str]:
        return [t for t, _ in sorted(vec.items(), key=lambda x: -x[1])[:n]]

    # ── Semantic analysis ─────────────────────────────────────────────────────

    def analyze_abstract_semantics(self, ref: Dict) -> Dict:
        ref_id = ref.get("reference_id", "")
        text = (ref.get("abstract") or ref.get("notes") or "").strip()
        title = (ref.get("title") or "").strip()
        combined = f"{title} {text}".strip()

        if not combined:
            return asdict(SemanticAnalysis(
                reference_id=ref_id, semantic_score=0.0, key_concepts=[],
                research_intent="unknown", novelty_score=0.0,
                methodology_detected=[], concept_density=0.0, top_tfidf_terms=[],
            ))

        tokens = self._tokenize(combined)
        corpus = [tokens]
        tfidf_vec = self._tfidf_vector(tokens, corpus)
        top_terms = self._top_terms(tfidf_vec, 10)
        key_concepts = self._extract_concepts(combined)
        research_intent = self._detect_intent(combined)
        methodologies = self._detect_methods_in_text(combined)
        novelty_score = self._assess_novelty(combined)
        concept_density = len(key_concepts) / max(len(tokens), 1)
        semantic_score = round(
            0.4 * min(len(key_concepts) / 5, 1.0)
            + 0.3 * novelty_score
            + 0.3 * min(concept_density * 10, 1.0),
            3,
        )
        return asdict(SemanticAnalysis(
            reference_id=ref_id,
            semantic_score=semantic_score,
            key_concepts=key_concepts,
            research_intent=research_intent,
            novelty_score=round(novelty_score, 3),
            methodology_detected=methodologies,
            concept_density=round(concept_density, 4),
            top_tfidf_terms=top_terms,
        ))

    def _extract_concepts(self, text: str) -> List[str]:
        words = re.findall(r"\b[a-zA-Z][\w\-]*\b", text)
        phrases: List[str] = []
        for i in range(len(words) - 1):
            w1, w2 = words[i].lower(), words[i + 1].lower()
            if (w1 not in _STOP_WORDS and w2 not in _STOP_WORDS
                    and len(w1) > 2 and len(w2) > 2):
                phrases.append(f"{w1} {w2}")
        abbrevs = [a.lower() for a in re.findall(r"\b[A-Z]{2,7}\b", text)]
        counts = Counter(phrases + abbrevs)
        return [c for c, _ in counts.most_common(12)]

    def _detect_intent(self, text: str) -> str:
        text_lower = text.lower()
        scores = {
            intent: sum(1 for kw in kws if kw in text_lower)
            for intent, kws in _INTENT_KEYWORDS.items()
        }
        best = max(scores, key=scores.get)
        return best if scores[best] > 0 else "investigation"

    def _assess_novelty(self, text: str) -> float:
        novelty_terms = [
            "novel", "first", "unique", "unprecedented", "original",
            "innovative", "newly", "previously unreported", "first time",
        ]
        hits = sum(1 for t in novelty_terms if t in text.lower())
        return round(min(hits / 3, 1.0), 3)

    def _detect_methods_in_text(self, text: str) -> List[str]:
        text_lower = text.lower()
        found = []
        for cat, terms in _METHODOLOGY_VOCAB.items():
            if any(t in text_lower for t in terms):
                found.append(cat.replace("_", " "))
        return found

    # ── Literature summarization ──────────────────────────────────────────────

    def generate_literature_summary(self, refs: List[Dict], topic: str = "Research Overview") -> Dict:
        docs = []
        ref_ids = []
        for ref in refs:
            text = f"{ref.get('title', '')} {ref.get('abstract', '')} {ref.get('notes', '')}".strip()
            if text and len(text) > 20:
                docs.append(text)
                ref_ids.append(ref.get("reference_id", ""))

        if not docs:
            return asdict(LiteratureSummary(
                summary_id="", topic=topic,
                summary_text="No sufficient reference content for summarization.",
                key_findings=[], methodology_summary="", research_gaps=[],
                source_references=[], confidence_score=0.0, document_count=0,
            ))

        summary_text = self._extractive_summary(docs, n_sentences=4)
        key_findings = self._extract_findings(docs)
        research_gaps = self._detect_gaps(docs)
        method_cats = self._summarize_method_categories(refs)
        methodology_summary = (", ".join(method_cats)
                               if method_cats else "Various experimental approaches")
        confidence = round(min(len(docs) / 10, 1.0) * 0.8 + 0.2, 3)

        return asdict(LiteratureSummary(
            summary_id=f"sum_{int(datetime.now(timezone.utc).timestamp())}",
            topic=topic,
            summary_text=summary_text,
            key_findings=key_findings[:6],
            methodology_summary=methodology_summary,
            research_gaps=research_gaps[:5],
            source_references=ref_ids,
            confidence_score=confidence,
            document_count=len(docs),
        ))

    def _extractive_summary(self, docs: List[str], n_sentences: int = 4) -> str:
        all_sentences: List[str] = []
        for doc in docs:
            all_sentences.extend(self._sentences(doc))
        if not all_sentences:
            return "Insufficient content for summary generation."

        doc_tokens = [self._tokenize(s) for s in all_sentences]
        scored: List[tuple] = []
        for i, (sent, tokens) in enumerate(zip(all_sentences, doc_tokens)):
            if not tokens:
                continue
            vec = self._tfidf_vector(tokens, doc_tokens)
            score = sum(vec.values()) / max(len(tokens), 1)
            scored.append((score, i, sent))

        scored.sort(reverse=True)
        top_indices = sorted([idx for _, idx, _ in scored[:n_sentences]])
        return " ".join(all_sentences[i] for i in top_indices)

    def _extract_findings(self, docs: List[str]) -> List[str]:
        findings: List[str] = []
        for doc in docs:
            for sent in self._sentences(doc):
                if any(ind in sent.lower() for ind in _FINDING_INDICATORS):
                    clean = sent.strip()
                    if len(clean) > 40 and clean not in findings:
                        findings.append(clean)
        return findings[:8]

    def _detect_gaps(self, docs: List[str]) -> List[str]:
        gaps: List[str] = []
        for doc in docs:
            for sent in self._sentences(doc):
                if any(ind in sent.lower() for ind in _GAP_INDICATORS):
                    clean = sent.strip()
                    if len(clean) > 40 and clean not in gaps:
                        gaps.append(clean)
        return gaps[:6]

    def _summarize_method_categories(self, refs: List[Dict]) -> List[str]:
        cat_counts: Counter = Counter()
        for ref in refs:
            text = f"{ref.get('title', '')} {ref.get('abstract', '')}".lower()
            for cat, terms in _METHODOLOGY_VOCAB.items():
                if any(t in text for t in terms):
                    cat_counts[cat] += 1
        return [cat.replace("_", " ") for cat, _ in cat_counts.most_common(4)]

    # ── Research question extraction ──────────────────────────────────────────

    def extract_research_questions(self, refs: List[Dict]) -> List[Dict]:
        questions: List[Dict] = []
        for ref in refs:
            text = f"{ref.get('title', '')} {ref.get('abstract', '')}".strip()
            if not text:
                continue
            questions.extend(self._find_questions(text, ref.get("reference_id", "")))
        questions = self._dedup_questions(questions)
        questions.sort(key=lambda q: -(q["significance_score"] + q["clarity_score"]))
        return questions[:20]

    def _find_questions(self, text: str, ref_id: str) -> List[Dict]:
        found: List[Dict] = []
        for i, sent in enumerate(self._sentences(text)):
            s_lower = sent.lower()
            is_question = (
                sent.endswith("?")
                or any(re.search(p, s_lower) for p in _QUESTION_PATTERNS)
                or any(kw in s_lower for kw in [
                    "we investigated", "we aimed to", "we sought to",
                    "the aim of", "the goal of", "the objective",
                ])
            )
            if not is_question:
                continue
            found.append(asdict(ResearchQuestion(
                question_id=f"{ref_id}_q{i}",
                question_text=sent.strip(),
                question_type=self._classify_question(s_lower),
                significance_score=round(self._score_significance(sent), 3),
                clarity_score=round(self._score_clarity(sent), 3),
                source_reference=ref_id,
                related_concepts=[t for t in self._tokenize(sent) if len(t) > 4][:5],
            )))
        return found

    def _classify_question(self, text_lower: str) -> str:
        scores = {
            qt: sum(1 for kw in kws if kw in text_lower)
            for qt, kws in _QUESTION_TYPE_KEYWORDS.items()
        }
        best = max(scores, key=scores.get)
        return best if scores[best] > 0 else "descriptive"

    def _score_significance(self, sent: str) -> float:
        sig_terms = [
            "mechanism", "role", "function", "pathway", "therapeutic",
            "disease", "clinical", "pathology", "treatment", "novel",
            "prion", "neurodegeneration", "aggregation",
        ]
        hits = sum(1 for t in sig_terms if t in sent.lower())
        length_bonus = min(len(sent.split()) / 20, 0.3)
        return min(hits * 0.12 + length_bonus + 0.2, 1.0)

    def _score_clarity(self, sent: str) -> float:
        words = sent.split()
        n = len(words)
        if n < 5:
            return 0.2
        if n > 60:
            return 0.35
        clarity_verbs = ["investigate", "determine", "evaluate", "assess", "examine", "aim to"]
        has_verb = any(v in sent.lower() for v in clarity_verbs)
        return round(min(0.55 + (0.2 if has_verb else 0) + min(n / 30, 0.25), 1.0), 3)

    def _dedup_questions(self, questions: List[Dict]) -> List[Dict]:
        seen: List[Set[str]] = []
        result: List[Dict] = []
        for q in questions:
            tokens = set(self._tokenize(q["question_text"]))
            if not any(
                len(tokens & s) / max(len(tokens | s), 1) > 0.7 for s in seen
            ):
                result.append(q)
                seen.append(tokens)
        return result

    # ── Methodology detection ─────────────────────────────────────────────────

    def detect_methodology_profile(self, ref: Dict) -> Dict:
        ref_id = ref.get("reference_id", "")
        text = f"{ref.get('title', '')} {ref.get('abstract', '')}".lower()
        detected_methods = self._detect_methods_detailed(text)
        experimental_design = self._identify_design(text)
        stats = self._detect_stats(text)
        tools = self._detect_tools(text)
        category = self._main_category(text)
        confidence = round(min(len(detected_methods) * 0.2 + 0.3, 1.0), 3)
        return asdict(MethodologyProfile(
            reference_id=ref_id,
            detected_methods=detected_methods,
            experimental_design=experimental_design,
            statistical_methods=stats,
            tools_software=tools,
            methodology_category=category,
            confidence=confidence,
        ))

    def _detect_methods_detailed(self, text: str) -> List[Dict]:
        results: List[Dict] = []
        for cat, terms in _METHODOLOGY_VOCAB.items():
            found_terms = [t for t in terms if t in text]
            if found_terms:
                results.append({
                    "category": cat.replace("_", " "),
                    "terms": found_terms[:3],
                    "confidence": round(min(len(found_terms) / 3, 1.0), 2),
                })
        return results

    def _identify_design(self, text: str) -> str:
        designs = [
            ("randomized controlled trial", ["randomized", "rct", "placebo"]),
            ("cohort study",               ["cohort study", "longitudinal", "follow-up"]),
            ("case-control study",         ["case-control", "case control"]),
            ("in vitro experiment",        ["in vitro", "cell culture", "cell line"]),
            ("in vivo experiment",         ["in vivo", "animal model", "mouse model"]),
            ("computational study",        ["computational", "simulation", "bioinformatics"]),
            ("systematic review",          ["meta-analysis", "systematic review"]),
            ("observational study",        ["observational", "cross-sectional", "epidemi"]),
        ]
        for design, keywords in designs:
            if any(kw in text for kw in keywords):
                return design
        return "experimental study"

    def _detect_stats(self, text: str) -> List[str]:
        return [m for m in _STATISTICAL_METHODS if m in text][:5]

    def _detect_tools(self, text: str) -> List[str]:
        return [t for t in _TOOLS_SOFTWARE if t in text][:5]

    def _main_category(self, text: str) -> str:
        cat_scores = {
            cat: sum(1 for t in terms if t in text)
            for cat, terms in _METHODOLOGY_VOCAB.items()
        }
        best = max(cat_scores, key=cat_scores.get)
        return best.replace("_", " ") if cat_scores[best] > 0 else "experimental"

    # ── Topic modeling ────────────────────────────────────────────────────────

    def perform_topic_modeling(self, refs: List[Dict], num_topics: int = 5) -> Dict:
        docs: List[str] = []
        ref_ids: List[str] = []
        for ref in refs:
            text = f"{ref.get('title', '')} {ref.get('abstract', '')} {ref.get('notes', '')}".strip()
            if len(text) > 15:
                docs.append(text)
                ref_ids.append(ref.get("reference_id", ""))

        if len(docs) < self.MIN_DOCS_FOR_TOPICS:
            return {
                "success": False,
                "error": f"Need at least {self.MIN_DOCS_FOR_TOPICS} documents for topic modeling",
                "doc_count": len(docs),
            }

        num_topics = min(num_topics, len(docs))
        corpus_tokens = [self._tokenize(d) for d in docs]
        tfidf_vecs = [self._tfidf_vector(tok, corpus_tokens) for tok in corpus_tokens]
        assignments = self._cluster_docs(tfidf_vecs, num_topics)

        # Build topics from cluster centroids
        topics: List[Dict] = []
        for t_id in range(num_topics):
            cluster_vecs = [tfidf_vecs[i] for i, a in enumerate(assignments) if a == t_id]
            if not cluster_vecs:
                continue
            agg: Counter = Counter()
            for vec in cluster_vecs:
                for term, score in vec.items():
                    agg[term] += score
            top_words = [w for w, _ in agg.most_common(10)]
            topics.append({
                "topic_id": t_id,
                "top_words": top_words,
                "size": len(cluster_vecs),
                "topic_label": self._label_topic(top_words),
            })

        doc_assignments = [
            {
                "reference_id": ref_ids[i],
                "topic_id": int(assignments[i]),
                "dominant_terms": self._top_terms(tfidf_vecs[i], 5),
            }
            for i in range(len(docs))
        ]

        return {
            "success": True,
            "topics": topics,
            "document_assignments": doc_assignments,
            "model_params": {
                "num_topics": num_topics,
                "num_documents": len(docs),
            },
        }

    def _cluster_docs(
        self, vecs: List[Dict[str, float]], n_clusters: int
    ) -> List[int]:
        """Pure-Python k-means-style document clustering."""
        n = len(vecs)
        if n <= n_clusters:
            return list(range(n))

        # Initialize centroids by spread selection (max-dissimilarity seeding)
        centroids = [dict(vecs[0])]
        for _ in range(1, n_clusters):
            sims = [max(self._cosine_sim(v, c) for c in centroids) for v in vecs]
            centroids.append(dict(vecs[sims.index(min(sims))]))

        assignments = [0] * n
        for _ in range(10):
            changed = False
            for i, vec in enumerate(vecs):
                best_c = max(range(n_clusters),
                             key=lambda c: self._cosine_sim(vec, centroids[c]))
                if best_c != assignments[i]:
                    assignments[i] = best_c
                    changed = True
            if not changed:
                break
            for c_idx in range(n_clusters):
                cluster_vecs = [vecs[i] for i in range(n) if assignments[i] == c_idx]
                if not cluster_vecs:
                    continue
                new_c: defaultdict = defaultdict(float)
                for v in cluster_vecs:
                    for t, s in v.items():
                        new_c[t] += s / len(cluster_vecs)
                centroids[c_idx] = dict(new_c)

        return assignments

    def _label_topic(self, top_words: List[str]) -> str:
        domain_map = {
            "prion": "Prion Biology",
            "protein": "Protein Biochemistry",
            "brain": "Neuroscience",
            "clinical": "Clinical Research",
            "mouse": "Animal Models",
            "cell": "Cell Biology",
            "gene": "Genetics/Genomics",
            "therapy": "Therapeutic Research",
            "structure": "Structural Biology",
            "aggregation": "Protein Aggregation",
            "neurodegeneration": "Neurodegeneration",
            "amyloid": "Amyloid Research",
        }
        for word in top_words:
            for key, label in domain_map.items():
                if key in word:
                    return label
        return " / ".join(top_words[:3]).title() if top_words else "Research Topic"


# ── Singleton ─────────────────────────────────────────────────────────────────

_svc: Optional[AdvancedNLPProcessingService] = None


def get_nlp_processing_service() -> AdvancedNLPProcessingService:
    global _svc
    if _svc is None:
        _svc = AdvancedNLPProcessingService()
    return _svc
