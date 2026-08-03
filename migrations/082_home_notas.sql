-- Notas de Inicio: shared corkboard of draggable/resizable sticky notes,
-- shown only on the Home page. Ported from the PrionAAV Atlas blueprint.
-- Completely independent from PrionNotes (prionnotes_entity_notes, migration
-- 081) — that system is private-per-user notes attached to any entity;
-- this one is a shared multi-board system with configurable per-note
-- visibility (private / everyone / specific people) and per-user "seen"
-- tracking. Do not merge the two.

BEGIN;

CREATE TABLE IF NOT EXISTS home_tablon (
    id_tablon      SERIAL      PRIMARY KEY,
    nombre         TEXT        NOT NULL,
    autor_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
    orden          INTEGER     NOT NULL DEFAULT 0,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_home_tablon_orden ON home_tablon(orden, id_tablon);

-- System board (id 1, "Notas", no owner) — pre-existing notes and any
-- note created without an explicit id_tablon land here.
INSERT INTO home_tablon (id_tablon, nombre, autor_id, orden)
SELECT 1, 'Notas', NULL, 0
WHERE NOT EXISTS (SELECT 1 FROM home_tablon WHERE id_tablon = 1);
SELECT setval(pg_get_serial_sequence('home_tablon', 'id_tablon'),
              GREATEST((SELECT MAX(id_tablon) FROM home_tablon), 1));

CREATE TABLE IF NOT EXISTS home_nota (
    id_nota        SERIAL      PRIMARY KEY,
    contenido      TEXT        NOT NULL DEFAULT '',
    color          TEXT        NOT NULL DEFAULT '#FEF08A',
    pos_x          REAL        NOT NULL DEFAULT 24,
    pos_y          REAL        NOT NULL DEFAULT 24,
    ancho          REAL        NOT NULL DEFAULT 240,
    alto           REAL        NOT NULL DEFAULT 200,
    visibilidad    TEXT        NOT NULL DEFAULT 'privada',
    autor_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    editado_por    UUID        REFERENCES users(id) ON DELETE SET NULL,
    id_tablon      INTEGER     NOT NULL DEFAULT 1 REFERENCES home_tablon(id_tablon) ON DELETE CASCADE,
    fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fecha_modif    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_home_nota_autor ON home_nota(autor_id);
CREATE INDEX IF NOT EXISTS idx_home_nota_tablon ON home_nota(id_tablon);

-- Bridge table: explicit recipients when visibilidad = 'personalizada'.
-- The author is never inserted here (already sees the note as author).
CREATE TABLE IF NOT EXISTS home_nota_usuario (
    id_nota    INTEGER NOT NULL REFERENCES home_nota(id_nota) ON DELETE CASCADE,
    id_usuario UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (id_nota, id_usuario)
);
CREATE INDEX IF NOT EXISTS idx_home_nota_usuario_u ON home_nota_usuario(id_usuario);

-- Per-user "seen" mark, compared against fecha_modif to flag unread changes.
CREATE TABLE IF NOT EXISTS home_nota_visto (
    id_nota     INTEGER     NOT NULL REFERENCES home_nota(id_nota) ON DELETE CASCADE,
    id_usuario  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fecha_visto TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id_nota, id_usuario)
);

COMMIT;
