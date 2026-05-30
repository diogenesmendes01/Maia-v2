/**
 * P3c Task 11 — Integration test end-to-end para a cadeia completa de
 * governança de procedures (P3c).
 *
 * Cobre 5 cenários:
 *   1. draft → proposed OK; proposed → active sem tests falha
 *      (`reason='tests_required'`).
 *   2. com 1 test pass + 1 test fail, proposed → active falha
 *      (`reason='tests_not_passing'`, `failing_tests` populado).
 *   3. todos tests pass → proposed → active sucesso.
 *   4. `runProcedureTest` exercita os 3 novos tipos de criterion em sequência
 *      (llm_judge → user_signal → human_confirmed) e completa com success.
 *   5. `runProcedureExecutionReaper` marca execução stale (8d) como
 *      abandoned/no_response e grava event `auto_abandoned`.
 *
 * Pattern segue tests/integration/p3b-procedure-runtime.spec.ts:
 *   - vi.mock('@/db/repositories.js', ...) com state em Map in-memory
 *   - vi.mock('@anthropic-ai/sdk', ...) para o cenário llm_judge
 *   - Todas as operações dentro de runWithTenantContext
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------- in-memory state ----------
const definitionsState: Record<string, any> = {};
const testsState: Record<string, any> = {};
const execState: Record<string, any> = {};
const events: any[] = [];
const tenantsState: Array<{ id: string; nome: string; status: string }> = [];

// ---------- Anthropic SDK mock (cenário 4: llm_judge) ----------
const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: messagesCreateMock } };
  });
  return { default: Anthropic };
});

// ---------- db/client mock (PR #85 fix P85-I1: reaper uses withTx) ----------
// After round-2 fix, transitionProcedureStatus inlines tx.update() and
// tx.insert() on the tx handle for non-active transitions. The mock provides
// a drizzle-like tx sentinel instead of a bare {} object.
//
// Issue #323 review iteration-2 (BLOCKING — fairness): the reaper's dispatcher
// enumeration changed from `db.selectDistinct(...).from(...).where(...)` to
// `db.select(... MIN(last_activity_at) AS oldest ...).from(...).where(...)
// .groupBy(tenant_id, agent_id).orderBy(oldest ASC)` over STALE in_progress
// rows. This faithful in-memory mirror filters execState by the SAME TTL cutoff
// the worker uses (env PROCEDURE_TTL_DAYS, default 7), groups by (tenant_id,
// agent_id), and orders by each tuple's oldest stale execution ascending — so
// the order the worker iterates is exactly the order the real query yields.
// Tuples whose executions are all fresh do NOT appear (TTL applied in the
// enumeration). Mirrors tests/unit/procedure-execution-reaper.spec.ts.
function enumerateStaleTuplesOrdered(): Array<{ tenant_id: string; agent_id: string }> {
  const ttlDays = Number(process.env.PROCEDURE_TTL_DAYS ?? 7);
  const cutoff = Date.now() - ttlDays * 86_400_000;
  const lastActivityMs = (ex: any): number =>
    ex.last_activity_at instanceof Date
      ? ex.last_activity_at.getTime()
      : new Date(ex.last_activity_at).getTime();
  const oldestByTuple = new Map<
    string,
    { tenant_id: string; agent_id: string; oldest: number }
  >();
  for (const ex of Object.values(execState) as any[]) {
    if (ex.status !== 'in_progress') continue;
    if (lastActivityMs(ex) >= cutoff) continue; // fresh — not stale
    const key = `${ex.tenant_id}|${ex.agent_id}`;
    const ts = lastActivityMs(ex);
    const cur = oldestByTuple.get(key);
    if (!cur) {
      oldestByTuple.set(key, { tenant_id: ex.tenant_id, agent_id: ex.agent_id, oldest: ts });
    } else if (ts < cur.oldest) {
      cur.oldest = ts;
    }
  }
  return [...oldestByTuple.values()]
    .sort((a, b) => a.oldest - b.oldest) // MIN(last_activity_at) ASC — oldest first
    .map(({ tenant_id, agent_id }) => ({ tenant_id, agent_id }));
}

vi.mock('@/db/client.js', () => ({
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: (_table: any) => ({
        set: (patch: any) => ({
          where: (_cond: any) => ({
            returning: () => {
              // Apply patch to all rows in definitionsState (single-row per test)
              const updated: any[] = [];
              for (const [k, v] of Object.entries(definitionsState)) {
                definitionsState[k] = { ...(v as any), ...patch };
                updated.push({ id: k });
              }
              return Promise.resolve(updated);
            },
          }),
        }),
      }),
      insert: (_table: any) => ({
        values: (_vals: any) => Promise.resolve(),
      }),
    };
    return fn(tx as any);
  }),
  // Issue #323 review iteration-2 (BLOCKING — fairness): the reaper now
  // enumerates stale (tenant_id, agent_id) tuples via
  // `db.select(...).from(...).where(...).groupBy(...).orderBy(...)` (oldest
  // stale execution first), NOT the old `selectDistinct(...).from().where()`.
  // Mirror the NEW chain over the in-memory execState so the dispatcher yields
  // the seeded tuples (deduped, oldest-first) before opening per-tuple context.
  // Matches tests/unit/procedure-execution-reaper.spec.ts.
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          groupBy: () => ({
            orderBy: async () => enumerateStaleTuplesOrdered(),
          }),
        }),
      }),
    }),
  },
}));

// ---------- repositories mock ----------
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    procedureDefinitionsRepo: {
      findActiveByName: vi.fn(async (nome: string) => {
        return (
          Object.values(definitionsState).find(
            (d: any) => d.nome === nome && d.status === 'active',
          ) ?? null
        );
      }),
      findById: vi.fn(async (id: string) => definitionsState[id] ?? null),
      updateStatus: vi.fn(async (id: string, updates: any) => {
        if (definitionsState[id]) {
          definitionsState[id] = { ...definitionsState[id], ...updates };
          return 1;
        }
        return 0;
      }),
      create: vi.fn(async (input: any) => {
        const id = `def-${Math.random().toString(36).slice(2)}`;
        definitionsState[id] = { id, ...input };
        return definitionsState[id];
      }),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(definitionsState).filter((d: any) => d.status === status),
      ),
      listAllVersionsByName: vi.fn(async (nome: string) =>
        Object.values(definitionsState).filter((d: any) => d.nome === nome),
      ),
      // P83-C4: atomic activation in a single transaction.
      // Required by procedure-status.ts when transitioning proposed → active.
      atomicActivate: vi.fn(
        async (args: {
          target_id: string;
          actor: string;
          preserve_activated_at?: boolean;
        }) => {
          const target = definitionsState[args.target_id];
          if (!target) throw new Error('not found');
          const now = new Date();
          // Freeze any sibling that is currently active (same nome).
          let deactivated: any = null;
          for (const k of Object.keys(definitionsState)) {
            const row = definitionsState[k];
            if (row.nome === target.nome && row.status === 'active' && row.id !== target.id) {
              definitionsState[k] = { ...row, status: 'frozen', deactivated_at: now };
              if (!deactivated) deactivated = definitionsState[k];
            }
          }
          const fromStatus = target.status;
          const patch: any = {
            status: 'active',
            approved_by: args.actor,
            approved_at: now,
            deactivated_at: null,
          };
          if (!args.preserve_activated_at || target.activated_at == null) {
            patch.activated_at = now;
          }
          definitionsState[args.target_id] = { ...target, ...patch };
          return { activated: definitionsState[args.target_id], deactivated };
        },
      ),
    },
    procedureStatusEventsRepo: {
      record: vi.fn(async () => {}),
      listByDefinition: vi.fn(async () => []),
    },
    procedureTestsRepo: {
      create: vi.fn(async (input: any) => {
        const id = `test-${Math.random().toString(36).slice(2)}`;
        const row = {
          id,
          tenant_id: 'default',
          agent_id: 'default',
          last_run_at: null,
          last_run_status: null,
          last_run_details: null,
          created_at: new Date(),
          updated_at: new Date(),
          description: null,
          expected_step_path: null,
          ...input,
        };
        testsState[id] = row;
        return row;
      }),
      listByDefinition: vi.fn(async (definition_id: string) =>
        Object.values(testsState).filter((t: any) => t.definition_id === definition_id),
      ),
      recordRun: vi.fn(async (args: { id: string; status: string; details: unknown }) => {
        if (testsState[args.id]) {
          testsState[args.id] = {
            ...testsState[args.id],
            last_run_at: new Date(),
            last_run_status: args.status,
            last_run_details: args.details,
            updated_at: new Date(),
          };
        }
      }),
      allPassFor: vi.fn(async (definition_id: string) => {
        const tests = Object.values(testsState).filter(
          (t: any) => t.definition_id === definition_id,
        );
        if (tests.length === 0) return false;
        return tests.every((t: any) => t.last_run_status === 'pass');
      }),
      delete: vi.fn(async (id: string) => {
        delete testsState[id];
      }),
    },
    procedureExecutionsRepo: {
      create: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = {
          id,
          ...input,
          status: input.status ?? 'in_progress',
          completed_steps: input.completed_steps ?? [],
          execution_state: input.execution_state ?? {},
        };
        return execState[id];
      }),
      // PR #84 introduced createOrFindActive returning { execution, created }.
      createOrFindActive: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = {
          id,
          ...input,
          status: input.status ?? 'in_progress',
          completed_steps: input.completed_steps ?? [],
          execution_state: input.execution_state ?? {},
        };
        return { execution: execState[id], created: true };
      }),
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      findActiveForConversa: vi.fn(async () => null),
      updateState: vi.fn(async (id: string, updates: any) => {
        if (execState[id]) {
          execState[id] = {
            ...execState[id],
            ...updates,
            last_activity_at: new Date(),
          };
        }
      }),
      // Tx-variant: PR #85 fix P85-I1 routes reaper writes through withTx.
      updateStateTx: vi.fn(async (_tx: unknown, id: string, updates: any) => {
        if (execState[id]) {
          execState[id] = {
            ...execState[id],
            ...updates,
            last_activity_at: new Date(),
          };
        }
      }),
      listStaleInProgress: vi.fn(async (opts: { ttl_days: number; limit?: number }) => {
        // Reaper sets (tenant, agent) context per iteration; honour it.
        // Issue #323 (Phase 3): the real query now filters by agent_id too.
        const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
        const tenant_id = getCurrentTenant();
        const agent_id = getCurrentAgent();
        const cutoff = Date.now() - opts.ttl_days * 86_400_000;
        const all = Object.values(execState).filter((ex: any) => {
          if (ex.tenant_id !== tenant_id) return false;
          if (ex.agent_id !== agent_id) return false;
          if (ex.status !== 'in_progress') return false;
          const lastTs =
            ex.last_activity_at instanceof Date
              ? ex.last_activity_at.getTime()
              : new Date(ex.last_activity_at).getTime();
          return lastTs < cutoff;
        });
        // Honour the worker's batch limit (PR #85 fix P85-I6).
        return typeof opts.limit === 'number' ? all.slice(0, opts.limit) : all;
      }),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => {
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      // Tx-variant: PR #85 fix P85-I1 routes reaper writes through withTx.
      recordTx: vi.fn(async (_tx: unknown, input: any) => {
        events.push({ ...input, created_at: input.created_at ?? new Date() });
      }),
      listByExecution: vi.fn(async (execution_id: string) =>
        events.filter((e) => e.execution_id === execution_id),
      ),
    },
    tenantsRepo: {
      list: vi.fn(async () => tenantsState.slice()),
      findById: vi.fn(async (id: string) => tenantsState.find((t) => t.id === id) ?? null),
      create: vi.fn(),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { transitionProcedureStatus } from '@/cognition/procedure-status.js';
import { runProcedureTest } from '@/procedures/test-runner.js';
import { runProcedureExecutionReaper } from '@/workers/procedure-execution-reaper.js';
import type { ProcedureDefinition } from '@/db/schema.js';

// ---------- helpers ----------
async function seedProposedDefinition(
  nome: string,
  overrides: Record<string, unknown> = {},
): Promise<ProcedureDefinition> {
  const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
  return procedureDefinitionsRepo.create({
    scope: 'agent',
    nome,
    version_number: 1,
    status: 'proposed',
    intencao: 'qualquer',
    when_apply: {},
    when_not_apply: {},
    steps: [],
    success_criteria: [],
    failure_modes: [],
    tools_referenced: [],
    source: 'ensino',
    ...overrides,
  } as any);
}

async function seedDraftDefinition(
  nome: string,
  overrides: Record<string, unknown> = {},
): Promise<ProcedureDefinition> {
  const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
  return procedureDefinitionsRepo.create({
    scope: 'agent',
    nome,
    version_number: 1,
    status: 'draft',
    intencao: 'qualquer',
    when_apply: {},
    when_not_apply: {},
    steps: [],
    success_criteria: [],
    failure_modes: [],
    tools_referenced: [],
    source: 'ensino',
    ...overrides,
  } as any);
}

async function seedTest(
  definition_id: string,
  status: 'pass' | 'fail' | null,
): Promise<{ id: string }> {
  const { procedureTestsRepo } = await import('@/db/repositories.js');
  const row = await procedureTestsRepo.create({
    definition_id,
    name: `t-${Math.random().toString(36).slice(2)}`,
    scenario: {},
    expected_outcome: 'success',
  });
  if (status !== null) {
    await procedureTestsRepo.recordRun({ id: row.id, status, details: {} });
  }
  return row;
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text: JSON.stringify(jsonObj) }] };
}

// ---------- test suite ----------
describe('P3c procedure governance', () => {
  beforeEach(() => {
    for (const k of Object.keys(definitionsState)) delete definitionsState[k];
    for (const k of Object.keys(testsState)) delete testsState[k];
    for (const k of Object.keys(execState)) delete execState[k];
    events.length = 0;
    tenantsState.length = 0;
    messagesCreateMock.mockReset();
    vi.clearAllMocks();
  });

  it('cenário 1: definition draft → proposed OK; proposed → active sem tests falha (tests_required)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedDraftDefinition('lifecycle-1');

        // draft → proposed (gate não dispara aqui)
        const promoteToProposed = await transitionProcedureStatus({
          definition: def,
          to: 'proposed',
          actor: 'owner-1',
        });
        expect(promoteToProposed.ok).toBe(true);
        expect(definitionsState[def.id].status).toBe('proposed');

        // proposed → active SEM tests → falha com tests_required
        const promoteToActive = await transitionProcedureStatus({
          definition: definitionsState[def.id],
          to: 'active',
          actor: 'owner-1',
        });
        expect(promoteToActive.ok).toBe(false);
        if (promoteToActive.ok === false) {
          expect(promoteToActive.reason).toBe('tests_required');
          // o tipo discriminado garante missing_tests neste branch
          expect(
            (promoteToActive as { missing_tests: true }).missing_tests,
          ).toBe(true);
        }
        // status permanece em 'proposed' — gate abortou a transição
        expect(definitionsState[def.id].status).toBe('proposed');
      },
    );
  });

  it('cenário 2: 1 test passing + 1 test failing → bloqueia com tests_not_passing e failing_tests populado', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('lifecycle-2');
        await seedTest(def.id, 'pass');
        const failing = await seedTest(def.id, 'fail');

        const result = await transitionProcedureStatus({
          definition: def,
          to: 'active',
          actor: 'owner-1',
        });

        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.reason).toBe('tests_not_passing');
          const failingTests = (result as { failing_tests: any[] }).failing_tests;
          expect(Array.isArray(failingTests)).toBe(true);
          expect(failingTests).toHaveLength(1);
          expect(failingTests[0].id).toBe(failing.id);
        }
        expect(definitionsState[def.id].status).toBe('proposed');
      },
    );
  });

  it('cenário 3: todos tests passing → promoção succeeds', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('lifecycle-3');
        const t1 = await seedTest(def.id, 'fail');
        const t2 = await seedTest(def.id, 'pass');

        // Atualiza o primeiro test para pass — agora ambos verdes.
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        await procedureTestsRepo.recordRun({ id: t1.id, status: 'pass', details: {} });
        // sanity check do helper de update
        expect(testsState[t1.id].last_run_status).toBe('pass');
        expect(testsState[t2.id].last_run_status).toBe('pass');

        const result = await transitionProcedureStatus({
          definition: def,
          to: 'active',
          actor: 'owner-1',
        });
        expect(result.ok).toBe(true);
        expect(definitionsState[def.id].status).toBe('active');
        expect(definitionsState[def.id].approved_by).toBe('owner-1');
        expect(definitionsState[def.id].activated_at).toBeDefined();
      },
    );
  });

  it('cenário 4: step evaluator chain — llm_judge → user_signal → human_confirmed → outcome=success', async () => {
    // Definition com 3 steps; cada um aponta um criterion type novo.
    const definition = {
      id: 'def-3steps',
      tenant_id: 'sandbox-test',
      agent_id: 'sandbox',
      scope: 'tenant',
      owner_agent_id: null,
      nome: 'chain-test',
      version_number: 1,
      status: 'proposed',
      intencao: 'Exercita os 3 criterion types novos',
      when_apply: {},
      when_not_apply: {},
      steps: [
        { id: 'A', intencao: 'judge', como: 'avalia', sucesso_criteria_ref: 'crit-A' },
        {
          id: 'B',
          intencao: 'signal',
          como: 'pergunta',
          depends_on: ['A'],
          sucesso_criteria_ref: 'crit-B',
        },
        {
          id: 'C',
          intencao: 'human',
          como: 'confirma',
          depends_on: ['B'],
          sucesso_criteria_ref: 'crit-C',
        },
      ],
      success_criteria: [
        { id: 'crit-A', type: 'llm_judge', prompt: 'Resposta clara?', threshold: 0.7 },
        { id: 'crit-B', type: 'user_signal', signal: 'agreement' },
        { id: 'crit-C', type: 'human_confirmed' },
      ],
      failure_modes: [],
      tools_referenced: [],
      source: 'manual',
      proposed_by: null,
      approved_by: null,
      approved_at: null,
      activated_at: null,
      deactivated_at: null,
      source_candidate_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as ProcedureDefinition;

    // Anthropic mock retorna score 0.85 — acima do threshold 0.7 → llm_judge
    // passa para step A. mockResolvedValue (não mockResolvedValueOnce) para
    // tolerar re-avaliações no test-runner.
    messagesCreateMock.mockResolvedValue(
      makeAnthropicReply({ score: 0.85, reasoning: 'cumpre' }),
    );

    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const result = await runProcedureTest({
          test_id: 'chain',
          definition,
          scenario: {
            turns: [
              // Step A: agente responde, judge retorna score acima do threshold.
              { role: 'user', message: 'olá' },
              { role: 'agent', response_text: 'Resposta bem fundamentada.' },
              // Step B: user diz "sim" → agreement → step-B passa.
              { role: 'user', message: 'sim' },
              { role: 'agent', response_text: 'Combinado!' },
              // Step C: agent turn; runner injeta human_confirmation no at_step=C
              // antes de re-avaliar → human_confirmed passa.
              { role: 'agent', response_text: 'Aguardando confirmação humana...' },
            ],
            human_confirmations: [
              { at_step: 'C', decision: 'approved', operator_id: 'op-1' },
            ],
          },
          expected_outcome: 'success',
          expected_step_path: ['A', 'B', 'C'],
        });

        expect(result.status).toBe('pass');
        expect(result.details.actual_outcome).toBe('success');
        expect(result.details.actual_step_path).toEqual(['A', 'B', 'C']);
        expect(result.details.diff).toEqual([]);
      },
    );
  });

  it('cenário 5: reaper marca execução stale (8d in_progress) como abandoned/no_response com event auto_abandoned', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    // Seed direto na in-memory store — a fixture precisa ter last_activity_at
    // de 8 dias atrás para passar pelo cutoff (TTL default 7d).
    execState['exec-stale'] = {
      id: 'exec-stale',
      tenant_id: 'tenant-a',
      agent_id: 'default',
      conversa_id: 'conv-stale',
      definition_id: 'def-stale',
      definition_version: 1,
      status: 'in_progress',
      current_step_id: 'step-x',
      execution_state: {},
      completed_steps: [],
      started_at: daysAgo(10),
      last_activity_at: daysAgo(8),
      ended_at: null,
      outcome: null,
      notes: null,
    };

    await runProcedureExecutionReaper();

    // 1. event auto_abandoned gravado, com step_id e payload corretos.
    const reapedEvents = events.filter((e) => e.event_type === 'auto_abandoned');
    expect(reapedEvents).toHaveLength(1);
    expect(reapedEvents[0].execution_id).toBe('exec-stale');
    expect(reapedEvents[0].step_id).toBe('step-x');
    expect(reapedEvents[0].payload.reason).toMatch(/inactive_for_\d+_days/);
    expect(reapedEvents[0].payload.last_activity_at).toBeDefined();

    // 2. execução marcada como abandoned/no_response com ended_at preenchido.
    const updated = execState['exec-stale'];
    expect(updated.status).toBe('abandoned');
    expect(updated.outcome).toBe('no_response');
    expect(updated.ended_at).toBeInstanceOf(Date);
  });
});
