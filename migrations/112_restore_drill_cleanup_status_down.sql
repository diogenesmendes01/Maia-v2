-- Down de 112 — remove `restore_drills.cleanup_status`.
--
-- SÓ PARA dev/CI. Em produção isto DESTRÓI EVIDÊNCIA de conformidade: a coluna
-- é o único lugar onde fica registrado que um drill deixou uma cópia completa
-- da produção no host. Depois deste down, um drill com resíduo volta a ser
-- indistinguível de um drill limpo — que é precisamente o defeito que a 112
-- fechou.
--
-- O `failure_code = 'cleanup_failed'` sobrevive ao rollback (é `text` livre), e
-- `probes->'cleanup'` também: quem precisar auditar depois de um down consegue
-- reconstruir o resíduo dali. O que se perde é o predicado indexado.

DROP INDEX IF EXISTS restore_drills_unsafe_idx;

ALTER TABLE restore_drills DROP CONSTRAINT IF EXISTS restore_drills_cleanup_status_chk;

ALTER TABLE restore_drills DROP COLUMN IF EXISTS cleanup_status;
