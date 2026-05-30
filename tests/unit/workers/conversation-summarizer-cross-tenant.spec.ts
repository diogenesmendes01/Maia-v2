/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `conversation-summarizer` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runConversationSummarizer` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples owning a stale conversation
 *      (`conversasRepo.listTenantAgentPairsWithStaleConversations`) and runs the
 *      existing inner ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      inner's stale-conversation SELECT never executes under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   4. MUTATION ISOLATION (the test that would have caught the #345 review bug):
 *      the inner's RAW `db.select(conversas)` is scoped to the current
 *      (tenant_id, agent_id), and `conversasRepo.close()`'s UPDATE is likewise
 *      scoped. Running the inner under tenant-A summarizes/closes ONLY tenant-A's
 *      stale conversations and leaves tenant-B's rows UNTOUCHED — proved against
 *      an in-memory store keyed by tenant whose SELECT/UPDATE apply the REAL
 *      drizzle predicate. Before the fix the inner SELECT had no tenant binding,
 *      so it would read (and then close) every tenant's stale conversations.
 *
 * Strategy: a single store-backed `@/db/client.js` mock serves both blocks. For
 * the DISPATCH-routing block the store is EMPTY, so the inner SELECT resolves to
 * `[]` (loop body never runs) while a thin wrapper records the ACTIVE tenant
 * context at the SELECT call site. For the MUTATION-ISOLATION block the store is
 * seeded with tenant-A + tenant-B stale conversations and the REAL
 * `conversasRepo.close()` runs (only the enumeration helper + `mensagensRepo`
 * are overridden). The cognition/LLM modules are stubbed defensively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
/** Context active each time the inner's stale-conversation SELECT fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();

const listStalePairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

// Store-backed `db` (select + update). The MUTATION-ISOLATION block seeds it and
// drives the REAL inner SELECT + `conversasRepo.close()`. The DISPATCH block
// leaves it empty so the inner SELECT returns `[]`.
const mutationStore = makeTenantScopedUpdateStore();

// Thin wrapper over the store's `select` that ALSO records the live ALS context
// at the SELECT call site (preserving the dispatch-routing assertions) and lets
// a tuple synthesise an inner failure (fail-isolation tests).
const dbSelectMock = vi.fn(() => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'conversation-summarizer inner SELECT ran outside tenant context — getCurrentTenant would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic summarizer failure for ${key}`);
  return mutationStore.db.select();
});

vi.mock('@/db/client.js', () => ({
  db: {
    select: dbSelectMock,
    update: (...args: unknown[]) => mutationStore.db.update(...args),
  },
  withTx: async (fn: (tx: unknown) => unknown) => fn(mutationStore.db),
}));

// Keep the REAL repo (so `conversasRepo.close`'s WHERE predicate is exercised in
// the mutation block) and override ONLY the dispatcher-enumeration helper and
// `mensagensRepo.recentInConversation` (which would otherwise hit the store with
// a mensagens query the harness doesn't model — we force the empty-transcript,
// direct-`close()` branch).
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    conversasRepo: {
      ...actual.conversasRepo,
      listTenantAgentPairsWithStaleConversations: listStalePairsMock,
    },
    mensagensRepo: {
      ...actual.mensagensRepo,
      recentInConversation: vi.fn(async () => []),
    },
  };
});

// Defensive stubs — not reached with an empty stale set, but keep the module
// graph importable without DB/LLM/config side effects.
vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn(async () => ({ content: '' })) }));
vi.mock('@/cognition/reflector.js', () => ({ reflect: vi.fn(async () => null) }));
vi.mock('@/cognition/classifier.js', () => ({ classify: vi.fn(async () => null) }));
vi.mock('@/cognition/persister.js', () => ({ persistCandidate: vi.fn(async () => undefined) }));
vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    status: 'ok',
    output: await fn(),
  })),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  throwForTuple = new Set();
  listStalePairsMock.mockClear();
  dbSelectMock.mockClear();
  // DISPATCH tests run with an EMPTY store (inner SELECT → []); the
  // MUTATION-ISOLATION block re-seeds it in its own beforeEach.
  mutationStore.reset([]);
});

describe('Issue #345 — runConversationSummarizer is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — inner runs once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runConversationSummarizer();

    expect(listStalePairsMock).toHaveBeenCalledTimes(1);
    expect(contextsSeen).toHaveLength(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — inner SELECT never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runConversationSummarizer();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runConversationSummarizer();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (inner SELECT never fires)', async () => {
    enumeratedPairs = [];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runConversationSummarizer();

    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await expect(runConversationSummarizer()).resolves.toBeUndefined();

    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await expect(runConversationSummarizer()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runWithTenantContext(A, runConversationSummarizer);

    expect(contextsSeen).toEqual([B]);
  });
});

/**
 * MUTATION ISOLATION — drives the REAL inner (`runConversationSummarizerInner`)
 * for tuple A ONLY, against a store seeded with stale conversations for BOTH
 * tenant A and tenant B. Each conversation has no messages
 * (`recentInConversation → []`), so the inner takes the direct
 * `conversasRepo.close(c.id, '')` branch — exercising BOTH scoped mutations:
 *   - the raw `db.select(conversas)` (must only return tenant-A's rows), and
 *   - `conversasRepo.close()`'s UPDATE (must only close tenant-A's rows).
 *
 * This is the #345 review regression lever: before the fix the inner SELECT had
 * no tenant predicate, so it would read tenant-B's stale conversation and close
 * it under tenant-A's run — a cross-tenant mutation. The assertion proves
 * tenant-B's conversa is left `ativa`.
 */
describe('Issue #345 — conversation-summarizer mutates ONLY the current tenant/agent', () => {
  const STALE = new Date(Date.now() - 30 * 86_400_000).toISOString(); // 30d old
  const FRESH = new Date().toISOString();
  const conv = (over: Partial<StoreRow>): StoreRow => ({
    id: 'c',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'ativa',
    ultima_atividade_em: STALE,
    ...over,
  });

  beforeEach(() => {
    contextsSeen.length = 0;
    mutationStore.reset([
      // Tenant A: stale+ativa (SHOULD be closed when running as A).
      conv({ id: 'A-stale', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // Tenant B: stale+ativa, different tenant (MUST stay untouched).
      conv({ id: 'B-stale', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Tenant A but a DIFFERENT agent (MUST stay untouched).
      conv({ id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
      // Tenant A but FRESH (not stale) — predicate must spare it.
      conv({ id: 'A-fresh', tenant_id: 'tenant-A', agent_id: 'agent-A', ultima_atividade_em: FRESH }),
    ]);
  });

  it('running the inner under tuple A closes ONLY tenant-A/agent-A stale conversations', async () => {
    enumeratedPairs = [A];

    const { runConversationSummarizer } = await import('@/workers/conversation-summarizer.js');
    await runConversationSummarizer();

    const byId = (id: string) => mutationStore.rows.find((r) => r.id === id)!;
    // Only tenant-A/agent-A's stale conversa was closed.
    expect(byId('A-stale').status).toBe('encerrada');
    // Cross-tenant isolation: tenant-B untouched …
    expect(byId('B-stale').status).toBe('ativa');
    // … other agent of tenant-A untouched …
    expect(byId('A-otherAgent').status).toBe('ativa');
    // … and the fresh (not-stale) tenant-A conversa untouched.
    expect(byId('A-fresh').status).toBe('ativa');

    // The inner SELECT predicate actually bound tenant_id AND agent_id.
    const selectTerms = parsePredicateForTest(mutationStore.lastSelectPredicate());
    expect(selectTerms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(selectTerms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
    // …and so did the close() UPDATE predicate.
    const updateTerms = parsePredicateForTest(mutationStore.lastPredicate());
    expect(updateTerms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(updateTerms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
  });
});
