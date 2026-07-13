-- 091 down — remove a unicidade global de linha ativa e desfaz a
-- normalização '+' (volta a dígitos puros para as rows normalizadas).
DROP INDEX IF EXISTS channels_active_line_uq;
UPDATE channels
   SET external_id = substr(external_id, 2)
 WHERE channel_type = 'whatsapp'
   AND external_id ~ '^\+[1-9][0-9]{6,14}$';
