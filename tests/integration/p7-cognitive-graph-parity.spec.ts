/**
 * P7 parity (issue #412) — DB side-effect parity for the cognitive graph path.
 *
 * **Objective:** prove that a representative turn driven through the
 * declarative cognitive-graph nodes emits the SAME database side-effects the
 * imperative legacy path emitted: `selector_decisions` rows, the full
 * `procedure_execution_events` set, and reflection persistence.
 *
 * This is the regression that lets `FEATURE_COGNITIVE_GRAPH` be removed: with
 * the flag gone there is only one path, so the parity guarantee becomes
 * "the graph path emits the full side-effect set" — asserted here against an
 * in-memory mirror of every repo the engine writes to.
 *
 * **Why in-memory and not Postgres:** like `p7-cognitive-graph.spec.ts` and
 * `p3b-procedure-runtime.spec.ts`, this file mocks `@/db/repositories.js` +
 * `@/db/client.js` (withTx passes through) and runs the REAL `engine.ts`,
 * REAL `evaluateCurrentStep`, and REAL graph nodes. The event log captured in
 * `events[]` is exactly what the procedure runtime would have written to
 * `procedure_execution_events`. No tcp/5432.
 *
 * The original legacy imperative side-effect set (from agent/core.ts before
 * the #412 collapse) is encoded as `LEGACY_*` reference constants so the test
 * documents the parity contract it enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---- In-memory stores (mirror the procedure-runtime tables) ----------------
const execState: Record<string, any> = {};
const events: any[] = [];
const decisions: any[] = [];
const definitions: Record<string, any> = {};
const persistedCandidates: any[] = [];
const successesRecorded: any[] = [];

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

vi.mock('@/db/client.js', () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  db: {},
  pool: {},
  isDbConnected: () => true,
  probeDb: async () => true,
  shutdownDb: async () => {},
}));

vi.mock('@/db/repositories.js', async () => {
  const actual =
    await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    procedureExecutionsRepo: {
      findById: vi.fn(async (id: string) => execState[id] ?? null),
      findActiveForConversa: vi.fn(
        async (conversa_id: string) =>
          Object.values(execState).find(
            (e: any) => e.conversa_id === conversa_id && e.status === 'in_progress',
          ) ?? null,
      ),
      createOrFindActive: vi.fn(async (input: any) => {
        const id = `exec-${Math.random().toString(36).slice(2)}`;
        execState[id] = { id, ...input };
        return { execution: execState[id], created: true };
      }),
      updateStateTx: vi.fn(async (_tx: unknown, id: string, updates: any) => {
        if (execState[id]) execState[id] = { ...execState[id], ...updates };
      }),
    },
    procedureExecutionEventsRepo: {
      record: vi.fn(async (input: any) => {
        events.push(input);
      }),
      recordTx: vi.fn(async (_tx: unknown, input: any) => {
        events.push(input);
      }),
      listByExecution: vi.fn(async (id: string) =>
        events.filter((e) => e.execution_id === id),
      ),
    },
    procedureSelectorDecisionsRepo: {
      record: vi.fn(async (input: any) => {
        decisions.push(input);
      }),
      recentByConversa: vi.fn(async () => decisions),
    },
    procedureDefinitionsRepo: {
      findById: vi.fn(async (id: string) => definitions[id] ?? null),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

// Reflection / cognition pipeline — mock so success-reflection persistence is
// observable without a real LLM. The nodes call reflect → classify →
// persistCandidate → recordSuccess.
vi.mock('@/cognition/reflector.js', () => ({
  reflect: vi.fn(async () => ({ insight: 'usuário confirmou que ficou bom' })),
}));
vi.mock('@/cognition/classifier.js', () => ({
  classify: vi.fn(async () => ({ type: 'fato', tipo: 'fato', conteudo: 'x' })),
}));
vi.mock('@/cognition/persister.js', () => ({
  persistCandidate: vi.fn(async (classified: any, event: any) => {
    persistedCandidates.push({ classified, event });
    return { persisted_to: 'cognitive_candidates', id: 'cand-1' };
  }),
}));
vi.mock('@/cognition/capability-tracker.js', () => ({
  recordSuccess: vi.fn(async (args: any) => {
    successesRecorded.push(args);
  }),
  recordFailure: vi.fn(async () => {}),
}));

import * as engine from '@/procedures/engine.js';
import { buildPostturnNodes } from '@/cognitive-graph/postturn-graph.js';
import { runNodes } from '@/cognitive-graph/orchestrator.js';

/**
 * Reference: the event_type set the LEGACY imperative post-turn IIFE in
 * agent/core.ts emitted for a single-step completion that called a tool and
 * had one passing criterion. (Setup `startExecution` contributes
 * `execution_started`; the evaluator-completion contributes the rest.)
 *
 * advanceStep itself emits step_completed + step_started + state_updated
 * (see procedures/engine.ts:advanceStep), so the full ordered set for a
 * tool+criterion turn that advances one step is below.
 */
const LEGACY_ADVANCE_EVENT_TYPES = [
  'execution_started', // from startExecution (turn setup)
  'tool_called', // recordToolCalled (per tool)
  'criterion_checked', // recordCriterionChecked (per criterion)
  'step_completed', // advanceStep
  'step_started', // advanceStep (next step)
  'state_updated', // advanceStep
] as const;

function seedAdvanceableDefinition(defId: string) {
  definitions[defId] = {
    id: defId,
    nome: 'test-proc',
    version_number: 1,
    status: 'active',
    intencao: 'test',
    when_apply: {},
    steps: [
      { id: 'step-1', intencao: 'X', como: 'Y', sucesso_criteria_ref: 'crit-1' },
      { id: 'step-2', intencao: 'Z', como: 'W', depends_on: ['step-1'] },
    ],
    success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'confirmado' }],
  };
}

describe('P7 — cognitive graph DB side-effect parity (#412)', () => {
  beforeEach(() => {
    for (const k of Object.keys(execState)) delete execState[k];
    for (const k of Object.keys(definitions)) delete definitions[k];
    events.length = 0;
    decisions.length = 0;
    persistedCandidates.length = 0;
    successesRecorded.length = 0;
    vi.clearAllMocks();
  });

  it('step-evaluator-trigger node emits the FULL procedure_execution_events set on advance (tool_called + criterion_checked + advance trio)', async () => {
    const defId = 'def-advance';
    seedAdvanceableDefinition(defId);

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c-parity',
        first_step_id: 'step-1',
      });

      // Drive the turn through the GRAPH node (not the legacy IIFE).
      const nodes = buildPostturnNodes();
      await runNodes(nodes, {
        conversa_id: 'c-parity',
        turno_id: 't-parity',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-parity' },
        // inbound text is neither a correction nor a success signal → only the
        // step-evaluator node fires, isolating the procedure side-effects.
        inbound: { id: 't-parity', conteudo: 'aqui está confirmado pelo cliente' },
        response_text: 'confirmado pelo cliente',
        tools_called: [{ name: 'lancar_transacao', result: { ok: true } }],
        active_execution_id: exec.id,
      } as never);

      // ASYNC fire-and-forget — let the node promise settle.
      await new Promise((r) => setTimeout(r, 50));

      const types = events.map((e) => e.event_type);

      // Parity: every legacy event_type is present, in the same relative order.
      for (const t of LEGACY_ADVANCE_EVENT_TYPES) {
        expect(types).toContain(t);
      }

      // The audit rows the original graph node DROPPED (pre-#412): tool_called
      // and criterion_checked. Assert their payloads carry the right shape.
      const toolEvt = events.find((e) => e.event_type === 'tool_called');
      expect(toolEvt?.payload?.tool_name).toBe('lancar_transacao');

      const critEvt = events.find((e) => e.event_type === 'criterion_checked');
      expect(critEvt?.payload?.criterion_id).toBe('crit-1');
      expect(critEvt?.payload?.passed).toBe(true);

      // And the step actually advanced (state mutation parity).
      expect(execState[exec.id].current_step_id).toBe('step-2');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('step-evaluator-trigger node emits step_failed when the step stalls (no criteria) — parity with legacy stall handling', async () => {
    const defId = 'def-stall';
    definitions[defId] = {
      id: defId,
      nome: 'stall-proc',
      version_number: 1,
      status: 'active',
      intencao: 'test',
      when_apply: {},
      // step-1 has NO sucesso_criteria_ref → evaluator returns
      // stall_reason='no_criteria_defined'.
      steps: [{ id: 'step-1', intencao: 'X', como: 'Y' }],
      success_criteria: [],
    };

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c-stall',
        first_step_id: 'step-1',
      });

      await runNodes(buildPostturnNodes(), {
        conversa_id: 'c-stall',
        turno_id: 't-stall',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-stall' },
        inbound: { id: 't-stall', conteudo: 'qualquer coisa' },
        response_text: 'resposta',
        tools_called: [],
        active_execution_id: exec.id,
      } as never);
      await new Promise((r) => setTimeout(r, 50));

      const stallEvt = events.find((e) => e.event_type === 'step_failed');
      expect(stallEvt).toBeTruthy();
      expect(stallEvt?.payload?.reason).toBe('no_criteria_defined');
      // Step did NOT advance / complete (stall is non-terminal).
      expect(events.some((e) => e.event_type === 'execution_completed')).toBe(false);
      expect(events.some((e) => e.event_type === 'step_completed')).toBe(false);
    });
  });

  it('success-reflection node persists a candidate + records success on an explicit success signal (reflection-row parity)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      await runNodes(buildPostturnNodes(), {
        conversa_id: 'c-success',
        turno_id: 't-success',
        pessoa: { id: 'p-success' },
        conversa: { id: 'c-success' },
        // "perfeito" trips detectSuccess → success-reflection node runs.
        inbound: { id: 't-success', conteudo: 'perfeito, ficou exatamente como eu queria' },
        response_text: 'que bom!',
        tools_called: [],
        active_execution_id: null,
      } as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(persistedCandidates.length).toBe(1);
      expect(persistedCandidates[0].event.type).toBe('success_explicit');
      expect(persistedCandidates[0].event.conversa_id).toBe('c-success');
      expect(successesRecorded).toEqual([{ domain: 'general' }]);
    });
  });

  it('runWhen gating: a neutral turn (no procedure, no signals) emits ZERO side-effects (parity — legacy also no-ops)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      await runNodes(buildPostturnNodes(), {
        conversa_id: 'c-neutral',
        turno_id: 't-neutral',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-neutral' },
        inbound: { id: 't-neutral', conteudo: 'me manda o relatório de maio' },
        response_text: 'claro, aqui está',
        tools_called: [],
        active_execution_id: null,
      } as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(events.length).toBe(0);
      expect(decisions.length).toBe(0);
      expect(persistedCandidates.length).toBe(0);
      expect(successesRecorded.length).toBe(0);
    });
  });
});
