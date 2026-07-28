-- 097 — Máquina de estados DURÁVEL do turno inbound (issue #503, Fase 1).
--
-- Substitui o marcador binário `mensagens.processada_em` (que só distingue
-- "processada" de "não processada") por um turno LÓGICO com ciclo de vida
-- completo. `processada_em` NÃO é removido aqui: durante o rollout ele vira
-- PROJEÇÃO de compatibilidade escrita por toda transição para estado terminal
-- (issue #503 §6). A remoção fica para issue posterior.
--
-- Por que "turno" e não "mensagem": o debounce agrega N mensagens de texto em
-- UMA execução. O estado pertence à execução, não a cada chunk. `agent_turns`
-- guarda o estado; `agent_turn_inputs` guarda quais mensagens o turno consumiu.
--
-- Invariantes gravadas em constraint (as demais vivem no repositório e em
-- src/runtime/turns/contract.ts):
--   * toda row escopada por (tenant_id, agent_id) — FKs COMPOSTAS, nunca por id
--     solto, para que nenhuma associação atravesse tenant/agente;
--   * uma mensagem inbound pertence a NO MÁXIMO um turno;
--   * estado terminal SEMPRE tem outcome; estado não-terminal NUNCA tem;
--   * o par (estado terminal, outcome) é fechado — espelha TERMINAL_OUTCOMES
--     em src/runtime/turns/contract.ts;
--   * `state_version` sustenta o compare-and-swap: toda transição incrementa e
--     o UPDATE exige a versão esperada.
--
-- Campos de claim/lease/deadline/outbound são criados AQUI mesmo sem uso nesta
-- issue. #504 (claim/lease/fencing), #506 (outbox) e #507 (deadline) os
-- consomem; criá-los agora evita uma sequência de ALTER TABLE no hot path.

CREATE TABLE IF NOT EXISTS agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  -- NULL enquanto a identidade/conversa não foi resolvida (o inbound é
  -- persistido antes da resolução — ver src/gateway/baileys.ts).
  conversa_id uuid,
  channel_id uuid,
  -- A mensagem que DISPAROU o turno. Também aparece em agent_turn_inputs.
  representative_message_id uuid NOT NULL,

  status text NOT NULL DEFAULT 'received',
  outcome text,
  state_version bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,

  -- Erro persistido: código de baixa cardinalidade + resumo SANITIZADO
  -- (sem payload/prompt/PII — sanitizeTurnError em contract.ts).
  last_error_code text,
  last_error_summary text,

  -- Reservado para #504 (claim atômico, lease, fencing).
  claimed_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  -- Reservado para #507 (deadline global e cancelamento).
  deadline_at timestamptz,
  -- Reservado para #506 (outbox durável): a resposta comprometida.
  outbound_message_id uuid,

  queued_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz,
  outbound_committed_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_turns_status_chk CHECK (status IN (
    'received', 'queued', 'claimed', 'running', 'outbound_pending',
    'retryable', 'completed', 'ignored', 'superseded', 'dead_letter'
  )),

  -- Compatibilidade estado x outcome, em UMA constraint. Cobre as três regras:
  -- não-terminal ⇒ outcome NULL; terminal ⇒ outcome NOT NULL; e o par tem de
  -- pertencer à lista fechada do estado.
  CONSTRAINT agent_turns_status_outcome_chk CHECK (
    (status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter') AND outcome IS NULL)
    OR (status = 'completed' AND outcome IN (
      'reply_delivered', 'reply_delivery_unknown', 'fallback_delivered',
      'no_reply_produced', 'pending_action_resolved', 'legacy_processed'
    ))
    OR (status = 'ignored' AND outcome IN (
      'blocked_by_policy', 'identity_unknown', 'identity_blocked',
      'quarantined', 'rate_limited_silent', 'operator_cancelled'
    ))
    OR (status = 'superseded' AND outcome = 'merged_into_turn')
    OR (status = 'dead_letter' AND outcome IN ('retry_exhausted', 'operator_cancelled'))
  ),

  CONSTRAINT agent_turns_state_version_chk CHECK (state_version >= 0),
  CONSTRAINT agent_turns_attempt_count_chk CHECK (attempt_count >= 0),
  -- Espelha TURN_ERROR_SUMMARY_MAX / TURN_ERROR_CODE_MAX do contrato: mesmo que
  -- um caller esqueça o sanitizador, o banco recusa texto longo (que é o vetor
  -- por onde payload/prompt vazaria para a trilha).
  CONSTRAINT agent_turns_error_summary_len_chk
    CHECK (last_error_summary IS NULL OR length(last_error_summary) <= 240),
  CONSTRAINT agent_turns_error_code_len_chk
    CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),

  -- Alvo das FKs compostas de agent_turn_inputs. `id` já é PK, então a
  -- unicidade do trio é consequência — não pode falhar por duplicata.
  CONSTRAINT agent_turns_scope_id_uq UNIQUE (tenant_id, agent_id, id)
);

-- Idempotência estrutural do ingresso e do backfill: um turno por mensagem
-- representativa. `createReceivedTurnTx` e o backfill em lotes dependem disto
-- (ON CONFLICT DO NOTHING) para serem seguros em re-execução.
CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_representative_uq
  ON agent_turns (representative_message_id);

-- Consulta do recovery: por (tenant, agent), estado e vencimento da tentativa.
CREATE INDEX IF NOT EXISTS agent_turns_scope_status_next_attempt_idx
  ON agent_turns (tenant_id, agent_id, status, next_attempt_at);

-- Enumeração CROSS-TENANT dos pares que têm trabalho pendente (o dispatcher do
-- worker de recovery roda FORA de contexto de tenant, como o de mensagens).
-- Parcial nos estados NÃO-terminais: a tabela cresce indefinidamente, o índice
-- não.
CREATE INDEX IF NOT EXISTS agent_turns_pending_dispatch_idx
  ON agent_turns (status, next_attempt_at, created_at)
  WHERE status IN ('received', 'queued', 'claimed', 'running', 'retryable');

-- #505 (FIFO por conversa) precisa ordenar turnos dentro de uma conversa.
CREATE INDEX IF NOT EXISTS agent_turns_conversa_idx
  ON agent_turns (tenant_id, agent_id, conversa_id, created_at)
  WHERE conversa_id IS NOT NULL;

-- #504 (lease expirada) — varredura de leases vencidas.
CREATE INDEX IF NOT EXISTS agent_turns_lease_idx
  ON agent_turns (tenant_id, agent_id, lease_expires_at)
  WHERE status IN ('claimed', 'running');

-- ─────────────────────────────────────────────────────────────────────────
-- Associação inbound -> turno lógico.
--
-- A FK para `mensagens` é COMPOSTA por (tenant_id, agent_id, id): é o que
-- impede fisicamente associar uma mensagem do tenant B a um turno do tenant A
-- (o índice único alvo foi criado CONCURRENTLY na migration 096). A FK para
-- `agent_turns` é composta pela mesma razão.

CREATE TABLE IF NOT EXISTS agent_turn_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  turn_id uuid NOT NULL,
  mensagem_id uuid NOT NULL,
  -- Ordem de chegada dentro do turno. 0 = mensagem representativa.
  ingress_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_turn_inputs_ingress_seq_chk CHECK (ingress_seq >= 0),
  CONSTRAINT agent_turn_inputs_turn_scope_fk
    FOREIGN KEY (tenant_id, agent_id, turn_id)
    REFERENCES agent_turns (tenant_id, agent_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_inputs_mensagem_scope_fk
    FOREIGN KEY (tenant_id, agent_id, mensagem_id)
    REFERENCES mensagens (tenant_id, agent_id, id)
);

-- Uma mensagem inbound pertence a NO MÁXIMO um turno lógico. Global (não
-- escopado): `mensagens.id` é UUID e a FK composta acima já garante que a row
-- referida é do mesmo par — a unicidade global só reforça "no máximo um".
CREATE UNIQUE INDEX IF NOT EXISTS agent_turn_inputs_mensagem_uq
  ON agent_turn_inputs (mensagem_id);

CREATE INDEX IF NOT EXISTS agent_turn_inputs_turn_idx
  ON agent_turn_inputs (tenant_id, agent_id, turn_id, ingress_seq);
