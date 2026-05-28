/**
 * Issue #240 — Cross-tenant (cross-empresa) isolation invariant for the
 * nightly `reflection_batch` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #240 fix):
 *
 *   1. `runReflectionBatch` is a DISPATCHER that enumerates `(tenant_id,
 *      agent_id)` tuples DISTINCT in `audit_log` (within the 24h window) and
 *      runs the actual reflection work INSIDE
 *      `runWithTenantContext({tenant_id, agent_id}, ...)` per tuple.
 *
 *   2. The hardcoded `default/default` shim is GONE. There is no fallback
 *      bucket — when no tenants have correction events the worker logs idle
 *      and exits without opening any context.
 *
 *   3. Every read of `audit_log` INSIDE a tenant context filters by
 *      `tenant_id` AND `agent_id` (defense-in-depth — even a future dispatcher
 *      bug cannot cause foreign-tenant rows to enter the LLM proposal stage).
 *
 *   4. `writeMemory` (POST #229/#237) is called UNDER the routed tenant
 *      context, so the resulting `agent_memories` row carries the real
 *      `(tenant_id, agent_id)` of the cluster that generated it — NEVER
 *      `default/default`.
 *
 *   5. `rulesRepo.create` is called UNDER the routed tenant context, so the
 *      newly-created `learned_rules` row carries the real `(tenant_id,
 *      agent_id)` via `applyTenantGuard`.
 *
 *   6. ADVERSARIAL SEED ORDER — tenant-B events inserted FIRST. The worker
 *      MUST still route each tenant's events to its own context. Insertion
 *      order does not bleed across tenant boundaries.
 *
 *   7. Empty per-tenant inner reads (the dispatcher enumerated the tuple but
 *      by the time the inner read fires the rows are gone) are a clean no-op
 *      — no spurious writes, no context switch leak.
 *
 * Strategy:
 *   We mock `db.execute` to intercept the worker's raw SQL. The worker uses
 *   exactly two query shapes:
 *
 *     (A) `SELECT DISTINCT tenant_id, agent_id FROM audit_log WHERE acao = 'transaction_corrected' AND created_at >= ...`
 *         — the dispatcher enumeration, NO tenant predicate (it discovers them).
 *
 *     (B) `SELECT acao, alvo_id, metadata, pessoa_id FROM audit_log WHERE acao = 'transaction_corrected' AND created_at >= ... AND tenant_id = $X AND agent_id = $Y ORDER BY created_at DESC LIMIT 1000`
 *         — the per-tenant inner read, WITH tenant predicate.
 *
 *   We dispatch on the rendered SQL text, project the seeded in-memory
 *   `audit_log` rows accordingly, and capture every `writeMemory` /
 *   `rulesRepo.create` / `audit()` invocation along with the active tenant
 *   context at call time so we can prove the routed values were used.
 *
 *   The LLM is stubbed to return a fixed applicable proposal so every cluster
 *   in every tenant yields one rule + one memory write (the assertion lever).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  runWithTenantContext,
  tryGetCurrentContext,
} from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// In-memory audit_log + db.execute fake
// ---------------------------------------------------------------------------
type AuditRow = {
  tenant_id: string;
  agent_id: string;
  acao: string;
  alvo_id: string | null;
  metadata: Record<string, unknown>;
  pessoa_id: string | null;
  created_at: Date;
};

const auditStore: AuditRow[] = [];
const renderedSqls: string[] = [];
const _dialect = new PgDialect();

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push(sqlText);

  // (A) Dispatcher enumeration — DISTINCT (tenant_id, agent_id).
  if (/SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(sqlText)) {
    // The window predicate `created_at >= now() - interval '24 hours'` is
    // rendered as raw SQL by drizzle (sql.raw), not a bound param. In the
    // fake we just project every audit row — every seeded row is "fresh"
    // by construction (we never seed historical rows in this suite).
    const seen = new Set<string>();
    const pairs: Array<{ tenant_id: string; agent_id: string }> = [];
    for (const r of auditStore) {
      if (r.acao !== 'transaction_corrected') continue;
      const key = `${r.tenant_id}|${r.agent_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ tenant_id: r.tenant_id, agent_id: r.agent_id });
    }
    return { rows: pairs };
  }

  // (B) Per-tenant inner read — filters by acao + tenant_id + agent_id.
  if (/SELECT\s+acao,\s*alvo_id,\s*metadata,\s*pessoa_id\s+FROM/i.test(sqlText)) {
    // Param order from the production SQL: $1=tenant_id, $2=agent_id.
    // (The `since` is a raw sql template, not a bound param.)
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const filtered = auditStore.filter(
      (r) =>
        r.acao === 'transaction_corrected' &&
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id,
    );
    return {
      rows: filtered.map((r) => ({
        acao: r.acao,
        alvo_id: r.alvo_id,
        metadata: r.metadata,
        pessoa_id: r.pessoa_id,
      })),
    };
  }

  return { rows: [] };
});

// ---------------------------------------------------------------------------
// Pool / Postgres client fake — REQUEST_CHANGES MEDIUM #2 (concurrent worker
// guard). The worker now acquires `pg_try_advisory_lock(hashtextextended(...))`
// on a dedicated client per tenant before processing. The fake tracks per-key
// lock state so tests can assert acquire/skip behavior.
// ---------------------------------------------------------------------------
type AdvisoryLockKey = string; // composite of tenant|agent for assertion clarity

/** Currently held advisory locks (keyed by the COMPOSITE input, not the hash). */
const heldLocks = new Set<AdvisoryLockKey>();
/** History of (action, key) pairs in chronological order for assertions. */
const lockHistory: Array<{ action: 'try' | 'unlock'; key: AdvisoryLockKey; locked: boolean }> = [];

const poolConnectMock = vi.fn(async () => {
  let clientReleased = false;
  const client = {
    query: vi.fn(
      async (
        text: string,
        params: unknown[],
      ): Promise<{ rows: Array<{ locked?: boolean }> }> => {
        if (/pg_try_advisory_lock/i.test(text)) {
          // params[0] = composite key string, params[1] = namespace seed (text).
          const key = params[0] as string;
          if (heldLocks.has(key)) {
            lockHistory.push({ action: 'try', key, locked: false });
            return { rows: [{ locked: false }] };
          }
          heldLocks.add(key);
          lockHistory.push({ action: 'try', key, locked: true });
          return { rows: [{ locked: true }] };
        }
        if (/pg_advisory_unlock/i.test(text)) {
          const key = params[0] as string;
          const wasHeld = heldLocks.delete(key);
          lockHistory.push({ action: 'unlock', key, locked: wasHeld });
          return { rows: [{ locked: wasHeld }] };
        }
        return { rows: [] };
      },
    ),
    release: vi.fn(() => {
      clientReleased = true;
    }),
    get released(): boolean {
      return clientReleased;
    },
  };
  return client;
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
  pool: { connect: poolConnectMock },
}));

// ---------------------------------------------------------------------------
// Capture every writeMemory + rulesRepo.create + audit() call WITH the active
// tenant context. These are the assertion levers.
// ---------------------------------------------------------------------------

type WriteMemoryCall = {
  conteudo: string;
  tipo: string;
  escopo: string;
  metadata?: Record<string, unknown>;
  tenant_id: string;
  agent_id: string;
};
type RulesRepoCreateCall = {
  tipo: string;
  contexto: string;
  acao: string;
  tenant_id: string;
  agent_id: string;
};
type AuditCall = {
  acao: string;
  alvo_id?: string | null;
  metadata?: Record<string, unknown>;
  tenant_id: string;
  agent_id: string;
};

const writeMemoryCalls: WriteMemoryCall[] = [];
const rulesRepoCreateCalls: RulesRepoCreateCall[] = [];
const auditCalls: AuditCall[] = [];
let nextRuleSeq = 1;

vi.mock('@/memory/vector.js', () => ({
  writeMemory: vi.fn(async (input: {
    conteudo: string;
    tipo: string;
    escopo: string;
    metadata?: Record<string, unknown>;
  }) => {
    // Capture the ACTIVE tenant context — production resolves tenant_id /
    // agent_id from `getCurrentTenant()`/`getCurrentAgent()` before writing
    // to `agent_memories`. We mirror that here to PROVE the worker opened
    // the right context before calling writeMemory.
    const ctx = tryGetCurrentContext();
    if (!ctx) {
      throw new Error(
        'writeMemory called outside tenant context — would throw MissingTenantContextError in prod',
      );
    }
    writeMemoryCalls.push({
      conteudo: input.conteudo,
      tipo: input.tipo,
      escopo: input.escopo,
      metadata: input.metadata,
      tenant_id: ctx.tenant_id,
      agent_id: ctx.agent_id,
    });
    return { id: `mem_${writeMemoryCalls.length.toString().padStart(6, '0')}` };
  }),
}));

vi.mock('@/db/repositories.js', () => ({
  rulesRepo: {
    findByContext: vi.fn(async (_tipo: string, _contexto: string) => null),
    create: vi.fn(async (input: { tipo: string; contexto: string; acao: string }) => {
      // Same capture pattern as writeMemory: tenant context proves the
      // worker routed correctly before mutating learned_rules.
      const ctx = tryGetCurrentContext();
      if (!ctx) {
        throw new Error(
          'rulesRepo.create called outside tenant context — prod applyTenantGuard would throw',
        );
      }
      rulesRepoCreateCalls.push({
        tipo: input.tipo,
        contexto: input.contexto,
        acao: input.acao,
        tenant_id: ctx.tenant_id,
        agent_id: ctx.agent_id,
      });
      const id = `00000000-0000-0000-0000-${String(nextRuleSeq++).padStart(12, '0')}`;
      return { id, ...input } as { id: string };
    }),
  },
}));

vi.mock('@/governance/audit.js', () => ({
  audit: vi.fn(async (input: {
    acao: string;
    alvo_id?: string | null;
    metadata?: Record<string, unknown>;
  }) => {
    // Capture the ACTIVE tenant context too — the audit() row inherits
    // (tenant_id, agent_id) via tryGetCurrentContext + applyTenantGuard.
    const ctx = tryGetCurrentContext();
    auditCalls.push({
      acao: input.acao,
      alvo_id: input.alvo_id,
      metadata: input.metadata,
      // If there's no context we record 'system' to match the production
      // fallback wrap — the test then asserts tenant_id !== 'system' for
      // routed reflections.
      tenant_id: ctx?.tenant_id ?? 'system',
      agent_id: ctx?.agent_id ?? 'system',
    });
  }),
}));

// ---------------------------------------------------------------------------
// Cognitive module + LLM — deterministic applicable proposal.
// Every cluster yields a single rule (so tenant-A's clusters produce
// tenant-A rules+memories, tenant-B's clusters produce tenant-B's).
// ---------------------------------------------------------------------------
vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(
    async <T>(_opts: unknown, fn: () => Promise<T>): Promise<{ status: 'ok'; output: T }> => ({
      status: 'ok',
      output: await fn(),
    }),
  ),
}));

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async () => ({
    content: JSON.stringify({
      applicable: true,
      tipo: 'classificacao',
      contexto: 'auto-test',
      acao: 'tag:auto',
      contexto_jsonb: {},
      acoes_jsonb: {},
      justificativa: 'unit-test deterministic proposal',
    }),
  })),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const A_CTX = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B_CTX = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

function seedCorrection(
  ctx: { tenant_id: string; agent_id: string },
  descricao: string,
  alvo_id: string = `00000000-0000-0000-0000-${Math.floor(Math.random() * 1e12)
    .toString()
    .padStart(12, '0')}`,
): void {
  auditStore.push({
    tenant_id: ctx.tenant_id,
    agent_id: ctx.agent_id,
    acao: 'transaction_corrected',
    alvo_id,
    metadata: { descricao },
    pessoa_id: null,
    created_at: new Date(),
  });
}

beforeEach(() => {
  auditStore.length = 0;
  renderedSqls.length = 0;
  writeMemoryCalls.length = 0;
  rulesRepoCreateCalls.length = 0;
  auditCalls.length = 0;
  nextRuleSeq = 1;
  heldLocks.clear();
  lockHistory.length = 0;
  dbExecuteMock.mockClear();
  poolConnectMock.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Issue #240 — runReflectionBatch is per-tenant scoped (no default/default leak)', () => {
  it('SUCCESS — tenant-A correction events route ALL writes (writeMemory + rulesRepo.create + audit) to tenant-A', async () => {
    seedCorrection(A_CTX, 'compra mercado pequeno almoço');
    seedCorrection(A_CTX, 'compra mercado pequeno almoço'); // same cluster — n=2

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // Dispatcher discovered tenant-A
    expect(rulesRepoCreateCalls).toHaveLength(1);
    expect(rulesRepoCreateCalls[0]!.tenant_id).toBe('tenant-A');
    expect(rulesRepoCreateCalls[0]!.agent_id).toBe('agent-A');

    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-A');
    expect(writeMemoryCalls[0]!.agent_id).toBe('agent-A');
    expect(writeMemoryCalls[0]!.tipo).toBe('reflexao');

    // audit(rule_learned) also under tenant-A
    expect(auditCalls.filter((c) => c.acao === 'rule_learned')).toHaveLength(1);
    expect(auditCalls[0]!.tenant_id).toBe('tenant-A');
    expect(auditCalls[0]!.agent_id).toBe('agent-A');
  });

  it('SYMMETRY — tenant-B correction events route ALL writes to tenant-B', async () => {
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    expect(rulesRepoCreateCalls).toHaveLength(1);
    expect(rulesRepoCreateCalls[0]!.tenant_id).toBe('tenant-B');
    expect(rulesRepoCreateCalls[0]!.agent_id).toBe('agent-B');

    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-B');
    expect(writeMemoryCalls[0]!.agent_id).toBe('agent-B');
  });

  it('MULTI-TENANT — both tenants processed; each tenant\'s writes scoped to its own (tenant_id, agent_id)', async () => {
    // tenant-A cluster
    seedCorrection(A_CTX, 'compra mercado pequeno almoço');
    seedCorrection(A_CTX, 'compra mercado pequeno almoço');
    // tenant-B cluster (different descricao → different cluster bucket too)
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // Both tenants produced exactly one rule each.
    expect(rulesRepoCreateCalls).toHaveLength(2);
    const tenants = rulesRepoCreateCalls.map((c) => c.tenant_id).sort();
    expect(tenants).toEqual(['tenant-A', 'tenant-B']);

    // Both tenants produced exactly one memory each.
    expect(writeMemoryCalls).toHaveLength(2);
    const memTenants = writeMemoryCalls.map((c) => c.tenant_id).sort();
    expect(memTenants).toEqual(['tenant-A', 'tenant-B']);

    // CRITICAL — no write landed under 'default'
    for (const call of [...writeMemoryCalls, ...rulesRepoCreateCalls]) {
      expect(call.tenant_id).not.toBe('default');
      expect(call.agent_id).not.toBe('default');
    }

    // Pairs are internally consistent — tenant-A rule + tenant-A memory etc.
    // (not a tenant-A rule paired with a tenant-B memory in the same loop iter).
    const aCreate = rulesRepoCreateCalls.find((c) => c.tenant_id === 'tenant-A')!;
    const aMem = writeMemoryCalls.find((c) => c.tenant_id === 'tenant-A')!;
    expect(aCreate.agent_id).toBe(aMem.agent_id);
  });

  it('ADVERSARIAL SEED ORDER — tenant-B rows seeded FIRST; routing is by data, not by store order', async () => {
    // Insert tenant-B events FIRST. A naive single-context loop that took the
    // first row's tenant_id as "the" context would put tenant-A's later
    // events under tenant-B. The per-tenant DISTINCT dispatcher must not
    // depend on insertion order.
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');
    seedCorrection(B_CTX, 'frete entrega rapida sao paulo');
    seedCorrection(A_CTX, 'compra mercado pequeno almoço');
    seedCorrection(A_CTX, 'compra mercado pequeno almoço');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    expect(rulesRepoCreateCalls).toHaveLength(2);
    expect(writeMemoryCalls).toHaveLength(2);

    // Per-tenant pairing still holds despite reverse seed order.
    const aCount = rulesRepoCreateCalls.filter((c) => c.tenant_id === 'tenant-A').length;
    const bCount = rulesRepoCreateCalls.filter((c) => c.tenant_id === 'tenant-B').length;
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    const aMemCount = writeMemoryCalls.filter((c) => c.tenant_id === 'tenant-A').length;
    const bMemCount = writeMemoryCalls.filter((c) => c.tenant_id === 'tenant-B').length;
    expect(aMemCount).toBe(1);
    expect(bMemCount).toBe(1);

    // No 'default' bucket leak under adversarial ordering.
    for (const c of writeMemoryCalls) {
      expect(c.tenant_id).not.toBe('default');
    }
  });

  it('CROSS-TENANT CONTAINMENT — descricao that appears in BOTH tenants creates SEPARATE rules per tenant (no shared "default" bucket)', async () => {
    // Same normalized descricao across both tenants. If routing were broken
    // they'd land in the same `agent_memories` bucket. With the fix in place
    // each lands under its own tenant_id+agent_id — two distinct rules.
    seedCorrection(A_CTX, 'descricao identica entre tenants');
    seedCorrection(A_CTX, 'descricao identica entre tenants');
    seedCorrection(B_CTX, 'descricao identica entre tenants');
    seedCorrection(B_CTX, 'descricao identica entre tenants');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    expect(rulesRepoCreateCalls).toHaveLength(2);
    expect(writeMemoryCalls).toHaveLength(2);

    // Distinct tenant attribution despite identical descricao.
    const memByTenant = new Set(writeMemoryCalls.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(memByTenant).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('EMPTY audit_log — no DISTINCT pairs → worker is a no-op; no tenant context opened, no writes', async () => {
    // No seeded events. Dispatcher returns an empty pair set.
    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    expect(rulesRepoCreateCalls).toHaveLength(0);
    expect(writeMemoryCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);

    // Defensive: the SELECT acao,alvo_id,... per-tenant read was NEVER fired
    // because we never entered a tenant context. (The dispatcher SELECT
    // DISTINCT DID fire — that's expected.)
    const perTenantReads = renderedSqls.filter((s) =>
      /SELECT\s+acao,\s*alvo_id,\s*metadata,\s*pessoa_id/i.test(s),
    );
    expect(perTenantReads).toHaveLength(0);
  });

  it('INNER READ — per-tenant SELECT filters by tenant_id AND agent_id (defense-in-depth)', async () => {
    // Two tenants with their own events. After running the worker we inspect
    // the inner SELECTs and assert they were each bound to the routed tenant
    // tuple — not a wildcard read.
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(B_CTX, 'B descricao');
    seedCorrection(B_CTX, 'B descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // Every per-tenant inner SELECT must include tenant_id AND agent_id in
    // its WHERE clause — that's the defense-in-depth predicate that protects
    // against future dispatcher bugs.
    const innerReads = renderedSqls.filter((s) =>
      /SELECT\s+acao,\s*alvo_id,\s*metadata,\s*pessoa_id/i.test(s),
    );
    expect(innerReads.length).toBeGreaterThan(0);
    for (const s of innerReads) {
      expect(s).toMatch(/tenant_id\s*=/);
      expect(s).toMatch(/agent_id\s*=/);
    }
  });

  it('NO default/default — the worker never opens a `default/default` tenant context (anti-regression)', async () => {
    // The bug was a hardcoded `runWithTenantContext({tenant_id:'default', agent_id:'default'}, ...)`
    // wrapping the entire inner. Now there is NO such wrap — only per-tenant
    // contexts derived from real audit_log rows. We prove this by seeding
    // ONLY real tenants and asserting no write lands under 'default'.
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(B_CTX, 'B descricao');
    seedCorrection(B_CTX, 'B descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    const allTenantsTouched = new Set([
      ...writeMemoryCalls.map((c) => c.tenant_id),
      ...rulesRepoCreateCalls.map((c) => c.tenant_id),
      ...auditCalls.filter((c) => c.acao === 'rule_learned').map((c) => c.tenant_id),
    ]);
    expect(allTenantsTouched.has('default')).toBe(false);
    expect(allTenantsTouched.has('system')).toBe(false);
    expect(allTenantsTouched).toEqual(new Set(['tenant-A', 'tenant-B']));
  });

  it('CONTEXT AT CALL-SITE — runWithTenantContext is open AT THE TIME writeMemory is invoked', async () => {
    // The writeMemory mock asserts presence of tenant context by checking
    // tryGetCurrentContext() — if production ever regressed to calling
    // writeMemory outside the routed wrap, the mock would throw. Run a
    // simple scenario to exercise that lever explicitly.
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await expect(runReflectionBatch()).resolves.toBeUndefined();
    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-A');
  });

  it('CROSS-AGENT — same tenant_id, different agent_id pairs are routed separately', async () => {
    // Two agents under the same tenant — each must get its own context. The
    // tenant-isolation invariant extends to (tenant_id, agent_id), not just
    // tenant_id (see vector-cross-tenant.spec.ts CROSS-AGENT subtest).
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-A' }, 'A1 descricao');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-A' }, 'A1 descricao');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-OTHER' }, 'A2 descricao');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-OTHER' }, 'A2 descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    expect(rulesRepoCreateCalls).toHaveLength(2);
    expect(writeMemoryCalls).toHaveLength(2);

    const pairs = new Set(writeMemoryCalls.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(pairs).toEqual(new Set(['tenant-A|agent-A', 'tenant-A|agent-OTHER']));
  });

  it('CALLED FROM OUTSIDE TENANT CONTEXT — dispatcher runs without an ambient tenant (it IS the dispatcher)', async () => {
    // The worker's outermost call MUST NOT require an active tenant context
    // — it's invoked from the cron registry, which has no context. We exercise
    // this by NOT wrapping in runWithTenantContext at the call site.
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    // No `runWithTenantContext` wrap here — production cron path.
    await expect(runReflectionBatch()).resolves.toBeUndefined();
    expect(rulesRepoCreateCalls).toHaveLength(1);
    expect(rulesRepoCreateCalls[0]!.tenant_id).toBe('tenant-A');
  });

  it('OUTSIDE-TENANT NO LEAK — when runWithTenantContext for tenant-A is active around the call, A is still routed correctly (not coupled to caller context)', async () => {
    // Defensive shape: even if some caller wraps runReflectionBatch in a
    // tenant context (e.g. an admin replays), the dispatcher should still
    // discover real tenants from audit_log and route accordingly. The
    // caller's ambient context must not become a sticky default.
    seedCorrection(B_CTX, 'B descricao');
    seedCorrection(B_CTX, 'B descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runWithTenantContext(A_CTX, runReflectionBatch);

    // B's events should produce a B-routed write — NOT inherit the ambient A.
    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-B');
    expect(writeMemoryCalls[0]!.agent_id).toBe('agent-B');
  });

  it('DISPATCHER QUERY filters tenant_id IS NOT NULL AND agent_id IS NOT NULL (Codex REQUEST_CHANGES MINOR)', async () => {
    // The MINOR ask from the #251 review: even though the schema enforces
    // NOT NULL, the dispatcher SQL should include the explicit predicate
    // (belt-and-suspenders against a future schema relaxation).
    seedCorrection(A_CTX, 'A descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    const dispatcherSql = renderedSqls.find((s) =>
      /SELECT\s+DISTINCT\s+tenant_id,\s*agent_id/i.test(s),
    );
    expect(dispatcherSql).toBeDefined();
    expect(dispatcherSql!).toMatch(/tenant_id\s+IS\s+NOT\s+NULL/i);
    expect(dispatcherSql!).toMatch(/agent_id\s+IS\s+NOT\s+NULL/i);
  });
});

// ---------------------------------------------------------------------------
// REQUEST_CHANGES on PR #251 — MEDIUM gaps
// ---------------------------------------------------------------------------
describe('PR #251 REQUEST_CHANGES — MEDIUM #1: fail-isolated per-tenant', () => {
  it('a thrown error in tenant-A does NOT abort processing of tenant-B', async () => {
    seedCorrection(A_CTX, 'A boom descricao');
    seedCorrection(A_CTX, 'A boom descricao');
    seedCorrection(B_CTX, 'B descricao');
    seedCorrection(B_CTX, 'B descricao');

    // Make tenant-A throw on findByContext (one of the catch-bypass paths the
    // reviewer flagged: errors here would escape the create/write try/catch
    // and unwind the per-tenant loop).
    const repos = await import('@/db/repositories.js');
    (repos.rulesRepo.findByContext as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('synthetic tenant-A failure');
      },
    );
    // Subsequent calls (tenant-B) return null as the default behavior.

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await expect(runReflectionBatch()).resolves.toBeUndefined();

    // tenant-B's write must have landed despite tenant-A blowing up. This is
    // the entire point of fail-isolated: a buggy tenant doesn't take down
    // the whole nightly batch.
    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-B');
    expect(writeMemoryCalls[0]!.agent_id).toBe('agent-B');
    expect(rulesRepoCreateCalls).toHaveLength(1);
    expect(rulesRepoCreateCalls[0]!.tenant_id).toBe('tenant-B');
  });

  it('tenant-A failure is logged with tenant_id+agent_id; other tenants still emit reflection_batch.tenant_done', async () => {
    seedCorrection(A_CTX, 'A boom');
    seedCorrection(A_CTX, 'A boom');
    seedCorrection(B_CTX, 'B ok');
    seedCorrection(B_CTX, 'B ok');

    const repos = await import('@/db/repositories.js');
    (repos.rulesRepo.findByContext as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('synthetic failure for log assertion');
      },
    );

    const loggerMod = await import('@/lib/logger.js');
    const warnSpy = loggerMod.logger.warn as ReturnType<typeof vi.fn>;
    const infoSpy = loggerMod.logger.info as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();
    infoSpy.mockClear();

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // The warn log of the failed tenant must carry tenant_id+agent_id so
    // ops can pinpoint which (tenant, agent) blew up.
    const tenantFailedLogs = warnSpy.mock.calls.filter(
      (c) => c[1] === 'reflection_batch.tenant_failed',
    );
    expect(tenantFailedLogs).toHaveLength(1);
    expect(tenantFailedLogs[0]![0]).toMatchObject({
      tenant_id: expect.any(String),
      agent_id: expect.any(String),
      err: expect.stringContaining('synthetic failure for log assertion'),
    });

    // tenant-B (the healthy one) must have emitted a tenant_done log too,
    // proving the loop kept going.
    const tenantDoneLogs = infoSpy.mock.calls.filter(
      (c) => c[1] === 'reflection_batch.tenant_done',
    );
    expect(tenantDoneLogs.length).toBeGreaterThanOrEqual(1);
    const doneTenants = new Set(tenantDoneLogs.map((c) => (c[0] as { tenant_id: string }).tenant_id));
    expect(doneTenants.has('tenant-B')).toBe(true);
  });

  it('reflection_batch.done aggregate carries tenants_failed + tenants_processed counters', async () => {
    seedCorrection(A_CTX, 'A boom');
    seedCorrection(A_CTX, 'A boom');
    seedCorrection(B_CTX, 'B ok');
    seedCorrection(B_CTX, 'B ok');

    const repos = await import('@/db/repositories.js');
    (repos.rulesRepo.findByContext as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('boom');
      },
    );

    const loggerMod = await import('@/lib/logger.js');
    const infoSpy = loggerMod.logger.info as ReturnType<typeof vi.fn>;
    infoSpy.mockClear();

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    const doneLogs = infoSpy.mock.calls.filter((c) => c[1] === 'reflection_batch.done');
    expect(doneLogs).toHaveLength(1);
    const doneFields = doneLogs[0]![0] as {
      tenants: number;
      tenants_processed: number;
      tenants_failed: number;
      tenants_skipped_locked: number;
    };
    expect(doneFields.tenants).toBe(2);
    expect(doneFields.tenants_processed).toBe(1);
    expect(doneFields.tenants_failed).toBe(1);
    expect(doneFields.tenants_skipped_locked).toBe(0);
  });
});

describe('PR #251 REQUEST_CHANGES — MEDIUM #2: concurrent worker guard (advisory lock)', () => {
  it('acquires an advisory lock per (tenant, agent) BEFORE processing and releases it after', async () => {
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // The lock history records exactly one acquire + one unlock for tenant-A.
    const aKey = 'tenant-A|agent-A';
    const tries = lockHistory.filter((h) => h.action === 'try' && h.key === aKey);
    const unlocks = lockHistory.filter((h) => h.action === 'unlock' && h.key === aKey);
    expect(tries).toHaveLength(1);
    expect(tries[0]!.locked).toBe(true);
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0]!.locked).toBe(true);

    // And acquire happens BEFORE the inner write (otherwise the lock can't
    // be protecting the read-then-create race).
    expect(heldLocks.size).toBe(0);
    expect(writeMemoryCalls).toHaveLength(1);
  });

  it('if the lock is already held by another worker, the tenant is SKIPPED (no writes, no inner read)', async () => {
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(A_CTX, 'A descricao');

    // Pre-seed the lock for tenant-A — simulates a second worker already
    // holding it. pg_try_advisory_lock should return false → skip path.
    heldLocks.add('tenant-A|agent-A');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // No writes happened — the tenant was skipped before entering the inner.
    expect(writeMemoryCalls).toHaveLength(0);
    expect(rulesRepoCreateCalls).toHaveLength(0);

    // The per-tenant inner SELECT (acao, alvo_id, ...) must NOT have fired
    // for tenant-A because we skipped before opening the tenant context.
    const innerReads = renderedSqls.filter((s) =>
      /SELECT\s+acao,\s*alvo_id,\s*metadata,\s*pessoa_id/i.test(s),
    );
    expect(innerReads).toHaveLength(0);

    // The pre-seeded lock is still held (we never unlocked it — the worker
    // doesn't release locks it didn't acquire).
    expect(heldLocks.has('tenant-A|agent-A')).toBe(true);
  });

  it('skipped-locked tenants are counted in reflection_batch.done.tenants_skipped_locked', async () => {
    seedCorrection(A_CTX, 'A descricao');
    seedCorrection(B_CTX, 'B descricao');

    // tenant-A is pre-locked (by another worker), tenant-B is free.
    heldLocks.add('tenant-A|agent-A');

    const loggerMod = await import('@/lib/logger.js');
    const infoSpy = loggerMod.logger.info as ReturnType<typeof vi.fn>;
    infoSpy.mockClear();

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // tenant-B processed normally.
    expect(writeMemoryCalls).toHaveLength(1);
    expect(writeMemoryCalls[0]!.tenant_id).toBe('tenant-B');

    // Counters reflect the skip.
    const doneLogs = infoSpy.mock.calls.filter((c) => c[1] === 'reflection_batch.done');
    expect(doneLogs).toHaveLength(1);
    const doneFields = doneLogs[0]![0] as {
      tenants_skipped_locked: number;
      tenants_processed: number;
    };
    expect(doneFields.tenants_skipped_locked).toBe(1);
    expect(doneFields.tenants_processed).toBe(1);

    // A tenant_skipped_locked log was emitted for tenant-A specifically.
    const skipLogs = infoSpy.mock.calls.filter(
      (c) => c[1] === 'reflection_batch.tenant_skipped_locked',
    );
    expect(skipLogs).toHaveLength(1);
    expect(skipLogs[0]![0]).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-A' });
  });

  it('lock is released even if the inner throws (finally guarantees no leaked lock)', async () => {
    seedCorrection(A_CTX, 'A boom');
    seedCorrection(A_CTX, 'A boom');

    const repos = await import('@/db/repositories.js');
    (repos.rulesRepo.findByContext as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('synthetic failure');
      },
    );

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // Even though tenant-A blew up, the advisory lock must have been
    // released — otherwise a sticky lock would block all subsequent worker
    // ticks for this tenant forever.
    expect(heldLocks.has('tenant-A|agent-A')).toBe(false);

    // History confirms acquire then unlock in order.
    const aKey = 'tenant-A|agent-A';
    const events = lockHistory.filter((h) => h.key === aKey);
    expect(events.map((e) => e.action)).toEqual(['try', 'unlock']);
  });

  it('distinct (tenant, agent) pairs each get their own lock — different pairs do not contend', async () => {
    // Both pairs are free; both should acquire successfully.
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-A' }, 'A1');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-A' }, 'A1');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-OTHER' }, 'A2');
    seedCorrection({ tenant_id: 'tenant-A', agent_id: 'agent-OTHER' }, 'A2');

    const { runReflectionBatch } = await import('@/workers/reflection-batch.js');
    await runReflectionBatch();

    // Both pairs processed.
    expect(writeMemoryCalls).toHaveLength(2);
    const pairs = new Set(writeMemoryCalls.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(pairs).toEqual(new Set(['tenant-A|agent-A', 'tenant-A|agent-OTHER']));

    // Both locks acquired and released — no held lock at end.
    expect(heldLocks.size).toBe(0);
    // Each pair has its own try+unlock pair.
    for (const key of ['tenant-A|agent-A', 'tenant-A|agent-OTHER']) {
      const events = lockHistory.filter((h) => h.key === key);
      expect(events.map((e) => e.action)).toEqual(['try', 'unlock']);
    }
  });
});
