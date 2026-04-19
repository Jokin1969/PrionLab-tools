"""User feedback learning system — pure Python, no sklearn/numpy/pandas dependencies.

Tracks user interactions with recommendations, derives adaptive per-user
algorithm weights, and surfaces feedback patterns to inform tuning.
"""
import json
import logging
import os
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ── Action reward values ──────────────────────────────────────────────────────

_ACTION_VALUES: Dict[str, float] = {
    "cite_reference":   1.0,
    "add_to_manuscript": 0.8,
    "view_details":     0.4,
    "click":            0.3,
    "dismiss":         -0.3,
    "mark_irrelevant": -0.8,
}

# Baseline algorithm weights (mirrors ai_core._WEIGHTS)
_DEFAULT_WEIGHTS: Dict[str, float] = {
    "collaborative": 0.40,
    "content":       0.35,
    "expertise":     0.25,
}

# ── Data class ────────────────────────────────────────────────────────────────

@dataclass
class FeedbackPattern:
    pattern_type: str        # recommendation_strength | recommendation_weakness |
                             # journal_preference | recency_preference
    description: str
    confidence: float        # 0-1
    impact_score: float      # magnitude of the signal
    recommendation: str      # actionable suggestion


# ── Persistence ───────────────────────────────────────────────────────────────

def _feedback_path() -> str:
    try:
        import config
        return os.path.join(config.CSV_DIR, "reference_feedback.json")
    except Exception:
        return os.path.join("data", "reference_feedback.json")


def _load_store() -> List[Dict]:
    path = _feedback_path()
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except Exception as e:
        logger.warning("feedback_learning load: %s", e)
    return []


def _save_store(records: List[Dict]) -> None:
    path = _feedback_path()
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(records, fh, indent=2)
    except Exception as e:
        logger.warning("feedback_learning save: %s", e)


# ── Service ───────────────────────────────────────────────────────────────────

class UserFeedbackLearningService:
    """Feedback-driven adaptive recommendation learning."""

    MAX_RECORDS = 5_000   # cap file growth
    MIN_HISTORY = 5       # minimum interactions before personalising

    # ── Write ─────────────────────────────────────────────────────────────────

    def record_feedback(
        self,
        username: str,
        rec_type: str,
        ref_id: str,
        ms_id: str,
        action: str,
        journal: str = "",
        year: int = 0,
    ) -> bool:
        """Persist one feedback event. Returns True on success."""
        try:
            records = _load_store()
            ts = datetime.now(timezone.utc)
            records.append({
                "id": f"fb_{int(ts.timestamp())}_{username[:8]}",
                "username": username,
                "rec_type": rec_type,
                "ref_id": ref_id,
                "ms_id": ms_id,
                "action": action,
                "value": _ACTION_VALUES.get(action, 0.0),
                "journal": (journal or "").lower().strip(),
                "year": int(year) if year else 0,
                "timestamp": ts.isoformat(),
            })
            if len(records) > self.MAX_RECORDS:
                records = records[-self.MAX_RECORDS:]
            _save_store(records)
            logger.debug("feedback recorded: %s %s %s", username, action, rec_type)
            return True
        except Exception as e:
            logger.error("record_feedback: %s", e)
            return False

    # ── Adaptive weights ──────────────────────────────────────────────────────

    def get_adaptive_weights(self, username: str) -> Dict[str, float]:
        """Return per-user algorithm weights derived from feedback history.

        Falls back to defaults when fewer than MIN_HISTORY records exist.
        """
        records = _load_store()
        user_recs = [r for r in records if r.get("username") == username]

        if len(user_recs) < self.MIN_HISTORY:
            return dict(_DEFAULT_WEIGHTS)

        # Compute mean reward per rec_type from the last 300 interactions
        type_values: Dict[str, List[float]] = defaultdict(list)
        for r in user_recs[-300:]:
            type_values[r.get("rec_type", "content")].append(r.get("value", 0.0))

        # Blend default weight with feedback signal
        # mean_reward in [-1, 1] → multiplicative factor in [0.5, 1.5]
        adjusted: Dict[str, float] = {}
        for t, base in _DEFAULT_WEIGHTS.items():
            vals = type_values.get(t, [])
            avg = statistics.mean(vals) if vals else 0.0
            factor = 1.0 + avg * 0.5
            adjusted[t] = max(0.05, base * factor)

        total = sum(adjusted.values())
        return {t: round(v / total, 4) for t, v in adjusted.items()}

    # ── Impact prediction ─────────────────────────────────────────────────────

    def predict_success(
        self,
        rec_type: str,
        journal: str,
        year: int,
        username: str,
    ) -> float:
        """Empirical success probability for a recommendation, 0-1."""
        records = _load_store()

        def _pos_rate(subset: List[Dict]) -> Optional[float]:
            if not subset:
                return None
            pos = sum(1 for r in subset if r.get("value", 0) > 0.1)
            return pos / len(subset)

        # Global rate for rec_type
        type_recs = [r for r in records if r.get("rec_type") == rec_type]
        base = _pos_rate(type_recs) or 0.5

        # Adjust for journal
        j = (journal or "").lower().strip()
        if j:
            j_recs = [r for r in records if r.get("journal") == j]
            jr = _pos_rate(j_recs)
            if jr is not None:
                base = base * 0.6 + jr * 0.4

        # Adjust for this user's history with this rec_type
        user_type = [
            r for r in records
            if r.get("username") == username and r.get("rec_type") == rec_type
        ]
        ur = _pos_rate(user_type)
        if ur is not None:
            base = base * 0.5 + ur * 0.5

        return round(min(max(base, 0.0), 1.0), 3)

    # ── Pattern analysis ──────────────────────────────────────────────────────

    def analyze_patterns(
        self, username: Optional[str] = None
    ) -> List[Dict]:
        """Identify actionable feedback patterns."""
        records = _load_store()
        subset = (
            [r for r in records if r.get("username") == username]
            if username
            else records
        )

        if len(subset) < self.MIN_HISTORY:
            return []

        patterns: List[Dict] = []
        current_year = datetime.now().year

        # 1. Recommendation type strength / weakness
        type_vals: Dict[str, List[float]] = defaultdict(list)
        for r in subset:
            type_vals[r.get("rec_type", "content")].append(r.get("value", 0.0))
        for rtype, vals in type_vals.items():
            if len(vals) < 3:
                continue
            avg = statistics.mean(vals)
            conf = round(min(len(vals) / 20, 1.0), 2)
            if avg > 0.3:
                patterns.append({
                    "pattern_type": "recommendation_strength",
                    "description": f"'{rtype}' recommendations consistently accepted",
                    "confidence": conf,
                    "impact_score": round(avg, 3),
                    "recommendation": f"Increase weight for '{rtype}' algorithm",
                })
            elif avg < -0.1:
                patterns.append({
                    "pattern_type": "recommendation_weakness",
                    "description": f"'{rtype}' recommendations frequently dismissed",
                    "confidence": conf,
                    "impact_score": round(abs(avg), 3),
                    "recommendation": f"Reduce weight for '{rtype}' algorithm",
                })

        # 2. Journal preference
        journal_vals: Dict[str, List[float]] = defaultdict(list)
        for r in subset:
            j = r.get("journal", "")
            if j:
                journal_vals[j].append(r.get("value", 0.0))
        for j, vals in journal_vals.items():
            if len(vals) >= 2 and statistics.mean(vals) > 0.5:
                patterns.append({
                    "pattern_type": "journal_preference",
                    "description": f"Strong preference for '{j}' publications",
                    "confidence": round(min(len(vals) / 10, 1.0), 2),
                    "impact_score": round(statistics.mean(vals), 3),
                    "recommendation": f"Boost recommendations from {j}",
                })

        # 3. Recency preference
        recent = [r for r in subset if r.get("year", 0) >= current_year - 3]
        older = [
            r for r in subset
            if 0 < r.get("year", 0) < current_year - 3
        ]
        if recent and older:
            r_avg = statistics.mean(r.get("value", 0) for r in recent)
            o_avg = statistics.mean(r.get("value", 0) for r in older)
            diff = r_avg - o_avg
            if diff > 0.2:
                patterns.append({
                    "pattern_type": "recency_preference",
                    "description": "Strong preference for recent publications (≤3 years)",
                    "confidence": 0.8,
                    "impact_score": round(diff, 3),
                    "recommendation": "Increase recency boost in recommendation scoring",
                })

        return sorted(patterns, key=lambda p: -p["impact_score"])

    # ── Statistics ────────────────────────────────────────────────────────────

    def get_stats(self) -> Dict:
        """Overall feedback system statistics."""
        records = _load_store()
        if not records:
            return {
                "total": 0, "positive": 0, "negative": 0, "neutral": 0,
                "positive_rate": 0, "by_type": {}, "by_action": {},
                "unique_users": 0,
            }

        positive = sum(1 for r in records if r.get("value", 0) > 0.1)
        negative = sum(1 for r in records if r.get("value", 0) < -0.1)
        neutral = len(records) - positive - negative

        return {
            "total": len(records),
            "positive": positive,
            "negative": negative,
            "neutral": neutral,
            "positive_rate": round(positive / max(len(records), 1), 3),
            "by_type": dict(
                Counter(r.get("rec_type", "content") for r in records).most_common()
            ),
            "by_action": dict(
                Counter(r.get("action", "") for r in records).most_common()
            ),
            "unique_users": len({r.get("username") for r in records}),
        }


# ── Singleton ─────────────────────────────────────────────────────────────────

_svc: Optional[UserFeedbackLearningService] = None


def get_feedback_learning_service() -> UserFeedbackLearningService:
    global _svc
    if _svc is None:
        _svc = UserFeedbackLearningService()
    return _svc
