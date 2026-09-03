# Work Loop v2 — Objetivo `cobranca_amigavel`: régua de cobrança em piloto — Design Spec

**Date:** 2026-07-31 (draft original) · **revisada em 2026-09-01 contra `origin/main@c1ebc755`**
**Status:** **Draft v2 — NÃO APROVADA. Spec e decision log apenas; nenhuma linha de produção depende dela.** A v1 do work loop (entidade Objetivo, registry de kinds, workers perceive/execute, exceções listadas por `objectives.listExceptions`) está em `main` — ver `docs/superpowers/specs/2026-06-10-agent-work-loop-design.md` e `migrations/088_agent_objectives.sql`. A **fatia 1** (lease, fencing, reaper, predicado de tenant) também está em `main` — #696, `migrations/138_objective_tasks_lease_fencing.sql`. **Nada de cobrança está em `main`**: o único kind do registry é `manual` (`src/objectives/kinds.ts:40`), e não existem `objective_contact_slots`, holdout nem cadência.
**Scope:** O primeiro objetivo com efeito colateral real — **régua de cobrança amigável de inadimplentes**, em **piloto com UM tenant e UMA carteira enumerada**. Define onde vive a fronteira "backend decide / agente propõe" quando o agente acorda sozinho, como a lista de proibições vira mecanismo, como a frequência resiste a retry/réplica, como a exceção humana destrava a tarefa, o que a métrica de saída consegue e **o que ela não consegue** provar, e como desligar depressa.
**Master refs:** `2026-06-10-learnable-workforce-vision.md` §2.3 (work loop) e §4 (fase 2 — critério de saída "um trabalho inteiro provado com cliente real, medido em R$"); `ARCHITECTURE.md` invariantes 1–6; `docs/architecture/concerns/action-layer.md`; `docs/architecture/concerns/capability-taxonomy.md`; `docs/architecture/concerns/governance-observability.md`.
**Decision log:** [`docs/architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md`](../../architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md) — estado, dono, consequência e evidência de repositório de cada uma das doze perguntas. **A §12 desta spec é o resumo; o decision log é o registro.**
**Architecture Locks:** os 6 invariantes são stop conditions. Em particular o work loop **não cria caminho novo de side-effect** — todo envio sairia pelo `dispatchTool` → `idempotency_effect_outbox` → relayer que já existe. Nenhum guard existente é afrouxado; esta spec só ADICIONA restrição.
**Estado das dependências (verificado em `c1ebc755`):** #521 **mergeada** (`d93624b7`) — `evaluateFinancialAuthorization`, `approval_requests`/`approval_decisions` e o LLM fora do circuito de aprovação são fato, não promessa. #696 **mergeada** (`a45cf85b`) — fatia 1, e a própria PR registra que as fatias seguintes não começam antes da revisão desta spec. #316 (outbox de efeito exactly-once) e #408/#437 (grants e packs) em `main`.
**Blocks:** critério de saída da fase 2 do blueprint; kind `agenda_confirm` (v3).

---

## §0. O que mudou da draft para esta v2, e por que isso importa

A draft anterior foi escrita contra o HEAD `7b34e7e0`, ficou 120 commits atrás de `main` e nunca teve PR. Esta revisão a traz para `origin/main@c1ebc755` e corrige **seis afirmações erradas ou incompletas**. Quatro delas mudam conclusão, não só texto.

| # | O que a draft dizia | O que é verdade em `c1ebc755` | Onde |
|---|---|---|---|
| 1 | "nada liga os parsers de OFX/CSV às tabelas `import_runs`" | **Liga — e está QUEBRADO.** As CLIs `import:ofx`/`import:list`/`import:show`/`import:apply` existem, e a de ingestão não grava uma linha desde a migração 083 | §12.Q2c |
| 2 | o teto de frequência resolvia "no máximo N contatos por devedor" | O unique proposto é `(objective_id, carteira_item_id, step)` — teto **por dívida**, não por destinatário | §7.1b |
| 3 | holdout sorteado por item torna a métrica atribuível | A randomização por item **contamina**: uma pessoa com duas pendências cai em tratamento e controle ao mesmo tempo | §9.2 |
| 4 | "R$ líquido recuperado" é reproduzível sobre `transacoes` + slots | `transacoes` é atualizada **in-place**, sem ledger imutável das liquidações; o custo de LLM é agregado por dia/pessoa em USD, não por objetivo/slot | §9.1b |
| 5 | §8.2 afirmava silêncio total do agente **e** a Q10 perguntava o oposto | Contradição interna da própria spec. **Nenhuma das duas está decidida**: as duas viraram opções da mesma decisão aberta, e a spec não escolhe | §8.2, DA-09 |
| 6 | Q4/Q5 eram questões de **política** | São também de **dado e mecanismo**: não há campo autoritativo para disputa, prescrição, acordo, falecimento ou menor; o opt-out não tem registro operacional durável | §12.Q4/Q5 |

E duas correções de **estado**, não de conteúdo:

- **O §4.4 da draft (endurecimento do caminho v1) foi entregue pela #696** — lease, reaper, `claim_token`, predicado de tenant em `transitionTask`, teto de reanimação e alvo explícito no `ON CONFLICT`. O que **resta** daquela lista é o dispatcher por tenant do perceptor, que esta spec chama de **fatia 2**.
- **`phase: number` não é mais o gate de worker.** Foi substituído por **grupos** (`src/workers/job-contract.ts`); `objective_perceive` e `objective_execute` estão no grupo `console` (`src/workers/index.ts:613`, `:626`), que nasce **desligado** em `MAIA_SCHEDULER_GROUPS`. A frase da draft "re-homear para phase 1 atrás de flag" está obsoleta: a flag já existe, e chama-se grupo.

Uma última correção, essa de premissa: a draft tratava a modelagem do principal de serviço (Q3) como "mudança estrutural em #521". **#521 está mergeada.** Um principal sem `Pessoa` não é continuação daquele trabalho — é **trabalho novo**, ainda por desenhar, contra um alvo que agora está fixo.

---

## §1. Purpose & problema

A v1 provou o **ciclo**: objetivo → percepção → tarefa idempotente → claim → execução → exceção → retomada. Provou com o kind sintético `manual`, cujo executor não toca nada (`src/objectives/kinds.ts:40`). O que falta é a parte difícil: um objetivo cujo executor **fala com um terceiro sobre dinheiro, sem ninguém ter pedido naquele instante**.

Todo o modelo de governança da Maia foi desenhado em torno de um turno: chega mensagem → resolve tenant/pessoa/permissão → decision engine → dispatcher guard → tool. A **mensagem do humano é o evento autorizador**, e `pessoa` + `ResolvedPermission` são o principal contra o qual `canAct` (`src/governance/permissions.ts:97`) e `evaluateFinancialAuthorization` (`src/governance/financial-authorization.ts:172`) decidem. `ToolContext` carrega `pessoa: Pessoa` como campo **obrigatório** (`src/tools/_dispatcher.ts:62`).

O work loop não tem nada disso. Ele acorda por cron. Não há mensagem, não há interlocutor, não há permissão resolvida. **A pergunta central desta spec é: qual é o gate, então?** Responder "o prompt do agente diz para não fazer X" não é resposta — prompt não é mecanismo.

Três problemas concretos que caem dessa pergunta:

1. `constitutionalCheck` C-003/C-007 (`src/governance/rules.ts:41`, `:73`) exige 4-eyes **incondicionalmente** para `send_proactive_message` e `start_recurring_outreach`, e desde #521 a evidência só pode vir de `approval_requests`. Uma régua de cobrança faz N envios. Ou o mandato pré-satisfaz a exigência de forma auditável, ou cada mensagem precisa de duas assinaturas humanas e a autonomia é ficção.
2. Não existe **teto de frequência por destinatário**, nem janela de silêncio. O que existe é *vazão*: `tryAcquireSendSlot` (`src/scheduling/backpressure.ts:71`) impõe 2s entre mensagens ao mesmo JID e baldes global — o suficiente para não tomar ban do WhatsApp, longe do suficiente para um teto do tipo "no máximo N contatos por devedor" — e o N não está decidido (DA-04/DA-05). **E o desenho proposto nesta spec também não entrega isso** (§7.1b). Essa é a correção 2, e ela é uma lacuna, não um detalhe.
3. O ciclo de tarefa era frágil — sem lease, sem reaper, sem predicado de tenant. **Resolvido pela #696**; ver §4.4.

**Não-objetivos** (§2.2): conversar livremente com o devedor; qualquer negociação; integração bancária nova; generalizar o kind; substituir o time de cobrança.

---

## §2. Escopo

### §2.1 Em escopo

- Kind `cobranca_amigavel` no registry (`src/objectives/kinds.ts`) com `perceive` + `execute`.
- **Mandato** hash-pinado como fronteira de decisão (§5) e sua materialização em **slots de contato** consumíveis uma única vez (§7).
- Catálogo de **templates aprovados com slots tipados** — o agente não redige texto livre para devedor (§6.3).
- Fila de exceções com retomada da tarefa pelo humano e expiração fail-closed (§8). **Em que superfície o humano atende essa fila é decisão aberta** — §8.4, DA-07.
- Ledger auditável de contato + desfecho, e uma métrica de saída **com as limitações declaradas em §9.1b** — não a promessa de "R$ recuperado reproduzível" que a draft fazia.
- O que resta do endurecimento genérico do caminho v1: dispatcher por tenant no perceptor e lote limitado (**fatia 2**, §4.4).
- Plano de piloto (um tenant, uma carteira enumerada) e quatro níveis de desligamento (§11).

### §2.2 Fora de escopo

| Fora | Por quê |
|---|---|
| Resposta **livre** ao devedor pelo agente | Texto livre para terceiro sobre dívida é superfície de risco jurídica, não técnica — e a §6.3 fecha esse caminho por construção. **O que acontece com o inbound do devedor** (silêncio, acuse automático, resposta tipada, e em que horário) **não está decidido** — §8.2, DA-09. |
| Negociar, parcelar, descontar, dar baixa, alterar saldo | Proibição do owner; mecanizada em §6 por ausência de grant + `denied_tools` + `valor_max=0`. |
| Integração bancária / conciliação de pagamento nova | Fora do escopo desta spec **e é o maior risco do piloto** — §12.Q1. |
| Consertar as CLIs de import | §12.Q2c mostra que `import:ofx` está morta desde a 083. **O conserto tem issue própria** e não entra nesta PR nem nas fatias 3–5. |
| Teto de contatos por DESTINATÁRIO | §7.1b: o mecanismo proposto não implementa isso. É decisão em aberto (Q5/Q8), não item de escopo. |
| Segundo kind / generalização | v3. Generalizar a partir de um caso é como se inventa abstração errada. |
| Cobrança de dívida contestada, negativada, prescrita ou judicializada | Decisão de negócio/jurídica **e lacuna de dado** — §12.Q4/Q5. |
| Aprovação de mandato via WhatsApp | Dual-approval e travas de arquitetura permanecem exclusivos do console. |

---

## §3. O que já existe (reuso) × o que é novo

Quase tudo já está construído. O novo é pequeno, e é pequeno de propósito.

### §3.1 Reuso — verificado em `origin/main@c1ebc755`

| Necessidade | Mecanismo existente |
|---|---|
| Entidade Objetivo + tarefas idempotentes | `migrations/088_agent_objectives.sql` — `agent_objectives`, `objective_tasks`, índice parcial `objective_tasks_live_natural_key_uq` |
| Registry de perceptor/executor tipado | `src/objectives/kinds.ts` — `ObjectiveKind`, `ExecuteResult` |
| **Claim com lease, fencing e reaper** | `objectivesRepo.claimNextPendingTask` (`src/db/repositories/objective-repos.ts:215`), `transitionTask` com tenant + `expect_claim_token` (`:304`), `reclaimExpiredTaskLeases` (`:384`), `migrations/138`. **Entregue pela #696 — não é trabalho desta spec** |
| Teto contra poison task | `MAX_TASK_CLAIM_ATTEMPTS` (`src/workers/objective-execute-worker.ts:56`) |
| Cancelamento de tarefa órfã | mesmo claim: objetivo ausente/não-`active` ⇒ tarefa `cancelled` |
| CRUD owner-only auditado + fila de exceções | `src/admin-ui/trpc/routers/objectives.ts` |
| **Evidência imutável de aprovação humana** | `approval_requests` + `approval_decisions` (`migrations/095`), `src/governance/approval-requests.ts` — `computeIntentHash`, `ensureApprovalRequest`, `claimExecutableApproval`, `consumeApproval` |
| **Limite financeiro determinístico** | `evaluateFinancialAuthorization` (`src/governance/financial-authorization.ts:172`) — `valor_max` individual, naturezas/categorias, `horario_permitido` timezone-aware, math em centavos, fail-closed. **Atenção: gate financeiro por permissão de pessoa, NÃO gate de horário de mensagem** — §6.2b |
| **Autoridade final de execução** | `dispatchTool` (`src/tools/_dispatcher.ts`) — guard `tool_not_granted` revalidado server-side (`:300`, `:357`) |
| **Escopo de ferramentas** | `agent_tool_grants` (`src/db/schema.ts:316`) + `computeAgentVisibleTools`; `denied_tools` é **HARD** e vence qualquer grant |
| Envio exactly-once | `markCompletedWithEffect` → `idempotency_effect_outbox` → `src/workers/idempotency-outbox-relayer.ts` → `deriveProviderDedupKey` |
| Idempotência no dispatch | `computeIdempotencyKey` / `tryReserve` / fencing por `reservation_token` |
| Follow-up recorrente | séries→ocorrências→tasks→outbox (`src/scheduling/`), `outreachTaskBlueprint()`, `exclusive_per_destinatario`, `escalateOutreachTimeout` |
| Dias úteis / feriados | `computeNextWithBusinessDays` (`src/scheduling/business-day-rrule.ts`) |
| Backpressure de saída | `tryAcquireSendSlot(jid)` (`src/scheduling/backpressure.ts:71`). **Atenção: só o `outbox-drain` o consome, não o relayer de efeito** — §7.3 |
| Sinal de risco jurídico | `legal_intent_detect` (`src/tools/legal-intent-detect.ts` — determinístico, léxico PT-BR, não-LLM) + `case_risk_classify` |
| Audit + métricas rotuladas | `audit()` / `auditTx()` (`src/governance/audit.ts`); enum tipado `src/governance/audit-actions.ts` (`objective_task_executed` em `:832`); `src/observability/metrics.ts` + `taxonomy.ts` + `labels.ts` |
| Pausa global | `src/governance/lockdown.ts` |
| Dispatcher por tenant | `schedulingDispatch.enumerate*Tenants` + `runWithTenantContext` fail-isolado (#355) |
| Grupos de worker (substituto de `phase`) | `src/workers/job-contract.ts`; `objective_perceive`/`objective_execute` no grupo `console`, **desligado por default** |

### §3.2 Novo

1. **`objective_contact_slots`** — a tabela de slots de contato pré-autorizados (§4.2). É o único artefato de dados novo, e faz quatro trabalhos: gate por envio, teto **por dívida** (§7.1b), kill-switch e substrato da métrica.
2. **`src/objectives/kinds/cobranca-amigavel.ts`** — perceptor + executor do kind.
3. **Catálogo de templates** versionado em código, com slots Zod (§6.3).
4. **A ponte exceção ↔ humano** (§8.4). `resolveTask` hoje aceita apenas `done|failed` (`src/admin-ui/trpc/routers/objectives.ts:64`); `resume` **não existe**. É construção, não reuso.
5. **Fatia 2** (§4.4): dispatcher por tenant no perceptor, lote limitado.
6. **Superfície de console**: bloco de mandato na aba Objetivos + painel do piloto.
7. Ações novas no enum tipado `src/governance/audit-actions.ts` (§9.4).

### §3.3 Por que o executor NÃO usa procedures

A spec v1 previa o executor como uma procedure `cobranca_inadimplencia`. Verificado, isso não é construível hoje, por três razões independentes:

- **O motor de procedures não causa side-effect, ele observa.** Não há caminho de `src/procedures/engine.ts` nem de `src/cognition/step-evaluator.ts` para o dispatcher. A dependência corre ao contrário.
- **Nada no sistema em execução consegue ativar uma procedure.** `transitionProcedureStatus` (`src/cognition/procedure-status.ts:100`) e `atomicActivate` não têm caller de produção, e o router `procedures` do admin-ui é somente leitura. Como o seletor filtra `status !== 'active'`, uma procedure criada hoje nunca é selecionada.
- O avanço de passo só acontece como efeito de cauda de um **turno de entrada**. Um loop que acorda por cron não tem turno.

Logo o executor chamaria `dispatchTool` diretamente, que é o caminho canônico e o mesmo que `src/scheduling/engine.ts:713` e `src/agent/pending-resolver.ts:173` já usam. `objective_tasks.procedure_execution_id` fica NULL. Ligar work loop a procedures continua desejável e vira trabalho próprio — §12.Q12.

### §3.4 Por que a 088 não cobre o slot

A 088 dá idempotência de **tarefa viva** — `objective_tasks_live_natural_key_uq` é `UNIQUE (objective_id, natural_key) WHERE status NOT IN ('done','failed','cancelled')`. Isso impede duas tarefas concorrentes para a mesma chave. **Não** impede que, depois que a tarefa da semana 1 vira `done`, uma re-percepção recrie a tarefa da semana 1 e contate a pessoa de novo. O índice é parcial por desenho, e por isso não pode servir de teto de frequência.

Também não há em 088 nem em 138 lugar para guardar "este contato foi pré-autorizado pelo mandato M, é o k-ésimo de no máximo N, vale até T". Uma coluna nova em `objective_tasks` não serviria: o slot precisa existir **antes** e **independentemente** da tarefa, porque é ele que autoriza a tarefa a existir.

Migração nova, portanto, justificada — `_up` + `_down`, prefixo reservado via `npm run migrate:reserve` **no momento da implementação**. O ledger (`migrations/RESERVATIONS.md`) já vai a 138; a draft citava "próximo livre 108", número que envelheceu. **Nenhum prefixo é reservado nesta PR**: ela não contém migração.

`objectivesRepo.upsertTask` já ganhou **alvo explícito** no `ON CONFLICT` pela #696, então a armadilha que a draft apontava (um `onConflictDoNothing` sem target engolindo o índice novo em silêncio) está fechada. Mantê-la fechada é requisito da fatia 3.

---

## §4. Modelo de dados e fluxo do loop

### §4.1 Uso das tabelas existentes

`agent_objectives` — uma linha por régua. `kind='cobranca_amigavel'`. `params` carrega o **envelope** (§5.2). `status` usa os três valores que a 088 já permite (`active|paused|archived`): o objetivo **nasce `paused`** (regra de router, §5.4) e só vira `active` com mandato válido.

`objective_tasks` — uma linha por *contato planejado*. `natural_key = 'cob:v1:{slot_id}'` (o slot é a identidade). `payload` = `{ slot_id, template_id, devedor_pessoa_id, carteira_item_id, step }`. `pending_question_id` — coluna que a 088 criou e ninguém usa — **continua NULL nesta versão** (§8.4). As colunas de lease/fencing da 138 são usadas como estão; a cobrança não as altera.

`approval_requests` — **uma** linha por mandato, com a `approval_class` que a DA-10 fixar, `tool='objective_mandate'`, `intent_payload` = o envelope canônico, `intent_hash` via `computeIntentHash`, `expires_at` obrigatório (é o fim do piloto).

### §4.2 Novo: `objective_contact_slots`

Formato **proposto** (não é código de produção; a implementação reserva o prefixo e escreve `_up`/`_down`):

```sql
CREATE TABLE objective_contact_slots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id        uuid NOT NULL REFERENCES agent_objectives(id) ON DELETE CASCADE,
  tenant_id           text NOT NULL,
  agent_id            text NOT NULL,
  mandate_request_id  uuid NOT NULL,      -- approval_requests.id
  mandate_hash        text NOT NULL,      -- cópia do intent_hash na materialização
  carteira_item_id    text NOT NULL,      -- item da carteira (§5.2), estável
  devedor_pessoa_id   uuid NOT NULL,
  step                integer NOT NULL CHECK (step >= 1),
  template_id         text NOT NULL,      -- allowlist em código (§6.3)
  window_start        timestamptz NOT NULL,
  window_end          timestamptz NOT NULL CHECK (window_end > window_start),
  status              text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','claimed','consumed','expired','revoked','holdout')),
  claim_token         text,
  claimed_at          timestamptz,
  consumed_at         timestamptz,
  task_id             uuid,               -- objective_tasks.id, preenchido no claim
  outcome             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- O teto POR DÍVIDA: UM slot por (item de carteira, passo). Não é um contador.
-- NÃO é teto por destinatário — ver §7.1b, que é uma decisão em aberto.
CREATE UNIQUE INDEX objective_contact_slots_step_uq
  ON objective_contact_slots (objective_id, carteira_item_id, step);

-- Fila do perceptor.
CREATE INDEX objective_contact_slots_ready_idx
  ON objective_contact_slots (objective_id, window_start)
  WHERE status = 'available';

CREATE INDEX objective_contact_slots_scope_idx
  ON objective_contact_slots (tenant_id, agent_id, status);

-- Espelha 095/138: estado de claim carrega seu token (fail-loud em drift).
ALTER TABLE objective_contact_slots
  ADD CONSTRAINT objective_contact_slots_claim_token_chk
  CHECK (status NOT IN ('claimed','consumed') OR claim_token IS NOT NULL);
```

Três propriedades que fazem o desenho funcionar, e **uma que ele não tem**:

- **O número máximo de mensagens por dívida é uma contagem física de linhas.** Não existe caminho pelo qual o loop envie mais do que os slots materializados na ativação **para aquele item**. Não há contador para driftar, nem janela para calcular errado sob concorrência.
- **`window_end` é a validade do slot.** Um worker parado 6 horas não acorda e dispara a rajada acumulada: os slots vencidos vão para `expired` e são inelegíveis para sempre. Isso é o oposto de `missed_run_policy: 'fire_all'`, e é deliberado.
- **`status='holdout'`** marca, na mesma tabela, as unidades sorteadas para o grupo de controle (§9.2) — nunca contatadas, medidas com o mesmo relógio e o mesmo código. **A unidade de sorteio é decisão em aberto** (§9.2).
- **O que ele NÃO tem: teto por destinatário.** `devedor_pessoa_id` está na linha, mas não aparece em nenhuma constraint de unicidade nem em nenhum contador. §7.1b.

### §4.3 Ativação (uma vez, humano no comando)

1. Owner cria o objetivo no console. Router força `status='paused'` para este kind. Nada acontece.
2. Owner submete o **envelope** (§5.2). O backend valida: cada item da carteira resolve para um recebível em aberto **e** para uma pessoa contatável (§5.2b); todo `template_id` está na allowlist; a janela de contato é bem-formada; o teto de passos respeita o máximo do kind. Então calcula `computeIntentHash` e chama `ensureApprovalRequest` com a classe de aprovação que a DA-10 fixar.
3. **Os aprovadores exigidos pela classe da DA-10 assinam.** `approval_decisions` registra cada assinatura (única por `(request, principal)`). Em que canal a assinatura acontece também é DA-10.
4. Na transição do request para `approved`, o backend **materializa os slots** numa transação: sorteia holdout ou tratamento **pela unidade experimental aprovada** (§9.2), com semente fixa derivada do `intent_hash`, e insere `step=1..N` com as janelas derivadas da RRULE do envelope. Auditado (`objective_mandate_materialized`, com contagens).
5. Owner faz `setStatus('active')`. O router recusa se não houver mandato `approved` cujo hash case com os `params` atuais.

Só então o worker teria trabalho — e só se o grupo `console` estiver ligado, o que é decisão de operação e não desta spec.

### §4.4 Percepção (`objective_perceive`, cron)

Determinística e não-LLM, como manda o princípio central da v1. Para cada objetivo `active` do kind:

1. Guard de piloto (§11.1): tenant fora da allowlist ⇒ no-op + audit. Fail-closed.
2. Guard de mandato: recalcula `computeIntentHash(objective.params)`; se ≠ `mandate_hash` dos slots, **para tudo** e audita `objective_mandate_hash_mismatch`. Um envelope editado invalida a régua inteira, sem exceção.
3. Seleciona slots `available` com `window_start <= now() < window_end`, limitado por lote.
4. Para cada slot, **revalida contra o estado do mundo agora** (não na ativação): o item ainda está em aberto? não houve pagamento? não há sinal jurídico registrado? não há resposta do devedor pendente? Qualquer não ⇒ slot para `revoked` com motivo auditado, sem tarefa.
5. Os que sobram viram tarefa via `upsertTask`.

O passo 4 é o que impede o dano mais óbvio: cobrar quem já pagou. Ele depende inteiramente de a liquidação estar visível para a Maia — §12.Q1, e **essa dependência não foi reduzida por nada que entrou em `main` desde a draft**.

### §4.5 Execução (`objective_execute`, drain)

Por tarefa claimada, sob `runWithTenantContext` derivado da row:

1. `claimSlot(slot_id)` — CAS `available → claimed` com `claim_token` novo, espelhando `claimExecutableApproval` e o claim de tarefa da 138. Perdedor da corrida ⇒ `ExecuteResult.failed` benigno.
2. Revalida os guards de §4.4 passo 4 (o mundo pode ter mudado entre percepção e execução).
3. Monta o intent **inteiramente no backend**: `template_id` vem do slot; os slots de texto são preenchidos com valores lidos do banco. O LLM **não participa** deste passo (§6.3).
4. `dispatchTool('send_proactive_message', ...)` pelo caminho normal — dispatcher guard, idempotência, `extractEffect` → `idempotency_effect_outbox`, relayer envia uma vez.
5. `consumeSlot(slot_id, claim_token)` — CAS `claimed → consumed`, one-time. Registra `outcome`.
6. Nada a agendar: o slot `step+1` já existe e já tem janela.
7. `transition: 'done'`, carregando o `claim_token` da tarefa (exigência da 138).

Falha de execução: `releaseSlot` devolve para `available` **apenas se a janela ainda for válida e o efeito comprovadamente não foi enfileirado**; caso contrário o slot vai para `expired` (fail-closed — perder um contato é aceitável, duplicar não é).

### §4.6 Fatia 2 — o que resta do endurecimento genérico, e por que é separável

A draft listava quatro lacunas do caminho v1. **Três foram fechadas pela #696** (`a45cf85b`, `migrations/138`):

| Lacuna da draft | Estado em `c1ebc755` |
|---|---|
| `objective_tasks` sem lease/heartbeat/reaper | **Fechada.** `claimed_by`/`claimed_at`/`lease_expires_at`/`claim_token`/`claim_attempts` + `reclaimExpiredTaskLeases` (`src/db/repositories/objective-repos.ts:384`), chamado no início de cada tick |
| `transitionTask` sem predicado de tenant e sem fencing | **Fechada.** `tenant_id`/`agent_id` obrigatórios + `expect_claim_token` no caminho do worker e `expect_status` (CAS) no caminho do console (`src/db/repositories/objective-repos.ts:304`) |
| Workers em `phase: 2` nunca agendados | **Obsoleta.** `phase` virou metadado histórico; o gate é o grupo `console`, desligado por default (`src/workers/job-contract.ts`, `src/workers/index.ts:613`, `:626`) |
| `runObjectivePerceiveWorker` sem dispatcher por tenant e sem `LIMIT` | **Aberta — é a fatia 2** |

A fatia 2 é, portanto: enumerar tuplas `(tenant_id, agent_id)` com trabalho e usar o padrão fail-isolado de #355; lote limitado no perceptor.

**Ela permanece separável, e essa separabilidade é uma decisão registrada.** A fatia 2 é endurecimento **genérico** (vale para qualquer kind, inclusive o `manual`) e **inerte** (não envia nada, e o grupo `console` continua desligado). Ela não depende de nenhuma das doze perguntas em aberto, não toca em cobrança, e pode ser feita, revisada e mergeada enquanto Q1/Q2b/Q3 seguem sem resposta. Amarrá-la à cobrança criaria dependência onde não existe — e atrasaria uma correção de isolamento por causa de uma discussão jurídica.

---

## §5. A fronteira de decisão: o mandato

### §5.1 O argumento

O gate não pode ser a mensagem do usuário, porque não há mensagem. Também não pode ser "o LLM foi instruído", porque isso não é gate. A resposta desta spec é que o gate **muda de lugar no tempo**: sai do instante da ação e vai para um ato humano anterior, durável, assinado por dois, com hash e validade.

Isso só é legítimo sob uma condição, e vale enunciá-la porque é a espinha do desenho:

> Se o intent de cada envio é **inteiramente determinado** pela tupla (mandato, item da carteira, passo) — sem nenhum grau de liberdade do LLM — então aprovar o envelope é matematicamente equivalente a aprovar cada envio individualmente.

A condição é satisfeita por construção: a carteira é enumerada e fixa (§5.2), o texto vem de um catálogo de templates aprovados (§6.3), os valores vêm do banco, e o calendário é derivado por RRULE determinística. O modelo não escolhe destinatário, nem valor, nem data, nem redação.

É por isso que o mandato é um gate honesto e não uma procuração em branco. Se alguma dessas propriedades cair — se o LLM ganhar liberdade de redigir, ou a carteira virar uma query — o argumento cai junto.

**O que a equivalência NÃO cobre:** ela diz que aprovar o envelope equivale a aprovar os envios *daquele envelope*. Não diz nada sobre o **acúmulo entre envelopes** — dois mandatos sobre dívidas diferentes da mesma pessoa produzem duas réguas, e cada uma foi aprovada isoladamente. §7.1b.

### §5.2 O envelope

Conteúdo canônico de `intent_payload` (a ordem é fixada pelo `computeIntentHash`):

```jsonc
{
  "kind": "cobranca_amigavel", "envelope_version": 1,
  "tenant_id": "...", "agent_id": "...", "objective_id": "...",
  "carteira": [                             // ENUMERADA. Nunca uma query. Ver §5.2b
    { "item_id": "...", "transacao_id": "...", "devedor_pessoa_id": "...", "valor_centavos": 0 }
  ],
  "holdout_fraction": "<DA-01>",            // grupo de controle (§9.2)
  "holdout_unit": "<DA-02>",                // unidade do sorteio (§9.2)
  "steps": "<DA-03>",                       // quais passos, com que intervalo
  "max_steps_per_item": "<DA-05>",          // teto de passos por item
  "contact_window": "<DA-04>",              // horário, dias, feriados, fuso
  "valor_max_centavos": 0,                  // o agente não move dinheiro (§6.2)
  "attribution_window_days": "<DA-06>",     // fixado ANTES de medir (§9.1)
  "expires_at": "<fim do piloto>"
}
```

**Os `<DA-nn>` não são reticências de rascunho: são campos que ninguém decidiu.** Cada um deles é uma decisão de dono nomeado, e um valor "de exemplo" ali — inclusive dentro deste bloco de código — vira default de fato na terceira vez que alguém o lê. O registro completo (dono, evidência, consequência) está no [ADR 0006](../../architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md); o que segue é a forma curta, com o mesmo marcador usado nos dois documentos.

> **DECISÃO ABERTA — DA-01 · fração do holdout** — Q6(a) do ADR 0006
>
> Que fatia da carteira fica sem ser cobrada durante o piloto. Opções (a ordem não é ranking):
>
> - **(a)** nenhuma — piloto sem grupo de controle;
> - **(b)** uma fração fixa, a definir pelo dono do produto;
> - **(c)** uma fração dimensionada por poder estatístico, a partir do tamanho da carteira;
> - **(d)** holdout só na primeira janela, com a carteira inteira tratada depois.
>
> **O que muda.** Com (a), "R$ recuperado" mede sobretudo quem pagaria de qualquer forma e o critério de saída da fase 2 fica sem contrafactual (§9.2). (b) e (c) custam recuperação real durante o piloto; (c) exige um cálculo de poder que ninguém fez. (d) mede só efeito de curto prazo. Seja qual for, o valor entra no envelope e portanto no hash — mudá-lo depois invalida o mandato (§5.3).
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-02 · unidade experimental do holdout** — Q6(b) do ADR 0006
>
> O que é sorteado entre tratamento e controle. Opções (a ordem não é ranking):
>
> - **(a)** o item de carteira (uma dívida);
> - **(b)** o devedor (`devedor_pessoa_id`);
> - **(c)** o documento (CPF/CNPJ), agrupando homônimos e duplicatas de `pessoas`;
> - **(d)** o grupo econômico.
>
> **O que muda.** Com (a), uma pessoa com duas pendências cai em tratamento por um item e em controle por outro: recebe a régua e é contada no grupo que não recebeu nada — *spillover*, que faz a diferença tratamento × controle **subestimar** o efeito, e cuja contaminação é maior justamente onde há mais dados, porque devedores com múltiplas pendências são os mais frequentes. (b) fecha isso dentro de uma carteira, não entre carteiras. (c) e (d) fecham mais e exigem um agrupador que **não existe no schema** — não há documento normalizado com deduplicação nem noção de grupo econômico. Nenhuma das quatro elimina a interferência fora do canal: o time humano de cobrança continua trabalhando a carteira, e isso não é resolvível por schema.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-03 · cadência (quais passos, com que intervalo)** — Q8 do ADR 0006
>
> O conteúdo de `steps`: quantos passos, qual `template_id` em cada um, e o `offset_days` entre eles. Opções (a ordem não é ranking):
>
> - **(a)** passo único, sem follow-up;
> - **(b)** uma régua curta, com intervalo fixo entre passos;
> - **(c)** uma régua com intervalos crescentes;
> - **(d)** cadência derivada do atraso do item (quanto mais vencido, mais espaçado — ou o contrário).
>
> **O que muda.** Volume do piloto, custo por item e a leitura da métrica: passos demais fazem o efeito medido incluir fadiga, passos de menos deixam o piloto sem sinal. A cadência também interage com DA-04 (a janela empurra passos para o próximo dia útil) e com um eventual teto por destinatário (§7.1b), que hoje **não existe como mecanismo**.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-04 · janela de contato (horário, dias, feriados, fuso)** — Q5 e Q8 do ADR 0006
>
> O conteúdo de `contact_window`. Opções (a ordem não é ranking):
>
> - **(a)** a janela mínima que o jurídico apontar como exigida pela normativa aplicável;
> - **(b)** uma janela mais estreita que a exigida, por política do tenant;
> - **(c)** janela por fuso do devedor, em vez de um fuso único do tenant;
> - **(d)** janela por dia da semana, com regra própria para sábado e véspera de feriado.
>
> **O que muda.** A janela é o único gate de horário que existiria neste caminho: §6.2b mostra que **não há gate de horário sobre mensagem de saída** hoje, e que `horario_permitido` é gate financeiro por pessoa, não permissão de envio. Uma janela por fuso do devedor (c) exige um dado de fuso por pessoa que o schema não tem. Os números são jurídicos (Q5) antes de serem operacionais.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-05 · máximo de passos por item** — Q8 do ADR 0006
>
> O `max_steps_per_item`, que é o teto físico de linhas materializadas por item. Opções (a ordem não é ranking):
>
> - **(a)** um teto pequeno e fixo, igual para toda a carteira;
> - **(b)** teto por faixa de valor ou de atraso;
> - **(c)** teto igual ao número de passos de `steps` (DA-03), sem folga;
> - **(d)** teto derivado de um limite jurídico por destinatário, se a Q5 fixar um.
>
> **O que muda.** É a contagem física de slots (§7.1): não há caminho pelo qual o loop envie mais do que os slots materializados **para aquele item**. Mas o teto é **por dívida, não por destinatário** (§7.1b) — com (d), o mecanismo descrito nesta spec é insuficiente e precisa de escopo `(tenant, agent, devedor, janela)` atravessando objetivos, que não existe.
>
> - `decided_by:`
> - `decided_at:`

> **DECISÃO ABERTA — DA-06 · janela de atribuição da métrica** — Q7 e §9.1 do ADR 0006
>
> O `attribution_window_days`: quanto tempo depois de um contato um pagamento ainda conta como relacionado a ele. Opções (a ordem não é ranking):
>
> - **(a)** uma janela fixa em dias, igual para todos os passos;
> - **(b)** uma janela por passo (o último contato "vale" menos tempo);
> - **(c)** janela até o próximo contato do mesmo item, sem sobreposição;
> - **(d)** sem janela: compara-se só o estado final de tratamento × controle no fim do piloto.
>
> **O que muda.** A janela é o que separa "o contato teve efeito" de "a pessoa ia pagar mesmo". Estar dentro do hash é o que impede ajustá-la depois de ver o resultado (§9.1) — por isso ela precisa ser escolhida **antes** do primeiro envio, e por isso um valor de exemplo aqui é pior que campo vazio.
>
> - `decided_by:`
> - `decided_at:`

**A carteira é uma lista, não um filtro.** Essa é a resposta à exigência "limitar a uma carteira sem gambiarra": um item que não está na lista não pode ser contatado, porque não existe slot para ele. Não há flag para afrouxar, nem `WHERE` para alargar. Ampliar a carteira significa novo envelope, novo hash, nova aprovação de dois owners.

`attribution_window_days` estar dentro do hash é intencional: fixa a régua de medição **antes** de existir resultado, para que ninguém a ajuste depois para melhorar o número (§9.1).

`holdout_unit` está no envelope **porque a unidade sorteada faz parte do desenho experimental pré-registrado, não do sorteador** — e desenho pré-registrado precisa estar hash-pinado como todo o resto. Qual unidade: DA-02, §9.2.

### §5.2b O item da carteira carrega o vínculo devedor→WhatsApp, porque o schema não carrega

Lacuna verificada em `c1ebc755`, e é séria: **não existe caminho de "quem deve" para "qual número mandar mensagem".** O devedor no razão é `transacoes.contraparte_id → contrapartes` (`src/db/schema.ts:182`), que tem `nome`, `documento`, `chave_pix` — e **nenhum telefone e nenhuma referência a `pessoas`**. Quem tem `telefone_whatsapp` é `pessoas` (`src/db/schema.ts:199`, coluna em `:211`), com unicidade `(tenant_id, agent_id, telefone_whatsapp)`. As duas tabelas não se falam. E `send_proactive_message` exige `pessoa_id_destino`.

Some-se a isso `agent_audience_profiles` (`migrations/074`): uma pessoa **sem perfil de audiência ativo é resolvida para `{ kind: 'quarantined' }`** e o turno é concluído sem chegar ao agente (`src/identity/resolver.ts:77`, `:92`, `:106`; `src/agent/core.ts:783`). Fail-closed, #407.

Por isso o item da carteira não é um id solto: é um **vínculo validado na ativação** — `(item_id, transacao_id, devedor_pessoa_id, valor_centavos)`. O backend recusa materializar o mandato se, para qualquer item, o `devedor_pessoa_id` não existir, não tiver `telefone_whatsapp` válido, ou não tiver perfil de audiência ativo para este agente.

Isto transforma um problema de dados silencioso ("por que o agente não contatou fulano?") num erro alto na ativação, antes do piloto começar. E deixa explícito o trabalho de curadoria que o tenant precisa fazer — §12.Q2b, **bloqueante**.

### §5.3 Ciclo de vida

| Evento | Efeito mecânico |
|---|---|
| Envelope editado (qualquer byte) | hash muda ⇒ perceptor e executor param no guard de §4.4/§4.5; nenhum slot novo, nenhum consumo |
| `expires_at` atingido | slots vencem; nada a claimar |
| Mandato revogado pelo owner | slots `available`/`claimed` → `revoked`; efeitos já enfileirados no outbox seguem (não há como despublicar uma mensagem — declarado, não escondido) |
| Objetivo `paused` | claim cancela tarefas órfãs (comportamento v1) |
| Lockdown global | `src/governance/lockdown.ts` — pausa tudo |

### §5.4 Onde a regra mora

No **router** (`src/admin-ui/trpc/routers/objectives.ts`), não no worker: `create` força `paused` para o kind; `setStatus('active')` exige mandato `approved` com hash casado. No **worker**, o guard de hash é revalidado a cada tick — o router é conveniência, o worker é autoridade. É o mesmo princípio de `capability-taxonomy.md`: visibilidade é conveniência, o dispatcher revalida do zero.

### §5.5 Em que canal o mandato é assinado

Os dois vocabulários de "approval class" do repo não são o mesmo, e é fácil confundi-los:

- As classes de `approval_requests` (`single_confirmation` / `requester_plus_one_owner` / `two_distinct_owners`) são, por desenho de #521, **decididas por WhatsApp**: `notifyForRequest` avisa os owners e `parseApprovalReply` intercepta a resposta **antes do LLM**. Expiram em `DUAL_APPROVAL_TIMEOUT_HOURS` (default **6h**).
- As classes de `src/admin-ui/lib/approval-matrix.ts` são governança de proposta e **exclusivas do console**.

Ativar uma régua autônoma é mudança de comportamento, e o blueprint mantém dual-approval no console. Mas o mecanismo que dá a evidência imutável (`approval_requests`) é WhatsApp-nativo. Os dois fatos não se encaixam sozinhos, e a spec **não escolhe o encaixe**:

> **DECISÃO ABERTA — DA-10 · classe de aprovação, canal e TTL do mandato** — Q9 do ADR 0006
>
> Quem assina o mandato, por onde, e por quanto tempo a assinatura fica aberta. Opções (a ordem não é ranking):
>
> - **(a)** `two_distinct_owners` assinado no console, com `approval_requests` só como evidência — exige que `recordApprovalDecision` aceite `channel: 'console'`;
> - **(b)** `two_distinct_owners` assinado por WhatsApp, no mecanismo nativo de #521, sem código novo de canal;
> - **(c)** `requester_plus_one_owner`, se o tenant do piloto não tiver dois owners distintos e ativos;
> - **(d)** classe nova, específica de mandato, com TTL próprio maior que `DUAL_APPROVAL_TIMEOUT_HOURS`.
>
> **O que muda.** Baixar a classe (c) enfraquece o argumento central da §5.1 — aprovar o envelope equivale a aprovar cada envio **porque** dois humanos assinaram. (a) e (d) são código novo. (b) contraria o blueprint, que mantém dual-approval no console. E o TTL global de `DUAL_APPROVAL_TIMEOUT_HOURS` (**6h**, fato do repo) é curto para juntar dois owners no console, o que empurra para (d) ou para um mandato que expira antes de ser assinado.
>
> - `decided_by:`
> - `decided_at:`

---

## §6. Guardrails como mecanismo

A lista do owner, traduzida uma a uma. Nenhuma linha depende de prompt.

### §6.1 O mapa

| Proibição | Mecanismo | Onde falha |
|---|---|---|
| Conceder desconto | Nenhuma tool de desconto existe; se existir, entra em `agent_tool_grants.denied_tools`, que é **HARD** e vence qualquer grant | `dispatchTool` → `tool_not_granted` (`src/tools/_dispatcher.ts:300`, `:357`), com audit |
| Renegociar / alterar saldo | `register_transaction`, `boleto_cancel`, `refund_create`, `company_campaign_remove` **fora dos packs concedidos**. Nenhum pack de escrita é concedido ao agente do piloto | idem `tool_not_granted`; e `capability-taxonomy.md`: write nunca é baseline |
| Mover dinheiro | `effective_limits.valor_max = 0` ⇒ `evaluateFinancialAuthorization` retorna `deny` para qualquer valor > 0 | `src/governance/financial-authorization.ts:172` |
| Ameaçar | **Catálogo de templates** (§6.3) — o agente não produz texto para devedor | impossível por construção: não há caminho do modelo até o corpo da mensagem |
| Decidir sobre dívida contestada | `legal_intent_detect` (determinístico) positivo ⇒ transição obrigatória para `waiting_human` e `revoked` em todos os slots restantes daquele item | §8.1. **Mas "contestada" não é um estado do banco** — §12.Q4 |
| Exceder a frequência **por dívida** | Slot consumível uma única vez + unique `(objective_id, carteira_item_id, step)` | §7 |
| Exceder a frequência **por destinatário** | **Nada.** Não há mecanismo | §7.1b — decisão em aberto |
| Contatar fora de hora | `window_start`/`window_end` do slot (derivados da janela do envelope + `computeNextWithBusinessDays` para feriados) — §6.2b. **Os valores da janela são DA-04** | perceptor não cria tarefa; executor recusa slot fora da janela |

### §6.2 Sobre `valor_max = 0`

O agente do piloto não é uma pessoa. Precisa de um **principal de serviço** — uma `pessoa` dedicada, vinculada ao objetivo, cuja `ResolvedPermission` tem `valor_max = 0`, naturezas/categorias vazias e `horario_permitido` = a janela do envelope. Isso reusa `evaluateFinancialAuthorization` sem tocá-lo.

Duas consequências que a implementação precisa respeitar: o principal de serviço **não pode ser dono/co_dono** (senão pega a isenção de dual-approval de `send_proactive_message` — `src/tools/send-proactive-message.ts:30`, `:42`), e não pode ser reutilizado por nenhum outro caminho.

**A modelagem exata é a decisão de segurança em aberto (§12.Q3), e ela é trabalho NOVO.** `ToolContext` exige `pessoa: Pessoa` (`src/tools/_dispatcher.ts:62`); `canAct` (`src/governance/permissions.ts:97`) e `evaluateFinancialAuthorization` (`src/governance/financial-authorization.ts:172`) exigem `pessoa` + `resolved`. `agent_objectives`/`objective_tasks` **não armazenam nem reidratam** esse principal — não há coluna para ele em `migrations/088` nem em `migrations/138`. Um caminho de autorização sem `Pessoa` não é continuação de #521 (que está mergeada): é desenho novo.

### §6.2b Janela de contato: não existe gate de horário para mensagem, e é preciso dizer isso

Correção importante contra uma suposição fácil. **Não existe hoje nenhum gate de horário sobre mensagem de saída.** Verificado:

- `effective_limits.horario_permitido` é timezone-aware e realmente aplicado — mas por `evaluateFinancialAuthorization`, sobre a **permissão financeira de uma pessoa**, tomando `valor` como entrada. Não é um gate de "pode mandar mensagem agora".
- A regra semeada `no_action_outside_business_hours_high_risk` (`migrations/037`) referencia `context.is_business_hours`, campo que **não existe em lugar nenhum do código**. Predicado sobre campo ausente resolve `not_applicable` ⇒ ALLOW. Não reivindicar horário comercial a partir de `policy_rules`.
- `src/scheduling/business-day-rrule.ts` dá **dia útil** (pula fim de semana e feriado), não hora do dia.
- `src/scheduling/backpressure.ts:71` dá vazão (2s por destinatário, baldes global), não janela.

Portanto a janela de contato é aplicada pelo **slot**: `window_start`/`window_end` são calculados na materialização a partir de `contact_window` do envelope (hash-pinado) com dias úteis. Um slot fora da janela não é elegível para o perceptor, e o executor revalida antes do dispatch. É uma camada nova, e é honesto chamá-la de nova em vez de fingir que `horario_permitido` já cobria.

O `valor_max = 0` continua valendo como defesa em profundidade para qualquer caminho que *seja* financeiro.

### §6.3 Templates: o mecanismo contra "ameaçar"

Este é o ponto mais importante da §6, porque "não ameaçar" é o único item da lista do owner que **não é mecanizável por policy de tool**. Policy governa *qual ação*; tom é *conteúdo*.

A saída é remover a liberdade de redação:

- Cada template é uma constante em código, revisada em PR, com `id` versionado (`cob.lembrete_cordial.v1`), corpo fixo e **slots tipados por Zod** (`{nome}`, `{valor}`, `{vencimento}`, `{link}`).
- Os slots são preenchidos pelo **backend**, com valores lidos do banco. O LLM não preenche slot, não escolhe template, não revisa o texto.
- O `template_id` de cada passo está **dentro do hash do mandato**. Trocar o texto invalida o mandato (§5.3).
- A revisão de tom acontece uma vez, por humano, na aprovação — não a cada envio, e não por um juiz automático.

Custo assumido, explicitamente: a mensagem não é personalizada. Para uma régua de lembrete cordial isso é adequado; para negociação não seria — e negociação está fora de escopo por isso.

### §6.4 O que continua valendo

Nada aqui substitui as camadas existentes. O envio seguiria passando por `dispatchTool` inteiro: feature flag, `tool_not_granted`, Zod, escopo de entidade, `constitutionalCheck`, `canAct`, avaliação financeira, reserva idempotente, outbox, audit, consumo de aprovação. O mandato **resolve a exigência de 4-eyes**; não remove nenhum outro passo.

---

## §7. Frequência sob retry, réplica e reexecução

### §7.1 A ideia

Contar é racy. Índice único não é. Por isso a frequência não é um contador consultado antes de enviar — é a **existência de um slot não consumido**.

```
UNIQUE (objective_id, carteira_item_id, step)
```

O k-ésimo contato de um item só pode acontecer se houver um slot `(objetivo, item, k)` em `available`, e ele só pode acontecer **uma vez** porque o consumo é um CAS `claimed → consumed` com token. Não há caminho pelo qual duas réplicas, dois retries ou duas reexecuções produzam dois envios para o mesmo `(item, passo)`.

### §7.1b CORREÇÃO: o limite é por DÍVIDA, não por DEVEDOR

A draft apresentava esse unique como se resolvesse "no máximo N contatos por devedor". **Não resolve, e a diferença importa.**

A chave é `(objective_id, carteira_item_id, step)`. `devedor_pessoa_id` existe na linha, mas **não participa de nenhuma unicidade e de nenhum contador**. Consequências mecânicas, todas dedutíveis do próprio DDL da §4.2:

| Situação | O que o mecanismo permite |
|---|---|
| Uma pessoa deve **duas dívidas** na mesma carteira | dois itens ⇒ **duas réguas completas** ⇒ até `2 × max_steps_per_item` mensagens para o mesmo telefone |
| Uma pessoa aparece em **dois objetivos** (duas carteiras, dois mandatos) | `objective_id` está na chave ⇒ os dois conjuntos de slots são independentes; nada os soma |
| Um segundo mandato amplia a carteira | slots antigos continuam válidos e os novos são materializados à parte (§5.2) ⇒ somam |

Portanto: **esta spec NÃO implementa um eventual teto jurídico por destinatário.** Ela implementa um teto por dívida. Se o número que o jurídico fixar (Q5) for "no máximo N contatos por pessoa por período", o mecanismo aqui descrito é insuficiente e precisa de algo que hoje não existe:

- uma unicidade ou contador cujo escopo seja `(tenant_id, agent_id, devedor_pessoa_id, janela)` **atravessando objetivos e mandatos**; e
- uma decisão sobre o que fazer quando o teto é atingido no meio de uma régua já aprovada (suprimir o slot? revogar? escalar?).

Nada disso está desenhado. **Fica como decisão em aberto (Q5 para o número, Q8 para a política de parada), explicitamente NÃO resolvida por esta spec.** É a diferença entre "temos um teto" e "temos o teto certo", e a draft confundia as duas.

### §7.2 As camadas, e o que cada uma sozinha já garante

| Camada | Garante sozinha | Mecanismo |
|---|---|---|
| 1. Slot | ≤ 1 envio por `(item, passo)`, ≤ N **por item** | unique + CAS one-time (§4.2) |
| 2. Claim da tarefa | ≤ 1 executor por tarefa, com lease e fencing | `FOR UPDATE SKIP LOCKED` + `claim_token` (`src/db/repositories/objective-repos.ts:215`, migração 138) |
| 3. Idempotência do dispatch | reexecução do mesmo intent converge | `tryReserve` + fencing por `reservation_token` |
| 4. Outbox de efeito | ≤ 1 enfileiramento por chave | UNIQUE `(tenant_id, agent_id, idempotency_key)` (`migrations/068`) |
| 5. Relayer | ≤ 1 entrega física | `deriveProviderDedupKey` — message id derivado da **row persistida**, não do contexto ALS (#327) |
| 6. Janela do slot | worker atrasado não dispara rajada | `window_end` ⇒ `expired`, inelegível |

Seis camadas independentes impedem a duplicata **por dívida**. Nenhuma delas olha para o destinatário (§7.1b).

### §7.3 O que NÃO protege este caminho, ao contrário do que parece

- **`exclusive_per_destinatario` não se aplica.** É propriedade de `series`, e o executor não cria série no caminho normal (§4.5 passo 6).
- **O backpressure de saída não cobre o relayer de efeito.** `tryAcquireSendSlot` (`src/scheduling/backpressure.ts:71`) é consumido **apenas** por `src/scheduling/outbox-drain.ts`. `send_proactive_message` sai pelo `idempotency_effect_outbox` → `src/workers/idempotency-outbox-relayer.ts`, que tem backoff próprio mas **não chama a função de pacing**.

Consequência prática: a vazão instantânea da régua é limitada pelo lote do relayer, não por pacing por destinatário. Para o piloto isso é aceitável **porque o volume total é limitado pelo teto absoluto de slots** — mas é uma suposição a validar na fatia 4 com contagem real, não a assumir. Se a vazão incomodar, a correção certa é o relayer passar a usar `tryAcquireSendSlot`, e isso é trabalho próprio (afeta todo o outbound proativo).

Esta spec deliberadamente **não** cria um rate limit de saída novo. Se um kind futuro precisar de taxa e não de teto, o padrão de zset com `ZREMRANGEBYSCORE` de `src/gateway/rate-limit.ts` é o que se reusa.

---

## §8. Fila de exceções

### §8.1 O que gera exceção

Quatro gatilhos, todos **determinísticos e avaliados pelo backend**:

1. `legal_intent_detect` positivo em qualquer mensagem do devedor (léxico PT-BR determinístico — `src/tools/legal-intent-detect.ts`).
2. Devedor responde. **O que dispara exceção aqui — toda resposta, ou só a que não casa com uma classificação tipada estreita — depende da DA-09** (§8.2).
3. Divergência de estado: o item aparece pago no meio da régua, ou o valor mudou, ou o devedor não tem canal válido.
4. Falha repetida de entrega para o mesmo item.

Nos casos 1 e 3, além da exceção, **todos os slots restantes daquele item vão para `revoked`**. Parar é decisão do backend, tomada no perceptor; o modelo não participa.

### §8.2 Inbound do devedor — a decisão que a draft tomou sozinha

Quando o devedor responde, a mensagem entra pelo caminho normal de turno (gateway → decision engine). O que acontece a partir daí **não está decidido**, e a draft escondia isso ao afirmar uma regra num parágrafo e perguntar o oposto na Q10.

Dois fatos de repositório emolduram a decisão, e nenhum dos dois a toma:

- **Não existe gate de horário sobre mensagem de saída** (§6.2b): `horario_permitido` é gate financeiro por pessoa (`src/governance/financial-authorization.ts:172`), `no_action_outside_business_hours_high_risk` referencia `context.is_business_hours`, campo inexistente no código (`migrations/037`), e `business-day-rrule.ts` dá dia útil, não hora. Qualquer opção que envolva "responder só dentro da janela" precisa de mecanismo novo.
- **Texto livre para terceiro sobre dívida é a superfície que a §6.3 fecha por construção.** Nenhuma opção abaixo reabre essa porta: todas passam por template aprovado.

> **DECISÃO ABERTA — DA-09 · resposta ao inbound do devedor (inclusive fora da janela)** — Q10 do ADR 0006
>
> O que o loop faz quando o devedor responde. Opções (a ordem não é ranking):
>
> - **(a)** silêncio: toda resposta do devedor vira exceção humana, sem nenhum envio de volta, em qualquer horário;
> - **(b)** acuse de recebimento automático por template próprio, dentro do mesmo mecanismo de slot e janela — logo, silêncio fora da janela e acuse quando ela abrir;
> - **(c)** acuse de recebimento automático em qualquer horário, fora do mecanismo de slot;
> - **(d)** resposta por template para uma classificação tipada estreita (promessa de pagamento com data, alegação de já ter pago), com tudo o mais virando exceção humana.
>
> **O que muda.** (a) é a mais restritiva e a que menos exige código; deixa o devedor sem retorno até um humano abrir a fila (DA-07). (b) exige mecanismo de janela para inbound, que não existe. (c) contorna a janela e é a que mais expõe o piloto a "cobrança fora de hora" caso a Q5 fixe um horário. (d) muda a natureza do risco jurídico e enfraquece o argumento da §6.3, porque o agente passa a emitir mensagem **em reação ao conteúdo** do devedor — ainda que por template. A escolha também determina o gatilho 2 da §8.1 e o critério de aceite 18 da §14, que hoje **não existe** justamente por depender dela.
>
> - `decided_by:`
> - `decided_at:`

Enquanto DA-09 estiver sem assinatura, esta spec **não afirma** comportamento nenhum para inbound de devedor — nem silêncio, nem acuse. Ver ADR 0006, Q10.

### §8.3 Travar e destravar

- Executor retorna `{ transition: 'waiting_human' }`; a tarefa aparece em `objectives.listExceptions` e na aba Objetivos — **isto já existe e funciona** (v1).
- O humano resolve a exceção — em que superfície é DA-07. Hoje `resolveTask` aceita apenas `done|failed` (`src/admin-ui/trpc/routers/objectives.ts:64`) e não consegue devolver a tarefa ao loop. **Precisa passar a aceitar `resume`**, que transiciona `waiting_human → pending` com a resposta no `payload`. Router + repo, sem migração. A #696 já deu a esse caminho escopo por tenant e CAS sobre `waiting_human`; `resume` entra no mesmo desenho.
- **Expiração é fail-closed**: exceção não resolvida dentro do TTL **não** retoma sozinha. A tarefa vai para `failed` e os slots restantes do item para `revoked`. O default do silêncio é parar de cobrar, nunca continuar. Isto é um sweeper novo sobre `objective_tasks` (§8.4), não o `pending-expirer`.

### §8.4 O que a v1 documentou como existente e não existe

A spec v1 diz: *"A resposta do owner (WhatsApp ou console) destrava a procedure → o executor retoma a tarefa."* Verificado, **essa ponte não existe**, em três níveis:

1. **`pending_questions` não tem vínculo com `procedure_executions`.** Não há coluna, e `src/agent/pending-resolver.ts` nunca emite `human_confirmation`. `procedureEngine.recordHumanConfirmation` só tem caller em `src/procedures/test-runner.ts`.
2. **`pending_questions` não tem nenhuma superfície de console.** Nenhum router do admin-ui lê ou escreve a tabela. É WhatsApp-only.
3. **`uniq_pending_questions_active_per_conversa`** (`migrations/004`) permite **uma** pending question aberta por conversa. Se as exceções da régua virassem pending questions na conversa do owner, elas **serializariam**: a segunda cancelaria a primeira.

O ponto 3 é o que restringe as opções: uma régua com dezenas de itens gera exceções em paralelo, e um canal que só comporta uma pergunta aberta por conversa serializa os casos. Restringe — não decide.

> **DECISÃO ABERTA — DA-07 · superfície em que o humano atende a fila de exceções** — Q11 do ADR 0006
>
> Onde o owner destrava uma tarefa em `waiting_human`. Opções (a ordem não é ranking):
>
> - **(a)** só no console (`objective_tasks.status='waiting_human'` + `resolveTask`), com `objective_tasks.pending_question_id` NULL;
> - **(b)** só no WhatsApp, caso a caso — exige resolver antes a limitação de `uniq_pending_questions_active_per_conversa` (`migrations/004`), em trabalho próprio;
> - **(c)** console para atender, mais notificação agregada por WhatsApp ("N casos aguardam você"), que não é pergunta por caso e não esbarra no índice;
> - **(d)** as duas superfícies com paridade, o que exige (b) mais reconciliação entre elas.
>
> **O que muda.** (a) obriga o owner a abrir o console para destravar — não resolve pelo celular. (b) e (d) mudam a **ordem das fatias**: o índice da `004` vira pré-requisito da fatia 4, e isso é trabalho que não está nesta spec. (c) é o meio-termo e ainda exige um agregador que não existe. Em qualquer opção, `resolveTask` precisa passar a aceitar `resume` (§8.3) — essa parte não depende da superfície.
>
> - `decided_by:`
> - `decided_at:`

---

## §9. Observabilidade e métricas

### §9.1 O critério de saída, e por que ele é difícil

"Valor líquido recuperado" é o critério de saída da fase 2. Para ser um número e não uma narrativa, precisa de três propriedades: ser **reproduzível** (recalculável do zero a partir de linhas imutáveis), ser **atribuível** (dá para dizer que o pagamento tem relação com o contato) e ser **líquido** (desconta custo).

O consumo de slot dá metade da primeira: `objective_contact_slots` seria append-com-CAS, com timestamp por transição, e portanto um registro fiel de **o que a Maia fez**. O problema é o outro lado da conta.

### §9.1b CORREÇÃO: a métrica NÃO é plenamente reproduzível sobre a base atual

A draft afirmava que a reprodutibilidade "vem de calcular sobre `objective_contact_slots` e sobre as transições de `transacoes` — ambas imutáveis o bastante". **A segunda metade dessa frase é falsa em `c1ebc755`**, e três fatos verificados a derrubam:

| Fato | Evidência | Consequência para a métrica |
|---|---|---|
| `transacoes` é atualizada **in-place**. Não há tabela de eventos de liquidação, nem versionamento de linha. `status` e `data_pagamento` são sobrescritos (`src/db/repositories/finance-repos.ts:518`, `scripts/import-review.ts:96`) | `src/db/schema.ts:127` (nenhuma coluna de versão); domínio de `status` fixado em `migrations/001_initial.sql:71` | **Não existe ledger imutável das liquidações.** Um recálculo feito em T+30 lê o estado ATUAL, não o estado em T. "Recalculável do zero" não é verdade: o passado foi sobrescrito |
| O custo de LLM é agregado em `agent_facts` por **dia** e por **dia+pessoa**, em USD, via `cost.daily.llm.${day}` e `cost.daily.llm.${day}.${pessoa_id}` | `src/lib/cost-ledger.ts:94`, `:102` | **Não há atribuição por objetivo, por slot nem por régua.** Não dá para dizer quanto custou ESTE piloto sem uma alocação arbitrária |
| Não existe política cambial | nenhuma conversão USD→BRL no repositório (busca por `cambio`/`exchange_rate`/`ptax`: zero ocorrências) | Um "R$ líquido" que subtrai um custo em USD precisa de uma taxa e de uma data de conversão. Nenhuma das duas está definida |
| Tempo humano em exceções não tem fonte | não há cronômetro nem campo de esforço em `objective_tasks` | O componente "líquido" fica incompleto por construção — §12.Q7 |

**Portanto esta spec não promete "R$ recuperado reproduzível" sobre a base atual.** O que ela pode prometer, e o que precisa de trabalho, fica separado assim:

| Componente | Estado |
|---|---|
| O que a Maia fez (contatos, quando, para qual item) | **Reproduzível** a partir de `objective_contact_slots` |
| Quantos itens liquidaram na janela | **Observável, não reproduzível** — depende do estado atual de `transacoes`, que é sobrescrito. Como (e se) recuperar a série temporal perdida é DA-08 |
| Custo de máquina do piloto | **Não atribuível** hoje sem rateio arbitrário |
| Custo humano | **Sem fonte** |
| "R$ líquido recuperado" | **Não computável com rigor** enquanto os três acima estiverem abertos |

O que tornaria isso reproduzível é uma decisão de dado, não de código do work loop: um **ledger append-only de liquidação** — ou algum substituto mais barato, que é DA-08 — e **atribuição de custo por objetivo**. Nenhum dos dois existe. Ver §12.Q1 e §12.Q7.

> **DECISÃO ABERTA — DA-08 · como a métrica recupera a série temporal que `transacoes` não guarda** — Q1 e Q7 do ADR 0006
>
> `transacoes` é sobrescrita in-place e não há ledger de liquidação. Opções (a ordem não é ranking):
>
> - **(a)** nada: a métrica declara-se observável e não reproduzível, e o relatório diz isso;
> - **(b)** ledger append-only de liquidação, com migração própria — resolve o problema na raiz e é trabalho fora desta spec;
> - **(c)** cópia imutável e datada do estado dos itens da carteira, gravada a cada ciclo pelo worker de métrica;
> - **(d)** (c) restrita aos itens da carteira do piloto, descartada no fim dele.
>
> **O que muda.** (a) é honesta e não custa nada, e o critério de saída da fase 2 fica sem número reproduzível. (b) é a única que torna o passado auditável de verdade, e é a mais cara. (c) e (d) não tornam o passado imutável retroativamente — criam a série a partir do dia em que o piloto começa — e são dado novo sob uma matriz de retenção que segue `DRAFT — NOT APPROVED` (Q5), então passam pelo DPO. Nenhuma das quatro conserta a atribuição de custo, que é Q7.
>
> - `decided_by:`
> - `decided_at:`

### §9.2 Grupo de controle — e a unidade que a draft escolheu sem perguntar

Sem holdout, "R$ recuperado" mede sobretudo **as pessoas que teriam pagado de qualquer forma**. Uma régua sobre uma carteira de inadimplentes recentes exibe recuperação alta mesmo sem enviar nada. Por isso o envelope carrega `holdout_fraction`, e a divisão é sorteada na materialização com semente derivada do `intent_hash` (reprodutível, fixada antes de qualquer resultado).

**O que a draft errou:** ela sorteava **por item de carteira**. Isso contamina o experimento.

Uma pessoa com duas pendências pode cair simultaneamente em tratamento (item A) e em controle (item B). Ela **recebe** a régua e ao mesmo tempo é contada no grupo que supostamente não recebeu nada. O efeito medido no controle passa a incluir o efeito do tratamento — o clássico *spillover* —, e a diferença tratamento × controle **subestima** o efeito real por construção. Pior: a contaminação é maior justamente onde o piloto tem mais dados, porque devedores com múltiplas pendências são os que mais aparecem.

Esse é um achado sobre o sorteio por item — não uma escolha de substituto. **Qual unidade passa a valer é decisão do dono do produto com o dono dos dados** (DA-02, §5.2), e é por isso que `holdout_unit` entra no envelope e portanto no hash: a unidade é parte do desenho pré-registrado, não um detalhe do sorteador. A fração sorteada é DA-01.

Nota de honestidade, válida para **qualquer** opção da DA-02: o holdout continua sujeito a interferência fora do canal (o time de cobrança humano continua trabalhando a carteira). Isso não é resolvível por schema; é uma limitação a declarar no relatório da fatia 5, não a esconder.

### §9.3 O que se mede

| Métrica | Fonte | Observação |
|---|---|---|
| Contatos efetivados por item/passo | `objective_contact_slots` | reproduzível |
| Itens liquidados na janela (tratamento × controle) | `transacoes` + o que a DA-08 decidir | **observável, não reproduzível** — §9.1b |
| R$ "líquido" | o que entra na conta é Q7; a janela de atribuição é DA-06 | **incompleto e ainda indefinido** — §9.1b, §12.Q7 |
| Taxa de contato | `consumed` / `available+consumed` | |
| Intervenção humana | tarefas que passaram por `waiting_human` / total | é a métrica de autonomia real |
| Reclamações / bloqueios | sinal jurídico, opt-out, falha de entrega por bloqueio | **é breaker, não painel** (§11.3). O opt-out não tem registro durável — §12.Q5 |
| Falsos positivos | slots `revoked` por "já estava pago" / total | mede a qualidade do perceptor; é o indicador de dano ao cliente |

### §9.4 Instrumentação

Métricas por `src/observability/metrics.ts`, com nomes declarados em `src/observability/taxonomy.ts` (`METRIC`) e labels sanitizados por `labels.ts`. O orçamento de cardinalidade e a regra de privacidade importam: `carteira_item_id`, `devedor_pessoa_id`, telefone e conteúdo **não podem ser labels** — só `tenant_id` e `agent_id` são identificadores sancionados.

Auditoria: cada passo por `audit()` (o contexto ALS carimba `tenant_id`/`agent_id`). O consumo do slot usa **`auditTx`** — fail-loud, na mesma transação. Ações novas precisam entrar no enum tipado `src/governance/audit-actions.ts`, senão não compilam: `objective_mandate_materialized`, `objective_mandate_revoked`, `objective_slot_claimed`, `objective_slot_consumed`, `objective_slot_revoked` (com motivo), `objective_exception_opened` / `_resumed` / `_expired`. `objective_task_executed` já existe (`src/governance/audit-actions.ts:832`).

O SLO `MaiaAuditWriteFailing` (`monitoring/alerts/slo.rules.yml`) dispara em qualquer incremento de `maia_audit_write_failed_total`: uma régua que perde trilha acende alarme sozinha.

---

## §10. Isolamento

Invariante 1 aplicado passo a passo:

| Passo | Escopo |
|---|---|
| Percepção | dispatcher por tenant (#355), `runWithTenantContext`, fail-isolado — **fatia 2, ainda não feita** |
| Slots | `tenant_id`/`agent_id` na tabela; índice de escopo; toda query com os dois |
| Claim de tarefa | claim é cross-tenant por desenho (o processo que morreu podia ser de qualquer tenant), mas o contexto é derivado da row e `transitionTask` **já tem** predicado de tenant + fencing (#696) |
| Envio | `dispatchTool` sob contexto; idempotência já é `(tenant_id, agent_id, key)`; outbox idem |
| Métrica | labels `tenant_id`/`agent_id` |
| Audit | `audit()` injeta o contexto ALS |

`test:leak` ganharia: objetivos, slots e exceções do tenant A invisíveis a B nos dois sentidos; e um slot de A jamais claimável sob contexto de B. (O leak de objetivos e tarefas já é coberto por `tests/integration/playground-objectives-mcp-leak.spec.ts` e `tests/integration/objective-task-lease.spec.ts`.)

---

## §11. Piloto e rollback

### §11.1 Um tenant

Dois gates, e o de fora é o que vale:

1. `MAIA_COBRANCA_PILOT_TENANTS` (config, default **vazio**): vazio ⇒ o kind é inerte em qualquer tenant.
2. O grupo `console` do scheduler, desligado por default em `MAIA_SCHEDULER_GROUPS` (`src/workers/job-contract.ts`). Ligá-lo é decisão de operação.

### §11.2 Uma carteira

Resolvido em §5.2 pela carteira enumerada e hash-pinada. **Não existe filtro para afrouxar**: item fora da lista não tem slot; sem slot não há contato. (O que isso **não** garante é o teto por destinatário — §7.1b.)

### §11.3 Desligar depressa

| Nível | Ação | Efeito | Latência |
|---|---|---|---|
| 0 | **Breaker automático** | reclamação/bloqueio acima do limiar ⇒ objetivo `paused` + exceção aberta. **Nunca se re-arma sozinho** | segundos |
| 1 | `objectives.setStatus('paused')` | perceptor para; claim cancela órfãs | próximo tick |
| 2 | Revogar o mandato | slots `available`/`claimed` → `revoked` | imediato |
| 3 | Grupo `console` fora de `MAIA_SCHEDULER_GROUPS` / `lockdown` | para o loop / o sistema | imediato |

O que **não** se desfaz: mensagem já entregue pelo relayer. Está declarado aqui em vez de escondido — é a razão de a janela do slot ser curta.

`expires_at` do mandato é o desligamento que não depende de ninguém lembrar: o piloto termina sozinho.

---

## §12. Perguntas em aberto

Nenhuma destas é escolhível por um agente. O registro completo — estado, dono, o que muda conforme a resposta e a evidência de repositório — está em [`docs/architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md`](../../architecture/decisions/0006-cobranca-piloto-perguntas-em-aberto.md). O que segue é o resumo.

**Q1 — [BLOQUEANTE] A Maia consegue saber quem deve e quem pagou?**
`payment_verification` retorna `paid: null` sempre (`src/tools/payment-verification.ts:59`) — nunca `false`, por desenho honesto. `boleto_search`, `dda_lookup`, `company_blacklist_check`, `company_history_lookup`, `refund_lookup` são stubs (#432). Sobra `transacoes` (`natureza='receita'`, `status='pendente'`), que só serve se os recebíveis do tenant do piloto **estiverem na Maia e forem mantidos em dia**. O repositório **não prova** população, completude nem atraso desses dados: não há métrica de frescor, não há teste de completude e não há um único tenant de referência verificado. Duas perguntas para o dono: (a) os recebíveis estão lá? (b) a liquidação chega por qual caminho e com qual atraso? Sem isso o perceptor cobra quem já pagou e o critério de saída em R$ não é mensurável. **Isto define se o piloto é viável.**

**Q2 — `transacoes` não tem `data_vencimento`.** Há `data_competencia` e `data_pagamento` (`src/db/schema.ts:127`); vencimento não é campo de primeira classe. Também não existe tabela de contas a receber: `transacoes` é o único razão. Usar competência como proxy de vencimento é aceitável para este tenant, ou vencimento precisa virar campo? Muda quem entra na carteira e quando.

**Q2b — [BLOQUEANTE] Quem faz a ponte devedor→WhatsApp?** `contrapartes` (`src/db/schema.ts:182`) não tem telefone nem vínculo com `pessoas`; `pessoas` (`:199`) é quem tem `telefone_whatsapp` (`:211`). Não existe FK, coluna nem tabela de junção entre as duas — verificado. Além disso, toda pessoa contatada precisa de **perfil de audiência ativo** para este agente (`migrations/074`), sem o qual o resolver devolve `quarantined` (`src/identity/resolver.ts:77`, `:92`, `:106`) e o inbound é descartado antes de virar turno (`src/agent/core.ts:783`). **Uma resposta do devedor ainda exige perfil de audiência ativo** — não é só o envio que depende disso. Quem monta e mantém esse vínculo para a carteira do piloto: import manual, curadoria no console, ou um campo novo em `contrapartes`? É trabalho de dados que precisa acontecer **antes** da fatia 4.

**Q2c — CORRIGIDA: a ingestão de extrato existe em código e está QUEBRADA.**
A draft dizia que "nada liga" os parsers às tabelas. **Falso.** As CLIs existem e estão declaradas em `package.json`: `import:ofx` (`scripts/import-ofx.ts`), `import:list`/`import:show`/`import:apply` (`scripts/import-review.ts`). O quadro real, verificado:

| Fato | Evidência |
|---|---|
| `import_runs.tenant_id` e `import_runs.agent_id` são `NOT NULL` | `src/db/schema.ts:1109`, `:1110`; `migrations/012_p0_force_not_null.sql` |
| e **sem default**: a `083` removeu o `DEFAULT 'default'` de toda coluna que o tinha, fechando o bucketing silencioso da #282/#323 | `migrations/083_drop_default_column_default.sql` |
| o insert de `import:ofx` **não inclui** `tenant_id` nem `agent_id` | `scripts/import-ofx.ts:79` |
| nenhuma das duas CLIs entra em contexto de tenant | `grep` de `runWithTenantContext`/`getCurrentTenant` em `scripts/import-ofx.ts` e `scripts/import-review.ts`: **zero ocorrências** |
| `applyTenantGuard` é opt-in por chamada de repo, não um interceptador global do drizzle — os scripts usam `db` diretamente | `src/db/tenant-guard.ts:16` |
| erro literal ao rodar a forma exata desse insert contra um banco migrado | `ERROR: null value in column "tenant_id" of relation "import_runs" violates not-null constraint` (reprodução do dono; **não re-executada nesta revisão** — ver §16) |

**Ou seja: `import:ofx` está morta desde a 083.** Ela não grava uma linha. E isso é **pior que ausente**, porque parece existir: o script está no `package.json`, o AGENTS.md o lista em §6 como comando operacional, e um leitor conclui que a ingestão de extrato funciona.

A CLI de revisão tem o mesmo defeito por outro lado: `import:apply` insere em `transacoes` sem `tenant_id`/`agent_id` (`scripts/import-review.ts:160`) e atualiza `transacoes`/`import_entries` **apenas por id**, sem predicado de tenant (`:96`) — o oposto do que `updateTransacaoWith` faz no caminho de produção (`src/db/repositories/finance-repos.ts:518`). Como `import:ofx` nunca cria uma run, esse caminho está inalcançável hoje; se a ingestão for consertada sem consertar isto junto, ele deixa de estar.

**Não conserte a CLI nesta PR — ela tem issue própria.** O que muda para a cobrança: a resposta a "a liquidação chega pela Maia?" é **não por extrato**; hoje entraria apenas por `register_transaction` (manual/WhatsApp). ERP externo via MCP está recusado no boot em produção (#521). Isso é suficiente para o tenant do piloto?

**Q3 — [BLOQUEANTE — Segurança] Como se modela o principal de serviço?**
O agente autônomo precisa de um principal para `canAct` e `evaluateFinancialAuthorization`. Verificado: `ToolContext` exige `pessoa: Pessoa` (`src/tools/_dispatcher.ts:62`); `canAct` exige `pessoa` + `resolved: ResolvedPermission | null` (`src/governance/permissions.ts:97`); `evaluateFinancialAuthorization` idem (`src/governance/financial-authorization.ts:172`). E **`agent_objectives`/`objective_tasks` não armazenam nem reidratam esse principal** — não há coluna para ele em `migrations/088` nem em `migrations/138`. Criar uma "pessoa robô" resolve o encaixe mas introduz um principal sem humano por trás. A alternativa é um caminho de autorização que não passe por `pessoa` — **trabalho novo**, não continuação de #521, que está mergeada. **Precisa do dono da segurança.**

**Q4 — CORRIGIDA: quem sai da carteira por regra — e com qual DADO?**
Dívida contestada, negativada, prescrita, em acordo, devedor falecido, menor. A draft tratava isso como escolha de política. É também **lacuna de dado**: o domínio de `transacoes.status` é `('pendente','agendada','paga','recebida','cancelada')` (`migrations/001_initial.sql:71`) — não há disputa, acordo nem prescrição; `contrapartes` não tem campo de situação jurídica (`src/db/schema.ts:182`); `pessoas.tipo` é `('pf','pj')` (`migrations/001_initial.sql:19`) e não há data de nascimento nem marcador de óbito. Portanto cada critério precisa de **duas** respostas: qual é a regra (negócio/jurídico) **e** onde o fato passa a viver de forma autoritativa (dado). Sem a segunda, o filtro do perceptor não tem o que ler.

**Q5 — CORRIGIDA: [BLOQUEANTE — Jurídico/DPO] limites regulatórios, e o mecanismo que falta.**
CDC art. 42 e a normativa aplicável a cobrança por mensagem: horário permitido, **frequência máxima por destinatário**, conteúdo obrigatório, opt-out e como ele é honrado, retenção do registro de contato, base legal LGPD. Além dos números, três lacunas de mecanismo:

- **Frequência por destinatário não é implementável com o desenho atual** (§7.1b). Precisa de escopo `(tenant, agent, devedor, janela)` atravessando objetivos, que não existe.
- **O opt-out não tem registro operacional durável.** Busca por `opt_out`/`opt-out`/`descadastr` no repositório: as únicas ocorrências são um default de resolver (`src/user-layer/resolvers/rules-resolver.ts:60`), um comentário de contexto de tenant e a descrição textual de uma skill (`migrations/079_boleto_proposta_attendant_role_and_skills.sql:220`). **Não há tabela, coluna nem tool que registre "esta pessoa pediu para não ser contatada".** Honrar opt-out exige construir isso.
- **A matriz de retenção segue `DRAFT — NOT APPROVED`** (`docs/architecture/concerns/data-retention-matrix.md`, linha 3), pendente do DPO. O registro de contato de cobrança é dado novo sob essa matriz.

**Q6 — CORRIGIDA: grupo de controle é aceitável, e qual é a unidade?**
Duas perguntas, não uma. (a) O owner aceita não cobrar uma fatia da carteira durante o piloto, e qual fatia — **DA-01**? (b) O que é sorteado — **DA-02**? A draft sorteava por item, o que contamina o experimento (§9.2); as opções e o que muda em cada uma estão nos dois blocos da §5.2. Agrupar por documento ou por grupo econômico exige um agrupador que hoje não existe no schema.

**Q7 — O que entra em "líquido"?** Custo de mensagem é mensurável. Custo de LLM existe, mas agregado por dia e por dia+pessoa em USD (`src/lib/cost-ledger.ts:94`, `:102`) — **não por objetivo nem por slot** —, e não há política cambial para trazê-lo a BRL. Tempo humano em exceções não tem fonte. Estimar por contagem de exceções × constante, ou declarar "recuperado bruto menos custo de mensagem" e parar de chamar de líquido? Ver §9.1b.

**Q8 — Quantos passos, com que intervalo, e quando parar?** `max_steps_per_item` (**DA-05**), `steps`/`offset_days` (**DA-03**) e o critério de desistência são política de cobrança do tenant. **Inclui a política de parada quando um teto por destinatário for definido (Q5)**: suprimir o slot, revogar a régua ou escalar. Nenhum dos três tem valor nesta spec, nem como exemplo.

**Q9 — Quem assina o mandato, e por quanto tempo a assinatura fica aberta? (DA-10)** A classe `two_distinct_owners` exige dois owners distintos e ativos. O tenant do piloto tem dois? Se não, `requester_plus_one_owner` é aceitável para um mandato desta natureza? E o TTL: `DUAL_APPROVAL_TIMEOUT_HOURS` é 6h global — curto para juntar dois owners no console (§5.5). Mandato ganha TTL próprio?

**Q10 — EM ABERTO (DA-09): o que acontece quando o devedor responde no meio da noite?**
A draft se contradizia — o §8.2 afirmava uma coisa e a própria Q10 perguntava o oposto — e a v2 anterior "resolveu" a contradição escolhendo um dos lados sem assinatura, o que é a mesma falha em outra forma. As quatro opções (silêncio; acuse dentro da janela; acuse a qualquer hora; resposta tipada) e o que muda em cada uma estão no bloco **DA-09** da §8.2. Esta spec **não afirma** nenhuma delas, e o critério de aceite correspondente só existe depois da assinatura. Contexto que restringe as opções: não há gate de horário sobre mensagem de saída (§6.2b).

**Q11 — Onde o owner atende as exceções? (DA-07)** Uma pending question por conversa serializaria os casos (`migrations/004`), o que restringe as opções sem escolher entre elas — as quatro estão no bloco **DA-07** da §8.4. Se destravar pelo celular for requisito, a limitação do índice precisa ser resolvida **antes**, em trabalho próprio, e isso muda a ordem das fatias.

**Q12 — Vale ligar o work loop a procedures algum dia?** §3.3 mostra que hoje não dá. Consertar isso é investimento real. **Não deve ser falsamente resolvida dentro do piloto**: vira ADR próprio depois da fatia 5, ou o executor-em-código por kind é declarado o desenho definitivo.

---

## §13. A sequência segura

Cada linha é uma pré-condição, não uma sugestão. Nenhuma fatia começa antes de a linha acima estar satisfeita.

| Antes de | Condição |
|---|---|
| **Fatia 3** (mandato, slots, kind sem envio) | Spec atualizada para a `main`, **PR de spec aceita**, Q1/Q2b/Q3 assinadas, e as seis correções da §0 resolvidas — não apenas lidas |
| **Fatia 4 — shadow** | **Q1, Q2b e Q3 assinadas** (as três bloqueantes valem para 3, 4 e 5 — não é herança implícita da linha acima); Q2/Q2c/Q4/Q10 fechadas; ingestão tenant-safe testada; carteira com **100%** dos vínculos válidos (§5.2b) |
| **Fatia 5 — envio real** | **Q1, Q2b e Q3 assinadas** (idem: as três valem aqui também); Q5–Q11 aprovadas pelos respectivos donos; **DPO e jurídico assinam**; **todo bloco DECISÃO ABERTA com `decided_by`/`decided_at` preenchidos e o valor promovido**; shadow aprovado |
| **Pós-piloto** | Q12 pode virar ADR próprio. **Não deve ser falsamente resolvida dentro do piloto** |

**Nenhuma fatia de 3 a 5 tem critério de entrada que passe por cima de Q1, Q2b e Q3.** As três aparecem nomeadas em cada uma das três linhas de propósito: uma cadeia implícita ("a linha acima já cobria") é exatamente como um gate some.

**A fatia 2 fica fora desta cadeia.** Por ser endurecimento genérico e inerte (§4.6), ela não depende de nenhuma pergunta em aberto e permanece separável: pode ser feita e mergeada em paralelo, em PR própria.

---

## §14. Critérios de aceite

Verificáveis. Cada um é um teste, não uma opinião. Eles valem para as fatias 3–5, **não para esta PR**, que é só spec.

**Nenhum critério aqui pode depender de uma DECISÃO ABERTA.** Um critério de aceite sobre decisão não assinada é a decisão entrando pela porta dos fundos: quem escreve o teste fixa o valor. Os dois que faziam isso (resposta ao devedor, unidade do holdout) foram removidos e só voltam quando DA-09 e DA-02 forem assinadas.

**Fronteira de decisão**
1. Objetivo do kind nasce `paused`; `setStatus('active')` sem mandato `approved` é recusado.
2. Alterar um byte de `params` após a materialização ⇒ perceptor e executor param com audit `objective_mandate_hash_mismatch`; zero slots novos, zero consumos.
3. Mandato expirado ⇒ nenhum claim de slot.
4. Item de carteira cujo `devedor_pessoa_id` não existe, não tem `telefone_whatsapp` ou não tem perfil de audiência ativo ⇒ **materialização falha alto**, com o item identificado (§5.2b).

**Guardrails**
5. Tentativa de `register_transaction` / `boleto_cancel` / `refund_create` sob o principal do loop ⇒ `tool_not_granted`, com audit.
6. Qualquer envio com `valor > 0` sob `valor_max=0` ⇒ `deny`.
7. Envio com `template_id` fora da allowlist ⇒ recusado antes do dispatch.
8. Nenhum caminho de código permite que a saída do LLM chegue ao corpo da mensagem — teste de arquitetura, no padrão de `tests/unit/runtime/decision/architecture-lock.spec.ts`.
9. Slot com `now()` fora de `[window_start, window_end)` não é percebido nem executado, incluindo na virada de fuso e em feriado (§6.2b).

**Frequência**
10. Duas réplicas do executor sobre o mesmo slot ⇒ exatamente um `consumed`, exatamente uma linha em `idempotency_effect_outbox` (integração com DB real).
11. Reexecução da mesma tarefa após crash pós-enfileiramento ⇒ zero mensagem extra; message id derivado idêntico.
12. Worker parado além de `window_end` ⇒ slots `expired`, zero envio.
13. `(objective_id, carteira_item_id, step)` duplicado ⇒ violação de unique (não `onConflictDoNothing` silencioso).
14. **Teste que documenta a lacuna:** duas dívidas do mesmo devedor na mesma carteira ⇒ duas réguas completas. O teste **afirma o comportamento atual** e cita §7.1b, para que a lacuna seja visível em vez de descoberta em produção.

**Exceções**
15. `legal_intent_detect` positivo ⇒ tarefa `waiting_human`, slots restantes do item `revoked`, exceção listada.
16. Resposta humana devolve a tarefa a `pending` (`resolveTask` com `resume`) e o executor a retoma com a resposta no payload.
17. Exceção expirada ⇒ `failed` + slots `revoked`; **nunca** retomada automática.
18. **VAGO até DA-09 ser assinada.** O critério sobre o que o loop faz com a resposta do devedor depende de qual das quatro opções da DA-09 valer; escrevê-lo agora seria decidir a Q10 dentro de um checklist. O número fica reservado de propósito — some-lo daria a impressão de que o assunto foi coberto.

**Métricas**
19. Holdout e tratamento são reportados separadamente; a métrica de saída é a diferença.
20. **Todos os itens de uma mesma unidade sorteada caem no mesmo braço.** Qual é a unidade vem da DA-02 — o teste lê `holdout_unit` do envelope em vez de fixar a unidade no código, e falha se alguma unidade aparecer nos dois braços.
21. O relatório declara explicitamente o que **não** é reproduzível (§9.1b) em vez de apresentar um número liso.

**Isolamento**
22. `test:leak`: objetivos, slots e exceções invisíveis cross-tenant nos dois sentidos.
23. Slot do tenant A não é claimável sob contexto de B.

**Piloto**
24. `MAIA_COBRANCA_PILOT_TENANTS` vazio ⇒ kind inerte mesmo com objetivo `active` e mandato válido.
25. Grupo `console` fora de `MAIA_SCHEDULER_GROUPS` ⇒ nenhum tick.
26. Item fora da carteira nunca recebe slot nem contato.
27. Breaker: reclamações acima do limiar ⇒ objetivo `paused` automaticamente, sem re-arme.

---

## §15. Entrega faseada

A draft usava letras A–E; a #696 usa "fatia A/B/C–E" com outro corte. Para acabar com a ambiguidade, **a numeração canônica passa a ser 1–5**, com o mapeamento explícito:

| Fatia | Conteúdo | Estado | Letra antiga |
|---|---|---|---|
| **1** | lease, fencing, reaper, predicado de tenant em `objective_tasks` | **MERGEADA** — #696, `migrations/138` | A (draft) / A (#696) |
| **2** | dispatcher por tenant no perceptor + lote limitado. Genérico e inerte | Aberta. **Separável** (§4.6) | parte de A (draft) / B (#696) |
| **3** | migração de slots, repos, materialização, guard de hash, superfície de console. Kind **sem envio** | Bloqueada por §13 | B (draft) |
| **4** | **shadow**: kind completo, envio **sinkado**. Carteira real, mensagens reais montadas, nada sai | Bloqueada por §13 | C (draft) |
| **5** | piloto com envio ligado, uma carteira, mandato curto | Bloqueada por §13 | D (draft) |
| **pós** | relatório tratamento × controle; ir/não-ir da fase 2; Q12 vira ADR próprio | — | E (draft) |

A fatia 4 é a que não deve ser pulada: é a única em que um erro de perceptor custa zero. Cobrar quem já pagou é o dano mais provável e o mais caro em confiança — e é exatamente o que o shadow mede antes de doer.

---

## §16. Riscos residuais, e o que esta revisão NÃO verificou

| Risco | Mitigação | Residual |
|---|---|---|
| Cobrar quem já pagou | revalidação em duas etapas (§4.4/§4.5) + fatia 4 | **Alto enquanto Q1 estiver aberta.** É o risco que decide o piloto |
| Exceder um teto jurídico por destinatário | nenhuma | **Alto e NÃO mitigado** — §7.1b. É lacuna de mecanismo, não de configuração |
| Métrica de saída interpretada como prova | §9.1b declara o que não é reproduzível | **Médio** — depende de o relatório repetir a declaração |
| Holdout contaminado | **nenhuma até DA-02 ser assinada** — o sorteio por item contamina, e a spec não escolheu substituto | **Alto enquanto DA-02 estiver aberta**; mesmo depois, a interferência do time humano de cobrança permanece |
| Mensagem entregue após decisão de parar | janela curta de slot; níveis 0–3 | Baixo, irreversível por natureza |
| Principal de serviço vira porta larga | `valor_max=0`, grants mínimos, `denied_tools` | **Médio-alto até Q3 ser respondida** — e Q3 é trabalho novo, não herdado de #521 |
| Template cordial soa mal em contexto real | revisão humana na aprovação + fatia 4 | Médio — é julgamento, não teste |
| Mandato como procuração em branco | a equivalência da §5.1 só vale enquanto o LLM não tocar o intent | **Alto se algum PR futuro der liberdade de redação ao modelo.** O aceite 8 existe para falhar alto nesse dia |
| Alguém confiar em `import:ofx` | §12.Q2c diz que está morta | **Alto até a issue própria fechar** — o comando continua listado no `AGENTS.md` §6 |

**O que esta revisão NÃO verificou** (declarado por exigência de honestidade, não como ressalva de estilo):

- **A reprodução empírica do erro de `import:ofx` não foi re-executada.** Não há Postgres nem Docker alcançável neste ambiente. A verificação feita foi estática e é completa no seu nível: schema `NOT NULL` (`src/db/schema.ts:1109`), remoção do default pela `083`, insert sem as colunas (`scripts/import-ofx.ts:79`), ausência total de contexto de tenant nos dois scripts. A mensagem literal de erro vem da reprodução do dono.
- **Nenhum dado de tenant real foi inspecionado.** Tudo o que a Q1 pergunta sobre população e frescor de `transacoes` continua sem resposta empírica aqui.
- **Nenhuma execução de worker.** `objective_perceive`/`objective_execute` nunca rodaram em produção (o grupo `console` nasce desligado); esta revisão leu o código, não o observou rodando.
- **Nenhuma consulta jurídica.** Todos os números da Q5 permanecem em branco de propósito.
- **Nenhuma das dez DECISÕES ABERTAS foi decidida aqui, e nenhuma delas tem valor de exemplo neste documento.** Um "por exemplo, X%" repetido três vezes vira default sem que ninguém tenha escolhido — foi assim que a draft chegou a uma fração, uma cadência, uma janela e um teto de passos que nenhum dono assinou. O guard `tests/unit/docs/decisoes-abertas-cobranca.spec.ts` reprova esses valores nas formas enumeradas na lista dele, e reprova também um bloco assinado sem o valor promovido. **Ele NÃO cobre prosa arbitrária** — o cabeçalho do teste lista as formas que sabidamente atravessam, e o que impede a reincidência de verdade é o procedimento de promoção, não a regex.
