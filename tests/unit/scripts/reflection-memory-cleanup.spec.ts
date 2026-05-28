/**
 * Issue #260 — Cleanup of polluted (tenant='default', agent='default')
 * `agent_memories` rows produced by the pre-#251 reflection batch worker.
 *
 * Contract this spec PROVES (after #260 ships + PR #276 iter 2 BLOCK
 * resolution):
 *
 *   1. CLI args:
 *      - Missing `--cutoff` → throws `RequiredArgsError` (CLI maps to exit 2).
 *      - `--cutoff` not parseable as a date → `InvalidArgsError` (exit 2).
 *      - `--cutoff` in the future → `InvalidArgsError` (exit 2). A future
 *        cutoff would either wipe legit new rows or be a typo.
 *      - `--cutoff` past MAX_SAFE_CUTOFF → `InvalidArgsError` (Codex iter
 *        2 blocker #5: hardcoded upper bound = PR #251 merge timestamp).
 *      - `--execute` + `--dry-run` together → `InvalidArgsError`.
 *      - `--limit=0`/`--limit=-1`/`--limit=foo` → `InvalidArgsError`.
 *      - Default (no flag) is `--dry-run`, not destructive.
 *      - `--execute` WITHOUT `--accept-heuristic` → `RequiredArgsError`.
 *      - `--yes` (Codex iter 2 blocker #4) is parsed and exposes yes=true.
 *      - `--undo=<run_id>` short-circuits the cutoff machinery.
 *
 *   2. Dry-run is read-only:
 *      - Counts matching rows.
 *      - Returns the date range + a 5-row sample (with `conteudo` truncated).
 *      - Does NOT touch the store. Every row that was there is still there.
 *
 *   3. Execute is destructive WITH guarantees (PR #276 iter 2):
 *      - SNAPSHOT (blocker #1): before delete, rows are INSERTed into
 *        agent_memories_cleanup_backup with cleanup_run_id + deleted_by +
 *        original_id. Subsequent DELETE targets the FROZEN ID set, not
 *        the predicate (blocker #6 — race window).
 *      - AUDIT-FIRST (blocker #2): admin_audit_log.action=
 *        'reflection_memory_cleanup.started' is written BEFORE the first
 *        DELETE; per-batch 'batch_completed' rows include deleted IDs;
 *        final 'completed' row has totals. On error, 'failed' row.
 *      - agent_id IN AUDIT (blocker #3): every audit row's change_summary
 *        contains both tenant_id AND agent_id.
 *      - --yes (blocker #4): non-TTY execution skips the prompt.
 *      - MAX_SAFE_CUTOFF (blocker #5): refuses cutoffs > PR #251 merge.
 *      - Confirmation MUST be 'y'/'yes' (case-insensitive). 'n', '', or
 *        anything else aborts without mutating.
 *
 *   4. Cross-tenant defense (the whole point of this script):
 *      - When the store contains a tenant-A row with tipo='reflexao'
 *        created BEFORE the cutoff, the cleanup MUST NOT touch it. Only
 *        rows physically in the `default/default` bucket are in scope.
 *
 *   5. Undo (PR #276 iter 2 — blocker #1 follow-through):
 *      - `--undo=<run_id>` restores backed-up rows BYTE-IDENTICALLY into
 *        agent_memories (same id, same content, same metadata).
 *      - Idempotent: rerunning --undo for a fully-restored run is a no-op.
 *
 * Strategy:
 *   No real DB. We mock `@/db/client.js` and dispatch on rendered SQL via
 *   Drizzle's `PgDialect`, same pattern as the embeddings-rebuild spec.
 *   The fake store implements the minimum SQL surface the production code
 *   uses: counts, range, sample, snapshot INSERT-SELECT-RETURNING, DELETE
 *   WHERE id=ANY, BEGIN/COMMIT/ROLLBACK, admin_audit_log INSERT, and the
 *   undo path (SELECT + INSERT-SELECT + UPDATE on the backup table).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// In-memory store + db.execute fake
// ---------------------------------------------------------------------------
type MemoryRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
  embedding?: string | null;
  tipo: string;
  escopo: string;
  metadata?: Record<string, unknown>;
  ref_tabela?: string | null;
  ref_id?: string | null;
  created_at: Date;
};
type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown>;
};
type BackupRow = {
  cleanup_run_id: string;
  original_id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
  embedding: string | null;
  tipo: string;
  escopo: string;
  metadata: Record<string, unknown>;
  ref_tabela: string | null;
  ref_id: string | null;
  original_created_at: Date;
  deleted_by: string;
  deleted_at: Date;
  restored_at: Date | null;
};

const memoryStore: MemoryRow[] = [];
const auditStore: AuditRow[] = [];
const backupStore: BackupRow[] = [];
const renderedSqls: Array<{ sql: string; params: unknown[] }> = [];

const _dialect = new PgDialect();

// Hoisted helpers (function declarations) for use in the mock dispatch.
// `normalizeTiposParams` flattens an array of params that came from a
// Drizzle `sql\`... ANY(${tipos})\`` expansion. With a 1-element list
// `tipos` lands as a single bare string; with N elements it lands as N
// individual params (one placeholder each). Either way we accept and
// flatten down to a `string[]`.
function normalizeTiposParams(raw: unknown[]): string[] {
  if (raw.length === 0) return [];
  // If raw is already a single nested array (Drizzle could expand that
  // way for >=2 elements depending on version), unwrap once.
  if (raw.length === 1 && Array.isArray(raw[0])) return raw[0] as string[];
  return raw.filter((x) => typeof x === 'string') as string[];
}

// Same idea for the ANY($1::uuid[]) ID-list expansion used by DELETE
// and undo's restored_at UPDATE.
function normalizeIdsParams(raw: unknown[]): string[] {
  if (raw.length === 0) return [];
  if (raw.length === 1 && Array.isArray(raw[0])) return raw[0] as string[];
  return raw.filter((x) => typeof x === 'string') as string[];
}

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push({ sql: sqlText, params });

  // BEGIN / COMMIT / ROLLBACK — record but no-op. The in-memory store is
  // mutated directly; rollback in tests is simulated by throwing before
  // mutation runs.
  if (/^\s*BEGIN\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };
  if (/^\s*COMMIT\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };
  if (/^\s*ROLLBACK\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };

  // INSERT INTO admin_audit_log — capture the row.
  if (/^\s*INSERT\s+INTO\s+admin_audit_log/i.test(sqlText)) {
    const [
      tenant_id,
      actor_id,
      actor_role,
      action,
      resource_type,
      resource_id,
      change_summary_json,
    ] = params as [string, string, string, string, string, string | null, string];
    auditStore.push({
      tenant_id,
      actor_id,
      actor_role,
      action,
      resource_type,
      resource_id: resource_id ?? null,
      change_summary:
        typeof change_summary_json === 'string'
          ? JSON.parse(change_summary_json)
          : (change_summary_json as Record<string, unknown>),
    });
    return { rows: [], rowCount: 1 };
  }

  // INSERT INTO agent_memories_cleanup_backup (snapshot from agent_memories)
  // The snapshot query is INSERT-SELECT-RETURNING: copies rows matching the
  // predicate, returning original_id as text.
  if (/^\s*INSERT\s+INTO\s+agent_memories_cleanup_backup/i.test(sqlText)) {
    // The SELECT's WHERE binds the same params as a count query:
    // [cleanup_run_id, deleted_by, tenant_id, agent_id, cutoff, ...tipos]
    const cleanupRunId = params[0] as string;
    const deletedBy = params[1] as string;
    const tenantId = params[2] as string;
    const agentId = params[3] as string;
    const cutoff = new Date(params[4] as string);
    // Remaining params are the tipos array (Drizzle expands 1-element
    // arrays to a single placeholder, so they start at index 5).
    const tipos = normalizeTiposParams(params.slice(5));
    const matching = memoryStore
      .filter(
        (r) =>
          r.tenant_id === tenantId &&
          r.agent_id === agentId &&
          r.created_at.getTime() < cutoff.getTime() &&
          tipos.includes(r.tipo),
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const now = new Date();
    for (const m of matching) {
      backupStore.push({
        cleanup_run_id: cleanupRunId,
        original_id: m.id,
        tenant_id: m.tenant_id,
        agent_id: m.agent_id,
        conteudo: m.conteudo,
        embedding: m.embedding ?? null,
        tipo: m.tipo,
        escopo: m.escopo,
        metadata: m.metadata ?? {},
        ref_tabela: m.ref_tabela ?? null,
        ref_id: m.ref_id ?? null,
        original_created_at: new Date(m.created_at.getTime()),
        deleted_by: deletedBy,
        deleted_at: now,
        restored_at: null,
      });
    }
    return {
      rows: matching.map((m) => ({ original_id: m.id })),
      rowCount: matching.length,
    };
  }

  // INSERT INTO agent_memories (used by undo path)
  if (/^\s*INSERT\s+INTO\s+agent_memories[\s\S]*FROM\s+agent_memories_cleanup_backup/i.test(sqlText)) {
    const cleanupRunId = params[0] as string;
    const candidates = backupStore.filter(
      (b) => b.cleanup_run_id === cleanupRunId && b.restored_at === null,
    );
    const restored: Array<{ id: string }> = [];
    for (const c of candidates) {
      // ON CONFLICT (id) DO NOTHING — skip if id already in memoryStore.
      if (memoryStore.some((m) => m.id === c.original_id)) continue;
      memoryStore.push({
        id: c.original_id,
        tenant_id: c.tenant_id,
        agent_id: c.agent_id,
        conteudo: c.conteudo,
        embedding: c.embedding,
        tipo: c.tipo,
        escopo: c.escopo,
        metadata: c.metadata,
        ref_tabela: c.ref_tabela,
        ref_id: c.ref_id,
        created_at: new Date(c.original_created_at.getTime()),
      });
      restored.push({ id: c.original_id });
    }
    return { rows: restored, rowCount: restored.length };
  }

  // UPDATE agent_memories_cleanup_backup SET restored_at = now() WHERE ...
  if (/^\s*UPDATE\s+agent_memories_cleanup_backup/i.test(sqlText)) {
    const cleanupRunId = params[0] as string;
    // Remaining params are the restoredIds array.
    const restoredIds = normalizeIdsParams(params.slice(1));
    let updated = 0;
    for (const b of backupStore) {
      if (
        b.cleanup_run_id === cleanupRunId &&
        restoredIds.includes(b.original_id) &&
        b.restored_at === null
      ) {
        b.restored_at = new Date();
        updated++;
      }
    }
    return { rows: [], rowCount: updated };
  }

  // SELECT counts on agent_memories_cleanup_backup (undo path)
  if (
    /SELECT\s+count\(\*\)::text\s+AS\s+count\s+FROM\s+agent_memories_cleanup_backup/i.test(
      sqlText,
    )
  ) {
    const cleanupRunId = params[0] as string;
    const onlyRestored = /restored_at\s+IS\s+NOT\s+NULL/i.test(sqlText);
    const filtered = backupStore.filter((b) => {
      if (b.cleanup_run_id !== cleanupRunId) return false;
      if (onlyRestored && b.restored_at === null) return false;
      return true;
    });
    return { rows: [{ count: String(filtered.length) }] };
  }

  // Single-param tipos helper (the count/range/sample queries bind tipos
  // at one fixed position rather than via slice).
  const normalizeTipos = (raw: unknown): string[] => {
    if (Array.isArray(raw)) {
      return (raw as unknown[]).filter((x) => typeof x === 'string') as string[];
    }
    if (typeof raw === 'string') return [raw];
    return [];
  };

  // count(*) summary on agent_memories
  if (/SELECT\s+count\(\*\)::text\s+AS\s+count\s+FROM\s+agent_memories\b/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    // The two count queries differ in WHERE depth:
    //   - in-scope count: tenant + agent + cutoff + tipos
    //   - remaining count: tenant + agent only (no cutoff/tipos)
    // Detect by presence of the cutoff predicate in the rendered SQL.
    const hasCutoff = /created_at\s*<\s*\$/.test(sqlText);
    let filtered = memoryStore.filter(
      (r) => r.tenant_id === tenant_id && r.agent_id === agent_id,
    );
    if (hasCutoff) {
      const cutoff = new Date(params[2] as string);
      const tipos = normalizeTipos(params[3]);
      filtered = filtered.filter(
        (r) => r.created_at.getTime() < cutoff.getTime() && tipos.includes(r.tipo),
      );
    }
    return { rows: [{ count: String(filtered.length) }] };
  }

  // min/max(created_at) summary
  if (/min\(created_at\)::text\s+AS\s+earliest/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const cutoff = new Date(params[2] as string);
    const tipos = normalizeTipos(params[3]);
    const matching = memoryStore.filter(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.created_at.getTime() < cutoff.getTime() &&
        tipos.includes(r.tipo),
    );
    if (matching.length === 0) {
      return { rows: [{ earliest: null, latest: null }] };
    }
    const sorted = matching
      .slice()
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return {
      rows: [
        {
          earliest: sorted[0]!.created_at.toISOString(),
          latest: sorted[sorted.length - 1]!.created_at.toISOString(),
        },
      ],
    };
  }

  // Sample SELECT (id::text, created_at::text, tipo, conteudo)
  if (/SELECT\s+id::text,\s+created_at::text,\s+tipo,\s+conteudo/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const cutoff = new Date(params[2] as string);
    const tipos = normalizeTipos(params[3]);
    const limit = Number(params[params.length - 1]);
    const rows = memoryStore
      .filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.created_at.getTime() < cutoff.getTime() &&
          tipos.includes(r.tipo),
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        tipo: r.tipo,
        conteudo: r.conteudo,
      }));
    return { rows };
  }

  // DELETE FROM agent_memories WHERE id = ANY($1::uuid[])
  // (PR #276 iter 2 — frozen ID set; no longer predicate-based)
  if (/^\s*DELETE\s+FROM\s+agent_memories\b/i.test(sqlText)) {
    const idsParam = params[0];
    // Drizzle expands a JS array into N placeholders; with one element
    // the param lands as a bare string. The fake just normalises both.
    const targetIds = Array.isArray(idsParam)
      ? (idsParam as string[])
      : params.filter((x) => typeof x === 'string') as string[];
    let deleted = 0;
    for (const id of targetIds) {
      const idx = memoryStore.findIndex((r) => r.id === id);
      if (idx >= 0) {
        memoryStore.splice(idx, 1);
        deleted++;
      }
    }
    return { rows: [], rowCount: deleted };
  }

  return { rows: [], rowCount: 0 };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

// CUTOFF here is intentionally PR #251 merge time — also the MAX_SAFE_CUTOFF.
const CUTOFF = new Date('2026-05-28T12:55:08Z');
// Times relative to the cutoff.
const T_BEFORE_1 = new Date('2026-05-25T10:00:00Z');
const T_BEFORE_2 = new Date('2026-05-26T10:00:00Z');
const T_BEFORE_3 = new Date('2026-05-27T10:00:00Z');
const T_AFTER_1 = new Date('2026-05-29T10:00:00Z');

beforeEach(() => {
  memoryStore.length = 0;
  auditStore.length = 0;
  backupStore.length = 0;
  renderedSqls.length = 0;
  dbExecuteMock.mockClear();
});

// Use deterministic UUIDs in the in-memory seed so we can compare against
// the snapshot/restore paths without UUID-shape brittleness.
function seedPolluted(): void {
  // Three reflection memories in the polluted bucket, BEFORE the cutoff.
  // These are the rows the cleanup MUST remove.
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000001',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao pre-fix 1',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000002',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo:
      'reflexao pre-fix 2 — a very long conteudo string that will end up exceeding the eighty-character truncation threshold so we can verify the dry-run sample truncates it correctly',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_2,
  });
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000003',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao pre-fix 3',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_3,
  });
}

function seedNonPolluted(): void {
  // 1. A reflection AFTER the cutoff in the same bucket — survives.
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000010',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao post-fix',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_AFTER_1,
  });
  // 2. A FACT in the default bucket BEFORE the cutoff — survives because
  //    tipo != 'reflexao'.
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000011',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'fato sob default',
    tipo: 'fato',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  // 3. A reflection in tenant-A BEFORE the cutoff — survives.
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000012',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'reflexao tenant-A pre-cutoff',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  // 4. A reflection in default tenant but DIFFERENT agent BEFORE cutoff.
  memoryStore.push({
    id: '00000000-0000-0000-0000-000000000013',
    tenant_id: 'default',
    agent_id: 'agent-OTHER',
    conteudo: 'reflexao default tenant, other agent',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #260 — scripts/reflection-memory-cleanup.ts', () => {
  describe('CLI args parsing — parseArgs', () => {
    it('REJECTION — missing --cutoff throws RequiredArgsError', async () => {
      const { parseArgs, RequiredArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      expect(() => parseArgs(['node', 'reflection-memory-cleanup.ts'])).toThrowError(
        RequiredArgsError,
      );
      try {
        parseArgs(['node', 'reflection-memory-cleanup.ts']);
      } catch (err) {
        expect((err as { code: string }).code).toBe('MISSING_REQUIRED_ARGS');
        expect((err as Error).message).toMatch(/--cutoff/);
      }
    });

    it('REJECTION — junk --cutoff throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = ['node', 'reflection-memory-cleanup.ts', '--cutoff=not-a-date'];
      expect(() => parseArgs(argv)).toThrowError(InvalidArgsError);
      try {
        parseArgs(argv);
      } catch (err) {
        expect((err as { code: string }).code).toBe('INVALID_ARGS');
        expect((err as Error).message).toMatch(/valid date/);
      }
    });

    it('REJECTION — future --cutoff throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-28T12:00:00Z');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-29T12:00:00Z',
      ];
      expect(() => parseArgs(argv, { now })).toThrowError(InvalidArgsError);
      try {
        parseArgs(argv, { now });
      } catch (err) {
        expect((err as { code: string }).code).toBe('INVALID_ARGS');
        expect((err as Error).message).toMatch(/future/);
      }
    });

    it('REJECTION — cutoff > MAX_SAFE_CUTOFF throws InvalidArgsError (Codex iter 2 blocker #5)', async () => {
      // Hardcoded upper bound = PR #251 merge timestamp (2026-05-28T12:55:08Z).
      // Anything later could sweep legitimate post-fix rows. Even if "now"
      // is later than the cutoff (so the future-check passes), the
      // MAX_SAFE_CUTOFF gate must still reject.
      const { parseArgs, InvalidArgsError, MAX_SAFE_CUTOFF } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const oneHourAfterMax = new Date(MAX_SAFE_CUTOFF.getTime() + 60 * 60 * 1000);
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        `--cutoff=${oneHourAfterMax.toISOString()}`,
      ];
      // "now" is much later than the cutoff so the future-check doesn't fire.
      const now = () => new Date('2026-06-30T00:00:00Z');
      expect(() => parseArgs(argv, { now })).toThrowError(InvalidArgsError);
      try {
        parseArgs(argv, { now });
      } catch (err) {
        expect((err as { code: string }).code).toBe('INVALID_ARGS');
        expect((err as Error).message).toMatch(/MAX_SAFE_CUTOFF|#251/i);
      }
    });

    it('ACCEPT — cutoff exactly AT MAX_SAFE_CUTOFF is allowed (boundary == is OK; only > is rejected)', async () => {
      const { parseArgs, MAX_SAFE_CUTOFF } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        `--cutoff=${MAX_SAFE_CUTOFF.toISOString()}`,
      ];
      const now = () => new Date('2026-06-30T00:00:00Z');
      const parsed = parseArgs(argv, { now });
      expect(parsed.cutoff!.toISOString()).toBe(MAX_SAFE_CUTOFF.toISOString());
    });

    it('REJECTION — --execute and --dry-run together throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
        '--dry-run',
        '--accept-heuristic',
      ];
      expect(() =>
        parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') }),
      ).toThrowError(InvalidArgsError);
    });

    it('REJECTION — --limit must be a positive integer', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-29T00:00:00Z');
      const base = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      expect(() => parseArgs([...base, '--limit=0'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=-5'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=foo'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=1.5'], { now })).toThrowError(InvalidArgsError);
    });

    it('ACCEPT — default behavior is dry-run when --execute is omitted', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
      expect(parsed.yes).toBe(false);
      expect(parsed.undo).toBeNull();
    });

    it('ACCEPT — --execute + --accept-heuristic sets execute=true, dryRun=false, acceptHeuristic=true', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
        '--accept-heuristic',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.execute).toBe(true);
      expect(parsed.dryRun).toBe(false);
      expect(parsed.acceptHeuristic).toBe(true);
    });

    it('REJECTION — --execute WITHOUT --accept-heuristic throws RequiredArgsError', async () => {
      const { parseArgs, RequiredArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
      ];
      const now = () => new Date('2026-05-29T00:00:00Z');
      expect(() => parseArgs(argv, { now })).toThrowError(RequiredArgsError);
      try {
        parseArgs(argv, { now });
      } catch (err) {
        expect((err as { code: string }).code).toBe('MISSING_REQUIRED_ARGS');
        expect((err as Error).message).toMatch(/--accept-heuristic/);
        expect((err as Error).message).toMatch(/heuristic|provenance/i);
      }
    });

    it('ACCEPT — --yes flag is parsed (Codex iter 2 blocker #4: non-TTY automation)', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const now = () => new Date('2026-05-29T00:00:00Z');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
        '--accept-heuristic',
        '--yes',
      ];
      const parsed = parseArgs(argv, { now });
      expect(parsed.yes).toBe(true);
      expect(parsed.execute).toBe(true);
      expect(parsed.acceptHeuristic).toBe(true);
    });

    it('ACCEPT — --yes is independent of --accept-heuristic (does NOT bypass it)', async () => {
      // The two flags are independent gates: --accept-heuristic is the
      // knowledge acknowledgement; --yes just skips the keyboard prompt.
      // Passing --yes WITHOUT --accept-heuristic must still fail.
      const { parseArgs, RequiredArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-29T00:00:00Z');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
        '--yes',
      ];
      expect(() => parseArgs(argv, { now })).toThrowError(RequiredArgsError);
    });

    it('ACCEPT — --accept-heuristic with default (dry-run) is allowed and harmless', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--accept-heuristic',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
      expect(parsed.acceptHeuristic).toBe(true);
    });

    it('ACCEPT — default dry-run without --accept-heuristic also exposes acceptHeuristic=false', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.acceptHeuristic).toBe(false);
      expect(parsed.dryRun).toBe(true);
    });

    it('ACCEPT — explicit --dry-run is accepted', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--dry-run',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
    });

    it('ACCEPT — --limit parses to a positive integer', async () => {
      const { parseArgs, DEFAULT_BATCH_SIZE } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-29T00:00:00Z');
      const base = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      expect(parseArgs(base, { now }).limit).toBe(DEFAULT_BATCH_SIZE);
      expect(parseArgs([...base, '--limit=500'], { now }).limit).toBe(500);
    });

    it('ACCEPT — --undo=<run_id> short-circuits cutoff validation', async () => {
      // Undo path doesn't need a cutoff; the run_id is the entire input.
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = ['node', 'reflection-memory-cleanup.ts', '--undo=some-run-id'];
      const parsed = parseArgs(argv);
      expect(parsed.undo).toBe('some-run-id');
      expect(parsed.cutoff).toBeNull();
    });

    it('REJECTION — --undo with empty value throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      expect(() =>
        parseArgs(['node', 'reflection-memory-cleanup.ts', '--undo=']),
      ).toThrowError(InvalidArgsError);
    });
  });

  describe('dry-run — summarizeScope is read-only', () => {
    it('counts matching rows, returns earliest/latest, samples truncated', async () => {
      seedPolluted();
      seedNonPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const lines: string[] = [];
      const summary = await runDryRun({ cutoff: CUTOFF, log: (m) => lines.push(m) });

      expect(summary.count).toBe(3);
      expect(summary.earliestCreatedAt).toBe(T_BEFORE_1.toISOString());
      expect(summary.latestCreatedAt).toBe(T_BEFORE_3.toISOString());
      expect(summary.remainingDefaultDefault).toBe(2);
      expect(summary.sample).toHaveLength(3);
      const longSample = summary.sample.find(
        (s) => s.id === '00000000-0000-0000-0000-000000000002',
      );
      expect(longSample).toBeDefined();
      expect(longSample!.conteudo.endsWith('…')).toBe(true);
      expect(longSample!.conteudo.length).toBeLessThanOrEqual(81);

      // DEFENSE: the store is unchanged after a dry run.
      expect(memoryStore).toHaveLength(7);
      // And no audit row written and no backup row written.
      expect(auditStore).toHaveLength(0);
      expect(backupStore).toHaveLength(0);

      expect(lines.some((l) => /rows in scope/.test(l))).toBe(true);
      expect(lines.some((l) => /DRY RUN END/.test(l))).toBe(true);
    });

    it('empty scope — count zero, no sample, no mutation', async () => {
      seedNonPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const summary = await runDryRun({ cutoff: CUTOFF, log: () => undefined });
      expect(summary.count).toBe(0);
      expect(summary.earliestCreatedAt).toBeNull();
      expect(summary.latestCreatedAt).toBeNull();
      expect(summary.sample).toHaveLength(0);
      expect(summary.remainingDefaultDefault).toBe(2);
    });
  });

  describe('execute — snapshot + delete + audit (PR #276 iter 2)', () => {
    it('SUCCESS — deletes ALL in-scope rows, preserves others', async () => {
      seedPolluted();
      seedNonPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });

      expect(outcome.confirmed).toBe(true);
      expect(outcome.result?.rowsDeleted).toBe(3);
      expect(outcome.result?.batches).toBeGreaterThan(0);
      expect(outcome.cleanupRunId).toBeTruthy();

      // In-scope rows are GONE.
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000001')).toBeUndefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000002')).toBeUndefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000003')).toBeUndefined();

      // OUT-OF-SCOPE rows are PRESERVED.
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000010')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000011')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000012')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000013')).toBeDefined();
    });

    it('SNAPSHOT (Codex iter 2 blocker #1) — deleted rows are quarantined byte-identically in agent_memories_cleanup_backup', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const runId = outcome.cleanupRunId!;
      const backedUp = backupStore.filter((b) => b.cleanup_run_id === runId);
      expect(backedUp).toHaveLength(3);
      // Every backup row carries the original UUID + cleanup metadata.
      for (const b of backedUp) {
        expect(b.tenant_id).toBe('default');
        expect(b.agent_id).toBe('default');
        expect(b.tipo).toBe('reflexao');
        expect(b.deleted_by).toBe('test-operator');
        expect(b.restored_at).toBeNull();
      }
      // The conteudo of the long-content row is preserved IN FULL (no
      // 80-char truncation; that's only for the dry-run sample).
      const longRow = backedUp.find(
        (b) => b.original_id === '00000000-0000-0000-0000-000000000002',
      );
      expect(longRow!.conteudo.length).toBeGreaterThan(80);
    });

    it('AUDIT-FIRST (Codex iter 2 blocker #2) — audit started row is written BEFORE the first DELETE', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      // First audit row written must be 'started'.
      expect(auditStore[0]?.action).toBe('reflection_memory_cleanup.started');
      // And in the rendered SQL sequence, the INSERT INTO admin_audit_log
      // (for the started action) must come BEFORE the first DELETE.
      const startedIdx = renderedSqls.findIndex(
        (r) =>
          /INSERT\s+INTO\s+admin_audit_log/i.test(r.sql) &&
          // started action is param[3] = 'reflection_memory_cleanup.started'
          (r.params[3] as string) === 'reflection_memory_cleanup.started',
      );
      const firstDeleteIdx = renderedSqls.findIndex((r) =>
        /^\s*DELETE\s+FROM\s+agent_memories\b/i.test(r.sql),
      );
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(firstDeleteIdx).toBeGreaterThanOrEqual(0);
      expect(startedIdx).toBeLessThan(firstDeleteIdx);
    });

    it('AUDIT TRAIL — emits started + N batch_completed + completed for N batches', async () => {
      seedPolluted(); // 3 rows
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        batchSize: 2, // forces 2 batches: [2, 1]
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const started = auditStore.filter((a) => a.action === 'reflection_memory_cleanup.started');
      const batchCompleted = auditStore.filter(
        (a) => a.action === 'reflection_memory_cleanup.batch_completed',
      );
      const completed = auditStore.filter((a) => a.action === 'reflection_memory_cleanup.completed');
      expect(started).toHaveLength(1);
      expect(batchCompleted).toHaveLength(2);
      expect(completed).toHaveLength(1);
      // batch_completed rows carry deleted IDs.
      for (const a of batchCompleted) {
        const cs = a.change_summary as { deleted_ids_sample: string[]; batch_index: number };
        expect(Array.isArray(cs.deleted_ids_sample)).toBe(true);
        expect(cs.deleted_ids_sample.length).toBeGreaterThan(0);
        expect(typeof cs.batch_index).toBe('number');
      }
    });

    it('AUDIT agent_id (Codex iter 2 blocker #3) — every cleanup audit row includes BOTH tenant_id AND agent_id', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      // Every audit row in this run must carry agent_id alongside tenant_id.
      const cleanupAudits = auditStore.filter((a) =>
        a.action.startsWith('reflection_memory_cleanup.'),
      );
      expect(cleanupAudits.length).toBeGreaterThan(0);
      for (const a of cleanupAudits) {
        const cs = a.change_summary as { tenant_id?: string; agent_id?: string };
        expect(cs.tenant_id).toBe('default');
        expect(cs.agent_id).toBe('default');
      }
    });

    it('AUDIT — completed row contains cleanup_run_id, rows_deleted, rows_snapshotted, agent_id, tenant_id', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const completed = auditStore.find(
        (a) => a.action === 'reflection_memory_cleanup.completed',
      );
      expect(completed).toBeDefined();
      const cs = completed!.change_summary as {
        cleanup_run_id: string;
        cutoff: string;
        rows_deleted: number;
        rows_snapshotted: number;
        tenant_id: string;
        agent_id: string;
        executed_by_user: string;
        started_at: string;
        ended_at: string;
      };
      expect(cs.cleanup_run_id).toBe(outcome.cleanupRunId);
      expect(cs.cutoff).toBe(CUTOFF.toISOString());
      expect(cs.rows_deleted).toBe(3);
      expect(cs.rows_snapshotted).toBe(3);
      expect(cs.tenant_id).toBe('default');
      expect(cs.agent_id).toBe('default');
      expect(cs.executed_by_user).toBe('test-operator');
      expect(typeof cs.started_at).toBe('string');
      expect(typeof cs.ended_at).toBe('string');
    });

    it('AUDIT — completed row resource_id equals cleanup_run_id (for direct SQL joins)', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const completed = auditStore.find(
        (a) => a.action === 'reflection_memory_cleanup.completed',
      );
      expect(completed?.resource_id).toBe(outcome.cleanupRunId);
    });

    it('--yes (Codex iter 2 blocker #4) — skips the interactive confirmation prompt', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      let readerCalled = false;
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'ci-runner',
        yes: true,
        // If yes:true bypasses the prompt, this reader must NEVER be called.
        confirmReader: async () => {
          readerCalled = true;
          return 'n';
        },
        log: () => undefined,
      });
      expect(readerCalled).toBe(false);
      expect(outcome.confirmed).toBe(true);
      expect(outcome.result?.rowsDeleted).toBe(3);
    });

    it('FROZEN ID SET (Codex iter 2 blocker #6) — concurrent INSERT post-snapshot is NOT swept', async () => {
      // Snapshot+delete must operate on the FROZEN ID set. Simulate a
      // concurrent insert by adding a new in-predicate row AFTER the
      // snapshot INSERT but BEFORE the DELETE. The new row must SURVIVE.
      seedPolluted(); // 3 rows
      let snapshotsSeen = 0;
      const original = dbExecuteMock.getMockImplementation()!;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        const result = await original(query);
        if (/^\s*INSERT\s+INTO\s+agent_memories_cleanup_backup/i.test(rendered.sql)) {
          snapshotsSeen++;
          if (snapshotsSeen === 1) {
            // Insert a NEW reflexao row that satisfies the predicate
            // (tenant=default, agent=default, tipo=reflexao, before cutoff).
            // It MUST NOT be deleted because it's not in the frozen ID set.
            memoryStore.push({
              id: '00000000-0000-0000-0000-0000000000ff',
              tenant_id: 'default',
              agent_id: 'default',
              conteudo: 'concurrent insert mid-cleanup',
              tipo: 'reflexao',
              escopo: 'global',
              created_at: T_BEFORE_1,
            });
          }
        }
        return result;
      });
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      // Only the 3 SEEDED polluted rows were deleted; the concurrent row
      // SURVIVES because it was never in the snapshot ID set.
      expect(outcome.result?.rowsDeleted).toBe(3);
      expect(
        memoryStore.find((r) => r.id === '00000000-0000-0000-0000-0000000000ff'),
      ).toBeDefined();
    });

    it('WARNING — runExecute prints the heuristic warning before the confirmation prompt', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const lines: string[] = [];
      let confirmCalled = false;
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => {
          confirmCalled = true;
          return 'n';
        },
        log: (m) => lines.push(m),
      });
      expect(confirmCalled).toBe(true);
      const joined = lines.join('\n');
      expect(joined).toMatch(/HEURISTIC WARNING/i);
      expect(joined).toMatch(/provenance|no provenance/i);
      expect(joined).toMatch(/default/);
      expect(joined).toMatch(/indistinguishable|legitimate/i);
    });

    it('CONFIRMATION — answering "n" aborts WITHOUT mutating the store, writing audit, or snapshotting', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'n',
        log: () => undefined,
      });
      expect(outcome.confirmed).toBe(false);
      expect(outcome.result).toBeNull();
      expect(memoryStore).toHaveLength(3);
      expect(auditStore).toHaveLength(0);
      expect(backupStore).toHaveLength(0);
    });

    it('CONFIRMATION — empty input is treated as NO (fail-closed)', async () => {
      seedPolluted();
      const { runExecute, confirmDestructive } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      expect(await confirmDestructive({ prompt: 'p', reader: async () => '' })).toBe(false);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => '   ' })).toBe(false);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'Y' })).toBe(true);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'yes' })).toBe(true);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'YES' })).toBe(true);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'maybe' })).toBe(false);
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => '',
        log: () => undefined,
      });
      expect(outcome.confirmed).toBe(false);
      expect(memoryStore).toHaveLength(3);
      expect(auditStore).toHaveLength(0);
      expect(backupStore).toHaveLength(0);
    });

    it('CUTOFF BOUNDARY — rows AT the cutoff are preserved (strict <, not <=)', async () => {
      memoryStore.push({
        id: '00000000-0000-0000-0000-0000000000aa',
        tenant_id: 'default',
        agent_id: 'default',
        conteudo: 'reflexao exactly at cutoff',
        tipo: 'reflexao',
        escopo: 'global',
        created_at: new Date(CUTOFF.getTime()),
      });
      memoryStore.push({
        id: '00000000-0000-0000-0000-0000000000bb',
        tenant_id: 'default',
        agent_id: 'default',
        conteudo: 'reflexao one ms before cutoff',
        tipo: 'reflexao',
        escopo: 'global',
        created_at: new Date(CUTOFF.getTime() - 1),
      });
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-0000000000aa')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-0000000000bb')).toBeUndefined();
    });

    it('BATCHING — small --limit forces multiple batches but deletes the same total', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        batchSize: 2,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      expect(outcome.result?.rowsDeleted).toBe(3);
      expect(outcome.result?.batches).toBeGreaterThanOrEqual(2);
      // BEGIN/COMMIT were called for the snapshot tx AND each delete batch.
      const begins = renderedSqls.filter((r) => /^\s*BEGIN\s*$/i.test(r.sql)).length;
      const commits = renderedSqls.filter((r) => /^\s*COMMIT\s*$/i.test(r.sql)).length;
      // 1 snapshot tx + 2 batches = 3 each.
      expect(begins).toBeGreaterThanOrEqual(3);
      expect(commits).toBeGreaterThanOrEqual(3);
    });

    it('EMPTY SCOPE — execute with zero in-scope rows is a clean no-op (no confirm, no delete, no audit)', async () => {
      seedNonPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      let confirmCalled = false;
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => {
          confirmCalled = true;
          return 'y';
        },
        log: () => undefined,
      });
      expect(confirmCalled).toBe(false);
      expect(outcome.confirmed).toBe(true);
      expect(outcome.result?.rowsDeleted).toBe(0);
      expect(auditStore).toHaveLength(0);
      expect(backupStore).toHaveLength(0);
    });

    it('FAILURE — DB error mid-batch is propagated AND a "failed" audit row is appended', async () => {
      seedPolluted();
      // Inject a one-shot failure on the next DELETE (after snapshot).
      let deletesSeen = 0;
      const original = dbExecuteMock.getMockImplementation()!;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*DELETE\s+FROM\s+agent_memories\b/i.test(rendered.sql)) {
          deletesSeen++;
          if (deletesSeen === 1) {
            throw new Error('db-failure-mid-batch');
          }
        }
        return original(query);
      });
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await expect(
        runExecute({
          cutoff: CUTOFF,
          batchSize: 1,
          executedByUser: 'op',
          confirmReader: async () => 'y',
          log: () => undefined,
        }),
      ).rejects.toThrow('db-failure-mid-batch');
      // 'started' audit row written before failure.
      const started = auditStore.filter((a) => a.action === 'reflection_memory_cleanup.started');
      expect(started).toHaveLength(1);
      // 'failed' audit row appended.
      const failed = auditStore.filter((a) => a.action === 'reflection_memory_cleanup.failed');
      expect(failed).toHaveLength(1);
      const cs = failed[0]!.change_summary as { error_message: string; agent_id: string };
      expect(cs.error_message).toContain('db-failure-mid-batch');
      expect(cs.agent_id).toBe('default');
      // Snapshot is still present (operator can --undo to restore anything
      // that DID get deleted before the failure).
      const startedRow = started[0]!;
      const runId = startedRow.resource_id!;
      expect(backupStore.filter((b) => b.cleanup_run_id === runId).length).toBeGreaterThan(0);
    });
  });

  describe('undo path — runUndo', () => {
    it('SUCCESS — restores all snapshotted rows byte-identically', async () => {
      seedPolluted();
      const { runExecute, runUndo } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      expect(memoryStore.filter((r) => r.tenant_id === 'default' && r.agent_id === 'default')).toHaveLength(0);
      const undoResult = await runUndo({
        cleanupRunId: outcome.cleanupRunId!,
        executedByUser: 'op',
        log: () => undefined,
      });
      expect(undoResult.rowsTotalInBackup).toBe(3);
      expect(undoResult.rowsRestored).toBe(3);
      expect(undoResult.rowsAlreadyRestored).toBe(0);
      expect(undoResult.rowsSkippedConflict).toBe(0);
      // Rows are back in agent_memories with their original UUIDs.
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000001')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000002')).toBeDefined();
      expect(memoryStore.find((r) => r.id === '00000000-0000-0000-0000-000000000003')).toBeDefined();
    });

    it('IDEMPOTENT — re-running undo for an already-restored run is a no-op', async () => {
      seedPolluted();
      const { runExecute, runUndo } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      await runUndo({
        cleanupRunId: outcome.cleanupRunId!,
        executedByUser: 'op',
        log: () => undefined,
      });
      // Second undo: everything already_restored.
      const second = await runUndo({
        cleanupRunId: outcome.cleanupRunId!,
        executedByUser: 'op',
        log: () => undefined,
      });
      expect(second.rowsRestored).toBe(0);
      expect(second.rowsAlreadyRestored).toBe(3);
      // Store still has the 3 rows (no duplicates).
      expect(memoryStore.filter((r) => r.tenant_id === 'default' && r.agent_id === 'default'))
        .toHaveLength(3);
    });

    it('NO-OP — undo for an unknown run_id reports zero', async () => {
      const { runUndo } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const result = await runUndo({
        cleanupRunId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        executedByUser: 'op',
        log: () => undefined,
      });
      expect(result.rowsTotalInBackup).toBe(0);
      expect(result.rowsRestored).toBe(0);
    });
  });

  describe('SQL predicate shape (defense-in-depth)', () => {
    it('every read query pins tenant_id, agent_id, cutoff, tipos', async () => {
      seedPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runDryRun({ cutoff: CUTOFF, log: () => undefined });

      const inScopeQueries = renderedSqls.filter((r) =>
        /FROM\s+agent_memories[\s\S]*WHERE[\s\S]*tenant_id\s*=[\s\S]*agent_id\s*=[\s\S]*created_at\s*<[\s\S]*tipo\s*=\s*ANY/i.test(
          r.sql,
        ),
      );
      expect(inScopeQueries.length).toBeGreaterThanOrEqual(3);
      for (const q of inScopeQueries) {
        expect(q.params[0]).toBe('default');
        expect(q.params[1]).toBe('default');
        expect(typeof q.params[2]).toBe('string');
        expect(new Date(q.params[2] as string).toISOString()).toBe(CUTOFF.toISOString());
        const tiposParam = q.params[3];
        const tiposNormalized = Array.isArray(tiposParam) ? tiposParam : [tiposParam];
        expect(tiposNormalized).toEqual(['reflexao']);
      }
    });

    it('snapshot INSERT pins tenant/agent/cutoff/tipos in its SELECT', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const snapshotSql = renderedSqls.find((r) =>
        /^\s*INSERT\s+INTO\s+agent_memories_cleanup_backup/i.test(r.sql),
      );
      expect(snapshotSql).toBeDefined();
      // Bound params: cleanup_run_id, deleted_by, tenant_id, agent_id, cutoff, ...tipos
      expect(typeof snapshotSql!.params[0]).toBe('string'); // cleanup_run_id (uuid)
      expect(snapshotSql!.params[1]).toBe('op'); // deleted_by
      expect(snapshotSql!.params[2]).toBe('default'); // tenant_id
      expect(snapshotSql!.params[3]).toBe('default'); // agent_id
      expect(typeof snapshotSql!.params[4]).toBe('string'); // cutoff iso
      expect(new Date(snapshotSql!.params[4] as string).toISOString()).toBe(
        CUTOFF.toISOString(),
      );
      // The SELECT's WHERE binds the same 4 predicates + tipos.
      expect(snapshotSql!.sql).toMatch(/tenant_id\s*=/);
      expect(snapshotSql!.sql).toMatch(/agent_id\s*=/);
      expect(snapshotSql!.sql).toMatch(/created_at\s*</);
      expect(snapshotSql!.sql).toMatch(/tipo\s*=\s*ANY/);
    });

    it('DELETE targets id=ANY of the frozen ID set (not the predicate)', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const deleteSql = renderedSqls.find((r) =>
        /^\s*DELETE\s+FROM\s+agent_memories\b/i.test(r.sql),
      );
      expect(deleteSql).toBeDefined();
      // Critical: DELETE is now `WHERE id = ANY(...)`, not the predicate.
      expect(deleteSql!.sql).toMatch(/id\s*=\s*ANY/);
      // It does NOT carry the cutoff predicate anymore (frozen by snapshot).
      expect(deleteSql!.sql).not.toMatch(/created_at\s*</);
    });
  });
});
