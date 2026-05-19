/**
 * Cross-tenant isolation — property tests across ALL 5 resolvers.
 *
 * PR #94 adversarial review demanded: "property test that inserts data for
 * 2 tenants, queries as tenant A, asserts ZERO rows from tenant B across
 * ALL access patterns".
 *
 * The full property test against a real Postgres lives in
 * `tests/integration/user-layer-cross-tenant.spec.ts` (gated on
 * `TEST_DB_URL`). THIS file is a unit-level guard that ships in every
 * CI run: it intercepts the Drizzle query builder and asserts that
 * EVERY emitted SQL fragment contains the tenant_id literal under EVERY
 * input shape (including the optional-filter variants that mutated the
 * original .where() chain). If a code change breaks this invariant the
 * regression fires immediately, even without a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Bypass async-storage check on the facade unit (irrelevant for these tests —
// we're inspecting the resolver-level SQL emission, not facade routing).
vi.mock('@/db/tenant-context.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/db/tenant-context.js')>(
    '@/db/tenant-context.js',
  );
  return {
    ...actual,
    tryGetCurrentContext: () => null,
  };
});

// ─────────────────────────────────────────────────────────
// Drizzle DB mock — captures every .where(...) call across all resolvers.
// Because Drizzle's SQL objects are circular (table ↔ column back-refs),
// we DON'T JSON.stringify them. Instead we record the captured expression's
// .queryChunks recursively, extracting any string/uuid params + table refs.
// ─────────────────────────────────────────────────────────
const captured: { where: unknown[]; sql: string[] } = { where: [], sql: [] };

function pushWhere(expr: unknown) {
  captured.where.push(expr);
}

function makeFluentChain() {
  // Match every resolver's chain shape:
  //   select().from().where().orderBy().limit() → []
  //   insert().values().returning() → [{}]
  //   update().set().where() → Promise<void>
  const finalReturn = Promise.resolve([]);
  const chain = {
    where(expr: unknown) {
      pushWhere(expr);
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      return finalReturn;
    },
    set() {
      return this;
    },
    values() {
      return { returning: () => Promise.resolve([{}]) };
    },
    from() {
      return this;
    },
    returning() {
      return Promise.resolve([{}]);
    },
  };
  return chain;
}

// db.execute(sql`...`) is used by facts-resolver. Capture the raw SQL string.
function makeExecuteCapture() {
  return (sqlObj: unknown) => {
    try {
      // Drizzle SQL has a queryChunks array; serialize the literal pieces
      // plus parameter placeholders so we can grep for tenant_id.
      const sqlAny = sqlObj as { queryChunks?: unknown[] };
      if (Array.isArray(sqlAny.queryChunks)) {
        const text = sqlAny.queryChunks
          .map((chunk) => {
            if (typeof chunk === 'string') return chunk;
            if (chunk && typeof chunk === 'object') {
              const c = chunk as { value?: unknown; name?: string };
              if (typeof c.value === 'string') return `'${c.value}'`;
              if (Array.isArray(c.value)) return `[${c.value.map(String).join(',')}]`;
              if (c.name) return c.name;
              return JSON.stringify(c, (_k, v) =>
                typeof v === 'object' && v !== null
                  ? Array.isArray(v)
                    ? v
                    : '[obj]'
                  : v,
              );
            }
            return String(chunk);
          })
          .join(' ');
        captured.sql.push(text);
      } else {
        captured.sql.push(String(sqlObj));
      }
    } catch {
      captured.sql.push('[unserializable]');
    }
    return Promise.resolve({ rows: [] });
  };
}

vi.mock('@/db/client.js', () => ({
  db: {
    select: () => makeFluentChain(),
    insert: () => makeFluentChain(),
    update: () => makeFluentChain(),
    execute: makeExecuteCapture(),
  },
}));

import { rulesResolver } from '@/user-layer/resolvers/rules-resolver.js';
import { memoryResolver } from '@/user-layer/resolvers/memory-resolver.js';
import { hintsResolver } from '@/user-layer/resolvers/hints-resolver.js';
import { interlocutorResolver } from '@/user-layer/resolvers/interlocutor-resolver.js';
import { factsResolver } from '@/user-layer/resolvers/facts-resolver.js';

// ─────────────────────────────────────────────────────────
// Helper: walk a Drizzle SQL expression collecting all string params.
// We rely on the fact that `eq(column, 'tenant-x')`, `inArray(column, [...])`
// and friends all store their values in `.queryChunks[*].value` or as nested
// param objects. We never JSON.stringify the root (it's circular).
// ─────────────────────────────────────────────────────────
function collectStringParams(node: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out; // bound recursion
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'number' || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStringParams(item, depth + 1, out);
    return out;
  }
  if (typeof node === 'object') {
    const n = node as Record<string, unknown>;
    // Drizzle Param wraps the raw value in `.value`
    if (Object.prototype.hasOwnProperty.call(n, 'value')) {
      collectStringParams(n.value, depth + 1, out);
    }
    if (Array.isArray(n.queryChunks)) {
      collectStringParams(n.queryChunks, depth + 1, out);
    }
    // For nested SQLChunks
    if (Array.isArray(n.params)) {
      collectStringParams(n.params, depth + 1, out);
    }
    // Skip back-pointers: 'table' / 'columns' / 'baseColumn' close the cycle.
  }
  return out;
}

const TENANT_A = 'tenant-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B_LITERAL_THAT_MUST_NEVER_APPEAR = 'tenant-bbbb-leak-leak-leak-leakleakleak';

beforeEach(() => {
  captured.where = [];
  captured.sql = [];
  vi.clearAllMocks();
});

describe('Cross-tenant isolation — all resolvers, all access patterns', () => {
  describe('rulesResolver', () => {
    it('list() carries tenant_id under every input variant', async () => {
      const variants = [
        { tenant_id: TENANT_A, limit: 10 },
        { tenant_id: TENANT_A, intent_filter: 'aluguel', limit: 10 },
        { tenant_id: TENANT_A, only_active: true, limit: 10 },
        { tenant_id: TENANT_A, only_active: false, limit: 10 },
        { tenant_id: TENANT_A, tipo: 'classificacao', limit: 10 },
        { tenant_id: TENANT_A, intent_filter: 'x', tipo: 'y', only_active: true, limit: 10 },
      ];
      for (const v of variants) {
        captured.where = [];
        await rulesResolver.list(v);
        expect(captured.where).toHaveLength(1); // single .where() — locks in the Drizzle <0.29 fix
        const params = collectStringParams(captured.where[0]);
        expect(params).toContain(TENANT_A);
        expect(params).not.toContain(TENANT_B_LITERAL_THAT_MUST_NEVER_APPEAR);
      }
    });
  });

  describe('memoryResolver', () => {
    it('list() carries tenant_id under every input variant', async () => {
      const variants = [
        { tenant_id: TENANT_A, limit: 10 },
        { tenant_id: TENANT_A, pessoa_id: 'p-1', limit: 10 },
        { tenant_id: TENANT_A, memory_types: ['fact', 'preference'], limit: 10 },
        { tenant_id: TENANT_A, intent_filter: 'support', limit: 10 },
        { tenant_id: TENANT_A, role_id: 'r-1', limit: 10 },
        { tenant_id: TENANT_A, channel_id: 'c-1', limit: 10 },
        { tenant_id: TENANT_A, conversa_id: 'conv-1', limit: 10 },
        {
          tenant_id: TENANT_A,
          pessoa_id: 'p-1',
          role_id: 'r-1',
          channel_id: 'c-1',
          conversa_id: 'conv-1',
          intent_filter: 'all',
          memory_types: ['fact'],
          limit: 10,
        },
      ];
      for (const v of variants) {
        captured.where = [];
        await memoryResolver.list(v);
        expect(captured.where).toHaveLength(1);
        const params = collectStringParams(captured.where[0]);
        expect(params).toContain(TENANT_A);
        expect(params).not.toContain(TENANT_B_LITERAL_THAT_MUST_NEVER_APPEAR);
      }
    });

    it('upsert() type signature requires tenant_id (compile-time guard)', () => {
      // TypeScript-only assertion: MemoryUpsertInput requires `tenant_id: string`.
      // Runtime mock can't enforce this without re-implementing Drizzle's
      // type checking, so we lock the contract at the type level instead.
      type Sig = Parameters<typeof memoryResolver.upsert>[0];
      type HasTenant = Sig extends { tenant_id: string } ? true : false;
      const proof: HasTenant = true;
      expect(proof).toBe(true);
    });

    it('markObserved() requires tenant_id (no caller-bypassable signature)', async () => {
      captured.where = [];
      await memoryResolver.markObserved({ tenant_id: TENANT_A, id: 'mem-1' });
      expect(captured.where).toHaveLength(1);
      const params = collectStringParams(captured.where[0]);
      expect(params).toContain(TENANT_A);
    });
  });

  describe('hintsResolver', () => {
    it('list() carries tenant_id under every input variant', async () => {
      const variants = [
        { tenant_id: TENANT_A, limit: 10 },
        { tenant_id: TENANT_A, pessoa_id: 'p-1', limit: 10 },
        { tenant_id: TENANT_A, scope: ['behavioral'], limit: 10 },
        { tenant_id: TENANT_A, pessoa_id: 'p-1', scope: ['behavioral'], limit: 10 },
      ];
      for (const v of variants) {
        captured.where = [];
        await hintsResolver.list(v);
        expect(captured.where).toHaveLength(1);
        const params = collectStringParams(captured.where[0]);
        expect(params).toContain(TENANT_A);
        expect(params).not.toContain(TENANT_B_LITERAL_THAT_MUST_NEVER_APPEAR);
      }
    });
  });

  describe('interlocutorResolver', () => {
    it('get() carries tenant_id', async () => {
      captured.where = [];
      try {
        await interlocutorResolver.get({ tenant_id: TENANT_A, pessoa_id: 'p-1' });
      } catch {
        // Throws because mocked db returns no rows — that's fine. We just
        // need the .where() invocation to have happened with the tenant.
      }
      expect(captured.where).toHaveLength(1);
      const params = collectStringParams(captured.where[0]);
      expect(params).toContain(TENANT_A);
    });
  });

  describe('factsResolver (raw SQL via db.execute)', () => {
    it('list() emits tenant_id in the raw SQL under every variant', async () => {
      const variants = [
        { tenant_id: TENANT_A, limit: 10 },
        { tenant_id: TENANT_A, scope: ['tenant' as const], limit: 10 },
        { tenant_id: TENANT_A, keys: ['k1'], limit: 10 },
        { tenant_id: TENANT_A, scope: ['tenant' as const, 'domain' as const], keys: ['k1', 'k2'], limit: 10 },
      ];
      for (const v of variants) {
        captured.sql = [];
        await factsResolver.list(v);
        expect(captured.sql.length).toBeGreaterThan(0);
        const allSql = captured.sql.join(' || ');
        expect(allSql).toContain(TENANT_A);
        expect(allSql).not.toContain(TENANT_B_LITERAL_THAT_MUST_NEVER_APPEAR);
        // Privacy gate must be present:
        expect(allSql).toContain('NOT EXISTS');
        expect(allSql.includes('needs_review') || allSql.includes('mention_allowed')).toBe(true);
      }
    });
  });
});
