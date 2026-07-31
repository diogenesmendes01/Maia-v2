# Work Loop v2 — Objetivo `cobranca_amigavel`: régua de cobrança em piloto — Design Spec

**Date:** 2026-07-31
**Status:** Draft v1 — spec exigida pela issue #469 ("Exige spec própria antes de implementar") para a **v2** do work loop. A v1 (entidade Objetivo, registry de kinds, workers perceive/execute, fila de exceções no console) já está em `main` — ver `docs/superpowers/specs/2026-06-10-agent-work-loop-design.md` §8-v1 e migração `migrations/088_agent_objectives.sql`. Esta spec substitui o §6 e o §8-v2 daquele documento.
**Scope:** O primeiro objetivo com efeito colateral real — **régua de cobrança amigável de inadimplentes**, em **piloto com UM tenant e UMA carteira enumerada**. Define onde vive a fronteira "backend decide / agente propõe" quando o agente acorda sozinho, como a lista de proibições vira mecanismo, como a frequência resiste a retry/réplica, como a exceção humana destrava a tarefa, como a métrica de saída (R$ líquido recuperado) é auditável, e como desligar depressa.
**Master refs:** `2026-06-10-learnable-workforce-vision.md` §2.3 (work loop) e §4 (fase 2 — critério de saída "um trabalho inteiro provado com cliente real, medido em R$"); `ARCHITECTURE.md` invariantes 1–6; `docs/architecture/concerns/action-layer.md` §1/§4.2/§4.4; `docs/architecture/concerns/capability-taxonomy.md` §2 (composição do turno), §3 (quem decide o quê), §4 (o que nunca pode ser baseline); `docs/architecture/concerns/governance-observability.md` §1/§4.
**Architecture Locks:** os 6 invariantes são stop conditions. Em particular o work loop **não cria caminho novo de side-effect** — todo envio sai pelo `dispatchTool` → `idempotency_effect_outbox` → relayer que já existe. Nenhum guard existente é afrouxado; esta spec só ADICIONA restrição.
**Depends on:** #469 v1 (migração 088, registry de kinds, workers); #521 Fase 0 cap. 1–3 (`evaluateFinancialAuthorization`, `approval_requests`/`approval_decisions`, LLM fora do circuito de aprovação); #316 (outbox de efeito exactly-once); #408/#437 (grants e packs).
**Blocks:** critério de saída da fase 2 do blueprint; kind `agenda_confirm` (v3), que só é honesto depois que um segundo domínio force a generalização.

---

## §0. Purpose & problema

A v1 provou o **ciclo**: objetivo → percepção → tarefa idempotente → claim → execução → exceção → retomada. Provou com o kind sintético `manual`, cujo executor não toca nada (`src/objectives/kinds.ts:40-62`). O que falta é a parte difícil: um objetivo cujo executor **fala com um terceiro sobre dinheiro, sem ninguém ter pedido naquele instante**.

Todo o modelo de governança da Maia foi desenhado em torno de um turno: chega mensagem → resolve tenant/pessoa/permissão → decision engine (early/mid/late PEP) → dispatcher guard → tool. A **mensagem do humano é o evento autorizador**, e `ctx.pessoa` + `ResolvedPermission` são o principal contra o qual `canAct` e `evaluateFinancialAuthorization` decidem.

O work loop não tem nada disso. Ele acorda por cron. Não há mensagem, não há interlocutor, não há permissão resolvida. **A pergunta central desta spec é: qual é o gate, então?** Responder "o prompt do agente diz para não fazer X" não é resposta — prompt não é mecanismo.

Três problemas concretos que caem dessa pergunta e que a spec resolve nas §5–§8:

1. `constitutionalCheck` C-003/C-007 (`src/governance/rules.ts`) exige 4-eyes **incondicionalmente** para `send_proactive_message` e `start_recurring_outreach`, e desde #521 a evidência só pode vir de `approval_requests` — o argumento do modelo não atesta mais nada. Uma régua de cobrança faz N envios. Ou o mandato pré-satisfaz a exigência de forma auditável, ou cada mensagem precisa de duas assinaturas humanas e a autonomia é ficção.
2. Não existe **teto de frequência por destinatário**, nem janela de silêncio. O que existe é *vazão*: `tryAcquireSendSlot` (`src/scheduling/backpressure.ts`) impõe 2s entre mensagens ao mesmo JID e baldes global por segundo/hora — o suficiente para não tomar ban do WhatsApp, longe do suficiente para "no máximo 3 contatos por devedor". A única janela deslizante do repo (`src/gateway/rate-limit.ts`) é *inbound, por pessoa*. O que de fato segura o outbound proativo hoje é a exigência de dual approval — exatamente o que o loop precisa relaxar.
3. `objective_tasks` **não tem lease, nem heartbeat, nem reaper**. Um SIGKILL entre o claim e o `transitionTask` deixa a tarefa em `running` para sempre (`src/db/repositories/objective-repos.ts:177`, `:228`). Com o kind `manual` isso é um item preso numa lista; com cobrança é uma régua que para no meio e ninguém percebe.

**Não-objetivos** (explícitos, §1.2): conversar livremente com o devedor; qualquer negociação; integração bancária nova; generalizar o kind para outros domínios; substituir o time de cobrança.

---

## §1. Escopo

### §1.1 Em escopo

- Kind `cobranca_amigavel` no registry (`src/objectives/kinds.ts`) com `perceive` + `execute`.
- **Mandato** hash-pinado como fronteira de decisão (§5) e sua materialização em **slots de contato** consumíveis uma única vez (§7).
- Catálogo de **templates aprovados com slots tipados** — o agente não redige texto livre para devedor (§6.3).
- Fila de exceções no console, com retomada da tarefa pelo humano e expiração fail-closed (§8).
- Ledger auditável de contato + desfecho, e a métrica de R$ líquido recuperado com **grupo de controle** (§9).
- Endurecimento do caminho v1 que a cobrança torna obrigatório: lease + reaper em `objective_tasks`, predicado de tenant em `transitionTask`, worker em phase 1 atrás de flag, dispatcher por tenant (§4.4).
- Plano de piloto (um tenant, uma carteira enumerada) e quatro níveis de desligamento (§11).

### §1.2 Fora de escopo

| Fora | Por quê |
|---|---|
| Resposta livre ao devedor pelo agente | Texto livre para terceiro sobre dívida é uma superfície de risco diferente (jurídica, não técnica). Inbound do devedor **sai** do loop: vira exceção humana (§8.2). |
| Negociar, parcelar, descontar, dar baixa, alterar saldo | Proibição do owner; mecanizada em §6 por ausência de grant + `denied_tools` + `valor_max=0`. |
| Integração bancária / conciliação de pagamento nova | Fora do escopo desta spec **e é o maior risco do piloto** — ver §12.Q1. |
| Segundo kind / generalização | v3. Generalizar a partir de um caso é como se inventa abstração errada. |
| Cobrança de dívida contestada, negativada, prescrita ou judicializada | Decisão de negócio/jurídica. §12.Q4/Q5. |
| Aprovação de mandato via WhatsApp | Dual-approval e travas de arquitetura permanecem exclusivos do console (blueprint §2.4). |

---

## §2. O que já existe (reuso) × o que é novo

Isto é o núcleo da spec: quase tudo já está construído. O novo é pequeno, e é pequeno de propósito.

### §2.1 Reuso — verificado no HEAD `7b34e7e0`

| Necessidade | Mecanismo existente |
|---|---|
| Entidade Objetivo + tarefas idempotentes | `migrations/088_agent_objectives.sql` — `agent_objectives`, `objective_tasks`, índice parcial `objective_tasks_live_natural_key_uq` |
| Registry de perceptor/executor tipado | `src/objectives/kinds.ts` — `ObjectiveKind`, `ExecuteResult` |
| Claim sem corrida | `objectivesRepo.claimNextPendingTask()` (`FOR UPDATE SKIP LOCKED`), `src/db/repositories/objective-repos.ts:177` |
| Cancelamento de tarefa órfã | mesmo claim: objetivo ausente/não-`active` ⇒ tarefa `cancelled` |
| CRUD owner-only auditado + fila de exceções | `src/admin-ui/trpc/routers/objectives.ts` (`create`/`setStatus`/`resolveTask`/`listExceptions`) |
| **Evidência imutável de aprovação humana** | `approval_requests` + `approval_decisions` (`migrations/095`), `src/governance/approval-requests.ts` — `computeIntentHash`, `ensureApprovalRequest`, `claimExecutableApproval` (claim atômico de vencedor único), `consumeApproval` |
| **Limite financeiro determinístico** | `evaluateFinancialAuthorization` (`src/governance/financial-authorization.ts`) — `valor_max` individual, naturezas/categorias, `horario_permitido` timezone-aware, `FINANCIAL_POLICY_VERSION`, math em centavos, fail-closed. **Atenção: gate financeiro por permissão de pessoa, NÃO gate de horário de mensagem** — §6.2b |
| **Autoridade final de execução** | `dispatchTool` (`src/tools/_dispatcher.ts`) — 17 passos, incl. o guard `tool_not_granted` (:114-172) revalidado server-side |
| **Escopo de ferramentas** | `agent_tool_grants` (`src/db/schema.ts:316`) + `computeAgentVisibleTools` (`src/tools/grant-math.ts`); `denied_tools` é **HARD** e vence qualquer grant |
| Envio exactly-once | `markCompletedWithEffect` → `idempotency_effect_outbox` (UNIQUE `(tenant_id, agent_id, idempotency_key)`) → `src/workers/idempotency-outbox-relayer.ts` → `deriveProviderDedupKey` (id de mensagem WhatsApp determinístico, derivado da ROW persistida) |
| Idempotência no dispatch | `computeIdempotencyKey` / `tryReserve` / fencing por `reservation_token` (`src/governance/idempotency.ts`, `src/db/repositories/idempotency-repos.ts`) |
| Follow-up recorrente | séries→ocorrências→tasks→outbox (`src/scheduling/`), `outreachTaskBlueprint()`, `exclusive_per_destinatario`, `missed_run_policy: 'escalate_to_owner'`, `escalateOutreachTimeout` |
| Dias úteis / feriados | `computeNextWithBusinessDays` (`src/scheduling/business-day-rrule.ts`) |
| Backpressure de saída | `tryAcquireSendSlot(jid)` (`src/scheduling/backpressure.ts`) — pacing de 2s por destinatário + baldes global (`OUTBOX_MAX_PER_SECOND=2` / `PER_HOUR=120`), fail-closed com Redis fora. **Atenção: só o `outbox-drain` o consome, não o relayer de efeito** — §7.3 |
| Sinal de risco jurídico | `legal_intent_detect` (`src/tools/legal-intent-detect.ts` — **determinístico, léxico PT-BR**, confiança computada, não-LLM) + `case_risk_classify` |
| Pending questions + expiração | `pendingQuestionsRepo` (`src/db/repositories/conversation-repos.ts`), `src/workers/pending-expirer.ts` (1min, hard expiry), `pending-reminder.ts` (máx. 2 lembretes). **Ver §8.4 — o que dá para reusar aqui é menos do que a v1 supôs** |
| Audit + métricas rotuladas | `audit()` / `auditTx()` (`src/governance/audit.ts`); ações no enum tipado `src/governance/audit-actions.ts`; `src/observability/metrics.ts` + `taxonomy.ts` + `labels.ts` (#514) |
| Pausa global | `src/governance/lockdown.ts` |
| Dispatcher por tenant | `schedulingDispatch.enumerate*Tenants` + `runWithTenantContext` fail-isolado (#355) |

### §2.2 Novo

1. **`objective_contact_slots`** — a tabela de slots de contato pré-autorizados (§7.1). É o único artefato de dados novo, e faz quatro trabalhos ao mesmo tempo: gate por envio, teto de frequência, kill-switch e substrato da métrica.
2. **`src/objectives/kinds/cobranca-amigavel.ts`** — perceptor + executor do kind.
3. **Catálogo de templates** versionado em código, com slots Zod (§6.3).
4. **A ponte exceção ↔ humano** (§8.4) — a v1 documentou essa retomada como se existisse; ela não existe. É construção, não reuso.
5. **Endurecimento do caminho v1** (§4.4): lease + reaper, predicado de tenant, phase 1 atrás de flag, dispatcher por tenant.
6. **Superfície de console**: bloco de mandato na aba Objetivos + painel do piloto.
7. Ações novas no enum tipado `src/governance/audit-actions.ts` (§9.4) — não dá para auditar ação fora do enum.

### §2.2b Por que o executor NÃO usa procedures

A spec v1 (§6) previa o executor como uma procedure `cobranca_inadimplencia`. Verificado no HEAD, isso não é construível hoje, por duas razões independentes:

- **O motor de procedures não causa side-effect, ele observa.** Não há caminho de `src/procedures/engine.ts` nem de `src/cognition/step-evaluator.ts` para o dispatcher. A dependência corre ao contrário: o ReAct loop chama tools e a camada de procedure registra `tool_called` depois do fato. Um executor de work loop precisa *causar* o envio.
- **Nada no sistema em execução consegue ativar uma procedure.** `transitionProcedureStatus` (`src/cognition/procedure-status.ts:100`) e `atomicActivate` não têm nenhum caller de produção, e o router `procedures` do admin-ui é somente leitura. O `procedure-candidate-consumer` cria definições em `draft`. Como o seletor filtra `status !== 'active'`, uma procedure criada hoje nunca é selecionada.
- Além disso, o avanço de passo só acontece como efeito de cauda de um **turno de entrada** (nó `step-evaluator-trigger` do post-turn graph). Um loop que acorda por cron não tem turno.

Logo o executor chama `dispatchTool` diretamente, que é o caminho de side-effect canônico e o mesmo que `src/scheduling/engine.ts:713` e `src/agent/pending-resolver.ts:165` já usam. `objective_tasks.procedure_execution_id` fica NULL nesta versão. Ligar work loop a procedures continua desejável e vira trabalho próprio — não é pré-requisito da cobrança, e fingir que é atrasaria o piloto atrás de um subsistema que precisa de conserto antes.

### §2.3 Por que a 088 não cobre o slot

Verificado antes de propor migração, como manda a issue. A 088 dá idempotência de **tarefa viva** — `objective_tasks_live_natural_key_uq` é `UNIQUE (objective_id, natural_key) WHERE status NOT IN ('done','failed','cancelled')`. Isso impede duas tarefas concorrentes para a mesma chave. **Não** impede que, depois que a tarefa da semana 1 vira `done`, uma re-percepção recrie a tarefa da semana 1 e contate a pessoa de novo. O índice é parcial por desenho (é o que permite o follow-up da semana 2 existir), e por isso não pode servir de teto de frequência.

Também não há em 088 nenhum lugar para guardar "este contato foi pré-autorizado pelo mandato M, é o k-ésimo de no máximo N, vale até T". Uma coluna nova em `objective_tasks` não serviria: o slot precisa existir **antes** e **independentemente** da tarefa, porque é ele que autoriza a tarefa a existir.

Migração nova, portanto, justificada — `_up` + `_down`, prefixo reservado via `npm run migrate:reserve` no momento da implementação (o próximo livre no ledger é 108; 104–106 estão reservados por branches em voo, ver `migrations/RESERVATIONS.md`).

**Armadilha a evitar:** `objectivesRepo.upsertTask` usa `.onConflictDoNothing()` **sem target** (`objective-repos.ts`), então ele engole conflito de *qualquer* índice único da tabela. Se algum índice novo tocar `objective_tasks`, o `onConflictDoNothing` precisa ganhar target explícito no mesmo PR — senão um bug de unicidade vira silêncio.

---

## §3. Modelo de dados

### §3.1 Uso das tabelas existentes

`agent_objectives` — uma linha por régua. `kind='cobranca_amigavel'`. `params` carrega o **envelope** (§5.2). `status` usa os três valores que a 088 já permite (`active|paused|archived`): o objetivo **nasce `paused`** (regra de router, §5.4) e só vira `active` com mandato válido.

`objective_tasks` — uma linha por *contato planejado*. `natural_key = 'cob:v1:{slot_id}'` (o slot é a identidade). `payload` = `{ slot_id, template_id, devedor_pessoa_id, carteira_item_id, step }`. `pending_question_id` — coluna que a 088 já criou e a v1 deixou sem uso — passa a ser preenchida (§8).

`approval_requests` — **uma** linha por mandato, `approval_class='two_distinct_owners'`, `tool='objective_mandate'`, `intent_payload` = o envelope canônico, `intent_hash` via `computeIntentHash`, `expires_at` obrigatório (é o fim do piloto).

### §3.2 Novo: `objective_contact_slots`

Formato proposto (não é código de produção; a implementação reserva o prefixo e escreve `_up`/`_down`):

```sql
CREATE TABLE objective_contact_slots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id        uuid NOT NULL REFERENCES agent_objectives(id) ON DELETE CASCADE,
  tenant_id           text NOT NULL,
  agent_id            text NOT NULL,
  mandate_request_id  uuid NOT NULL,      -- approval_requests.id
  mandate_hash        text NOT NULL,      -- cópia do intent_hash no momento da materialização
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

-- O teto de frequência: UM slot por (carteira_item, passo). Não é um contador.
CREATE UNIQUE INDEX objective_contact_slots_step_uq
  ON objective_contact_slots (objective_id, carteira_item_id, step);

-- Fila do perceptor.
CREATE INDEX objective_contact_slots_ready_idx
  ON objective_contact_slots (objective_id, window_start)
  WHERE status = 'available';

CREATE INDEX objective_contact_slots_scope_idx
  ON objective_contact_slots (tenant_id, agent_id, status);

-- Espelha 095: estado de claim carrega seu token (fail-loud em drift).
ALTER TABLE objective_contact_slots
  ADD CONSTRAINT objective_contact_slots_claim_token_chk
  CHECK (status NOT IN ('claimed','consumed') OR claim_token IS NOT NULL);
```

Três propriedades que fazem o desenho inteiro funcionar:

- **O número máximo de mensagens é uma contagem física de linhas.** Não existe caminho pelo qual o loop envie mais do que os slots materializados na ativação. Não há contador para driftar, nem janela para calcular errado sob concorrência.
- **`window_end` é a validade do slot.** Um worker parado 6 horas não acorda e dispara a rajada acumulada: os slots vencidos vão para `expired` e são inelegíveis para sempre. Isso é o oposto de `missed_run_policy: 'fire_all'`, e é deliberado.
- **`status='holdout'`** marca, na mesma tabela, os itens da carteira sorteados para o grupo de controle (§9.2) — que nunca serão contatados, mas cuja evolução é medida com o mesmo relógio e o mesmo código.

---

## §4. Fluxo do loop

### §4.1 Ativação (uma vez, humano no comando)

1. Owner cria o objetivo no console. Router força `status='paused'` para este kind. Nada acontece.
2. Owner submete o **envelope** (§5.2). O backend valida: cada item da carteira resolve para um recebível em aberto **e** para uma pessoa contatável (§5.2b); todo `template_id` está na allowlist; a janela de contato é bem-formada; o teto de passos respeita o máximo do kind. Então calcula `computeIntentHash` e chama `ensureApprovalRequest` com `approval_class='two_distinct_owners'`.
3. **Dois owners distintos aprovam** no console. `approval_decisions` registra cada assinatura (única por `(request, principal)`).
4. Na transição do request para `approved`, o backend **materializa os slots** numa transação: para cada item da carteira, sorteia holdout ou tratamento (semente fixa derivada do `intent_hash` — reprodutível), e insere `step=1..N` com as janelas derivadas da RRULE do envelope. Auditado (`objective_mandate_materialized`, com contagens).
5. Owner faz `setStatus('active')`. O router recusa se não houver mandato `approved` cujo hash case com os `params` atuais.

Só agora o worker tem trabalho.

### §4.2 Percepção (`objective_perceive`, cron)

Determinística e não-LLM, como manda o princípio central da v1. Para cada objetivo `active` do kind:

1. Guard de piloto (§11.1): tenant fora da allowlist ⇒ no-op + audit. Fail-closed.
2. Guard de mandato: recalcula `computeIntentHash(objective.params)`; se ≠ `mandate_hash` dos slots, **para tudo** e audita `objective_mandate_hash_mismatch`. Um envelope editado invalida a régua inteira, sem exceção.
3. Seleciona slots `available` com `window_start <= now() < window_end`, limitado por lote.
4. Para cada slot, **revalida contra o estado do mundo agora** (não na ativação): o item ainda está em aberto? não houve pagamento? não há sinal jurídico registrado? não há resposta do devedor pendente? Qualquer não ⇒ slot para `revoked` com motivo auditado, sem tarefa.
5. Os que sobram viram tarefa via `upsertTask` (`natural_key = 'cob:v1:{slot_id}'`).

O passo 4 é o que impede o caso mais óbvio de dano: cobrar quem já pagou. Ele depende inteiramente de a liquidação estar visível para a Maia — ver §12.Q1.

### §4.3 Execução (`objective_execute`, drain)

Por tarefa claimada, sob `runWithTenantContext` derivado da row:

1. `claimSlot(slot_id)` — CAS `available → claimed` com `claim_token` novo, espelhando `claimExecutableApproval`. Perdedor da corrida ⇒ `ExecuteResult.failed` benigno, tarefa não reexecuta.
2. Revalida os guards de §4.2 passo 4 (o mundo pode ter mudado entre percepção e execução).
3. Monta o intent do envio **inteiramente no backend**: `template_id` vem do slot; os slots de texto são preenchidos com valores lidos do banco (nome, valor, data, link). O LLM **não participa** deste passo. (§6.3)
4. `dispatchTool('send_proactive_message', ...)` pelo caminho normal — dispatcher guard, idempotência, `extractEffect` → `idempotency_effect_outbox`, relayer envia uma vez.
5. `consumeSlot(slot_id, claim_token)` — CAS `claimed → consumed`, one-time. Registra `outcome`.
6. Agenda o follow-up: o slot `step+1` já existe e já tem janela; não há nada a agendar. Séries/ocorrências são usadas apenas quando o passo exige espera-por-resposta com timeout (`outreachTaskBlueprint`, `escalateOutreachTimeout`).
7. `transition: 'done'`.

Falha de execução: `releaseSlot` devolve para `available` **apenas se a janela ainda for válida e o efeito comprovadamente não foi enfileirado**; caso contrário o slot vai para `expired` (fail-closed — perder um contato é aceitável, duplicar não é).

### §4.4 Endurecimento obrigatório do caminho v1

A cobrança torna quatro lacunas da v1 inaceitáveis. Fazem parte da entrega:

| Lacuna verificada | Correção |
|---|---|
| `objective_tasks` sem lease/heartbeat/reaper — crash deixa `running` preso para sempre (`objective-repos.ts:177`) | Colunas `claimed_by`/`claimed_at`/`lease_expires_at` + reclaim de lease vencida no início do tick, no padrão de `occurrencesRepo.reclaimExpiredLeases` (`src/scheduling/repos.ts:691`). O reclaim NÃO reexecuta o envio: o slot em `claimed` é a barreira. |
| `transitionTask` sem predicado de tenant e sem fencing token (`objective-repos.ts:228`) | Adicionar `tenant_id`/`agent_id` ao WHERE e exigir o token do claim. É invariante 1, não otimização. |
| Workers em `phase: 2`, e produção chama `startWorkers(1)` — **nunca são agendados** (`src/workers/index.ts:85-86`) | Re-homear para phase 1 **atrás de flag default-off**, como fizeram `synthetic_probe` e `mcp_sync`. A flag, não a fase, é o gate de comportamento. |
| `runObjectivePerceiveWorker` varre `agent_objectives WHERE status='active'` sem `LIMIT` e sem dispatcher por tenant | Enumerar tuplas `(tenant_id, agent_id)` com trabalho e usar o padrão fail-isolado de #355; lote limitado. |

As colunas de lease são **aditivas em `objective_tasks`**, e migração é append-only: entram na mesma migração nova do §3.2 (ou numa própria da fase A), nunca editando a 088.

Duas armadilhas do caminho v1 que a fase A precisa fechar junto:

- `objectivesRepo.upsertTask` usa `.onConflictDoNothing()` **sem target**. Com um índice único novo na tabela, ele passa a engolir silenciosamente o conflito errado. Precisa de target explícito no mesmo PR.
- O tick tem guard de auto-sobreposição (`runTick` pula se o job anterior ainda roda, `src/workers/index.ts:226`), e o comentário do próprio arquivo assume que todo job longo é single-flight **por lease de DB**. Hoje `objective_execute` não é — o guard só vale dentro de um processo. Com lease, a premissa passa a valer também entre réplicas.

---

## §5. A fronteira de decisão: o mandato

### §5.1 O argumento

O gate não pode ser a mensagem do usuário, porque não há mensagem. Também não pode ser "o LLM foi instruído", porque isso não é gate. A resposta desta spec é que o gate **muda de lugar no tempo**: sai do instante da ação e vai para um ato humano anterior, durável, assinado por dois, com hash e validade.

Isso só é legítimo sob uma condição, e vale enunciá-la porque é a espinha do desenho:

> Se o intent de cada envio é **inteiramente determinado** pela tupla (mandato, item da carteira, passo) — sem nenhum grau de liberdade do LLM — então aprovar o envelope é matematicamente equivalente a aprovar cada envio individualmente.

A condição é satisfeita por construção: a carteira é enumerada e fixa (§5.2), o texto vem de um catálogo de templates aprovados (§6.3), os valores vêm do banco, e o calendário é derivado por RRULE determinística. O modelo não escolhe destinatário, nem valor, nem data, nem redação. Ele não participa da montagem do envio.

É por isso que o mandato é um gate honesto e não uma procuração em branco. Se alguma dessas propriedades cair — se o LLM ganhar liberdade de redigir, ou a carteira virar uma query — o argumento cai junto e o mandato deixa de ser suficiente.

### §5.2 O envelope

Conteúdo canônico de `intent_payload` (a ordem é fixada pelo `computeIntentHash`):

```jsonc
{
  "kind": "cobranca_amigavel", "envelope_version": 1,
  "tenant_id": "...", "agent_id": "...", "objective_id": "...",
  "carteira": [                             // ENUMERADA. Nunca uma query. Ver §5.2b
    { "item_id": "...", "transacao_id": "...", "devedor_pessoa_id": "...", "valor_centavos": 0 }
  ],
  "holdout_fraction": 0.2,                  // grupo de controle (§9.2)
  "steps": [ { "step": 1, "template_id": "cob.lembrete_cordial.v1", "offset_days": 0 },
             { "step": 2, "template_id": "cob.followup_1.v1",       "offset_days": 7 } ],
  "max_steps_per_item": 3,
  "contact_window": { "tz": "America/Sao_Paulo", "inicio": "09:00", "fim": "18:00",
                      "dias": ["MO","TU","WE","TH","FR"], "respeita_feriados": true },
  "valor_max_centavos": 0,                  // o agente não move dinheiro (§6.2)
  "attribution_window_days": 14,            // fixado ANTES de medir (§9.1)
  "expires_at": "2026-..."
}
```

**A carteira é uma lista, não um filtro.** Essa é a resposta à exigência "limitar a uma carteira sem gambiarra": um item que não está na lista não pode ser contatado, porque não existe slot para ele. Não há flag para afrouxar, nem `WHERE` para alargar. Ampliar a carteira significa novo envelope, novo hash, nova aprovação de dois owners — e os slots antigos continuam válidos, os novos são materializados à parte.

`attribution_window_days` estar dentro do hash é intencional: fixa a régua de medição **antes** de existir resultado, para que ninguém a ajuste depois para melhorar o número (§9.1).

### §5.2b O item da carteira carrega o vínculo devedor→WhatsApp, porque o schema não carrega

Lacuna verificada, e é séria: **não existe caminho de "quem deve" para "qual número mandar mensagem".** O devedor no razão é `transacoes.contraparte_id → contrapartes` (`src/db/schema.ts:182`), que tem `nome`, `documento`, `chave_pix` — e **nenhum telefone e nenhuma referência a `pessoas`**. Quem tem `telefone_whatsapp` é `pessoas` (`:199`), com unicidade `(tenant_id, agent_id, telefone_whatsapp)`. As duas tabelas não se falam. E `send_proactive_message` exige `pessoa_id_destino`.

Some-se a isso `agent_audience_profiles` (`migrations/074`): uma pessoa **sem perfil de audiência ativo é colocada em quarentena e nunca é atendida** (fail-closed, #407).

Por isso o item da carteira não é um id solto: é um **vínculo validado na ativação** — `(item_id, transacao_id, devedor_pessoa_id, valor_centavos)`. O backend recusa materializar o mandato se, para qualquer item, o `devedor_pessoa_id` não existir, não tiver `telefone_whatsapp` válido, ou não tiver perfil de audiência ativo para este agente.

Isto tem um efeito útil: transforma um problema de dados silencioso ("por que o agente não contatou fulano?") num erro alto na ativação, antes do piloto começar. E deixa explícito o trabalho de curadoria que o tenant precisa fazer — ver §12.Q2b.

### §5.3 Ciclo de vida

| Evento | Efeito mecânico |
|---|---|
| Envelope editado (qualquer byte) | hash muda ⇒ perceptor e executor param no guard de §4.2/§4.3; nenhum slot novo, nenhum consumo |
| `expires_at` atingido | slots vencem; nada a claimar |
| Mandato revogado pelo owner | slots `available`/`claimed` → `revoked`; efeitos já enfileirados no outbox seguem (não há como despublicar uma mensagem — declarado, não escondido) |
| Objetivo `paused` | claim cancela tarefas órfãs (comportamento v1, `objective-repos.ts:177`) |
| Lockdown global | `src/governance/lockdown.ts` — pausa tudo |

### §5.4 Onde a regra mora

No **router** (`src/admin-ui/trpc/routers/objectives.ts`), não no worker: `create` força `paused` para o kind; `setStatus('active')` exige mandato `approved` com hash casado. No **worker**, o guard de hash é revalidado a cada tick — o router é conveniência, o worker é autoridade. É o mesmo princípio de `capability-taxonomy.md` §2 passo 8: visibilidade é conveniência, o dispatcher revalida do zero.

### §5.5 Em que canal o mandato é assinado

Ponto que exige decisão explícita, porque os dois vocabulários de "approval class" do repo não são o mesmo e é fácil confundi-los:

- As classes de `approval_requests` (`single_confirmation` / `requester_plus_one_owner` / `two_distinct_owners`) são, por desenho de #521, **decididas por WhatsApp**: `notifyForRequest` manda `AP-xxxxxxxx` aos owners e `parseApprovalReply` intercepta `"aprova AP-xxxxxxxx"` **antes do LLM**, identificando o humano pela linha autenticada. Expiram em `DUAL_APPROVAL_TIMEOUT_HOURS` (default **6h**).
- As 16 classes de `src/admin-ui/lib/approval-matrix.ts` são governança de proposta e são **exclusivas do console**.

Ativar uma régua autônoma é mudança de comportamento, e o blueprint §2.4 mantém dual-approval no console. Mas o mecanismo que dá a evidência imutável (`approval_requests`) é WhatsApp-nativo. A spec adota: **decisão no console**, com `approval_requests` como o registro de evidência, e a notificação por WhatsApp servindo de aviso, não de canal de assinatura. Isso exige que `recordApprovalDecision` aceite `channel: 'console'` (o campo existe; o default é `'whatsapp'`).

Um detalhe operacional que decorre disso: 6h de TTL é curto para uma aprovação que exige dois owners no console. O TTL do mandato provavelmente precisa ser próprio, não o global — §12.Q9.

---

## §6. Guardrails como mecanismo

A lista do owner, traduzida uma a uma. Nenhuma linha depende de prompt.

### §6.1 O mapa

| Proibição | Mecanismo | Onde falha |
|---|---|---|
| Conceder desconto | Nenhuma tool de desconto existe; se existir, entra em `agent_tool_grants.denied_tools`, que é **HARD** e vence qualquer grant (`grant-math.ts`) | `dispatchTool` → `tool_not_granted` (`_dispatcher.ts:114-172`), com audit |
| Renegociar / alterar saldo | `register_transaction`, `boleto_cancel`, `refund_create`, `company_campaign_remove` **fora dos packs concedidos**. Nenhum pack de escrita é concedido ao agente do piloto | idem `tool_not_granted`; e `capability-taxonomy.md` §4: write nunca é baseline |
| Mover dinheiro | `effective_limits.valor_max = 0` ⇒ `evaluateFinancialAuthorization` retorna `deny/above_individual_limit` para qualquer valor > 0 | `_dispatcher.ts` passo 12 |
| Ameaçar | **Catálogo de templates** (§6.3) — o agente não produz texto para devedor | impossível por construção: não há caminho do modelo até o corpo da mensagem |
| Decidir sobre dívida contestada | `legal_intent_detect` (determinístico) positivo ⇒ transição obrigatória para `waiting_human` e `revoked` em todos os slots restantes daquele item | §8.1 — a decisão de parar é do backend, não do modelo |
| Exceder a frequência | Slot consumível uma única vez + unique `(objective_id, carteira_item_id, step)` | §7 |
| Contatar fora de hora | **`window_start`/`window_end` do slot** (derivados da janela do envelope + `computeNextWithBusinessDays` para feriados) — ver §6.2b | perceptor não cria tarefa; executor recusa slot fora da janela |

### §6.2 Sobre `valor_max = 0`

O agente do piloto não é uma pessoa. Precisa de um **principal de serviço** — uma `pessoa` dedicada, vinculada ao objetivo, cuja `ResolvedPermission` tem `valor_max = 0`, naturezas/categorias vazias e `horario_permitido` = a janela do envelope. Isso reusa `evaluateFinancialAuthorization` sem tocá-lo: com `valor_max = 0`, todo montante positivo cai em `deny`.

Duas consequências que a implementação precisa respeitar: o principal de serviço **não pode ser dono/co_dono** (senão pega a isenção de dual-approval de `send_proactive_message`, `src/tools/send-proactive-message.ts:41`), e ele não pode ser reutilizado por nenhum outro caminho. Ver §12.Q3 — a modelagem exata do principal de serviço é a decisão de segurança em aberto.

### §6.2b Janela de contato: não existe gate de horário para mensagem, e é preciso dizer isso

Correção importante contra uma suposição fácil. **Não existe hoje nenhum gate de horário sobre mensagem de saída.** Verificado:

- `effective_limits.horario_permitido` é timezone-aware e realmente aplicado — mas por `evaluateFinancialAuthorization`, sobre a **permissão financeira de uma pessoa**, tomando `valor` como entrada. Não é um gate de "pode mandar mensagem agora".
- A regra semeada `no_action_outside_business_hours_high_risk` (`migrations/037`) referencia `context.is_business_hours`, campo que **não existe em lugar nenhum do código**. Predicado sobre campo ausente resolve `not_applicable` ⇒ ALLOW. A própria migração 078 documenta essa armadilha. Não reivindicar horário comercial a partir de `policy_rules`.
- `src/scheduling/business-day-rrule.ts` dá **dia útil** (pula fim de semana e feriado via `holidays`), não hora do dia.
- `src/scheduling/backpressure.ts` dá vazão (2s por destinatário, baldes global), não janela.

Portanto a janela de contato é aplicada pelo **slot**: `window_start`/`window_end` são calculados na materialização a partir de `contact_window` do envelope (hash-pinado) com dias úteis. Um slot fora da janela não é elegível para o perceptor, e o executor revalida antes do dispatch. É uma camada nova, e é honesto chamá-la de nova em vez de fingir que `horario_permitido` já cobria.

O `valor_max = 0` continua valendo como defesa em profundidade para qualquer caminho que *seja* financeiro.

### §6.3 Templates: o mecanismo contra "ameaçar"

Este é o ponto mais importante da §6, porque "não ameaçar" é o único item da lista do owner que **não é mecanizável por policy de tool**. Policy governa *qual ação*; tom é *conteúdo*. Um agente com permissão de enviar mensagem e liberdade de redação pode ser rude, e nenhum guard de dispatcher vê isso.

A saída é remover a liberdade de redação:

- Cada template é uma constante em código, revisada em PR, com `id` versionado (`cob.lembrete_cordial.v1`), corpo fixo e **slots tipados por Zod** (`{nome}`, `{valor}`, `{vencimento}`, `{link}`).
- Os slots são preenchidos pelo **backend**, com valores lidos do banco. O LLM não preenche slot, não escolhe template, não revisa o texto.
- O `template_id` de cada passo está **dentro do hash do mandato**. Trocar o texto invalida o mandato (§5.3).
- A revisão de tom acontece uma vez, por humano, na aprovação — não a cada envio, e não por um juiz automático.

Custo assumido, explicitamente: a mensagem não é personalizada. Para uma régua de lembrete cordial isso é adequado; para negociação não seria — e negociação está fora de escopo por isso.

### §6.4 O que continua valendo

Nada aqui substitui as camadas existentes. O envio segue passando por `dispatchTool` inteiro: feature flag, `tool_not_granted`, Zod, escopo de entidade, `constitutionalCheck`, `canAct`, avaliação financeira, reserva idempotente, outbox, audit, consumo de aprovação. O mandato **resolve a exigência de 4-eyes**; não remove nenhum outro passo.

---

## §7. Frequência sob retry, réplica e reexecução

### §7.1 A ideia

Contar é racy. Índice único não é. Por isso a frequência não é um contador consultado antes de enviar — é a **existência de um slot não consumido**.

```
UNIQUE (objective_id, carteira_item_id, step)
```

O k-ésimo contato de um item só pode acontecer se houver um slot `(objetivo, item, k)` em `available`, e ele só pode acontecer **uma vez** porque o consumo é um CAS `claimed → consumed` com token. Não há caminho pelo qual duas réplicas, dois retries ou duas reexecuções produzam dois envios para o mesmo `(item, passo)`.

### §7.2 As camadas, e o que cada uma sozinha já garante

| Camada | Garante sozinha | Mecanismo |
|---|---|---|
| 1. Slot | ≤ 1 envio por `(item, passo)`, ≤ N por item | unique + CAS one-time (§3.2) |
| 2. Claim da tarefa | ≤ 1 executor por tarefa | `FOR UPDATE SKIP LOCKED` (`objective-repos.ts:177`) |
| 3. Idempotência do dispatch | reexecução do mesmo intent converge | `tryReserve` + fencing por `reservation_token` |
| 4. Outbox de efeito | ≤ 1 enfileiramento por chave | UNIQUE `(tenant_id, agent_id, idempotency_key)` (`migrations/068`) |
| 5. Relayer | ≤ 1 entrega física | `deriveProviderDedupKey` — message id derivado da **row persistida**, não do contexto ALS (#327), então uma redispatch pós-crash calcula o mesmo id |
| 6. Janela do slot | worker atrasado não dispara rajada | `window_end` ⇒ `expired`, inelegível |

Cinco camadas independentes impedem a duplicata, e a mais interna (unique + CAS) não é derrotável por concorrência. Se alguma outra falhar, a duplicata não passa.

### §7.3 O que NÃO protege este caminho, ao contrário do que parece

Duas correções que importam, porque as duas defesas mais citadas do repo **não estão neste caminho**:

- **`exclusive_per_destinatario` não se aplica.** É propriedade de `series`, e o executor não cria série no caminho normal (§4.3 passo 6). Só valeria se um passo usasse espera-por-resposta com timeout.
- **O backpressure de saída não cobre o relayer de efeito.** `tryAcquireSendSlot` (2s por JID, baldes global) é consumido **apenas** por `src/scheduling/outbox-drain.ts`. `send_proactive_message` sai pelo `idempotency_effect_outbox` → `src/workers/idempotency-outbox-relayer.ts`, que tem backoff exponencial próprio (30s base, teto 1h) mas **não chama a função de pacing**. `OUTBOX_MAX_PER_SECOND` / `PER_HOUR` não se aplicam a ele.

Consequência prática: a vazão instantânea da régua é limitada pelo lote do relayer (`OUTBOX_RELAYER_BATCH_PER_TENANT`, default 100) — não por pacing por destinatário. Para o piloto isso é aceitável porque o teto absoluto de slots já limita o volume total e as janelas espalham os passos no tempo; mas é uma suposição a validar na fase C com contagem real, não a assumir. Se a vazão incomodar, a correção certa é o relayer passar a usar `tryAcquireSendSlot`, e isso é trabalho próprio (afeta todo o outbound proativo, não só cobrança).

Esta spec deliberadamente **não** cria um rate limit de saída novo: o teto por slot é mais forte que uma janela deslizante — é limite absoluto, não taxa. Se um kind futuro precisar de taxa e não de teto, o padrão de zset com `ZREMRANGEBYSCORE` de `src/gateway/rate-limit.ts` é o que se reusa.

---

## §8. Fila de exceções

### §8.1 O que gera exceção

Quatro gatilhos, todos **determinísticos e avaliados pelo backend**:

1. `legal_intent_detect` positivo em qualquer mensagem do devedor (léxico PT-BR determinístico, confiança computada — `src/tools/legal-intent-detect.ts`).
2. Devedor responde qualquer coisa que não case com uma classificação tipada estreita (§8.2).
3. Divergência de estado: o item aparece pago no meio da régua, ou o valor mudou, ou o devedor não tem canal válido.
4. Falha repetida de entrega para o mesmo item.

Nos casos 1 e 3, além da exceção, **todos os slots restantes daquele item vão para `revoked`**. Parar é uma decisão do backend, tomada no perceptor; o modelo não participa.

### §8.2 Inbound do devedor sai do loop

Quando o devedor responde, a mensagem entra pelo caminho normal de turno (gateway → decision engine). Para o piloto:

- Uma classificação tipada estreita, com limiar de backend, reconhece apenas **promessa de pagamento com data** e **alegação de já ter pago**. Ambas apenas registram o desfecho no slot e escalam.
- **Qualquer outra coisa** — incluindo silêncio ambíguo — vira exceção humana. O agente não responde ao devedor de forma autônoma no piloto.

Isto é restritivo de propósito. É o ponto onde o texto livre entraria, e texto livre para terceiro sobre dívida é a superfície que a §6.3 existe para fechar.

### §8.3 Travar e destravar

- Executor retorna `{ transition: 'waiting_human' }`; a tarefa aparece em `objectives.listExceptions` e na aba Objetivos — **isto já existe e funciona** (v1).
- O humano resolve no console. Hoje `resolveTask` só aceita `done|failed` (`src/admin-ui/trpc/routers/objectives.ts:64`) e não consegue devolver a tarefa ao loop. **Passa a aceitar `resume`**, que transiciona `waiting_human → pending` com a resposta no `payload`; o executor a retoma no próximo drain. Router + repo, sem migração.
- **Expiração é fail-closed**: exceção não resolvida dentro do TTL **não** retoma sozinha. A tarefa vai para `failed` e os slots restantes do item para `revoked`. O default do silêncio é parar de cobrar, nunca continuar. Isto é um sweeper novo sobre `objective_tasks` (§8.4), não o `pending-expirer`.

### §8.4 O que a v1 documentou como existente e não existe

A spec v1 §4 diz: *"A resposta do owner (WhatsApp ou console) destrava a procedure → o executor retoma a tarefa."* Verificado no HEAD, **essa ponte não existe**, em três níveis:

1. **`pending_questions` não tem vínculo com `procedure_executions`.** Não há coluna, e `src/agent/pending-resolver.ts` nunca emite `human_confirmation`. `procedureEngine.recordHumanConfirmation` — que alimentaria o critério `human_confirmed` — só tem caller em `src/procedures/test-runner.ts`.
2. **`pending_questions` não tem nenhuma superfície de console.** Nenhum router do admin-ui lê ou escreve a tabela. É WhatsApp-only: entrega por `output-dispatch` (poll ou mensagem citada), resolução por `checkPendingFirst` (atrás de `FEATURE_PENDING_GATE`, **default false**), reação emoji ou voto de enquete.
3. **`uniq_pending_questions_active_per_conversa`** (`migrations/004`) permite **uma** pending question aberta por conversa, e o índice é global, não por tenant. Se as exceções da régua virassem pending questions na conversa do owner, elas **serializariam**: a segunda exceção cancelaria a primeira (`cancelOpenForConversaTx`, motivo `'substituted'`).

O ponto 3 é decisivo. Uma régua com dezenas de itens gera exceções em paralelo; um canal que só comporta uma pergunta aberta por vez não é fila, é funil. **Por isso a fila de exceções do piloto é a do console** (`objective_tasks.status='waiting_human'` + `resolveTask`), que é uma lista de verdade, e `objective_tasks.pending_question_id` fica NULL nesta versão.

Notificação por WhatsApp de que *há* exceções é um resumo agregado ("3 casos aguardam você"), não uma pergunta por caso — não consome o slot de pending question e não serializa. Aprovar caso a caso pelo WhatsApp fica para depois de a limitação do ponto 3 ser resolvida em trabalho próprio.

---

## §9. Observabilidade e métricas

### §9.1 O critério de saída, e por que ele é difícil

"Valor líquido recuperado" é o critério de saída da fase 2. Para ser um número e não uma narrativa, precisa de três propriedades: ser **reproduzível** (recalculável do zero a partir de linhas imutáveis, sem contador acumulado), ser **atribuível** (dá para dizer que o pagamento tem relação com o contato) e ser **líquido** (desconta custo).

Reprodutibilidade vem de calcular sobre `objective_contact_slots` (consumo, com timestamp) e sobre as transições de `transacoes` — ambas imutáveis o bastante. O worker de métrica grava snapshot, mas o snapshot é sempre recomputável; divergência entre recálculo e snapshot é um alerta, não um arredondamento.

Atribuição é o problema real, e é onde quase toda medição de cobrança mente.

### §9.2 Grupo de controle

Sem holdout, "R$ recuperado" mede sobretudo **as pessoas que teriam pagado de qualquer forma**. Uma régua sobre uma carteira de inadimplentes recentes exibe recuperação alta mesmo sem enviar nada.

Por isso o envelope carrega `holdout_fraction`, a divisão é sorteada na materialização com semente derivada do `intent_hash` (reprodutível, e fixada antes de qualquer resultado), e os itens de controle vivem na mesma tabela com `status='holdout'` — medidos pelo mesmo código e no mesmo relógio, nunca contatados.

A métrica de saída é a **diferença** entre tratamento e controle na janela de atribuição, não o bruto do tratamento.

Isto tem um custo de negócio (uma fatia da carteira não é cobrada pelo agente durante o piloto) e é uma decisão do owner, não minha — §12.Q6.

### §9.3 O que se mede

| Métrica | Fonte | Observação |
|---|---|---|
| R$ recuperado (tratamento × controle) | `transacoes` liquidadas na janela × slots | depende de §12.Q1 |
| R$ líquido | acima − custo LLM (`llmSettings`) − custo de mensagem − tempo humano em exceções | custo humano precisa de proxy; §12.Q7 |
| Taxa de contato | `consumed` / `available+consumed` | |
| Intervenção humana | tarefas que passaram por `waiting_human` / total | é a métrica de autonomia real |
| Reclamações / bloqueios | sinal jurídico, opt-out, falha de entrega por bloqueio | **é breaker, não painel** (§11.3) |
| Falsos positivos | slots `revoked` por "já estava pago" / total | mede a qualidade do perceptor; é o indicador de dano ao cliente |

### §9.4 Instrumentação

Métricas por `src/observability/metrics.ts` (a camada de policy sobre `lib/metrics.ts`), com nomes declarados em `src/observability/taxonomy.ts` (`METRIC`) e labels sanitizados por `labels.ts`. O orçamento de cardinalidade e a regra de privacidade importam: `carteira_item_id`, `devedor_pessoa_id`, telefone e conteúdo **não podem ser labels** — só `tenant_id` e `agent_id` são identificadores sancionados. Nome novo de métrica precisa entrar em `METRIC`, senão é rejeitado.

Auditoria: cada passo por `audit()` (o contexto ALS carimba `tenant_id`/`agent_id`; não são parâmetros). O consumo do slot usa **`auditTx`** — fail-loud, na mesma transação — pela mesma razão que os writes de razão usam: um consumo sem trilha é pior que uma falha. Ações novas precisam entrar no enum tipado `src/governance/audit-actions.ts`, senão não compilam: `objective_mandate_materialized`, `objective_mandate_revoked`, `objective_slot_claimed`, `objective_slot_consumed`, `objective_slot_revoked` (com motivo), `objective_exception_opened` / `_resumed` / `_expired`. `objective_task_executed` já existe (`audit-actions.ts:426`).

Vale notar o que já vigia isto de graça: o SLO `MaiaAuditWriteFailing` (`monitoring/alerts/slo.rules.yml`) dispara em **qualquer** incremento de `maia_audit_write_failed_total`. Uma régua que perde trilha acende alarme sozinha.

---

## §10. Isolamento

Invariante 1 aplicado passo a passo:

| Passo | Escopo |
|---|---|
| Percepção | dispatcher por tenant (#355), `runWithTenantContext`, fail-isolado |
| Slots | `tenant_id`/`agent_id` na tabela; índice de escopo; toda query com os dois |
| Claim de tarefa | claim é cross-tenant por desenho (padrão do playground), mas o contexto é derivado da row e **`transitionTask` ganha predicado de tenant** (§4.4) |
| Envio | `dispatchTool` sob contexto; idempotência já é `(tenant_id, agent_id, key)`; outbox idem |
| Métrica | labels `tenant_id`/`agent_id` (#275) |
| Audit | `audit()` injeta o contexto ALS |

`test:leak` ganha: objetivos, slots e exceções do tenant A invisíveis a B nos dois sentidos; e um slot de A jamais claimável sob contexto de B.

---

## §11. Piloto e rollback

### §11.1 Um tenant

Dois gates, e o de fora é o que vale:

1. `MAIA_COBRANCA_PILOT_TENANTS` (config, default **vazio**): vazio ⇒ o kind é inerte em qualquer tenant. Um objetivo criado por engano em outro tenant não percebe e não executa.
2. A flag do worker (§4.4) — phase 1, default-off.

### §11.2 Uma carteira

Resolvido em §5.2 pela carteira enumerada e hash-pinada. Vale repetir a propriedade: **não existe filtro para afrouxar**. Item fora da lista não tem slot; sem slot não há contato.

### §11.3 Desligar depressa

Quatro níveis, do mais rápido ao mais amplo:

| Nível | Ação | Efeito | Latência |
|---|---|---|---|
| 0 | **Breaker automático** | reclamação/bloqueio acima do limiar ⇒ objetivo `paused` + exceção aberta. **Nunca se re-arma sozinho** | segundos |
| 1 | `objectives.setStatus('paused')` | perceptor para; claim cancela órfãs | próximo tick |
| 2 | Revogar o mandato | slots `available`/`claimed` → `revoked`; para até o que já foi claimado | imediato |
| 3 | Flag do worker off / `lockdown` | para o loop / o sistema | imediato |

O que **não** se desfaz: mensagem já entregue pelo relayer. Está declarado aqui em vez de escondido — é a razão de a janela do slot (§7.2 camada 6) ser curta, para reduzir o intervalo entre decisão e efeito.

`expires_at` do mandato é o desligamento que não depende de ninguém lembrar: o piloto termina sozinho.

---

## §12. Perguntas em aberto

Nenhuma destas é escolhível por um agente. Todas dependem de decisão de negócio, jurídica ou de segurança.

**Q1 — [Bloqueante] A Maia consegue saber quem deve e quem pagou?**
`payment_verification` é um stub honesto que retorna `paid: null`, nunca `false` (`src/tools/payment-verification.ts`) — e `boleto_search`, `dda_lookup`, `company_blacklist_check`, `company_history_lookup`, `refund_lookup`, `operational_ticket_create` são stubs também (#432). Sobra `transacoes` (`natureza='receita'`, `status='pendente'`), que só serve se os recebíveis do tenant do piloto **estiverem na Maia e forem mantidos em dia**. Duas perguntas: (a) estão? (b) a liquidação chega por qual caminho e com qual atraso? Sem isso o perceptor cobra quem já pagou e o critério de saída em R$ não é mensurável. **Isto define se o piloto é viável.**

**Q2 — `transacoes` não tem `data_vencimento`.** Há `data_competencia` (competência) e `data_pagamento` (liquidação); vencimento não é campo de primeira classe — o único `proximo_vencimento` está em `recorrencias` e em `entity_states` (cache). Também não existe tabela de contas a receber: `transacoes` é o único razão. Usar competência como proxy de vencimento é aceitável para este tenant, ou vencimento precisa virar campo? Muda quem entra na carteira e quando.

**Q2b — [Bloqueante] Quem faz a ponte devedor→WhatsApp?** `contrapartes` (o devedor no razão) não tem telefone nem vínculo com `pessoas`; `pessoas` é quem tem `telefone_whatsapp` (§5.2b). Além disso, toda pessoa contatada precisa de **perfil de audiência ativo** para este agente (`agent_audience_profiles`, migração 074) — sem ele fica em quarentena e nunca é atendida. Quem monta e mantém esse vínculo para a carteira do piloto: import manual, curadoria no console, ou um campo novo em `contrapartes`? É trabalho de dados que precisa acontecer **antes** da fase D, e ninguém o fez ainda.

**Q2c — A liquidação chega pela Maia?** Os parsers de OFX/CSV existem e são testados (`src/import/ofx-parser.ts`, `csv-parser.ts`, `reconciler.ts`) e as tabelas `import_runs`/`import_entries` estão no schema — mas **nada os liga**: não há repo, tool, rota tRPC nem worker que insira em `import_runs`. Extrato bancário não é ingerido hoje. E ERP externo via MCP está **recusado no boot em produção** (#521 cap. 5). Então a liquidação só entra por `register_transaction` (manual/WhatsApp). Isso é suficiente para o tenant do piloto?

**Q3 — [Segurança] Como se modela o principal de serviço?** O agente autônomo precisa de um `pessoa` + `ResolvedPermission` para `canAct` / `evaluateFinancialAuthorization`. Criar uma "pessoa robô" resolve o encaixe mas introduz um principal sem humano por trás. A alternativa é um caminho de autorização que não passe por `pessoa`, o que é mudança estrutural em `#521`. **Precisa do dono da segurança**, não de mim.

**Q4 — Quem sai da carteira por regra, e não por escolha?** Dívida contestada, negativada, prescrita, em acordo, com o mesmo devedor tendo outra pendência, falecido, menor. Nenhum desses critérios eu escolho. Cada um vira um filtro determinístico no perceptor.

**Q5 — [Jurídico] Limites regulatórios.** CDC art. 42 e a normativa aplicável a cobrança por mensagem: horário permitido, frequência máxima, conteúdo obrigatório, opt-out e como ele é honrado, retenção do registro de contato, base legal LGPD para contatar o devedor por WhatsApp. A spec parametriza tudo isso no envelope; **os valores são jurídicos**, e a `data-retention-matrix.md` ainda está DRAFT pendente de DPO.

**Q6 — Grupo de controle é aceitável?** O holdout (§9.2) é o que torna "R$ recuperado" um número real, e custa não cobrar uma fatia da carteira durante o piloto. Aceita? Se não, a métrica de saída passa a ser bruta e não atribuível — e vale dizer isso em voz alta em vez de apresentar o bruto como se fosse efeito do agente.

**Q7 — O que entra em "líquido"?** Custo LLM e de mensagem são mensuráveis. Tempo humano em exceções não tem fonte hoje. Estimar por contagem de exceções × constante, ou deixar fora e chamar de "recuperado bruto menos custo de máquina"?

**Q8 — Quantos passos, com que intervalo, e quando parar?** `max_steps_per_item`, `offset_days` e o critério de desistência são política de cobrança do tenant. Não invento.

**Q9 — Quem assina o mandato, e por quanto tempo a assinatura fica aberta?** `two_distinct_owners` exige dois owners distintos e ativos. O tenant do piloto tem dois? Se não, `requester_plus_one_owner` é aceitável para um mandato desta natureza? E o TTL: `DUAL_APPROVAL_TIMEOUT_HOURS` é 6h global — curto para juntar dois owners no console (§5.5). Mandato ganha TTL próprio?

**Q10 — O que acontece quando o devedor responde no meio da noite?** A janela restringe o *envio*. A resposta chega quando chega e cai no caminho de turno normal, que não tem gate de horário (§6.2b). O agente responde fora da janela, ou fica em silêncio até a janela abrir?

**Q11 — Onde o owner atende as exceções?** A spec põe a fila no console (§8.4), porque uma pending question por conversa serializaria os casos. Isso significa que o owner precisa abrir o console para destravar — não resolve pelo WhatsApp. Aceitável para o piloto, ou destravar pelo celular é requisito? Se for requisito, a limitação do índice `uniq_pending_questions_active_per_conversa` precisa ser resolvida antes, em trabalho próprio.

**Q12 — Vale ligar o work loop a procedures algum dia?** §2.2b mostra que hoje não dá (o motor observa, não causa; e nada ativa uma procedure em produção). Consertar isso é um investimento real. Vale como trabalho próprio depois do piloto, ou o executor-em-código por kind é o desenho definitivo?

---

## §13. Critérios de aceite

Verificáveis. Cada um é um teste, não uma opinião.

**Fronteira de decisão**
1. Objetivo do kind nasce `paused`; `setStatus('active')` sem mandato `approved` é recusado.
2. Alterar um byte de `params` após a materialização ⇒ perceptor e executor param com audit `objective_mandate_hash_mismatch`; zero slots novos, zero consumos.
3. Mandato expirado ⇒ nenhum claim de slot.

3b. Item de carteira cujo `devedor_pessoa_id` não existe, não tem `telefone_whatsapp` ou não tem perfil de audiência ativo ⇒ **materialização do mandato falha alto**, com o item identificado (§5.2b).

**Guardrails**
4. Tentativa de `register_transaction` / `boleto_cancel` / `refund_create` sob o principal do loop ⇒ `tool_not_granted`, com audit.
5. Qualquer envio com `valor > 0` sob `valor_max=0` ⇒ `deny/above_individual_limit`.
6. Envio com `template_id` fora da allowlist ⇒ recusado antes do dispatch.
7. Nenhum caminho de código permite que a saída do LLM chegue ao corpo da mensagem — teste de arquitetura, no padrão de `tests/unit/runtime/decision/architecture-lock.spec.ts`.
7b. Slot com `now()` fora de `[window_start, window_end)` não é percebido nem executado, incluindo na virada de fuso e em feriado (§6.2b).

**Frequência**
8. Duas réplicas do executor sobre o mesmo slot ⇒ exatamente um `consumed`, exatamente uma linha em `idempotency_effect_outbox` (integração com DB real).
9. Reexecução da mesma tarefa após crash pós-enfileiramento ⇒ zero mensagem extra; message id derivado idêntico.
10. Worker parado além de `window_end` ⇒ slots `expired`, zero envio.
11. `(objective_id, carteira_item_id, step)` duplicado ⇒ violação de unique (não `onConflictDoNothing` silencioso).

**Exceções**
12. `legal_intent_detect` positivo ⇒ tarefa `waiting_human`, slots restantes do item `revoked`, exceção listada.
13. Resposta humana devolve a tarefa a `pending` e o executor a retoma com a resposta no payload.
14. Exceção expirada ⇒ `failed` + slots `revoked`; **nunca** retomada automática.

**Métricas**
15. Recálculo do zero reproduz o snapshot do worker (mesma janela ⇒ mesmo número).
16. Holdout e tratamento são reportados separadamente; a métrica de saída é a diferença.

**Isolamento**
17. `test:leak`: objetivos, slots e exceções invisíveis cross-tenant nos dois sentidos.
18. Slot do tenant A não é claimável sob contexto de B.
19. `transitionTask` com tenant errado não muta linha.

**Robustez v1**
20. SIGKILL entre claim e transição ⇒ lease vencida é reclamada e a tarefa volta a `pending`; o slot em `claimed` impede envio duplicado.
21. Workers em phase 1 com a flag off são no-op comprovado.

**Piloto**
22. `MAIA_COBRANCA_PILOT_TENANTS` vazio ⇒ kind inerte mesmo com objetivo `active` e mandato válido.
23. Item fora da carteira nunca recebe slot nem contato.
24. Breaker: reclamações acima do limiar ⇒ objetivo `paused` automaticamente, sem re-arme.

---

## §14. Entrega faseada

| Fase | Conteúdo | Porta de saída |
|---|---|---|
| **A — endurecer** | §4.4 completo (lease + reaper, predicado de tenant, phase 1 atrás de flag, dispatcher por tenant). Nada de cobrança | testes 20–21 verdes; v1 continua verde |
| **B — mandato e slots** | migração, repos, materialização, guard de hash, superfície de console. Kind ainda sem envio | testes 1–3, 8, 10–11, 17–19, 22–23 |
| **C — shadow** | kind completo, **mas o envio é sinkado** (padrão do sink sintético de `2026-07-17`). Carteira real, mensagens reais montadas, nada sai | operador lê 100% das mensagens que teriam saído e aprova; falsos positivos medidos antes de qualquer contato |
| **D — piloto** | envio ligado, uma carteira, mandato curto | métricas §9 por ciclo; breaker armado |
| **E — decisão** | relatório tratamento × controle | ir/não-ir da fase 2 pelo critério em R$ |

A fase C é a que não deve ser pulada: é a única em que um erro de perceptor custa zero. Cobrar quem já pagou é o dano mais provável e o mais caro em confiança — e é exatamente o que a fase C mede antes de doer.

---

## §15. Riscos residuais

| Risco | Mitigação | Residual |
|---|---|---|
| Cobrar quem já pagou | revalidação em duas etapas (§4.2/§4.3) + fase C | **Alto enquanto Q1 estiver aberta.** É o risco que decide o piloto |
| Mensagem entregue após decisão de parar | janela curta de slot; níveis 0–3 de desligamento | Baixo, irreversível por natureza |
| Principal de serviço vira porta larga | `valor_max=0`, grants mínimos, `denied_tools` | Médio até Q3 ser respondida |
| Template cordial soa mal em contexto real | revisão humana na aprovação + fase C | Médio — é julgamento, não teste |
| Mandato como procuração em branco | a equivalência da §5.1 só vale enquanto o LLM não tocar o intent | **Alto se algum PR futuro der liberdade de redação ao modelo.** O teste 7 existe para falhar alto nesse dia |
