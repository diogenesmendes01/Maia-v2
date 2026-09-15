-- 140 — o JOURNAL DURÁVEL de execução do engine e o CONTROLE DE CONVERSA
-- (spec Maia+Hermes §5.6.2 e §8.2.1).
--
-- ─── O que estas tabelas existem para impedir ──────────────────────────────
--
-- Hoje o resultado do raciocínio é um objeto em memória: `ReActLoopResult`. Se
-- o processo morre no meio, o que aconteceu com as ferramentas que já rodaram
-- não está escrito em lugar nenhum — e a única saída honesta vira "não repetir
-- nada", ou a desonesta, "repetir tudo". Com um motor em OUTRO processo isso
-- deixa de ser aceitável: precisa existir um registro de quem autorizou a
-- execução, o que foi pedido, o que foi chamado, o que tem efeito
-- possivelmente comitado e o que já virou saída.
--
-- Por isso o journal é subordinado ao turno (`agent_turns`), nunca uma segunda
-- máquina de turnos: `engine_runs.phase` é observação do EXECUTOR e não
-- substitui `agent_turns.status` (§5.7.2).
--
-- ─── Por que o controle de conversa entra AQUI ─────────────────────────────
--
-- O plano da spec coloca o controle humano no P04, depois do journal (P03).
-- Mas o DDL de `engine_runs` tem FK composta para `conversation_controls` e o
-- §5.6.2 diz, textualmente, para criar a tabela de controle ANTES dessa FK.
-- As duas coisas não cabem em ordens diferentes: uma FK não pode apontar para
-- uma tabela que ainda não existe.
--
-- Resolução deliberada, registrada no checkpoint da implementação: o SCHEMA do
-- controle nasce aqui, junto do journal que depende dele. O COMPORTAMENTO de
-- pausa/retomada (comandos, epoch nos limites de efeito, console) continua
-- sendo o P04. Uma tabela de controle sem o serviço é inerte: todo run nasce
-- com `mode='bot'` e epoch 0, que é exatamente o estado de hoje.
--
-- ─── O que NÃO está aqui, e por quê ────────────────────────────────────────
--
-- * FKs compostas de `conversation_controls` para `conversas`/`pessoas`/
--   `channels`: essas tabelas hoje só têm `PRIMARY KEY (id)` (conferido no
--   banco). Criar os uniques compostos que faltam significa índice novo em
--   tabela QUENTE (`conversas`), que é migration própria, com CONCURRENTLY, e
--   pertence à fatia do P04 — junto do código que passa a escrever nelas. Até
--   lá o escopo é garantido pelos CHECKs abaixo e pelo repositório.
-- * `agent_engine_policies` / `agent_execution_limits` (§4.1): são política por
--   agente, consumidas pela admissão, e entram com o seletor de engine.
--
-- ─── Imutabilidade é do BANCO, não só do repositório ───────────────────────
--
-- §5.6.2 exige que pin, request, contexto, origem, identidade de chamada e
-- terminal aceito sejam IMUTÁVEIS, com "trigger de imutabilidade ou
-- privilégios + testes de UPDATE direto". Aqui é trigger: um `UPDATE` direto no
-- psql durante um incidente é exatamente o caminho que o runbook proíbe, e é
-- justamente quando ninguém está lendo o código do repositório.
--
-- ─── Por que SEM `CONCURRENTLY` e COM envelope ─────────────────────────────
--
-- Todas as tabelas NASCEM aqui e nascem vazias: não há leitura concorrente a
-- proteger nem varredura a fazer. O envelope `BEGIN`/`COMMIT` garante que
-- "tabela sem o índice único que a torna idempotente" não seja um estado
-- alcançável, e mantém este arquivo fora da armadilha da issue 658.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CONTROLE DE CONVERSA (§8.2.1)
-- ════════════════════════════════════════════════════════════════════════════

-- A unidade de controle é a STREAM, não a conversa: `conversa_id` pode ser nulo
-- no ingresso (a identidade ainda não foi resolvida), e uma conversa encerrada
-- por inatividade não pode apagar uma pausa. `stream_key` é a mesma chave
-- derivada por src/runtime/turns/stream-key.ts.
CREATE TABLE IF NOT EXISTS conversation_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  stream_key text NOT NULL,
  stream_key_version smallint NOT NULL,
  channel_id uuid NOT NULL,
  -- Nulos até a resolução confiável. Vinculados por operação escopada, NUNCA
  -- por argumento de modelo.
  conversa_id uuid,
  pessoa_id uuid,

  -- `pausing` é estado REAL, não decoração: entre a barreira e a drenagem
  -- confirmada existe I/O em voo que ninguém pode declarar morto.
  mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'pausing', 'human')),
  -- Incrementa no pause E no resume. Incrementar nos dois impede o problema
  -- ABA: um run iniciado no epoch antigo não recupera autoridade só porque o
  -- modo voltou a `bot`.
  control_epoch bigint NOT NULL DEFAULT 0 CHECK (control_epoch >= 0),

  -- `app_users.id` é text (conferido no banco), não uuid.
  owner_app_user_id text,
  reason_code text CHECK (reason_code IS NULL OR reason_code IN (
    'operator_takeover', 'customer_requested', 'safety_review', 'handoff_accepted',
    'human_resolved', 'operator_release', 'supervised_recovery')),
  -- Referência protegida à nota — a nota em si NÃO mora aqui.
  reason_ref uuid,

  paused_at timestamptz,
  resumed_at timestamptz,
  last_command_id uuid,
  -- Marca d'água de `future_only` (§8.2.5): o que entrou antes dela não é
  -- respondido automaticamente na retomada.
  resume_after_ingress_seq bigint,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_controls_scope_id_uq UNIQUE (tenant_id, agent_id, id),
  CONSTRAINT conversation_controls_stream_uq UNIQUE (tenant_id, agent_id, stream_key),
  -- Mesmo fail-closed da 133: um controle sob o literal `default` seria um
  -- controle GLOBAL disfarçado.
  CONSTRAINT conversation_controls_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0 AND length(stream_key) > 0
  ),
  -- Quem está no controle precisa ter nome. `human`/`pausing` sem dono é
  -- indistinguível de bug de escrita, e é sobre esse estado que o console
  -- decide se libera composer.
  CONSTRAINT conversation_controls_owner_chk CHECK (
    mode = 'bot' OR (owner_app_user_id IS NOT NULL AND length(owner_app_user_id) > 0)
  ),
  CONSTRAINT conversation_controls_paused_chk CHECK (
    mode = 'bot' OR paused_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS conversation_controls_queue_idx
  ON conversation_controls (tenant_id, agent_id, mode, updated_at, id);

COMMENT ON TABLE conversation_controls IS
  'spec maia-hermes 8.2.1: quem pode agir nesta conversa (bot/pausing/human) e desde qual epoch. A unidade e a STREAM, nao a conversa: conversa_id pode ser nulo no ingresso e encerrar conversa nao pode apagar uma pausa. Schema criado junto do journal porque engine_runs tem FK composta para ca; o comportamento de pausa/retomada e a fatia P04.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. BINDING DE ENGINE POR TURNO (§5.6.2)
-- ════════════════════════════════════════════════════════════════════════════

-- Fixa UM motor por turno oficial. Retry do turno NÃO troca o motor: trocar no
-- meio de um resultado ou efeito incerto é o cenário que a spec proíbe em
-- §5.8.2 ("Rollback de engine selector").
CREATE TABLE IF NOT EXISTS engine_turn_bindings (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  turn_id uuid NOT NULL,
  engine text NOT NULL CHECK (engine IN ('maia_react', 'hermes')),
  adapter_revision text NOT NULL CHECK (length(adapter_revision) BETWEEN 1 AND 128),
  configuration_digest text NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  protocol_version integer NOT NULL CHECK (protocol_version = 1),
  -- Teto de deliberações NOVAS no turno. Reconciliar/entregar resultado já
  -- produzido não consome geração (§5.8.3).
  max_generations integer NOT NULL CHECK (max_generations BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_turn_bindings_pk PRIMARY KEY (tenant_id, agent_id, turn_id),
  CONSTRAINT engine_turn_bindings_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_turn_bindings_turn_fk FOREIGN KEY (tenant_id, agent_id, turn_id)
    REFERENCES agent_turns (tenant_id, agent_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE engine_turn_bindings IS
  'spec maia-hermes 5.6.2: UM motor por turno, imutavel. O pin nao muda em retry — trocar de motor no meio de um efeito incerto e o cenario proibido em 5.8.2.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. RUN (§5.6.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  turn_id uuid NOT NULL,
  -- Deliberação nova dentro do turno. NÃO incrementa por poll, retry de
  -- transporte, reconciliação ou entrega.
  generation_no integer NOT NULL CHECK (generation_no > 0),
  -- A tentativa canônica do TURNO que autorizou criar este run. Imutável.
  origin_turn_attempt integer NOT NULL CHECK (origin_turn_attempt > 0),
  -- O fence de origem. Só existe no banco: nunca é serializado no pedido nem
  -- entregue ao modelo (§5.6.1).
  origin_claim_token uuid NOT NULL,
  origin_worker_id text NOT NULL,

  control_id uuid NOT NULL,
  control_epoch bigint NOT NULL CHECK (control_epoch >= 0),

  mode text NOT NULL CHECK (mode IN ('live', 'shadow')),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),

  phase text NOT NULL CHECK (phase IN (
    'prepared', 'submitting', 'submission_unknown', 'running', 'cancelling',
    'reconciling', 'result_ready', 'blocked', 'closed')),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),

  -- Identidade do START. Reenvio mantém bytes e hash; mesma chave com bytes
  -- diferentes é conflito terminal, não "última escrita vence".
  request_key uuid NOT NULL,
  remote_instance_id text NOT NULL CHECK (length(remote_instance_id) BETWEEN 1 AND 128),
  remote_run_id text CHECK (remote_run_id IS NULL OR length(remote_run_id) BETWEEN 1 AND 512),

  request_json jsonb NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  host_context_json jsonb NOT NULL,
  host_context_hash text NOT NULL CHECK (host_context_hash ~ '^[0-9a-f]{64}$'),

  -- Prazo ABSOLUTO do raciocínio, diferente do horizonte móvel da lease. O de
  -- reconciliação é maior de propósito: consultar e cancelar precisam continuar
  -- possíveis depois de o orçamento de raciocínio acabar.
  deadline_at timestamptz NOT NULL,
  reconcile_deadline_at timestamptz NOT NULL,
  capabilities_revoked_at timestamptz,

  submit_count integer NOT NULL DEFAULT 0 CHECK (submit_count >= 0),
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz,

  terminal_json jsonb,
  terminal_hash text,
  output_preparation_json jsonb,
  adopted_by_turn_attempt integer CHECK (
    adopted_by_turn_attempt IS NULL OR adopted_by_turn_attempt > 0),

  closed_reason text CHECK (closed_reason IS NULL OR closed_reason IN (
    'handed_to_outbox', 'completed_no_reply', 'safe_to_retry', 'discarded', 'manual_resolved')),
  closed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  last_event_sequence bigint NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT engine_runs_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_runs_control_fk FOREIGN KEY (tenant_id, agent_id, control_id)
    REFERENCES conversation_controls (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_runs_binding_fk FOREIGN KEY (tenant_id, agent_id, turn_id)
    REFERENCES engine_turn_bindings (tenant_id, agent_id, turn_id) ON DELETE RESTRICT,
  CONSTRAINT engine_runs_scope_id_uq UNIQUE (tenant_id, agent_id, id),
  CONSTRAINT engine_runs_scope_turn_id_uq UNIQUE (tenant_id, agent_id, turn_id, id),
  CONSTRAINT engine_runs_generation_uq UNIQUE (tenant_id, agent_id, turn_id, generation_no),
  CONSTRAINT engine_runs_request_uq UNIQUE (tenant_id, agent_id, request_key),
  CONSTRAINT engine_runs_deadlines_chk CHECK (reconcile_deadline_at >= deadline_at),
  -- Fechar exige dizer POR QUE e ter revogado capacidade. Um run `closed` com
  -- capacidade viva seria um callback autorizado sem dono.
  CONSTRAINT engine_runs_closed_chk CHECK (
    CASE WHEN phase = 'closed'
      THEN closed_at IS NOT NULL AND closed_reason IS NOT NULL AND capabilities_revoked_at IS NOT NULL
      ELSE closed_at IS NULL AND closed_reason IS NULL END),
  CONSTRAINT engine_runs_terminal_hash_chk CHECK (
    (terminal_json IS NULL AND terminal_hash IS NULL) OR
    (terminal_json IS NOT NULL AND terminal_hash IS NOT NULL AND terminal_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT engine_runs_ready_chk CHECK (phase <> 'result_ready' OR terminal_json IS NOT NULL),
  -- Entregar ou concluir sem resposta exige terminal E dono que adotou: é o que
  -- impede "fechei o run" virar sinônimo de "alguém decidiu o desfecho".
  CONSTRAINT engine_runs_adopted_chk CHECK (
    closed_reason IS NULL OR closed_reason NOT IN ('handed_to_outbox', 'completed_no_reply') OR
    (terminal_json IS NOT NULL AND adopted_by_turn_attempt IS NOT NULL)),
  CONSTRAINT engine_runs_request_size_chk CHECK (octet_length(request_json::text) <= 1048576),
  CONSTRAINT engine_runs_context_size_chk CHECK (octet_length(host_context_json::text) <= 1048576),
  CONSTRAINT engine_runs_terminal_size_chk CHECK (
    terminal_json IS NULL OR octet_length(terminal_json::text) <= 262144),
  CONSTRAINT engine_runs_output_size_chk CHECK (
    output_preparation_json IS NULL OR octet_length(output_preparation_json::text) <= 262144)
);

-- No máximo UM run não fechado por turno. É o que impede duas deliberações
-- concorrentes para a mesma conversa.
CREATE UNIQUE INDEX IF NOT EXISTS engine_runs_one_open_turn_uq
  ON engine_runs (tenant_id, agent_id, turn_id) WHERE phase <> 'closed';

-- Mesma execução remota não pode ser reivindicada por dois runs.
CREATE UNIQUE INDEX IF NOT EXISTS engine_runs_remote_uq
  ON engine_runs (tenant_id, agent_id, remote_instance_id, remote_run_id)
  WHERE remote_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS engine_runs_due_idx
  ON engine_runs (tenant_id, agent_id, next_poll_at, id)
  WHERE phase IN ('prepared', 'submitting', 'submission_unknown', 'running',
                  'cancelling', 'reconciling', 'result_ready');

-- Mesma pergunta SEM tenant no prefixo: o varredor cross-tenant descobre os
-- pares com trabalho ANTES de abrir contexto, como o de lease vencida da 114.
CREATE INDEX IF NOT EXISTS engine_runs_due_dispatch_idx
  ON engine_runs (next_poll_at, tenant_id, agent_id)
  WHERE phase IN ('prepared', 'submitting', 'submission_unknown', 'running',
                  'cancelling', 'reconciling', 'result_ready');

CREATE INDEX IF NOT EXISTS engine_runs_blocked_idx
  ON engine_runs (tenant_id, agent_id, updated_at, id) WHERE phase = 'blocked';

COMMENT ON TABLE engine_runs IS
  'spec maia-hermes 5.6.2: a execucao do motor, subordinada ao turno. phase e observacao do EXECUTOR e nao substitui agent_turns.status: um run closed/handed_to_outbox convive com turno outbound_pending, e um run blocked convive com turno dead_letter.';

COMMENT ON COLUMN engine_runs.origin_claim_token IS
  'spec 5.6.1: o fence de origem. NUNCA e serializado no pedido nem entregue ao modelo, e a recuperacao nao o troca pelo token do novo dono.';

COMMENT ON COLUMN engine_runs.request_key IS
  'spec 5.6.1: identidade do START. Reenvio mantem bytes e hash. Mesma chave com bytes diferentes e conflito terminal, nunca last-writer-wins.';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. TOOL CALLS (§5.6.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  turn_id uuid NOT NULL,
  run_id uuid NOT NULL,
  -- Derivado pela Maia (`run_id:call_seq`), nunca escolhido pelo modelo.
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 256),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  -- Telemetria opcional. NULL e' valido: o handler comum do Hermes nao recebe o
  -- numero autoritativo da iteracao, e inventar `1` para satisfazer um NOT NULL
  -- seria fabricar evidencia.
  iteration integer CHECK (iteration IS NULL OR iteration > 0),
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 256),
  args_json jsonb NOT NULL,
  args_hash text NOT NULL CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  normalized_args_json jsonb,
  request_id uuid NOT NULL,

  state text NOT NULL CHECK (state IN (
    'received', 'dispatching', 'handler_started', 'completed', 'denied',
    'approval_required', 'effect_unknown', 'cancelled')),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  dispatch_token uuid,

  side_effect text CHECK (side_effect IS NULL OR side_effect IN (
    'none', 'read', 'write', 'communication')),
  effect_class text CHECK (effect_class IS NULL OR effect_class IN (
    'abort_safe', 'idempotent', 'non_interruptible', 'compensatable')),
  sensitive boolean NOT NULL DEFAULT false,
  -- Conservador por construção, como o booleano do ReAct de hoje: marca na
  -- INVOCAÇÃO, não no sucesso.
  legacy_irreversible_invoked boolean NOT NULL DEFAULT false,
  -- `possible`/`unknown` NUNCA voltam a `none` por expiração (§5.6.2).
  effect_evidence text NOT NULL DEFAULT 'none' CHECK (effect_evidence IN (
    'none', 'possible', 'committed', 'unknown')),

  idempotency_key text,
  idempotency_payload_hash text,
  reservation_token text,
  approval_request_id uuid,
  approval_claim_token text,

  result_json jsonb,
  receipt_json jsonb,
  receipt_hash text,
  handler_started_at timestamptz,
  finished_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT engine_tool_calls_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  CONSTRAINT engine_tool_calls_run_fk FOREIGN KEY (tenant_id, agent_id, turn_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, turn_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_tool_calls_approval_fk FOREIGN KEY (tenant_id, agent_id, approval_request_id)
    REFERENCES approval_requests (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_tool_calls_call_uq UNIQUE (tenant_id, agent_id, run_id, call_id),
  CONSTRAINT engine_tool_calls_ordinal_uq UNIQUE (tenant_id, agent_id, run_id, ordinal),
  CONSTRAINT engine_tool_calls_identity_chk CHECK (
    (idempotency_key IS NULL AND idempotency_payload_hash IS NULL) OR
    (idempotency_key IS NOT NULL AND idempotency_payload_hash IS NOT NULL)),
  -- O marcador de handler é o que separa "não começou" de "pode ter começado".
  -- Sem token de dispatch e sem reserva ele não significa nada.
  CONSTRAINT engine_tool_calls_handler_chk CHECK (
    state <> 'handler_started' OR
    (handler_started_at IS NOT NULL AND dispatch_token IS NOT NULL AND reservation_token IS NOT NULL)),
  CONSTRAINT engine_tool_calls_terminal_chk CHECK (
    CASE WHEN state IN ('completed', 'denied', 'approval_required', 'effect_unknown', 'cancelled')
      THEN finished_at IS NOT NULL AND result_json IS NOT NULL
      ELSE finished_at IS NULL END),
  CONSTRAINT engine_tool_calls_approval_chk CHECK (
    state <> 'approval_required' OR approval_request_id IS NOT NULL),
  CONSTRAINT engine_tool_calls_unknown_chk CHECK (
    state <> 'effect_unknown' OR effect_evidence = 'unknown'),
  CONSTRAINT engine_tool_calls_receipt_chk CHECK (
    (receipt_json IS NULL AND receipt_hash IS NULL) OR
    (receipt_json IS NOT NULL AND receipt_hash IS NOT NULL AND receipt_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT engine_tool_calls_size_chk CHECK (
    octet_length(args_json::text) <= 262144 AND
    (normalized_args_json IS NULL OR octet_length(normalized_args_json::text) <= 262144) AND
    (result_json IS NULL OR octet_length(result_json::text) <= 262144) AND
    (receipt_json IS NULL OR octet_length(receipt_json::text) <= 262144))
);

CREATE INDEX IF NOT EXISTS engine_tool_calls_unsettled_idx
  ON engine_tool_calls (tenant_id, agent_id, run_id, ordinal)
  WHERE state IN ('received', 'dispatching', 'handler_started', 'effect_unknown');

CREATE INDEX IF NOT EXISTS engine_tool_calls_approval_idx
  ON engine_tool_calls (tenant_id, agent_id, approval_request_id)
  WHERE approval_request_id IS NOT NULL;

COMMENT ON TABLE engine_tool_calls IS
  'spec maia-hermes 5.6.2: o journal por chamada. effect_evidence separa "nao houve efeito" de "pode ter havido" — e timeout nunca prova ausencia de efeito (INV-06).';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. EVENTOS E PROJEÇÕES (§5.6.2)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS engine_run_events (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (event_type IN (
    'prepared', 'submit_started', 'submit_observed', 'tool_state', 'terminal_observed',
    'capabilities_revoked', 'reconcile_decision', 'output_handoff', 'closed', 'projection')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('turn_owner', 'recovery', 'operator')),
  actor_turn_attempt integer CHECK (actor_turn_attempt IS NULL OR actor_turn_attempt > 0),
  -- Só IDs, códigos e hashes: nunca prompt, resultado bruto ou raciocínio.
  metadata_json jsonb NOT NULL CHECK (octet_length(metadata_json::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_run_events_pk PRIMARY KEY (tenant_id, agent_id, run_id, sequence_no),
  CONSTRAINT engine_run_events_dedupe_uq UNIQUE (tenant_id, agent_id, run_id, dedupe_key),
  CONSTRAINT engine_run_events_run_fk FOREIGN KEY (tenant_id, agent_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS engine_projections (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  projection text NOT NULL CHECK (projection IN (
    'event_history', 'postturn_graph', 'gap_reflection')),
  -- `uncertain` existe porque "começou e não sei se terminou" é um fato
  -- diferente de "falhou", e reexecutar um graph iniciado sem idempotência por
  -- node é o que duplica aprendizado.
  state text NOT NULL CHECK (state IN ('pending', 'started', 'completed', 'uncertain', 'failed')),
  row_version bigint NOT NULL DEFAULT 0 CHECK (row_version >= 0),
  -- Referência FORENSE à mensagem-âncora. Sem FK, como blocked_by_turn_id da
  -- 133: o escopo é validado na mesma transação da criação.
  anchor_message_id uuid,
  started_at timestamptz,
  finished_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_projections_pk PRIMARY KEY (tenant_id, agent_id, run_id, projection),
  CONSTRAINT engine_projections_run_fk FOREIGN KEY (tenant_id, agent_id, run_id)
    REFERENCES engine_runs (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT engine_projections_terminal_chk CHECK (
    state NOT IN ('completed', 'uncertain', 'failed') OR finished_at IS NOT NULL),
  CONSTRAINT engine_projections_anchor_chk CHECK (
    anchor_message_id IS NULL OR projection = 'event_history')
);

CREATE INDEX IF NOT EXISTS engine_projections_pending_idx
  ON engine_projections (tenant_id, agent_id, created_at, run_id) WHERE state = 'pending';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. IMUTABILIDADE (§5.6.2, invariante 2)
-- ════════════════════════════════════════════════════════════════════════════

-- O que é imutável não é "o que o repositório não atualiza": é o que o BANCO
-- recusa atualizar. Um `UPDATE` de incidente no psql é justamente o caminho em
-- que ninguém está lendo o código do repositório.
CREATE OR REPLACE FUNCTION engine_runs_immutable_columns()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.generation_no IS DISTINCT FROM OLD.generation_no
     OR NEW.origin_turn_attempt IS DISTINCT FROM OLD.origin_turn_attempt
     OR NEW.origin_claim_token IS DISTINCT FROM OLD.origin_claim_token
     OR NEW.control_id IS DISTINCT FROM OLD.control_id
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.request_json IS DISTINCT FROM OLD.request_json
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.host_context_json IS DISTINCT FROM OLD.host_context_json
     OR NEW.host_context_hash IS DISTINCT FROM OLD.host_context_hash
     OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
     OR NEW.remote_instance_id IS DISTINCT FROM OLD.remote_instance_id THEN
    RAISE EXCEPTION 'engine_runs: coluna imutavel alterada (spec 5.6.2 invariante 2)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- `remote_run_id` pode passar NULL -> valor UMA vez. Reatribuir e' o caso em
  -- que duas execucoes remotas disputam o mesmo registro: bloqueia, nao
  -- sobrescreve (spec 5.6.2 invariante 3).
  IF OLD.remote_run_id IS NOT NULL AND NEW.remote_run_id IS DISTINCT FROM OLD.remote_run_id THEN
    RAISE EXCEPTION 'engine_runs: remote_run_id ja atribuido nao pode mudar'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Terminal aceito e' imutavel: um segundo terminal diferente para a mesma
  -- execucao e' conflito a reconciliar, nao atualizacao.
  IF OLD.terminal_hash IS NOT NULL AND NEW.terminal_hash IS DISTINCT FROM OLD.terminal_hash THEN
    RAISE EXCEPTION 'engine_runs: terminal ja aceito nao pode ser substituido'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_runs_immutable_trg
  BEFORE UPDATE ON engine_runs
  FOR EACH ROW EXECUTE FUNCTION engine_runs_immutable_columns();

CREATE OR REPLACE FUNCTION engine_tool_calls_immutable_columns()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
     OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
     OR NEW.args_json IS DISTINCT FROM OLD.args_json
     OR NEW.args_hash IS DISTINCT FROM OLD.args_hash
     OR NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'engine_tool_calls: coluna imutavel alterada (spec 5.6.2 invariante 2)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Evidencia de efeito e' MONOTONICA: uma vez que houve possibilidade de
  -- efeito, expiracao ou retry nao devolvem a linha para `none`.
  IF OLD.effect_evidence IN ('possible', 'committed', 'unknown')
     AND NEW.effect_evidence = 'none' THEN
    RAISE EXCEPTION 'engine_tool_calls: effect_evidence nao regride para none'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_tool_calls_immutable_trg
  BEFORE UPDATE ON engine_tool_calls
  FOR EACH ROW EXECUTE FUNCTION engine_tool_calls_immutable_columns();

-- Eventos sao APPEND-ONLY: o ledger que explica uma reconciliacao nao pode ser
-- reescrito por quem esta sendo reconciliado.
CREATE OR REPLACE FUNCTION engine_run_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'engine_run_events e append-only (spec 5.6.2)'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engine_run_events_append_only_trg
  BEFORE UPDATE OR DELETE ON engine_run_events
  FOR EACH ROW EXECUTE FUNCTION engine_run_events_append_only();

COMMIT;
