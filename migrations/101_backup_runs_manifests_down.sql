-- 101 down — remove as tabelas de evidência de backup/restore.
--
-- ATENÇÃO (issue #520, seção Rollback: "migrations `_down` não podem destruir
-- evidência necessária para recovery/compliance sem export aprovado"):
--
--   * `backup_manifests` é a ÚNICA cópia do documento assinado que prova qual
--     commit/schema/checksum cada artefato representa. Sem ele, um artefato
--     off-site vira um blob que ninguém consegue validar antes de restaurar.
--   * `backup_runs` é a base do cálculo de RPO e da resposta a "qual foi o
--     último backup íntegro e off-site".
--   * `restore_drills` é a evidência de RTO medido.
--
-- Em produção, o rollback CORRETO é desligar os novos jobs por feature flag
-- (BACKUP_ENABLED / o worker) e MANTER estas tabelas legíveis. Rode este down
-- apenas em dev/CI, ou depois de um export aprovado dos manifestos.

DROP TABLE IF EXISTS restore_drills;
DROP TABLE IF EXISTS backup_manifests;
DROP TABLE IF EXISTS backup_runs;
