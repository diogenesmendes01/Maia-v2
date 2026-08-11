-- maia:no-transaction
-- 096 — Índices em `mensagens` que sustentam a máquina de estados do turno
-- (issue #503). Separado da 097 (que cria as tabelas) por DOIS motivos:
--
--   1. `mensagens` é a maior tabela quente do runtime. Construir índice nela
--      dentro da transação da migration bloquearia INSERT de inbound durante
--      todo o build — janela de perda de mensagem no ingresso. Daí
--      CONCURRENTLY + o marcador `maia:no-transaction` (ver scripts/migrate.ts).
--   2. A 097 declara FK COMPOSTA `agent_turn_inputs (tenant_id, agent_id,
--      mensagem_id) -> mensagens (tenant_id, agent_id, id)`. Postgres exige um
--      índice ÚNICO sobre exatamente essas colunas no lado referenciado, então
--      ele precisa existir ANTES — e migrations rodam em ordem de prefixo.
--
-- Restrição do runner no modo no-transaction: SÓ statements simples terminados
-- por `;` (sem `DO $$`, sem literal com `;`). Todos abaixo são idempotentes via
-- IF NOT EXISTS, então um re-run após crash é seguro.
--
-- NOTA OPERACIONAL: CREATE INDEX CONCURRENTLY que falha (deadlock, cancelamento)
-- deixa um índice INVÁLIDO. O `_down` derruba ambos por nome, então o remédio é
-- rodar o down e reaplicar. Ver docs/runbooks/migrations.md.

-- (1) Alvo da FK composta da 097. É a chave natural da row + o escopo de
-- isolamento; `id` já é PK (logo já é único), então a unicidade do trio é
-- consequência — a criação NÃO pode falhar por duplicata.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_mensagens_tenant_agent_id
  ON mensagens (tenant_id, agent_id, id);

-- (2) Varredura do backfill (scripts/backfill-agent-turns.ts) e do verificador
-- de divergência entre `agent_turns.status` terminal e a projeção legada
-- `processada_em`. Ambos varrem inbound POR (tenant, agent) em ordem de
-- chegada. O índice parcial `direcao = 'in'` mantém o custo proporcional ao
-- inbound, ignorando o outbound (que não gera turno).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_inbound_scope_created
  ON mensagens (tenant_id, agent_id, created_at, id)
  WHERE direcao = 'in';
