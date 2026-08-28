-- 137 — issue #513 (fatia A): a POSSE de uma sessão de canal como DADO do banco.
--
-- O PROBLEMA. `src/gateway/line-session-manager.ts` declara, na própria
-- abertura: "Topologia v1: in-process (N sockets)". A posse de uma linha vive
-- em `Map`s locais do processo. Com UMA réplica isso é correto por acidente:
-- não há com quem competir. Com duas, ambas abrem o mesmo socket, disputam o
-- mesmo auth state e enviam em duplicidade — o split-brain de sessão que a
-- issue #513 existe para impedir.
--
-- A DECISÃO. A posse deixa de ser uma estrutura de memória e passa a ser uma
-- linha do PostgreSQL, com o "no máximo um dono por canal" expresso como
-- CONSTRAINT (`channel_id` é a PK), não como convenção que o código promete
-- respeitar. Duas réplicas que disputam a mesma linha produzem exatamente um
-- vencedor porque o banco não tem como produzir dois.
--
-- POR QUE `fencing_token` É `bigint` E NÃO `uuid`. O resto da casa usa
-- `claim_token uuid` (097/114 em `agent_turns`, 121 em `outbound_messages`), e
-- normalmente a coerência de vocabulário venceria. Aqui não vence, por um
-- motivo específico: a issue exige que o token AUMENTE a cada takeover
-- ("Cada nova posse incrementa `fencing_token`"), e um uuid não ordena. Um
-- fence só serve se um portador conseguir provar que o token que lhe
-- apresentam é ANTERIOR ao seu — comparação, não igualdade. `bigint` compara.
--
-- POR QUE A LINHA NUNCA É APAGADA. A monotonicidade do token depende disso.
-- Se `release` fizesse `DELETE`, o próximo `acquire` começaria de novo em 1 e
-- um dono antigo, voltando de uma partição de rede com o token 1 na mão,
-- reapresentaria um token que voltou a valer. Por isso `release` marca
-- `status` e PRESERVA `fencing_token`: a linha por canal é permanente e o
-- contador só sobe. O custo é uma linha por canal, para sempre — barato ao
-- lado de um envio pela linha errada.
--
-- O RELÓGIO É O DO BANCO. Todo prazo aqui é avaliado com `now()` do
-- PostgreSQL, nunca com o `Date.now()` de uma réplica. "Clock skew dos
-- containers" está listado na própria issue como cenário de fault injection;
-- uma réplica com o relógio adiantado poderia declarar vencida uma lease viva
-- e roubar uma linha em uso. Com o relógio do banco há UMA fonte de verdade.
--
-- Tabela NOVA e VAZIA: `BEGIN/COMMIT` e nenhum `CONCURRENTLY` — fora da
-- armadilha de índice inválido da #658, que só existe para índice criado
-- concorrentemente sobre tabela com tráfego.

BEGIN;

CREATE TABLE channel_session_leases (
  -- A PK é o CANAL, não um id sintético. É esta escolha que torna
  -- "no máximo um dono por linha" uma garantia do banco: não existe forma de
  -- inserir uma segunda posse do mesmo canal, nem sob concorrência.
  channel_id        uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,

  -- A posse SEMPRE carrega tenant e agente. A issue pede isso explicitamente
  -- ("Lease sempre inclui tenant e agent"): a auditoria da transição precisa
  -- cair no tenant certo, e um varredor cross-tenant precisa saber de quem é a
  -- linha que ele acabou de encontrar vencida.
  tenant_id         text NOT NULL,
  agent_id          text NOT NULL,

  -- Quem é o dono. É a identidade do PROCESSO (uma réplica), não do host: duas
  -- réplicas no mesmo host são dois donos distintos.
  owner_instance_id text NOT NULL,

  -- O fence. Monotônico POR CANAL, incrementado a cada nova posse. Um portador
  -- com token menor que o corrente perdeu a linha, ainda que não saiba disso.
  fencing_token     bigint NOT NULL DEFAULT 1,

  acquired_at       timestamptz NOT NULL DEFAULT now(),
  heartbeat_at      timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz NOT NULL,

  -- `active`  — há um dono vivo (ou uma lease vencida ainda não tomada).
  -- `released`— o dono devolveu a linha de propósito (shutdown limpo). A linha
  --             fica reivindicável IMEDIATAMENTE, sem esperar o prazo vencer:
  --             é a diferença entre um deploy ordenado e uma queda.
  status            text NOT NULL DEFAULT 'active',

  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT channel_session_leases_status_chk
    CHECK (status IN ('active', 'released')),

  -- Uma lease que nasce vencida é um bug de quem chamou, não um estado
  -- legítimo: seria posse que nunca autoriza nada e que qualquer réplica pode
  -- tomar no instante seguinte.
  CONSTRAINT channel_session_leases_prazo_chk
    CHECK (lease_expires_at > acquired_at),

  CONSTRAINT channel_session_leases_fence_positivo_chk
    CHECK (fencing_token > 0),

  -- Fail-closed contra o literal reservado (invariante 8 do AGENTS.md). Uma
  -- posse gravada sob `default` seria posse GLOBAL disfarçada: o varredor
  -- cross-tenant a devolveria para qualquer tenant que perguntasse.
  CONSTRAINT channel_session_leases_sem_default_chk
    CHECK (tenant_id <> 'default' AND agent_id <> 'default'
           AND length(tenant_id) > 0 AND length(agent_id) > 0),

  CONSTRAINT channel_session_leases_dono_nao_vazio_chk
    CHECK (length(owner_instance_id) > 0)
);

-- A varredura de lease VENCIDA é feita FORA de contexto de tenant — a pergunta
-- "quais linhas estão órfãs?" é do operador da instalação inteira, não de um
-- tenant. É o mesmo desenho do índice de lease vencida da 114 (turnos) e do de
-- takeover da 131 (outbound). Parcial em `status='active'`: uma linha
-- `released` já é reivindicável e não precisa aparecer na varredura de órfãs.
CREATE INDEX channel_session_leases_vencidas_idx
  ON channel_session_leases (lease_expires_at)
  WHERE status = 'active';

-- Quais linhas ESTA réplica pensa possuir — usado no shutdown (devolver tudo o
-- que é meu) e no reconciliador de boot (um processo que reinicia rápido pode
-- reencontrar as próprias leases ainda vivas em vez de esperar vencerem).
CREATE INDEX channel_session_leases_dono_idx
  ON channel_session_leases (owner_instance_id)
  WHERE status = 'active';

-- Inventário por tenant/agente, para o console e para a métrica de sessões
-- possuídas.
CREATE INDEX channel_session_leases_tenant_agente_idx
  ON channel_session_leases (tenant_id, agent_id);

COMMIT;
