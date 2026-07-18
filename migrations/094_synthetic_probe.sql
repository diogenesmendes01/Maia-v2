-- 094 — Sonda sintética: teste real de interação do agente, automatizado
-- (spec docs/superpowers/specs/2026-07-17-synthetic-agent-probe-design.md §1/§4).
--
-- Três partes, todas ADITIVAS e inertes enquanto MAIA_SYNTHETIC_PROBE=false:
--   (a) coluna `channels.is_synthetic` — marcador IMUTÁVEL (setado só aqui, no
--       seed, nunca por config de runtime): base do sink de outbound (§1.3) e
--       da validação fail-fast de boot (§1.3);
--   (b) tabelas de estado durável `synthetic_probe_runs` / `synthetic_probe_state`
--       (§1.5) — last_ok/K-falhas/transição/single-flight/histórico sobrevivem a
--       restart (os contadores in-memory de metrics.ts não);
--   (c) seed do recurso de sonda: tenant/agente dedicados, canal whatsapp E.164
--       **INATIVO** com is_synthetic=true (§1.2 — um canal ATIVO de tenant ≠
--       primary derrubaria `findPrimaryCatchAllChannel` para multi_tenant:true e
--       quebraria o ingresso REAL; ele só é ativado no pareamento sob
--       exact_first/strict), role default + policy, pessoa "cliente de teste",
--       entidade + conta, permissão (profile pré-semeado `dono_total`) e grant do
--       pack `domain.finance` (sem ele a tool `register_transaction` nem é
--       visível). Fixtures completos do cenário register_transaction_pendente
--       (§1.4). Também um agent_audience_profiles ATIVO para a pessoa — sem ele o
--       resolver de identidade quarentena a pessoa (fail-closed) e nada é servido.
--
-- Ids literais fixos (referenciados por src/probe/constants.ts) para o canal, a
-- pessoa, a entidade e a conta; os demais usam ids fixos por determinismo. O
-- tenant/agent é '__probe__' (≠ 'primary'/'default'/'system'; passa os guards de
-- tenant-context). O `_down` desfaz na ordem inversa de dependência.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps each migration in a transaction.

-- (a) marcador sintético imutável no canal.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

-- (b) estado durável da sonda.
CREATE TABLE IF NOT EXISTS synthetic_probe_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL REFERENCES tenants(id),
  agent_id     text NOT NULL REFERENCES agents(id),
  channel_id   uuid,
  scenario     text NOT NULL,
  -- id estável do inbound sintético injetado (metadata.whatsapp_id): o HANDLE
  -- do run — dele a sonda resolve a `mensagens` de entrada e, daí, os efeitos.
  whatsapp_id  text NOT NULL,
  -- `mensagens.id` da entrada resolvida: a chave de correlação dos efeitos
  -- (transacoes.mensagem_id / out.metadata->>'in_reply_to'). NULL até resolver.
  mensagem_id  uuid,
  started_at   timestamptz NOT NULL DEFAULT now(),
  -- ok | slow | wrong | silent | error — NULL enquanto em voo (não classificado).
  outcome      text CHECK (outcome IS NULL OR outcome IN ('ok','slow','wrong','silent','error')),
  latency_ms   integer,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- set quando o run atinge estado TERMINAL — só então o cleanup pode recolher
  -- as rows do run (§1.5: um job que estourou o SLO pode persistir DEPOIS).
  terminal_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS synthetic_probe_runs_scope_idx
  ON synthetic_probe_runs (tenant_id, agent_id, started_at DESC);
-- runs em voo (sweep de TTL e correlação): baratíssimo quando vazio.
CREATE INDEX IF NOT EXISTS synthetic_probe_runs_open_idx
  ON synthetic_probe_runs (started_at) WHERE terminal_at IS NULL;
CREATE INDEX IF NOT EXISTS synthetic_probe_runs_wid_idx
  ON synthetic_probe_runs (whatsapp_id);

CREATE TABLE IF NOT EXISTS synthetic_probe_state (
  tenant_id             text NOT NULL REFERENCES tenants(id),
  agent_id              text NOT NULL REFERENCES agents(id),
  -- sinal PRIMÁRIO de outage (§1.6): o gauge seconds_since_last_ok é lido daqui.
  last_ok_at            timestamptz,
  -- primeira tentativa registrada — o gauge cresce a partir daqui mesmo se a
  -- sonda NUNCA ficou verde (last_ok_at nulo). Sem isso um ambiente que falha
  -- desde o 1º tick exibiria gauge=0 e a regra '>15m' nunca dispararia (review).
  first_attempt_at      timestamptz,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  health                text NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','degraded')),
  -- alerta durável com retry (§1.6): a transição saudável→degradado grava
  -- alert_pending=true; um retry no worker reentrega até confirmar e só então
  -- zera — sem isso uma falha de entrega de sendAlert (allSettled engole)
  -- suprimiria o alerta até a próxima recuperação+degradação.
  alert_pending         boolean NOT NULL DEFAULT false,
  alert_pending_since   timestamptz,
  last_alert_attempt_at timestamptz,
  -- single-flight (§1.5): impede runs concorrentes; lease vencido é reciclado.
  lease_until           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id)
);

-- (c) seed do recurso de sonda (ordem FK-safe).

-- tenant + agente dedicados (ids TEXT literais, ≠ primary/default/system).
INSERT INTO tenants (id, nome, status)
  VALUES ('__probe__', 'Synthetic Probe (isolado)', 'active')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO agents (id, tenant_id, nome, status)
  VALUES ('__probe__', '__probe__', 'Maia Probe', 'active')
  ON CONFLICT (id) DO NOTHING;

-- canal whatsapp da sonda — INATIVO + is_synthetic=true. A linha E.164
-- (+999000999001, faixa reservada ITU-T +999) é o exact-match do ingresso; o
-- canal só é ativado no pareamento sob exact_first/strict (§1.2).
INSERT INTO channels (id, tenant_id, agent_id, external_id, channel_type, display_name, active, is_synthetic)
  VALUES ('eebe5268-875d-58e0-b727-7bb6589c947e', '__probe__', '__probe__',
          '+999000999001', 'whatsapp', 'Synthetic Probe Line', false, true)
  ON CONFLICT (tenant_id, channel_type, external_id) DO NOTHING;

-- role default + policy do canal (resolve role/policy do ingresso).
INSERT INTO roles (id, tenant_id, agent_id, role_key, display_name, description, is_default, active)
  VALUES ('b53e338f-854c-5e72-bfed-9cace6ec4a75', '__probe__', '__probe__',
          'default', 'Default', 'Role default da sonda', true, true)
  ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING;
INSERT INTO channel_policies (id, tenant_id, agent_id, channel_id, default_role_id, switch_behavior, announce_mode)
  VALUES ('6ba2c628-1177-570e-8eb4-37f6c03e8c3b', '__probe__', '__probe__',
          'eebe5268-875d-58e0-b727-7bb6589c947e', 'b53e338f-854c-5e72-bfed-9cace6ec4a75',
          'free_with_trigger', 'affects_user')
  ON CONFLICT (channel_id) DO NOTHING;

-- pessoa "cliente de teste" (remetente do inbound sintético). tel +999000999002
-- (≠ linha, ≠ OWNER/MAIA reais). tipo 'dono' + perfil dono_total para poder
-- registrar transação; o nome deixa claro que é sonda.
INSERT INTO pessoas (id, tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
  VALUES ('5a2d2130-7bf8-5870-b0d6-1ee7775c1f47', '__probe__', '__probe__',
          'Cliente de Teste (sonda)', '+999000999002', 'dono', 'ativa')
  ON CONFLICT (tenant_id, agent_id, telefone_whatsapp) DO NOTHING;

-- agent_audience_profiles ATIVO — sem ele o resolver quarentena a pessoa
-- (fail-closed) e o agente nunca responde.
INSERT INTO agent_audience_profiles (tenant_id, agent_id, pessoa_id, audience_type, trust_level, status, permission_profile_ids)
  VALUES ('__probe__', '__probe__', '5a2d2130-7bf8-5870-b0d6-1ee7775c1f47',
          'owner', 'trusted_internal', 'active', '{dono_total}'::text[])
  ON CONFLICT (pessoa_id) DO NOTHING;

-- entidade + conta da sonda (fixtures do register_transaction).
INSERT INTO entidades (id, tenant_id, agent_id, nome, tipo, status)
  VALUES ('46691ceb-2a90-5eef-ba77-445763433efb', '__probe__', '__probe__',
          'Entidade Sonda', 'pf', 'ativa')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO contas_bancarias (id, tenant_id, agent_id, entidade_id, banco, apelido, tipo, saldo_atual, status)
  VALUES ('21e4d7f3-ae55-574b-923b-eaa2345db9ec', '__probe__', '__probe__',
          '46691ceb-2a90-5eef-ba77-445763433efb', 'Banco Sonda', 'Conta Sonda', 'caixa', 0, 'ativa')
  ON CONFLICT (id) DO NOTHING;

-- permissão da pessoa sobre a entidade (profile pré-semeado dono_total, acoes ['*'])
-- — sem uma row ativa com entidade_id não-nulo a entidade não entra em
-- ctx.scope.entidades e a tool é negada.
INSERT INTO permissoes (id, tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, acoes_permitidas, status)
  VALUES ('3b316a06-0934-5358-9423-8a31ba57ad56', '__probe__', '__probe__',
          '5a2d2130-7bf8-5870-b0d6-1ee7775c1f47', '46691ceb-2a90-5eef-ba77-445763433efb',
          'dono', 'dono_total', '{*}'::text[], 'ativa')
  ON CONFLICT (pessoa_id, entidade_id) DO NOTHING;

-- grant do pack domain.finance ao agente da sonda (torna register_transaction
-- visível/chamável). baseline.core + domain.calendar mantidos por paridade.
INSERT INTO agent_tool_grants (id, tenant_id, agent_id, granted_packs, granted_by, reason)
  VALUES ('4b2f5721-93a9-5931-9eeb-2cd88858eda6', '__probe__', '__probe__',
          '{baseline.core,domain.calendar,domain.finance}'::text[], 'system', 'synthetic probe seed')
  ON CONFLICT (tenant_id, agent_id) DO NOTHING;
