# Maia v2 — P1 Reflexão Expandida + Classifier + Cognitive Wrapper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expandir a reflexão da Maia de correção-only pra 4+1 gatilhos (correção existente + sucesso/conversa-encerrada/padrão/gap-interno), introduzir classificador tipado (6 destinos: fato/regra/procedimento/lacuna/tool_request/descarte), e formalizar módulos cognitivos via `runCognitiveModule()` wrapper com audit/timeout/fallback. Termina com reflexão sobre eventos diversos gerando candidatos auditáveis em `cognitive_candidates`, prontos pra consumo das fases P2-P5.

**Architecture:** Pipeline event-driven: gatilho → `Reflector` (uma call LLM, modelo `reasoning`) → candidato bruto → `Classifier` (uma call LLM, modelo `fast`) → destino tipado. Tudo passa por `runCognitiveModule()` wrapper que registra em `cognitive_module_log` (já ativa em P0). Reflexão existente sobre correção continua funcionando idêntico — agora roteia pelo Runner.

**Tech Stack:** TypeScript, Drizzle ORM (P0 schema), vitest, BullMQ workers, Anthropic SDK (Sonnet + Haiku).

**Reference:** Spec — [docs/superpowers/specs/2026-05-11-maia-v2-cognitive-architecture-design.md](../specs/2026-05-11-maia-v2-cognitive-architecture-design.md) §4.1 (loop de reflexão), §10.1 (CognitiveEventType enum), §9 P1 (acceptance gates).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/types/enums.ts` | Modify | Expand `CognitiveEventType` com 4 novos valores + new `CandidateType` enum |
| `src/cognition/types.ts` | Create | TypeScript types: `CognitiveEvent` (discriminated union), `ClassifiedCandidate` (discriminated union), `RunModuleOptions` |
| `src/cognition/runner.ts` | Create | `runCognitiveModule()` — wrapper com audit + timeout + fallback + cost tracking |
| `src/cognition/reflector.ts` | Create | `reflect(event)` — gera candidato bruto a partir de evento; LLM call (Sonnet) |
| `src/cognition/classifier.ts` | Create | `classify(candidate)` — tipa candidato em 6 destinos via LLM (Haiku) |
| `src/cognition/persister.ts` | Create | `persistCandidate(classified)` — roteamento pra `agent_facts`, `learned_rules`, ou `cognitive_candidates` (queue pra P2+) |
| `migrations/013_p1_cognitive_candidates.sql` | Create | Tabela `cognitive_candidates` (queue pra candidatos sem destino direto ainda) |
| `migrations/013_p1_cognitive_candidates_down.sql` | Create | Rollback |
| `src/db/schema.ts` | Modify | Adicionar `cognitive_candidates` pgTable |
| `src/db/repositories.ts` | Modify | Adicionar `cognitiveCandidatesRepo` |
| `src/agent/reflection.ts` | Modify | Refactor `reflectOnCorrection` → roteia pelo Runner; preserva behavior |
| `src/agent/success-detector.ts` | Create | Detector de sucesso explícito em mensagens (regex + LLM-as-judge no ambíguo) |
| `src/agent/gap-detector.ts` | Create | Detector de auto-reconhecimento de lacuna no ReAct loop |
| `src/workers/reflection-batch.ts` | (no-op em P1) | Continua processando correções como hoje; novos triggers vão pelos seus próprios paths. Listed pra clareza. |
| `src/workers/conversation-summarizer.ts` | Modify | Disparar evento `conversation_closed` ao fechar conversa |
| `src/workers/pattern-detector.ts` | Create | Worker batch — detecta padrões repetidos em audit_log |
| `tests/unit/cognition-runner.spec.ts` | Create | Testa runner: success/timeout/fallback/audit |
| `tests/unit/cognition-classifier.spec.ts` | Create | Testa classifier mock — cada tipo de candidato |
| `tests/unit/success-detector.spec.ts` | Create | Testa regex + heurística do success detector |
| `tests/integration/p1-reflection-expansion.spec.ts` | Create | Integration: 4 triggers → 4 candidatos → 4 destinos |

---

## Task 1: Expandir `CognitiveEventType` + criar `CandidateType` enum

**Files:** `src/types/enums.ts` (modify)

- [ ] **Step 1: Expandir enums**

Em `src/types/enums.ts`, adicionar valores ao `CognitiveEventType` e criar `CandidateType`:

```typescript
export const CognitiveEventType = {
  USER_CORRECTION: 'user_correction',         // existente (P0)
  SUCCESS_EXPLICIT: 'success_explicit',       // P1 NEW
  CONVERSATION_CLOSED: 'conversation_closed', // P1 NEW
  PATTERN_DETECTED: 'pattern_detected',       // P1 NEW
  INTERNAL_GAP: 'internal_gap',               // P1 NEW
} as const;
export type CognitiveEventType = typeof CognitiveEventType[keyof typeof CognitiveEventType];

export const CandidateType = {
  FATO: 'fato',
  REGRA: 'regra',
  PROCEDIMENTO: 'procedimento',
  LACUNA: 'lacuna',
  TOOL_REQUEST: 'tool_request',
  DESCARTE: 'descarte',
} as const;
export type CandidateType = typeof CandidateType[keyof typeof CandidateType];
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/types/enums.ts
git commit -m "feat(p1): CognitiveEventType +4 triggers; CandidateType enum (6 destinos)"
```

---

## Task 2: Criar types core de cognition

**Files:** `src/cognition/types.ts` (create)

- [ ] **Step 1: Criar types.ts**

```typescript
import type { CognitiveEventType, CandidateType } from '@/types/enums.js';

/** Evento que dispara reflexão. Discriminated union por type. */
export type CognitiveEvent =
  | UserCorrectionEvent
  | SuccessExplicitEvent
  | ConversationClosedEvent
  | PatternDetectedEvent
  | InternalGapEvent;

export type UserCorrectionEvent = {
  type: typeof CognitiveEventType.USER_CORRECTION;
  conversa_id: string;
  inbound_mensagem_id: string;
  previous_assistant_mensagem_id: string;
  correction_text: string;
  previous_response_text: string;
};

export type SuccessExplicitEvent = {
  type: typeof CognitiveEventType.SUCCESS_EXPLICIT;
  conversa_id: string;
  inbound_mensagem_id: string;
  signal: string; // ex: "perfeito", "obrigado", "fechou"
  context_summary: string;
};

export type ConversationClosedEvent = {
  type: typeof CognitiveEventType.CONVERSATION_CLOSED;
  conversa_id: string;
  transcript: string;
  summary: string;
  duration_minutes: number;
};

export type PatternDetectedEvent = {
  type: typeof CognitiveEventType.PATTERN_DETECTED;
  pattern_descriptor: string;
  evidence_count: number;
  evidence_ids: string[];
};

export type InternalGapEvent = {
  type: typeof CognitiveEventType.INTERNAL_GAP;
  conversa_id: string;
  inbound_mensagem_id: string;
  gap_description: string;
  attempted_response: string;
};

/** Candidato classificado. Discriminated union por type. */
export type ClassifiedCandidate =
  | FatoCandidate
  | RegraCandidate
  | ProcedimentoCandidate
  | LacunaCandidate
  | ToolRequestCandidate
  | DescarteCandidate;

export type FatoCandidate = {
  type: typeof CandidateType.FATO;
  content: string;
  scope: 'agent' | 'role' | 'conversation';
  subject_id?: string;
};

export type RegraCandidate = {
  type: typeof CandidateType.REGRA;
  contexto: string;
  acao: string;
  tipo: 'classificacao' | 'identificacao_entidade' | 'tom_resposta' | 'recorrencia';
  confianca: number; // 0..1
};

export type ProcedimentoCandidate = {
  type: typeof CandidateType.PROCEDIMENTO;
  nome: string;
  intencao: string;
  passos_draft: string[]; // texto livre, será estruturado em P3
};

export type LacunaCandidate = {
  type: typeof CandidateType.LACUNA;
  capability_description: string;
  tipo: 'tool' | 'knowledge' | 'procedure';
  contexto: string;
};

export type ToolRequestCandidate = {
  type: typeof CandidateType.TOOL_REQUEST;
  tool_name_sketch: string;
  description: string;
  inputs_sketch: string;
  outputs_sketch: string;
};

export type DescarteCandidate = {
  type: typeof CandidateType.DESCARTE;
  reason: string;
};

/** Opções de runCognitiveModule. */
export type RunModuleOptions<TOut> = {
  name: string;
  version?: string;
  triggered_by: 'sync_required' | 'sync_conditional' | 'async_event';
  timeoutMs?: number;
  fallback?: TOut | (() => TOut);
  conversa_id?: string;
  turno_id?: string;
  audit?: boolean; // default true
};

export type RunModuleResult<TOut> = {
  output: TOut | null;
  status: 'success' | 'timeout' | 'error' | 'skipped';
  fallback_triggered: boolean;
  latency_ms: number;
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/cognition/types.ts
git commit -m "feat(p1): types core de cognition (CognitiveEvent, ClassifiedCandidate, RunModuleOptions)"
```

---

## Task 3: `runCognitiveModule()` wrapper (TDD)

**Files:** `src/cognition/runner.ts` (create), `tests/unit/cognition-runner.spec.ts` (create)

- [ ] **Step 1: Escrever testes**

Em `tests/unit/cognition-runner.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCognitiveModule } from '@/cognition/runner.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Mock cognitiveModuleLogRepo
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
    },
  };
});

describe('runCognitiveModule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('execução normal: retorna output + status=success + audit log', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.module', triggered_by: 'sync_required' },
        async () => 'hello',
      );
      expect(result.output).toBe('hello');
      expect(result.status).toBe('success');
      expect(result.fallback_triggered).toBe(false);
    });
  });

  it('timeout: retorna fallback + status=timeout', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.slow', triggered_by: 'sync_conditional', timeoutMs: 50, fallback: 'fb' },
        async () => new Promise((r) => setTimeout(() => r('slow'), 200)),
      );
      expect(result.output).toBe('fb');
      expect(result.status).toBe('timeout');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('erro do módulo: retorna fallback + status=error', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom', triggered_by: 'async_event', fallback: null },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
      expect(result.fallback_triggered).toBe(true);
    });
  });

  it('sem fallback + erro: output null mas não throw', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runCognitiveModule(
        { name: 'test.boom2', triggered_by: 'async_event' },
        async () => { throw new Error('boom'); },
      );
      expect(result.output).toBeNull();
      expect(result.status).toBe('error');
    });
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `npx vitest tests/unit/cognition-runner.spec.ts`
Expected: FAIL (module não existe).

- [ ] **Step 3: Implementar**

Em `src/cognition/runner.ts`:

```typescript
import type { RunModuleOptions, RunModuleResult } from './types.js';
import { cognitiveModuleLogRepo } from '@/db/repositories.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';

export async function runCognitiveModule<TOut>(
  opts: RunModuleOptions<TOut>,
  fn: () => Promise<TOut>,
): Promise<RunModuleResult<TOut>> {
  const startTime = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const audit = opts.audit ?? true;
  let status: RunModuleResult<TOut>['status'] = 'success';
  let output: TOut | null = null;
  let fallback_triggered = false;
  let error_message: string | undefined;

  try {
    output = await Promise.race([
      fn(),
      new Promise<TOut>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);
  } catch (err) {
    const e = err as Error;
    error_message = e.message;
    status = e.message === 'timeout' ? 'timeout' : 'error';
    fallback_triggered = true;
    if (opts.fallback !== undefined) {
      output = typeof opts.fallback === 'function'
        ? (opts.fallback as () => TOut)()
        : opts.fallback;
    } else {
      output = null;
    }
  }

  const latency_ms = Date.now() - startTime;

  if (audit) {
    const ctx = tryGetCurrentContext();
    try {
      await cognitiveModuleLogRepo.record({
        tenant_id: ctx?.tenant_id ?? 'default',
        agent_id: ctx?.agent_id ?? 'default',
        conversa_id: opts.conversa_id ?? null,
        turno_id: opts.turno_id ?? null,
        module_name: opts.name,
        module_version: opts.version ?? 'v1',
        prompt_version: null,
        triggered_by: opts.triggered_by,
        started_at: new Date(startTime),
        ended_at: new Date(),
        latency_ms,
        model_used: null,
        tokens_in: null,
        tokens_out: null,
        cost_estimate: null,
        output_summary_hash: null,
        confidence: null,
        fallback_triggered,
        fallback_reason: error_message ?? null,
        status,
        metadata: {},
      });
    } catch (logErr) {
      logger.warn({ err: (logErr as Error).message, module: opts.name }, 'runner.audit_failed');
    }
  }

  return { output, status, fallback_triggered, latency_ms };
}
```

- [ ] **Step 4: Rodar — deve passar**

Run: `npx vitest tests/unit/cognition-runner.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/cognition/runner.ts tests/unit/cognition-runner.spec.ts
git commit -m "feat(p1): runCognitiveModule wrapper (audit + timeout + fallback)"
```

---

## Task 4: Migration `cognitive_candidates` (queue pra candidatos sem destino direto)

**Files:** `migrations/013_p1_cognitive_candidates.sql` (create), `013_p1_cognitive_candidates_down.sql` (create), `src/db/schema.ts` (modify)

- [ ] **Step 1: Criar migration up**

```sql
-- P1: queue pra candidatos classificados que ainda não têm destino dedicado (procedimento, lacuna, tool_request)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE cognitive_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  source_event_type TEXT NOT NULL,
  source_event_id UUID,
  candidate_type TEXT NOT NULL CHECK (
    candidate_type IN ('procedimento', 'lacuna', 'tool_request')
  ),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'consumed', 'rejected', 'expired')
  ),
  consumed_by_phase TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cognitive_candidates_tenant_agent_status_idx
  ON cognitive_candidates(tenant_id, agent_id, status, created_at DESC);
CREATE INDEX cognitive_candidates_type_status_idx
  ON cognitive_candidates(candidate_type, status);
```

- [ ] **Step 2: Migration down**

```sql
DROP TABLE IF EXISTS cognitive_candidates CASCADE;
```

- [ ] **Step 3: Drizzle schema**

Em `src/db/schema.ts`:

```typescript
export const cognitive_candidates = pgTable(
  'cognitive_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    source_event_type: text('source_event_type').notNull(),
    source_event_id: uuid('source_event_id'),
    candidate_type: text('candidate_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    consumed_by_phase: text('consumed_by_phase'),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('cognitive_candidates_tenant_agent_status_idx').on(
      t.tenant_id, t.agent_id, t.status, t.created_at,
    ),
    typeStatusIdx: index('cognitive_candidates_type_status_idx').on(t.candidate_type, t.status),
  }),
);

export type CognitiveCandidate = typeof cognitive_candidates.$inferSelect;
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add migrations/013_p1_cognitive_candidates.sql migrations/013_p1_cognitive_candidates_down.sql src/db/schema.ts
git commit -m "feat(p1): tabela cognitive_candidates (queue pra candidatos sem destino direto)"
```

---

## Task 5: `cognitiveCandidatesRepo`

**Files:** `src/db/repositories.ts` (modify)

- [ ] **Step 1: Add repo**

```typescript
import { cognitive_candidates, type CognitiveCandidate } from './schema.js';
import { applyTenantGuard } from './tenant-guard.js';

export const cognitiveCandidatesRepo = {
  async create(
    input: Omit<CognitiveCandidate, 'id' | 'created_at' | 'tenant_id' | 'agent_id' | 'status' | 'consumed_by_phase' | 'consumed_at'>,
  ): Promise<CognitiveCandidate> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(cognitive_candidates).values(guarded).returning();
    return row!;
  },

  async listPending(candidate_type?: string, limit = 100): Promise<CognitiveCandidate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conditions = [
      eq(cognitive_candidates.tenant_id, tenant_id),
      eq(cognitive_candidates.agent_id, agent_id),
      eq(cognitive_candidates.status, 'pending'),
    ];
    if (candidate_type) conditions.push(eq(cognitive_candidates.candidate_type, candidate_type));
    return db
      .select()
      .from(cognitive_candidates)
      .where(and(...conditions))
      .orderBy(desc(cognitive_candidates.created_at))
      .limit(limit);
  },

  async markConsumed(id: string, phase: string): Promise<void> {
    await db
      .update(cognitive_candidates)
      .set({ status: 'consumed', consumed_by_phase: phase, consumed_at: new Date() })
      .where(eq(cognitive_candidates.id, id));
  },
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/db/repositories.ts
git commit -m "feat(p1): cognitiveCandidatesRepo"
```

---

## Task 6: Reflector module

**Files:** `src/cognition/reflector.ts` (create)

- [ ] **Step 1: Implementar Reflector**

```typescript
import type { CognitiveEvent } from './types.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

/**
 * Reflector — gera candidato bruto (texto livre) a partir de evento cognitivo.
 * Saída é um insight não-tipado que será classificado pelo Classifier.
 */
export async function reflect(
  event: CognitiveEvent,
): Promise<{ insight: string; tokens_in?: number; tokens_out?: number } | null> {
  const systemPrompt = buildSystemForEvent(event);
  const userPrompt = buildUserForEvent(event);

  const result = await runCognitiveModule(
    {
      name: `reflector.${event.type}`,
      triggered_by: event.type === 'user_correction' || event.type === 'internal_gap'
        ? 'sync_conditional'
        : 'async_event',
      conversa_id: 'conversa_id' in event ? event.conversa_id : undefined,
      timeoutMs: 10000,
    },
    async () => {
      const res = await callLLM({
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 500,
        temperature: 0.2,
      });
      return {
        insight: res.content?.trim() ?? '',
        tokens_in: res.usage?.input_tokens,
        tokens_out: res.usage?.output_tokens,
      };
    },
  );

  return result.output;
}

function buildSystemForEvent(event: CognitiveEvent): string {
  const base = `Você é o Reflector da Maia. Ao receber um evento cognitivo, produza um insight em texto livre que será classificado depois. Seja preciso, sem inventar. Se não há insight útil, diga "DESCARTE: <motivo>".`;
  // type-specific guidance
  switch (event.type) {
    case 'user_correction':
      return `${base}\n\nFoco: o que essa correção te ensina sobre como evitar o mesmo erro?`;
    case 'success_explicit':
      return `${base}\n\nFoco: que padrão dessa interação merece reforço pra próximas vezes?`;
    case 'conversation_closed':
      return `${base}\n\nFoco: que aprendizado essa conversa inteira deixa? Pode ser um fato sobre o interlocutor, um procedimento que emergiu, ou uma lacuna identificada.`;
    case 'pattern_detected':
      return `${base}\n\nFoco: como esse padrão repetido deve ser tratado daqui pra frente? Vira regra, procedimento, ou pede capacidade nova?`;
    case 'internal_gap':
      return `${base}\n\nFoco: identifique a capacidade faltante. Que tool, conhecimento ou procedimento te faltou pra responder bem?`;
  }
}

function buildUserForEvent(event: CognitiveEvent): string {
  return JSON.stringify(event, null, 2);
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/cognition/reflector.ts
git commit -m "feat(p1): Reflector module (gera insight bruto por evento, via runCognitiveModule)"
```

---

## Task 7: Classifier module (TDD)

**Files:** `src/cognition/classifier.ts` (create), `tests/unit/cognition-classifier.spec.ts` (create)

- [ ] **Step 1: Escrever testes** (mock o LLM call)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { classify } from '@/cognition/classifier.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async ({ messages }) => {
    const user = messages[0].content as string;
    // simula classificador retornando JSON baseado em keyword
    if (user.includes('FATO_X')) return { content: JSON.stringify({ type: 'fato', content: 'X', scope: 'agent' }) };
    if (user.includes('REGRA_X')) return { content: JSON.stringify({ type: 'regra', contexto: 'X', acao: 'Y', tipo: 'classificacao', confianca: 0.7 }) };
    if (user.includes('LACUNA_X')) return { content: JSON.stringify({ type: 'lacuna', capability_description: 'X', tipo: 'tool', contexto: 'Y' }) };
    if (user.includes('DESCARTE_X')) return { content: JSON.stringify({ type: 'descarte', reason: 'irrelevant' }) };
    return { content: JSON.stringify({ type: 'descarte', reason: 'fallback' }) };
  }),
}));

describe('classify', () => {
  it('classifica como fato', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('FATO_X: cliente prefere matutino');
      expect(r?.type).toBe('fato');
    });
  });

  it('classifica como regra', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('REGRA_X: se ver X, faça Y');
      expect(r?.type).toBe('regra');
    });
  });

  it('classifica como lacuna', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('LACUNA_X: faltou tool');
      expect(r?.type).toBe('lacuna');
    });
  });

  it('classifica como descarte', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('DESCARTE_X: ruído');
      expect(r?.type).toBe('descarte');
    });
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

- [ ] **Step 3: Implementar**

Em `src/cognition/classifier.ts`:

```typescript
import { z } from 'zod';
import type { ClassifiedCandidate } from './types.js';
import { callLLM } from '@/lib/claude.js';
import { runCognitiveModule } from './runner.js';

const ClassifiedSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fato'), content: z.string(), scope: z.enum(['agent', 'role', 'conversation']), subject_id: z.string().optional() }),
  z.object({ type: z.literal('regra'), contexto: z.string(), acao: z.string(), tipo: z.enum(['classificacao', 'identificacao_entidade', 'tom_resposta', 'recorrencia']), confianca: z.number() }),
  z.object({ type: z.literal('procedimento'), nome: z.string(), intencao: z.string(), passos_draft: z.array(z.string()) }),
  z.object({ type: z.literal('lacuna'), capability_description: z.string(), tipo: z.enum(['tool', 'knowledge', 'procedure']), contexto: z.string() }),
  z.object({ type: z.literal('tool_request'), tool_name_sketch: z.string(), description: z.string(), inputs_sketch: z.string(), outputs_sketch: z.string() }),
  z.object({ type: z.literal('descarte'), reason: z.string() }),
]);

export async function classify(insight: string): Promise<ClassifiedCandidate | null> {
  const result = await runCognitiveModule(
    { name: 'classifier', triggered_by: 'async_event', timeoutMs: 8000 },
    async () => {
      const res = await callLLM({
        system: classifierSystemPrompt(),
        messages: [{ role: 'user', content: insight }],
        max_tokens: 400,
        temperature: 0.0,
      });
      const text = (res.content ?? '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = ClassifiedSchema.safeParse(JSON.parse(match[0]));
      return parsed.success ? parsed.data : null;
    },
  );
  return result.output;
}

function classifierSystemPrompt(): string {
  return `Você é o Classifier. Recebe um insight (texto livre) e o tipa em um dos 6 destinos:
- fato: informação sobre o mundo/interlocutor
- regra: se-contexto-então-ação atômico
- procedimento: como-fazer multi-passo
- lacuna: capacidade faltante (tool/knowledge/procedure)
- tool_request: proposta de tool específica
- descarte: ruído, não útil

Retorne APENAS JSON conforme schema:
- fato: { type, content, scope: 'agent'|'role'|'conversation', subject_id? }
- regra: { type, contexto, acao, tipo: 'classificacao'|'identificacao_entidade'|'tom_resposta'|'recorrencia', confianca: 0..1 }
- procedimento: { type, nome, intencao, passos_draft: string[] }
- lacuna: { type, capability_description, tipo: 'tool'|'knowledge'|'procedure', contexto }
- tool_request: { type, tool_name_sketch, description, inputs_sketch, outputs_sketch }
- descarte: { type, reason }

Na dúvida, prefira descarte. Não invente conteúdo.`;
}
```

- [ ] **Step 4: Rodar — deve passar**

Run: `npx vitest tests/unit/cognition-classifier.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/cognition/classifier.ts tests/unit/cognition-classifier.spec.ts
git commit -m "feat(p1): Classifier module (tipa candidato em 6 destinos com zod)"
```

---

## Task 8: Persister — roteia candidato pro destino

**Files:** `src/cognition/persister.ts` (create)

- [ ] **Step 1: Implementar**

```typescript
import type { ClassifiedCandidate, CognitiveEvent } from './types.js';
import { factsRepo, rulesRepo, cognitiveCandidatesRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';

/**
 * Persister — roteia ClassifiedCandidate pro destino apropriado.
 * Fases atuais (P1):
 *   - fato → agent_facts (existente)
 *   - regra → learned_rules (existente)
 *   - procedimento, lacuna, tool_request → cognitive_candidates (queue pra P2-P5)
 *   - descarte → log apenas
 */
export async function persistCandidate(
  candidate: ClassifiedCandidate,
  event: CognitiveEvent,
): Promise<{ persisted_to: string; id?: string }> {
  switch (candidate.type) {
    case 'fato': {
      const fact = await factsRepo.upsert({
        chave: hashKey(candidate.content),
        valor: candidate.content,
        escopo: candidate.scope === 'agent' ? 'global' : candidate.scope,
        confianca: '0.50',
      });
      return { persisted_to: 'agent_facts', id: fact?.id };
    }
    case 'regra': {
      const rule = await rulesRepo.create({
        tipo: candidate.tipo,
        contexto: candidate.contexto,
        acao: candidate.acao,
        contexto_jsonb: {},
        acoes_jsonb: {},
        confianca: String(candidate.confianca.toFixed(2)),
      });
      return { persisted_to: 'learned_rules', id: rule?.id };
    }
    case 'procedimento':
    case 'lacuna':
    case 'tool_request': {
      const row = await cognitiveCandidatesRepo.create({
        conversa_id: 'conversa_id' in event ? event.conversa_id : null,
        source_event_type: event.type,
        source_event_id: null,
        candidate_type: candidate.type,
        payload: candidate as Record<string, unknown>,
      });
      return { persisted_to: 'cognitive_candidates', id: row.id };
    }
    case 'descarte': {
      logger.info({ reason: candidate.reason, event_type: event.type }, 'persister.discarded');
      return { persisted_to: 'log_only' };
    }
  }
}

function hashKey(content: string): string {
  // chave determinística pra upsert idempotente
  const slug = content.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
  return `p1.${slug}`;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/cognition/persister.ts
git commit -m "feat(p1): Persister roteia candidato pro destino (facts/rules/candidates queue)"
```

---

## Task 9: Refactor `reflection.ts` pra usar Reflector + Classifier + Persister

**Files:** `src/agent/reflection.ts` (modify)

- [ ] **Step 1: Refactor mantendo behavior atual**

A função `reflectOnCorrection` continua existindo (assinatura e behavior idênticos), mas internamente usa o pipeline novo:

```typescript
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';

// dentro de reflectOnCorrection:
const event = {
  type: CognitiveEventType.USER_CORRECTION,
  conversa_id: input.conversa.id,
  inbound_mensagem_id: input.inbound.id,
  previous_assistant_mensagem_id: input.previousAssistant.id,
  correction_text: input.inbound.conteudo ?? '',
  previous_response_text: input.previousAssistant.conteudo ?? '',
} as const;

const reflected = await reflect(event);
if (!reflected) return;

const classified = await classify(reflected.insight);
if (!classified) return;

await persistCandidate(classified, event);
```

**Preservar:** o audit `audit('rule_created', ...)` quando classified.type === 'regra' (compat com auditoria existente).

- [ ] **Step 2: Verificar testes existentes ainda passam**

```bash
npm test
```
Expected: 578+ pass (sem regressão).

- [ ] **Step 3: Commit**

```bash
git add src/agent/reflection.ts
git commit -m "refactor(p1): reflectOnCorrection roteia pelo Reflector→Classifier→Persister"
```

---

## Task 10: Success detector + wire em mensagem inbound

**Files:** `src/agent/success-detector.ts` (create), `tests/unit/success-detector.spec.ts` (create), `src/agent/core.ts` (modify)

- [ ] **Step 1: Testes**

```typescript
import { describe, it, expect } from 'vitest';
import { detectSuccess } from '@/agent/success-detector.js';

describe('detectSuccess', () => {
  it('detecta sinais positivos óbvios', () => {
    expect(detectSuccess('perfeito, obrigado!')).toBe(true);
    expect(detectSuccess('exatamente isso')).toBe(true);
    expect(detectSuccess('fechou!')).toBe(true);
    expect(detectSuccess('ok pode mandar')).toBe(true);
  });

  it('não detecta sinais neutros', () => {
    expect(detectSuccess('ok')).toBe(false); // único 'ok' é ambíguo
    expect(detectSuccess('entendi')).toBe(false);
    expect(detectSuccess('me explica de novo')).toBe(false);
  });

  it('não detecta correções', () => {
    expect(detectSuccess('não, errado')).toBe(false);
    expect(detectSuccess('isso tá errado')).toBe(false);
  });
});
```

- [ ] **Step 2: Implementar**

```typescript
import { stripDiacritics } from '@/lib/utils.js';

const SUCCESS_PATTERNS = [
  /\bperfeito\b/i,
  /\bexatamente\b/i,
  /\bfechou\b/i,
  /\bcerto\b.*\b(sim|isso)\b/i,
  /\bobrigado\b/i,
  /\bok\b.*\b(pode|mandar|seguir|fechou)\b/i,
  /\bisso\s*(mesmo|ai)\b/i,
];

const CORRECTION_OVERRIDE = [/\bn[ãa]o\b/i, /\berrad/i, /\bcorrige/i];

export function detectSuccess(message: string): boolean {
  if (CORRECTION_OVERRIDE.some((re) => re.test(message))) return false;
  const normalized = stripDiacritics(message.toLowerCase().trim());
  return SUCCESS_PATTERNS.some((re) => re.test(normalized));
}
```

- [ ] **Step 3: Wire em `runAgentForMensagem`**

Em `src/agent/core.ts`, após receber mensagem e ANTES de gerar resposta (ou em paralelo), checar sucesso e disparar reflexão async:

```typescript
import { detectSuccess } from './success-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';

// dentro de runAgentForMensagem (dentro de runWithTenantContext):
if (inbound.conteudo && detectSuccess(inbound.conteudo)) {
  // fire-and-forget — reflection roda em background
  (async () => {
    const event = {
      type: CognitiveEventType.SUCCESS_EXPLICIT,
      conversa_id: conversa.id,
      inbound_mensagem_id: inbound.id,
      signal: inbound.conteudo!,
      context_summary: '', // simplificado; pode ser melhorado depois
    } as const;
    const reflected = await reflect(event);
    if (!reflected) return;
    const classified = await classify(reflected.insight);
    if (!classified) return;
    await persistCandidate(classified, event);
  })().catch((err) => logger.warn({ err: (err as Error).message }, 'success.reflection.failed'));
}
```

- [ ] **Step 4: tsc + tests + commit**

```bash
npx tsc --noEmit
npx vitest tests/unit/success-detector.spec.ts
git add src/agent/success-detector.ts tests/unit/success-detector.spec.ts src/agent/core.ts
git commit -m "feat(p1): success detector + trigger SUCCESS_EXPLICIT reflection"
```

---

## Task 11: Wire `conversation_closed` no summarizer

**Files:** `src/workers/conversation-summarizer.ts` (modify)

- [ ] **Step 1: Dispatch evento ao final do summarize**

Em `runConversationSummarizer`, após `conversasRepo.close(c.id, summary)`, disparar reflexão:

```typescript
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';

// após close:
const event = {
  type: CognitiveEventType.CONVERSATION_CLOSED,
  conversa_id: c.id,
  transcript,
  summary,
  duration_minutes: 0, // ou calcular se houver timestamps
} as const;
const reflected = await reflect(event);
if (reflected) {
  const classified = await classify(reflected.insight);
  if (classified) {
    await persistCandidate(classified, event);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workers/conversation-summarizer.ts
git commit -m "feat(p1): trigger CONVERSATION_CLOSED no summarizer worker"
```

---

## Task 12: Worker `pattern-detector` (batch diário)

**Files:** `src/workers/pattern-detector.ts` (create), `src/workers/index.ts` (modify — registrar cron)

- [ ] **Step 1: Implementar worker**

```typescript
import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import { sql } from 'drizzle-orm';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';

const MIN_OCCURRENCES = 3;

/**
 * Detecta padrões repetidos em audit_log nas últimas 24h.
 * Atualmente: ações com mesma `acao` que repetiram ≥ MIN_OCCURRENCES vezes
 * pra mesma `alvo_id` ou conta.
 */
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runPatternDetector(): Promise<void> {
  // P0-era single-tenant shim: pattern detection roda em escopo do tenant 'default'.
  // P6 introduz iteração por tenant (encapsular esse corpo num for-each tenant).
  // IMPORTANTE: pattern queries são tenant-scoped (audit_log é multi-tenant pós-P0).
  await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
    const rows = await db.execute<{ pattern: string; count: number; alvo_ids: string[] }>(sql`
      SELECT 
        acao || '|' || COALESCE((metadata->>'descricao'), '') AS pattern,
        count(*) AS count,
        array_agg(DISTINCT alvo_id::text) FILTER (WHERE alvo_id IS NOT NULL) AS alvo_ids
      FROM ${audit_log}
      WHERE tenant_id = 'default'
        AND agent_id = 'default'
        AND created_at >= now() - interval '24 hours'
      GROUP BY pattern
      HAVING count(*) >= ${MIN_OCCURRENCES}
      ORDER BY count DESC
      LIMIT 20
    `);

    for (const r of rows.rows as Array<{ pattern: string; count: number; alvo_ids: string[] }>) {
      const event = {
        type: CognitiveEventType.PATTERN_DETECTED,
        pattern_descriptor: r.pattern,
        evidence_count: r.count,
        evidence_ids: r.alvo_ids ?? [],
      } as const;
      try {
        const reflected = await reflect(event);
        if (!reflected) continue;
        const classified = await classify(reflected.insight);
        if (!classified) continue;
        await persistCandidate(classified, event);
      } catch (err) {
        logger.warn({ err: (err as Error).message, pattern: r.pattern }, 'pattern_detector.failed');
      }
    }
  });
}
```

- [ ] **Step 2: Registrar no cron**

Em `src/workers/index.ts`, adicionar entrada no `JOBS` (seguir padrão de outros workers).

- [ ] **Step 3: Commit**

```bash
git add src/workers/pattern-detector.ts src/workers/index.ts
git commit -m "feat(p1): worker pattern-detector (batch diário detecta padrões em audit_log)"
```

---

## Task 13: Gap detector — auto-reconhecimento de lacuna no ReAct loop

**Files:** `src/agent/gap-detector.ts` (create), `src/agent/react-loop.ts` (modify)

- [ ] **Step 1: Implementar detector**

```typescript
/**
 * Detecta auto-reconhecimento de lacuna na resposta do ReAct.
 * Frases típicas: "não sei isso", "preciso verificar", "não tenho como X agora".
 * Trigger pra INTERNAL_GAP event.
 */
const GAP_SIGNALS = [
  /\bn[ãa]o\s+(sei|tenho|consigo)\b/i,
  /\bprecisaria\s+(de|verificar)\b/i,
  /\bnão\s+tenho\s+como\b/i,
  /\bsem\s+acesso\s+a\b/i,
  /\bme\s+falta\b/i,
];

export function detectGap(responseText: string): { detected: boolean; signal?: string } {
  for (const re of GAP_SIGNALS) {
    const m = responseText.match(re);
    if (m) return { detected: true, signal: m[0] };
  }
  return { detected: false };
}
```

- [ ] **Step 2: Wire em react-loop**

Após resposta final gerada em `react-loop.ts`, checar gap. Se detectado, fire reflection async (igual success).

- [ ] **Step 3: Commit**

```bash
git add src/agent/gap-detector.ts src/agent/react-loop.ts
git commit -m "feat(p1): gap detector + trigger INTERNAL_GAP no ReAct loop"
```

---

## Task 14: Integration test — 4 triggers → 4 candidatos → destinos

**Files:** `tests/integration/p1-reflection-expansion.spec.ts` (create)

- [ ] **Step 1: Escrever teste de integração**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { CognitiveEventType } from '@/types/enums.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { db } from '@/db/client.js';
import { cognitive_candidates } from '@/db/schema.js';
import { eq } from 'drizzle-orm';

// Mock callLLM pra retornar respostas determinísticas por evento
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async ({ system }) => {
    if (system.includes('SUCCESS')) return { content: 'aprendizado de sucesso aqui' };
    if (system.includes('PATTERN')) return { content: 'lacuna identificada: precisa tool X' };
    // classifier path
    return { content: JSON.stringify({ type: 'descarte', reason: 'mock' }) };
  }),
}));

describe('P1 reflection expansion integration (DB-dependent)', () => {
  it('CONVERSATION_CLOSED → reflect → classify → persist (descarte)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.CONVERSATION_CLOSED,
        conversa_id: '00000000-0000-0000-0000-000000000000',
        transcript: 'oi\ntudo bem',
        summary: 'small talk',
        duration_minutes: 2,
      } as const;
      const reflected = await reflect(event);
      if (!reflected) return;
      const classified = await classify(reflected.insight);
      expect(classified?.type).toBe('descarte');
    });
  });

  // Adicionar testes pros 3 outros triggers (success/pattern/internal_gap)
  // Cada um exercita o pipeline completo
});
```

- [ ] **Step 2: SKIP DB run** (sem DB local) e commit

```bash
git add tests/integration/p1-reflection-expansion.spec.ts
git commit -m "test(p1): integration test 4 triggers → pipeline completo"
```

---

## Task 15: Acceptance gates P1

**Files:** `scripts/p1-acceptance-gates.sh` (create), `docs/runbooks/p1-reflection.md` (create)

### Code-level gates executados agora

- [ ] Gate A: enums expandidos
```bash
grep -E "SUCCESS_EXPLICIT|CONVERSATION_CLOSED|PATTERN_DETECTED|INTERNAL_GAP" src/types/enums.ts
```
Expected: 4 valores.

- [ ] Gate B: runCognitiveModule tests
```bash
npx vitest tests/unit/cognition-runner.spec.ts
```
Expected: PASS (4/4).

- [ ] Gate C: classifier tests
```bash
npx vitest tests/unit/cognition-classifier.spec.ts
```
Expected: PASS (4/4).

- [ ] Gate D: success-detector tests
```bash
npx vitest tests/unit/success-detector.spec.ts
```
Expected: PASS.

- [ ] Gate E: production build
```bash
npm run build
```
Expected: clean.

### DB-dependent gates (script)

Criar `scripts/p1-acceptance-gates.sh` análogo ao do P0, cobrindo:
- Migration 013 aplicada
- `cognitive_candidates` aceita inserts
- Integration test passa
- `cognitive_module_log` registra execuções dos 4 novos triggers

### Runbook P1

`docs/runbooks/p1-reflection.md` documenta:
- Como debugar reflexão (logs em cognitive_module_log)
- Como inspecionar candidates pendentes
- Como expandir triggers no futuro
- Quando classifier falha (descarte vs erro)

- [ ] **Commit + abertura de PR**

```bash
git add scripts/p1-acceptance-gates.sh docs/runbooks/p1-reflection.md
git commit -m "docs(p1): acceptance gates script + runbook reflexão"
git push origin HEAD
gh pr create --title "feat(p1): Maia v2 — Reflexão expandida + Classifier" --body "..."
```

---

## P1 Acceptance: o que está provado ao final

1. ✅ 4 novos triggers cognitivos disparam reflexão (success/conversation_closed/pattern/gap)
2. ✅ Classifier tipa output em 6 destinos com schema zod
3. ✅ runCognitiveModule wrapper aplicado em Reflector e Classifier
4. ✅ cognitive_module_log registra todas as execuções
5. ✅ Correção (P0) continua funcionando idêntico — agora rota pelo pipeline novo
6. ✅ `cognitive_candidates` queue pronta pra P2-P5 consumirem (procedimento/lacuna/tool_request)
7. ✅ Pattern detector worker em produção (cron diário)
8. ✅ Integration tests cobrem pipeline ponta-a-ponta

## O que P1 NÃO entrega (vem depois)

- ❌ Memory scoping 6-controles (P2)
- ❌ Self-model com capabilities/gaps via classifier (P2 consome cognitive_candidates de tipo 'lacuna')
- ❌ Procedures executáveis (P3 consome 'procedimento')
- ❌ Capability acquisition workflow (P5 consome 'tool_request')
- ❌ Identidade operacional versionada (P4)
- ❌ Channel/Role/Policy (P6)
- ❌ Grafo cognitivo formal (P7)
