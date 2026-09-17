-- 141 — IDEMPOTÊNCIA DE COMANDO do controle humano da conversa
-- (spec Maia+Hermes §8.2.3 passo 2 e §8.2.4).
--
-- ─── Por que uma tabela, e não um campo em `conversation_controls` ─────────
--
-- A 140 já guarda o ESTADO (`mode`, `control_epoch`, `last_command_id`). O que
-- falta é o registro do COMANDO, e os dois têm tempos de vida diferentes: o
-- estado é um, os comandos são muitos, e o §8.2.1 exige que "retry da mesma
-- chave de comando devolva o resultado do mesmo comando, sem novo incremento
-- nem novo audit". Sem uma linha por comando não há onde guardar o resultado
-- para devolver — e "sem novo incremento de epoch" viraria promessa que o
-- código não consegue cumprir, porque ele não saberia que já viu aquela chave.
--
-- ─── Por que `request_hash` e não só a chave ───────────────────────────────
--
-- §8.2.4: "mesma chave com payload divergente é conflito"; "não devolver
-- resultados de outra identidade que reutilize uma chave". Guardar só a chave
-- transformaria uma colisão (ou um cliente confuso mandando pause e depois
-- resume sob a mesma chave) em última-escrita-vence silencioso. O hash é o que
-- permite distinguir REDELIVERY de CONFLITO — a mesma régua do `request_key`
-- do journal de execução (§5.6.1).
--
-- ─── Por que ela também é OUTBOX ───────────────────────────────────────────
--
-- §8.2.4 manda usar o registro "como outbox de intenção de cancelamento/
-- reconciliação, com claim/lease/fence próprio de consumidor... não um publish
-- efêmero como única cópia". O pause commita uma barreira local, mas o cancel
-- do run remoto é I/O que pode falhar; sem linha durável, a intenção morreria
-- com o processo. Por isso as colunas de claim/lease aqui — o consumidor as usa
-- do mesmo jeito que o delivery worker usa as da 121.
--
-- ─── O que esta migration NÃO faz ──────────────────────────────────────────
--
-- Não implementa `pauseConversationTx` nem toca em caminho vivo: é só o
-- schema. O comportamento é a fatia P04, e as ações de auditoria que o §8.2.3
-- passo 4 exige ainda NÃO existem no vocabulário de `AUDIT_ACTIONS` (varridos
-- os 303 membros) — registrado como C20/C22 no checkpoint, e resolvido na
-- unidade que escrever a transação, não aqui.
--
-- Tabela NOVA e VAZIA: sem `CONCURRENTLY`, com envelope BEGIN/COMMIT.

BEGIN;

CREATE TABLE IF NOT EXISTS conversation_control_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  control_id uuid NOT NULL,

  -- Só os comandos de OPERADOR. `pausing → human` é do reconciliador Maia
  -- (§8.2.1) e não é comandado por ninguém: confirmar drenagem não é um pedido,
  -- é a constatação de que não há mais I/O autorizado em aberto.
  kind text NOT NULL CHECK (kind IN ('pause', 'resume')),

  -- A chave do chamador. UNIQUE por escopo, nunca global: duas contas podem
  -- gerar o mesmo UUID e uma não pode ler o resultado da outra.
  idempotency_key uuid NOT NULL,
  -- sha256 do payload canônico + principal. É o que separa REDELIVERY de
  -- CONFLITO; sem ele a mesma chave com payload diferente venceria em silêncio.
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),

  -- O CAS do §8.2.3 passo 3. NOT NULL de propósito: um comando sem epoch
  -- esperado não é compare-and-swap, é sobrescrita — e o console SEMPRE leu a
  -- row antes de oferecer o botão.
  expected_epoch bigint NOT NULL CHECK (expected_epoch >= 0),
  -- Preenchido no commit. NULL enquanto o comando não resolveu.
  result_epoch bigint CHECK (result_epoch IS NULL OR result_epoch >= 0),

  -- Principal administrativo. Referência SOFT, como `owner_app_user_id` na
  -- 140: `conversation_controls` também não tem FK para `app_users`, e criar
  -- integridade só aqui produziria dois padrões para o mesmo fato.
  requested_by_app_user_id text NOT NULL CHECK (length(requested_by_app_user_id) > 0),

  -- Desfecho TIPADO (§8.2.4). `conflict` é resposta legítima, não erro de
  -- transporte: outra chave já mexeu no epoch, ou a mesma chave veio com outro
  -- payload.
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'conflict', 'failed')),
  outcome_code text CHECK (outcome_code IS NULL OR outcome_code IN (
    'epoch_mismatch', 'payload_conflict', 'mode_not_allowed', 'control_not_found',
    'forbidden', 'reconciliation_required')),

  -- §8.2.3: "`barrierCommitted=true` NÃO significa `drainStatus='complete'`".
  -- Duas colunas porque são dois fatos, e colapsá-los seria prometer que
  -- nenhuma mensagem chega depois do clique — o que o §8.2.3 proíbe afirmar.
  barrier_committed boolean NOT NULL DEFAULT false,
  drain_status text CHECK (drain_status IS NULL OR drain_status IN (
    'pending', 'complete', 'reconciliation_required')),

  -- Contadores de evidência para a UI. Sem conteúdo de mensagem.
  inflight_effects integer NOT NULL DEFAULT 0 CHECK (inflight_effects >= 0),
  unknown_deliveries integer NOT NULL DEFAULT 0 CHECK (unknown_deliveries >= 0),

  -- "resumo sem conteúdo" (§8.2.4): só ids, códigos e contagens.
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (octet_length(summary_json::text) <= 16384),

  -- OUTBOX de intenção: claim/lease/fence próprios do consumidor que leva o
  -- cancelamento ao motor remoto (§8.2.4). Não é a lease do turno e não herda
  -- heartbeat dela.
  claimed_by text,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_control_commands_scope_id_uq
    UNIQUE (tenant_id, agent_id, id),
  -- A idempotência do §8.2.3 passo 2, no BANCO: duas chamadas simultâneas com
  -- a mesma chave produzem UMA linha e a segunda lê o resultado da primeira.
  CONSTRAINT conversation_control_commands_idem_uq
    UNIQUE (tenant_id, agent_id, idempotency_key),
  CONSTRAINT conversation_control_commands_control_fk
    FOREIGN KEY (tenant_id, agent_id, control_id)
    REFERENCES conversation_controls (tenant_id, agent_id, id) ON DELETE RESTRICT,
  -- Mesmo fail-closed da 133 e da 140: um comando sob o literal `default` seria
  -- comando GLOBAL disfarçado.
  CONSTRAINT conversation_control_commands_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  ),
  -- Resolvido exige dizer em que epoch parou. `pending` ainda não sabe.
  CONSTRAINT conversation_control_commands_resolved_chk CHECK (
    status = 'pending' OR status = 'conflict' OR status = 'failed'
    OR (status = 'accepted' AND result_epoch IS NOT NULL)
  ),
  -- Recusa precisa de motivo; aceite não inventa um.
  CONSTRAINT conversation_control_commands_outcome_chk CHECK (
    (status IN ('conflict', 'failed') AND outcome_code IS NOT NULL)
    OR (status IN ('pending', 'accepted') AND outcome_code IS NULL)
  ),
  -- Posse do outbox é tudo-ou-nada, como o claim da 121.
  CONSTRAINT conversation_control_commands_claim_chk CHECK (
    (claimed_by IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
    OR (claimed_by IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

-- Fila administrativa: comandos de um escopo, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS conversation_control_commands_scope_idx
  ON conversation_control_commands (tenant_id, agent_id, created_at DESC, id);

-- A varredura do consumidor de outbox. CROSS-TENANT e PARCIAL, como a de lease
-- vencida da 114: a pergunta "que intenção de cancelamento ficou sem dono?" não
-- tem tenant para ser feita dentro.
CREATE INDEX IF NOT EXISTS conversation_control_commands_outbox_idx
  ON conversation_control_commands (lease_expires_at, tenant_id, agent_id)
  WHERE status = 'accepted' AND drain_status IS DISTINCT FROM 'complete';

COMMENT ON TABLE conversation_control_commands IS
  'spec maia-hermes 8.2.3 passo 2 e 8.2.4: o COMANDO de pause/resume como linha duravel. A unique escopada de idempotency_key torna o retry repetivel sem incrementar epoch de novo, e request_hash separa redelivery de conflito. Tambem e outbox da intencao de cancelamento/reconciliacao, com claim/lease proprio: barrier_committed=true NAO significa drain_status=complete. Comportamento e a fatia P04; aqui so o schema.';

COMMENT ON COLUMN conversation_control_commands.request_hash IS
  'spec 8.2.4: sha256 do payload canonico + principal. Mesma chave com hash diferente e CONFLITO, nunca ultima-escrita-vence.';

COMMENT ON COLUMN conversation_control_commands.barrier_committed IS
  'spec 8.2.3: a barreira local commitou. NAO afirma que nenhuma mensagem chega depois — isso e drain_status, e sao fatos diferentes de proposito.';

COMMIT;
