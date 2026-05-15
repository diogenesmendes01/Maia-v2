-- P0 follow-up (PR #75 review, Superpowers finding #15):
-- Adiciona índice composto (tenant_id, status) em agents.
--
-- Motivação: queries como "lista agents ativos de um tenant" são padrão
-- comum nos workers de P1+. O índice atual `agents_tenant_id_idx` ajuda no
-- filtro por tenant, mas a Postgres ainda precisa scanear status row-by-row.
-- O índice composto torna o lookup index-only.
--
-- Idempotente: IF NOT EXISTS permite re-run em ambiente onde alguém já
-- aplicou manualmente.

CREATE INDEX IF NOT EXISTS agents_tenant_status_idx ON agents(tenant_id, status);
