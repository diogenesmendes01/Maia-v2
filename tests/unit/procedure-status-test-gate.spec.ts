/**
 * P3c Task 8 — test gate `proposed → active`.
 *
 * Gate semantics:
 *  1. zero procedure_tests for a definition          → `reason: 'tests_required'`
 *  2. >=1 test but any row last_run_status !== 'pass' → `reason: 'tests_not_passing'`
 *  3. >=1 test and all rows last_run_status === 'pass' → success
 *
 * Other transitions (draft→proposed, active→frozen, frozen→active, etc.) MUST
 * NOT trigger the gate.
 *
 * Pattern mirrors tests/integration/p3a-procedure-lifecycle.spec.ts +
 * tests/unit/procedure-tests-repo.spec.ts (in-memory mock of the repos).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { transitionProcedureStatus } from '@/cognition/procedure-status.js';

const definitionsState: Record<string, any> = {};
const testsState: Record<string, any> = {};

// ---------------------------------------------------------------------------
// Mock @/db/client.js so the non-active path (which now uses withTx) does not
// attempt a real DB connection. The mock simply runs the callback immediately.
// ---------------------------------------------------------------------------
vi.mock('@/db/client.js', () => ({
  db: {},
  withTx: vi.fn(async (fn: (tx: any) => Promise<any>) => fn({} as any)),
}));

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
      // P83-C4: atomicActivate is the single entry point for `→ active`
      // transitions (locks + freezes siblings + emits event in one tx).
      // The transitionProcedureStatus router calls it after the P3c gate
      // passes — so this test mock has to provide it too.
      atomicActivate: vi.fn(async (args: any) => {
        const target = definitionsState[args.target_id];
        if (!target) throw new Error('not found');
        let deactivated: any = null;
        for (const id in definitionsState) {
          const sib = definitionsState[id];
          if (sib.id !== target.id && sib.nome === target.nome && sib.status === 'active') {
            sib.status = 'frozen';
            sib.deactivated_at = new Date();
            if (!deactivated) deactivated = sib;
          }
        }
        target.status = 'active';
        target.approved_by = args.actor;
        target.approved_at = new Date();
        if (!args.preserve_activated_at || !target.activated_at) {
          target.activated_at = new Date();
        }
        return { activated: target, deactivated };
      }),
      create: vi.fn(async (input: any) => {
        const id = `def-${Math.random().toString(36).slice(2)}`;
        definitionsState[id] = { id, ...input };
        return definitionsState[id];
      }),
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
  };
});

async function seedProposedDefinition(nome: string) {
  const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
  return procedureDefinitionsRepo.create({
    scope: 'agent',
    nome,
    version_number: 1,
    status: 'proposed',
    intencao: 'X',
    when_apply: {},
    when_not_apply: {},
    steps: [],
    success_criteria: [],
    failure_modes: [],
    tools_referenced: [],
    source: 'ensino',
  } as any);
}

async function seedTest(definition_id: string, status: 'pass' | 'fail' | null) {
  const { procedureTestsRepo } = await import('@/db/repositories.js');
  const row = await procedureTestsRepo.create({
    definition_id,
    name: `test-${Math.random().toString(36).slice(2)}`,
    scenario: {},
    expected_outcome: 'success',
  });
  if (status !== null) {
    await procedureTestsRepo.recordRun({ id: row.id, status, details: {} });
  }
  return row;
}

describe('P3c test gate — proposed → active', () => {
  beforeEach(() => {
    for (const k of Object.keys(definitionsState)) delete definitionsState[k];
    for (const k of Object.keys(testsState)) delete testsState[k];
    vi.clearAllMocks();
  });

  it('cenário 1: zero tests → bloqueia com reason=tests_required', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('no-tests');

        const result = await transitionProcedureStatus({
          definition: def,
          to: 'active',
          actor: 'owner-1',
        });

        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.reason).toBe('tests_required');
          expect(result.missing_tests).toBe(true);
        }
        // definition stays in 'proposed' — gate aborted the transition
        expect(definitionsState[def.id].status).toBe('proposed');
      },
    );
  });

  it('cenário 2: 1 test passing + 1 failing → bloqueia com reason=tests_not_passing e failing_tests preenchido', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('mixed-results');
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
          expect(Array.isArray(result.failing_tests)).toBe(true);
          expect(result.failing_tests!.length).toBe(1);
          expect(result.failing_tests![0]!.id).toBe(failing.id);
        }
        expect(definitionsState[def.id].status).toBe('proposed');
      },
    );
  });

  it('cenário 3: todos tests passing → promove com sucesso', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('all-green');
        await seedTest(def.id, 'pass');
        await seedTest(def.id, 'pass');

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

  it('cenário 4: tests com last_run_status null (nunca rodaram) também bloqueiam como tests_not_passing', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const def = await seedProposedDefinition('never-ran');
        const never = await seedTest(def.id, null); // created, never recordRun-ed

        const result = await transitionProcedureStatus({
          definition: def,
          to: 'active',
          actor: 'owner-1',
        });

        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.reason).toBe('tests_not_passing');
          expect(result.failing_tests!.map((t) => t.id)).toContain(never.id);
        }
        expect(definitionsState[def.id].status).toBe('proposed');
      },
    );
  });

  it('cenário 5: gate NÃO dispara em draft → proposed (não há gate aí)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const def = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'no-gate-here',
          version_number: 1,
          status: 'draft',
          intencao: 'X',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);

        // No tests seeded — but draft→proposed should not consult the gate.
        const result = await transitionProcedureStatus({
          definition: def,
          to: 'proposed',
          actor: 'owner-1',
        });

        expect(result.ok).toBe(true);
        expect(definitionsState[def.id].status).toBe('proposed');
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        expect(procedureTestsRepo.listByDefinition).not.toHaveBeenCalled();
      },
    );
  });

  it('cenário 6: gate NÃO dispara em active → frozen', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureDefinitionsRepo } = await import('@/db/repositories.js');
        const def = await procedureDefinitionsRepo.create({
          scope: 'agent',
          nome: 'active-to-frozen',
          version_number: 1,
          status: 'active',
          intencao: 'X',
          when_apply: {},
          when_not_apply: {},
          steps: [],
          success_criteria: [],
          failure_modes: [],
          tools_referenced: [],
          source: 'ensino',
        } as any);

        const result = await transitionProcedureStatus({
          definition: def,
          to: 'frozen',
          actor: 'owner-1',
        });

        expect(result.ok).toBe(true);
        expect(definitionsState[def.id].status).toBe('frozen');
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        expect(procedureTestsRepo.listByDefinition).not.toHaveBeenCalled();
      },
    );
  });
});
