-- 102 down — remove as tabelas de ciclo de vida de dados.
--
-- ATENÇÃO (issue #520, seção Rollback: "manter tombstones e legal holds";
-- "migrations `_down` não podem destruir evidência necessária para
-- recovery/compliance sem export aprovado"):
--
--   * `data_tombstones` é a ÚNICA barreira contra ressurreição de dado
--     excluído após um restore. Derrubar esta tabela e depois restaurar um
--     snapshot antigo REVIVE dados pessoais que um titular mandou apagar —
--     um incidente de privacidade, não um rollback.
--   * `legal_holds` ativo bloqueia purge. Sem a tabela, um purge subsequente
--     apaga dado sob ordem judicial.
--   * `privacy_requests` é a evidência de atendimento de solicitações LGPD.
--   * `retention_runs` é a trilha das ações destrutivas já executadas.
--
-- O rollback CORRETO em produção é pausar os jobs (RETENTION_DRY_RUN=true e
-- desabilitar o executor) mantendo estas tabelas legíveis. Rode este down
-- apenas em dev/CI, ou após export aprovado pelo responsável jurídico/DPO.
--
-- A ordem respeita as FKs: tombstones referenciam privacy_requests.

DROP TABLE IF EXISTS retention_runs;
DROP TABLE IF EXISTS data_tombstones;
DROP TABLE IF EXISTS privacy_requests;
DROP TABLE IF EXISTS legal_holds;
