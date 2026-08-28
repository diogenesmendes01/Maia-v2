-- 137 — issue #513 (fatia A): FENCING TOKEN da posse de sessão de canal.
--
-- O PROBLEMA. `src/gateway/line-session-manager.ts` declara, na abertura:
-- "Topologia v1: in-process (N sockets)". A posse de uma linha vive em `Map`s
-- locais, e `startAdditionalLineSessions()` enumera TODAS as linhas ativas e
-- as abre localmente, sem reivindicar nada. Com uma réplica isso está certo
-- por ausência de adversário; com duas, ambas abrem o mesmo socket, disputam o
-- mesmo auth state e enviam em duplicidade.
--
-- POR QUE AQUI E NÃO NUMA TABELA NOVA. `channel_line_state` (migration 103) já
-- guarda a posse da sessão em `session_owner_instance` +
-- `session_owner_lease_expires_at`, com um escritor vivo
-- (`channel-pairing-worker.ts`) e um consumidor vivo (o endereçamento de
-- `disable`/`repair` à réplica que segura o socket). Criar uma segunda tabela
-- de posse daria DOIS donos declarados para o mesmo fato, e eles divergiriam:
-- `renewSessionLeases` é last-writer-wins por desenho declarado ("Não usa CAS
-- por dono"), então a réplica B se carimbaria como `session_owner_instance`
-- enquanto a réplica A segurasse a lease fenced — e o comando de `disable`
-- voltaria a ser consumido pela réplica ERRADA, que é exatamente o P1 que a
-- review da PR #528 fechou.
--
-- O que faltava não era uma tabela: era o FENCE.
--
-- POR QUE `bigint` E NÃO `uuid`. O resto da casa usa `claim_token uuid`
-- (097/114 em `agent_turns`, 121 em `outbound_messages`) e normalmente a
-- coerência de vocabulário venceria. Aqui não vence: a issue exige que o token
-- AUMENTE a cada takeover ("Cada nova posse incrementa `fencing_token`"), e
-- uuid não ordena. Um fence só serve se o portador puder provar que o token
-- que lhe apresentam é ANTERIOR ao seu — comparação, não igualdade.
--
-- POR QUE O TOKEN SOBREVIVE AO `release`. `releaseSessionOwnership` zera
-- `session_owner_instance`, e continuará zerando; o TOKEN não é zerado junto.
-- Se fosse, a próxima posse recomeçaria e um dono antigo, voltando de uma
-- partição de rede com o token velho na mão, o reapresentaria válido. As rows
-- de `channel_line_state` nunca são apagadas (não há um só `DELETE` no
-- código), então o contador é monotônico por canal para sempre.
--
-- O RELÓGIO É O DO BANCO. Todo prazo é avaliado com `now()` do PostgreSQL,
-- nunca com o `Date.now()` de uma réplica. "Clock skew dos containers" está
-- listado na própria issue como cenário de fault injection.
--
-- `ADD COLUMN` com DEFAULT constante é metadata-only desde o PG 11 — não
-- reescreve a tabela. O índice é criado sem `CONCURRENTLY` porque
-- `channel_line_state` tem UMA row por linha de WhatsApp (dezenas, não
-- milhões): a varredura sob lock é instantânea, e `CONCURRENTLY` traria a
-- armadilha de índice inválido da #658 sem nenhum ganho.

BEGIN;

-- 0 = esta linha NUNCA teve dono. A primeira posse grava 1.
ALTER TABLE channel_line_state
  ADD COLUMN IF NOT EXISTS session_fencing_token bigint NOT NULL DEFAULT 0;

-- Backfill EXPLÍCITO antes da CHECK. Rows que já têm dono registrado (escritas
-- pelo `renewSessionLeases` de hoje) nasceriam com token 0 e violariam a
-- coerência. Recebem 1: são a primeira posse conhecida daquela linha.
UPDATE channel_line_state
   SET session_fencing_token = 1
 WHERE session_owner_instance IS NOT NULL
   AND session_fencing_token = 0;

-- Coerência dos três campos, no mesmo espírito do CHECK de claim/lease da 121:
-- ter dono implica ter prazo e ter fence. O contrário NÃO vale — uma linha
-- devolvida fica sem dono e sem prazo, mas PRESERVA o token, que é justamente
-- o que impede o dono antigo de voltar a valer.
ALTER TABLE channel_line_state
  ADD CONSTRAINT channel_line_state_session_fence_chk
  CHECK (
    session_owner_instance IS NULL
    OR (session_owner_lease_expires_at IS NOT NULL AND session_fencing_token > 0)
  );

-- A varredura de posse ÓRFÃ é feita FORA de contexto de tenant: "quais linhas
-- ficaram sem dono vivo?" é pergunta do operador da instalação, não de um
-- tenant — um dono que morreu não deixa ninguém para perguntar em nome dele.
-- Mesmo desenho do índice de lease vencida da 114 (turnos) e do de takeover da
-- 131 (outbound).
CREATE INDEX IF NOT EXISTS channel_line_state_session_orfa_idx
  ON channel_line_state (session_owner_lease_expires_at)
  WHERE session_owner_instance IS NOT NULL;

COMMIT;
