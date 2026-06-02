/**
 * Review 2 — Blocker 2: `started_at` must be set on transitions into
 * `awaiting_third_party` and `awaiting_owner`, not just `in_progress`.
 * Otherwise the `listAwaitingTimedOut` query (which filters on
 * `started_at IS NOT NULL`) never matches and recurring_outreach
 * timeouts never fire.
 *
 * We exercise the transactional setStatus (used by the engine inside
 * advanceWithTx) and the standalone setStatus (used by status-only
 * transitions). Both paths must anchor the timestamp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '../../src/db/tenant-context.js';

// Issue #355: setStatus is now tenant-scoped + fail-loud (asserts the UPDATE
// matched exactly one row via `.returning({ id })`). The update chain therefore
// resolves to a non-empty array on `.returning()`. We run every call inside a
// tenant context so `getCurrentTenant()/getCurrentAgent()` resolve.
const TENANT = { tenant_id: 'tenant-A', agent_id: 'agent-A' };

const updateCalls: Array<{ table: unknown; set: Record<string, unknown> }> = [];

const setMock = vi.fn(function (this: Record<string, unknown>, payload: Record<string, unknown>) {
  // Track the most recent set() call for assertion below.
  updateCalls.push({ table: this['table'], set: payload });
  return this;
});
const whereMock = vi.fn(function (this: Record<string, unknown>) {
  return this;
});
// `.returning()` is the fail-loud row-count probe — return one row so
// assertMutated sees a successful single-row update.
const returningMock = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
const updateChain = { set: setMock, where: whereMock, returning: returningMock };
const updateMock = vi.fn(() => {
  return updateChain;
});

const txMock = { update: updateMock, select: vi.fn(), insert: vi.fn() };
const withTxMock = vi.fn(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));

vi.mock('../../src/db/client.js', () => ({
  db: { update: updateMock, select: vi.fn(), insert: vi.fn() },
  withTx: withTxMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  updateCalls.length = 0;
  setMock.mockClear();
  whereMock.mockClear();
  returningMock.mockClear().mockResolvedValue([{ id: 'row-1' }]);
  updateMock.mockClear();
});

describe('occurrencesRepo.setStatus — started_at anchor (Blocker 2 review 2)', () => {
  it('status=in_progress sets started_at', async () => {
    const { occurrencesRepo } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () => occurrencesRepo.setStatus('occ-1', 'in_progress'));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.set).toHaveProperty('started_at');
    expect(updateCalls[0]!.set.started_at).toBeInstanceOf(Date);
  });

  it('status=awaiting_third_party sets started_at (CRITICAL — was the bug)', async () => {
    const { occurrencesRepo } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () => occurrencesRepo.setStatus('occ-2', 'awaiting_third_party'));
    expect(updateCalls[0]!.set).toHaveProperty('started_at');
    expect(updateCalls[0]!.set.started_at).toBeInstanceOf(Date);
  });

  it('status=awaiting_owner sets started_at (parallel fix)', async () => {
    const { occurrencesRepo } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () => occurrencesRepo.setStatus('occ-3', 'awaiting_owner'));
    expect(updateCalls[0]!.set).toHaveProperty('started_at');
    expect(updateCalls[0]!.set.started_at).toBeInstanceOf(Date);
  });

  it('status=pending does NOT touch started_at', async () => {
    const { occurrencesRepo } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () => occurrencesRepo.setStatus('occ-4', 'pending'));
    expect(updateCalls[0]!.set).not.toHaveProperty('started_at');
  });

  it('status=completed sets completed_at, not started_at', async () => {
    const { occurrencesRepo } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () => occurrencesRepo.setStatus('occ-5', 'completed'));
    expect(updateCalls[0]!.set).not.toHaveProperty('started_at');
    expect(updateCalls[0]!.set).toHaveProperty('completed_at');
  });

  it('transactional setStatus (via advanceWithTx) also anchors started_at on awaiting_*', async () => {
    const { advanceWithTx } = await import('../../src/scheduling/repos.js');
    await runWithTenantContext(TENANT, () =>
      advanceWithTx(async (_tx, repos) => {
        await repos.occurrences.setStatus('occ-tx', 'awaiting_third_party');
      }),
    );
    expect(updateCalls[0]!.set).toHaveProperty('started_at');
    expect(updateCalls[0]!.set.started_at).toBeInstanceOf(Date);
  });
});
