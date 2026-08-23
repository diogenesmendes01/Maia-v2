-- 116 — `mensagens.tipo` passa a admitir 'evento' (issue #577).
--
-- O DEFEITO QUE ISSO FECHA
--   `flushUnconfirmedToolSummaries()` (`src/agent/react-loop.ts`) grava a row
--   placeholder que carrega `ferramentas_chamadas` de um turno que terminou SEM
--   outbound (`iteration_cap` / `empty_final_text` / `reasoner_failed` /
--   `outbound_failure`). Ela sempre nasceu com `tipo='evento'`, e o CHECK de
--   `migrations/001_initial.sql:169` só admitia ('texto','audio','imagem',
--   'documento','sistema'): todo INSERT do flush violava a constraint, o
--   `catch` do helper engolia, e o rastro das ferramentas daquele turno
--   desaparecia do histórico. Helper morto desde que nasceu.
--
-- POR QUE 'evento' E NÃO 'sistema' (que já passava no CHECK)
--   O único consumidor que ramifica pelo valor — `src/agent/prompt-builder.ts`
--   (`isEventOnly`) — já testa `m.tipo === 'evento'`; com 'sistema' aquele ramo
--   continuaria morto e o descarte dependeria só do fallback `conteudo === ''`.
--   E 'sistema' já tem dono: `src/gateway/baileys.ts` carimba nos frames de
--   ENTRADA que o gateway não consegue classificar (ruído de protocolo, sempre
--   `direcao='in'`). Reaproveitar confundiria ruído de gateway com rastro de
--   auditoria no mesmo SELECT.
--
-- ESCOPO
--   Só a lista fechada do CHECK muda, e o valor é NOVO — nenhuma linha existente
--   pode violar o CHECK ampliado, nenhuma linha é reescrita.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE `maia:no-transaction` E TRÊS FASES
-- ─────────────────────────────────────────────────────────────────────────────
--   A versão anterior deste arquivo era `DROP CONSTRAINT` + `ADD CONSTRAINT`
--   SOLTOS, sem marker. Sem marker o arquivo roda no modo `runner`
--   (`src/migrations/runner.ts`): o runner abre `BEGIN`, executa o arquivo
--   INTEIRO e só então dá `COMMIT`. O ACCESS EXCLUSIVE tomado pelo `DROP` fica
--   retido até o fim da transação, e a varredura que o `ADD CONSTRAINT` faz para
--   validar TODAS as linhas de `mensagens` acontece debaixo dele. `mensagens` é
--   a tabela de entrada/saída — toda mensagem que entra e toda que sai passa por
--   um INSERT nela. Segurar ACCESS EXCLUSIVE pelo tempo da varredura bloqueia
--   inbound e outbound do produto inteiro durante a migração. Numa base vazia
--   isso custa 2 ms e não se mede; numa base real, custa a janela toda.
--
--   O par `NOT VALID` + `VALIDATE` só evita esse bloqueio quando as duas fases
--   estão em TRANSAÇÕES SEPARADAS (`docs/architecture/modules/migrations.md`,
--   seção "`none` is not only for `CONCURRENTLY`"). Daí o
--   `-- maia:no-transaction`: o runner passa a enviar um statement por vez, cada
--   um em autocommit, e a troca vira três fases — o mesmo desenho da
--   `115_agent_turns_pending_race_lost.sql`.
--
--   FASE 1 — constraint nova sob nome TEMPORÁRIO, `NOT VALID`.
--     ACCESS EXCLUSIVE curto e só de catálogo (sem varredura). A partir daqui a
--     tabela está protegida por DUAS constraints: a antiga (001, válida) e a
--     nova (`NOT VALID` já barra INSERT/UPDATE — `NOT VALID` só dispensa a
--     varredura das linhas ANTIGAS).
--   FASE 2 — `VALIDATE CONSTRAINT` do nome temporário.
--     Aqui está a varredura, e agora ela corre em transação própria, sob
--     SHARE UPDATE EXCLUSIVE, que NÃO conflita com ROW EXCLUSIVE: INSERT
--     concorrente em `mensagens` continua passando.
--   FASE 3 — troca curta: derruba a antiga e renomeia a nova para o nome
--     canônico. Dois statements de catálogo, sem varredura.
--
--   CRASH-SAFETY (o runner registra `dirty` se o processo morrer no meio, e
--   `dirty` NUNCA é reaplicado sozinho — um operador inspeciona antes). Em toda
--   fronteira entre statements a tabela continua protegida por pelo menos uma
--   constraint equivalente:
--     · morreu antes da fase 1 ..... só a 001 (válida)                 → OK
--     · morreu depois da fase 1 .... 001 + `_v116` NOT VALID           → OK
--     · morreu depois da fase 2 .... 001 + `_v116` válida              → OK
--     · morreu entre os dois
--       statements da fase 3 ....... só `_v116`, válida, nome errado   → OK
--   Reaplicar o arquivo inteiro conserta os três primeiros casos sem janela
--   descoberta (o `DROP … IF EXISTS` da fase 1 só derruba `_v116` enquanto a
--   001 ainda está de pé).
--
--   O ÚNICO caso que NÃO deve ser reaplicado cegamente é o quarto: ali a antiga
--   já caiu, e o `DROP … IF EXISTS _v116` da fase 1 deixaria a tabela sem
--   NENHUMA constraint entre dois statements. Remediação, um statement só:
--     ALTER TABLE mensagens
--       RENAME CONSTRAINT mensagens_tipo_check_v116 TO mensagens_tipo_check;
--   e então `tsx scripts/migrate.ts repair --id 116_mensagens_tipo_evento.sql
--   --as applied --reason "..."`. Está no runbook (`docs/runbooks/migrations.md`).
--
--   Como diferenciar os quatro casos:
--     SELECT conname, convalidated FROM pg_constraint
--      WHERE conrelid = 'mensagens'::regclass AND conname LIKE '%tipo_check%';

-- maia:no-transaction

-- ── FASE 1 — constraint nova, nome temporário, NOT VALID (catálogo, sem scan) ──
ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check_v116;

ALTER TABLE mensagens ADD CONSTRAINT mensagens_tipo_check_v116
  CHECK (tipo IN ('texto', 'audio', 'imagem', 'documento', 'sistema', 'evento')) NOT VALID;

-- ── FASE 2 — a varredura, em transação própria, sob SHARE UPDATE EXCLUSIVE ────
ALTER TABLE mensagens VALIDATE CONSTRAINT mensagens_tipo_check_v116;

-- ── FASE 3 — troca curta: só catálogo, sem varredura ─────────────────────────
ALTER TABLE mensagens DROP CONSTRAINT IF EXISTS mensagens_tipo_check;

ALTER TABLE mensagens RENAME CONSTRAINT mensagens_tipo_check_v116 TO mensagens_tipo_check;
