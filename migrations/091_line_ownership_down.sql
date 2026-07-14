-- 091 down — remove a unicidade global de linha ativa e desfaz a
-- normalização '+' APENAS nas rows que o forward efetivamente mudou
-- (registro em channels_line_normalization_091_backup — review PR #496
-- alto 7). Rows que sempre foram E.164 (ou nasceram normalizadas depois de
-- 091) ficam INTACTAS: sob o schema 089 external_id é texto livre, então
-- manter o '+' é seguro; era o strip indiscriminado que quebrava.
DROP INDEX IF EXISTS channels_active_line_uq;

DO $$
BEGIN
  -- Ambientes que aplicaram a versão PRÉ-FIX do forward não têm o backup:
  -- nesse caso o down não toca dados (fail-safe > desnormalizar às cegas).
  IF to_regclass('channels_line_normalization_091_backup') IS NOT NULL THEN
    UPDATE channels c
       SET external_id = b.original_external_id
      FROM channels_line_normalization_091_backup b
     WHERE c.id = b.channel_id;
    DROP TABLE channels_line_normalization_091_backup;
  END IF;
END $$;
