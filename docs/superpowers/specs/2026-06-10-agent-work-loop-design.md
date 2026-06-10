# Maia — Work Loop: Objetivos e Trabalho Autônomo — Design Spec

**Date:** 2026-06-10
**Status:** v1 implementada (2026-06-10) — entrega conforme §8 v1: migração 088 (`agent_objectives` + `objective_tasks`), `src/db/repositories/objective-repos.ts` (claim SKIP LOCKED, upsert idempotente por natural_key, cancelamento de tarefas órfãs no claim), registry tipado `src/objectives/kinds.ts` (kind `manual` com flows auto/exception), workers `objective_perceive` (5min) e `objective_execute` (drain 1min) com audit `objective_task_executed`, router `objectives` (criação/pausa auditadas, resolução humana de exceções) e aba "Objetivos" em `/agents/[agentId]`. v2 (kind `inadimplencia` + vínculo a procedures via `startExecution`) e v3 seguem o roadmap abaixo.
**Master refs:** visão em `2026-06-10-learnable-workforce-vision.md` §2.3; `ARCHITECTURE.md` invariantes 1–5; `docs/architecture/modules/scheduling.md`, `docs/architecture/modules/procedures.md`, `docs/architecture/concerns/action-layer.md`
**Architecture Locks:** tenant isolation, LLM-propõe/backend-decide, audit total, fail-closed — inalterados. O work loop NUNCA executa side-effects fora do caminho tools/procedures existente.

---

## 0. Purpose

Hoje o agente acorda quando chega mensagem (nível 0–1 da escada de autonomia). O work loop dá ao agente **responsabilidades**: objetivos declarativos por agente ("manter inadimplência < 5%", "confirmar agendas de amanhã até 18h"), um orquestrador que percebe trabalho pendente e gera tarefas, e execução via procedures — com exceções escalando para o humano.

## 1. Modelo

```
Objetivo (declarativo, owner-aprovado)
  └─ Percepção (worker determinístico por tipo de objetivo)
       └─ Tarefas (unidades de trabalho, idempotentes por chave natural)
            └─ Execução (procedure event-sourced OU tool direto, via decision engine)
                 ├─ concluída → métrica do objetivo atualizada
                 └─ exceção  → fila de exceções (pending question p/ owner)
```

**Princípio central: a percepção é determinística, não-LLM.** Cada tipo de objetivo declara um *perceptor* em código (ex.: `inadimplencia`: query sobre lançamentos vencidos) que materializa tarefas. O LLM entra só DENTRO da execução da tarefa (conversar com o devedor, redigir cobrança) — nunca para decidir "que trabalho existe". Isso mantém o invariante: backend decide, LLM propõe.

## 2. Entidades (migração nova)

```sql
agent_objectives (
  id uuid PK, tenant_id, agent_id,
  kind text,             -- registry em código: 'inadimplencia' | 'agenda_confirm' | ...
  title text, params jsonb,        -- alvo + parâmetros do perceptor
  status text CHECK (active|paused|archived),
  created_by, approved_by,         -- criação owner-aprovada (auditada)
  created_at, updated_at
)
objective_tasks (
  id uuid PK, objective_id FK, tenant_id, agent_id,
  natural_key text,                -- idempotência: perceptor nunca duplica tarefa viva
  title text, payload jsonb,
  status text CHECK (pending|running|waiting_human|done|failed|cancelled),
  procedure_execution_id uuid NULL,  -- vínculo quando executa via procedure
  pending_question_id uuid NULL,     -- vínculo quando escala p/ humano
  outcome jsonb NULL, created_at, completed_at,
  UNIQUE (objective_id, natural_key) WHERE status NOT IN ('done','failed','cancelled')
)
```

## 3. Orquestrador (workers)

- `objective_perceive` (cron 5min): para cada objetivo `active`, roda o perceptor do `kind` (registry tipado em `src/objectives/perceptors/`), faz upsert idempotente de tarefas por `natural_key`. Por-tenant dispatcher (mesmo padrão do scheduling pós-#355).
- `objective_execute` (cron 1min, drain): claim de tarefas `pending` (SKIP LOCKED), executa o executor do `kind` — que usa procedures/scheduling/outbox existentes (ex.: cobrança = procedure que conversa via WhatsApp com a pessoa, respeitando rate-limit e policies). Estado `waiting_human` quando a procedure abre pending question.
- `objective_metrics` (cron 1h): recomputa métrica de cada objetivo (deterministicamente, pelo perceptor) e grava série para o painel ROI.

## 4. Fila de exceções

Tarefa em `waiting_human` referencia a pending question existente (`src/workflows/`). A resposta do owner (WhatsApp ou console) destrava a procedure → o executor retoma a tarefa. Console: seção "Exceções" no dashboard + aba Objetivos do agente listando tarefas travadas com CTA.

## 5. Superfície tRPC + UI

- Router `objectives`: list/create/pause/archive (owner/founder, auditados), listTasks (filtros status), retryTask.
- UI: aba **"Objetivos"** em `/agents/[agentId]` — cards de objetivo (métrica atual vs. alvo, tarefas por status), drill-down de tarefas; bloco "Exceções" no dashboard.

## 6. Primeiro kind de ponta a ponta: `inadimplencia` (régua de cobrança)

Critério de saída da fase 2 (visão §4): um trabalho real medido em R$.
- Perceptor: lançamentos a receber vencidos há N dias (params: dias, valor mínimo) → tarefa por (pessoa, competência).
- Executor: procedure `cobranca_inadimplencia` (proposta + aprovada via fluxo normal): contata a pessoa no WhatsApp dentro do playbook, agenda follow-ups via scheduling, registra promessa de pagamento, escala exceções (contestação, silêncio após 3 tentativas).
- Métrica: R$ vencido total; R$ recuperado no período.

## 7. Invariantes e guardrails

1. Objetivo criado/pausado só por owner/founder, auditado (criação é mudança de comportamento).
2. Perceptores/executores são código revisado por `kind` — agente não inventa objetivos nem perceptores (anti-escopo da visão §5).
3. Toda execução passa pelo decision engine + policies + rate-limit existentes; o work loop não cria caminho novo de side-effect.
4. Tarefa órfã (objetivo arquivado) é cancelada pelo executor, não executada.
5. `test:leak`: objetivos/tarefas do tenant A invisíveis ao tenant B.

## 8. Entrega faseada

- **v1 (1ª iteração):** migração + repos + router + aba Objetivos (CRUD owner-aprovado) + workers perceive/execute com UM kind sintético de validação (`manual`: tarefas criadas pelo owner na UI, executor = procedure existente) — prova o ciclo tarefa→procedure→exceção→retomada sem exigir conector novo.
- **v2:** kind `inadimplencia` completo (perceptor financeiro + procedure de cobrança + métrica R$).
- **v3:** kind `agenda_confirm` (segundo domínio — força generalização honesta); painel ROI.

## 9. Fora de escopo

Geração de objetivos pelo LLM; perceptores-LLM; criação dinâmica de kinds sem deploy; orquestração multi-agente de um mesmo objetivo.
