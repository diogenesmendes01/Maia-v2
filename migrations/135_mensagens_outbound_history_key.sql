-- maia:no-transaction
-- 135 — a CHAVE IDEMPOTENTE do histórico de saída (issue #635, fatia F da #506).
--
-- ─── O defeito que esta migração fecha ─────────────────────────────────────
--
-- A #506 exige, textualmente: "a gravação da mensagem de saída no histórico
-- deve usar `outbound_id`/provider ID como chave idempotente; retry de
-- persistência não cria duplicata". Até aqui a idempotência do histórico era
-- inteiramente DE ESTADO (`completeDeliveryTx`: ou a linha vai a `completed`
-- COM a row de `mensagens`, ou nenhuma das duas). Essa garantia é real e
-- continua valendo, mas ela tem exatamente um escritor. A #635 acrescenta o
-- SEGUNDO — a reconciliação, que fabrica o histórico perdido na janela
-- `delivered -> completed` —, e a partir de dois escritores a unicidade não
-- pode mais ser um efeito colateral de uma máquina de estados: precisa ser uma
-- declaração do banco.
--
-- `mensagens` não tinha COMO expressá-la. A unicidade da tabela é por `id`
-- (001) e por `whatsapp_id` no ingresso (003/090); a saída não tinha chave
-- nenhuma. O predicado que a #633 usou como substituto —
-- `metadata->>'in_reply_to'` — não é uma chave e erra num caso REAL desta
-- fatia: numa resposta MULTIPART os dois artefatos do turno compartilham o
-- mesmo `in_reply_to`, então o histórico do artefato 0 faz a leitura responder
-- "já existe" para o artefato 1, e o histórico do artefato 1 é perdido em
-- silêncio — com a linha marcada `completed`, ou seja, mentindo.
--
-- ─── Por que a coluna e não um campo em `metadata` ─────────────────────────
--
-- Um índice único sobre expressão JSONB (`(metadata->>'outbound_id')`) daria a
-- mesma unicidade e é o que dispensaria migração de schema. Foi descartado por
-- duas razões, e a segunda é a que decide:
--
--  1. o índice de expressão é maior e mais caro de manter (extração + cast a
--     cada escrita de `mensagens`, a tabela mais quente do runtime);
--  2. `metadata` é jsonb SEM schema. Um valor de tipo errado ali (número,
--     objeto, string vazia) não é recusado por nada — ele só produz uma chave
--     que não colide, e uma chave que não colide é o duplicado de volta. A
--     coluna `uuid` torna o valor malformado INEXPRIMÍVEL, que é a mesma razão
--     pela qual a 121 pôs `turn_id` em coluna própria em vez de no payload.
--
-- ─── Por que PARCIAL (`WHERE outbound_id IS NOT NULL`) ─────────────────────
--
-- Mesma disciplina da 121: todo `mensagens` já gravado — todo o ingresso, todo
-- o histórico anterior a esta fatia, e todo outbound de caminho que ainda não
-- tem linha durável (o regime de rollback de #631, a voz sintetizada de #634)
-- — fica FORA do índice. A criação não pode explodir com duplicata histórica
-- porque nenhuma row histórica entra nele, e o custo é proporcional ao
-- histórico ANCORADO, não à tabela.
--
-- ─── Por que sem FK para `outbound_messages` ───────────────────────────────
--
-- Uma FK simples para `outbound_messages(id)` seria expressável — a PK está
-- lá. Mas o alvo é uma tabela sob RETENÇÃO: o sweeper da #292 apaga
-- linhas antigas do outbox. Com FK, ou o histórico bloquearia a retenção, ou o
-- `ON DELETE SET NULL` apagaria a chave de dedupe justamente das linhas mais
-- antigas. A referência é deliberadamente SOFT, e o que ela precisa garantir —
-- "duas gravações do mesmo artefato produzem uma row" — é da unique, não da FK.
--
-- ─── Sem transação, e o que isso exige ─────────────────────────────────────
--
-- `mensagens` é a maior tabela quente do runtime. `CREATE UNIQUE INDEX
-- CONCURRENTLY` não roda dentro de bloco de transação, e a alternativa
-- (índice comum) reteria SHARE — bloqueio de ingresso durante a construção.
-- Mesmo raciocínio, e mesmo marcador, da 096 e da 122.
--
-- Todo statement abaixo é idempotente, então reaplicar o arquivo após um crash
-- é seguro. ATENÇÃO OPERACIONAL (issue #658): um `CREATE INDEX CONCURRENTLY`
-- interrompido deixa o índice INVÁLIDO e o runner NÃO detecta isso. Confira à
-- mão depois de aplicar:
--
--   SELECT indisvalid FROM pg_index
--    WHERE indexrelid = 'mensagens_outbound_history_uq'::regclass;
--
-- `f` ⇒ derrube o índice (`DROP INDEX CONCURRENTLY mensagens_outbound_history_uq`)
-- e reaplique este arquivo.

-- ── (1) A coluna. Catálogo apenas: nullable, sem DEFAULT, sem reescrita. ────
ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS outbound_id uuid;

-- ── (2) A CHAVE. O produto desta migração. ─────────────────────────────────
--
-- Escopada por (tenant_id, agent_id) e não global, pela invariante de
-- isolamento: o namespace de dedupe pertence ao par. Dois tenants com o mesmo
-- uuid de artefato (impossível na prática, mas a constraint não pode depender
-- disso) não colidem, e — o que importa mais — a sonda de leak tem um
-- predicado NOMEADO para exigir.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mensagens_outbound_history_uq
  ON mensagens (tenant_id, agent_id, outbound_id)
  WHERE outbound_id IS NOT NULL;

-- ── (3) A coerência de direção. ────────────────────────────────────────────
--
-- `outbound_id` só faz sentido numa row de SAÍDA. Sem este CHECK, um ingresso
-- carimbado por engano ocuparia a chave do artefato e a gravação legítima do
-- histórico seria recusada por unicidade — falha que apareceria como "o
-- histórico sumiu", longe da causa.
--
-- NOT VALID + VALIDATE separado: a adição é catálogo (lock curto) e JÁ protege
-- todo INSERT/UPDATE a partir dali; a varredura das linhas antigas corre depois
-- sob SHARE UPDATE EXCLUSIVE, que não conflita com o ingresso. Mesmo desenho da
-- 122. A varredura de hoje é trivial (a coluna acabou de nascer NULL em todas
-- as linhas), mas a FORMA importa mais que o custo de hoje.
--
-- Lógica ternária: o predicado começa por `outbound_id IS NULL OR ...`, que é
-- sempre booleano; nenhuma comparação fica exposta a NULL. `direcao` é NOT NULL
-- desde a 001, então o segundo operando também nunca é NULL.
ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_outbound_history_direcao_chk;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_outbound_history_direcao_chk CHECK (
  outbound_id IS NULL OR direcao = 'out'
) NOT VALID;

ALTER TABLE mensagens VALIDATE CONSTRAINT mensagens_outbound_history_direcao_chk;

COMMENT ON COLUMN mensagens.outbound_id IS
  'Issue #635: artefato do outbox (outbound_messages.id) que esta row de historico registra. Chave IDEMPOTENTE do historico de saida — unique PARCIAL por (tenant_id, agent_id, outbound_id). NULL = ingresso, historico anterior a esta fatia, ou saida sem linha duravel. Referencia SOFT de proposito: outbound_messages esta sob retencao (#292).';
