/**
 * Flip-safety for the emergency kill-switch `src/governance/lockdown.ts` (#355).
 *
 * DISPOSITION = PER-TENANT (see lockdown.ts header): `activateLockdown`/
 * `liftLockdown` touch only per-tenant tables (`pessoas`, `permissoes`,
 * `entity_states`), so they bind `tenant_id`/`agent_id` from ALS and scope every
 * query to the running tuple — NOT `runWithSystemContext`.
 *
 * These tests prove the function no longer relies on the `'default'` literal and
 * works under `MAIA_REJECT_DEFAULT_LITERAL`:
 *   1. Outside any ALS context → MissingTenantContextError (fail-loud).
 *   2. Under the legacy `'default'` literal WITH the flag on → DefaultLiteralRejectedError
 *      (it no longer silently runs on the rejected sentinel).
 *   3. Under a REAL tenant/agent WITH the flag on → succeeds, and the DB work +
 *      audit observe that real context (proving the queries are tenant-scoped).
 *
 * `db` is mocked as a chainable Drizzle stub; `entityStatesRepo` and `audit` are
 * mocked and capture the live ALS context to prove the real bind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runWithTenantContext,
  runWithSystemContext,
  MissingTenantContextError,
  DefaultLiteralRejectedError,
} from '../../src/db/tenant-context.js';

// --- chainable db stub -------------------------------------------------------
// select().from().where() resolves to a controllable row array (awaitable).
// update().set().where() resolves to undefined (awaitable). We capture how many
// times each terminal ran so the tests can assert the queries fired.
let selectRows: unknown[] = [];
const updateWhereMock = vi.fn().mockResolvedValue(undefined);

const dbMock = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(selectRows)),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: updateWhereMock,
    })),
  })),
};

vi.mock('../../src/db/client.js', () => ({ db: dbMock }));

// entityStatesRepo + audit are real-context consumers; mock them and record the
// ALS context they observe.
const observedContexts: Array<{ tenant_id: string; agent_id: string } | null> = [];
const entityByIdMock = vi.fn();
const entityUpsertMock = vi.fn();
const auditMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  entityStatesRepo: {
    byId: (...args: unknown[]) => entityByIdMock(...args),
    upsert: (...args: unknown[]) => entityUpsertMock(...args),
  },
}));

vi.mock('../../src/governance/audit.js', () => ({
  audit: async (...args: unknown[]) => {
    const { tryGetCurrentContext } = await import('../../src/db/tenant-context.js');
    observedContexts.push(tryGetCurrentContext());
    return auditMock(...args);
  },
}));

beforeEach(() => {
  selectRows = [];
  updateWhereMock.mockClear();
  dbMock.select.mockClear();
  dbMock.update.mockClear();
  entityByIdMock.mockReset().mockResolvedValue(null);
  entityUpsertMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockReset().mockResolvedValue(undefined);
  observedContexts.length = 0;
});

const REAL = { tenant_id: 'acme', agent_id: 'fin-agent' };

describe('governance/lockdown flip-safety (#355)', () => {
  it('activateLockdown throws MissingTenantContextError outside any ALS context', async () => {
    const { activateLockdown } = await import('../../src/governance/lockdown.js');
    await expect(activateLockdown('actor-1')).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('liftLockdown throws MissingTenantContextError outside any ALS context', async () => {
    const { liftLockdown } = await import('../../src/governance/lockdown.js');
    await expect(liftLockdown('actor-1')).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('activateLockdown rejects the legacy default literal when the flag is on', async () => {
    const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    try {
      const { activateLockdown } = await import('../../src/governance/lockdown.js');
      await expect(
        runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () =>
          activateLockdown('actor-1'),
        ),
      ).rejects.toBeInstanceOf(DefaultLiteralRejectedError);
      // It threw at the bind (before any DB work) — no silent run on the sentinel.
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      else process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    }
  });

  it('liftLockdown rejects the legacy default literal when the flag is on', async () => {
    const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    try {
      const { liftLockdown } = await import('../../src/governance/lockdown.js');
      await expect(
        runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, () =>
          liftLockdown('actor-1'),
        ),
      ).rejects.toBeInstanceOf(DefaultLiteralRejectedError);
      expect(dbMock.select).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      else process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    }
  });

  it('activateLockdown runs under a REAL tenant/agent with the flag on (no default reliance)', async () => {
    const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    try {
      // No owners, no active permissões → nothing to suspend, but the full query
      // path + audit still run under the real context.
      selectRows = [];
      const { activateLockdown } = await import('../../src/governance/lockdown.js');
      const res = await runWithTenantContext(REAL, () => activateLockdown('actor-1'));

      expect(res).toEqual({ suspended: 0 });
      // The owner-lookup + active-permissões SELECTs ran under the real tuple.
      expect(dbMock.select).toHaveBeenCalled();
      // audit() observed the REAL context (not 'default', not 'system').
      expect(observedContexts).toHaveLength(1);
      expect(observedContexts[0]).toEqual(REAL);
    } finally {
      if (prev === undefined) delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      else process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    }
  });

  it('liftLockdown restores from this tenant snapshot and audits under the real context', async () => {
    const prev = process.env.MAIA_REJECT_DEFAULT_LITERAL;
    process.env.MAIA_REJECT_DEFAULT_LITERAL = 'true';
    try {
      // First select (non-owner pessoas) is ignored; second select (entity_states)
      // returns one row carrying a lockdown snapshot with one suspended permissão.
      // Both selects share the same stub, so return the snapshot-bearing row.
      selectRows = [
        {
          entidade_id: 'ent-1',
          flags: { lockdown_snapshot: [{ id: 'perm-1', status_before: 'ativa' }] },
        },
      ];
      const { liftLockdown } = await import('../../src/governance/lockdown.js');
      const res = await runWithTenantContext(REAL, () => liftLockdown('actor-1'));

      expect(res).toEqual({ restored: 1 });
      // The permissão restore UPDATE fired.
      expect(updateWhereMock).toHaveBeenCalledTimes(1);
      // entity_states snapshot cleared via the (tenant-scoped) repo upsert.
      expect(entityUpsertMock).toHaveBeenCalledTimes(1);
      // audit observed the real context.
      expect(observedContexts).toEqual([REAL]);
    } finally {
      if (prev === undefined) delete process.env.MAIA_REJECT_DEFAULT_LITERAL;
      else process.env.MAIA_REJECT_DEFAULT_LITERAL = prev;
    }
  });

  it('is NOT wrapped in system context — running under system still does the tenant-scoped work as system', async () => {
    // Defensive: the kill-switch must NOT self-elevate to `system`. If a caller
    // explicitly opens system context, the function honors THAT context (it does
    // not silently rewrite it), proving the disposition lives at the call site,
    // not hard-coded inside lockdown.
    selectRows = [];
    const { activateLockdown } = await import('../../src/governance/lockdown.js');
    const res = await runWithSystemContext(() => activateLockdown('actor-1'));
    expect(res).toEqual({ suspended: 0 });
    expect(observedContexts[0]).toEqual({ tenant_id: 'system', agent_id: 'system' });
  });
});
