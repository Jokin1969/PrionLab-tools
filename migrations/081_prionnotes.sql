-- PrionNotes: generic floating post-it board, private per user, attached
-- to any entity via a generic (entity_type, entity_id) pair. Ported from
-- the PrionAAV Atlas blueprint; kept separate from the existing 5-note-cap
-- per-article sticky notes system (prionvault_article_note, see
-- migration 052) which this does NOT touch or replace.
--
-- id is TEXT and generated in Python as f"n{int(time.time()*1000)}" (see
-- tools/prionvault/services/prionnotes.py _new_note_id) rather than a DB
-- default, matching the blueprint's design (server-generated ids only,
-- no optimistic-UI temp ids on the client).
--
-- entity_id is TEXT even though article ids are UUIDs, so the same table
-- can serve any future entity type without a schema change.

BEGIN;

CREATE TABLE IF NOT EXISTS prionnotes_entity_notes (
    id           TEXT        PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type  TEXT        NOT NULL,
    entity_id    TEXT        NOT NULL,
    text         TEXT        NOT NULL,
    color        TEXT        NOT NULL DEFAULT '#fef9c3',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prionnotes_user_entity_idx
    ON prionnotes_entity_notes (user_id, entity_type, entity_id);

COMMIT;
