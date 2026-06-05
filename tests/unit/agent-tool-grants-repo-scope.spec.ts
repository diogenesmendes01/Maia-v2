/**
 * Issue #408 — DB-free proof that `agentToolGrantsRepo` binds the
 * (tenant_id, agent_id) predicate from the ALS context on every read.
 *
 * The Postgres-gated leak suite (agent-tool-grants-leak.spec.ts) proves
 * isolation against a real DB, but only runs with TEST_DB_URL. This unit test
 * compiles the repo's actual WHERE clause with the Pg dialect and asserts the
 * tenant/agent predicate is present — so the isolation invariant (#1) is proven
 * even on CI lanes without a database. Mirrors EXACTLY the #407 pattern in
 * tests/unit/agent-audience-profiles-repo-scope.spec.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { runWithTenantContext } from '../../src/db/tenant-context.js';

// Capture every `.where(...)` condition the repo builds. Declared before
// vi.mock; the factory closes over it and runs lazily on first import.
const captured: SQL[] = [];

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: SQL) => {
      captured.push(w);
      return chain;
    },
    limit: () => Promise.resolve([]),
    // Thenable so `await db.select().from().where()` (list, no .limit) resolves.
    then: (resolve: (v: unknown) => unknown) => resolve([]),
  };
  return chain;
}

vi.mock('../../src/db/client.js', () => ({
  db: { select: () => makeChain() },
  withTx: vi.fn(),
  pgErrorCode: () => undefined,
}));

function compile(where: SQL): { sql: string; params: unknown[] } {
  const q = new PgDialect().sqlToQuery(where);
  return { sql: q.sql, params: q.params as unknown[] };
}

beforeEach(() => {
  captured.length = 0;
});

describe('agentToolGrantsRepo — ALS predicate (DB-free, #408)', () => {
  it('findForCurrentAgent scopes by tenant_id + agent_id from the ALS context', async () => {
    const { agentToolGrantsRepo } = await import('../../src/db/repositories.js');
    await runWithTenantContext({ tenant_id: 'tA', agent_id: 'agA' }, () =>
      agentToolGrantsRepo.findForCurrentAgent(),
    );
    expect(captured).toHaveLength(1);
    const { sql, params } = compile(captured[0]!);
    expect(sql).toMatch(/tenant_id/);
    expect(sql).toMatch(/agent_id/);
    expect(params).toEqual(expect.arrayContaining(['tA', 'agA']));
  });
});
