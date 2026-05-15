/**
 * P3c Task 3 — repo tests for procedureTestsRepo + procedureMetricsRepo.
 *
 * Pattern (matches tests/integration/p3a-procedure-lifecycle.spec.ts and
 * tests/integration/p3b-procedure-runtime.spec.ts): we don't have a Postgres
 * test instance available in this environment, so we mock @/db/repositories.js
 * with an in-memory backing store. The mock surface mirrors the real repo
 * signatures so consumer code typed against the repo behaves identically.
 *
 * This validates the contract / API shape of the repos. Real DB integration
 * tests live under tests/integration/p3c-* (added separately when a fixtures
 * runner is available).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const testsState: Record<string, any> = {};
const metricsState: Record<string, any> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
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
    procedureMetricsRepo: {
      getByDefinition: vi.fn(async (definition_id: string) => metricsState[definition_id] ?? null),
      listByTenantAgent: vi.fn(async () => Object.values(metricsState)),
    },
  };
});

describe('procedureTestsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(testsState)) delete testsState[k];
    for (const k of Object.keys(metricsState)) delete metricsState[k];
    vi.clearAllMocks();
  });

  it('cria um test row (com applyTenantGuard propagado)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const row = await procedureTestsRepo.create({
          definition_id: 'def-1',
          name: 'cenário feliz',
          description: 'usuário responde tudo certo',
          scenario: { turns: [{ role: 'user', text: 'oi' }] },
          expected_outcome: 'success',
          expected_step_path: ['step-1', 'step-2'],
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.definition_id).toBe('def-1');
        expect(row.expected_outcome).toBe('success');
        expect(row.last_run_status).toBeNull();
      },
    );
  });

  it('listByDefinition retorna todos tests de uma definition', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        await procedureTestsRepo.create({
          definition_id: 'def-A',
          name: 't1',
          scenario: {},
          expected_outcome: 'success',
        });
        await procedureTestsRepo.create({
          definition_id: 'def-A',
          name: 't2',
          scenario: {},
          expected_outcome: 'failure',
        });
        await procedureTestsRepo.create({
          definition_id: 'def-B',
          name: 't3',
          scenario: {},
          expected_outcome: 'success',
        });

        const tests = await procedureTestsRepo.listByDefinition('def-A');
        expect(tests.length).toBe(2);
        expect(tests.every((t: any) => t.definition_id === 'def-A')).toBe(true);
      },
    );
  });

  it('recordRun atualiza last_run_at + last_run_status + last_run_details', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const row = await procedureTestsRepo.create({
          definition_id: 'def-X',
          name: 'run-update',
          scenario: {},
          expected_outcome: 'success',
        });
        expect(row.last_run_status).toBeNull();

        await procedureTestsRepo.recordRun({
          id: row.id,
          status: 'pass',
          details: { duration_ms: 142, asserts_passed: 5 },
        });

        const after = await procedureTestsRepo.listByDefinition('def-X');
        expect(after[0]!.last_run_status).toBe('pass');
        expect(after[0]!.last_run_at).toBeInstanceOf(Date);
        expect((after[0]!.last_run_details as any).duration_ms).toBe(142);
      },
    );
  });

  it('allPassFor retorna false quando zero tests', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const result = await procedureTestsRepo.allPassFor('def-empty');
        expect(result).toBe(false);
      },
    );
  });

  it('allPassFor retorna false quando um test falha', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const t1 = await procedureTestsRepo.create({
          definition_id: 'def-mix',
          name: 'ok',
          scenario: {},
          expected_outcome: 'success',
        });
        const t2 = await procedureTestsRepo.create({
          definition_id: 'def-mix',
          name: 'breaks',
          scenario: {},
          expected_outcome: 'success',
        });
        await procedureTestsRepo.recordRun({ id: t1.id, status: 'pass', details: {} });
        await procedureTestsRepo.recordRun({ id: t2.id, status: 'fail', details: { reason: 'wrong step path' } });

        const result = await procedureTestsRepo.allPassFor('def-mix');
        expect(result).toBe(false);
      },
    );
  });

  it('allPassFor retorna true quando todos passam', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const t1 = await procedureTestsRepo.create({
          definition_id: 'def-allpass',
          name: 'a',
          scenario: {},
          expected_outcome: 'success',
        });
        const t2 = await procedureTestsRepo.create({
          definition_id: 'def-allpass',
          name: 'b',
          scenario: {},
          expected_outcome: 'success',
        });
        await procedureTestsRepo.recordRun({ id: t1.id, status: 'pass', details: {} });
        await procedureTestsRepo.recordRun({ id: t2.id, status: 'pass', details: {} });

        const result = await procedureTestsRepo.allPassFor('def-allpass');
        expect(result).toBe(true);
      },
    );
  });

  it('delete remove o test', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureTestsRepo } = await import('@/db/repositories.js');
        const row = await procedureTestsRepo.create({
          definition_id: 'def-del',
          name: 'to-delete',
          scenario: {},
          expected_outcome: 'success',
        });
        expect((await procedureTestsRepo.listByDefinition('def-del')).length).toBe(1);
        await procedureTestsRepo.delete(row.id);
        expect((await procedureTestsRepo.listByDefinition('def-del')).length).toBe(0);
      },
    );
  });
});

describe('procedureMetricsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(metricsState)) delete metricsState[k];
    vi.clearAllMocks();
  });

  it('getByDefinition retorna null para id desconhecido', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { procedureMetricsRepo } = await import('@/db/repositories.js');
        const result = await procedureMetricsRepo.getByDefinition('unknown-def');
        expect(result).toBeNull();
      },
    );
  });

  it('getByDefinition retorna metric quando existe', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        metricsState['def-known'] = {
          definition_id: 'def-known',
          tenant_id: 'default',
          agent_id: 'default',
          nome: 'qualify-lead',
          version: 1,
          definition_status: 'active',
          total_executions: 10,
          successful_executions: 7,
          failed_executions: 1,
          aborted_executions: 1,
          escalated_executions: 0,
          abandoned_executions: 1,
          in_progress_executions: 0,
          success_rate: '0.7000',
          avg_completion_seconds: '42.3',
          last_execution_at: new Date(),
          refreshed_at: new Date(),
        };
        const { procedureMetricsRepo } = await import('@/db/repositories.js');
        const result = await procedureMetricsRepo.getByDefinition('def-known');
        expect(result).not.toBeNull();
        expect(result!.nome).toBe('qualify-lead');
        expect(result!.total_executions).toBe(10);
      },
    );
  });

  it('listByTenantAgent retorna array de metrics', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        metricsState['def-1'] = {
          definition_id: 'def-1',
          tenant_id: 'default',
          agent_id: 'default',
          nome: 'p1',
          version: 1,
          definition_status: 'active',
          total_executions: 5,
          successful_executions: 5,
          failed_executions: 0,
          aborted_executions: 0,
          escalated_executions: 0,
          abandoned_executions: 0,
          in_progress_executions: 0,
          success_rate: '1.0000',
          avg_completion_seconds: '10.0',
          last_execution_at: new Date(),
          refreshed_at: new Date(),
        };
        const { procedureMetricsRepo } = await import('@/db/repositories.js');
        const result = await procedureMetricsRepo.listByTenantAgent();
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(1);
        expect(result[0]!.definition_id).toBe('def-1');
      },
    );
  });
});
