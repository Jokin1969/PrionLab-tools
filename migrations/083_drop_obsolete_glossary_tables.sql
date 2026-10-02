-- Drop tables tied to two now-obsolete glossary workflows:
--
-- 1. Retroactive "improve existing summaries with the glossary" batch
--    jobs (migration 062, patched by 064/066/067). All AI summaries have
--    since been regenerated from scratch with the current glossary, and
--    every new/regenerated summary already records which glossary
--    version produced it via articles.ai_summary_glossary_version — so
--    this reconciliation machinery (and its audit trail) has no more
--    use case. Code removed: tools/prionvault/services/summary_improver.py
--    and the corresponding routes in routes_glossary.py.
--
-- 2. The legacy simple EN->ES translation glossary (migration 051),
--    unified into prionvault_glossary_terms (061) — the richer,
--    versioned table already used for AI-summary generation. Article
--    chat and library chat now read from the same unified glossary via
--    glossary_manager.prompt_block(). Code removed:
--    tools/prionvault/services/glossary.py and its /api/admin/glossary
--    CRUD routes.

BEGIN;

DROP TABLE IF EXISTS summary_correction_detail;
DROP TABLE IF EXISTS summary_improvement_log;
DROP TABLE IF EXISTS glossary_improvement_stats;
DROP TABLE IF EXISTS prionvault_translation_glossary;

COMMIT;
