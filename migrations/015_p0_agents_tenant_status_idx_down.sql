-- Reverte migration 015: drop do índice composto (tenant_id, status).
DROP INDEX IF EXISTS agents_tenant_status_idx;
