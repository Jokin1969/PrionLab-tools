"""PrionVault ingestion pipeline (Phase 2).

This package will host the bulk-PDF import workflow:

    ingestion.queue           — persistent BD-backed job queue
    ingestion.pdf_extractor   — pdfplumber wrapper, returns text + page count
    ingestion.metadata_resolver — CrossRef + PubMed lookup by DOI / title
    ingestion.dropbox_uploader — reuses core/dropbox_client.py
    ingestion.deduplicator    — DOI + MD5 dedup
    ingestion.worker          — long-running consumer

Stubbed for now; populated in the next entregable.
"""
