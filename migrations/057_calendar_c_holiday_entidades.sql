-- Calendar v2 — Migration C: junction holiday_entidades (custom holidays linked
-- to specific entidades, e.g. holding recess for entidade X).
-- tenant_id explícito (denormalização proposital para o tenant_guard runtime).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE holiday_entidades (
  tenant_id    TEXT   NOT NULL REFERENCES tenants(id),
  holiday_id   BIGINT NOT NULL REFERENCES holidays(id) ON DELETE CASCADE,
  entidade_id  UUID   NOT NULL REFERENCES entidades(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (holiday_id, entidade_id)
);

CREATE INDEX idx_holiday_entidades_tenant_entidade
  ON holiday_entidades(tenant_id, entidade_id);
