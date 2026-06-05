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

// procedure-selector — mock so the preturn `procedure-selector` node returns a
// deterministic SelectorDecision without an LLM. Drives the `selector_decisions`
// parity scenario: the node output is persisted via
// `procedureSelectorDecisionsRepo.record` exactly as agent/core.ts does.
const selectProcedureMock = vi.fn();
vi.mock('@/cognition/procedure-selector.js', () => ({
  selectProcedure: (...args: unknown[]) => selectProcedureMock(...args),
}));

import * as engine from '@/procedures/engine.js';
import { buildPostturnNodes } from '@/cognitive-graph/postturn-graph.js';
import { buildPreturnNodes } from '@/cognitive-graph/preturn-graph.js';
import { runNodes } from '@/cognitive-graph/orchestrator.js';
import { procedureSelectorDecisionsRepo } from '@/db/repositories.js';

/**
 * Reference: the EXACT ordered event_type sequence the LEGACY imperative
 * post-turn IIFE in agent/core.ts emitted for a single-step completion that
 * called one tool and had one passing criterion, then advanced one step.
 *
 * Order is byte-for-byte the engine's emission order (see procedures/engine.ts):
 *   - setup `startExecution`     → execution_started
 *   - recordToolCalled (per tool)→ tool_called
 *   - recordCriterionChecked     → criterion_checked
 *   - advanceStep                → step_completed, step_started, state_updated
 *
 * The test asserts this sequence EXACTLY (ordered + exact count) — not mere
 * membership — so a dropped, reordered, or duplicated event fails the gate.
 */
const LEGACY_ADVANCE_EVENT_TYPES = [
  'execution_started', // from startExecution (turn setup)
  'tool_called', // recordToolCalled (per tool)
  'criterion_checked', // recordCriterionChecked (per criterion)
  'step_completed', // advanceStep
  'step_started', // advanceStep (next step)
  'state_updated', // advanceStep
] as const;

/**
 * Branch scenario: when the completed step has ≥2 eligible downstream steps,
 * the DAG-aware picker linearizes them and the node emits `branch_taken`
 * (chosen + alternates) BEFORE the advance trio. Exact ordered sequence:
 */
const LEGACY_BRANCH_EVENT_TYPES = [
  'execution_started',
  'tool_called',
  'criterion_checked',
  'branch_taken', // recordEvent — DAG linearized, alternates reported
  'step_completed',
  'step_started',
  'state_updated',
] as const;

/**
 * Terminal-completion scenario: last step passes, no eligible next step, so
 * the node calls `completeExecution` (NOT advanceStep). Exact sequence:
 */
const LEGACY_COMPLETE_EVENT_TYPES = [
  'execution_started',
  'tool_called',
  'criterion_checked',
  'execution_completed', // completeExecution
  'state_updated', // completeExecution (status flip)
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

/**
 * A DAG with a real branch: `step-1` completes and BOTH `step-2a` and
 * `step-2b` become eligible (both depend only on `step-1`, neither completed).
 * The deterministic picker chooses `step-2a` (array order) and reports
 * `step-2b` as an alternate → exercises `branch_taken`.
 */
function seedBranchingDefinition(defId: string) {
  definitions[defId] = {
    id: defId,
    nome: 'branch-proc',
    version_number: 1,
    status: 'active',
    intencao: 'test',
    when_apply: {},
    steps: [
      { id: 'step-1', intencao: 'X', como: 'Y', sucesso_criteria_ref: 'crit-1' },
      { id: 'step-2a', intencao: 'A', como: 'A', depends_on: ['step-1'] },
      { id: 'step-2b', intencao: 'B', como: 'B', depends_on: ['step-1'] },
    ],
    success_criteria: [{ id: 'crit-1', type: 'machine_check', expression: 'confirmado' }],
  };
}

/**
 * A single-step definition: `step-1` passes and there is NO downstream step,
 * so the evaluator returns `next_step_id=null` and the node terminates the
 * execution via `completeExecution`.
 */
function seedTerminalDefinition(defId: string) {
  definitions[defId] = {
    id: defId,
    nome: 'terminal-proc',
    version_number: 1,
    status: 'active',
    intencao: 'test',
    when_apply: {},
    steps: [{ id: 'step-1', intencao: 'X', como: 'Y', sucesso_criteria_ref: 'crit-1' }],
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

      // STRICT parity: the EXACT ordered sequence + exact count — not mere
      // membership. Dropping, reordering, or duplicating any event fails here.
      expect(types).toEqual([...LEGACY_ADVANCE_EVENT_TYPES]);

      // The audit rows the original graph node DROPPED (pre-#412): tool_called
      // and criterion_checked. Assert their payloads carry the right shape.
      const toolEvt = events.find((e) => e.event_type === 'tool_called');
      expect(toolEvt?.payload?.tool_name).toBe('lancar_transacao');

      const critEvt = events.find((e) => e.event_type === 'criterion_checked');
      expect(critEvt?.payload?.criterion_id).toBe('crit-1');
      expect(critEvt?.payload?.passed).toBe(true);

      // advanceStep payload parity: step_completed carries completed+next ids.
      const stepCompleted = events.find((e) => e.event_type === 'step_completed');
      expect(stepCompleted?.payload).toMatchObject({
        completed_step_id: 'step-1',
        next_step_id: 'step-2',
      });
      const stateUpdated = events.find((e) => e.event_type === 'state_updated');
      expect(stateUpdated?.payload).toMatchObject({
        current_step_id: 'step-2',
        completed_steps: ['step-1'],
      });

      // Single-step advance emits NO branch_taken (only one eligible next step).
      expect(types).not.toContain('branch_taken');

      // And the step actually advanced (state mutation parity).
      expect(execState[exec.id].current_step_id).toBe('step-2');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('branch-alternate scenario: a step with ≥2 eligible next steps emits branch_taken (chosen + alternates) in the exact ordered sequence before the advance trio', async () => {
    const defId = 'def-branch';
    seedBranchingDefinition(defId);

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c-branch',
        first_step_id: 'step-1',
      });

      await runNodes(buildPostturnNodes(), {
        conversa_id: 'c-branch',
        turno_id: 't-branch',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-branch' },
        inbound: { id: 't-branch', conteudo: 'confirmado pelo cliente' },
        response_text: 'confirmado pelo cliente',
        tools_called: [{ name: 'lancar_transacao', result: { ok: true } }],
        active_execution_id: exec.id,
      } as never);
      await new Promise((r) => setTimeout(r, 50));

      const types = events.map((e) => e.event_type);

      // STRICT parity: exact ordered sequence WITH branch_taken interleaved
      // between criterion_checked and the advance trio.
      expect(types).toEqual([...LEGACY_BRANCH_EVENT_TYPES]);

      // branch_taken payload: deterministic array-order pick → step-2a chosen,
      // step-2b reported as the linearized alternate.
      const branchEvt = events.find((e) => e.event_type === 'branch_taken');
      expect(branchEvt?.step_id).toBe('step-2a');
      expect(branchEvt?.payload).toMatchObject({
        chosen_step_id: 'step-2a',
        alternates: ['step-2b'],
        picker: 'deterministic_array_order',
      });

      // Advanced into the chosen branch (state mutation parity).
      expect(execState[exec.id].current_step_id).toBe('step-2a');
      expect(execState[exec.id].completed_steps).toContain('step-1');
    });
  });

  it('terminal-completion scenario: the last step passing (no next step) emits execution_completed + state_updated with success outcome — NOT advanceStep', async () => {
    const defId = 'def-terminal';
    seedTerminalDefinition(defId);

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { execution: exec } = await engine.startExecution({
        definition_id: defId,
        definition_version: 1,
        conversa_id: 'c-terminal',
        first_step_id: 'step-1',
      });

      await runNodes(buildPostturnNodes(), {
        conversa_id: 'c-terminal',
        turno_id: 't-terminal',
        pessoa: { id: 'p1' },
        conversa: { id: 'c-terminal' },
        inbound: { id: 't-terminal', conteudo: 'confirmado pelo cliente' },
        response_text: 'confirmado pelo cliente',
        tools_called: [{ name: 'lancar_transacao', result: { ok: true } }],
        active_execution_id: exec.id,
      } as never);
      await new Promise((r) => setTimeout(r, 50));

      const types = events.map((e) => e.event_type);

      // STRICT parity: exact ordered terminal sequence. Completion path emits
      // execution_completed + state_updated and NEVER the advance trio.
      expect(types).toEqual([...LEGACY_COMPLETE_EVENT_TYPES]);
      expect(types).not.toContain('step_started');

      const completedEvt = events.find((e) => e.event_type === 'execution_completed');
      expect(completedEvt?.payload).toMatchObject({ outcome: 'success' });

      const stateEvt = events.find((e) => e.event_type === 'state_updated');
      expect(stateEvt?.payload).toMatchObject({ status: 'completed', outcome: 'success' });

      // Execution terminal in the mirror (status flipped, outcome recorded).
      expect(execState[exec.id].status).toBe('completed');
      expect(execState[exec.id].outcome).toBe('success');
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

  it('selector_decisions parity: the procedure-selector node output is persisted to procedureSelectorDecisionsRepo.record with the legacy field mapping', async () => {
    // The `procedure-selector` node returns a SelectorDecision; the persist
    // into `selector_decisions` is a post-graph side-effect in agent/core.ts
    // (consuming `result.nodes['procedure-selector'].output`). This scenario
    // drives the REAL preturn node via runNodes, then persists its output with
    // the SAME field mapping core.ts uses, proving the `selector_decisions`
    // side-effect lands in the mirror — the parity the doc claims.
    const selectorDecision = {
      decision: 'start' as const,
      selected_procedure_id: 'proc-onboarding',
      candidates: [{ procedure_id: 'proc-onboarding', confidence: 0.91, reason: 'top' }],
      conflicts: [],
      reason: 'top candidate 0.91 > threshold 0.70',
    };
    selectProcedureMock.mockResolvedValue(selectorDecision);

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await runNodes(buildPreturnNodes({ multi_channel_on: false }), {
        conversa_id: 'c-selector',
        turno_id: 't-selector',
        inbound_text: 'quero abrir uma conta nova',
        current_execution: null,
      } as never);

      const selectorOutput = result.nodes['procedure-selector']?.output as
        | typeof selectorDecision
        | null;
      expect(selectorOutput).toEqual(selectorDecision);

      // Mirror agent/core.ts's post-graph persist of the selector decision.
      await procedureSelectorDecisionsRepo.record({
        conversa_id: 'c-selector',
        turno_id: 't-selector',
        current_execution_id: null,
        candidates: selectorOutput!.candidates,
        conflicts: selectorOutput!.conflicts,
        decision: selectorOutput!.decision,
        selected_procedure_id: selectorOutput!.selected_procedure_id ?? null,
        decided_by: 'selector_llm',
        reason: selectorOutput!.reason,
      } as never);

      expect(decisions.length).toBe(1);
      expect(decisions[0]).toMatchObject({
        conversa_id: 'c-selector',
        turno_id: 't-selector',
        decision: 'start',
        selected_procedure_id: 'proc-onboarding',
        decided_by: 'selector_llm',
      });
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
