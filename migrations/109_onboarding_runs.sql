-- 109 — Saga DURÁVEL de onboarding: provisionar tenant + agente por um wizard
-- persistido e retomável (issue #519).
--
-- Por que uma saga persistida em vez de estado de sessão:
--   O provisionamento cruza dez decisões de governança (tenant, admin, agente,
--   profile, packs, papel, política, canal, pareamento, ativação). Entre elas
--   existe INTERAÇÃO HUMANA — o operador lê, aprova e escaneia QR code. Manter
--   uma transação SQL aberta durante isso é inaceitável, e manter o progresso
--   em memória perde tudo num restart de deploy. A saga é o meio-termo
--   sancionado pela issue: UMA transação SQL CURTA por comando, estado durável
--   entre comandos, e uma transição final de ativação atômica.
--
-- Três tabelas, três papéis distintos:
--   `onboarding_runs`         — o ESTADO corrente (a máquina de estados).
--   `onboarding_events`       — o HISTÓRICO append-only do workflow (reconstrução
--                               e diagnóstico). NÃO substitui `audit_log`: eventos
--                               sustentam operação, auditoria sustenta governança.
--   `onboarding_step_results` — o LEDGER de idempotência: o resultado persistido
--                               de cada comando, chaveado pela idempotency key.
--
-- Anti-duplo-provisionamento (duas defesas, deliberadamente separadas):
--   1. MESMA chave, retry  → o ledger devolve o resultado já persistido (replay).
--   2. Chave DIFERENTE     → a máquina de estados recusa: o passo só é legal a
--                            partir do seu estado de origem, e o commit anterior
--                            já avançou a run. Um double-click com duas chaves
--                            distintas serializa no `FOR UPDATE` da run e o
--                            segundo vê `invalid_transition`.
--   Por isso NÃO existe unique em (run_id, step): passos re-executáveis
--   (`evaluate_readiness`, retomada de pareamento) precisam poder rodar de novo,
--   e quem impede o provisionamento duplicado é o estado, não o ledger.
--
-- Fail-closed no SCHEMA (invariante 8 do AGENTS.md): o literal legado
-- `'default'` é REJEITADO por CHECK em todas as três tabelas. Uma run que
-- provisionasse silenciosamente para `'default'` é exatamente o bug que a
-- regra existe para prevenir, e o banco recusa antes do código.
--
-- Segredos: NADA sensível entra aqui. `metadata`/`summary` são sanitizados no
-- código (`src/onboarding/sanitize.ts`); QR code, código de pareamento, senha
-- de bootstrap e token de sessão nunca são persistidos nestas tabelas — o
-- material cifrado de pareamento vive em `channel_line_state` (migration 103).

CREATE TABLE IF NOT EXISTS onboarding_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- `global_bootstrap`  — instalação vazia: cria o primeiro tenant/admin. O
  --                       `tenant_id` é NULL até o passo que o resolve.
  -- `tenant_onboarding` — tenant seguinte: exige sessão administrativa e um
  --                       `tenant_id` desde o início.
  kind text NOT NULL,

  -- Escopo. NULL só é tolerado ENQUANTO o recurso ainda não existe; os CHECKs
  -- abaixo garantem que `tenant_onboarding` nunca nasce sem tenant e que um
  -- `agent_id` nunca aparece sem o tenant que o possui.
  tenant_id text,
  agent_id text,

  state text NOT NULL DEFAULT 'created',
  current_step text,

  -- Optimistic concurrency: todo comando informa a versão que leu; o UPDATE
  -- só casa com `version = $expected`. Dois operadores no mesmo passo ⇒ um
  -- avança, o outro recebe `version_conflict` (nunca dois avanços).
  version integer NOT NULL DEFAULT 1,

  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  -- Runs abandonadas precisam de política de expiração (critério de aceite da
  -- issue). A varredura marca `cancelled` com `last_error_code='expired'`; a
  -- run continua legível e diagnosticável, nunca apagada.
  expires_at timestamptz NOT NULL,

  -- Código de erro SANITIZADO (estável, sem mensagem livre, sem PII).
  last_error_code text,

  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Fingerprints do contrato: uma run iniciada sob outra versão de contrato de
  -- configuração / de schema não pode ser retomada às cegas.
  configuration_contract_version text NOT NULL,
  schema_version text NOT NULL,

  CONSTRAINT onboarding_runs_kind_ck
    CHECK (kind IN ('global_bootstrap', 'tenant_onboarding')),

  CONSTRAINT onboarding_runs_state_ck CHECK (state IN (
    'created',
    'tenant_ready',
    'admin_ready',
    'agent_draft',
    'profile_ready',
    'capabilities_ready',
    'policy_ready',
    'channel_declared',
    'pairing_pending',
    'channel_ready',
    'ready_for_activation',
    'activating',
    'active',
    'readiness_failed',
    'failed_retryable',
    'failed_terminal',
    'cancelled'
  )),

  CONSTRAINT onboarding_runs_version_ck CHECK (version >= 1),

  -- Invariante 8 (AGENTS.md §4): o sentinel legado `'default'` NUNCA é alvo de
  -- provisionamento. `IS DISTINCT FROM` para que NULL (ainda não resolvido)
  -- continue válido.
  CONSTRAINT onboarding_runs_no_default_literal_ck CHECK (
    tenant_id IS DISTINCT FROM 'default' AND agent_id IS DISTINCT FROM 'default'
  ),

  -- `'system'` é o bucket de manutenção GLOBAL (tenant-context.ts): é um
  -- destino inválido para provisionamento de um agente operacional.
  CONSTRAINT onboarding_runs_no_system_literal_ck CHECK (
    tenant_id IS DISTINCT FROM 'system' AND agent_id IS DISTINCT FROM 'system'
  ),

  CONSTRAINT onboarding_runs_tenant_scope_ck CHECK (
    kind <> 'tenant_onboarding' OR tenant_id IS NOT NULL
  ),

  CONSTRAINT onboarding_runs_agent_needs_tenant_ck CHECK (
    agent_id IS NULL OR tenant_id IS NOT NULL
  )
);

-- No máximo UMA run viva por (tenant, agent). Sem isto, dois operadores abrem
-- dois wizards para o mesmo agente e cada um provisiona metade da governança.
-- Estados terminais (`active`, `cancelled`, `failed_terminal`) saem do índice
-- para que um re-onboarding futuro seja possível.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_runs_one_live_per_agent_uq
  ON onboarding_runs (tenant_id, agent_id)
  WHERE agent_id IS NOT NULL
    AND state NOT IN ('active', 'cancelled', 'failed_terminal');

-- Listagem do console: "as runs do MEU tenant, mais recentes primeiro".
CREATE INDEX IF NOT EXISTS onboarding_runs_tenant_state_idx
  ON onboarding_runs (tenant_id, state, created_at DESC);

-- Varredura de expiração: só runs vivas interessam.
CREATE INDEX IF NOT EXISTS onboarding_runs_expiry_idx
  ON onboarding_runs (expires_at)
  WHERE state NOT IN ('active', 'cancelled', 'failed_terminal');

-- ── Histórico append-only do workflow ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE RESTRICT (e não CASCADE) é deliberado: a issue exige que o
  -- cancelamento/compensação NUNCA apague eventos. Apagar uma run passa a ser
  -- impossível enquanto houver histórico — que é o comportamento desejado.
  run_id uuid NOT NULL REFERENCES onboarding_runs(id) ON DELETE RESTRICT,

  tenant_id text,
  agent_id text,

  step text NOT NULL,
  event_type text NOT NULL,

  actor_id text NOT NULL,
  correlation_id text,
  -- HASH da idempotency key, nunca a chave em claro.
  idempotency_key_hash text,

  from_state text,
  to_state text,

  -- Resumo SANITIZADO. Sem segredo, sem telefone, sem e-mail, sem QR.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT onboarding_events_type_ck CHECK (event_type IN (
    'run_created',
    'step_completed',
    'step_replayed',
    'step_denied',
    'step_failed',
    'readiness_evaluated',
    'run_cancelled',
    'run_completed',
    'run_expired'
  )),

  CONSTRAINT onboarding_events_no_default_literal_ck CHECK (
    tenant_id IS DISTINCT FROM 'default' AND agent_id IS DISTINCT FROM 'default'
  )
);

CREATE INDEX IF NOT EXISTS onboarding_events_run_idx
  ON onboarding_events (run_id, created_at);

CREATE INDEX IF NOT EXISTS onboarding_events_tenant_idx
  ON onboarding_events (tenant_id, created_at DESC);

-- ── Ledger de idempotência ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_step_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES onboarding_runs(id) ON DELETE RESTRICT,
  tenant_id text,
  step text NOT NULL,

  -- SHA-256 da idempotency key opaca do cliente. A chave em claro nunca é
  -- persistida (ela é um segredo do cliente e identificaria a requisição).
  idempotency_key_hash text NOT NULL,
  -- SHA-256 canônico do payload. MESMA chave + payload DIVERGENTE ⇒ conflito
  -- (o cliente reciclou a chave para outra intenção).
  payload_hash text NOT NULL,

  -- Resultado materializado devolvido no replay. Sanitizado.
  result jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT onboarding_step_results_no_default_literal_ck CHECK (
    tenant_id IS DISTINCT FROM 'default'
  )
);

-- A chave de idempotência da issue §4: tenant + run + step + hash da chave.
-- `run_id` já determina o tenant, mas o tenant entra no índice como defesa em
-- profundidade (o mesmo padrão dos demais uniques tenant-scoped do schema).
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_step_results_key_uq
  ON onboarding_step_results (run_id, step, idempotency_key_hash);

CREATE INDEX IF NOT EXISTS onboarding_step_results_run_idx
  ON onboarding_step_results (run_id, created_at);
