-- "Editor de Vigilancia competitiva": a non-admin user who may generate and
-- edit the VC report (same powers as an admin inside that section only).
-- Granted to Hasier Eraña at the PI's request.
ALTER TABLE prionlab_users ADD COLUMN IF NOT EXISTS is_vc_editor TEXT NOT NULL DEFAULT '';
UPDATE prionlab_users SET is_vc_editor = 'true'
 WHERE lower(email) = 'herana@cicbiogune.es' OR lower(username) = 'herana';
