-- 133 — a STREAM BLOQUEADA por poison message, como dado (issue #629, fatia F
-- da #505; fase 8 e última do rollout da issue-mãe).
--
-- ─── A escolha que esta tabela torna possível ──────────────────────────────
--
-- A issue-mãe (#505, §"Falha, retry e DLQ") exige que, ao esgotar tentativas, a
-- política escolha CONSCIENTEMENTE entre duas saídas incompatíveis:
--
--   * `dead_letter` terminal que LIBERA o próximo turno — preserva
--     disponibilidade às custas da semântica (a conversa responde M2 sem nunca
--     ter respondido M1);
--   * STREAM BLOQUEADA para intervenção — preserva a semântica às custas da
--     conversa (nada mais anda até um operador olhar).
--
-- Até a #627 só a primeira existia, e existia por OMISSÃO: `dead_letter` é
-- terminal, um turno terminal sai do predicado de head-of-line, e o sucessor
-- passa a ser reivindicável sem que ninguém tenha DECIDIDO isso. Deixar essa
-- escolha implícita é literalmente a falha nº 5 da issue-mãe ("um turno em DLQ
-- bloqueia a stream para sempre" — e o seu oposto, que é o que acontecia aqui:
-- um turno em DLQ não bloqueia nada, nem quando deveria).
--
-- ─── Por que uma TABELA, e não uma coluna em `agent_turns` ────────────────
--
-- O bloqueio é da STREAM, não do turno. Um marcador em `agent_turns` teria de
-- ser lido "existe algum turno desta stream com o marcador ligado?" — a mesma
-- varredura de histórico que a migration 126 existe para eliminar, e sobre uma
-- tabela que só cresce. Aqui a pergunta é um lookup por chave primária lógica
-- num conjunto que, em operação saudável, é VAZIO.
--
-- E há a razão de vocabulário: o bloqueio tem ciclo de vida próprio (quem
-- bloqueou, por quê, quem desbloqueou, quando, com que justificativa) e esse
-- ciclo não é o do turno. Enfiá-lo numa coluna do turno faria o desbloqueio ser
-- uma escrita no turno morto — que é exatamente o `UPDATE agent_turns` à mão
-- que o runbook proíbe.
--
-- ─── O índice único PARCIAL é a idempotência ──────────────────────────────
--
-- `agent_stream_blocks_active_uq` sobre `(tenant_id, agent_id, stream_key)`
-- `WHERE unblocked_at IS NULL` é o que faz "no máximo UM bloqueio ativo por
-- stream" ser propriedade do banco. Duas conclusões terminais simultâneas da
-- mesma stream (o head e um irmão absorvido) produzem UMA linha e um
-- `ON CONFLICT DO NOTHING` — nunca duas, nunca um bloqueio que o desbloqueio
-- de um operador não consegue apagar por inteiro.
--
-- O parcial também é o que permite HISTÓRICO: linhas já desbloqueadas ficam,
-- porque "esta conversa já foi envenenada três vezes este mês" é a pergunta
-- que decide se o problema é a mensagem ou a integração.
--
-- ─── Por que NÃO há `CONCURRENTLY` ────────────────────────────────────────
--
-- A tabela NASCE aqui e nasce vazia: não existe leitura concorrente a proteger
-- nem varredura a fazer. Consequência boa e deliberada — este arquivo não está
-- exposto à armadilha da issue #658 (um `CREATE INDEX CONCURRENTLY` que falha
-- deixa `pg_index.indisvalid = false`, e reaplicar a migration DEVOLVE SUCESSO,
-- marcando-a como aplicada sem o índice). Aqui tudo cabe num único átomo, e o
-- envelope `BEGIN`/`COMMIT` é o que garante que "tabela sem índice único" não
-- seja um estado alcançável — nesse estado o bloqueio deixaria de ser
-- idempotente e duas linhas ativas tornariam o desbloqueio parcial.
--
-- ─── O CHECK de escopo, e por que ele repete o da 120 ─────────────────────
--
-- A invariante MUST nº 8 do repositório recusa o literal `default` em caminho
-- dinâmico. Uma stream bloqueada sob `default` seria um bloqueio GLOBAL
-- disfarçado — todo tenant sem escopo resolvido cairia nele. O código de
-- aplicação já recusa; o banco recusa também porque um backfill ou um `psql` de
-- incidente não passa pelo código de aplicação.
--
-- Ver docs/runbooks/turn-state-machine.md §14.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_stream_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  stream_key text NOT NULL,

  -- POR QUE a stream está bloqueada. Vocabulário fechado, espelhado em
  -- src/runtime/turns/poison-policy.ts (STREAM_BLOCK_REASONS).
  reason text NOT NULL,
  -- A CATEGORIA de erro que decidiu o bloqueio (POISON_CATEGORIES). É o que
  -- torna a decisão auditável: "esta conversa parou porque a política manda
  -- bloquear efeito já comitado", e não "esta conversa parou".
  category text NOT NULL,
  -- O turno envenenado. Sem FK, como promoted_by_turn_id (127): a coluna é
  -- FORENSE, e uma FK faria a limpeza de histórico de um turno antigo virar
  -- falha de integridade em cima de um bloqueio vivo.
  blocked_by_turn_id uuid NOT NULL,
  -- `last_error_code` do turno envenenado, já sanitizado ([a-z0-9_]{1,64}).
  -- NUNCA a mensagem: o resumo do erro pode conter conteúdo do usuário.
  error_code text,
  blocked_at timestamptz NOT NULL DEFAULT now(),

  -- O desbloqueio é OPERAÇÃO DE OPERADOR, e as três colunas juntas são a
  -- prova de que ela foi consciente. `unblocked_at IS NULL` é o predicado do
  -- índice parcial — isto é, o próprio estado "bloqueada".
  unblocked_at timestamptz,
  unblocked_by text,
  unblock_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_stream_blocks_scope_chk CHECK (
    tenant_id <> 'default' AND agent_id <> 'default'
    AND length(tenant_id) > 0 AND length(agent_id) > 0
    AND length(stream_key) > 0
  ),
  -- Fail-closed contra desbloqueio "meio feito": um `unblocked_at` sem autor
  -- nem justificativa é indistinguível de um bug de escrita, e o histórico
  -- perderia exatamente a informação pela qual ele existe.
  CONSTRAINT agent_stream_blocks_unblock_chk CHECK (
    (unblocked_at IS NULL AND unblocked_by IS NULL AND unblock_reason IS NULL)
    OR (unblocked_at IS NOT NULL AND unblocked_by IS NOT NULL
        AND length(unblocked_by) > 0 AND unblock_reason IS NOT NULL
        AND length(unblock_reason) > 0)
  )
);

-- A idempotência do bloqueio. Ver o cabeçalho.
CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_blocks_active_uq
  ON agent_stream_blocks (tenant_id, agent_id, stream_key)
  WHERE unblocked_at IS NULL;

-- O histórico por stream, para "esta conversa já foi envenenada antes?".
CREATE INDEX IF NOT EXISTS agent_stream_blocks_history_idx
  ON agent_stream_blocks (tenant_id, agent_id, stream_key, blocked_at DESC);

COMMENT ON TABLE agent_stream_blocks IS
  'issue 629: STREAM BLOQUEADA para intervencao — a segunda saida da politica de poison/DLQ da issue 505. Uma linha ATIVA (unblocked_at IS NULL) por (tenant, agent, stream_key) faz o claim recusar todo turno da conversa com stream_poisoned. Linhas desbloqueadas ficam como historico.';

COMMENT ON COLUMN agent_stream_blocks.reason IS
  'issue 629: vocabulario fechado (STREAM_BLOCK_REASONS em src/runtime/turns/poison-policy.ts). Hoje so `poison`; o campo existe para que um segundo motivo de bloqueio nao precise de migration.';

COMMENT ON COLUMN agent_stream_blocks.category IS
  'issue 629: a categoria de erro (POISON_CATEGORIES) que a politica classificou e que decidiu bloquear em vez de liberar. E o unico dado que permite auditar a DECISAO, e nao so o efeito.';

COMMENT ON COLUMN agent_stream_blocks.blocked_by_turn_id IS
  'issue 629: o turno que foi para dead_letter e envenenou a stream. Sem FK, como promoted_by_turn_id (127) — a coluna e forense.';

COMMIT;
