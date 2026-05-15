# Maia v2 — P3c Procedures: Governança (Metrics + Tests + Reaper + Step Evaluator Completo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Fechar o ciclo de **governança** sobre procedimentos: (1) métricas auditáveis recalculáveis do zero a partir de events; (2) testes obrigatórios que rodam antes de promover `proposed → active`; (3) worker `reaper` que força `status=abandoned` após inatividade prolongada; (4) step evaluator suporta os **5 tipos** de critério (`machine_check`, `tool_result` já em P3b — adicionar `llm_judge`, `user_signal`, `human_confirmed`).

**Architecture:** 1 tabela nova (`procedure_tests`) + 1 view materializada (`procedure_metrics`, derivada de `procedure_execution_events`) + 2 workers (`procedure-execution-reaper`, `procedure-metrics-refresh`) + extensão do step-evaluator para 3 novos tipos de critério + test-runner module que executa cenários em sandbox antes de promover. Test gate é **bloqueante** na transição `proposed → active` (modifica `procedure-status.ts` de P3a).

**Tech Stack:** TypeScript, Drizzle, PostgreSQL (matview), vitest, Anthropic SDK (Haiku para `llm_judge`), BullMQ/node-cron (workers). Builds on P3a (definitions/assignments) + P3b (executions/events/selector) + P0+P1+P2.

**Reference:** Spec §4.4 (critérios tipados), §6.1 P3c (`procedure_metrics` + `procedure_tests`), §9 P3c done criteria (linhas 591-595), §10.8 (schemas dormentes — P3c ativa estes).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/023_p3c_procedure_tests.sql` + down | Create | Cenários executáveis (gate de promoção) |
| `migrations/024_p3c_procedure_metrics.sql` + down | Create | Materialized view + refresh fn |
| `src/db/schema.ts` | Modify | `procedure_tests` table + types; `procedure_metrics` (read-only) |
| `src/db/repositories.ts` | Modify | `procedureTestsRepo` (CRUD) + `procedureMetricsRepo` (read) |
| `src/cognition/step-evaluator.ts` | Modify | Adicionar `llm_judge`, `user_signal`, `human_confirmed` branches |
| `src/cognition/step-evaluator-llm-judge.ts` | Create | Haiku judge isolado (cognitive module) |
| `src/cognition/step-evaluator-user-signal.ts` | Create | NLU determinístico sobre última msg do user |
| `src/procedures/test-runner.ts` | Create | Executa cenários em sandbox com LLM mockado/real |
| `src/cognition/procedure-status.ts` | Modify | `proposed → active` requer `tests_pass = true` |
| `src/workers/procedure-execution-reaper.ts` | Create | Marca `status=abandoned` após 7d inativo |
| `src/workers/procedure-metrics-refresh.ts` | Create | `REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics` |
| `src/workers/index.ts` | Modify | Registra os 2 novos jobs |
| `src/cognition/types.ts` | Modify | `LLMJudgeResult`, `UserSignalResult`, `ProcedureTestResult` |
| `tests/unit/step-evaluator-llm-judge.spec.ts` | Create | Testa judge com mock Haiku |
| `tests/unit/step-evaluator-user-signal.spec.ts` | Create | Testa NLU determinístico |
| `tests/unit/step-evaluator-human-confirmed.spec.ts` | Create | Testa branch human_confirmed via event |
| `tests/unit/procedure-test-runner.spec.ts` | Create | Testa runner com cenários mockados |
| `tests/unit/procedure-status-test-gate.spec.ts` | Create | Testa que `active` exige testes verdes |
| `tests/unit/procedure-execution-reaper.spec.ts` | Create | Testa worker reaper |
| `tests/integration/p3c-procedure-governance.spec.ts` | Create | End-to-end: criar def → criar tests → tentar promover sem tests → falha → rodar tests → promover → executar → metrics refresh → reaper ignora ativo |
| `scripts/p3c-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p3c-procedure-governance.md` | Create | Runbook |

---

## Task 1: Migration `procedure_tests`

**Files:**
- Create: `migrations/023_p3c_procedure_tests.sql`
- Create: `migrations/023_p3c_procedure_tests_down.sql`
- Modify: `src/db/schema.ts`

### SQL UP

```sql
-- P3c: procedure_tests — cenários executáveis que validam um procedimento
-- antes de promover proposed → active. Cada test é uma sequência de
-- (user_message → expected_outcome) que o test-runner executa em sandbox.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE procedure_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  scenario JSONB NOT NULL,
  expected_outcome TEXT NOT NULL CHECK (
    expected_outcome IN ('success', 'failure', 'partial', 'escalated')
  ),
  expected_step_path JSONB,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT CHECK (
    last_run_status IS NULL OR last_run_status IN ('pass', 'fail', 'error', 'skipped')
  ),
  last_run_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_tests_definition_idx
  ON procedure_tests(definition_id, last_run_status);
CREATE INDEX procedure_tests_tenant_agent_idx
  ON procedure_tests(tenant_id, agent_id);
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS procedure_tests_tenant_agent_idx;
DROP INDEX IF EXISTS procedure_tests_definition_idx;
DROP TABLE IF EXISTS procedure_tests;
```

### Drizzle (em `src/db/schema.ts`, junto com outras procedure tables)

```typescript
export const procedure_tests = pgTable(
  'procedure_tests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    definition_id: uuid('definition_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    scenario: jsonb('scenario').notNull(),
    expected_outcome: text('expected_outcome').notNull(),
    expected_step_path: jsonb('expected_step_path'),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    last_run_status: text('last_run_status'),
    last_run_details: jsonb('last_run_details'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    definitionIdx: index('procedure_tests_definition_idx').on(t.definition_id, t.last_run_status),
    tenantAgentIdx: index('procedure_tests_tenant_agent_idx').on(t.tenant_id, t.agent_id),
  }),
);

export type ProcedureTest = typeof procedure_tests.$inferSelect;
export type NewProcedureTest = typeof procedure_tests.$inferInsert;
```

### Steps

- [ ] **Step 1: Write the failing test** — `tests/unit/db-schema-p3c.spec.ts`

```typescript
import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P3c schema', () => {
  it('exports procedure_tests table', () => {
    expect(schema.procedure_tests).toBeDefined();
  });
  it('procedure_tests has scenario JSONB column', () => {
    const cols = Object.keys(schema.procedure_tests);
    expect(cols).toContain('scenario');
    expect(cols).toContain('expected_outcome');
    expect(cols).toContain('definition_id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/db-schema-p3c.spec.ts`
Expected: FAIL (`procedure_tests` not exported)

- [ ] **Step 3: Create the SQL migration files (UP + DOWN)** as defined above.

- [ ] **Step 4: Add Drizzle definition** in `src/db/schema.ts` as defined above.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/db-schema-p3c.spec.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add migrations/023_p3c_procedure_tests.sql migrations/023_p3c_procedure_tests_down.sql src/db/schema.ts tests/unit/db-schema-p3c.spec.ts
git commit -m "feat(p3c): procedure_tests table (cenários como gate de promoção)"
```

---

## Task 2: Migration `procedure_metrics` (materialized view)

**Files:**
- Create: `migrations/024_p3c_procedure_metrics.sql`
- Create: `migrations/024_p3c_procedure_metrics_down.sql`
- Modify: `src/db/schema.ts`

**Scene:** Métricas DERIVADAS de events. Recalculáveis do zero. Refresh assíncrono via worker (CONCURRENTLY). Não armazenamos nada que dependa de cálculo cumulativo — toda agregação vem do event log.

### SQL UP

```sql
-- P3c: procedure_metrics — view materializada agregando métricas por definition
-- Recalculável 100% a partir de procedure_executions + procedure_execution_events.
-- Refresh assíncrono via worker.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE MATERIALIZED VIEW procedure_metrics AS
SELECT
  d.id AS definition_id,
  d.tenant_id,
  d.owner_agent_id AS agent_id,
  d.nome,
  d.version,
  d.status AS definition_status,
  COUNT(DISTINCT e.id) AS total_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'success') AS successful_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'failure') AS failed_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'aborted') AS aborted_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'escalated') AS escalated_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'abandoned') AS abandoned_executions,
  COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'in_progress') AS in_progress_executions,
  CASE
    WHEN COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('completed', 'aborted', 'escalated', 'abandoned')) > 0
    THEN (
      COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'completed' AND e.outcome = 'success')::numeric
      / COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('completed', 'aborted', 'escalated', 'abandoned'))::numeric
    )
    ELSE NULL
  END AS success_rate,
  AVG(
    EXTRACT(EPOCH FROM (e.ended_at - e.started_at))
  ) FILTER (WHERE e.status = 'completed' AND e.ended_at IS NOT NULL) AS avg_completion_seconds,
  MAX(e.last_activity_at) AS last_execution_at,
  now() AS refreshed_at
FROM procedure_definitions d
LEFT JOIN procedure_executions e ON e.definition_id = d.id
GROUP BY d.id, d.tenant_id, d.owner_agent_id, d.nome, d.version, d.status;

CREATE UNIQUE INDEX procedure_metrics_definition_idx
  ON procedure_metrics(definition_id);
CREATE INDEX procedure_metrics_tenant_agent_idx
  ON procedure_metrics(tenant_id, agent_id);
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS procedure_metrics_tenant_agent_idx;
DROP INDEX IF EXISTS procedure_metrics_definition_idx;
DROP MATERIALIZED VIEW IF EXISTS procedure_metrics;
```

### Drizzle

Materialized views são read-only via Drizzle. Declarar como `pgView` ou expor type manual.

```typescript
// Em src/db/schema.ts, após procedure_tests:
import { pgMaterializedView } from 'drizzle-orm/pg-core';

export const procedure_metrics = pgMaterializedView('procedure_metrics', {
  definition_id: uuid('definition_id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  agent_id: text('agent_id').notNull(),
  nome: text('nome').notNull(),
  version: integer('version').notNull(),
  definition_status: text('definition_status').notNull(),
  total_executions: integer('total_executions').notNull(),
  successful_executions: integer('successful_executions').notNull(),
  failed_executions: integer('failed_executions').notNull(),
  aborted_executions: integer('aborted_executions').notNull(),
  escalated_executions: integer('escalated_executions').notNull(),
  abandoned_executions: integer('abandoned_executions').notNull(),
  in_progress_executions: integer('in_progress_executions').notNull(),
  success_rate: text('success_rate'),
  avg_completion_seconds: text('avg_completion_seconds'),
  last_execution_at: timestamp('last_execution_at', { withTimezone: true }),
  refreshed_at: timestamp('refreshed_at', { withTimezone: true }).notNull(),
}).existing();

export type ProcedureMetric = typeof procedure_metrics.$inferSelect;
```

### Steps

- [ ] **Step 1: Extend test** (adicionar caso no spec da Task 1)

```typescript
it('exports procedure_metrics view', () => {
  expect(schema.procedure_metrics).toBeDefined();
});
```

- [ ] **Step 2: Run test, verify it fails.**

- [ ] **Step 3: Create migration files (UP + DOWN).**

- [ ] **Step 4: Add Drizzle definition** in `src/db/schema.ts`.

- [ ] **Step 5: Run test, verify it passes.**

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add migrations/024_p3c_procedure_metrics.sql migrations/024_p3c_procedure_metrics_down.sql src/db/schema.ts tests/unit/db-schema-p3c.spec.ts
git commit -m "feat(p3c): procedure_metrics materialized view (derivada de events)"
```

---

## Task 3: Repos `procedureTestsRepo` + `procedureMetricsRepo`

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/unit/procedure-tests-repo.spec.ts`

### Repo signatures

```typescript
export const procedureTestsRepo = {
  async create(input: {
    definition_id: string;
    name: string;
    description?: string;
    scenario: unknown;
    expected_outcome: 'success' | 'failure' | 'partial' | 'escalated';
    expected_step_path?: unknown;
  }): Promise<ProcedureTest> { /* applyTenantGuard insert */ },

  async listByDefinition(definition_id: string): Promise<ProcedureTest[]> { /* */ },

  async recordRun(args: {
    id: string;
    status: 'pass' | 'fail' | 'error' | 'skipped';
    details: unknown;
  }): Promise<void> { /* updates last_run_status + last_run_at + last_run_details */ },

  async allPassFor(definition_id: string): Promise<boolean> {
    /* returns true iff there's at least 1 test AND all have last_run_status='pass' */
  },

  async delete(id: string): Promise<void> { /* */ },
};

export const procedureMetricsRepo = {
  async getByDefinition(definition_id: string): Promise<ProcedureMetric | null> { /* */ },
  async listByTenantAgent(): Promise<ProcedureMetric[]> { /* applyTenantGuard select */ },
};
```

### Steps

- [ ] **Step 1: Write the failing tests** — `tests/unit/procedure-tests-repo.spec.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { procedureTestsRepo, procedureDefinitionsRepo, tenantsRepo, agentsRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

describe('procedureTestsRepo', () => {
  // Setup fixtures (tenant, agent, definition)
  // ...
  it('creates a test', async () => { /* */ });
  it('lists tests by definition', async () => { /* */ });
  it('records run status', async () => { /* */ });
  it('allPassFor returns false when no tests', async () => { /* */ });
  it('allPassFor returns false when one fails', async () => { /* */ });
  it('allPassFor returns true when all pass', async () => { /* */ });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `procedureTestsRepo` + `procedureMetricsRepo` em `src/db/repositories.ts`. Use `applyTenantGuard` no insert/select.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Typecheck** (`npx tsc --noEmit`).

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories.ts tests/unit/procedure-tests-repo.spec.ts
git commit -m "feat(p3c): procedureTestsRepo + procedureMetricsRepo"
```

---

## Task 4: Step evaluator — branch `llm_judge`

**Files:**
- Create: `src/cognition/step-evaluator-llm-judge.ts`
- Modify: `src/cognition/step-evaluator.ts`
- Modify: `src/cognition/types.ts`
- Test: `tests/unit/step-evaluator-llm-judge.spec.ts`

**Scene:** `llm_judge` é critério **subjetivo** com threshold. Recebe `prompt`, `threshold` (0.0-1.0) e `response_text`. Pergunta a um modelo barato (Haiku) se a resposta cumpre o critério, e extrai um score. Envolvido em `runCognitiveModule` (timeout + fallback + audit). Em falha → `passed = false`, `evidence = "judge_error: <reason>"`.

### Critério format

```typescript
{
  id: 'criterion_explained_well',
  type: 'llm_judge',
  prompt: 'A resposta explica claramente os 3 pilares do produto?',
  threshold: 0.7,    // mínimo aceitável (0-1)
  rubric?: string,   // opcional, dado ao judge
}
```

### Module `step-evaluator-llm-judge.ts`

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from './runner.js';

export type LLMJudgeInput = {
  prompt: string;
  threshold: number;
  response_text: string;
  rubric?: string;
};

export type LLMJudgeResult = {
  passed: boolean;
  score: number;
  reasoning: string;
};

const SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string', maxLength: 200 },
  },
  required: ['score', 'reasoning'],
};

export async function judgeStepCriterion(input: LLMJudgeInput): Promise<LLMJudgeResult> {
  return runCognitiveModule(
    {
      module: 'step_evaluator_llm_judge',
      timeout_ms: 5000,
      fallback: (): LLMJudgeResult => ({
        passed: false,
        score: 0,
        reasoning: 'judge_timeout_or_error',
      }),
    },
    async () => {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      const system = [
        'Você é um avaliador objetivo de respostas.',
        'Dado um critério, uma resposta e (opcional) um rubric, devolva',
        '{"score": 0..1, "reasoning": "..."}.',
        '0 = não cumpre; 1 = cumpre perfeitamente.',
      ].join('\n');
      const user = [
        `CRITÉRIO: ${input.prompt}`,
        input.rubric ? `RUBRIC: ${input.rubric}` : '',
        `RESPOSTA: ${input.response_text}`,
        'Devolva JSON com score (0-1) e reasoning curto.',
      ].filter(Boolean).join('\n\n');
      const completion = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = completion.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        return { passed: false, score: 0, reasoning: 'judge_returned_no_json' };
      }
      const parsed = JSON.parse(match[0]) as { score: number; reasoning: string };
      return {
        passed: parsed.score >= input.threshold,
        score: parsed.score,
        reasoning: parsed.reasoning,
      };
    },
  );
}
```

### Modificação em `step-evaluator.ts`

```typescript
// Substituir o ramo "else" (linhas 84-89 atuais) por:

} else if (c.type === 'llm_judge') {
  const judge = await judgeStepCriterion({
    prompt: c.prompt as string,
    threshold: (c.threshold as number) ?? 0.7,
    response_text: args.response_context.response_text ?? '',
    rubric: c.rubric as string | undefined,
  });
  passed = judge.passed;
  evidence = `judge score=${judge.score.toFixed(2)} threshold=${(c.threshold as number) ?? 0.7}: ${judge.reasoning}`;
} else if (c.type === 'user_signal') {
  // Task 5 — keep as not-evaluated for this commit
  passed = false;
  evidence = `criterion type ${c.type} not evaluated yet (Task 5)`;
} else if (c.type === 'human_confirmed') {
  // Task 6 — keep as not-evaluated for this commit
  passed = false;
  evidence = `criterion type ${c.type} not evaluated yet (Task 6)`;
}
```

**IMPORTANT:** A função `evaluateCurrentStep` em `step-evaluator.ts` **deve passar a ser `async`** (já que `judgeStepCriterion` é async). Todos os callers (engine, react-loop, agent/core) devem aguardar (`await`).

### Tipos em `types.ts`

```typescript
export type StepCriterionType =
  | 'machine_check'
  | 'tool_result'
  | 'llm_judge'
  | 'user_signal'
  | 'human_confirmed';

export type LLMJudgeCriterion = {
  id: string;
  type: 'llm_judge';
  prompt: string;
  threshold?: number;
  rubric?: string;
};
```

### Steps

- [ ] **Step 1: Write failing test** — `tests/unit/step-evaluator-llm-judge.spec.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"score": 0.85, "reasoning": "explica bem"}' }],
      }),
    },
  })),
}));

import { judgeStepCriterion } from '@/cognition/step-evaluator-llm-judge.js';

describe('judgeStepCriterion', () => {
  it('passes when score >= threshold', async () => {
    const r = await judgeStepCriterion({
      prompt: 'Resposta clara?',
      threshold: 0.7,
      response_text: 'sim, explicando A, B e C',
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(0.85, 2);
  });

  it('fails when score < threshold', async () => {
    // Reconfigure mock to return 0.5
    // ...
  });

  it('returns fallback on error', async () => {
    // mock anthropic to throw
    // expect passed=false, reasoning includes 'timeout_or_error'
  });
});
```

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** `src/cognition/step-evaluator-llm-judge.ts`.

- [ ] **Step 4: Update types** in `src/cognition/types.ts`.

- [ ] **Step 5: Wire into `step-evaluator.ts`** — make `evaluateCurrentStep` async, add `llm_judge` branch, leave `user_signal`/`human_confirmed` as not-evaluated for now.

- [ ] **Step 6: Update callers** to `await`. **Confirmed callers** (verified via `grep -rn evaluateCurrentStep src/ tests/`):
  - `src/agent/core.ts` (line ~496, post-turn evaluator) — needs `await`
  - `tests/unit/step-evaluator.spec.ts` — every `evaluateCurrentStep(...)` must become `await evaluateCurrentStep(...)` and the surrounding `it(...)` callbacks must be `async`
  - `tests/integration/p3b-procedure-runtime.spec.ts` — same treatment

  **NOT callers** (despite intuition): `src/procedures/engine.ts` does NOT call `evaluateCurrentStep` (engine handles event sourcing; evaluator is called from agent/core only). `src/agent/react-loop.ts` does NOT call it either. Do not introduce phantom imports.

- [ ] **Step 7: Run** `npx vitest run tests/unit/step-evaluator-llm-judge.spec.ts` — pass.

- [ ] **Step 8: Re-run** existing P3b tests (`tests/unit/step-evaluator.spec.ts`) — still pass.

- [ ] **Step 9: Typecheck.**

- [ ] **Step 10: Commit**

```bash
git add src/cognition/step-evaluator-llm-judge.ts src/cognition/step-evaluator.ts src/cognition/types.ts src/agent/core.ts tests/unit/step-evaluator.spec.ts tests/integration/p3b-procedure-runtime.spec.ts tests/unit/step-evaluator-llm-judge.spec.ts
git commit -m "feat(p3c): step-evaluator branch llm_judge (Haiku + threshold + cognitive module wrap)"
```

---

## Task 5: Step evaluator — branch `user_signal`

**Files:**
- Create: `src/cognition/step-evaluator-user-signal.ts`
- Modify: `src/cognition/step-evaluator.ts`
- Modify: `src/cognition/step-evaluator.ts` signature (add user_message to ResponseContext)
- Test: `tests/unit/step-evaluator-user-signal.spec.ts`

**Scene:** `user_signal` valida se o **usuário** sinalizou algo (concordou, confirmou, negou). É **determinístico** — não chama LLM. Usa lista de padrões POSITIVOS e NEGATIVOS configurados no critério, mais palavras-default.

### Critério format

```typescript
{
  id: 'criterion_user_agreed',
  type: 'user_signal',
  signal: 'agreement' | 'denial' | 'custom',
  // se signal === 'custom':
  positive_patterns?: string[],   // regex/substring
  negative_patterns?: string[],
}
```

### Module

```typescript
const AGREEMENT_POSITIVE = [
  /\b(sim|ok|claro|combinado|fechado|aceito|topo|pode ser|tudo bem|tudo certo|beleza|show|positivo|concordo|confirmo|confirmado)\b/i,
];
const AGREEMENT_NEGATIVE = [
  /\b(n[ãa]o|nope|de jeito nenhum|negativo|n[ãa]o quero|n[ãa]o aceito|recuso)\b/i,
];
const DENIAL_POSITIVE = AGREEMENT_NEGATIVE;
const DENIAL_NEGATIVE = AGREEMENT_POSITIVE;

export type UserSignalInput = {
  signal: 'agreement' | 'denial' | 'custom';
  positive_patterns?: string[];
  negative_patterns?: string[];
  user_message: string;
};

export type UserSignalResult = {
  passed: boolean;
  matched: 'positive' | 'negative' | 'none';
  evidence: string;
};

export function detectUserSignal(input: UserSignalInput): UserSignalResult {
  const msg = (input.user_message ?? '').trim();
  if (msg.length === 0) {
    return { passed: false, matched: 'none', evidence: 'no user message' };
  }
  let pos: RegExp[] = [];
  let neg: RegExp[] = [];
  if (input.signal === 'agreement') { pos = AGREEMENT_POSITIVE; neg = AGREEMENT_NEGATIVE; }
  else if (input.signal === 'denial') { pos = DENIAL_POSITIVE; neg = DENIAL_NEGATIVE; }
  else {
    pos = (input.positive_patterns ?? []).map((p) => safeRegex(p));
    neg = (input.negative_patterns ?? []).map((p) => safeRegex(p));
  }
  // Negative checked first — denial overrides accidental positive
  for (const r of neg) if (r.test(msg)) {
    return { passed: false, matched: 'negative', evidence: `matched negative pattern` };
  }
  for (const r of pos) if (r.test(msg)) {
    return { passed: true, matched: 'positive', evidence: `matched positive pattern` };
  }
  return { passed: false, matched: 'none', evidence: 'no pattern matched' };
}

function safeRegex(p: string): RegExp {
  try { return new RegExp(p, 'i'); }
  catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}
```

### ResponseContext extension

```typescript
// step-evaluator.ts
export type ResponseContext = {
  response_text?: string;
  tools_called?: Array<{ name: string; result: unknown }>;
  user_message?: string;   // NEW — last user message in this turn
};
```

E em `step-evaluator.ts` substituir o ramo `user_signal` por:

```typescript
} else if (c.type === 'user_signal') {
  const r = detectUserSignal({
    signal: (c.signal as 'agreement' | 'denial' | 'custom') ?? 'agreement',
    positive_patterns: c.positive_patterns as string[] | undefined,
    negative_patterns: c.negative_patterns as string[] | undefined,
    user_message: args.response_context.user_message ?? '',
  });
  passed = r.passed;
  evidence = `user_signal ${r.matched}: ${r.evidence}`;
}
```

**Callers atualizados:**
- `src/agent/core.ts` post-turn evaluator deve passar `user_message` (a `mensagem.body` que originou o turno).
- `src/procedures/engine.ts` — se houver chamada interna a evaluator, passar `user_message: ''`.

### Steps

- [ ] **Step 1: Write failing test** — `tests/unit/step-evaluator-user-signal.spec.ts`

```typescript
import { detectUserSignal } from '@/cognition/step-evaluator-user-signal.js';

describe('detectUserSignal', () => {
  it('agreement positive matches "sim"', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: 'sim, pode ser' });
    expect(r.passed).toBe(true);
    expect(r.matched).toBe('positive');
  });
  it('agreement negative matches "não"', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: 'não, obrigado' });
    expect(r.passed).toBe(false);
    expect(r.matched).toBe('negative');
  });
  it('denial inverts: "não" passes for signal=denial', () => {
    const r = detectUserSignal({ signal: 'denial', user_message: 'não quero' });
    expect(r.passed).toBe(true);
  });
  it('custom uses provided patterns', () => {
    const r = detectUserSignal({
      signal: 'custom',
      positive_patterns: ['quero comprar'],
      user_message: 'eu quero comprar agora',
    });
    expect(r.passed).toBe(true);
  });
  it('empty message → none', () => {
    const r = detectUserSignal({ signal: 'agreement', user_message: '' });
    expect(r.matched).toBe('none');
  });
});
```

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** `src/cognition/step-evaluator-user-signal.ts`.

- [ ] **Step 4: Extend `ResponseContext`** and wire branch in `step-evaluator.ts`.

- [ ] **Step 5: Update callers** to pass `user_message` (especially `src/agent/core.ts`).

- [ ] **Step 6: Run** test, verify pass.

- [ ] **Step 7: Run** existing P3b step-evaluator tests — still pass.

- [ ] **Step 8: Typecheck.**

- [ ] **Step 9: Commit**

```bash
git add src/cognition/step-evaluator-user-signal.ts src/cognition/step-evaluator.ts src/agent/core.ts src/procedures/engine.ts tests/unit/step-evaluator-user-signal.spec.ts
git commit -m "feat(p3c): step-evaluator branch user_signal (NLU determinístico agree/deny/custom)"
```

---

## Task 6: Step evaluator — branch `human_confirmed`

**Files:**
- Modify: `src/cognition/step-evaluator.ts`
- Modify: `src/procedures/engine.ts` (helper para registrar confirmação humana)
- Test: `tests/unit/step-evaluator-human-confirmed.spec.ts`
- Test: `tests/unit/procedure-engine-human-confirmation.spec.ts`

**Scene:** `human_confirmed` exige que um **operador humano** registre confirmação via mecanismo externo (ex.: dashboard). Tecnicamente: o engine ganha método `recordHumanConfirmation(execution_id, step_id, operator_id, decision)` que persiste um event tipo `human_confirmation` em `procedure_execution_events`. O step-evaluator lê o events do step atual e verifica se há `human_confirmation` com `decision='approved'`.

### Critério format

```typescript
{
  id: 'criterion_supervisor_ok',
  type: 'human_confirmed',
  role?: string,        // qual role pode confirmar (default: any operator)
  ttl_minutes?: number, // confirmação expira (default: nenhuma expiração)
}
```

### Helpers

```typescript
// src/procedures/engine.ts
export async function recordHumanConfirmation(args: {
  execution_id: string;
  step_id: string;
  operator_id: string;
  decision: 'approved' | 'rejected';
  notes?: string;
}): Promise<void> {
  await procedureExecutionEventsRepo.append({
    execution_id: args.execution_id,
    event_type: 'human_confirmation',
    payload: {
      step_id: args.step_id,
      operator_id: args.operator_id,
      decision: args.decision,
      notes: args.notes ?? null,
    },
  });
}

// Helper para o evaluator consultar
export async function getLatestHumanConfirmation(args: {
  execution_id: string;
  step_id: string;
}): Promise<{ decision: 'approved' | 'rejected'; operator_id: string; ts: Date } | null> {
  const events = await procedureExecutionEventsRepo.listByExecution(args.execution_id);
  // pick LAST event of type human_confirmation for this step
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const p = e.payload as { step_id?: string; decision?: string; operator_id?: string };
    if (e.event_type === 'human_confirmation' && p?.step_id === args.step_id) {
      return { decision: p.decision as 'approved' | 'rejected', operator_id: p.operator_id!, ts: e.created_at };
    }
  }
  return null;
}
```

### Branch em `step-evaluator.ts`

```typescript
} else if (c.type === 'human_confirmed') {
  const conf = await getLatestHumanConfirmation({
    execution_id: args.execution.id,
    step_id: currentStep.id,
  });
  if (!conf) {
    passed = false;
    evidence = 'awaiting human confirmation';
  } else if (conf.decision === 'rejected') {
    passed = false;
    evidence = `human rejected by ${conf.operator_id}`;
  } else {
    // optional TTL check
    const ttlMin = c.ttl_minutes as number | undefined;
    if (ttlMin && Date.now() - conf.ts.getTime() > ttlMin * 60_000) {
      passed = false;
      evidence = `confirmation expired (ttl ${ttlMin}min)`;
    } else {
      passed = true;
      evidence = `human approved by ${conf.operator_id}`;
    }
  }
}
```

### Steps

- [ ] **Step 1: Write failing tests:**
  - `step-evaluator-human-confirmed.spec.ts` — testa branch usando mock `procedureExecutionEventsRepo.listByExecution`.
  - `procedure-engine-human-confirmation.spec.ts` — testa que `recordHumanConfirmation` chama o append correto.

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** `recordHumanConfirmation` + `getLatestHumanConfirmation` em `src/procedures/engine.ts`.

- [ ] **Step 4: Wire branch** em `step-evaluator.ts`.

- [ ] **Step 5: Run** tests, verify pass.

- [ ] **Step 6: Run** existing P3b engine + step-evaluator tests — still pass.

- [ ] **Step 7: Typecheck.**

- [ ] **Step 8: Commit**

```bash
git add src/cognition/step-evaluator.ts src/procedures/engine.ts tests/unit/step-evaluator-human-confirmed.spec.ts tests/unit/procedure-engine-human-confirmation.spec.ts
git commit -m "feat(p3c): step-evaluator branch human_confirmed (event-sourced via human_confirmation event)"
```

---

## Task 7: Procedure test runner

**Files:**
- Create: `src/procedures/test-runner.ts`
- Test: `tests/unit/procedure-test-runner.spec.ts`

**Scene:** Test runner executa um cenário em **sandbox**: cria execução temporária da definition, simula sequência de mensagens user/agent, dispara step evaluator a cada passo, e compara o `outcome` final + `step_path` com `expected_outcome` + `expected_step_path` do test. Resultado vai para `last_run_status`.

### Scenario format

```typescript
type Scenario = {
  turns: Array<
    | { role: 'user'; message: string }
    | { role: 'agent'; response_text: string; tools_called?: Array<{ name: string; result: unknown }> }
  >;
  // Opcional: confirmações humanas que devem ser auto-injetadas em determinados pontos
  human_confirmations?: Array<{ at_step: string; decision: 'approved' | 'rejected'; operator_id: string }>;
};
```

### Signature

```typescript
export type TestRunResult = {
  status: 'pass' | 'fail' | 'error';
  details: {
    expected_outcome: string;
    actual_outcome: string | null;
    expected_step_path?: string[];
    actual_step_path: string[];
    final_status: string;
    diff: string[];
    error?: string;
  };
};

export async function runProcedureTest(args: {
  test_id: string;
  definition: ProcedureDefinition;
  scenario: Scenario;
  expected_outcome: string;
  expected_step_path?: string[];
}): Promise<TestRunResult>;
```

### Implementation outline

1. Cria uma execução **sandbox** (tenant_id='sandbox-test', agent_id='sandbox', conversa_id=null) via `engine.startExecution`
2. Itera turns:
   - se `role:user` → guarda last_user_message
   - se `role:agent` → chama `evaluateCurrentStep` com `response_context = { response_text, tools_called, user_message: last_user_message }`; se `step_completed`, chama `engine.advanceStep`
3. Aplica `human_confirmations` no momento certo (via `recordHumanConfirmation`)
4. Após todos os turns, se ainda `in_progress`, marca outcome como `partial`
5. Compara com expected; devolve `pass`/`fail`/`error`

**IMPORTANT:** rodar dentro de `runWithTenantContext({ tenant_id: 'sandbox-test', agent_id: 'sandbox' })`.

**Cleanup:** após o run, deletar a execução sandbox criada (`procedure_executions.delete(execution_id)` + cascade events).

### Steps

- [ ] **Step 1: Write failing test** — pelo menos 3 cenários:
  - Cenário pass (turns que levam ao expected_outcome)
  - Cenário fail (turns que NÃO chegam ao expected_outcome)
  - Cenário com `human_confirmations`

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** `runProcedureTest` em `src/procedures/test-runner.ts`.

- [ ] **Step 4: Run, pass.**

- [ ] **Step 5: Typecheck.**

- [ ] **Step 6: Commit**

```bash
git add src/procedures/test-runner.ts tests/unit/procedure-test-runner.spec.ts
git commit -m "feat(p3c): procedure test-runner (sandbox + step-evaluator + human confirmations)"
```

---

## Task 8: Test gate na transição `proposed → active`

**Files:**
- Modify: `src/cognition/procedure-status.ts`
- Test: `tests/unit/procedure-status-test-gate.spec.ts`

**Scene:** `procedure-status.ts` de P3a controla transições. P3c adiciona regra: `proposed → active` requer **pelo menos 1 test, e todos com `last_run_status='pass'`**. Caso contrário, retorna erro tipado `tests_not_passing` com lista de testes pendentes/falhos.

### Modificação

```typescript
// procedure-status.ts — branch proposed → active

if (from === 'proposed' && to === 'active') {
  const tests = await procedureTestsRepo.listByDefinition(definition.id);
  if (tests.length === 0) {
    return { ok: false, reason: 'tests_required', missing_tests: true };
  }
  const notPass = tests.filter((t) => t.last_run_status !== 'pass');
  if (notPass.length > 0) {
    return {
      ok: false,
      reason: 'tests_not_passing',
      failing_tests: notPass.map((t) => ({ id: t.id, name: t.name, status: t.last_run_status })),
    };
  }
}
```

### Steps

- [ ] **Step 1: Write failing test** — 3 cenários:
  - Promover sem nenhum teste → erro `tests_required`
  - Promover com teste failing → erro `tests_not_passing`
  - Promover com todos pass → ok

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** branch em `src/cognition/procedure-status.ts`.

- [ ] **Step 4: Run, pass.**

- [ ] **Step 5: Run** existing P3a status tests — qualquer teste em `tests/unit/procedure-status.spec.ts` que exercite `proposed → active` SEM seed de `procedure_test` precisa ser ajustado. Duas opções (escolher caso a caso):
  - **(a)** Seedar pelo menos 1 `procedure_test` com `last_run_status='pass'` para a definition antes da transição (preserva a intenção original do teste, que era validar a transição em si).
  - **(b)** Atualizar o teste pra asseverar o novo erro `tests_required` (caso a intenção original fosse só checar caminho feliz e o teste se beneficie do gate).
  Aplicar a mesma regra ao integration test `tests/integration/p3a-procedures.spec.ts` se ele promover sem seed.

- [ ] **Step 6: Typecheck.**

- [ ] **Step 7: Commit**

```bash
git add src/cognition/procedure-status.ts tests/unit/procedure-status-test-gate.spec.ts
git commit -m "feat(p3c): test gate proposed -> active (exige tests verdes)"
```

---

## Task 9: Worker `procedure-execution-reaper`

**Files:**
- Create: `src/workers/procedure-execution-reaper.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/unit/procedure-execution-reaper.spec.ts`

**Scene:** Worker periódico (a cada 1h) que marca como `status='abandoned'` execuções com `status='in_progress'` cuja `last_activity_at < now() - INTERVAL '7 days'`. Registra event tipo `auto_abandoned` para auditoria. TTL configurável via env `PROCEDURE_TTL_DAYS` (default 7).

### Implementation

```typescript
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { tenantsRepo, procedureExecutionsRepo, procedureExecutionEventsRepo } from '@/db/repositories.js';

const TTL_DAYS = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);

export async function runProcedureExecutionReaper(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let total = 0;
  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      // For each agent in tenant — list staling executions
      const stale = await procedureExecutionsRepo.listStaleInProgress({
        ttl_days: TTL_DAYS,
      });
      for (const ex of stale) {
        await procedureExecutionEventsRepo.append({
          execution_id: ex.id,
          event_type: 'auto_abandoned',
          payload: { reason: `inactive_for_${TTL_DAYS}_days`, last_activity_at: ex.last_activity_at },
        });
        await procedureExecutionsRepo.update(ex.id, {
          status: 'abandoned',
          outcome: 'no_response',
          ended_at: new Date(),
        });
        total++;
      }
    });
  }
  logger.info({ reaped: total, ttl_days: TTL_DAYS }, 'procedure_execution_reaper.done');
}
```

**Novo método em `procedureExecutionsRepo`:**

```typescript
async listStaleInProgress(opts: { ttl_days: number }): Promise<ProcedureExecution[]> {
  const cutoff = new Date(Date.now() - opts.ttl_days * 86_400_000);
  return applyTenantGuard(
    db
      .select()
      .from(schema.procedure_executions)
      .where(
        and(
          eq(schema.procedure_executions.status, 'in_progress'),
          lt(schema.procedure_executions.last_activity_at, cutoff),
        ),
      )
  );
}
```

### Schedule

Em `src/workers/index.ts`:

```typescript
import { runProcedureExecutionReaper } from './procedure-execution-reaper.js';

// ... dentro de JOBS:
{ name: 'procedure_execution_reaper', cron: '0 * * * *', fn: runProcedureExecutionReaper, phase: 3 },
```

### Steps

- [ ] **Step 1: Write failing test**

```typescript
describe('runProcedureExecutionReaper', () => {
  it('marks stale in_progress as abandoned + appends auto_abandoned event', async () => {
    // setup: insert execution with last_activity_at = 8 days ago, status in_progress
    // run reaper
    // assert: status='abandoned', outcome='no_response', event appended
  });
  it('skips fresh executions', async () => { /* */ });
  it('skips completed/aborted executions', async () => { /* */ });
});
```

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement** `listStaleInProgress` em repo + `runProcedureExecutionReaper`.

- [ ] **Step 4: Register job** em `src/workers/index.ts`.

- [ ] **Step 5: Run, pass.**

- [ ] **Step 6: Typecheck.**

- [ ] **Step 7: Commit**

```bash
git add src/workers/procedure-execution-reaper.ts src/workers/index.ts src/db/repositories.ts tests/unit/procedure-execution-reaper.spec.ts
git commit -m "feat(p3c): worker procedure-execution-reaper (7d TTL -> abandoned)"
```

---

## Task 10: Worker `procedure-metrics-refresh`

**Files:**
- Create: `src/workers/procedure-metrics-refresh.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/unit/procedure-metrics-refresh.spec.ts`

**Scene:** Worker periódico (a cada 15min) que executa `REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics`. Como é matview cross-tenant, **não roda dentro de tenant context** — usa pool global. Concurrent refresh evita lock leitor; precisa do índice único (já definido na Task 2).

### Implementation

```typescript
import { logger } from '@/lib/logger.js';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

export async function runProcedureMetricsRefresh(): Promise<void> {
  const start = Date.now();
  try {
    await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics`);
    logger.info({ elapsed_ms: Date.now() - start }, 'procedure_metrics_refresh.done');
  } catch (err) {
    logger.error({ err, elapsed_ms: Date.now() - start }, 'procedure_metrics_refresh.failed');
    throw err;
  }
}
```

### Schedule

```typescript
{ name: 'procedure_metrics_refresh', cron: '*/15 * * * *', fn: runProcedureMetricsRefresh, phase: 3 },
```

### Steps

- [ ] **Step 1: Write test** com mock `db.execute` checando que recebe a SQL certa.

- [ ] **Step 2: Run, fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Register job.**

- [ ] **Step 5: Run, pass.**

- [ ] **Step 6: Typecheck.**

- [ ] **Step 7: Commit**

```bash
git add src/workers/procedure-metrics-refresh.ts src/workers/index.ts tests/unit/procedure-metrics-refresh.spec.ts
git commit -m "feat(p3c): worker procedure-metrics-refresh (REFRESH CONCURRENTLY a cada 15min)"
```

---

## Task 11: Integration test end-to-end P3c

**Files:**
- Create: `tests/integration/p3c-procedure-governance.spec.ts`

**Scene:** Cenário completo: criar definition draft → criar 2 tests → tentar promover (falha — não rodou) → rodar tests (1 pass, 1 fail) → tentar promover (falha — tests_not_passing) → corrigir cenário → rodar de novo (both pass) → promover → criar execução real → simular turn com critério llm_judge (mock Haiku) → step avança → abort → events refletem outcome → reaper ignora (já não está in_progress) → metrics view (após refresh manual) registra 1 execução com outcome correto.

Usar mocks pra Anthropic (Haiku) e isolar via tenant 'p3c-integration'.

5 sub-cenários numerados, mesma estrutura dos integration tests anteriores. Cada um termina em `expect`s claros.

### Steps

- [ ] **Step 1: Write scenarios** (mocked end-to-end).

- [ ] **Step 2: Run, iterate** até todos passarem.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/p3c-procedure-governance.spec.ts
git commit -m "test(p3c): integration test governance (5 cenários mocked)"
```

---

## Task 12: Acceptance gates script + runbook + types

**Files:**
- Create: `scripts/p3c-acceptance-gates.sh`
- Create: `docs/runbooks/p3c-procedure-governance.md`

### `scripts/p3c-acceptance-gates.sh`

Checagens (espelhando spec §9 P3c):
1. Migrations 023 + 024 aplicáveis (UP/DOWN).
2. `procedure_metrics` matview existe e responde a `REFRESH CONCURRENTLY`.
3. Promover `proposed → active` SEM tests retorna erro `tests_required`.
4. Worker reaper marca execução com 8d inativa como `abandoned`.
5. Step evaluator suporta os 5 tipos (`machine_check`, `tool_result`, `llm_judge`, `user_signal`, `human_confirmed`).
6. Vitest suite completa passa.
7. Typecheck limpo.

Espelhar formato do `scripts/p3b-acceptance-gates.sh` (set -e, echo seções, contador de gates passados/falhos, exit code).

### `docs/runbooks/p3c-procedure-governance.md`

Seções:
- O que é P3c, escopo, dependências (P3a/P3b)
- Como criar um `procedure_test` (exemplo de scenario JSON)
- Como rodar testes manualmente (`runProcedureTest` em script ad-hoc)
- Como ler `procedure_metrics` (queries de exemplo)
- TTL config (`PROCEDURE_TTL_DAYS`)
- Operações manuais: forçar refresh, listar stale, abortar execução
- Troubleshooting: matview desatualizada, judge timing out, promotion falhando
- Rollback: 024 → 023 (drop matview antes da tabela)

### Steps

- [ ] **Step 1: Write script** seguindo padrão `p3b-acceptance-gates.sh`.

- [ ] **Step 2: Write runbook**.

- [ ] **Step 3: Validate gates script structure** (`bash -n scripts/p3c-acceptance-gates.sh`).

- [ ] **Step 4: Commit**

```bash
git add scripts/p3c-acceptance-gates.sh docs/runbooks/p3c-procedure-governance.md
git commit -m "docs(p3c): acceptance gates script + runbook procedure governance"
```

---

## Acceptance Criteria (P3c done)

Espelhando spec §9 P3c (linhas 591-595):

1. **`procedure_metrics` recalculável do zero** a partir de events. Drop + recreate matview reconstroi métricas inteiras.
2. **`procedure_tests` rodam em CI** antes de promover. `proposed → active` exige `allPassFor(definition_id) === true`.
3. **Worker reaper** força `status=abandoned` após TTL (default 7d).
4. **Step evaluator suporta TODOS os 5 tipos:** `machine_check`, `tool_result`, `llm_judge`, `user_signal`, `human_confirmed`.

**Não bloqueia:** dashboard de métricas UI (P4+), CI hook que executa testes automaticamente em GitHub Actions (operacional, fora de escopo de runtime).

---

## Riscos & Mitigations

| Risco | Mitigação |
|---|---|
| `evaluateCurrentStep` virou async — quebra callers antigos | Task 4 já lista callers a atualizar. Existing tests rodam após cada commit pra catch regressão. |
| `llm_judge` consome tokens em produção | Wrapping com `runCognitiveModule` aplica timeout (5s) + fallback (passed=false). Spec exige judge ser opcional. |
| Matview `REFRESH CONCURRENTLY` falha sem índice único | Já garantido em Task 2 (`procedure_metrics_definition_idx UNIQUE`). |
| Reaper marca execução ativa por engano | Filtro `status='in_progress' AND last_activity_at < cutoff`. Tests cobrem skip de fresh + non-in-progress. |
| Test gate quebra promoção em produção em definitions legadas | Migration zera tests; legacy definitions já `active` não passam por gate. Apenas novas precisam. |

---

## Notas finais

- **Migrations 023 + 024** entram em ordem (`procedure_tests` antes da matview, embora não dependam tecnicamente).
- **NÃO MERGEAR P3c** sem antes ter merged P3a (#83) e P3b (#84) — schema depende.
- **Quando rodar gates:** após P3a/P3b merged + 023/024 aplicadas + matview refresh inicial manual.
