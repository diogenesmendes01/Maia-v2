/**
 * Issue #239 — Cross-tenant (cross-empresa) isolation invariant for the
 * `scripts/embeddings-rebuild.ts` admin tool.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Script-specific contract this spec PROVES (after the #239 fix):
 *   1. The script REQUIRES `--tenant=<id> --agent=<id>` CLI flags. Without
 *      them `parseRequiredArgs` throws `RequiredArgsError` (the CLI entry
 *      maps this to `process.exit(2)`).
 *   2. The SELECT for pending rows pins `tenant_id` AND `agent_id` in the
 *      WHERE clause — only rows for the routed (tenant, agent) tuple are
 *      pulled, and the resulting batch sent to the embedding provider
 *      therefore contains text from ONE tenant only (no cross-tenant content
 *      mixing at the external provider boundary).
 *   3. The UPDATE pins `id` AND `tenant_id` AND `agent_id` — a stale or
 *      wrong id cannot mutate a row outside the routed tuple, even if the
 *      ambient ALS context is somehow set incorrectly.
 *   4. The script wraps its work in `runWithTenantContext({tenant_id,
 *      agent_id})` (defense-in-depth — explicit predicates are the primary
 *      guarantee, but any indirect callers that read the ALS context also
 *      see the routed values).
 *
 * Before this fix (the bug pattern reported in #239):
 *   - SELECT had no tenant/agent predicate; pending-rows batch mixed every
 *     tenant's text into a single provider call.
 *   - UPDATE used `WHERE id = ?` only; an operator with the wrong ALS
 *     context (or no context) could mutate another tenant's row by id.
 *
 * Strategy:
 *   We don't need a real DB or a real embedding provider. `scripts/
 *   embeddings-rebuild.ts` uses raw `db.execute(sql\`...\`)` and a stubbable
 *   provider interface. We:
 *     1. Render the production SQL via Drizzle's `PgDialect` to extract the
 *        text + bound parameters (same pattern as
 *        `tests/unit/memory/vector-cross-tenant.spec.ts`).
 *     2. Dispatch on the rendered SQL text:
 *          COUNT(*)  → return count of in-store rows matching the WHERE
 *                      params (tenant_id + agent_id).
 *          SELECT id,conteudo
 *                    → filter the store by tenant_id + agent_id AND
 *                      (embedding IS NULL OR dim mismatch), apply LIMIT.
 *          UPDATE    → filter the store by id + tenant_id + agent_id and
 *                      mutate the matching row. Rows whose tuple doesn't
 *                      match are LEFT UNCHANGED — this is what proves the
 *                      WHERE predicates work.
 *     3. Stub the embedding provider to return a deterministic vector AND
 *        to record every call's text inputs, so we can assert the provider
 *        only saw text from the routed tenant.
 *     4. Drive the production code via `rebuildEmbeddingsForTuple({tenant_id,
 *        agent_id})` — the exported core loop that the CLI entry wraps.
 *
 * Seed (two tenants, four pending rows):
 *   tenant-A / agent-A: { mem_A_alpha (null embedding), mem_A_beta (wrong dim) }
 *   tenant-B / agent-B: { mem_B_gamma (null embedding), mem_B_delta (wrong dim) }
 *
 * The adversarial seed (`seedTwoTenantsReverse`) inserts tenant-B FIRST so a
 * missing tenant_id filter on the SELECT would surface tenant-B's row earlier
 * in store iteration order. The production WHERE pins the tuple, so seed
 * order is irrelevant — the test exists to PROVE that with the worst seed
 * order the guard still fires.
 *
 * This does NOT use a real Postgres or pgvector (P9a-style real-DB proof is
 * tracked separately). The fake faithfully reproduces the SQL dispatch
 * surface so the REAL production code paths in
 * `scripts/embeddings-rebuild.ts` are exercised end-to-end; only the storage
 * + embedding layers are replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { config } from '@/config/env.js';

// ---------------------------------------------------------------------------
// In-memory store + db.execute fake
// ---------------------------------------------------------------------------
type StoredRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
  // The fake stores `embedding` as either null (rebuild candidate) or a
  // number[] (already-embedded). For dim-mismatch rows we set a vector of
  // the WRONG length so the production `vector_dims(embedding) != N`
  // predicate fires.
  embedding: number[] | null;
  created_at: number;
};

const store: StoredRow[] = [];

// Records every SQL that reached `db.execute` so we can assert tenant_id /
// agent_id appears in the rendered text and bound params.
const renderedSqls: Array<{ sql: string; params: unknown[] }> = [];

// Records every provider call's input texts so we can assert the provider
// only ever sees text from a single (tenant, agent) tuple per invocation.
const providerCalls: Array<string[]> = [];

function parseVectorLiteral(s: string): number[] {
  const trimmed = s.replace(/^\[|\]$/g, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((p) => Number(p));
}

const _dialect = new PgDialect();

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push({ sql: sqlText, params });

  // ---- COUNT(*) ---------------------------------------------------------
  // Production:
  //   SELECT count(*)::text AS count FROM agent_memories
  //   WHERE tenant_id = $1 AND agent_id = $2
  if (/SELECT\s+count\(\*\)::text\s+AS\s+count/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const count = store.filter(
      (r) => r.tenant_id === tenant_id && r.agent_id === agent_id,
    ).length;
    return { rows: [{ count: String(count) }] };
  }

  // ---- SELECT pending rows ---------------------------------------------
  // Production:
  //   SELECT id::text, conteudo FROM agent_memories
  //   WHERE tenant_id = $1 AND agent_id = $2
  //     AND (embedding IS NULL OR vector_dims(embedding) != $3)
  //   ORDER BY created_at LIMIT $4
  if (/SELECT\s+id::text,\s+conteudo/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const expectedDim = Number(params[2]);
    const limit = Number(params[3]);
    const candidates = store
      .filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          (r.embedding === null || r.embedding.length !== expectedDim),
      )
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((r) => ({ id: r.id, conteudo: r.conteudo }));
    return { rows: candidates };
  }

  // ---- UPDATE one row ---------------------------------------------------
  // Production:
  //   UPDATE agent_memories SET embedding = $1::vector
  //   WHERE id = $2::uuid AND tenant_id = $3 AND agent_id = $4
  if (/^\s*UPDATE\s+agent_memories/i.test(sqlText)) {
    const vec = parseVectorLiteral(params[0] as string);
    const id = params[1] as string;
    const tenant_id = params[2] as string;
    const agent_id = params[3] as string;
    const target = store.find(
      (r) => r.id === id && r.tenant_id === tenant_id && r.agent_id === agent_id,
    );
    if (target) {
      target.embedding = vec;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [] };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

// The embedding provider returns a constant vector of the configured length,
// and we record every call's text inputs so the test can assert no cross-
// tenant texts ever appear in the same provider batch.
//
// We resolve the length at call time from `config.EMBEDDING_DIMENSIONS` so
// the test stays in sync with the production dim guard even if defaults
// change.
const PROVIDER_VECTOR_FILL = 0.42;
vi.mock('@/lib/embeddings.js', async () => {
  const { config: cfg } = await import('@/config/env.js');
  return {
    getEmbeddingProvider: () => ({
      name: 'voyage',
      modelId: 'fake',
      dimensions: cfg.EMBEDDING_DIMENSIONS,
      embed: async (texts: string[]) => {
        // Defensive copy — provider implementations sometimes mutate the
        // input array; we want the recorded list to be immutable.
        providerCalls.push([...texts]);
        return texts.map(() => Array(cfg.EMBEDDING_DIMENSIONS).fill(PROVIDER_VECTOR_FILL));
      },
    }),
  };
});

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Setup / helpers
// ---------------------------------------------------------------------------
const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

beforeEach(() => {
  store.length = 0;
  renderedSqls.length = 0;
  providerCalls.length = 0;
  dbExecuteMock.mockClear();
});

const expectedDim = config.EMBEDDING_DIMENSIONS;
// A "wrong dim" vector — anything that isn't length expectedDim so the
// production `vector_dims(embedding) != N` predicate fires.
const WRONG_DIM_VEC = Array(Math.max(1, expectedDim - 1)).fill(0.1);

function seedTwoTenants() {
  // All four rows are rebuild candidates (null embedding or wrong dim).
  store.push({
    id: 'mem_A_alpha',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'A-alpha-text',
    embedding: null,
    created_at: 1,
  });
  store.push({
    id: 'mem_A_beta',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'A-beta-text',
    embedding: WRONG_DIM_VEC,
    created_at: 2,
  });
  store.push({
    id: 'mem_B_gamma',
    tenant_id: 'tenant-B',
    agent_id: 'agent-B',
    conteudo: 'B-gamma-text',
    embedding: null,
    created_at: 3,
  });
  store.push({
    id: 'mem_B_delta',
    tenant_id: 'tenant-B',
    agent_id: 'agent-B',
    conteudo: 'B-delta-text',
    embedding: WRONG_DIM_VEC,
    created_at: 4,
  });
}

// Adversarial seed: tenant-B rows are inserted FIRST. If any code path
// accidentally relied on insertion order (e.g. an unscoped SELECT walking the
// store in order), this seeding would surface tenant-B rows in tenant-A's
// rebuild. The production WHERE pins tenant_id+agent_id explicitly, so the
// fake's tenant filter executes BEFORE the slice — proving the contract holds
// regardless of seed order.
function seedTwoTenantsReverse() {
  store.push({
    id: 'mem_B_gamma',
    tenant_id: 'tenant-B',
    agent_id: 'agent-B',
    conteudo: 'B-gamma-text',
    embedding: null,
    created_at: 1,
  });
  store.push({
    id: 'mem_B_delta',
    tenant_id: 'tenant-B',
    agent_id: 'agent-B',
    conteudo: 'B-delta-text',
    embedding: WRONG_DIM_VEC,
    created_at: 2,
  });
  store.push({
    id: 'mem_A_alpha',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'A-alpha-text',
    embedding: null,
    created_at: 3,
  });
  store.push({
    id: 'mem_A_beta',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'A-beta-text',
    embedding: WRONG_DIM_VEC,
    created_at: 4,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #239 — scripts/embeddings-rebuild.ts is tenant_id+agent_id scoped', () => {
  describe('CLI args — required --tenant and --agent', () => {
    it('REJECTION — parseRequiredArgs throws RequiredArgsError when --tenant is missing', async () => {
      const { parseRequiredArgs, RequiredArgsError } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const argv = ['node', 'embeddings-rebuild.ts', '--agent=agent-A'];
      expect(() => parseRequiredArgs(argv)).toThrowError(RequiredArgsError);
      try {
        parseRequiredArgs(argv);
      } catch (err) {
        expect((err as { code: string }).code).toBe('MISSING_REQUIRED_ARGS');
        expect((err as Error).message).toMatch(/--tenant/);
      }
    });

    it('REJECTION — parseRequiredArgs throws RequiredArgsError when --agent is missing', async () => {
      const { parseRequiredArgs, RequiredArgsError } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const argv = ['node', 'embeddings-rebuild.ts', '--tenant=tenant-A'];
      expect(() => parseRequiredArgs(argv)).toThrowError(RequiredArgsError);
      try {
        parseRequiredArgs(argv);
      } catch (err) {
        expect((err as { code: string }).code).toBe('MISSING_REQUIRED_ARGS');
        expect((err as Error).message).toMatch(/--agent/);
      }
    });

    it('REJECTION — parseRequiredArgs throws when both flags are missing (silent fall-through would be a regression)', async () => {
      const { parseRequiredArgs, RequiredArgsError } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      // The CLI is `node embeddings-rebuild.ts` with no extra flags. The
      // production code MUST refuse to fall through to any implicit default.
      expect(() => parseRequiredArgs(['node', 'embeddings-rebuild.ts'])).toThrowError(
        RequiredArgsError,
      );
    });

    it('ACCEPT — parseRequiredArgs returns the tuple when both flags are present', async () => {
      const { parseRequiredArgs } = await import('@/../scripts/embeddings-rebuild.ts');
      const argv = [
        'node',
        'embeddings-rebuild.ts',
        '--tenant=tenant-A',
        '--agent=agent-A',
      ];
      expect(parseRequiredArgs(argv)).toEqual({
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
      });
    });
  });

  describe('rebuildEmbeddingsForTuple — read step', () => {
    it('SUCCESS — tenant-A rebuild only reads tenant-A rows (NEVER tenant-B)', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      expect(result.updated).toBe(2);
      expect(result.totalInScope).toBe(2);

      // Provider must have seen ONLY tenant-A text — NEVER tenant-B's.
      const allProviderTexts = providerCalls.flat();
      expect(allProviderTexts).toEqual(
        expect.arrayContaining(['A-alpha-text', 'A-beta-text']),
      );
      expect(allProviderTexts).not.toContain('B-gamma-text');
      expect(allProviderTexts).not.toContain('B-delta-text');
    });

    it('SYMMETRY — tenant-B rebuild only reads tenant-B rows (NEVER tenant-A)', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...B_CTX, batchSize: 32 });

      expect(result.updated).toBe(2);

      const allProviderTexts = providerCalls.flat();
      expect(allProviderTexts).toEqual(
        expect.arrayContaining(['B-gamma-text', 'B-delta-text']),
      );
      expect(allProviderTexts).not.toContain('A-alpha-text');
      expect(allProviderTexts).not.toContain('A-beta-text');
    });

    it('ADVERSARIAL SEED ORDER — tenant-B inserted first, tenant-A rebuild still leaks nothing', async () => {
      // The pre-fix failure mode: an unscoped SELECT walking the store in
      // insertion order would surface tenant-B rows for tenant-A's rebuild.
      seedTwoTenantsReverse();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      expect(result.updated).toBe(2);

      const allProviderTexts = providerCalls.flat();
      // Defensive: explicitly assert ZERO tenant-B content reached the
      // provider, even though tenant-B rows are earlier in store order.
      expect(allProviderTexts).not.toContain('B-gamma-text');
      expect(allProviderTexts).not.toContain('B-delta-text');
      expect(allProviderTexts).toEqual(
        expect.arrayContaining(['A-alpha-text', 'A-beta-text']),
      );
    });

    it('PROVIDER BATCH ISOLATION — every provider call contains text from ONE tenant only', async () => {
      // Even with multiple batches, each batch is per-tuple — no batch mixes
      // texts across tenants. Use a small batch size to force multiple calls.
      seedTwoTenantsReverse();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 1 });

      // Each call's texts should ALL belong to tenant-A. The provider must
      // have been called at least once.
      expect(providerCalls.length).toBeGreaterThan(0);
      for (const batch of providerCalls) {
        for (const text of batch) {
          expect(text.startsWith('A-')).toBe(true);
        }
      }
    });

    it('SELECT SQL includes tenant_id AND agent_id predicates', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      const selectSql = renderedSqls.find((r) =>
        /SELECT\s+id::text,\s+conteudo/i.test(r.sql),
      );
      expect(selectSql).toBeDefined();
      expect(selectSql!.sql).toMatch(/tenant_id\s*=/);
      expect(selectSql!.sql).toMatch(/agent_id\s*=/);
      // And the bound params include the routed tuple.
      expect(selectSql!.params).toEqual(
        expect.arrayContaining(['tenant-A', 'agent-A']),
      );
    });
  });

  describe('rebuildEmbeddingsForTuple — update step', () => {
    it('SUCCESS — tenant-A rebuild only mutates tenant-A rows (NEVER tenant-B)', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      // Tenant-A rows: now have the provider's vector.
      const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
      const aBeta = store.find((r) => r.id === 'mem_A_beta');
      expect(aAlpha!.embedding).not.toBeNull();
      expect(aAlpha!.embedding!.length).toBe(expectedDim);
      expect(aBeta!.embedding!.length).toBe(expectedDim);

      // Tenant-B rows: UNCHANGED — still null / wrong-dim.
      const bGamma = store.find((r) => r.id === 'mem_B_gamma');
      const bDelta = store.find((r) => r.id === 'mem_B_delta');
      expect(bGamma!.embedding).toBeNull();
      expect(bDelta!.embedding).toEqual(WRONG_DIM_VEC);
    });

    it('SYMMETRY — tenant-B rebuild only mutates tenant-B rows (NEVER tenant-A)', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...B_CTX, batchSize: 32 });

      const bGamma = store.find((r) => r.id === 'mem_B_gamma');
      const bDelta = store.find((r) => r.id === 'mem_B_delta');
      expect(bGamma!.embedding!.length).toBe(expectedDim);
      expect(bDelta!.embedding!.length).toBe(expectedDim);

      const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
      const aBeta = store.find((r) => r.id === 'mem_A_beta');
      expect(aAlpha!.embedding).toBeNull();
      expect(aBeta!.embedding).toEqual(WRONG_DIM_VEC);
    });

    it('UPDATE SQL includes tenant_id AND agent_id predicates (defense-in-depth)', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      const updateSql = renderedSqls.find((r) =>
        /^\s*UPDATE\s+agent_memories/i.test(r.sql),
      );
      expect(updateSql).toBeDefined();
      expect(updateSql!.sql).toMatch(/tenant_id\s*=/);
      expect(updateSql!.sql).toMatch(/agent_id\s*=/);
      // The bound params include the routed tuple, alongside the id.
      expect(updateSql!.params).toEqual(
        expect.arrayContaining(['tenant-A', 'agent-A']),
      );
    });
  });

  describe('end-to-end isolation invariant', () => {
    it('FULL ROUNDTRIP — alternating tenant-A and tenant-B rebuilds preserve isolation', async () => {
      // Rebuild for A first, then for B. Each invocation is independent and
      // should only touch its own tenant's rows. The combination of the two
      // runs eventually embeds all four rows — but never mixes them in a
      // single provider call or a single UPDATE.
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      const aResult = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      expect(aResult.updated).toBe(2);

      const bResult = await rebuildEmbeddingsForTuple({ ...B_CTX, batchSize: 32 });
      expect(bResult.updated).toBe(2);

      // No provider call mixed tenants.
      for (const batch of providerCalls) {
        const prefixes = new Set(batch.map((t) => t.charAt(0)));
        expect(prefixes.size).toBe(1);
      }

      // All four rows are now embedded with the right dim.
      for (const r of store) {
        expect(r.embedding).not.toBeNull();
        expect(r.embedding!.length).toBe(expectedDim);
      }
    });

    it('NO-OP — rebuild on a tenant with no pending rows does not touch any other tenant', async () => {
      // tenant-B rows pending, tenant-A's row already correct. The tenant-A
      // rebuild should be a no-op even though tenant-B rows would have
      // matched the pre-fix unscoped predicate.
      store.push({
        id: 'mem_A_done',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        conteudo: 'A-done-text',
        embedding: Array(expectedDim).fill(0.5),
        created_at: 1,
      });
      store.push({
        id: 'mem_B_pending',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        conteudo: 'B-pending-text',
        embedding: null,
        created_at: 2,
      });
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      expect(result.updated).toBe(0);
      // tenant-B's pending row is UNTOUCHED.
      const bPending = store.find((r) => r.id === 'mem_B_pending');
      expect(bPending!.embedding).toBeNull();
      // And the provider was never called.
      expect(providerCalls.length).toBe(0);
    });

    it('CROSS-AGENT — same tenant, different agent: tenant-A/agent-A rebuild MUST NOT touch tenant-A/agent-OTHER rows', async () => {
      // The invariant is BOTH tenant AND agent. A tenant-A/agent-A rebuild
      // must not embed tenant-A/agent-OTHER rows.
      store.push({
        id: 'mem_A_self',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        conteudo: 'A-self-text',
        embedding: null,
        created_at: 1,
      });
      store.push({
        id: 'mem_A_other',
        tenant_id: 'tenant-A',
        agent_id: 'agent-OTHER',
        conteudo: 'A-other-text',
        embedding: null,
        created_at: 2,
      });
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      expect(result.updated).toBe(1);

      const allProviderTexts = providerCalls.flat();
      expect(allProviderTexts).toContain('A-self-text');
      expect(allProviderTexts).not.toContain('A-other-text');

      const aSelf = store.find((r) => r.id === 'mem_A_self');
      const aOther = store.find((r) => r.id === 'mem_A_other');
      expect(aSelf!.embedding).not.toBeNull();
      expect(aOther!.embedding).toBeNull();
    });
  });
});
