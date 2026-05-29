-- Reverse of 062: recreate `dashboard_sessions` for rollback.
--
-- The shape mirrors migration 002 (original create) + the columns added by
-- migrations 009/010/012 (tenant/agent backfill + NOT NULL). After rollback
-- the table is present and empty — sessions from before the drop are NOT
-- restored (a magic-link token can't be unhashed; the security model relied
-- on losing the token on logout/expiry anyway).
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  agent_id      TEXT NOT NULL DEFAULT 'default',
  pessoa_id     UUID NOT NULL,
  token_hash    TEXT NOT NULL,
  expira_em     TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at       TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dashboard_sessions_token_hash_idx
  ON dashboard_sessions (token_hash);
CREATE INDEX IF NOT EXISTS dashboard_sessions_pessoa_id_idx
  ON dashboard_sessions (pessoa_id);
