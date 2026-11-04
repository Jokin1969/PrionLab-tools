-- Presenter named in the "Convocar Journal Club" modal (prefilled from the
-- article's reservation, editable), kept for scheduled convocations.
ALTER TABLE prionvault_jc_convocation_schedule ADD COLUMN IF NOT EXISTS presenter_name TEXT;
