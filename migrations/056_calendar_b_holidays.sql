-- Calendar v2 — Migration B: holidays table.
-- tenant_id NOT NULL invariant (P0): toda query DEVE filtrar por tenant.
-- type ∈ {national, state, municipal, entity_custom, holding_recess}.
-- status ∈ {ativo, rejeitado, pending} (pending exige proposal_id).
-- year NULL = recorre anualmente; year = ano específico (ex.: feriado pontual).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE holidays (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT       NOT NULL REFERENCES tenants(id),
  name         TEXT       NOT NULL,
  month        SMALLINT   NOT NULL CHECK (month BETWEEN 1 AND 12),
  day          SMALLINT   NOT NULL CHECK (day BETWEEN 1 AND 31),
  year         INTEGER,   -- NULL = recorrente anual
  type         TEXT       NOT NULL CHECK (
    type IN ('national', 'state', 'municipal', 'entity_custom', 'holding_recess')
  ),
  uf           VARCHAR(2),
  cidade       TEXT,
  proposal_id  UUID,      -- referência a capability_proposals quando vindo via pipeline
  approved_by  TEXT,
  approved_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'ativo' CHECK (
    status IN ('ativo', 'rejeitado', 'pending')
  ),
  source       TEXT,      -- 'seed' | 'owner' | 'pipeline' (auditoria leve)
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- regional_consistency: state precisa uf; municipal precisa uf + cidade.
  CONSTRAINT regional_consistency CHECK (
    (type = 'national'      AND uf IS NULL     AND cidade IS NULL)
    OR (type = 'state'      AND uf IS NOT NULL AND cidade IS NULL)
    OR (type = 'municipal'  AND uf IS NOT NULL AND cidade IS NOT NULL)
    OR (type IN ('entity_custom', 'holding_recess'))
  ),
  -- pending_must_have_proposal: status='pending' precisa proposal_id.
  CONSTRAINT pending_must_have_proposal CHECK (
    status <> 'pending' OR proposal_id IS NOT NULL
  )
);

CREATE INDEX idx_holidays_tenant_date     ON holidays(tenant_id, month, day);
CREATE INDEX idx_holidays_tenant_regional ON holidays(tenant_id, type, uf, cidade);
CREATE INDEX idx_holidays_pending         ON holidays(tenant_id, status) WHERE status = 'pending';

-- trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION trg_set_holidays_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_holidays_timestamp
  BEFORE UPDATE ON holidays
  FOR EACH ROW EXECUTE FUNCTION trg_set_holidays_timestamp();
