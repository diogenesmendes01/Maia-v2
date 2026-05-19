-- Calendar v2 — Migration E: UNIQUE index para idempotência do seed.
-- COALESCE necessário porque NULL ≠ NULL em UNIQUE PostgreSQL.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE UNIQUE INDEX IF NOT EXISTS holidays_unique_idem
  ON holidays(
    tenant_id,
    COALESCE(year, 0),
    month, day, name, type,
    COALESCE(uf, ''),
    COALESCE(cidade, '')
  );
