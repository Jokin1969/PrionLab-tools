"""Locks down _parse_confidence(): the function pulls the model's
self-reported confidence label out of the answer. Various models
drift away from the exact prompt format, so we accept several
synonyms and case variants and normalise English to Spanish."""
import pytest

# rag.py imports embeddings/retriever which imports pgvector. None
# of that is actually invoked when we only call _parse_confidence,
# but the module-level imports run on first import. If they fail
# (e.g. SDK missing in the test env) we skip the file instead of
# erroring the whole suite.
pytest.importorskip("sqlalchemy")
from tools.prionvault.services.rag import _parse_confidence  # noqa: E402


@pytest.mark.parametrize("answer, expected", [
    # Exact prompt format the system asks for.
    ("…texto…\nNivel de confianza: alto",        "alto"),
    ("Lorem ipsum.\nnivel de confianza: medio",  "medio"),
    ("…\nNIVEL DE CONFIANZA:bajo",               "bajo"),
    # The model often drops "Nivel de".
    ("…\nConfianza: alto",                       "alto"),
    ("…\nconfianza:  medio",                     "medio"),
    # English drift, normalised to Spanish.
    ("…\nConfidence: high",                      "alto"),
    ("…\nconfidence: Medium",                    "medio"),
    ("…\nCONFIDENCE: low",                       "bajo"),
    # Missing → None.
    ("No confidence marker anywhere",            None),
    ("",                                          None),
])
def test_parse_confidence_variants(answer, expected):
    assert _parse_confidence(answer) == expected


def test_parse_confidence_picks_first_match():
    """If the model accidentally emits two markers, we honour the
    first one rather than silently failing."""
    answer = ("Bla bla.\nNivel de confianza: alto\n\n"
              "Apéndice: Confianza: bajo")
    assert _parse_confidence(answer) == "alto"
