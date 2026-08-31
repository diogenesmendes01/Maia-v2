-- 138 — lease, fencing e reaper em `objective_tasks` (issue #469, fatia A do
-- work loop; §4.4 da spec `2026-07-31-collections-work-loop-design.md`).
--
-- ─── O que estava quebrado ────────────────────────────────────────────────
--
-- O claim da 088 (`objectivesRepo.claimNextPendingTask`) faz UM update:
--
--     UPDATE objective_tasks SET status = 'running' WHERE id = (... SKIP LOCKED)
--
-- e nada mais. A row passa a `running` sem dono, sem prazo e sem token. Três
-- consequências, todas verificáveis no HEAD antes desta migration:
--
--  1. Um SIGKILL (ou um deploy, ou um OOM) entre o claim e o `transitionTask`
--     deixa a tarefa em `running` PARA SEMPRE. Nenhum caminho de código a
--     devolve para `pending`, e o índice parcial único
--     `objective_tasks_live_natural_key_uq` considera `running` uma tarefa
--     VIVA — então o perceptor também não pode recriá-la. O trabalho some em
--     silêncio, e no console a linha fica "em execução" indefinidamente.
--
--  2. `transitionTask` escrevia só por `id`, sem predicado de tenant e sem
--     token. Um id vazado transiciona a tarefa de outro tenant (invariante 1),
--     e um worker que ficou pendurado sobrescreve a decisão do worker que
--     assumiu a tarefa depois — o clássico write de dono morto.
--
--  3. O comentário do `runTick` em `src/workers/index.ts` afirma que "todo job
--     longo aqui (outbox drain, playground drain, objective execute) já é
--     single-flight por lease de DB". Para `objective_execute` isso era FALSO:
--     o guard de sobreposição vale dentro de UM processo, não entre réplicas.
--     Esta migration é o que torna a frase verdadeira.
--
-- ─── O que esta migration acrescenta ──────────────────────────────────────
--
--  * `claimed_by`      — quem detém o claim (id da instância/worker).
--  * `claimed_at`      — quando o claim foi tomado.
--  * `lease_expires_at`— até quando o claim vale. É o prazo, não o heartbeat:
--                        esta fatia não renova lease (a execução de uma tarefa
--                        do work loop é curta), então uma coluna
--                        `heartbeat_at` mentiria sobre um sinal de vida que
--                        ninguém emite. Quando um kind de execução longa
--                        existir, ela entra com o renovador junto.
--  * `claim_token`     — o FENCING TOKEN. `transitionTask` passa a exigi-lo:
--                        o worker cujo lease foi reclamado não consegue mais
--                        escrever, porque o token dele não é mais o da row.
--                        Sem isto o reaper seria uma corrida nova, não uma
--                        correção.
--  * `claim_attempts`  — quantas vezes esta tarefa já foi claimada. Existe por
--                        uma razão específica: um reaper sem teto reanima PARA
--                        SEMPRE uma poison task que derruba o processo a cada
--                        execução. Acima do teto (constante em código, hoje 3)
--                        a tarefa vai para `failed` com motivo, e não volta
--                        para a fila. Fail-closed: perder uma tarefa e ver o
--                        motivo é melhor que um loop de crash invisível.
--
-- ─── Forma ────────────────────────────────────────────────────────────────
--
-- Todas as colunas são ADITIVAS e NULLABLE (exceto `claim_attempts`, que tem
-- DEFAULT constante) — `ADD COLUMN` com default constante é metadata-only
-- desde o PG 11, então não há varredura da tabela.
--
-- Sem backfill, e isso é deliberado: uma tarefa anterior a esta migration
-- nunca teve dono, então `NULL` é a VERDADE ("nunca houve claim"), não um
-- buraco. Carimbar `now()` faria uma tarefa presa desde ontem parecer
-- recém-claimada e a esconderia do reaper — exatamente a row que precisa
-- aparecer primeiro.
--
-- O CHECK de coerência (`running` ⇒ dono + prazo + token) é adicionado JÁ
-- VALIDADO, dentro do mesmo envelope — e NÃO no padrão `NOT VALID` + `VALIDATE`
-- em statement próprio da 121/122. Duas razões, e a primeira é a que manda:
--
--   * o guard `artifact_integrity` do runner de migrations RECUSA um arquivo
--     que declara `BEGIN;…COMMIT;` e ainda executa statement depois do COMMIT
--     (o que já está durável não pode ser desfeito quando o statement seguinte
--     falha). Ou o arquivo inteiro é uma transação, ou ele não controla
--     transação nenhuma. Aqui a atomicidade importa mais que o lock fraco;
--   * `objective_tasks` é minúscula. O grupo `console` nasce DESLIGADO em
--     `MAIA_SCHEDULER_GROUPS`, então estes workers nunca rodaram em produção e
--     a tabela só tem o que o console criou à mão. A varredura de validação
--     sob `ACCESS EXCLUSIVE` custa milissegundos. O padrão `NOT VALID` existe
--     para tabelas quentes (`mensagens`, `agent_turns`); usá-lo aqui seria
--     copiar a forma sem o motivo — e, pior, ao custo da atomicidade.
--
-- ATENÇÃO: as rows PRÉ-EXISTENTES em `running` (se houver alguma, criada por
-- um console antigo) violariam o CHECK. Por isso o `_up` primeiro DEVOLVE
-- para `pending` toda tarefa `running` órfã — que é precisamente o conserto
-- que esta migration entrega — e só então adiciona a restrição. Devolver para
-- `pending` é seguro porque nenhum executor da v1 tem side-effect externo (o
-- único kind é `manual`); quando um kind com efeito real existir, a barreira
-- contra o duplo envio será o slot consumível da fatia B, não o status da
-- tarefa.
--
-- O índice de varredura é PARCIAL e CROSS-TENANT, no mesmo padrão do índice de
-- lease vencida da 114 e da 131: a pergunta do reaper ("quais tarefas
-- perderam o dono?") é feita FORA de contexto de tenant, porque o worker que
-- morreu pode ter sido o de qualquer tenant. O escopo por tenant continua
-- valendo em toda LEITURA de console (`objective_tasks_tenant_agent_status_idx`
-- da 088) e agora também em toda ESCRITA (`transitionTask` ganha o predicado).
--
-- Tabela pequena e sem tráfego ⇒ sem `CONCURRENTLY` e com envelope
-- BEGIN/COMMIT (a armadilha de índice inválido da issue #658 não se aplica a
-- um arquivo atômico).

BEGIN;

ALTER TABLE objective_tasks
  ADD COLUMN IF NOT EXISTS claimed_by       text        NULL,
  ADD COLUMN IF NOT EXISTS claimed_at       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS claim_token      text        NULL,
  ADD COLUMN IF NOT EXISTS claim_attempts   integer     NOT NULL DEFAULT 0;

-- Conserto das órfãs herdadas: toda tarefa que a 088 deixou em `running` sem
-- dono volta para a fila. Sem isto o CHECK abaixo não valida, e — mais
-- importante — essas rows continuariam invisíveis para sempre.
UPDATE objective_tasks
   SET status = 'pending'
 WHERE status = 'running'
   AND claim_token IS NULL;

-- Coerência: `running` só existe com dono, prazo e token; e o token nunca
-- sobrevive fora de `running` (uma tarefa concluída com token seria um lease
-- fantasma que o reaper poderia reanimar).
ALTER TABLE objective_tasks
  ADD CONSTRAINT objective_tasks_claim_coherence_chk
  CHECK (
    (status <> 'running')
    OR (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL AND claim_token IS NOT NULL)
  );

ALTER TABLE objective_tasks
  ADD CONSTRAINT objective_tasks_claim_attempts_chk
  CHECK (claim_attempts >= 0);

-- Fila do reaper: lease vencida, cross-tenant, ordenada pelo prazo.
CREATE INDEX IF NOT EXISTS objective_tasks_lease_expiry_idx
  ON objective_tasks (lease_expires_at)
  WHERE status = 'running' AND lease_expires_at IS NOT NULL;

COMMIT;
