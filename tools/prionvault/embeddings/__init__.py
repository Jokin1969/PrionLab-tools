"""PrionVault embeddings pipeline (Phase 4).

    embeddings.chunker  — token-aware splitter with overlap
    embeddings.embedder — Voyage `voyage-3-large` client
    embeddings.indexer  — article -> chunks -> vectors workflow

Retrieval lives in `prionvault.embeddings.retriever` (Phase 5).
"""
