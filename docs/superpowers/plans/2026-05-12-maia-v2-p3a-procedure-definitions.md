# Maia v2 — P3a Procedures: Definição + Modo ENSINO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Definir procedimentos como **objetos operacionais executáveis** (estrutura híbrida: esqueleto + prosa + critérios verificáveis + versionamento), schemas + repos + status transitions. Implementar **modo ENSINO** onde owner teaches procedure step-by-step. P3a NÃO executa procedures em runtime — apenas armazena (P3b executa, P3c métricas).

**Architecture:** 2 tabelas (`procedure_definitions` + `procedure_assignments`) com versionamento imutável (status active = read-only). Estrutura híbrida em JSONB (passos com prosa + critérios + tools_referenced). Status: draft → proposed → active → frozen/rolled_back. Modo ENSINO: função `teachProcedure(owner_input)` recebe descrição em linguagem natural, usa LLM (Sonnet) pra estruturar como definition, salva como draft. Worker consome `cognitive_candidates` tipo `procedimento` (do P1) e gera drafts automaticamente.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, vitest.

**Reference:** Spec §4.4 (procedures como executable skills), §10.8 (schemas dormentes — P3a ativa procedure_definitions + assignments).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/018_p3a_procedure_definitions.sql` + down | Create | `procedure_definitions` versionada, imutável quando active |
| `migrations/019_p3a_procedure_assignments.sql` + down | Create | `procedure_assignments` (definitions → agents/roles com customizations) |
| `src/db/schema.ts` | Modify | Adicionar 2 tabelas + types |
| `src/db/repositories.ts` | Modify | `procedureDefinitionsRepo`, `procedureAssignmentsRepo` |
| `src/cognition/types.ts` | Modify | Estender com `ProcedureDefinition` structured types (steps, criteria, etc.) |
| `src/cognition/procedure-builder.ts` | Create | `teachProcedure(input)` — LLM transforma descrição em draft estruturado |
| `src/cognition/procedure-status.ts` | Create | Status transitions: draft → proposed → active → frozen/rolled_back |
| `src/workers/procedure-candidate-consumer.ts` | Create | Worker batch: consome `cognitive_candidates` tipo 'procedimento' → draft procedures |
| `src/workers/index.ts` | Modify | Registrar worker |
| `tests/unit/procedure-builder.spec.ts` | Create | Testa parsing de ENSINO input |
| `tests/unit/procedure-status.spec.ts` | Create | Testa transitions válidas/inválidas |
| `tests/integration/p3a-procedure-lifecycle.spec.ts` | Create | Cenário: ENSINO → draft → proposed → active |
| `scripts/p3a-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p3a-procedures.md` | Create | Runbook operacional |

---

## Task 1: Migration `procedure_definitions`

**Files:** `migrations/018_p3a_procedure_definitions.sql` + down, `src/db/schema.ts`

### Migration UP

```sql
-- P3a: procedure_definitions — objetos operacionais executáveis, versionados, imutáveis quando active
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'agent', 'role')),
  owner_agent_id TEXT REFERENCES agents(id), -- só se scope='agent'
  nome TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'proposed', 'active', 'frozen', 'rolled_back')
  ),
  intencao TEXT NOT NULL,
  when_apply JSONB NOT NULL DEFAULT '{}'::jsonb,    -- estrutura: { conditions: [...], tags: [...] }
  when_not_apply JSONB NOT NULL DEFAULT '{}'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,         -- array de passos: { id, intencao, como, sucesso_criteria, armadilhas }
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb, -- array tipados: { type, expression/prompt/tool/signal, threshold? }
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  tools_referenced JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL CHECK (source IN ('ensino', 'observacao', 'pratica', 'platform_wisdom')),
  proposed_by TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  source_candidate_id UUID, -- link to cognitive_candidates quando vem de pratica/observacao
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, nome, version_number)
);

CREATE INDEX procedure_def_tenant_agent_status_idx 
  ON procedure_definitions(tenant_id, agent_id, status, nome);
CREATE INDEX procedure_def_active_idx 
  ON procedure_definitions(tenant_id, agent_id, nome) WHERE status = 'active';
CREATE INDEX procedure_def_source_candidate_idx 
  ON procedure_definitions(source_candidate_id) WHERE source_candidate_id IS NOT NULL;
```

### Migration DOWN

```sql
DROP TABLE IF EXISTS procedure_definitions CASCADE;
```

### Drizzle schema entry

```typescript
export const procedure_definitions = pgTable(
  'procedure_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    scope: text('scope').notNull(),
    owner_agent_id: text('owner_agent_id'),
    nome: text('nome').notNull(),
    version_number: integer('version_number').notNull().default(1),
    status: text('status').notNull().default('draft'),
    intencao: text('intencao').notNull(),
    when_apply: jsonb('when_apply').notNull().default(sql`'{}'::jsonb`),
    when_not_apply: jsonb('when_not_apply').notNull().default(sql`'{}'::jsonb`),
    steps: jsonb('steps').notNull().default(sql`'[]'::jsonb`),
    success_criteria: jsonb('success_criteria').notNull().default(sql`'[]'::jsonb`),
    failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),
    tools_referenced: jsonb('tools_referenced').notNull().default(sql`'[]'::jsonb`),
    source: text('source').notNull(),
    proposed_by: text('proposed_by'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
    source_candidate_id: uuid('source_candidate_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('procedure_def_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.nome),
    activeIdx: index('procedure_def_active_idx').on(t.tenant_id, t.agent_id, t.nome),
    sourceCandidateIdx: index('procedure_def_source_candidate_idx').on(t.source_candidate_id),
  }),
);
export type ProcedureDefinition = typeof procedure_definitions.$inferSelect;
```

Commit: `feat(p3a): procedure_definitions table (versionada, imutável quando active)`

---

## Task 2: Migration `procedure_assignments`

**Files:** `migrations/019_p3a_procedure_assignments.sql` + down, `src/db/schema.ts`

### Migration UP

```sql
-- P3a: procedure_assignments — vincula definitions a agents/roles com customizations locais
CREATE TABLE procedure_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id) ON DELETE CASCADE,
  definition_version INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'role')),
  target_id TEXT NOT NULL,
  customizations JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ,
  UNIQUE (tenant_id, definition_id, target_type, target_id)
);

CREATE INDEX procedure_assignments_target_idx 
  ON procedure_assignments(tenant_id, target_type, target_id, enabled);
CREATE INDEX procedure_assignments_def_idx 
  ON procedure_assignments(definition_id);
```

### Migration DOWN

```sql
DROP TABLE IF EXISTS procedure_assignments CASCADE;
```

### Drizzle schema

```typescript
export const procedure_assignments = pgTable(
  'procedure_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    definition_id: uuid('definition_id').notNull(),
    definition_version: integer('definition_version').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    customizations: jsonb('customizations').notNull().default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    activated_at: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
    deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => ({
    targetIdx: index('procedure_assignments_target_idx').on(t.tenant_id, t.target_type, t.target_id, t.enabled),
    defIdx: index('procedure_assignments_def_idx').on(t.definition_id),
  }),
);
export type ProcedureAssignment = typeof procedure_assignments.$inferSelect;
```

Commit: `feat(p3a): procedure_assignments table (definitions → agents/roles com customizations)`

---

## Task 3: Repos

**Files:** `src/db/repositories.ts` (modify)

### procedureDefinitionsRepo

- `create(input)` — insert draft com applyTenantGuard
- `findActiveByName(nome)` — retorna a versão active mais recente
- `findById(id)`
- `listByTenant(filter?)` — lista por status opcional
- `propose(id, proposed_by)` — draft → proposed
- `approve(id, approved_by)` — proposed → active (deactivate previous active version)
- `freeze(id)` — active → frozen
- `rollback(id)` — active → rolled_back; reactiva versão anterior

### procedureAssignmentsRepo

- `create(input)`
- `listForTarget(target_type, target_id)` — retorna assignments enabled
- `disable(id)`

Commit: `feat(p3a): procedureDefinitionsRepo + procedureAssignmentsRepo`

---

## Task 4: Estender cognition types

**Files:** `src/cognition/types.ts` (modify)

Adicionar:

```typescript
export type ProcedureStep = {
  id: string;
  intencao: string;
  como: string;
  sucesso_criteria_ref?: string; // referência ao item em success_criteria
  armadilhas?: string[];
  tools_used?: string[];
  depends_on?: string[]; // step ids
};

export type ProcedureSuccessCriterion =
  | { id: string; type: 'machine_check'; expression: string }
  | { id: string; type: 'tool_result'; tool: string; expected: string }
  | { id: string; type: 'user_signal'; signals: string[] }
  | { id: string; type: 'llm_judge'; prompt: string; threshold: number }
  | { id: string; type: 'human_confirmed'; requires_role: string };

export type ProcedureWhenApply = {
  conditions?: string[]; // free-form descriptions
  tags?: string[];
  context_match?: Record<string, unknown>;
};
```

Commit: `feat(p3a): types ProcedureStep, ProcedureSuccessCriterion, ProcedureWhenApply`

---

## Task 5: procedure-builder — modo ENSINO

**Files:** `src/cognition/procedure-builder.ts` (create), `tests/unit/procedure-builder.spec.ts` (create — TDD)

### Goal

Função `teachProcedure(input)` recebe:
- `nome` (string)
- `descricao_livre` (string — owner explica em linguagem natural)
- `scope` (global/tenant/agent/role)
- `target` (opcional — agent_id ou role_id)

Chama LLM (Sonnet) com prompt estruturador, recebe JSON estruturado com steps/criteria/etc, valida via zod, retorna draft. NÃO persiste — caller decide.

### Tests (TDD)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { teachProcedure } from '@/cognition/procedure-builder.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async () => ({
    content: JSON.stringify({
      intencao: 'Qualificar lead de inglês adulto',
      when_apply: { tags: ['lead_b2c_adulto'] },
      when_not_apply: { tags: ['lead_em_fechamento'] },
      steps: [
        { id: 'descobrir_motivo', intencao: 'Entender porquê', como: 'Pergunte aberto', sucesso_criteria_ref: 'tem_motivo' },
        { id: 'estimar_nivel', intencao: 'Calibrar nível', como: 'Não pergunte direto', depends_on: ['descobrir_motivo'] },
      ],
      success_criteria: [{ id: 'tem_motivo', type: 'llm_judge', prompt: 'Cliente expressou motivo real?', threshold: 0.7 }],
      failure_modes: ['Confiar no nível declarado'],
      tools_referenced: ['ask_pending_question'],
    }),
  })),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return { ...actual, cognitiveModuleLogRepo: { record: vi.fn(async () => {}), recentByModule: vi.fn(async () => []) } };
});

describe('teachProcedure', () => {
  it('estrutura input livre em draft válido', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const draft = await teachProcedure({
        nome: 'qualificar-lead-ingles',
        descricao_livre: 'Quando entra lead novo de inglês adulto, primeiro descobre motivo real (viagem? trabalho? hobby?), depois estima nível sem confrontar...',
        scope: 'tenant',
      });
      expect(draft).not.toBeNull();
      expect(draft?.nome).toBe('qualificar-lead-ingles');
      expect(draft?.intencao).toContain('Qualificar');
      expect(draft?.steps.length).toBeGreaterThan(0);
      expect(draft?.success_criteria.length).toBeGreaterThan(0);
    });
  });

  it('retorna null quando LLM output inválido', async () => {
    // mock retorna json inválido pra esse teste
  });
});
```

### Implementation

```typescript
import { z } from 'zod';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

const ProcedureDraftSchema = z.object({
  intencao: z.string(),
  when_apply: z.object({}).passthrough(),
  when_not_apply: z.object({}).passthrough().optional(),
  steps: z.array(z.object({
    id: z.string(),
    intencao: z.string(),
    como: z.string(),
    sucesso_criteria_ref: z.string().optional(),
    armadilhas: z.array(z.string()).optional(),
    depends_on: z.array(z.string()).optional(),
    tools_used: z.array(z.string()).optional(),
  })),
  success_criteria: z.array(z.object({
    id: z.string(),
    type: z.enum(['machine_check', 'tool_result', 'user_signal', 'llm_judge', 'human_confirmed']),
  }).passthrough()),
  failure_modes: z.array(z.string()).optional(),
  tools_referenced: z.array(z.string()).optional(),
});

export type ProcedureDraft = {
  nome: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  intencao: string;
  when_apply: Record<string, unknown>;
  when_not_apply: Record<string, unknown>;
  steps: Array<{ id: string; intencao: string; como: string; [k: string]: unknown }>;
  success_criteria: Array<{ id: string; type: string; [k: string]: unknown }>;
  failure_modes: string[];
  tools_referenced: string[];
  source: 'ensino' | 'observacao' | 'pratica' | 'platform_wisdom';
};

export async function teachProcedure(input: {
  nome: string;
  descricao_livre: string;
  scope: 'global' | 'tenant' | 'agent' | 'role';
  source?: 'ensino' | 'observacao' | 'pratica';
}): Promise<ProcedureDraft | null> {
  const result = await runCognitiveModule(
    { name: 'procedure-builder.ensino', triggered_by: 'sync_required', timeoutMs: 15000 },
    async () => {
      const res = await callLLM({
        system: builderPrompt(),
        messages: [{ role: 'user', content: input.descricao_livre }],
        max_tokens: 1500,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const parsed = ProcedureDraftSchema.safeParse(JSON.parse(match[0]));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  );

  if (!result.output) return null;

  return {
    nome: input.nome,
    scope: input.scope,
    intencao: result.output.intencao,
    when_apply: result.output.when_apply,
    when_not_apply: result.output.when_not_apply ?? {},
    steps: result.output.steps as ProcedureDraft['steps'],
    success_criteria: result.output.success_criteria as ProcedureDraft['success_criteria'],
    failure_modes: result.output.failure_modes ?? [],
    tools_referenced: result.output.tools_referenced ?? [],
    source: input.source ?? 'ensino',
  };
}

function builderPrompt(): string {
  return `Você é o Procedure Builder. Recebe uma descrição livre de um procedimento (como o owner explicaria) e estrutura em JSON com:
- intencao: 1 frase resumindo o objetivo
- when_apply: { tags?: [...], conditions?: [...] } — quando o procedimento aplica
- when_not_apply: idem — quando NÃO aplica  
- steps: [{ id, intencao, como, sucesso_criteria_ref?, armadilhas?, depends_on?, tools_used? }] — passos em ordem lógica
- success_criteria: [{ id, type: 'machine_check'|'tool_result'|'user_signal'|'llm_judge'|'human_confirmed', ... }] — critérios verificáveis
- failure_modes: [string] — armadilhas comuns
- tools_referenced: [string] — tools que o procedimento usa

Use snake_case pra ids. Cada step deve ser concreto e verificável.

Retorne APENAS JSON. Se input incompreensível, retorne {"error":"..."}.`;
}
```

Commit: `feat(p3a): procedure-builder (modo ENSINO via LLM)`

---

## Task 6: procedure-status — transitions

**Files:** `src/cognition/procedure-status.ts` (create), `tests/unit/procedure-status.spec.ts` (create — TDD)

### Goal

Funções puras de validação + execução de transitions:
- `canTransition(from, to): boolean`
- `transitionStatus(definition_id, to, actor): Promise<void>` — chama repo apropriado

Transitions válidas:
- `draft → proposed` (qualquer)
- `proposed → active` (owner approval; deactivate previous active version do mesmo nome)
- `proposed → draft` (rejection, volta)
- `active → frozen` (manual freeze, e.g. drift detector P4)
- `active → rolled_back` (rollback)
- `frozen → active` (unfreeze)
- `rolled_back → ...` (não pode voltar — terminal)

Tests cover:
- Transitions válidas funcionam
- Transitions inválidas throw
- `proposed → active` deactivates previous active version (only one active per nome)

Commit: `feat(p3a): procedure-status transitions com validação`

---

## Task 7: Worker `procedure-candidate-consumer`

**Files:** `src/workers/procedure-candidate-consumer.ts` (create), `src/workers/index.ts` (modify)

### Goal

Worker batch (cron diário). Consome `cognitive_candidates` com `candidate_type='procedimento'` e `status='pending'`:
1. Lê em batch (50 por vez)
2. Para cada candidate, extrai `payload` (que veio do P1 classifier)
3. Chama `teachProcedure` usando `payload.passos_draft.join('\n')` como descricao_livre
4. Cria draft em `procedure_definitions`
5. Marca candidate como consumed: `cognitiveCandidatesRepo.markConsumed(id, 'p3a-procedure-builder')`

Implementação concisa, segue pattern de outros workers.

Registrar cron em `src/workers/index.ts`: `{ name: 'procedure_candidate_consumer', cron: '0 2 * * *', fn: runProcedureCandidateConsumer, phase: 2 }`

Commit: `feat(p3a): worker consome cognitive_candidates tipo procedimento → drafts`

---

## Task 8: Integration test — procedure lifecycle

**Files:** `tests/integration/p3a-procedure-lifecycle.spec.ts` (create)

### Cenários (mocked LLM + repos)

1. ENSINO → draft criado com estrutura válida
2. draft → proposed → approve → status=active
3. Reapproval cria nova version + deactivates previous
4. rollback volta versão anterior
5. transitions inválidas lançam erro

Commit: `test(p3a): integration test procedure lifecycle (5 cenários)`

---

## Task 9: Acceptance gates + runbook + PR

**Files:** `scripts/p3a-acceptance-gates.sh`, `docs/runbooks/p3a-procedures.md`

### Code-level gates
- 2 novas tabelas no schema
- procedure-builder + procedure-status unit tests pass
- Integration test pass
- Production build clean

### Runbook
- Como ensinar procedure manualmente (chamando `teachProcedure`)
- Como inspecionar drafts no DB
- Como aprovar manualmente um draft (procedure-status transitions)
- Como rollback se procedure ativa der errado

### PR
Open PR com summary das entregas P3a.

---

## P3a Acceptance Summary

1. ✅ procedure_definitions + procedure_assignments tables com schema híbrido
2. ✅ Status transitions: draft → proposed → active → frozen/rolled_back (active imutável)
3. ✅ Modo ENSINO funcional: owner descreve → LLM estrutura → draft armazenado
4. ✅ Consumer worker: P1 cognitive_candidates tipo 'procedimento' → drafts
5. ✅ Repos com tenant_guard + applyTenantGuard padrão
6. ❌ Runtime execution (P3b)
7. ❌ Métricas + tests + reaper (P3c)
