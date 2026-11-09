-- VC: suggested themes written by the lab, given to the AI when grouping.
ALTER TABLE prionvault_vc_report ADD COLUMN IF NOT EXISTS theme_hints TEXT NOT NULL DEFAULT '';
