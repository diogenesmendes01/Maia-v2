import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Issue #525 — publisher coverage for the `self_awareness` cache resource.
 *
 * #511 removed `capabilities` and `gaps` from the cache because the coverage
 * was partial, and "partial coverage reads as a guarantee". Bringing them back
 * is only defensible if the coverage is now TOTAL, so this spec asserts it the
 * only way that means anything: one test per mutating method, plus a structural
 * check that the list of mutating methods is the whole list.
 *
 * The structural half matters more than the per-method half. The two tables are
 * written ONLY through `capabilitiesSkillRepo` and `capabilityGapsRepo` — so if
 * every write-shaped method there publishes, coverage is complete by
 * construction rather than by audit. The last test enumerates the repo surface
 * and fails when a new mutating method appears without a publisher, which is the
 * failure mode that would otherwise reintroduce exactly the #511 bug.
 */

const h = vi.hoisted(() => ({
  published: [] as Array<{ tenant_id: string; agent_id: string | null; resource: string }>,
  /** Rows the SELECT half of `upsert`/`upsertConfidence` finds. */
  existingRows: [] as unknown[],
}));

vi.mock('../../src/agent/turn-context/cache.js', () => ({
  publishTurnContextInvalidation: vi.fn(async (args: { resource: string }) => {
    h.published.push(args as never);
  }),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/**
 * A drizzle-shaped double. Every builder chain used by the mutating methods
 * bottoms out in a thenable that resolves to `h.existingRows` (SELECT) or a
 * one-row array (INSERT … RETURNING).
 */
vi.mock('../../src/db/client.js', () => {
  const chain = (rows: () => unknown[]): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'set', 'values', 'returning', 'orderBy']) {
      node[m] = () => node;
    }
    node.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve);
    return node;
  };
  return {
    db: {
      select: () => chain(() => h.existingRows),
      insert: () => chain(() => [{ id: 'new-row' }]),
      update: () => chain(() => [{ id: 'updated' }]),
      execute: async () => ({ rows: [] }),
    },
    withTx: async (fn: (tx: unknown) => unknown) => fn({}),
    pgErrorCode: () => undefined,
  };
});

vi.mock('../../src/db/tenant-context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/tenant-context.js')>();
  return {
    ...actual,
    getCurrentTenant: () => 'acme',
    getCurrentAgent: () => 'agent-1',
  };
});

vi.mock('../../src/db/tenant-guard.js', () => ({
  applyTenantGuard: (input: Record<string, unknown>) => ({
    ...input,
    tenant_id: 'acme',
    agent_id: 'agent-1',
  }),
}));

import {
  capabilitiesSkillRepo,
  capabilityGapsRepo,
} from '../../src/db/repositories/capability-repos.js';
import { GapLevel } from '../../src/types/enums.js';

function selfAwarenessEvents(): typeof h.published {
  return h.published.filter((e) => e.resource === 'self_awareness');
}

describe('#525 self_awareness invalidation coverage', () => {
  beforeEach(() => {
    h.published.length = 0;
    h.existingRows = [];
  });

  it('publishes when a skill is created', async () => {
    await capabilitiesSkillRepo.upsertConfidence('financeiro', 'conciliar', { confidence: '0.9' });
    expect(selfAwarenessEvents()).toHaveLength(1);
    expect(selfAwarenessEvents()[0]).toMatchObject({ tenant_id: 'acme', agent_id: 'agent-1' });
  });

  it('publishes when a skill confidence is updated (rollback / revocation path)', async () => {
    // The catalogue has no delete: a revocation or a rollback lands here as a
    // confidence update, which is what makes this the skill-side coverage.
    h.existingRows = [{ id: 'skill-1' }];
    await capabilitiesSkillRepo.upsertConfidence('financeiro', 'conciliar', { confidence: '0.0' });
    expect(selfAwarenessEvents()).toHaveLength(1);
  });

  it('publishes when a gap is created through upsert (learning loop)', async () => {
    await capabilityGapsRepo.upsert({ capability_description: 'emitir nf', tipo: 'tool' });
    expect(selfAwarenessEvents()).toHaveLength(1);
  });

  it('publishes when an existing gap is reinforced through upsert', async () => {
    h.existingRows = [{ id: 'gap-1', frequency_score: 2 }];
    await capabilityGapsRepo.upsert({ capability_description: 'emitir nf', tipo: 'tool' });
    expect(selfAwarenessEvents()).toHaveLength(1);
  });

  it('publishes when a gap is created directly (capability revert)', async () => {
    await capabilityGapsRepo.create({ capability_description: 'ler boleto', tipo: 'tool' });
    expect(selfAwarenessEvents()).toHaveLength(1);
  });

  it('publishes on every gap LEVEL transition', async () => {
    // The escalation chain silent → dashboard → mentionable → proposed is what
    // decides whether a gap is visible in the prompt at all, so each hop must
    // drop the cached snapshot.
    for (const level of [
      GapLevel.DASHBOARD,
      GapLevel.MENTIONABLE,
      GapLevel.PROPOSED,
      GapLevel.SILENT,
    ]) {
      h.published.length = 0;
      await capabilityGapsRepo.updateLevel({ id: 'gap-1', new_level: level });
      expect(selfAwarenessEvents(), `level ${level}`).toHaveLength(1);
    }
  });

  it('scopes every event to the running tenant AND agent', async () => {
    await capabilityGapsRepo.updateLevel({ id: 'gap-1', new_level: GapLevel.MENTIONABLE });
    for (const e of selfAwarenessEvents()) {
      expect(e.tenant_id).toBe('acme');
      // Never a tenant-wide (`agent_id: null`) flush: a gap belongs to one
      // agent, and dropping every agent's entry would be a self-inflicted
      // thundering herd on a busy tenant.
      expect(e.agent_id).toBe('agent-1');
    }
  });

  /**
   * The structural guarantee. If a new mutating method lands on either repo
   * without a publisher, this fails — which is the whole reason
   * `capabilities`/`gaps` are allowed in the cache again.
   */
  it('leaves no mutating method on either repo without a publisher', async () => {
    const mutating = {
      'capabilitiesSkillRepo.upsertConfidence': () =>
        capabilitiesSkillRepo.upsertConfidence('d', 's', {}),
      'capabilityGapsRepo.upsert': () =>
        capabilityGapsRepo.upsert({ capability_description: 'x', tipo: 'tool' }),
      'capabilityGapsRepo.create': () =>
        capabilityGapsRepo.create({ capability_description: 'x', tipo: 'tool' }),
      'capabilityGapsRepo.updateLevel': () =>
        capabilityGapsRepo.updateLevel({ id: 'g', new_level: GapLevel.MENTIONABLE }),
    };

    // 1. The enumeration is complete: no write-shaped method on either repo is
    //    missing from the table above.
    const writeShaped = (obj: object): string[] =>
      Object.keys(obj).filter((k) => /^(upsert|create|update|delete|revoke|set)/i.test(k));
    expect(writeShaped(capabilitiesSkillRepo).sort()).toEqual(['upsertConfidence']);
    expect(writeShaped(capabilityGapsRepo).sort()).toEqual(['create', 'updateLevel', 'upsert']);

    // 2. Each one publishes.
    for (const [name, call] of Object.entries(mutating)) {
      h.published.length = 0;
      h.existingRows = [];
      await call();
      expect(selfAwarenessEvents(), name).toHaveLength(1);
    }
  });
});
