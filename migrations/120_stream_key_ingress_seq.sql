-- 118 — identidade de STREAM e sequência de ingresso (issue #505, fases 1–2:
-- shadow mode). Aditiva e reversível: nada existente muda de forma.
--
-- ─── O que uma "stream" é, e por que ela não pode ser a conversa ────────────
--
-- A #505 exige FIFO POR CONVERSA sem serializar a fila inteira. A unidade de
-- serialização precisa existir NO INGRESSO — antes de qualquer resolução de
-- identidade — porque é ali que a ordem de chegada é decidida. `conversa_id`
-- não serve: `agent_turns.conversa_id` é NULLABLE por construção (o inbound é
-- persistido ANTES da resolução, ver src/gateway/baileys.ts), e uma unidade de
-- ordenação que às vezes é NULL colapsa em "todo mundo na mesma stream", que é
-- exatamente a serialização global que a issue proíbe.
--
-- A `stream_key` é derivada de material que JÁ existe no ingresso:
-- `tenant_id`, `agent_id`, o canal (linha) e a identidade remota normalizada.
-- A derivação canônica, versionada e à prova de ambiguidade vive em
-- src/runtime/turns/stream-key.ts — este arquivo só guarda o resultado.
--
-- ─── Por que NULLABLE nesta fase ────────────────────────────────────────────
--
-- Fases 1–2 do rollout da issue (§Migration and Rollout) são SHADOW: as colunas
-- passam a ser preenchidas para ingressos NOVOS, e nada as lê para decidir. Row
-- histórica fica NULL — não há backfill nesta fatia, porque inventar ordem
-- histórica que nunca existiu seria pior que admitir que ela não existe
-- (§Backfill: "não inventar ordem histórica precisa quando ela não existe").
-- Toda leitura futura tem de tratar NULL como "anterior ao protocolo".
--
-- ─── `mensagens.ingress_seq` vs `agent_turn_inputs.ingress_seq` ─────────────
--
-- São coisas DIFERENTES e o nome colide de propósito com o já existente, então
-- registre a distinção aqui em vez de descobri-la num incidente:
--
--   * `agent_turn_inputs.ingress_seq` (migration 097) é a POSIÇÃO da mensagem
--     DENTRO do turno (0 = representativa, 1..n = irmãs absorvidas pelo
--     debounce). Escopo: um turno. Começa em 0. `integer`.
--   * `mensagens.ingress_seq` (aqui) é a POSIÇÃO da mensagem DENTRO DA STREAM,
--     monotônica desde o nascimento da stream e independente de turno. Escopo:
--     uma stream. Começa em 1. `bigint` — uma stream longeva pode acumular
--     muito mais que 2^31 eventos ao longo de anos, e migrar o tipo depois
--     exigiria reescrever a tabela mais quente do runtime.
--
-- O `0` NUNCA é uma sequência de stream válida (ver o CHECK na migration 119):
-- é o valor de partida do CONTADOR, e a primeira alocação já devolve 1. Isso
-- torna "seq ausente" e "primeira seq" distinguíveis sem consultar o contador.
--
-- ─── `agent_stream_sequences`: por que uma tabela de contador ──────────────
--
-- A alocação precisa ser monotônica POR STREAM e segura sob múltiplos
-- produtores (§Sequência de ingresso). Três candidatos foram considerados:
--
--   (a) `SELECT max(ingress_seq)+1 FROM mensagens WHERE stream…` — não é
--       atômico: dois produtores leem o mesmo max e alocam o mesmo número. Só
--       ficaria correto sob `SERIALIZABLE` ou um lock explícito, e o lock
--       teria de ser sobre uma linha que talvez ainda não exista.
--   (b) uma SEQUENCE do Postgres por stream — `CREATE SEQUENCE` é DDL, e criar
--       DDL no hot path do ingresso é inaceitável (catálogo cresce sem limite,
--       e DDL não é transacionalmente barata).
--   (c) uma LINHA de contador por stream, incrementada com
--       `INSERT … ON CONFLICT DO UPDATE … RETURNING` — uma única declaração
--       atômica. O lock da linha serializa APENAS a stream em questão; streams
--       distintas não se veem. É esta.
--
-- A escolha (c) tem uma propriedade que (b) não tem e que a issue exige: o
-- contador é TRANSACIONAL. Um rollback devolve o número — logo, uma reentrega
-- que colide na unique de `mensagens` aborta a transação inteira e NÃO queima
-- sequência. É assim que "redelivery do mesmo evento reutiliza a sequência
-- original" (§Acceptance) fica garantido por construção, e não por um caminho
-- de compensação que alguém teria de lembrar de escrever.
--
-- A PK é `(tenant_id, agent_id, stream_key)` e não `(stream_key)` sozinha: a
-- `stream_key` já embute tenant e agent no material canônico, mas embutir não
-- é o mesmo que ESCOPAR. Com o par na chave, uma stream_key forjada/colidida
-- não consegue nem endereçar o contador de outro tenant — o predicado do
-- `ON CONFLICT` não casa. É a invariante nº 1 do AGENTS.md escrita em chave
-- primária, e não em convenção de chamada.
--
-- `stream_key_version` NÃO é atualizado no `DO UPDATE`: ele registra qual
-- algoritmo MINTOU a stream. Uma versão nova produz `stream_key` diferente (a
-- versão é prefixo do próprio valor), portanto uma linha nova — a coluna aqui é
-- a evidência de origem, não um campo mutável.
--
-- ─── O que esta migration deliberadamente NÃO faz ──────────────────────────
--
--   * nenhum índice CONCURRENTLY (fica na 119, que é `no-transaction`);
--   * nenhuma constraint CHECK (idem — validá-las exige varredura, e varrer
--     `mensagens` sob ACCESS EXCLUSIVE é janela de perda de ingresso);
--   * nenhuma exclusão "no máximo um turno ativo por stream" — isso é fase 5+
--     do rollout e uma fatia própria;
--   * nenhum backfill.

ALTER TABLE mensagens
  ADD COLUMN IF NOT EXISTS stream_key text,
  ADD COLUMN IF NOT EXISTS stream_key_version smallint,
  ADD COLUMN IF NOT EXISTS ingress_seq bigint;

COMMENT ON COLUMN mensagens.stream_key IS
  'Issue #505: identidade DURÁVEL da stream de ordenação (tenant+agent+canal+identidade remota). Derivada por src/runtime/turns/stream-key.ts. NULL = ingresso anterior ao protocolo (sem backfill).';
COMMENT ON COLUMN mensagens.stream_key_version IS
  'Issue #505: versão do algoritmo que derivou stream_key. Persistida para que uma troca de algoritmo seja detectável em vez de silenciosa.';
COMMENT ON COLUMN mensagens.ingress_seq IS
  'Issue #505: posição monotônica DESTE ingresso dentro da stream (>=1). NÃO confundir com agent_turn_inputs.ingress_seq, que é a posição dentro do turno e começa em 0.';

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS stream_key text,
  ADD COLUMN IF NOT EXISTS stream_key_version smallint,
  ADD COLUMN IF NOT EXISTS first_ingress_seq bigint,
  ADD COLUMN IF NOT EXISTS last_ingress_seq bigint;

COMMENT ON COLUMN agent_turns.stream_key IS
  'Issue #505: a stream a que este turno pertence. Igual à stream_key da mensagem representativa.';
COMMENT ON COLUMN agent_turns.stream_key_version IS
  'Issue #505: versão do algoritmo que derivou stream_key.';
COMMENT ON COLUMN agent_turns.first_ingress_seq IS
  'Issue #505: menor ingress_seq consumido por este turno. Turno simples: igual a last_ingress_seq.';
COMMENT ON COLUMN agent_turns.last_ingress_seq IS
  'Issue #505: maior ingress_seq consumido por este turno. É a fronteira que o head-of-line de fases posteriores compara.';

CREATE TABLE IF NOT EXISTS agent_stream_sequences (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  stream_key text NOT NULL,
  -- Versão do algoritmo que MINTOU a stream (não muda no incremento).
  stream_key_version smallint NOT NULL,
  -- Última sequência ENTREGUE. 0 = linha recém-criada que ainda não entregou
  -- nada; a primeira alocação devolve 1. Ver o CHECK de `>= 0`.
  last_ingress_seq bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_stream_sequences_pk PRIMARY KEY (tenant_id, agent_id, stream_key),
  CONSTRAINT agent_stream_sequences_seq_chk CHECK (last_ingress_seq >= 0),
  CONSTRAINT agent_stream_sequences_version_chk CHECK (stream_key_version >= 1),
  -- Fail-closed no BANCO contra o literal que a invariante MUST nº 8 recusa.
  -- Uma stream sob `default` seria a stream genérica que a issue proíbe
  -- (§Falhas 8), e o único jeito de ela NUNCA existir é o banco recusá-la —
  -- o código de aplicação pode ser contornado por um backfill ou por psql.
  CONSTRAINT agent_stream_sequences_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
    AND length(stream_key) > 0
  )
);

COMMENT ON TABLE agent_stream_sequences IS
  'Issue #505: contador transacional de ingresso POR STREAM. Uma linha por (tenant, agent, stream_key); o incremento é INSERT … ON CONFLICT DO UPDATE … RETURNING, atômico e monotônico, e o rollback devolve o número (é isso que faz redelivery não queimar sequência).';
