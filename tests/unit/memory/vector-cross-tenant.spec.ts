/**
 * Issue #229 — Cross-tenant (cross-empresa) isolation invariant for the
 * vector memory layer (`agent_memories`) INSERT + recall.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Vector-memory-specific contract this spec PROVES:
 *   1. `writeMemory` REQUIRES an active tenant context — without one it
 *      throws `MissingTenantContextError` (no silent fall-through to the
 *      legacy `'default'` bucket).
 *   2. `writeMemory` writes the routed `tenant_id` / `agent_id` into the
 *      INSERT column list (rendered SQL + bound params verified).
 *   3. `recall` injects `tenant_id = <ctx> AND agent_id = <ctx>` into the
 *      WHERE clause AND returns ZERO foreign-tenant rows under every seed
 *      order — including the adversarial case where a tenant-B row's
 *      embedding is closer to the query than tenant-A's (similarity score
 *      MUST NOT override tenant scoping).
 *
 * Before this fix:
 *   - INSERT didn't include `tenant_id`/`agent_id`; the DB defaults
 *     (`'default'`) routed every write into a single shared bucket.
 *   - SELECT filtered ONLY by `escopo`, so a similarity recall could surface
 *     ANY tenant's memory regardless of who was asking — a direct cross-
 *     tenant learning leak.
 *
 * Strategy:
 *   We don't need a full drizzle builder mock here — `src/memory/vector.ts`
 *   uses raw `db.execute(sql\`...\`)`. Instead we:
 *     1. Render the production SQL via Drizzle's `PgDialect` to extract the
 *        text + bound parameter array (same pattern as
 *        `tests/unit/audit-watcher.spec.ts` and
 *        `tests/unit/llm-settings.spec.ts`).
 *     2. Dispatch on the rendered SQL: INSERT → push row to in-memory store
 *        using the params; SELECT → filter the store by tenant/agent + escopo,
 *        sort by simulated cosine distance (we encoded the embedding in the
 *        param), apply the LIMIT, return.
 *     3. Wrap every test in `runWithTenantContext({tenant_id, agent_id}, ...)`
 *        so `getCurrentTenant()` / `getCurrentAgent()` resolve to the routed
 *        values. The "no-context throws" test deliberately runs OUTSIDE.
 *     4. Stub the embedding provider to return the deterministic vector
 *        attached to each test input — that lets us drive the similarity
 *        ranking without depending on a real model.
 *
 * Seed (two tenants, four memories):
 *   tenant-A / agent-A: { mem_A_alpha, mem_A_beta } — both with embedding "moderate"
 *   tenant-B / agent-B: { mem_B_gamma (embedding "near-query") , mem_B_delta }
 *
 * The adversarial subtest seeds `mem_B_gamma` with an embedding CLOSER to the
 * recall query than any tenant-A row. If the WHERE clause omitted tenant
 * scoping, `mem_B_gamma` would rank #1 and leak. The production WHERE pins
 * tenant_id+agent_id so the row is filtered out before ORDER BY runs.
 *
 * This does NOT use a real DB or real pgvector — that's tracked separately
 * (P9a-style real-Postgres proof). The fake faithfully reproduces the SQL
 * dispatch surface so the REAL `vector.ts` code paths are exercised
 * end-to-end; only the storage layer is replaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { runWithTenantContext, MissingTenantContextError } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory store + db.execute fake
// ---------------------------------------------------------------------------
type StoredRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
  embedding: number[];
  tipo: string;
  escopo: string;
  metadata: Record<string, unknown>;
  ref_tabela: string | null;
  ref_id: string | null;
};

const store: StoredRow[] = [];
let nextId = 1;
let nextEmbedding: number[] = [0.5, 0.5, 0.5];

function seedRow(over: Partial<StoredRow> & { id: string; tenant_id: string; agent_id: string; embedding: number[] }): void {
  store.push({
    conteudo: 'seeded',
    tipo: 'reflexao',
    escopo: 'global',
    metadata: {},
    ref_tabela: null,
    ref_id: null,
    ...over,
  });
}

// Cosine distance approximation for ordering. We don't need numerical fidelity
// to pgvector — we just need a deterministic monotonic distance so the test
// can prove that ranking would surface a row IF tenant scoping didn't filter
// it first. We compute Euclidean distance between fixed-length numeric arrays
// (every embedding in this suite is length 3).
function dist(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    sum += (ai - bi) * (ai - bi);
  }
  return Math.sqrt(sum);
}

function parseVectorLiteral(s: string): number[] {
  // Production formats the embedding as `[a,b,c]` then casts via `::vector`.
  // The bound parameter we see here is the raw `[a,b,c]` string.
  const trimmed = s.replace(/^\[|\]$/g, '');
  if (!trimmed) return [];
  return trimmed.split(',').map((p) => Number(p));
}

const _dialect = new PgDialect();
const renderedSqls: string[] = [];

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push(sqlText);

  if (/^\s*INSERT\s+INTO\s+agent_memories/i.test(sqlText)) {
    // Production INSERT param order matches the column order on the production
    // VALUES (...):
    //   ($1 tenant_id, $2 agent_id, $3 conteudo, $4 embedding,
    //    $5 tipo, $6 escopo, $7 metadata-jsonb, $8 ref_tabela, $9 ref_id)
    const [tenant_id, agent_id, conteudo, vec, tipo, escopo, metadataJson, ref_tabela, ref_id] = params as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
    ];
    const id = `mem_${String(nextId++).padStart(6, '0')}`;
    store.push({
      id,
      tenant_id,
      agent_id,
      conteudo,
      embedding: parseVectorLiteral(vec),
      tipo,
      escopo,
      metadata: typeof metadataJson === 'string' ? JSON.parse(metadataJson) : (metadataJson ?? {}),
      ref_tabela: ref_tabela ?? null,
      ref_id: ref_id ?? null,
    });
    return { rows: [{ id }] };
  }

  if (/^\s*SELECT[\s\S]+FROM\s+agent_memories/i.test(sqlText)) {
    // Production SELECT param order:
    //   $1 vec (used twice: in score expression AND ORDER BY)
    //   $2 tenant_id
    //   $3 agent_id
    //   $4 escopo array
    //   ($5 tipo array IF tipos filter present)
    //   $N limit (always last)
    //
    // Drizzle reuses the same parameter for the duplicate `${vec}` template
    // expressions; renderedSql.params dedupes — confirm by inspection.
    const queryVec = parseVectorLiteral(params[0] as string);
    const tenant_id = params[1] as string;
    const agent_id = params[2] as string;
    const escopo = params[3] as string[];
    const hasTipoFilter = sqlText.includes('tipo = ANY');
    const tipos = hasTipoFilter ? (params[4] as string[]) : null;
    const limit = params[params.length - 1] as number;

    let filtered = store.filter(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        escopo.includes(r.escopo) &&
        (tipos ? tipos.includes(r.tipo) : true),
    );
    filtered = filtered.slice().sort((a, b) => dist(a.embedding, queryVec) - dist(b.embedding, queryVec));
    const top = filtered.slice(0, limit).map((r) => ({
      conteudo: r.conteudo,
      tipo: r.tipo,
      escopo: r.escopo,
      // Production casts via Number(); pgvector returns score as decimal text.
      // Use a deterministic stand-in based on distance.
      score: String(1 - dist(r.embedding, queryVec) / 10),
    }));
    return { rows: top };
  }

  return { rows: [] };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

// Stub the embedding provider so the test drives the vector deterministically.
// `nextEmbedding` is set per-call before the production code reaches the
// provider; for INSERT it's the row's embedding, for recall it's the query's.
vi.mock('@/lib/embeddings.js', () => ({
  getEmbeddingProvider: () => ({
    name: 'voyage',
    modelId: 'fake',
    dimensions: 3,
    embed: async (_texts: string[]) => [nextEmbedding],
  }),
}));

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
  nextId = 1;
  nextEmbedding = [0.5, 0.5, 0.5];
  renderedSqls.length = 0;
  dbExecuteMock.mockClear();
});

function seedTwoTenants() {
  // tenant-A inserted first
  seedRow({ id: 'mem_A_alpha', tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-alpha', escopo: 'global', embedding: [0.5, 0.5, 0.5] });
  seedRow({ id: 'mem_A_beta',  tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-beta',  escopo: 'pessoa:p1', embedding: [0.6, 0.6, 0.6] });
  seedRow({ id: 'mem_B_gamma', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-gamma', escopo: 'global', embedding: [0.7, 0.7, 0.7] });
  seedRow({ id: 'mem_B_delta', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-delta', escopo: 'pessoa:p1', embedding: [0.8, 0.8, 0.8] });
}

function seedTwoTenantsReverse() {
  // tenant-B FIRST: a missing tenant_id filter would surface tenant-B's row
  // first in store order; if any code path accidentally relied on insertion
  // order this would fail.
  seedRow({ id: 'mem_B_gamma', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-gamma', escopo: 'global', embedding: [0.7, 0.7, 0.7] });
  seedRow({ id: 'mem_B_delta', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-delta', escopo: 'pessoa:p1', embedding: [0.8, 0.8, 0.8] });
  seedRow({ id: 'mem_A_alpha', tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-alpha', escopo: 'global', embedding: [0.5, 0.5, 0.5] });
  seedRow({ id: 'mem_A_beta',  tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-beta',  escopo: 'pessoa:p1', embedding: [0.6, 0.6, 0.6] });
}

// Adversarial seed: tenant-B's row is embedding-wise closer to the query than
// any tenant-A row. WITHOUT tenant scoping in the WHERE, similarity ranking
// would surface mem_B_adversary in tenant-A's recall. This is the most direct
// test of the cross-tenant invariant against the failure mode the bug ACTUALLY
// had: an unscoped similarity recall.
function seedAdversarialSimilarity(queryVec: number[]) {
  // tenant-A: identical embedding distance "far" from query
  seedRow({ id: 'mem_A_far', tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-far', escopo: 'global', embedding: queryVec.map((v) => v + 0.5) });
  // tenant-B: embedding EXACTLY matches the query — would rank #1 by similarity
  seedRow({ id: 'mem_B_adversary', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-adversary', escopo: 'global', embedding: [...queryVec] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #229 — vector memory (agent_memories) INSERT + recall are tenant/agent-scoped', () => {
  describe('writeMemory — INSERT', () => {
    it('SUCCESS — tenant-A context inserts a row with tenant_id=tenant-A AND agent_id=agent-A', async () => {
      const { writeMemory } = await import('@/memory/vector.js');
      nextEmbedding = [0.1, 0.2, 0.3];
      const { id } = await runWithTenantContext(A_CTX, async () =>
        writeMemory({ conteudo: 'first A memory', tipo: 'reflexao', escopo: 'global' }),
      );
      const row = store.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('tenant-A');
      expect(row!.agent_id).toBe('agent-A');
      expect(row!.conteudo).toBe('first A memory');
    });

    it('SUCCESS — tenant-B context inserts a row with tenant_id=tenant-B AND agent_id=agent-B (symmetry)', async () => {
      const { writeMemory } = await import('@/memory/vector.js');
      nextEmbedding = [0.1, 0.2, 0.3];
      const { id } = await runWithTenantContext(B_CTX, async () =>
        writeMemory({ conteudo: 'first B memory', tipo: 'reflexao', escopo: 'global' }),
      );
      const row = store.find((r) => r.id === id);
      expect(row!.tenant_id).toBe('tenant-B');
      expect(row!.agent_id).toBe('agent-B');
    });

    it('REJECTION — writeMemory without tenant context throws MissingTenantContextError', async () => {
      const { writeMemory } = await import('@/memory/vector.js');
      nextEmbedding = [0.1, 0.2, 0.3];
      // Calling OUTSIDE runWithTenantContext — production refuses to fall
      // through to the legacy `'default'` bucket.
      await expect(
        writeMemory({ conteudo: 'orphan', tipo: 'reflexao', escopo: 'global' }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
      // And no row was written.
      expect(store.length).toBe(0);
    });

    it('INSERT SQL includes the tenant_id and agent_id columns explicitly', async () => {
      const { writeMemory } = await import('@/memory/vector.js');
      nextEmbedding = [0.1, 0.2, 0.3];
      await runWithTenantContext(A_CTX, async () =>
        writeMemory({ conteudo: 'msg', tipo: 'reflexao', escopo: 'global' }),
      );
      const insertSql = renderedSqls.find((s) => /INSERT INTO agent_memories/i.test(s));
      expect(insertSql).toBeDefined();
      // Defensive — assert the column list contains both invariants.
      expect(insertSql!).toMatch(/tenant_id/);
      expect(insertSql!).toMatch(/agent_id/);
    });
  });

  describe('recall — SELECT', () => {
    it('SUCCESS — tenant-A recall returns ONLY tenant-A rows', async () => {
      seedTwoTenants();
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.5, 0.5, 0.5]; // closest to mem_A_alpha
      const result = await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global', 'pessoa:p1'], k: 10 }),
      );
      expect(result.length).toBeGreaterThan(0);
      for (const r of result) {
        expect(r.conteudo.startsWith('A-')).toBe(true);
      }
      // Defensive: explicitly NO tenant-B content.
      expect(result.map((r) => r.conteudo)).not.toContain('B-gamma');
      expect(result.map((r) => r.conteudo)).not.toContain('B-delta');
    });

    it('SYMMETRY — tenant-B recall returns ONLY tenant-B rows', async () => {
      seedTwoTenants();
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.7, 0.7, 0.7];
      const result = await runWithTenantContext(B_CTX, async () =>
        recall({ query: 'anything', escopo: ['global', 'pessoa:p1'], k: 10 }),
      );
      expect(result.length).toBeGreaterThan(0);
      for (const r of result) {
        expect(r.conteudo.startsWith('B-')).toBe(true);
      }
      expect(result.map((r) => r.conteudo)).not.toContain('A-alpha');
      expect(result.map((r) => r.conteudo)).not.toContain('A-beta');
    });

    it('ADVERSARIAL SEED ORDER — tenant-B inserted first, tenant-A recall still leaks nothing', async () => {
      seedTwoTenantsReverse();
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.5, 0.5, 0.5];
      const result = await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global', 'pessoa:p1'], k: 10 }),
      );
      for (const r of result) {
        expect(r.conteudo.startsWith('A-')).toBe(true);
      }
    });

    it('ADVERSARIAL SIMILARITY — a tenant-B row whose embedding is CLOSER to the query than any tenant-A row MUST NOT surface in tenant-A recall', async () => {
      // The core failure mode the bug had: similarity ranking would surface
      // a foreign-tenant row regardless of tenant. We seed precisely that
      // and assert the production WHERE filters it out before ORDER BY runs.
      const queryVec = [0.1, 0.2, 0.3];
      seedAdversarialSimilarity(queryVec);
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = queryVec;
      const result = await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global'], k: 10 }),
      );
      // Despite mem_B_adversary having a PERFECT similarity match, it MUST
      // NOT appear in tenant-A's recall.
      const contents = result.map((r) => r.conteudo);
      expect(contents).not.toContain('B-adversary');
      // Tenant-A's "far" row is the only legitimate match and SHOULD surface.
      expect(contents).toContain('A-far');
    });

    it('SYMMETRY (adversarial) — tenant-A row exactly matching tenant-B recall MUST NOT leak', async () => {
      // Mirror image of the above: an A-row with perfect similarity vs the
      // query must NOT appear when routed as tenant-B.
      const queryVec = [0.1, 0.2, 0.3];
      seedRow({ id: 'mem_A_adversary', tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-adversary', escopo: 'global', embedding: [...queryVec] });
      seedRow({ id: 'mem_B_far',       tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-far',       escopo: 'global', embedding: queryVec.map((v) => v + 0.5) });
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = queryVec;
      const result = await runWithTenantContext(B_CTX, async () =>
        recall({ query: 'anything', escopo: ['global'], k: 10 }),
      );
      const contents = result.map((r) => r.conteudo);
      expect(contents).not.toContain('A-adversary');
      expect(contents).toContain('B-far');
    });

    it('CROSS-AGENT — same tenant, different agent: tenant-A/agent-A recall MUST NOT see tenant-A/agent-OTHER rows', async () => {
      // The invariant is BOTH tenant AND agent. A tenant-A agent should not
      // recall another tenant-A agent's vectorized memory.
      seedRow({ id: 'mem_A_other', tenant_id: 'tenant-A', agent_id: 'agent-OTHER', conteudo: 'A-other-agent', escopo: 'global', embedding: [0.1, 0.2, 0.3] });
      seedRow({ id: 'mem_A_self',  tenant_id: 'tenant-A', agent_id: 'agent-A',     conteudo: 'A-self',        escopo: 'global', embedding: [0.5, 0.5, 0.5] });
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.1, 0.2, 0.3]; // exactly matches mem_A_other
      const result = await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global'], k: 10 }),
      );
      const contents = result.map((r) => r.conteudo);
      expect(contents).not.toContain('A-other-agent');
      expect(contents).toContain('A-self');
    });

    it('REJECTION — recall without tenant context throws (not silently returns []) ', async () => {
      seedTwoTenants();
      const { recall } = await import('@/memory/vector.js');
      // Production resolves tenant_id/agent_id BEFORE the try/catch around
      // db.execute, so MissingTenantContextError propagates rather than
      // being swallowed by the recall error handler.
      await expect(
        recall({ query: 'anything', escopo: ['global'], k: 5 }),
      ).rejects.toBeInstanceOf(MissingTenantContextError);
    });

    it('RECALL SQL includes tenant_id AND agent_id predicates', async () => {
      seedTwoTenants();
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.5, 0.5, 0.5];
      await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global'], k: 5 }),
      );
      const selectSql = renderedSqls.find((s) => /FROM agent_memories/i.test(s));
      expect(selectSql).toBeDefined();
      expect(selectSql!).toMatch(/tenant_id\s*=/);
      expect(selectSql!).toMatch(/agent_id\s*=/);
    });

    it('TIPOS FILTER + tenant scoping — tipos filter narrows but tenant scoping still wins', async () => {
      // Validate parameter-order assumption: when `tipos` is present the
      // SELECT renders an extra `AND tipo = ANY($5)`. We assert that a row
      // matching the tipo filter but belonging to a different tenant is STILL
      // filtered out.
      seedRow({ id: 'mem_A_factual', tenant_id: 'tenant-A', agent_id: 'agent-A', conteudo: 'A-factual', escopo: 'global', tipo: 'reflexao', embedding: [0.5, 0.5, 0.5] });
      seedRow({ id: 'mem_B_factual', tenant_id: 'tenant-B', agent_id: 'agent-B', conteudo: 'B-factual', escopo: 'global', tipo: 'reflexao', embedding: [0.5, 0.5, 0.5] });
      const { recall } = await import('@/memory/vector.js');
      nextEmbedding = [0.5, 0.5, 0.5];
      const result = await runWithTenantContext(A_CTX, async () =>
        recall({ query: 'anything', escopo: ['global'], tipos: ['reflexao'], k: 10 }),
      );
      const contents = result.map((r) => r.conteudo);
      expect(contents).toContain('A-factual');
      expect(contents).not.toContain('B-factual');
    });
  });
});
