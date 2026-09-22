-- 147 — A ESCADA DE CANÁRIO como DADO (spec Maia+Hermes §10.1, §10 linha P12).
--
-- ─── O que esta tabela decide ──────────────────────────────────────────────
--
-- Em qual DEGRAU da escada do §10.1 um agente está. A escada em si é código
-- (`src/runtime/engines/canary-policy.ts`): ela responde "o que este degrau
-- permite?". O que faltava era o outro lado da pergunta — "em que degrau este
-- agente está?" — e ele não pode ser código, porque a resposta muda por
-- agente, por decisão humana, e precisa sobreviver a deploy.
--
-- Linha ausente = `off`. Não existe flag global que suba alguém de degrau, do
-- mesmo jeito que a 145 não tem flag global que ligue o Hermes: subir é
-- escrever UMA linha de UM escopo, com o ator e a evidência do aceite.
--
-- ─── Por que (tenant, agente), e não (tenant, agente, canal) ──────────────
--
-- Porque o §10.1 governa CAPACIDADE, e capacidade não é do canal. "Pode usar
-- dado real", "pode projetar memória privada", "pode publicar conhecimento
-- compartilhado" valem para o agente inteiro — um agente que pode aprender
-- pelo WhatsApp e não pelo console seria uma escada furada. O canal escolhe
-- MOTOR (145); o degrau escolhe o que qualquer motor pode fazer.
--
-- ─── Por que a coorte e a evidência são colunas, e não anotação ───────────
--
-- O §10.1 exige coorte "listada por IDs autorizados no backend" e o §10 lista
-- "evidência de aceite" como artefato da P12. Fora do banco, as duas viram
-- promessa: alguém sobe o degrau e a evidência fica num canal de chat. Aqui a
-- CHECK exige coorte a partir de `live_informational` e aceite a partir de
-- `shadow_offline`, então um degrau sem lastro não chega a existir.
--
-- Isso duplica `validateCanaryPolicy` de propósito. A validação em TypeScript
-- existe para o console recusar cedo e explicar; a CHECK existe porque o banco
-- é o último lugar por onde toda escrita passa, inclusive a feita à mão numa
-- madrugada.
--
-- ─── O que NÃO está aqui ───────────────────────────────────────────────────
--
-- Percentual, duração e throughput. O §10.1 fecha assim: "Não definir
-- percentuais, duração de canário ou throughput sem volume e janela
-- operacional conhecidos". Coluna vazia esperando número inventado é convite
-- a inventá-lo.
--
-- Tabela NOVA e VAZIA: sem `CONCURRENTLY`, com envelope BEGIN/COMMIT.
--
-- (146 está reservada pela branch do P09, nesta mesma leva.)

BEGIN;

CREATE TABLE IF NOT EXISTS agent_canary_policy (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  stage text NOT NULL DEFAULT 'off',
  -- Referência ao CADASTRO da coorte autorizada. Texto opaco de propósito: o
  -- §10.1 exige que a coorte venha do backend, e uma FK para uma tabela que
  -- ainda não existe prenderia esta migration à fatia que a criar.
  cohort_ref text,
  -- Quem aceitou o degrau atual e contra o quê. Sem ela, subir de degrau é uma
  -- edição de configuração indistinguível de um engano.
  acceptance_evidence_ref text,
  row_version bigint NOT NULL DEFAULT 1,
  -- Ator da última escrita. `app_users.id` é text; referência SOFT, como
  -- `updated_by` na 145.
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_canary_policy_pk PRIMARY KEY (tenant_id, agent_id),
  -- A ordem é a do §10.1. O CHECK é uma lista fechada porque um degrau que o
  -- código não conhece não tem como ser interpretado — e o lado seguro de
  -- "não sei" seria `off`, que esconderia a configuração errada em vez de
  -- mostrá-la.
  CONSTRAINT agent_canary_policy_stage_chk CHECK (stage IN (
    'off',
    'synthetic',
    'shadow_offline',
    'live_informational',
    'private_memory',
    'governed_shared_learning',
    'business_effect_tools'
  )),
  -- Coorte exigida a partir de `live_informational` — o primeiro degrau em que
  -- existe gente de verdade do outro lado (§10.1).
  CONSTRAINT agent_canary_policy_cohort_chk CHECK (
    stage IN ('off', 'synthetic', 'shadow_offline')
    OR (cohort_ref IS NOT NULL AND length(cohort_ref) > 0)
  ),
  -- Aceite exigido a partir de `shadow_offline` — o primeiro degrau em que
  -- algo sai do laboratório (snapshot de conversa real, ainda que minimizado).
  CONSTRAINT agent_canary_policy_acceptance_chk CHECK (
    stage IN ('off', 'synthetic')
    OR (acceptance_evidence_ref IS NOT NULL AND length(acceptance_evidence_ref) > 0)
  ),
  CONSTRAINT agent_canary_policy_row_version_chk CHECK (row_version >= 1),
  CONSTRAINT agent_canary_policy_updated_by_chk CHECK (length(updated_by) > 0),
  -- Mesmo fail-closed da 133/140/145: um degrau sob o literal `default` seria
  -- canário GLOBAL disfarçado.
  CONSTRAINT agent_canary_policy_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
  )
);

COMMENT ON TABLE agent_canary_policy IS
  'spec maia-hermes 10.1 (P12): degrau da escada de canario por (tenant, agente). Linha ausente = off; nenhuma flag global sobe ninguem de degrau. CHECK exige coorte a partir de live_informational e evidencia de aceite a partir de shadow_offline. Escrita por CAS em row_version.';

COMMENT ON COLUMN agent_canary_policy.cohort_ref IS
  'Referencia ao cadastro da coorte autorizada (10.1: IDs autorizados no backend). Nenhuma chave do usuario WhatsApp habilita Hermes.';

COMMENT ON COLUMN agent_canary_policy.acceptance_evidence_ref IS
  'Evidencia de ACEITE do degrau atual: quem autorizou e contra o que. Artefato exigido pelo 10 para a P12.';

COMMENT ON COLUMN agent_canary_policy.row_version IS
  'CAS: nasce 1 e sobe 1 por escrita aceita. Escrita com versao velha e recusada, nunca ultima-escrita-vence.';

COMMIT;
