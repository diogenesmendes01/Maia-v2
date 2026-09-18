-- 144 — o LEDGER do gateway de inferência Hermes: grants, contas, tentativas e
-- eventos de uso (spec Maia+Hermes §9.1 e §9.2).
--
-- ─── O que estas tabelas existem para impedir ──────────────────────────────
--
-- O filho Hermes só fala com o mundo por UMA rota HTTP da Maia, e cada chamada
-- a essa rota custa dinheiro de um cliente. Sem registro durável, três coisas
-- ficam impossíveis de afirmar: que a chamada foi autorizada por um run vivo,
-- que o orçamento foi reservado ANTES de o provider ser chamado, e quanto ela
-- custou — inclusive quando ninguém sabe (timeout depois do envio).
--
-- * `engine_inference_grants`: a credencial curta do run, guardada só pela
--   HASH. O texto do token nunca toca o banco (§9.2 "nunca texto do token").
--   Revogação é monotônica e o resto do grant é imutável.
-- * `engine_budget_accounts`: a conta por (tenant, agente, dia UTC, moeda),
--   com limite, reservado e liquidado em microusd inteiros. É a trava da
--   admissão; o budget legado da Maia (Redis, fail-open) não é herdado.
-- * `engine_inference_attempts`: uma linha por request HTTP que passou pela
--   admissão, com o que foi reservado e o que foi liquidado. `reserved` é o
--   intento persistido ANTES do provider; uma linha que ficou em `reserved`
--   depois de um crash é exposição, não custo zero.
-- * `engine_usage_events`: eventos idempotentes de custo. Append-only: nova
--   evidência entra como evento compensatório, nunca sobrescreve a cobrança.
--
-- ─── Por que o PERÍODO é o dia UTC ─────────────────────────────────────────
--
-- É a mesma janela do budget diário que a Maia já opera (`LLM_DAILY_BUDGET_USD`)
-- e do ledger `cost.daily.llm`. Uma conta por dia torna a admissão uma trava de
-- linha curta e o fechamento do dia um fato, não uma soma móvel.
--
-- ─── O que NÃO está aqui ───────────────────────────────────────────────────
--
-- * Conta agregada por TENANT (§9.2 "se o plano comercial exigir"): o primeiro
--   contrato limita por agente, e dizer que existe teto da empresa sem a
--   decisão de produto seria prometer o que não se implementou.
-- * Projeção para `readDailyLLMUsd`/painéis: a spec proíbe somar duas
--   projeções do mesmo request, e a escolha de qual é decisão própria.
-- * Nada aqui referencia a 142/143: esta migration pode aplicar antes delas.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CONTA DE ORÇAMENTO (§9.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_budget_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  period_start_utc date NOT NULL,
  -- Unidade EXPLÍCITA: dinheiro nunca em float (§4.2).
  currency text NOT NULL CHECK (currency = 'microusd'),
  limit_microusd bigint NOT NULL CHECK (limit_microusd >= 0),
  -- Exposição reservada e ainda não liquidada (inclui o desconhecido).
  reserved_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  settled_microusd bigint NOT NULL DEFAULT 0 CHECK (settled_microusd >= 0),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_budget_accounts_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_budget_accounts_scope_id_uq UNIQUE (tenant_id, agent_id, id),
  CONSTRAINT engine_budget_accounts_period_uq UNIQUE (tenant_id, agent_id, period_start_utc, currency)
);

COMMENT ON TABLE engine_budget_accounts IS
  'spec maia-hermes 9.2: conta de orcamento do gateway de inferencia por agente e dia UTC, em microusd inteiros. Trava da admissao; o budget legado (Redis, fail-open) nao e herdado.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. GRANT DE INFERÊNCIA (§9.1 "Autenticação")
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_inference_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  -- sha256 hex do token. O texto do token não existe no banco.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 128),
  -- Modelo EXATAMENTE aprovado (§9.1 validação 2).
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  -- Copiados do run na emissão: o grant vale para aquele epoch e manifest.
  control_epoch bigint NOT NULL CHECK (control_epoch >= 0),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  -- nome da tool -> digest canônico do input_schema (§9.1 validação 4: nomes
  -- E schemas). Objeto vazio = nenhuma tool.
  tool_surface jsonb NOT NULL CHECK (
    jsonb_typeof(tool_surface) = 'object' AND octet_length(tool_surface::text) <= 65536),
  max_inference_calls integer NOT NULL CHECK (max_inference_calls >= 0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_inference_grants_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_inference_grants_scope_id_uq UNIQUE (tenant_id, agent_id, id),
  -- GLOBAL de propósito: a credencial é resolvida antes de haver tenant.
  CONSTRAINT engine_inference_grants_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT engine_inference_grants_run_fk FOREIGN KEY (tenant_id, agent_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_inference_grants_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT engine_inference_grants_revoke_chk CHECK (
    (revoked_at IS NULL) = (revoke_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS engine_inference_grants_run_idx
  ON engine_inference_grants (tenant_id, agent_id, run_id);

COMMENT ON TABLE engine_inference_grants IS
  'spec maia-hermes 9.1: credencial curta de inferencia de UM run, guardada so pela hash (sha256). Revogacao monotonica; o resto e imutavel. Resolver pela hash acontece antes de haver tenant, por isso o unique global.';

-- O grant é uma autorização emitida: nada nele muda depois, exceto a revogação,
-- e a revogação só anda num sentido.
CREATE OR REPLACE FUNCTION engine_inference_grants_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'engine_inference_grants nao aceita DELETE (spec 9.1)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.control_epoch IS DISTINCT FROM OLD.control_epoch
     OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
     OR NEW.tool_surface IS DISTINCT FROM OLD.tool_surface
     OR NEW.max_inference_calls IS DISTINCT FROM OLD.max_inference_calls
     OR NEW.max_output_tokens IS DISTINCT FROM OLD.max_output_tokens
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'engine_inference_grants e imutavel exceto a revogacao (spec 9.1)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
          OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'revogacao de engine_inference_grants e monotonica (spec 9.1)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_inference_grants_guard_trg
  BEFORE UPDATE OR DELETE ON engine_inference_grants
  FOR EACH ROW EXECUTE FUNCTION engine_inference_grants_guard();

-- ════════════════════════════════════════════════════════════════════════════
-- 3. TENTATIVA DE INFERÊNCIA (§9.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_inference_attempts (
  -- O request UUID gerado pelo gateway.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  -- Contador sequencial por run. Retries do cliente são tentativas novas.
  attempt_seq integer NOT NULL CHECK (attempt_seq > 0),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- reserved = intento persistido antes do provider; not_sent = comprovadamente
  -- não saiu; completed = resposta recebida; failed_after_send = pode ter custado.
  state text NOT NULL CHECK (state IN ('reserved', 'not_sent', 'completed', 'failed_after_send')),
  accounting_status text NOT NULL CHECK (
    accounting_status IN ('reserved', 'estimated', 'settled', 'unknown')),
  -- NULL = admitido sem preço (policy admit_unpriced); nunca zero fabricado.
  reserved_microusd bigint CHECK (reserved_microusd IS NULL OR reserved_microusd >= 0),
  settled_microusd bigint CHECK (settled_microusd IS NULL OR settled_microusd >= 0),
  tariff_version text CHECK (tariff_version IS NULL OR length(tariff_version) BETWEEN 1 AND 128),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT engine_inference_attempts_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_inference_attempts_scope_id_uq UNIQUE (tenant_id, agent_id, id),
  CONSTRAINT engine_inference_attempts_seq_uq UNIQUE (tenant_id, agent_id, run_id, attempt_seq),
  CONSTRAINT engine_inference_attempts_run_fk FOREIGN KEY (tenant_id, agent_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_inference_attempts_grant_fk FOREIGN KEY (tenant_id, agent_id, grant_id)
    REFERENCES engine_inference_grants (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_inference_attempts_account_fk FOREIGN KEY (tenant_id, agent_id, account_id)
    REFERENCES engine_budget_accounts (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_inference_attempts_finished_chk CHECK (
    (state = 'reserved') = (finished_at IS NULL)),
  -- Liquidado exige valor; desconhecido não pode fingir valor.
  CONSTRAINT engine_inference_attempts_settled_chk CHECK (
    accounting_status <> 'settled' OR settled_microusd IS NOT NULL),
  CONSTRAINT engine_inference_attempts_unknown_chk CHECK (
    accounting_status <> 'unknown' OR settled_microusd IS NULL)
);

-- Tentativas ainda sem desfecho, para a reconciliação.
CREATE INDEX IF NOT EXISTS engine_inference_attempts_open_idx
  ON engine_inference_attempts (tenant_id, agent_id, started_at, id)
  WHERE state = 'reserved' OR accounting_status = 'unknown';

COMMENT ON TABLE engine_inference_attempts IS
  'spec maia-hermes 9.2: uma linha por request que passou pela admissao do gateway. reserved e o intento persistido antes do provider; linha presa em reserved depois de crash e exposicao, nao custo zero.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. EVENTOS DE USO (§9.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  -- Dedupe: o mesmo fato registrado duas vezes é o mesmo evento.
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('reported', 'estimated', 'reconciled', 'adjustment')),
  source text NOT NULL CHECK (
    source IN ('provider_accounted', 'engine_reported', 'gateway_estimated', 'unavailable')),
  -- NULL = custo desconhecido. `cost=null` não é zero (§9.2).
  delta_microusd bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_usage_events_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_usage_events_key_uq UNIQUE (tenant_id, agent_id, event_key),
  CONSTRAINT engine_usage_events_run_fk FOREIGN KEY (tenant_id, agent_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_usage_events_attempt_fk FOREIGN KEY (tenant_id, agent_id, attempt_id)
    REFERENCES engine_inference_attempts (tenant_id, agent_id, id) ON DELETE RESTRICT,
  -- Só o ajuste compensatório pode ser negativo.
  CONSTRAINT engine_usage_events_delta_chk CHECK (
    kind = 'adjustment' OR delta_microusd IS NULL OR delta_microusd >= 0)
);

CREATE INDEX IF NOT EXISTS engine_usage_events_attempt_idx
  ON engine_usage_events (tenant_id, agent_id, attempt_id);

COMMENT ON TABLE engine_usage_events IS
  'spec maia-hermes 9.2: eventos idempotentes de custo. Append-only: nova evidencia entra como evento compensatorio, nunca sobrescreve a cobranca original. delta NULL e custo desconhecido.';

CREATE OR REPLACE FUNCTION engine_usage_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'engine_usage_events e append-only (spec 9.2)'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_usage_events_append_only_trg
  BEFORE UPDATE OR DELETE ON engine_usage_events
  FOR EACH ROW EXECUTE FUNCTION engine_usage_events_append_only();

COMMIT;
