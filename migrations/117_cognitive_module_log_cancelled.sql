-- 117 — `cognitive_module_log.status` passa a admitir `cancelled` (issue #507).
--
-- O DEFEITO QUE ISSO FECHA
--   `runCognitiveModule` (`src/cognition/runner.ts`) audita TODA execução de
--   módulo cognitivo. O vocabulário fechado da 008 era
--   ('success','timeout','error','skipped') — e não existia palavra para
--   "a tentativa foi CANCELADA".
--
--   Consequência concreta, com a lease do turno perdida no meio do round-trip
--   do reasoner (issue #504 §Fencing): ou o provedor terminava antes de alguém
--   olhar o sinal e a row dizia `success` — auditoria afirmando que um turno
--   que já não era nosso deu certo —, ou o abort caía no catch genérico e a row
--   dizia `error` com `fallback_triggered=true`, contaminando a taxa de
--   fallback (a métrica que mede quanto o PRODUTO degradou) com cancelamentos
--   administrativos. Nenhum dos dois é o fato.
--
-- POR QUE UM VALOR NOVO, E NÃO REUSAR `timeout`
--   `timeout` é o módulo estourando o próprio limite: a operação era nossa e
--   demorou demais. `cancelled` é a autoridade sobre o turno tendo mudado de
--   dono no meio do caminho. Colapsar os dois apagaria justamente a distinção
--   que a #507 precisa medir — quanto do orçamento vai embora por lentidão
--   versus quanto vai embora por takeover/shutdown.
--
-- ESCOPO
--   Só a lista fechada do CHECK muda; nenhuma linha existente é reescrita (o
--   valor é NOVO, então nenhuma row atual pode violar o CHECK ampliado).
--   Espelha 1:1 `RunModuleResult['status']` em `src/cognition/types.ts`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE `maia:no-transaction` E TRÊS FASES
-- ─────────────────────────────────────────────────────────────────────────────
--   Mesmo raciocínio da 115, e vale repetir porque é contraintuitivo. Sem o
--   marker, o runner (`src/migrations/runner.ts`) abre `BEGIN`, roda o arquivo
--   inteiro e só então `COMMIT`: o ACCESS EXCLUSIVE tomado pelo `DROP
--   CONSTRAINT` fica retido até o fim, e o `VALIDATE` — que sozinho tomaria
--   apenas SHARE UPDATE EXCLUSIVE — varre a tabela com o lock forte ainda
--   ativo. `cognitive_module_log` é a tabela de auditoria de TODO módulo
--   cognitivo (uma row por chamada de reasoner, classifier, drift, KSM…):
--   é grande e é quente. Bloquear INSERT nela pela varredura inteira faria o
--   runtime engasgar no caminho síncrono do turno.
--
--   FASE 1 — constraint nova sob nome TEMPORÁRIO, `NOT VALID`. ACCESS
--     EXCLUSIVE curto e só de catálogo. Daqui em diante a tabela está protegida
--     por DUAS constraints: a da 008 (válida) e a nova (`NOT VALID` já barra
--     INSERT/UPDATE — ela só dispensa a varredura das linhas ANTIGAS).
--   FASE 2 — `VALIDATE CONSTRAINT`: a varredura, em transação própria, sob
--     SHARE UPDATE EXCLUSIVE, que NÃO conflita com o ROW EXCLUSIVE dos INSERTs.
--   FASE 3 — troca curta: derruba a antiga e renomeia. Só catálogo.
--
--   CRASH-SAFETY (o runner marca `dirty` e nunca reaplica sozinho). Em toda
--   fronteira entre statements a tabela segue protegida por ao menos uma
--   constraint equivalente:
--     · morreu antes da fase 1 ..... só a 008 (válida)                 → OK
--     · morreu depois da fase 1 .... 008 + `_v117` NOT VALID           → OK
--     · morreu depois da fase 2 .... 008 + `_v117` válida              → OK
--     · morreu entre os dois
--       statements da fase 3 ....... só `_v117`, válida, nome errado   → OK
--   Reaplicar o arquivo conserta os três primeiros sem janela descoberta.
--   O quarto NÃO deve ser reaplicado cegamente (o `DROP … IF EXISTS _v117` da
--   fase 1 deixaria a tabela sem NENHUMA constraint entre dois statements).
--   Remediação, um statement:
--     ALTER TABLE cognitive_module_log
--       RENAME CONSTRAINT cognitive_module_log_status_check_v117
--                      TO cognitive_module_log_status_check;
--   e então `tsx scripts/migrate.ts repair --id 117_cognitive_module_log_cancelled.sql
--   --as applied --reason "..."`.
--
--   Como diferenciar os quatro casos:
--     SELECT conname, convalidated FROM pg_constraint
--      WHERE conrelid = 'cognitive_module_log'::regclass AND conname LIKE '%status%';

-- maia:no-transaction

-- ── FASE 1 — constraint nova, nome temporário, NOT VALID (catálogo, sem scan) ──
ALTER TABLE cognitive_module_log
  DROP CONSTRAINT IF EXISTS cognitive_module_log_status_check_v117;

ALTER TABLE cognitive_module_log
  ADD CONSTRAINT cognitive_module_log_status_check_v117
  CHECK (status IN ('success', 'timeout', 'error', 'skipped', 'cancelled')) NOT VALID;

-- ── FASE 2 — a varredura, em transação própria, sob SHARE UPDATE EXCLUSIVE ────
ALTER TABLE cognitive_module_log VALIDATE CONSTRAINT cognitive_module_log_status_check_v117;

-- ── FASE 3 — troca curta: só catálogo, sem varredura ─────────────────────────
ALTER TABLE cognitive_module_log DROP CONSTRAINT IF EXISTS cognitive_module_log_status_check;

ALTER TABLE cognitive_module_log
  RENAME CONSTRAINT cognitive_module_log_status_check_v117 TO cognitive_module_log_status_check;
