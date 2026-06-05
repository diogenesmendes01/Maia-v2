-- =====================================================================
-- Maia — Migration 074 (issue #407)
-- Per-agent AudienceContext: relax the global phone-unique on `pessoas`
-- and introduce the governed `agent_audience_profiles` relation.
--
-- WHY (issue #407): the runtime must answer "who is this person FOR THIS
-- AGENT?", not just "who is this person globally?". `pessoas` is ALREADY
-- scoped by (tenant_id, agent_id), so the only thing physically blocking
-- the same phone from existing for two agents is the GLOBAL unique on
-- `pessoas.telefone_whatsapp` (migration 001). This migration:
--
--   1. Drops the global unique on telefone_whatsapp.
--   2. Adds a COMPOSITE unique (tenant_id, agent_id, telefone_whatsapp) —
--      the same phone may now be `customer` for Agent X and `employee`
--      for Agent Y, while still being unique within one (tenant, agent).
--   3. Creates `agent_audience_profiles` (1:1 with `pessoas` for now):
--      the per-agent relation that holds `audience_type` + `trust_level`
--      (governance-derived, invariant #3) instead of the quasi-global
--      `pessoas.tipo`.
--   4. Idempotently backfills one profile per existing pessoa, mapping the
--      legacy `pessoas.tipo` → (audience_type, trust_level).
--
-- BLAST RADIUS: low. No FK on `pessoas` changes; `pessoas.tipo` stays for
-- back-compat (it is simply no longer the source of truth for audience
-- governance). `AudienceContext` is derived at runtime, NOT persisted.
--
-- Tenant-isolation (invariant #1): the new table carries tenant_id +
-- agent_id NOT NULL and its UNIQUE is composite on (tenant_id, agent_id,
-- pessoa_id). See tests/integration/leak.spec.ts + repos-leak.spec.ts.
--
-- NOTE: no BEGIN/COMMIT wrappers — scripts/migrate.ts wraps each forward
-- migration in a transaction (no `-- maia:no-transaction` marker here).
-- =====================================================================

-- 1+2. Relax the global phone-unique → composite (tenant, agent, phone).
--      Migration 001 created the unique inline (`telefone_whatsapp TEXT NOT
--      NULL UNIQUE`), which Postgres auto-names `pessoas_telefone_whatsapp_key`.
--      Do NOT trust that name: a wrong name + `IF EXISTS` would SILENTLY leave
--      the global unique in place and defeat this migration. Instead find the
--      single-column UNIQUE on `telefone_whatsapp` by its column set (name-
--      independent) and drop it. Idempotent: a no-op once already relaxed.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.relname = 'pessoas'
    AND c.contype = 'u'
    AND c.conkey = ARRAY[(
      SELECT a.attnum FROM pg_attribute a
      WHERE a.attrelid = rel.oid
        AND a.attname = 'telefone_whatsapp'
        AND NOT a.attisdropped
    )]::smallint[];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pessoas DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE pessoas
  ADD CONSTRAINT pessoas_tenant_agent_telefone_key
  UNIQUE (tenant_id, agent_id, telefone_whatsapp);

-- 3. The per-agent audience relation. Governed: audience_type + trust_level
--    are derived (never LLM-declared). status mirrors the pessoa-status
--    vocabulary used by the resolver's fail-closed path.
CREATE TABLE IF NOT EXISTS agent_audience_profiles (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  agent_id               TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id),
  pessoa_id              UUID NOT NULL REFERENCES pessoas(id) ON DELETE CASCADE,
  audience_type          TEXT NOT NULL DEFAULT 'unknown'
    CHECK (audience_type IN (
      'owner','manager','employee','accountant',
      'customer','vendor','lead','system_user','unknown'
    )),
  trust_level            TEXT NOT NULL DEFAULT 'unverified'
    CHECK (trust_level IN (
      'trusted_internal','known_external','unverified','unknown','blocked'
    )),
  status                 TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','quarantined','blocked')),
  permission_profile_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  labels                 TEXT[] NOT NULL DEFAULT '{}'::text[],
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Tenant-scoped uniqueness (invariant #1) + lookup parity.
  CONSTRAINT agent_audience_profiles_tenant_agent_pessoa_key
    UNIQUE (tenant_id, agent_id, pessoa_id),
  -- Hard 1:1 with pessoas: a pessoa (already scoped to one tenant+agent) gets
  -- at most one audience profile. Stronger than the composite above, which
  -- alone would let the same pessoa_id pair with a different (tenant, agent).
  CONSTRAINT agent_audience_profiles_pessoa_key UNIQUE (pessoa_id)
);

-- Lookup index for the runtime resolver hot path: given a pessoa row
-- (already scoped to tenant+agent), fetch its active audience profile.
CREATE INDEX IF NOT EXISTS agent_audience_profiles_tenant_agent_pessoa_idx
  ON agent_audience_profiles (tenant_id, agent_id, pessoa_id);

-- updated_at trigger — mirrors the per-table triggers in migration 001.
CREATE TRIGGER set_updated_at_agent_audience_profiles
  BEFORE UPDATE ON agent_audience_profiles
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- 4. Idempotent backfill: one profile per existing pessoa.
--    `pessoas.tipo` (legacy quasi-global role) → (audience_type, trust_level).
--    ON CONFLICT DO NOTHING makes re-runs safe (the composite unique is the
--    conflict target). Only inserts; never overwrites an operator-edited
--    profile. status carries over the pessoa lifecycle so a blocked/inactive
--    pessoa does not silently gain an `active` audience profile.
INSERT INTO agent_audience_profiles
  (tenant_id, agent_id, pessoa_id, audience_type, trust_level, status)
SELECT
  p.tenant_id,
  p.agent_id,
  p.id,
  CASE p.tipo
    WHEN 'dono'         THEN 'owner'
    WHEN 'co_dono'      THEN 'owner'
    WHEN 'socio'        THEN 'manager'
    WHEN 'contador'     THEN 'accountant'
    WHEN 'funcionario'  THEN 'employee'
    WHEN 'fornecedor'   THEN 'vendor'
    WHEN 'cliente'      THEN 'customer'
    ELSE 'unknown'                          -- 'outro' / NULL / any future tipo
  END AS audience_type,
  CASE p.tipo
    WHEN 'dono'         THEN 'trusted_internal'
    WHEN 'co_dono'      THEN 'trusted_internal'
    WHEN 'socio'        THEN 'trusted_internal'
    WHEN 'contador'     THEN 'trusted_internal'
    WHEN 'funcionario'  THEN 'trusted_internal'
    WHEN 'fornecedor'   THEN 'known_external'
    WHEN 'cliente'      THEN 'known_external'
    ELSE 'unverified'                       -- 'outro' / NULL / any future tipo
  END AS trust_level,
  CASE p.status
    WHEN 'ativa'        THEN 'active'
    WHEN 'inativa'      THEN 'inactive'
    WHEN 'quarentena'   THEN 'quarantined'
    WHEN 'bloqueada'    THEN 'blocked'
    ELSE 'active'
  END AS status
FROM pessoas p
ON CONFLICT ON CONSTRAINT agent_audience_profiles_pessoa_key
  DO NOTHING;
