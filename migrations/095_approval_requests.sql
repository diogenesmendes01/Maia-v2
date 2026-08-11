-- 095 — Evidência backend imutável de aprovação (auditoria P0 Fase 0, cap. 2).
--
-- Substitui o rastro anterior de 4-eyes que vivia em `workflows.contexto`
-- (JSON mutado em memória, sem persistência das assinaturas, sem hash do
-- payload, sem consumo único). A partir daqui a fonte de verdade de uma
-- aprovação humana é este par de tabelas:
--
--   approval_requests  — o intent IMUTÁVEL (payload + hash canônico versionado),
--                        classe de aprovação, contagem exigida, expiração e a
--                        máquina de estados com consumo one-time:
--                          pending → approved | denied | expired
--                          approved → claimed → consumed | execution_failed
--   approval_decisions — cada decisão humana individual (aprovador, decisão,
--                        canal, snapshot do papel), única por (request, principal).
--
-- Invariantes:
--   * o LLM nunca cria/assina/consome evidência — apenas o backend;
--   * transições sempre por conditional UPDATE (CAS) — nunca mutação de JSON;
--   * no máximo UM request aberto por fingerprint (partial unique);
--   * payload aprovado é imutável — o consume revalida o hash;
--   * expiração obrigatória (expires_at NOT NULL).

CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  requester_pessoa_id uuid NOT NULL,
  entidade_id uuid,
  conversa_id uuid,
  mensagem_id uuid,
  request_id text,
  tool text NOT NULL,
  operation_type text NOT NULL,
  intent_payload jsonb NOT NULL,
  intent_hash text NOT NULL,
  intent_hash_version integer NOT NULL DEFAULT 1,
  approval_class text NOT NULL
    CHECK (approval_class IN ('single_confirmation', 'requester_plus_one_owner', 'two_distinct_owners')),
  required_approvals integer NOT NULL CHECK (required_approvals >= 1),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'claimed', 'consumed', 'execution_failed')),
  fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  denied_at timestamptz,
  claimed_at timestamptz,
  consumed_at timestamptz,
  claim_token text,
  result_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Classe dual exige >= 2 aprovações; single_confirmation exige exatamente 1.
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_class_count_chk
  CHECK (
    (approval_class = 'single_confirmation' AND required_approvals = 1)
    OR (approval_class <> 'single_confirmation' AND required_approvals >= 2)
  );

-- Estados terminais/claim carregam seus timestamps (fail-loud em drift).
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_claim_token_chk
  CHECK (status NOT IN ('claimed', 'consumed') OR claim_token IS NOT NULL);

-- Índices tenant/agent-first (invariante de isolamento).
CREATE INDEX IF NOT EXISTS approval_requests_scope_status_idx
  ON approval_requests (tenant_id, agent_id, status, expires_at);

-- No máximo um request ABERTO por fingerprint do intent.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_open_fingerprint_uq
  ON approval_requests (tenant_id, agent_id, fingerprint)
  WHERE status IN ('pending', 'approved', 'claimed');

CREATE TABLE IF NOT EXISTS approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  request_id uuid NOT NULL REFERENCES approval_requests (id),
  principal_pessoa_id uuid NOT NULL,
  -- Snapshot do papel no momento da decisão (auditável mesmo se o papel mudar).
  principal_tipo text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'deny')),
  channel text NOT NULL DEFAULT 'whatsapp',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Mesma pessoa não conta duas vezes (nem por dois canais).
  CONSTRAINT approval_decisions_request_principal_uq UNIQUE (request_id, principal_pessoa_id)
);

CREATE INDEX IF NOT EXISTS approval_decisions_scope_idx
  ON approval_decisions (tenant_id, agent_id, request_id);
