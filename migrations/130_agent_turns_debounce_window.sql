-- maia:no-transaction
-- 130 — a JANELA DE DEBOUNCE como DADO do PostgreSQL (issue #628, fatia E da
-- #505; fase 7 do rollout da issue-mãe).
--
-- ─── A frase que esta migration existe para tornar verdadeira ──────────────
--
-- "**Nenhum timer em memória é fonte de verdade.**"
--
-- Antes daqui a janela do debounce era um `setTimeout` da BullMQ mais uma
-- chave no Redis (`agent-debounce:<tenant>:<agent>:<phone>`, src/gateway/
-- debouncer.ts). Duas consequências, as duas listadas na issue:
--
--   1. com N réplicas, duas podiam fechar o MESMO batch — ou dois batches
--      SOBREPOSTOS — porque não havia um ponto único onde "este batch está
--      fechado" pudesse ser afirmado uma vez só;
--   2. um reinício de processo entre o `add` do job atrasado e o disparo dele
--      perdia a janela inteira: nada no PostgreSQL sabia que uma existia.
--
-- Depois daqui a janela é uma LINHA. Ela é aberta na MESMA transação que
-- persiste o ingresso (`createReceivedTurnTx`), estendida na MESMA transação do
-- ingresso seguinte, e fechada por um UPDATE cuja unicidade é do banco. Um
-- reinício não perde nada — o varredor reencontra a janela vencida e a fecha.
--
-- ─── Por que COLUNAS em `agent_turns`, e não uma tabela de janelas ─────────
--
-- A tentação é `agent_debounce_windows(tenant, agent, stream_key, deadline)`.
-- Está errada por uma razão estrutural: a janela e o TURNO-CABEÇA da stream são
-- a MESMA entidade. Quem executa a rajada é o head-of-line (#626) — o turno de
-- menor `first_ingress_seq` não terminal —, e é ele que absorve os irmãos e
-- carrega a fronteira `[first_ingress_seq, last_ingress_seq]` do batch. Uma
-- tabela à parte precisaria de uma FK para esse turno e de uma regra escrita à
-- mão para mantê-los em sincronia; duas linhas para um fato só é como o fato
-- fica com duas versões.
--
-- Com as colunas AQUI, "fechar o batch" e "enfileirar o head" são o mesmo
-- UPDATE, na mesma linha, na mesma transação — e a exclusão por stream que a
-- fatia B (#625) garante no banco vale automaticamente para a janela.
--
-- ─── As quatro colunas ────────────────────────────────────────────────────
--
--   * `debounce_window_opened_at` — o instante do PRIMEIRO ingresso da janela,
--     carimbado com `now()` do PostgreSQL. É a ÂNCORA DO TETO: o prazo nunca
--     passa de `opened_at + MESSAGE_DEBOUNCE_MAX_MS`, de modo que um usuário
--     que digita sem parar não adia a resposta para sempre. Guardá-lo (em vez
--     de recalcular do `created_at` da mensagem) é o que faz o teto sobreviver
--     ao reinício: o processo que estende a janela pode não ser o que a abriu.
--
--   * `debounce_deadline_at` — QUANDO o batch pode fechar. Reescrito a cada
--     ingresso novo da stream para `LEAST(opened_at + max_hold, now() + delay)`.
--     É o RELÓGIO PERSISTENTE que a issue exige: a comparação que autoriza o
--     fechamento é `debounce_deadline_at <= now()` avaliada NO BANCO, nunca um
--     `Date.now()` de réplica. Relógios de réplica divergem; o do PostgreSQL é
--     um só, e é o mesmo que decide `lease_expires_at` (#504).
--
--   * `debounce_closed_at` — o batch FECHOU. É a coluna que torna o fechamento
--     ÚNICO: o UPDATE que fecha exige `debounce_closed_at IS NULL`, então duas
--     réplicas que cheguem juntas produzem uma linha afetada e zero. Não é
--     "quem chegou primeiro ganha por convenção": é compare-and-swap.
--
--   * `debounce_batch_size` — quantos ingressos o batch consumiu. É o dado que
--     alimenta `maia_stream_debounce_batch_size` (critério de pronto da issue)
--     e, mais importante, é a EVIDÊNCIA FORENSE da composição: sem ele,
--     reconstruir meses depois "esta resposta respondeu a quantas mensagens?"
--     dependeria de recontar turnos `superseded`, que a limpeza de histórico
--     pode ter levado.
--
-- Todas NULLABLE e sem default: `NULL` em `debounce_deadline_at` significa
-- "este turno não tem janela" — turno anterior a esta fatia, turno de mídia
-- (que nunca entra em debounce) e turno gravado com a flag desligada. Um
-- default aqui inventaria janela para todo turno já existente e faria o
-- varredor tentar fechar o histórico inteiro no primeiro tick.
--
-- ─── O ÍNDICE, e por que ele é cross-tenant ───────────────────────────────
--
-- A pergunta do varredor é "QUAIS streams têm janela vencida?", feita FORA de
-- qualquer contexto de tenant — exatamente como `agent_turns_lease_expiry_idx`
-- (114) faz para lease vencida, e pela mesma razão: o varredor é um dispatcher
-- que descobre os pares (tenant, agent) com trabalho ANTES de abrir contexto
-- para cada um. Um índice prefixado por `tenant_id` não serve essa pergunta.
--
-- O predicado tira do índice tudo que não é janela ABERTA. O índice, portanto,
-- contém as janelas em voo — dezenas, não o histórico —, e ele ENCOLHE quando
-- o batch fecha. É a mesma economia do parcial do head-of-line (126): não
-- cresce com o tráfego, só com o que está pendente.
--
-- ─── CONCURRENTLY e a NÃO-ATOMICIDADE deste arquivo ───────────────────────
--
-- `agent_turns` é quente: um `CREATE INDEX` comum tomaria ACCESS EXCLUSIVE e
-- pararia claim, transição e conclusão pela duração da construção. Daí o
-- `CONCURRENTLY` — que o PostgreSQL RECUSA dentro de bloco de transação, daí o
-- marcador `maia:no-transaction`, e daí a consequência que precisa estar
-- escrita: este arquivo NÃO é atômico. O runner usa
-- `psql -v ON_ERROR_STOP=1 -f`, que autocommita por statement; se o índice
-- falhar, as colunas ficam.
--
-- Isso é seguro AQUI, e a razão é específica: os dois statements são
-- idempotentes (`IF NOT EXISTS`), e o estado intermediário — colunas sem índice
-- — é FUNCIONALMENTE CORRETO, só lento (o varredor faria seq scan). Reaplicar
-- conserta. Não vale a pena trocar isso por um `CREATE INDEX` bloqueante.
--
-- ARMADILHA VERIFICADA (issue #658, mesma da 124 e da 126): um
-- `CREATE INDEX CONCURRENTLY` que FALHA deixa `pg_index.indisvalid = false`, e
-- REAPLICAR este arquivo DEVOLVE SUCESSO — o `IF NOT EXISTS` acha o índice
-- inválido e responde `CREATE INDEX`. O runner marca a migration como aplicada
-- COM O ÍNDICE INVÁLIDO, e nada no output o distingue de um deploy bom.
-- Confira à mão depois de aplicar:
--
--   SELECT indexrelid::regclass, indisvalid, indisready
--     FROM pg_index
--    WHERE indexrelid::regclass::text = 'agent_turns_debounce_due_idx';
--
-- Ver docs/runbooks/turn-state-machine.md §13.

ALTER TABLE agent_turns
  ADD COLUMN IF NOT EXISTS debounce_window_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS debounce_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS debounce_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS debounce_batch_size integer;

COMMENT ON COLUMN agent_turns.debounce_window_opened_at IS
  'issue 628: instante (relogio do PostgreSQL) do PRIMEIRO ingresso da janela de debounce deste turno. Ancora do teto MESSAGE_DEBOUNCE_MAX_MS, e sobrevive ao reinicio do processo que a abriu. NULL = turno sem janela.';

COMMENT ON COLUMN agent_turns.debounce_deadline_at IS
  'issue 628: quando o batch PODE fechar. Reescrito a cada ingresso novo da stream para LEAST(opened_at + max_hold, now() + delay). E o relogio PERSISTENTE do debounce — a autorizacao de fechar e debounce_deadline_at <= now() avaliada no banco, nunca um Date.now() de replica.';

COMMENT ON COLUMN agent_turns.debounce_closed_at IS
  'issue 628: o batch FECHOU. O UPDATE que fecha exige debounce_closed_at IS NULL, entao duas replicas concorrentes produzem uma linha afetada e zero, de modo que o fechamento unico e compare-and-swap e nao convencao.';

COMMENT ON COLUMN agent_turns.debounce_batch_size IS
  'issue 628: quantos ingressos o batch fechado consumiu. Alimenta maia_stream_debounce_batch_size e e a evidencia forense da composicao do batch depois que os turnos superseded sairem do historico.';

CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_turns_debounce_due_idx
  ON agent_turns (debounce_deadline_at)
  WHERE debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL;
