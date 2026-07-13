-- 093 — Escopo tenant/agent/source em proposal_approvals (spec
-- 2026-07-09-profile-inbox-source Draft v4 §1.6).
--
-- A unicidade era GLOBAL: (proposal_id, approver_user_id, decision) — sem
-- tenant/agent/source (review v2 alto 3 + review v3 alta). Índices e
-- constraints não são dados: recriá-los respeita o espírito append-only
-- (nenhuma row é alterada; a semântica legada é preservada por partial
-- unique própria).
--
-- CHECK de pareamento NULL (review v4): em Postgres NULLs são distintos —
-- com agent_id nullable dentro da chave, rows com source preenchido e agent
-- ausente duplicariam indefinidamente. Ou ambos nulos (legado) ou ambos
-- preenchidos (novo).

ALTER TABLE proposal_approvals ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE proposal_approvals ADD COLUMN IF NOT EXISTS proposal_source text;

-- Vocabulário FECHADO (review v3): a registry TS é a fonte; este CHECK
-- acompanha cada source novo em migração própria.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_approvals_source_chk'
  ) THEN
    ALTER TABLE proposal_approvals
      ADD CONSTRAINT proposal_approvals_source_chk
      CHECK (proposal_source IS NULL OR proposal_source IN
        ('policy_rule','soul_bias','skill','capability_proposal',
         'knowledge_proposal','operational_profile'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proposal_approvals_scope_pair_chk'
  ) THEN
    ALTER TABLE proposal_approvals
      ADD CONSTRAINT proposal_approvals_scope_pair_chk
      CHECK ((agent_id IS NULL) = (proposal_source IS NULL));
  END IF;
END $$;

-- Backfill BEST-EFFORT (§1.6): onde o source permite derivar o par completo.
-- Hoje o único source com rows de approval em produção é capability_proposals
-- (tem agent_id); o join deriva o par (agent_id, source) respeitando o CHECK
-- de pareamento. O que não casar permanece NULL como legado somente-leitura —
-- nenhum predicate novo depende dessas rows (risco aceito na spec §5).
UPDATE proposal_approvals pa
   SET agent_id = cp.agent_id,
       proposal_source = 'capability_proposal'
  FROM capability_proposals cp
 WHERE pa.proposal_id = cp.id
   AND pa.tenant_id = cp.tenant_id
   AND pa.agent_id IS NULL
   AND pa.proposal_source IS NULL;

-- Substituição da unicidade global pelas parciais escopadas.
ALTER TABLE proposal_approvals
  DROP CONSTRAINT IF EXISTS proposal_approvals_proposal_user_decision_uq;

-- Rows NOVAS (escopo completo): unicidade por tenant+agent+source+proposal+
-- approver+decision, válida apenas quando o escopo é completo (o CHECK acima
-- garante o pareamento; o WHERE garante que NULLs nunca entram na chave).
CREATE UNIQUE INDEX IF NOT EXISTS proposal_approvals_scoped_uq
  ON proposal_approvals
     (tenant_id, agent_id, proposal_source, proposal_id, approver_user_id, decision)
  WHERE agent_id IS NOT NULL AND proposal_source IS NOT NULL;

-- Rows LEGADAS (source NULL): preserva a semântica antiga apenas para elas.
CREATE UNIQUE INDEX IF NOT EXISTS proposal_approvals_legacy_uq
  ON proposal_approvals (proposal_id, approver_user_id, decision)
  WHERE proposal_source IS NULL;

-- Leitura composta (predicates novos incluem tenant sempre; agent/source
-- quando o chamador os conhece).
CREATE INDEX IF NOT EXISTS proposal_approvals_scope_read_idx
  ON proposal_approvals (tenant_id, proposal_source, proposal_id);
