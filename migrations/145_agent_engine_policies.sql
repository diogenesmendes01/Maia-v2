-- 145 — POLÍTICA DE ENGINE por escopo (spec Maia+Hermes §4.1; matriz K-15).
--
-- ─── O que esta tabela decide ──────────────────────────────────────────────
--
-- Qual motor atende um turno NOVO de (tenant, agente, canal): `maia_react` ou
-- `hermes`. Linha ausente = `maia_react`. Não existe flag global que ligue o
-- Hermes: ligar é escrever UMA linha de UM escopo, e um tenant ligado não liga
-- outro. O kill switch (`MAIA_HERMES_KILL_SWITCH`) só força `maia_react`.
--
-- Turno já pinado não lê esta tabela: o pin de `engine_turn_bindings` (140) é
-- imutável, e trocar de motor no meio de um turno é o que o §5.8.2 proíbe.
--
-- ─── Escopo por FK composta ────────────────────────────────────────────────
--
-- `channel_id` referencia `channels (tenant_id, agent_id, id)`, o unique de
-- suporte criado pela 090 (`channels_tenant_agent_id_uq`) e já usado pelas FKs
-- de `conversas`/`outbox_messages`. Uma FK por `id` simples aceitaria o canal
-- de outro tenant ou de outro agente: o UUID prova unicidade, não
-- pertencimento.
--
-- ─── Versão para CAS ───────────────────────────────────────────────────────
--
-- `row_version` nasce 1 e sobe 1 a cada escrita aceita. A escrita só aplica se
-- a versão esperada bate (src/db/repositories/engine-policy-repos.ts); duas
-- escritas com a mesma versão produzem uma aceita e uma recusa.
--
-- ─── O que NÃO está aqui ───────────────────────────────────────────────────
--
-- `mode`, `approved_bundle_id` e `limits_policy_id` (§4.1) entram com P11, P09
-- e `agent_execution_limits`. A spec pede unique (tenant_id, agent_id); o dono
-- pediu (tenant_id, agent_id, channel_id), e é o que vale aqui.
--
-- Tabela NOVA e VAZIA: sem `CONCURRENTLY`, com envelope BEGIN/COMMIT.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_engine_policies (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  channel_id uuid NOT NULL,
  engine text NOT NULL,
  row_version bigint NOT NULL DEFAULT 1,
  -- Ator da última escrita (§4.1 pede "timestamps/ator"). `app_users.id` é
  -- text; referência SOFT, como `owner_app_user_id` na 140.
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- A unique do dono: um motor por (tenant, agente, canal).
  CONSTRAINT agent_engine_policies_pk PRIMARY KEY (tenant_id, agent_id, channel_id),
  CONSTRAINT agent_engine_policies_channel_fk
    FOREIGN KEY (tenant_id, agent_id, channel_id)
    REFERENCES channels (tenant_id, agent_id, id) ON DELETE RESTRICT,
  CONSTRAINT agent_engine_policies_engine_chk CHECK (engine IN ('maia_react', 'hermes')),
  CONSTRAINT agent_engine_policies_row_version_chk CHECK (row_version >= 1),
  CONSTRAINT agent_engine_policies_updated_by_chk CHECK (length(updated_by) > 0),
  -- Mesmo fail-closed da 133/140: uma política sob o literal `default` seria
  -- política GLOBAL disfarçada.
  CONSTRAINT agent_engine_policies_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  )
);

COMMENT ON TABLE agent_engine_policies IS
  'spec maia-hermes 4.1 (K-15): motor de turno NOVO por (tenant, agente, canal). Linha ausente = maia_react; nenhuma flag global liga o Hermes; MAIA_HERMES_KILL_SWITCH so forca maia_react. Escrita por CAS em row_version. Turno ja pinado (engine_turn_bindings) nao le esta tabela.';

COMMENT ON COLUMN agent_engine_policies.row_version IS
  'CAS: nasce 1 e sobe 1 por escrita aceita. Escrita com versao velha e recusada, nunca ultima-escrita-vence.';

COMMIT;
