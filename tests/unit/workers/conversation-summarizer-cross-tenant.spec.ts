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
 * Strategy: mock `@/db/repositories.js` for the enumeration and `@/db/client.js`
 * so the inner's `db.select().from(conversas)...` chain captures the ACTIVE
 * tenant context and returns an EMPTY stale set (so the per-conversation loop
 * body — LLM/reflection — never runs; we only need to prove the inner executed
 * under the routed tuple). The cognition/LLM modules are stubbed defensively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
/** Context active each time the inner's stale-conversation SELECT fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();

const listStalePairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

// Chainable drizzle `db.select().from().where().limit()` stub. The terminal
// `.limit()` captures the live ALS context and resolves to an empty stale set.
function makeSelectChain() {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => {
      const ctx = tryGetCurrentContext();
      if (!ctx) {
        throw new Error(
          'conversation-summarizer inner SELECT ran outside tenant context — getCurrentTenant would throw in prod',
        );
      }
      contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
      const key = `${ctx.tenant_id}|${ctx.agent_id}`;
      if (throwForTuple.has(key)) throw new Error(`synthetic summarizer failure for ${key}`);
      return []; // empty stale set → per-conversation loop never runs
    }),
  };
  return chain;
}

const dbSelectMock = vi.fn(() => makeSelectChain());

vi.mock('@/db/client.js', () => ({
  db: { select: dbSelectMock },
}));

vi.mock('@/db/repositories.js', () => ({
  conversasRepo: {
    listTenantAgentPairsWithStaleConversations: listStalePairsMock,
    close: vi.fn(async () => undefined),
  },
  mensagensRepo: {
    recentInConversation: vi.fn(async () => []),
  },
}));

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
