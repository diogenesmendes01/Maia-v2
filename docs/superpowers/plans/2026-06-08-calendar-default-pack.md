# Calendar como capacidade base de todo agente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o pack de agenda (consultas de data + lembretes) auto-concedido a todo agente, de todo tenant, sem quebrar o modelo de capacidades — mantendo `register_custom_holiday` como concessão explícita.

**Architecture:** Uma constante leve `BASE_AGENT_PACKS = ['baseline.core','domain.calendar']` vira a fonte única do "floor" de todo agente, substituindo os ~6 literais `baseline.core` hardcoded. `domain.calendar` é redefinido para 7 tools; `register_custom_holiday` sai para um pack `domain.calendar.admin`. Agentes novos recebem o floor pelo seed; existentes via migration de backfill. Nenhuma skill nova (o grant já torna as tools visíveis em turnos sem skill).

**Tech Stack:** TypeScript/ESM, Drizzle ORM, PostgreSQL, Vitest. Spec: [docs/superpowers/specs/2026-06-08-calendar-default-pack-design.md](../specs/2026-06-08-calendar-default-pack-design.md).

---

## File Structure

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `src/tools/base-agent-packs.ts` | Fonte única do floor (`BASE_AGENT_PACKS`), zero imports | **Criar** |
| `src/tools/grant-math.ts` | `PLATFORM_DEFAULT_DOMAIN_PACKS`, redefinir `DOMAIN_CALENDAR_PACK` (7 tools), novo `DOMAIN_CALENDAR_ADMIN_PACK`, `defaultAgentGrant()` via `BASE_AGENT_PACKS` | Modificar |
| `src/tools/packs.ts` | Re-export do admin pack + constantes; guards revalidam no load | Modificar |
| `src/db/repositories.ts` | Repoint dos literais: seed (`createWithSeedAndAudit`), audit payload, `agentToolGrantsRepo.findForCurrentAgent` fallback | Modificar |
| `src/tools/runtime-filter.ts` | Repoint do fallback (`resolveEffectiveGrant`) | Modificar |
| `src/tools/_dispatcher.ts` | Repoint do fallback | Modificar |
| `src/db/schema.ts` | Column DEFAULT de `agent_tool_grants.granted_packs` | Modificar |
| `migrations/081_calendar_default_pack.sql` + `_down.sql` | Backfill dos grants existentes + ALTER column default | **Criar** |
| `migrations/RESERVATIONS.md` | Reservar prefixo `081` | Modificar |
| `tests/unit/tools/agent-tool-grants.spec.ts` | Atualizar casos de parity | Modificar |
| `tests/unit/tools/calendar-default-pack.spec.ts` | Novos testes (packs, seed, fallback, visibilidade) | **Criar** |

> Antes de começar: confirmar com `git branch --show-current` que está em `claude/calendar-default-pack`. `node_modules` é junction do install da raiz — **não** rodar `npm install`.

---

## Task 1: Fonte única `BASE_AGENT_PACKS` + reestruturação dos packs

**Files:**
- Create: `src/tools/base-agent-packs.ts`
- Modify: `src/tools/grant-math.ts` (DOMAIN_CALENDAR_PACK, novo admin pack, PLATFORM_DEFAULT_DOMAIN_PACKS, DOMAIN_PACKS)
- Modify: `src/tools/packs.ts` (re-exports)
- Test: `tests/unit/tools/calendar-default-pack.spec.ts`

- [ ] **Step 1: Ler os locais atuais** — `grant-math.ts` (DOMAIN_CALENDAR_PACK ~219-238, DEFAULT_AGENT_PACKS ~130, defaultAgentGrant ~643, DOMAIN_PACKS ~400-408) e `packs.ts` (re-exports ~33-66, guards ~120-175). Confirmar as 8 tools atuais do calendar pack.

- [ ] **Step 2: Escrever o teste (falha)** em `tests/unit/tools/calendar-default-pack.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import {
  DEFAULT_AGENT_PACKS,
  PLATFORM_DEFAULT_DOMAIN_PACKS,
  DOMAIN_CALENDAR_PACK,
  DOMAIN_CALENDAR_ADMIN_PACK,
} from '@/tools/grant-math.js';

describe('calendar default pack — estrutura', () => {
  it('BASE_AGENT_PACKS = baseline.core + domain.calendar (parity)', () => {
    expect([...BASE_AGENT_PACKS]).toEqual([
      ...DEFAULT_AGENT_PACKS,
      ...PLATFORM_DEFAULT_DOMAIN_PACKS,
    ]);
    expect(BASE_AGENT_PACKS).toContain('baseline.core');
    expect(BASE_AGENT_PACKS).toContain('domain.calendar');
  });

  it('domain.calendar tem as 7 tools universais, SEM register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_PACK.tools).toHaveLength(7);
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('schedule_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).toContain('cancel_reminder');
    expect(DOMAIN_CALENDAR_PACK.tools).not.toContain('register_custom_holiday');
  });

  it('domain.calendar.admin isola o register_custom_holiday', () => {
    expect(DOMAIN_CALENDAR_ADMIN_PACK.id).toBe('domain.calendar.admin');
    expect(DOMAIN_CALENDAR_ADMIN_PACK.tools).toEqual(['register_custom_holiday']);
  });
});
```

- [ ] **Step 3: Rodar e verificar a falha**

Run: `npx vitest run tests/unit/tools/calendar-default-pack.spec.ts`
Expected: FAIL (módulo `base-agent-packs` inexistente / exports ausentes).

- [ ] **Step 4: Criar `src/tools/base-agent-packs.ts`** (zero imports — leaf module):

```ts
/**
 * Single source of truth for the per-agent capability FLOOR. Kept import-free
 * (no registry/gateway chain) so `db/repositories.ts` can import it without
 * violating the deliberate separation documented at repositories.ts:~4691.
 *
 * = baseline.core (universal, conservative) + the platform-default domain packs
 * the platform grants to EVERY agent (issue: calendar as base capability).
 */
export const BASE_AGENT_PACKS = ['baseline.core', 'domain.calendar'] as const;
```

- [ ] **Step 5: Editar `src/tools/grant-math.ts`:**
  - Remover `'register_custom_holiday'` da lista `tools` de `DOMAIN_CALENDAR_PACK` (fica com 7).
  - Adicionar o novo pack:
    ```ts
    export const DOMAIN_CALENDAR_ADMIN_PACK: ToolPack = {
      id: 'domain.calendar.admin',
      name: 'Agenda (admin)',
      domain: 'calendar',
      version: 1,
      risk_level: 'high',
      default_for_agent_type: [],
      description: 'Gestão de feriados customizados do tenant (write). Concessão explícita — não auto-concedido.',
      tools: ['register_custom_holiday'],
    } as const;
    ```
  - Adicionar `DOMAIN_CALENDAR_ADMIN_PACK` ao array `DOMAIN_PACKS` (~400-408).
  - Adicionar `export const PLATFORM_DEFAULT_DOMAIN_PACKS: readonly string[] = ['domain.calendar'] as const;` perto de `DEFAULT_AGENT_PACKS` (~130). Manter `DEFAULT_AGENT_PACKS = ['baseline.core']`.

- [ ] **Step 6: Editar `src/tools/packs.ts`** — adicionar `DOMAIN_CALENDAR_ADMIN_PACK` e `PLATFORM_DEFAULT_DOMAIN_PACKS` à lista de re-exports (~41-66). Os guards (`assertDomainPackToolsKnown`, `assertPackToolsExist`) rodam no load e devem passar (register_custom_holiday segue conhecido).

- [ ] **Step 7: Rodar o teste (passa)**

Run: `npx vitest run tests/unit/tools/calendar-default-pack.spec.ts`
Expected: PASS (os 3 testes desta task).

- [ ] **Step 8: Commit**

```bash
git add src/tools/base-agent-packs.ts src/tools/grant-math.ts src/tools/packs.ts tests/unit/tools/calendar-default-pack.spec.ts
git commit -m "feat(tools): split calendar pack + BASE_AGENT_PACKS source of truth"
```

---

## Task 2: Repoint dos literais `baseline.core` → `BASE_AGENT_PACKS`

**Files:**
- Modify: `src/tools/grant-math.ts` (`defaultAgentGrant`)
- Modify: `src/db/repositories.ts` (`createWithSeedAndAudit` granted_packs + audit payload; `agentToolGrantsRepo.findForCurrentAgent` fallback)
- Modify: `src/tools/runtime-filter.ts` (`resolveEffectiveGrant` fallback)
- Modify: `src/tools/_dispatcher.ts` (fallback)
- Test: `tests/unit/tools/calendar-default-pack.spec.ts` (acrescentar) + um teste de seed

- [ ] **Step 1: Escrever o teste do floor (falha)** — acrescentar ao spec da Task 1:

```ts
import { defaultAgentGrant } from '@/tools/grant-math.js';

describe('calendar default pack — floor', () => {
  it('defaultAgentGrant() concede o BASE_AGENT_PACKS (inclui calendar)', () => {
    const g = defaultAgentGrant();
    expect(g.granted_packs).toEqual([...BASE_AGENT_PACKS]);
    expect(g.granted_packs).toContain('domain.calendar');
    expect(g.denied_tools).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e verificar a falha**

Run: `npx vitest run tests/unit/tools/calendar-default-pack.spec.ts -t floor`
Expected: FAIL (`defaultAgentGrant` ainda retorna só baseline.core).

- [ ] **Step 3: Repoint** — em cada site, trocar o literal `['baseline.core']` por `[...BASE_AGENT_PACKS]` (importando de `@/tools/base-agent-packs.js`):
  - `grant-math.ts` `defaultAgentGrant()` → `granted_packs: [...BASE_AGENT_PACKS]`.
  - `repositories.ts` `createWithSeedAndAudit` (~4778) → o INSERT de `granted_packs`.
  - `repositories.ts` audit payload `default_tool_packs` (~4808).
  - `repositories.ts` `findForCurrentAgent` fallback (~432/444-456) → o `granted_packs ?? [...]`.
  - `runtime-filter.ts` `resolveEffectiveGrant` fallback (~115).
  - `_dispatcher.ts` fallback (~100/114).
  > NÃO tocar `resolveGrantedToolNames` (mantém a união de `BASELINE_CORE_PACK.tools` como floor independente). Confirmar que `base-agent-packs.ts` não cria ciclo de import (`npx tsc --noEmit` na Step 5).

- [ ] **Step 4: Escrever o teste do seed semeado (falha → passa)** — pina o LITERAL do repo, não só `defaultAgentGrant()`. Em `tests/unit/...` mocando o insert do `agentsRepo.createWithSeedAndAudit`, asserir que o `granted_packs` semeado contém `domain.calendar`. (Se o seed for difícil de unit-testar isolado, cobrir via integration em `tests/integration/*-real-db` — marcar como tal; specs real-db rodam no CI com Postgres.)

- [ ] **Step 5: Validar tipos + rodar testes**

Run: `npx tsc --noEmit && npx vitest run tests/unit/tools/calendar-default-pack.spec.ts`
Expected: tsc limpo (sem ciclo de import) + PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/grant-math.ts src/db/repositories.ts src/tools/runtime-filter.ts src/tools/_dispatcher.ts tests/unit/tools/calendar-default-pack.spec.ts
git commit -m "feat(tools): floor = BASE_AGENT_PACKS at seed/grant/fallback sites"
```

---

## Task 3: Column default + migration 081 (backfill)

**Files:**
- Modify: `migrations/RESERVATIONS.md`
- Create: `migrations/081_calendar_default_pack.sql`, `migrations/081_calendar_default_pack_down.sql`
- Modify: `src/db/schema.ts` (~323, column default)

- [ ] **Step 1: Reservar o prefixo**

Run: `npm run migrate:reserve` (ou adicionar a linha `081` em `migrations/RESERVATIONS.md` conforme o formato existente). Confirma o guard: `npx tsx scripts/check-migration-reservations.ts` (ou `npm run` equivalente).

- [ ] **Step 2: Escrever `migrations/081_calendar_default_pack.sql`** (idempotente, respeita denies):

```sql
-- 081: calendar como capacidade base — backfill dos grants existentes + column default.
-- Adiciona 'domain.calendar' a quem ainda não tem; NÃO mexe em denied_tools.
UPDATE agent_tool_grants
SET granted_packs = array_append(granted_packs, 'domain.calendar')
WHERE NOT ('domain.calendar' = ANY(granted_packs));

ALTER TABLE agent_tool_grants
  ALTER COLUMN granted_packs SET DEFAULT '{baseline.core,domain.calendar}'::text[];
```

- [ ] **Step 3: Escrever `migrations/081_calendar_default_pack_down.sql`:**

```sql
UPDATE agent_tool_grants
SET granted_packs = array_remove(granted_packs, 'domain.calendar')
WHERE 'domain.calendar' = ANY(granted_packs);

ALTER TABLE agent_tool_grants
  ALTER COLUMN granted_packs SET DEFAULT '{baseline.core}'::text[];
```

- [ ] **Step 4: Atualizar `src/db/schema.ts:323`** — o `.default(...)` da coluna `granted_packs` para refletir `{baseline.core,domain.calendar}` (manter em sync com a migration).

- [ ] **Step 5: Testar a migration (integration, precisa de Postgres)**

Run: `npm run test:integration:setup && npm run db:migrate` então um teste `tests/integration/*-real-db` que: semeia um grant legado `{baseline.core}`, roda o backfill, asserir que vira `{baseline.core,domain.calendar}`; rodar 2× = idempotente; um grant com `denied_tools` mantém o deny.
Expected: PASS. (Se Postgres indisponível no ambiente local, validar o SQL manualmente e deixar o CI rodar — ver AGENTS.md §7.)

- [ ] **Step 6: Commit**

```bash
git add migrations/081_calendar_default_pack.sql migrations/081_calendar_default_pack_down.sql migrations/RESERVATIONS.md src/db/schema.ts tests/integration/
git commit -m "feat(db): migration 081 — backfill calendar pack into existing agent grants"
```

---

## Task 4: Visibilidade end-to-end (sem skill)

**Files:**
- Test: `tests/unit/tools/calendar-default-pack.spec.ts` (acrescentar)

- [ ] **Step 1: Escrever o teste de visibilidade** — usando o caminho `computeAgentVisibleTools`/`resolveGrantedToolNames` (ver como `agent-tool-grants.spec.ts` monta um grant):
  - Grant `{baseline.core, domain.calendar}` → `schedule_reminder` e `cancel_reminder` no conjunto de tools visíveis; `register_custom_holiday` **ausente**.
  - Grant `{baseline.core, domain.calendar, domain.calendar.admin}` → `register_custom_holiday` **presente**.

- [ ] **Step 2: Rodar (deve passar — implementação já feita nas tasks 1-2)**

Run: `npx vitest run tests/unit/tools/calendar-default-pack.spec.ts`
Expected: PASS. Se falhar, investigar o resolver (não deveria precisar de mudança de código).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/tools/calendar-default-pack.spec.ts
git commit -m "test(tools): calendar tools visible via grant, admin tool gated"
```

---

## Task 5: Atualizar testes existentes + catálogo + validação final

**Files:**
- Modify: `tests/unit/tools/agent-tool-grants.spec.ts`
- Possivelmente: `src/admin-ui/generated/tool-catalog.ts` (regenerado)

- [ ] **Step 1: Atualizar `tests/unit/tools/agent-tool-grants.spec.ts`** — os casos que assertam sobre `defaultAgentGrant()` (`:45-52`) passam a esperar `baseline.core + domain.calendar`. Os casos que testam um grant explicitamente SEM domain pack (ex.: `:30-43`) permanecem `== BASELINE`. Distinguir os dois.

- [ ] **Step 2: Regenerar o catálogo (se mudou)**

Run: `npm run gen:tool-catalog` então `git status`. Se `src/admin-ui/generated/tool-catalog.ts` mudou (ex.: pack de cada tool), incluir no commit.

- [ ] **Step 3: Validação completa**

Run: `npx tsc --noEmit && npm run lint && npx vitest run tests/unit`
Expected: tsc limpo, lint limpo, **todos** os testes unit passando.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/tools/agent-tool-grants.spec.ts src/admin-ui/generated/tool-catalog.ts
git commit -m "test(tools): align grant parity tests with calendar floor; regen catalog"
```

---

## Validação final (antes do PR)

- [ ] `npx tsc --noEmit` limpo
- [ ] `npm run lint` limpo
- [ ] `npx vitest run tests/unit` verde
- [ ] (Se Postgres disponível) `npm run test:integration` cobre o backfill
- [ ] Manual: um agente novo nasce com `domain.calendar`; um agente legado pós-migration tem `domain.calendar`; `register_custom_holiday` não aparece sem o admin pack.
- [ ] PR com as 8 seções do `pr:body:check` (AGENTS.md §8) + "Residual risk:".

## Notas

- **Não** há skill nova nem seed por-tenant — o grant é por-agente.
- Risco principal de implementação: esquecer um site de literal → mitigado pela constante única + testes de seed/fallback (Task 2).
- Não rodar `npm install` (node_modules é junction). Branch de `origin/main`.
