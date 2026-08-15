-- 115 — novo outcome terminal `pending_race_lost` para `agent_turns`.
--
-- O DEFEITO QUE ISSO FECHA
--   Quando duas respostas do usuário chegam em paralelo para a MESMA pergunta
--   pendente, uma vence o `SELECT … FOR UPDATE` de
--   `pendingQuestionsRepo.findActiveForUpdate` e a outra perde. O invariante de
--   exatamente-uma-vez está intacto (issue #545): a ação é despachada uma vez
--   só, e a perna perdedora é auditada como `pending_race_lost`.
--
--   O problema era o que acontecia com a perna perdedora DEPOIS. O gate
--   colapsava esse desfecho em `{ kind: 'no_pending' }`, e `src/agent/core.ts`
--   lia isso como "não havia pendência nenhuma" e rodava o turno normal do
--   agente (ReAct) sobre uma mensagem que já tinha sido CLASSIFICADA como
--   resposta à pendência. Um "sim" que significava "opção sim da pergunta X"
--   virava um comando novo e livre para o LLM — mudança de significado num
--   caminho que, por definição, só existe sob concorrência.
--
--   O gate passa a devolver `{ kind: 'race_lost' }` e o core conclui o turno
--   sem ReAct. Este outcome é o registro durável dessa conclusão.
--
-- POR QUE `ignored`, E NÃO `completed`
--   `src/runtime/turns/contract.ts` reserva `completed` a turnos que EXECUTARAM
--   até o fim — entregaram resposta ou concluíram um determinismo de negócio —
--   e define `ignored` como "descarte intencional por regra explícita". A perna
--   perdedora não executou nada: quem despachou a ação foi o outro turno.
--   Marcá-la `completed` + `pending_action_resolved` afirmaria que ESTE turno
--   resolveu a pendência, o que é falso e apagaria a distinção forense entre a
--   perna vencedora e a perdedora justamente no cenário em que ela importa.
--
--   Como todo outcome de `ignored`, a conclusão vira uma linha
--   `turn_ignored_by_policy` em `audit_log` (`concludeTurn`), ao lado do
--   `pending_race_lost` que `src/agent/pending-resolver.ts` já escreve. Duas
--   linhas, dois fatos: a race foi perdida, e o turno foi descartado por isso.
--
-- ESCOPO DA MUDANÇA
--   Só a lista fechada de `status = 'ignored'` no CHECK composto muda. As duas
--   outras constraints da 097 (presença do outcome e vocabulário de status)
--   ficam intactas, e nenhuma linha existente é reescrita: o valor é NOVO, então
--   nenhuma row atual pode violar o CHECK ampliado. Espelha 1:1 `TERMINAL_OUTCOMES`
--   em `src/runtime/turns/contract.ts` — `tests/integration/agent-turns-real-db.spec.ts`
--   gera a matriz completa a partir daquelas constantes e falha se divergirem.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE `maia:no-transaction` E TRÊS FASES (e por que a versão anterior deste
-- arquivo PROMETIA o que não entregava)
-- ─────────────────────────────────────────────────────────────────────────────
--   A primeira versão era `DROP CONSTRAINT` + `ADD … NOT VALID` +
--   `VALIDATE CONSTRAINT` **sem marker**, e o comentário afirmava que o par
--   `NOT VALID` + `VALIDATE` evitava segurar ACCESS EXCLUSIVE durante a varredura.
--   Ela não evitava nada. Sem marker o arquivo roda no modo `runner`
--   (`src/migrations/runner.ts`): o runner abre `BEGIN`, executa o arquivo
--   INTEIRO e só então dá `COMMIT`. O ACCESS EXCLUSIVE tomado pelo `DROP` fica
--   retido até o fim da transação, e o `VALIDATE` — que sozinho tomaria apenas
--   SHARE UPDATE EXCLUSIVE — varre a tabela com o lock mais forte ainda ativo.
--   Em `agent_turns`, tabela quente, isso bloqueia escrita concorrente pela
--   varredura inteira: exatamente o risco que o texto dizia ter mitigado. Um
--   comentário assim é pior que nenhum, porque alguém confia nele numa janela
--   de manutenção.
--
--   Só há um jeito de a validação NÃO correr sob ACCESS EXCLUSIVE: ela precisa
--   estar em uma TRANSAÇÃO SEPARADA das DDLs que tomam esse lock. Daí o
--   `-- maia:no-transaction`: o runner passa a enviar um statement por vez, cada
--   um em autocommit, e a troca vira três fases.
--
--   FASE 1 — constraint nova sob nome TEMPORÁRIO, `NOT VALID`.
--     ACCESS EXCLUSIVE curto e só de catálogo (sem varredura). A partir daqui a
--     tabela está protegida por DUAS constraints: a antiga (097, válida) e a
--     nova (NOT VALID já barra INSERT/UPDATE — `NOT VALID` só dispensa a
--     varredura das linhas ANTIGAS).
--   FASE 2 — `VALIDATE CONSTRAINT` do nome temporário.
--     Aqui está a varredura, e agora ela corre em transação própria, sob
--     SHARE UPDATE EXCLUSIVE, que NÃO conflita com ROW EXCLUSIVE: escrita
--     concorrente em `agent_turns` continua passando.
--   FASE 3 — troca curta: derruba a antiga e renomeia a nova para o nome
--     canônico. Dois statements de catálogo, sem varredura.
--
--   CRASH-SAFETY (o runner registra `dirty` se o processo morrer no meio, e
--   `dirty` NUNCA é reaplicado sozinho — um operador inspeciona antes). Em toda
--   fronteira entre statements a tabela continua protegida por pelo menos uma
--   constraint equivalente:
--     · morreu antes da fase 1 ..... só a 097 (válida)                 → OK
--     · morreu depois da fase 1 .... 097 + `_v115` NOT VALID           → OK
--     · morreu depois da fase 2 .... 097 + `_v115` válida              → OK
--     · morreu entre os dois
--       statements da fase 3 ....... só `_v115`, válida, nome errado   → OK
--   Reaplicar o arquivo inteiro conserta os três primeiros casos sem janela
--   descoberta (o `DROP … IF EXISTS` da fase 1 só derruba `_v115` enquanto a
--   097 ainda está de pé).
--
--   O ÚNICO caso que NÃO deve ser reaplicado cegamente é o quarto: ali a antiga
--   já caiu, e o `DROP … IF EXISTS _v115` da fase 1 deixaria a tabela sem
--   NENHUMA constraint entre dois statements. Remediação, um statement só:
--     ALTER TABLE agent_turns
--       RENAME CONSTRAINT agent_turns_status_outcome_chk_v115
--                      TO agent_turns_status_outcome_chk;
--   e então `tsx scripts/migrate.ts repair --id 115_agent_turns_pending_race_lost.sql
--   --as applied --reason "..."`. Está no runbook (`docs/runbooks/migrations.md`).
--
--   Como diferenciar os quatro casos:
--     SELECT conname, convalidated FROM pg_constraint
--      WHERE conrelid = 'agent_turns'::regclass AND conname LIKE '%status_outcome%';

-- maia:no-transaction

-- ── FASE 1 — constraint nova, nome temporário, NOT VALID (catálogo, sem scan) ──
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_outcome_chk_v115;

ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_outcome_chk_v115 CHECK (
  (status NOT IN ('completed', 'ignored', 'superseded', 'dead_letter') AND outcome IS NULL)
  OR (status = 'completed' AND outcome IS NOT NULL AND outcome IN (
    'reply_delivered', 'reply_delivery_unknown', 'fallback_delivered',
    'no_reply_produced', 'pending_action_resolved', 'legacy_processed'
  ))
  OR (status = 'ignored' AND outcome IS NOT NULL AND outcome IN (
    'blocked_by_policy', 'identity_unknown', 'identity_blocked',
    'quarantined', 'rate_limited_silent', 'operator_cancelled',
    'pending_race_lost'
  ))
  OR (status = 'superseded' AND outcome IS NOT NULL AND outcome = 'merged_into_turn')
  OR (status = 'dead_letter' AND outcome IS NOT NULL
      AND outcome IN ('retry_exhausted', 'operator_cancelled', 'unsafe_to_retry'))
) NOT VALID;

-- ── FASE 2 — a varredura, em transação própria, sob SHARE UPDATE EXCLUSIVE ────
ALTER TABLE agent_turns VALIDATE CONSTRAINT agent_turns_status_outcome_chk_v115;

-- ── FASE 3 — troca curta: só catálogo, sem varredura ─────────────────────────
ALTER TABLE agent_turns DROP CONSTRAINT IF EXISTS agent_turns_status_outcome_chk;

ALTER TABLE agent_turns RENAME CONSTRAINT agent_turns_status_outcome_chk_v115 TO agent_turns_status_outcome_chk;
