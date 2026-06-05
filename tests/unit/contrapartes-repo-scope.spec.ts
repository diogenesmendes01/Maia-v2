/**
 * Issue #431 — DB-free proof that the NEW `contrapartesRepo` search methods
 * (`byDocumento`, `searchByName`, `byIdScoped`) pin `tenant_id + agent_id` from
 * the ALS context (on top of the entidade scope) in their WHERE clause.
 *
 * WHY THIS MATTERS (invariant #1 / the issue's security fix): the PRE-EXISTING
 * read path is NOT tenant-pinned — `byId` filters by `id` only, `byScope` by
 * `entidade_id` only. `contrapartes.documento` and `.nome` have NO unique index,
 * so an unscoped CNPJ/name lookup would read ACROSS TENANTS. These methods MUST
 * add the tenant/agent predicate, or a boleto adapter (`company_search` /
 * `company_identity_resolver`) leaks another tenant's counterparty.
 *
 * The Postgres-gated leak suite (`tests/integration/repos-leak.spec.ts`) proves
 * isolation against a real DB but only runs with a DB. This unit test compiles
 * the repo's ACTUAL WHERE clause with the Pg dialect and asserts the tenant/agent
 * predicate + bound params are present — so the invariant is proven on CI lanes
 * without a database. Mirrors EXACTLY `agent-tool-grants-repo-scope.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { runWithTenantContext } from '../../src/db/tenant-context.js';

// Capture every `.where(...)` condition the repo builds.
const captured: SQL[] = [];

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: SQL) => {
      captured.push(w);
      return chain;
    },
    limit: () => Promise.resolve([]),
    // Thenable so `await db.select().from().where()` (no .limit) resolves.
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

const SCOPE = { pessoa_id: 'p1', entidades: ['ent-A'] };

beforeEach(() => {
  captured.length = 0;
});

describe('contrapartesRepo — ALS tenant+agent predicate on new search methods (DB-free, #431)', () => {
  it('byDocumento scopes by tenant_id + agent_id + entidade and normalizes the document', async () => {
    const { contrapartesRepo } = await import('../../src/db/repositories.js');
    await runWithTenantContext({ tenant_id: 'tA', agent_id: 'agA' }, () =>
      contrapartesRepo.byDocumento(SCOPE, '12.345.678/0001-90'),
    );
    expect(captured).toHaveLength(1);
    const { sql, params } = compile(captured[0]!);
    expect(sql).toMatch(/tenant_id/);
    expect(sql).toMatch(/agent_id/);
    expect(sql).toMatch(/entidade_id/);
    // tenant/agent/entidade + the digits-only document are all bound params.
    expect(params).toEqual(expect.arrayContaining(['tA', 'agA', 'ent-A', '12345678000190']));
  });

  it('searchByName scopes by tenant_id + agent_id + entidade', async () => {
    const { contrapartesRepo } = await import('../../src/db/repositories.js');
    await runWithTenantContext({ tenant_id: 'tB', agent_id: 'agB' }, () =>
      contrapartesRepo.searchByName(SCOPE),
    );
    expect(captured).toHaveLength(1);
    const { sql, params } = compile(captured[0]!);
    expect(sql).toMatch(/tenant_id/);
    expect(sql).toMatch(/agent_id/);
    expect(sql).toMatch(/entidade_id/);
    expect(params).toEqual(expect.arrayContaining(['tB', 'agB', 'ent-A']));
  });

  it('byIdScoped scopes by id + tenant_id + agent_id + entidade', async () => {
    const { contrapartesRepo } = await import('../../src/db/repositories.js');
    await runWithTenantContext({ tenant_id: 'tC', agent_id: 'agC' }, () =>
      contrapartesRepo.byIdScoped(SCOPE, 'cp-id-1'),
    );
    expect(captured).toHaveLength(1);
    const { sql, params } = compile(captured[0]!);
    expect(sql).toMatch(/tenant_id/);
    expect(sql).toMatch(/agent_id/);
    expect(sql).toMatch(/entidade_id/);
    expect(params).toEqual(expect.arrayContaining(['cp-id-1', 'tC', 'agC', 'ent-A']));
  });

  it('every new search method throws EmptyScopeError on an empty entidade scope (no implicit broadening)', async () => {
    const { contrapartesRepo, EmptyScopeError } = await import('../../src/db/repositories.js');
    const empty = { pessoa_id: 'p', entidades: [] };
    await runWithTenantContext({ tenant_id: 'tD', agent_id: 'agD' }, async () => {
      await expect(contrapartesRepo.byDocumento(empty, '123')).rejects.toBeInstanceOf(
        EmptyScopeError,
      );
      await expect(contrapartesRepo.searchByName(empty)).rejects.toBeInstanceOf(EmptyScopeError);
      await expect(contrapartesRepo.byIdScoped(empty, 'x')).rejects.toBeInstanceOf(
        EmptyScopeError,
      );
    });
  });
});
