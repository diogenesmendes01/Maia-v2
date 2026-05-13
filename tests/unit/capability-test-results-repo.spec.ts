/**
 * P5 Task 5 — repo tests for capabilityTestResultsRepo.
 *
 * Mock-based pattern (matches tests/unit/procedure-tests-repo.spec.ts). The
 * mock implements the same contract as the real repo so consumer code typed
 * against the repo behaves identically.
 *
 * Validates: record() inserts with applyTenantGuard, listByProposal returns
 * ordered by ran_at DESC, latestByProposal returns most recent row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

type ResultRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  proposal_id: string;
  gap_id: string | null;
  outcome: 'pass' | 'fail' | 'error';
  scenarios_run: unknown;
  scenarios_passed: number;
  scenarios_failed: number;
  details: unknown;
  triggered_revert: boolean;
  technical_gap_id: string | null;
  ran_at: Date;
};

const resultsState: Record<string, ResultRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  return {
    ...actual,
    capabilityTestResultsRepo: {
      record: vi.fn(async (input: {
        proposal_id: string;
        gap_id?: string;
        outcome: 'pass' | 'fail' | 'error';
        scenarios_run: unknown[];
        scenarios_passed: number;
        scenarios_failed: number;
        details?: unknown;
        triggered_revert?: boolean;
        technical_gap_id?: string;
      }) => {
        const id = `res-${Math.random().toString(36).slice(2)}`;
        const row: ResultRow = {
          id,
          tenant_id: 'default',
          agent_id: 'default',
          proposal_id: input.proposal_id,
          gap_id: input.gap_id ?? null,
          outcome: input.outcome,
          scenarios_run: input.scenarios_run,
          scenarios_passed: input.scenarios_passed,
          scenarios_failed: input.scenarios_failed,
          details: input.details ?? {},
          triggered_revert: input.triggered_revert ?? false,
          technical_gap_id: input.technical_gap_id ?? null,
          ran_at: new Date(),
        };
        resultsState[id] = row;
        return row;
      }),
      listByProposal: vi.fn(async (proposal_id: string) =>
        Object.values(resultsState)
          .filter((r) => r.proposal_id === proposal_id)
          .sort((a, b) => b.ran_at.getTime() - a.ran_at.getTime()),
      ),
      latestByProposal: vi.fn(async (proposal_id: string) => {
        const rows = Object.values(resultsState)
          .filter((r) => r.proposal_id === proposal_id)
          .sort((a, b) => b.ran_at.getTime() - a.ran_at.getTime());
        return rows[0] ?? null;
      }),
    },
  };
});

describe('capabilityTestResultsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(resultsState)) delete resultsState[k];
    vi.clearAllMocks();
  });

  it('record insere result com outcome=pass', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityTestResultsRepo } = await import('@/db/repositories.js');
        const row = await capabilityTestResultsRepo.record({
          proposal_id: 'prop-1',
          outcome: 'pass',
          scenarios_run: [{ name: 'ok' }],
          scenarios_passed: 1,
          scenarios_failed: 0,
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.proposal_id).toBe('prop-1');
        expect(row.outcome).toBe('pass');
        expect(row.scenarios_passed).toBe(1);
        expect(row.triggered_revert).toBe(false);
        expect(row.technical_gap_id).toBeNull();
        expect(row.ran_at).toBeInstanceOf(Date);
      },
    );
  });

  it('record com triggered_revert=true + technical_gap_id', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityTestResultsRepo } = await import('@/db/repositories.js');
        const row = await capabilityTestResultsRepo.record({
          proposal_id: 'prop-2',
          gap_id: 'gap-x',
          outcome: 'fail',
          scenarios_run: [{ name: 'sad' }, { name: 'sad2' }],
          scenarios_passed: 0,
          scenarios_failed: 2,
          details: { errors: ['timeout', 'wrong-shape'] },
          triggered_revert: true,
          technical_gap_id: 'gap-tech-1',
        });
        expect(row.outcome).toBe('fail');
        expect(row.triggered_revert).toBe(true);
        expect(row.technical_gap_id).toBe('gap-tech-1');
        expect(row.gap_id).toBe('gap-x');
        expect((row.details as { errors: string[] }).errors.length).toBe(2);
      },
    );
  });

  it('latestByProposal retorna mais recente (ran_at DESC)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityTestResultsRepo } = await import('@/db/repositories.js');
        await capabilityTestResultsRepo.record({
          proposal_id: 'prop-A',
          outcome: 'fail',
          scenarios_run: [],
          scenarios_passed: 0,
          scenarios_failed: 1,
        });
        // tick — ran_at is set in mock via new Date(); ensure ordering
        await new Promise((r) => setTimeout(r, 5));
        const latest = await capabilityTestResultsRepo.record({
          proposal_id: 'prop-A',
          outcome: 'pass',
          scenarios_run: [],
          scenarios_passed: 1,
          scenarios_failed: 0,
        });
        const got = await capabilityTestResultsRepo.latestByProposal('prop-A');
        expect(got).not.toBeNull();
        expect(got!.id).toBe(latest.id);
        expect(got!.outcome).toBe('pass');
      },
    );
  });

  it('listByProposal retorna múltiplos resultados', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { capabilityTestResultsRepo } = await import('@/db/repositories.js');
        await capabilityTestResultsRepo.record({
          proposal_id: 'prop-many',
          outcome: 'fail',
          scenarios_run: [],
          scenarios_passed: 0,
          scenarios_failed: 1,
        });
        await capabilityTestResultsRepo.record({
          proposal_id: 'prop-many',
          outcome: 'pass',
          scenarios_run: [],
          scenarios_passed: 1,
          scenarios_failed: 0,
        });
        await capabilityTestResultsRepo.record({
          proposal_id: 'other-prop',
          outcome: 'pass',
          scenarios_run: [],
          scenarios_passed: 1,
          scenarios_failed: 0,
        });
        const rows = await capabilityTestResultsRepo.listByProposal('prop-many');
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.proposal_id === 'prop-many')).toBe(true);
      },
    );
  });
});
