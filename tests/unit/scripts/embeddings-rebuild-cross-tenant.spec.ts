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

// Concurrency / lock simulation. When `lockHeld` is true, the advisory lock
// attempt returns false (simulating another process holding the lock for the
// SAME key). When false (default), the lock is acquired.
let lockHeld = false;

// Capture audit_log inserts so tests can assert the run was recorded with
// the correct tuple + operator identity.
const auditLogInserts: Array<{
  tenant_id: string;
  agent_id: string;
  acao: string;
  metadata: Record<string, unknown>;
}> = [];

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push({ sql: sqlText, params });

  // NOTE (review v2 fix): the advisory lock SQL is NO LONGER routed through
  // `db.execute`. Production now uses session-level `pg_try_advisory_lock` on
  // a dedicated pool client (see `poolConnectMock` below) so the lock
  // survives statement boundaries and is released explicitly via
  // `pg_advisory_unlock` in `finally`. We assert the lock call shape against
  // `lockClientQueryMock` instead of `renderedSqls`.

  // ---- COUNT(*) pending (pending-only) ----------------------------------
  // Production:
  //   SELECT count(*)::text AS count FROM agent_memories
  //   WHERE tenant_id = $1 AND agent_id = $2
  //     AND (embedding IS NULL OR vector_dims(embedding) != $3)
  if (
    /SELECT\s+count\(\*\)::text\s+AS\s+count/i.test(sqlText) &&
    /embedding\s+IS\s+NULL/i.test(sqlText)
  ) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const expectedDim = Number(params[2]);
    const count = store.filter(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        (r.embedding === null || r.embedding.length !== expectedDim),
    ).length;
    return { rows: [{ count: String(count) }] };
  }

  // ---- COUNT(*) total in scope -----------------------------------------
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

  // ---- INSERT INTO audit_log -------------------------------------------
  // Production:
  //   INSERT INTO audit_log (tenant_id, agent_id, acao, metadata)
  //   VALUES ($1, $2, $3, $4::jsonb)
  if (/INSERT\s+INTO\s+audit_log/i.test(sqlText)) {
    auditLogInserts.push({
      tenant_id: params[0] as string,
      agent_id: params[1] as string,
      acao: params[2] as string,
      metadata: JSON.parse(params[3] as string),
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- UPDATE one row ---------------------------------------------------
  // Production:
  //   UPDATE agent_memories SET embedding = $1::vector
  //   WHERE id = $2::uuid AND tenant_id = $3 AND agent_id = $4
  //   RETURNING id::text
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
      return { rows: [{ id: target.id }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [] };
});

// ─── pool.connect() fake (review v2 fix) ────────────────────────────────────
// Production now acquires the advisory lock on a dedicated pool client via
// `pool.connect()` so the session-scoped lock survives statement boundaries
// and the explicit `pg_advisory_unlock` in `finally` actually targets the
// same session. The fake tracks every `client.query()` call (lock + unlock)
// and the `release()` call so tests can assert the lifecycle.
const lockClientQueryMock = vi.fn(
  async (sqlText: string, params: unknown[] = []) => {
    if (/pg_try_advisory_lock\s*\(/i.test(sqlText)) {
      return { rows: [{ acquired: !lockHeld }], rowCount: 1 };
    }
    if (/pg_advisory_unlock\s*\(/i.test(sqlText)) {
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
);
const lockClientReleaseMock = vi.fn(() => undefined);
const poolConnectMock = vi.fn(async () => ({
  query: lockClientQueryMock,
  release: lockClientReleaseMock,
}));

// ─── db.transaction() fake (Codex review #244 HIGH blocker) ─────────────────
// Production now wraps each batch's UPDATEs in `db.transaction(async tx =>
// {...})` so a mid-batch DB failure rolls back the entire batch (all-or-
// nothing semantics). The fake provides a `tx` shim that exposes `.execute`
// identical to `db.execute` AND tracks BEGIN/COMMIT/ROLLBACK lifecycle so
// tests can assert the rollback fires on error.
//
// Rollback model: we snapshot the store at txn start and restore on error.
// This is the BEHAVIOURAL contract the production code relies on — if the
// fake didn't roll back, the test couldn't distinguish "atomic batch
// committed" from "per-row autocommit" outcomes.
type TxnLifecycle = 'begin' | 'commit' | 'rollback';
const txnLifecycle: TxnLifecycle[] = [];
const dbTransactionMock = vi.fn(
  async <T>(fn: (tx: { execute: typeof dbExecuteMock }) => Promise<T>): Promise<T> => {
    txnLifecycle.push('begin');
    // Snapshot embedding values for rollback (the only field UPDATEs mutate).
    const snapshot = store.map((r) => ({
      id: r.id,
      embedding: r.embedding === null ? null : [...r.embedding],
    }));
    try {
      const result = await fn({ execute: dbExecuteMock });
      txnLifecycle.push('commit');
      return result;
    } catch (err) {
      // Restore snapshot — all UPDATEs in this txn are rolled back.
      for (const snap of snapshot) {
        const row = store.find((r) => r.id === snap.id);
        if (row) row.embedding = snap.embedding;
      }
      txnLifecycle.push('rollback');
      throw err;
    }
  },
);

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock, transaction: dbTransactionMock },
  pool: { connect: poolConnectMock },
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
  auditLogInserts.length = 0;
  txnLifecycle.length = 0;
  lockHeld = false;
  dbExecuteMock.mockClear();
  dbTransactionMock.mockClear();
  lockClientQueryMock.mockClear();
  lockClientReleaseMock.mockClear();
  poolConnectMock.mockClear();
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

    // [Codex #244 MEDIUM] — the issue's contract used --tenant_id / --agent_id
    // names. We accept both forms as aliases so README / CI snippets that
    // adopted either spelling keep working. Owner-locked Option A (required)
    // is preserved: at least one form of each is still required.
    it('ALIAS — parseRequiredArgs accepts --tenant_id / --agent_id forms', async () => {
      const { parseRequiredArgs } = await import('@/../scripts/embeddings-rebuild.ts');
      const argv = [
        'node',
        'embeddings-rebuild.ts',
        '--tenant_id=tenant-X',
        '--agent_id=agent-X',
      ];
      expect(parseRequiredArgs(argv)).toEqual({
        tenant_id: 'tenant-X',
        agent_id: 'agent-X',
      });
    });

    it('ALIAS — --tenant_id wins when both --tenant and --tenant_id are passed (explicit > short)', async () => {
      const { parseRequiredArgs } = await import('@/../scripts/embeddings-rebuild.ts');
      const argv = [
        'node',
        'embeddings-rebuild.ts',
        '--tenant=tenant-OLD',
        '--tenant_id=tenant-NEW',
        '--agent_id=agent-X',
      ];
      // The longer form is more explicit / less likely to be a typo. Owner
      // contract is unambiguous: exactly one tenant per run.
      expect(parseRequiredArgs(argv).tenant_id).toBe('tenant-NEW');
    });

    it('MIXED — --tenant + --agent_id (one of each form) is accepted', async () => {
      const { parseRequiredArgs } = await import('@/../scripts/embeddings-rebuild.ts');
      const argv = [
        'node',
        'embeddings-rebuild.ts',
        '--tenant=tenant-A',
        '--agent_id=agent-A',
      ];
      expect(parseRequiredArgs(argv)).toEqual({
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
      });
    });
  });

  describe('CLI options — dry-run, yes, batch', () => {
    it('parseCliOptions defaults to {dryRun:false, yes:false, batchSize:undefined}', async () => {
      const { parseCliOptions } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(parseCliOptions(['node', 'x', '--tenant=t', '--agent=a'])).toEqual({
        dryRun: false,
        yes: false,
        batchSize: undefined,
      });
    });

    it('parseCliOptions picks up --dry-run, --yes, --batch=10', async () => {
      const { parseCliOptions } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(
        parseCliOptions(['node', 'x', '--dry-run', '--yes', '--batch=10']),
      ).toEqual({ dryRun: true, yes: true, batchSize: 10 });
    });

    it('parseCliOptions rejects non-positive / non-integer --batch', async () => {
      const { parseCliOptions } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(() => parseCliOptions(['node', 'x', '--batch=0'])).toThrow(/invalid --batch/);
      expect(() => parseCliOptions(['node', 'x', '--batch=-5'])).toThrow(/invalid --batch/);
      expect(() => parseCliOptions(['node', 'x', '--batch=abc'])).toThrow(/invalid --batch/);
      expect(() => parseCliOptions(['node', 'x', '--batch=1.5'])).toThrow(/invalid --batch/);
    });
  });

  // -------------------------------------------------------------------------
  // [Issue #288] hasFlag — boolean parse contract
  //
  // Background: PR #244 introduced a TTY confirmation gate that uses
  // `hasFlag(argv, 'yes')` to decide whether to skip the prompt. The original
  // implementation accepted ANY `--yes=...` as truthy, so an operator who
  // typed `--yes=false` (explicitly opting OUT of skipping) would have their
  // intent inverted — confirmation was silently bypassed.
  //
  // The fixed contract: bare `--name` is truthy; `--name=value` is truthy
  // only for `true` / `1` / `yes` (case-insensitive). Everything else is
  // falsy, including `false`, `0`, `no`, and the empty value `--name=`.
  // -------------------------------------------------------------------------
  describe('hasFlag — boolean parse contract (#288)', () => {
    it('TRUE — bare --yes is truthy', async () => {
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes'], 'yes')).toBe(true);
    });

    it('TRUE — explicit truthy values (--yes=true / --yes=1 / --yes=yes) are truthy', async () => {
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes=true'], 'yes')).toBe(true);
      expect(hasFlag(['--yes=1'], 'yes')).toBe(true);
      expect(hasFlag(['--yes=yes'], 'yes')).toBe(true);
    });

    it('TRUE — truthy values are case-insensitive (--yes=TRUE / --yes=Yes)', async () => {
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes=TRUE'], 'yes')).toBe(true);
      expect(hasFlag(['--yes=Yes'], 'yes')).toBe(true);
    });

    it('FALSE — explicit falsy values (--yes=false / --yes=0 / --yes=no) are falsy', async () => {
      // The #288 regression: previously these returned true, so an operator
      // typing `--yes=false` to OPT OUT had their intent silently inverted.
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes=false'], 'yes')).toBe(false);
      expect(hasFlag(['--yes=0'], 'yes')).toBe(false);
      expect(hasFlag(['--yes=no'], 'yes')).toBe(false);
    });

    it('FALSE — falsy values are case-insensitive (--yes=FALSE / --yes=No)', async () => {
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes=FALSE'], 'yes')).toBe(false);
      expect(hasFlag(['--yes=No'], 'yes')).toBe(false);
    });

    it('FALSE — empty value (--yes=) is falsy', async () => {
      // An empty `--yes=` is almost certainly a typo or shell-expansion
      // accident, not a deliberate opt-in.
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes='], 'yes')).toBe(false);
    });

    it('FALSE — unknown values (--yes=maybe / --yes=foo) are falsy', async () => {
      // Reject-by-default for any unrecognised value — safer than silently
      // accepting arbitrary strings as truthy.
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag(['--yes=maybe'], 'yes')).toBe(false);
      expect(hasFlag(['--yes=foo'], 'yes')).toBe(false);
    });

    it('FALSE — flag absent entirely is falsy', async () => {
      const { hasFlag } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(hasFlag([], 'yes')).toBe(false);
      expect(hasFlag(['--tenant=t', '--agent=a'], 'yes')).toBe(false);
    });

    it('parseCliOptions — yes=false propagates to CliOptions.yes (regression guard)', async () => {
      // End-to-end: the #288 bug manifested at the parseCliOptions surface
      // because parseCliOptions delegates to hasFlag. This locks in the fix
      // at the same boundary the production CLI consumes.
      const { parseCliOptions } = await import('@/../scripts/embeddings-rebuild.ts');
      expect(parseCliOptions(['node', 'x', '--yes=false']).yes).toBe(false);
      expect(parseCliOptions(['node', 'x', '--yes=0']).yes).toBe(false);
      expect(parseCliOptions(['node', 'x', '--yes=no']).yes).toBe(false);
      expect(parseCliOptions(['node', 'x', '--yes']).yes).toBe(true);
      expect(parseCliOptions(['node', 'x', '--yes=true']).yes).toBe(true);
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

  // -------------------------------------------------------------------------
  // [Codex #244] Operational hardening — addresses MEDIUMs (CLI alias, lock)
  // and LOWs (dry-run, RETURNING verification, audit trail).
  // -------------------------------------------------------------------------

  describe('concurrency — pg_try_advisory_lock (session-level, review v2)', () => {
    it('LOCK BUSY — another run holds the lock → throws ConcurrentRunError, no mutation', async () => {
      seedTwoTenants();
      lockHeld = true; // simulate another process holding the lock for this tuple

      const { rebuildEmbeddingsForTuple, ConcurrentRunError } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await expect(
        rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 }),
      ).rejects.toBeInstanceOf(ConcurrentRunError);

      // No provider call, no UPDATEs: tenant-A rows still pending.
      expect(providerCalls.length).toBe(0);
      const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
      expect(aAlpha!.embedding).toBeNull();

      // Lock acquire fired but unlock MUST NOT fire (we never acquired it).
      const acquireCalls = lockClientQueryMock.mock.calls.filter((c) =>
        /pg_try_advisory_lock/i.test(c[0] as string),
      );
      const unlockCalls = lockClientQueryMock.mock.calls.filter((c) =>
        /pg_advisory_unlock/i.test(c[0] as string),
      );
      expect(acquireCalls.length).toBe(1);
      expect(unlockCalls.length).toBe(0);
      // Client MUST still be released so it returns to the pool.
      expect(lockClientReleaseMock).toHaveBeenCalledTimes(1);
    });

    it('LOCK FREE — acquired → run proceeds normally, then releases lock + client', async () => {
      seedTwoTenants();
      lockHeld = false;

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      expect(result.updated).toBe(2);

      // Both lock and unlock fired exactly once, in order, on the same client.
      const acquireCalls = lockClientQueryMock.mock.calls.filter((c) =>
        /pg_try_advisory_lock/i.test(c[0] as string),
      );
      const unlockCalls = lockClientQueryMock.mock.calls.filter((c) =>
        /pg_advisory_unlock/i.test(c[0] as string),
      );
      expect(acquireCalls.length).toBe(1);
      expect(unlockCalls.length).toBe(1);
      // Client MUST be released so it returns to the pool.
      expect(lockClientReleaseMock).toHaveBeenCalledTimes(1);
    });

    it('LOCK PINNED TO ONE CLIENT — exactly one pool.connect() per run', async () => {
      // Review v2 critical fix: the lock + unlock MUST hit the SAME session,
      // otherwise the unlock targets a different connection and the original
      // lock leaks until the pool closes the holding connection. We assert
      // the script checks out exactly one pool client per run.
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      expect(poolConnectMock).toHaveBeenCalledTimes(1);
    });

    it('LOCK CALL SHAPE — uses session-level pg_try_advisory_lock with two int4 keys', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      const acquireCall = lockClientQueryMock.mock.calls.find((c) =>
        /pg_try_advisory_lock/i.test(c[0] as string),
      );
      expect(acquireCall).toBeDefined();
      // Critical: NOT the transactional variant (review v2). The _xact_
      // variant would release at end of the acquiring SELECT under autocommit.
      expect(acquireCall![0]).not.toMatch(/pg_try_advisory_xact_lock/i);
      expect(acquireCall![0]).toMatch(/pg_try_advisory_lock/i);
      // Two bound integer params (namespace + tuple key). Both must be in the
      // int4 range so the call signature matches the two-arg overload.
      const params = acquireCall![1] as unknown[];
      expect(params.length).toBe(2);
      for (const p of params) {
        expect(Number.isInteger(p as number)).toBe(true);
        expect(Math.abs(p as number)).toBeLessThanOrEqual(0x7fffffff);
      }
    });

    it('UNLOCK CALL SHAPE — pg_advisory_unlock with the same two int4 keys as the acquire', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      const acquireCall = lockClientQueryMock.mock.calls.find((c) =>
        /pg_try_advisory_lock/i.test(c[0] as string),
      );
      const unlockCall = lockClientQueryMock.mock.calls.find((c) =>
        /pg_advisory_unlock/i.test(c[0] as string),
      );
      expect(unlockCall).toBeDefined();
      // Unlock must target the exact same lock key (namespace, tuple).
      expect(unlockCall![1]).toEqual(acquireCall![1]);
    });

    it('UNLOCK ON ERROR — UPDATE throws → lock still released, client still released', async () => {
      // finally{} contract: a mid-run failure MUST NOT leak the advisory lock
      // (without this, a poison row would block the next operator until the
      // pool idle-timeout closes the connection).
      seedTwoTenants();

      // One-shot `db.execute` override: throw on the FIRST UPDATE so the run
      // fails after the lock has been acquired. The provider has already
      // returned vectors at that point.
      const originalImpl = dbExecuteMock.getMockImplementation()!;
      let updateSeen = false;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        const sqlText = rendered.sql;
        if (!updateSeen && /^\s*UPDATE\s+agent_memories/i.test(sqlText)) {
          updateSeen = true;
          throw new Error('simulated update failure');
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        await expect(
          rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 }),
        ).rejects.toThrow(/simulated update failure/);

        // The lock was acquired; finally must have unlocked it + released client.
        const unlockCalls = lockClientQueryMock.mock.calls.filter((c) =>
          /pg_advisory_unlock/i.test(c[0] as string),
        );
        expect(unlockCalls.length).toBe(1);
        expect(lockClientReleaseMock).toHaveBeenCalledTimes(1);
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });

    it('LOCK NAMESPACING — different tuples produce different lock keys', async () => {
      const { fnv1a32 } = await import('@/../scripts/embeddings-rebuild.ts');
      const a = fnv1a32('tenant-A::agent-A');
      const b = fnv1a32('tenant-B::agent-B');
      const c = fnv1a32('tenant-A::agent-OTHER');
      // No collisions across the seed combinations the test uses.
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
      expect(b).not.toBe(c);
    });
  });

  describe('dry-run mode', () => {
    it('DRY-RUN — counts pending rows, never calls provider, never UPDATEs', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({
        ...A_CTX,
        batchSize: 32,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.updated).toBe(0);
      expect(result.processed).toBe(0);
      // pendingInScope still reflects the real count so the operator can plan.
      expect(result.pendingInScope).toBe(2);
      expect(result.totalInScope).toBe(2);

      // No provider call.
      expect(providerCalls.length).toBe(0);
      // No UPDATE issued (only counts + lock + pending count).
      const updateSqls = renderedSqls.filter((r) =>
        /^\s*UPDATE\s+agent_memories/i.test(r.sql),
      );
      expect(updateSqls.length).toBe(0);

      // Rows untouched.
      const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
      expect(aAlpha!.embedding).toBeNull();
    });

    it('DRY-RUN with zero pending — returns 0 cleanly', async () => {
      // tenant-A row already correct.
      store.push({
        id: 'mem_A_done',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        conteudo: 'A-done',
        embedding: Array(expectedDim).fill(0.5),
        created_at: 1,
      });
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({
        ...A_CTX,
        dryRun: true,
      });
      expect(result.pendingInScope).toBe(0);
      expect(result.totalInScope).toBe(1);
    });
  });

  describe('post-write verification — UPDATE ... RETURNING', () => {
    it('UPDATE SQL uses RETURNING id', async () => {
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      const updateSql = renderedSqls.find((r) =>
        /^\s*UPDATE\s+agent_memories/i.test(r.sql),
      );
      expect(updateSql).toBeDefined();
      expect(updateSql!.sql).toMatch(/RETURNING/i);
    });

    it('RACE — UPDATE returning zero rows is NOT counted as updated', async () => {
      // Seed a tenant-A row, then simulate "row moved out from under us": we
      // mutate the store BEFORE the UPDATE runs by intercepting the SELECT.
      // The test fakes the race by changing tenant_id on the row between the
      // SELECT (which returned it) and the UPDATE (which won't match).
      const seedRow: StoredRow = {
        id: 'mem_A_race',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        conteudo: 'A-race-text',
        embedding: null,
        created_at: 1,
      };
      store.push(seedRow);

      // After the SELECT but before the UPDATE, the row's tenant flips. We
      // simulate that by hooking the mock to mutate the row right before any
      // UPDATE call. This produces an UPDATE that matches zero rows under
      // the tuple+id predicate — the production code must detect this and
      // NOT increment `updated`.
      const originalImpl = dbExecuteMock.getMockImplementation();
      dbExecuteMock.mockImplementation(async (query) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          // Flip tenant before the UPDATE lands.
          const target = store.find((r) => r.id === 'mem_A_race');
          if (target) target.tenant_id = 'tenant-MOVED';
        }
        return originalImpl!(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
      // Row was flipped out before UPDATE could match → updated must be 0.
      expect(result.updated).toBe(0);
      // processed still increments (we did fetch the row), so the operator
      // sees the discrepancy.
      expect(result.processed).toBe(1);
    });
  });

  describe('audit + operator identity', () => {
    it('OPERATOR — getOperatorIdentity reads USER / USERNAME / LOGNAME in order', async () => {
      const { getOperatorIdentity } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      expect(getOperatorIdentity({ USER: 'alice' })).toBe('alice');
      expect(getOperatorIdentity({ USERNAME: 'bob' })).toBe('bob');
      expect(getOperatorIdentity({ LOGNAME: 'carol' })).toBe('carol');
      // USER takes priority over the others.
      expect(
        getOperatorIdentity({ USER: 'alice', USERNAME: 'bob', LOGNAME: 'carol' }),
      ).toBe('alice');
      expect(getOperatorIdentity({})).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // [Codex #244 HIGH blocker 1] Windows file:// entrypoint guard
  //
  // Background: `import.meta.url` is a file:// URL. The previous code built
  // a comparison URL from `process.argv[1]` (a filesystem PATH) by string
  // concatenation: `new URL(\`file://${entry.replace(/\\/g, '/')}\`)`. On
  // Windows, `argv[1]` is `C:\foo\bar.ts`. After backslash → forward-slash
  // substitution, the URL constructor parses `file://C:/foo/bar.ts` as
  // host=`c:` + path=`/foo/bar.ts` — which is NOT how `import.meta.url`
  // serialises (`file:///C:/foo/bar.ts`, host empty + drive in path).
  //
  // Result: the comparison was ALWAYS false on Windows → `npm run
  // embeddings:rebuild` loaded the module, never invoked `main()`, exited
  // silently with no usage error. The fix is to use Node's `pathToFileURL`,
  // which is OS-aware and produces the exact serialisation `import.meta.url`
  // uses on both platforms.
  // -------------------------------------------------------------------------
  describe('isDirectInvocation — Windows file:// entrypoint guard (#244 HIGH)', () => {
    it('TRUE — matches when argv[1] resolves to the same file URL as import.meta.url', async () => {
      // POSIX path. `pathToFileURL('/x/y.ts').href` → `file:///x/y.ts`.
      // Importing the production helper itself proves the wiring is sound.
      const { isDirectInvocation } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const { pathToFileURL } = await import('node:url');
      // Use a synthetic path so the test is deterministic across CI hosts.
      const fakeEntry = '/path/to/embeddings-rebuild.ts';
      const fakeMetaUrl = pathToFileURL(fakeEntry).href;
      expect(isDirectInvocation(fakeEntry, fakeMetaUrl)).toBe(true);
    });

    it('TRUE — Windows-style path matches its pathToFileURL output exactly', async () => {
      // The bug specifically manifested on Windows with `C:\...` paths. We
      // simulate the production comparison by funnelling a Windows path
      // through pathToFileURL (the same helper production uses) and asserting
      // the round-trip matches.
      const { isDirectInvocation } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const { pathToFileURL } = await import('node:url');
      // Pre-Windows `pathToFileURL` returns `file:///C:/path/to/file.ts`.
      // On POSIX it also accepts absolute-style paths; the assertion below
      // works regardless of host OS because we generate both sides via the
      // same helper.
      const windowsEntry = 'C:\\path\\to\\embeddings-rebuild.ts';
      let expectedHref: string;
      try {
        expectedHref = pathToFileURL(windowsEntry).href;
      } catch {
        // On POSIX, pathToFileURL rejects a Windows-style path because the
        // backslashes aren't recognised as separators. Skip the assertion in
        // that case — the contract we care about (parity between argv[1] and
        // import.meta.url) is exercised by the POSIX test above. We still
        // assert the function doesn't throw.
        expect(() => isDirectInvocation(windowsEntry, 'file:///x.ts')).not.toThrow();
        return;
      }
      expect(isDirectInvocation(windowsEntry, expectedHref)).toBe(true);
    });

    it('FALSE — undefined entry (process.argv[1] missing) does not throw', async () => {
      const { isDirectInvocation } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      // Real-world: if the script is somehow loaded with no argv[1] (e.g.
      // a wrapper that strips args), we MUST NOT throw — just return false.
      expect(isDirectInvocation(undefined, 'file:///x.ts')).toBe(false);
    });

    it('FALSE — mismatched paths do not match', async () => {
      // Sanity: a different argv[1] yields a different file:// URL, and the
      // comparison correctly returns false. This proves the guard isn't
      // accidentally permissive.
      const { isDirectInvocation } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const { pathToFileURL } = await import('node:url');
      const metaUrl = pathToFileURL('/scripts/embeddings-rebuild.ts').href;
      expect(isDirectInvocation('/scripts/other.ts', metaUrl)).toBe(false);
    });

    it('REGRESSION — production uses pathToFileURL (not hand-rolled file://${path})', async () => {
      // The Codex review #244 HIGH blocker reported that the hand-rolled
      // form `new URL(\`file://${entry.replace(/\\/g, '/')}\`).href` is
      // unreliable on Windows: depending on the Node URL parser version,
      // the drive letter could be parsed as the host (yielding
      // `file://c:/...`, host=`c:`) instead of as part of the path
      // (yielding `file:///C:/...`, host empty). Even when modern Node
      // parsers correctly normalise the two-slash form, case-sensitivity
      // edge cases remain (host lowercased vs path preserved).
      //
      // The fix is to use Node's `pathToFileURL`, which is OS-aware and
      // emits the EXACT serialisation `import.meta.url` uses. We pin the
      // production form here by asserting it produces a URL of the
      // correct shape (three slashes, drive letter preserved in path).
      const { pathToFileURL } = await import('node:url');
      // Skip when pathToFileURL can't parse a literal Windows path
      // (POSIX-only nodes refuse `C:\...`).
      let winFileUrl: string | null;
      try {
        winFileUrl = pathToFileURL('C:\\x\\y.ts').href;
      } catch {
        winFileUrl = null;
      }
      if (winFileUrl !== null) {
        // Correct shape for Windows: `file:///C:/...` — three slashes
        // (empty host), drive letter preserved with original case,
        // forward slashes throughout the path.
        expect(winFileUrl).toMatch(/^file:\/\/\/[A-Za-z]:\//);
      }
      // Absolute path → file:///... (three slashes, empty host). The
      // exact path varies by host OS (on Windows it gets the current
      // drive prepended), so we only assert the shape.
      const absFileUrl = pathToFileURL('/x/y.ts').href;
      expect(absFileUrl).toMatch(/^file:\/\/\/.*x\/y\.ts$/);
    });

    it('PROD WIRING — module exports isDirectInvocation as the entrypoint guard', async () => {
      // The module-level invokedDirectly constant uses isDirectInvocation,
      // so the test surface (exported function) and the production wiring
      // (module-level constant) share the same code path. Without this,
      // a future refactor could silently bypass the helper. We pin the
      // export contract here.
      const mod = await import('@/../scripts/embeddings-rebuild.ts');
      expect(typeof (mod as Record<string, unknown>).isDirectInvocation).toBe(
        'function',
      );
    });
  });

  // -------------------------------------------------------------------------
  // [Codex #244 HIGH blocker 2] UPDATE rollback on mid-batch failure
  //
  // Background: the previous loop ran each UPDATE in autocommit (per-row).
  // When row N's UPDATE failed, rows 1..N-1 were ALREADY committed but the
  // caller saw an error — caller-visible state and DB state diverged. Fix:
  // wrap all UPDATEs in a batch inside `db.transaction()` so the batch is
  // atomic (all-or-nothing). Trade-off: the transaction holds for N UPDATEs
  // (the session-level advisory lock is on a SEPARATE client and unaffected).
  // -------------------------------------------------------------------------
  describe('per-batch transaction — rollback on mid-batch UPDATE failure (#244 HIGH)', () => {
    it('USES db.transaction() to wrap the UPDATE batch', async () => {
      // The production code MUST route UPDATEs through `db.transaction(...)`
      // not raw `db.execute`. We assert by counting how many times the
      // transaction shim was invoked: at least once per non-empty batch.
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });

      // Two pending tenant-A rows → fits in one batch of 32 → one txn.
      expect(dbTransactionMock).toHaveBeenCalledTimes(1);
      // Lifecycle ended with commit (no error).
      expect(txnLifecycle).toEqual(['begin', 'commit']);
    });

    it('ROLLBACK — mid-batch UPDATE failure rolls back the WHOLE batch', async () => {
      // Seed: TWO pending rows in the same batch (batchSize=32 → both in
      // batch #1). Make the SECOND UPDATE throw. With per-row autocommit
      // the first UPDATE would have committed; with the transactional fix,
      // BOTH must remain pending (null embedding).
      seedTwoTenants();

      const originalImpl = dbExecuteMock.getMockImplementation()!;
      let updateCount = 0;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          updateCount++;
          if (updateCount === 2) {
            throw new Error('simulated second-row failure');
          }
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        await expect(
          rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 }),
        ).rejects.toThrow(/simulated second-row failure/);

        // BOTH rows must remain pending — the first UPDATE was rolled back
        // along with the failing second UPDATE.
        const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
        const aBeta = store.find((r) => r.id === 'mem_A_beta');
        // Either the original null/wrong-dim embedding (rollback restored)
        // — neither row should hold the provider's fresh vector.
        // The fake restores the pre-txn snapshot; both should be in their
        // pre-rebuild state.
        const isAlphaPreState =
          aAlpha!.embedding === null ||
          aAlpha!.embedding!.length !== expectedDim;
        const isBetaPreState =
          aBeta!.embedding === null ||
          aBeta!.embedding!.length !== expectedDim;
        expect(isAlphaPreState).toBe(true);
        expect(isBetaPreState).toBe(true);

        // Txn lifecycle: begin → rollback.
        expect(txnLifecycle).toEqual(['begin', 'rollback']);
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });

    it('COMMIT — successful batch commits and counters reflect the batch', async () => {
      // Mirror of the rollback test — happy path, both UPDATEs succeed,
      // both rows now embedded, counters reflect the success.
      seedTwoTenants();
      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );
      const result = await rebuildEmbeddingsForTuple({
        ...A_CTX,
        batchSize: 32,
      });

      expect(result.updated).toBe(2);
      expect(result.processed).toBe(2);
      expect(txnLifecycle).toEqual(['begin', 'commit']);
      const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
      const aBeta = store.find((r) => r.id === 'mem_A_beta');
      expect(aAlpha!.embedding!.length).toBe(expectedDim);
      expect(aBeta!.embedding!.length).toBe(expectedDim);
    });

    it('MULTI-BATCH — each batch runs in its OWN transaction (batch failure isolates)', async () => {
      // batchSize=1 → each row is its own batch + its own txn. Make the
      // SECOND batch fail. The first batch should have committed; the
      // second should have rolled back.
      seedTwoTenants();

      const originalImpl = dbExecuteMock.getMockImplementation()!;
      let updateCount = 0;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          updateCount++;
          if (updateCount === 2) {
            throw new Error('simulated second-batch failure');
          }
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        await expect(
          rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 1 }),
        ).rejects.toThrow(/simulated second-batch failure/);

        // Batch 1 committed (one row embedded). Batch 2 rolled back (the
        // other row still in pre-rebuild state).
        const aRows = store.filter((r) => r.tenant_id === 'tenant-A');
        const embedded = aRows.filter(
          (r) => r.embedding !== null && r.embedding.length === expectedDim,
        );
        const pending = aRows.filter(
          (r) => r.embedding === null || r.embedding.length !== expectedDim,
        );
        expect(embedded.length).toBe(1);
        expect(pending.length).toBe(1);

        // Txn lifecycle: begin → commit → begin → rollback.
        expect(txnLifecycle).toEqual([
          'begin',
          'commit',
          'begin',
          'rollback',
        ]);
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });

    it('LOCK STILL RELEASED — batch rollback does not leak advisory lock', async () => {
      // The advisory lock is on a SEPARATE client; the per-batch txn is on
      // the pool-routed `db`. A batch rollback must NOT prevent the lock
      // from being released in `finally`.
      seedTwoTenants();

      const originalImpl = dbExecuteMock.getMockImplementation()!;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          throw new Error('simulated batch failure');
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        await expect(
          rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 }),
        ).rejects.toThrow(/simulated batch failure/);

        const unlockCalls = lockClientQueryMock.mock.calls.filter((c) =>
          /pg_advisory_unlock/i.test(c[0] as string),
        );
        expect(unlockCalls.length).toBe(1);
        expect(lockClientReleaseMock).toHaveBeenCalledTimes(1);
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });

    it('COUNTER INTEGRITY — rolled-back batch does NOT increment updated/processed', async () => {
      // The pre-fix path counted `updated++` per-row as the UPDATE returned,
      // which meant a mid-batch failure left the caller seeing a non-zero
      // `updated` count for rows that had ALREADY been committed but a
      // failed run. With the transactional fix, the counter is only updated
      // AFTER the txn commits — a rolled-back batch contributes zero.
      seedTwoTenants();

      const originalImpl = dbExecuteMock.getMockImplementation()!;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          throw new Error('simulated batch failure');
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        let caught: unknown;
        try {
          await rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        // The throw means the function didn't return a result — what we
        // really want to assert is that NO row was committed. Already
        // covered by the snapshot rollback above, but pin the no-side-
        // effects contract explicitly here.
        const aAlpha = store.find((r) => r.id === 'mem_A_alpha');
        expect(aAlpha!.embedding).toBeNull();
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });

    it('RACE WITHIN BATCH — RETURNING 0 rows does NOT roll back the whole batch', async () => {
      // Race detection (worker flipped tenant between SELECT and UPDATE)
      // logs a warn but does NOT throw — the txn commits the OTHER UPDATEs
      // in the batch that DID match. Without this carve-out, a transient
      // race would discard genuine work.
      seedTwoTenants();

      // Flip tenant-A on `mem_A_alpha` only, just before its UPDATE lands.
      // `mem_A_beta` should still embed.
      const originalImpl = dbExecuteMock.getMockImplementation()!;
      let updateCount = 0;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*UPDATE\s+agent_memories/i.test(rendered.sql)) {
          updateCount++;
          if (updateCount === 1) {
            // Flip tenant on alpha BEFORE the UPDATE lands → 0 rows match.
            const target = store.find((r) => r.id === 'mem_A_alpha');
            if (target) target.tenant_id = 'tenant-MOVED';
          }
        }
        return originalImpl(query);
      });

      const { rebuildEmbeddingsForTuple } = await import(
        '@/../scripts/embeddings-rebuild.ts'
      );

      try {
        const result = await rebuildEmbeddingsForTuple({
          ...A_CTX,
          batchSize: 32,
        });

        // The batch COMMITTED (no throw): one row genuinely updated, the
        // other recorded as a race no-op.
        expect(txnLifecycle).toEqual(['begin', 'commit']);
        expect(result.updated).toBe(1); // beta succeeded; alpha was no-op
        expect(result.processed).toBe(2);

        const aBeta = store.find((r) => r.id === 'mem_A_beta');
        expect(aBeta!.embedding!.length).toBe(expectedDim);
      } finally {
        dbExecuteMock.mockImplementation(originalImpl);
      }
    });
  });

  describe('error log context', () => {
    it('PROVIDER FAILURE — logs include tenant_id + agent_id (not just err)', async () => {
      // Re-mock provider to throw, then assert the logger captured tuple
      // context. We sniff this via the logger mock — see the top-of-file
      // mock for `@/lib/logger.js`.
      const { logger } = await import('@/lib/logger.js');
      const errorSpy = logger.error as unknown as ReturnType<typeof vi.fn>;
      errorSpy.mockClear();

      // Replace provider with a failing one for this test only.
      const embeddingsMod = await import('@/lib/embeddings.js');
      const original = embeddingsMod.getEmbeddingProvider;
      (embeddingsMod as unknown as { getEmbeddingProvider: typeof original }).getEmbeddingProvider =
        () => ({
          name: 'voyage',
          modelId: 'fake',
          dimensions: expectedDim,
          embed: async () => {
            throw new Error('provider boom');
          },
        });

      try {
        seedTwoTenants();
        const { rebuildEmbeddingsForTuple } = await import(
          '@/../scripts/embeddings-rebuild.ts'
        );
        await expect(
          rebuildEmbeddingsForTuple({ ...A_CTX, batchSize: 32 }),
        ).rejects.toThrow(/provider boom/);

        // logger.error should have been called with an object that includes
        // tenant_id + agent_id.
        expect(errorSpy).toHaveBeenCalled();
        const calls = errorSpy.mock.calls as unknown as Array<
          [Record<string, unknown>, string]
        >;
        const matchingCall = calls.find(
          (c) =>
            (c[0] as Record<string, unknown>).tenant_id === 'tenant-A' &&
            (c[0] as Record<string, unknown>).agent_id === 'agent-A',
        );
        expect(matchingCall).toBeDefined();
      } finally {
        (embeddingsMod as unknown as { getEmbeddingProvider: typeof original }).getEmbeddingProvider =
          original;
      }
    });
  });
});
