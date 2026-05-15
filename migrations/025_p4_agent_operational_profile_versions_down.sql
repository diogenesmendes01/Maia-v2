-- Down de 025: drop integral. v3.1.1 substituiu schema antigo (4 colunas) por 1 (profile_body).
-- Como nada está em prod, não há migração de dados a reverter.

DROP INDEX IF EXISTS agent_op_profile_unique_active_idx;
DROP INDEX IF EXISTS agent_op_profile_tenant_agent_status_idx;
DROP TABLE IF EXISTS agent_operational_profile_versions;
