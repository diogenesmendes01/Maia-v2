-- 113 — saga DURÁVEL de onboarding (issue #519).
--
-- Por que uma saga persistida em vez de uma transação:
--   O provisionamento atravessa leitura de instruções, aprovação humana de
--   perfil e leitura de QR code em outro aparelho. Manter uma transação SQL
--   aberta durante isso trava linhas por minutos e morre no primeiro timeout de
--   proxy. "Transacional" aqui significa o que a issue define: uma SAGA com
--   transação SQL CURTA por comando e uma transição FINAL de ativação atômica.
--
-- Três tabelas, três contratos distintos:
--
--   1. `onboarding_runs` — o estado corrente. UMA row por jornada, com
--      `version` para concorrência otimista (dois operadores não avançam a
--      mesma versão) e `state`/`current_step` como a única fonte de verdade do
--      que já aconteceu. A UI não decide nada: ela lê daqui.
--
--   2. `onboarding_events` — APPEND-ONLY. Reconstrói o workflow ("o que essa
--      run fez, em que ordem, por quem"). NÃO substitui `admin_audit_log`, que
--      continua sendo a trilha de GOVERNANÇA: os eventos servem à operação, a
--      auditoria serve à prestação de contas, e as duas caem no MESMO commit.
--
--   3. `onboarding_step_results` — o LEDGER de idempotência. A chave da issue
--      §4 é `tenant_id + onboarding_run_id + step + idempotency_key_hash`;
--      `run_id` já é único globalmente, então o índice carrega o triplete
--      (run, step, hash) e o `tenant_id` fica como coluna de escopo/forense.
--
-- Segredo NUNCA entra aqui: `idempotency_key_hash` é SHA-256 da chave opaca,
-- `request_hash` é SHA-256 do payload canônico. Nem a chave nem o payload cru
-- são persistidos — o ledger só precisa saber "é o mesmo pedido?".

CREATE TABLE IF NOT EXISTS onboarding_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  kind text NOT NULL,

  -- Tenant ALVO. Anulável APENAS enquanto a run ainda não criou/vinculou o
  -- tenant (estado `created`); a CHECK abaixo fecha a janela.
  tenant_id text,
  -- Agente ALVO. Anulável até o passo `agent`.
  agent_id text,

  -- Tenant da SESSÃO que abriu a run. É por ele que a listagem filtra: um
  -- operador enxerga as runs abertas no PRÓPRIO tenant, inclusive a que ainda
  -- não tem `tenant_id` alvo resolvido. Sem esta coluna, uma run de bootstrap
  -- (tenant alvo nulo) seria invisível ou visível para todos — as duas
  -- respostas erradas.
  actor_tenant_id text NOT NULL,

  state text NOT NULL DEFAULT 'created',
  current_step text NOT NULL DEFAULT 'tenant',
  -- Concorrência OTIMISTA. Todo comando declara a versão que leu; o UPDATE só
  -- vence se ela ainda for a corrente. Dois operadores clicando ao mesmo tempo:
  -- um avança, o outro recebe conflito tipado e recarrega.
  version integer NOT NULL DEFAULT 0,

  created_by text NOT NULL,
  created_by_role text NOT NULL,
  correlation_id text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  -- Runs abandonadas têm política de expiração (critério de aceite): a row
  -- sobrevive para diagnóstico, mas para de aceitar comandos.
  expires_at timestamptz NOT NULL,

  -- Código SANITIZADO. Nunca mensagem crua de erro, nunca stack, nunca payload.
  last_error_code text,

  -- Metadata TIPADA e sem segredo: rótulos operacionais que a UI mostra
  -- (nome do tenant, arquétipo escolhido, external_id da linha declarada).
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Fingerprints do contrato de configuração (#515) e do schema (#516) no
  -- momento em que a run nasceu. Uma run aberta antes de um deploy que mudou o
  -- contrato é diagnosticável sem adivinhação.
  configuration_contract_version text NOT NULL,
  schema_version text NOT NULL,

  CONSTRAINT onboarding_runs_kind_chk CHECK (
    kind IN ('global_bootstrap', 'tenant_onboarding')
  ),
  CONSTRAINT onboarding_runs_state_chk CHECK (state IN (
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
  CONSTRAINT onboarding_runs_step_chk CHECK (current_step IN (
    'tenant',
    'admin',
    'agent',
    'profile',
    'capabilities',
    'role',
    'channel',
    'pairing',
    'readiness',
    'activation',
    'done'
  )),
  -- Escopo fail-closed: sair de `created` exige o tenant alvo resolvido.
  CONSTRAINT onboarding_runs_tenant_resolved_chk CHECK (
    state = 'created' OR state = 'cancelled' OR tenant_id IS NOT NULL
  ),
  -- Idem para o agente: todo estado a partir de `agent_draft` é escopado por
  -- (tenant_id, agent_id) — o invariante 1 do AGENTS.md aplicado à própria saga.
  CONSTRAINT onboarding_runs_agent_resolved_chk CHECK (
    state NOT IN (
      'agent_draft',
      'profile_ready',
      'capabilities_ready',
      'policy_ready',
      'channel_declared',
      'pairing_pending',
      'channel_ready',
      'ready_for_activation',
      'activating',
      'active'
    )
    OR agent_id IS NOT NULL
  ),
  CONSTRAINT onboarding_runs_terminal_stamp_chk CHECK (
    (state <> 'active' OR completed_at IS NOT NULL)
    AND (state <> 'cancelled' OR cancelled_at IS NOT NULL)
  )
);

-- Listagem/retomada do operador: sempre pelo tenant da SESSÃO primeiro.
CREATE INDEX IF NOT EXISTS onboarding_runs_actor_scope_idx
  ON onboarding_runs (actor_tenant_id, state, created_at DESC);

-- Consulta por escopo alvo (dashboard/doctor perguntam "esta dupla tem run?").
CREATE INDEX IF NOT EXISTS onboarding_runs_target_scope_idx
  ON onboarding_runs (tenant_id, agent_id, created_at DESC);

-- Sweep de expiração.
CREATE INDEX IF NOT EXISTS onboarding_runs_expiry_idx
  ON onboarding_runs (expires_at)
  WHERE state NOT IN ('active', 'cancelled', 'failed_terminal');

-- No máximo UMA run viva por (tenant, agente). Sem isto, dois operadores
-- abrindo o wizard para o mesmo agente criam duas sagas que se atropelam —
-- cada uma achando que é a dona do provisionamento.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_runs_active_scope_uq
  ON onboarding_runs (tenant_id, agent_id)
  WHERE tenant_id IS NOT NULL
    AND agent_id IS NOT NULL
    AND state NOT IN ('active', 'cancelled', 'failed_terminal');

-- No máximo UM bootstrap global vivo ao mesmo tempo (critério de aceite:
-- "corridas simultâneas criam no máximo um bootstrap válido"). A expressão é
-- constante DENTRO do predicado parcial, então o índice admite exatamente uma
-- row viva do tipo.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_runs_single_live_bootstrap_uq
  ON onboarding_runs ((kind))
  WHERE kind = 'global_bootstrap'
    AND state NOT IN ('active', 'cancelled', 'failed_terminal');

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS onboarding_events (
  id bigserial PRIMARY KEY,
  -- RESTRICT, não CASCADE: a run nunca é apagada, e se alguém tentar, os
  -- eventos seguram. "Preservar auditoria e eventos" é critério de aceite do
  -- cancelamento.
  run_id uuid NOT NULL REFERENCES onboarding_runs(id) ON DELETE RESTRICT,
  tenant_id text,
  agent_id text,

  step text NOT NULL,
  event_type text NOT NULL,

  actor_id text NOT NULL,
  actor_role text NOT NULL,
  correlation_id text NOT NULL,
  -- SHA-256 da chave opaca. A chave em si nunca é persistida.
  idempotency_key_hash text,

  from_state text,
  to_state text,

  -- Resumo SANITIZADO: ids de recurso e contadores, nunca segredo, QR, token,
  -- e-mail ou telefone.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT onboarding_events_type_chk CHECK (event_type IN (
    'started',
    'completed',
    'denied',
    'failed',
    'replayed',
    'cancelled',
    'expired'
  ))
);

CREATE INDEX IF NOT EXISTS onboarding_events_run_idx
  ON onboarding_events (run_id, id);
CREATE INDEX IF NOT EXISTS onboarding_events_scope_idx
  ON onboarding_events (tenant_id, agent_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS onboarding_step_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES onboarding_runs(id) ON DELETE RESTRICT,
  tenant_id text,
  agent_id text,

  step text NOT NULL,
  -- SHA-256 da chave de idempotência opaca enviada pelo cliente.
  idempotency_key_hash text NOT NULL,
  -- SHA-256 do payload canônico. Mesma chave + payload DIFERENTE = conflito
  -- (§4 da issue): o cliente reusou a chave para outra coisa, e devolver o
  -- resultado antigo esconderia o bug.
  request_hash text NOT NULL,
  -- Resultado materializado devolvido no replay. Sanitizado (ids, nunca
  -- segredo).
  result jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chave de idempotência da issue §4.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_step_results_key_uq
  ON onboarding_step_results (run_id, step, idempotency_key_hash);

-- UM resultado por passo. É este índice que faz o double-click NÃO duplicar
-- recurso mesmo quando o cliente perde a chave e gera outra: o segundo insert
-- colide, e o comando volta o resultado persistido em vez de criar de novo.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_step_results_step_uq
  ON onboarding_step_results (run_id, step);
