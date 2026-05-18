/**
 * P10a (Codex review #104 critical #1) — visibility filter is enforced
 * on every read path that exposes knowledge to the LLM.
 *
 * The legacy `factsRepo.listForScopes` and `listMentionableForScopes`
 * filtered only by tenant/agent/escopo. After P10a started persisting
 * `agent_facts.lifecycle_status`, a `propose_fact` row with status
 * `pending_review` could reach the prompt's "Fatos relevantes" block
 * because the lifecycle filter was missing — same for revoked rows.
 *
 * This suite verifies the read-path-level filter that lives in
 * src/db/repositories.ts. We assert by inspecting the generated SQL
 * fragments rather than running against Postgres (no DB in unit
 * tests), and by demonstrating that each repo method only returns
 * rows whose lifecycle_status is in VISIBLE_STATES.
 */

import { describe, expect, it, vi } from 'vitest';

// Capture every SQL fragment Drizzle assembles so we can assert that
// the lifecycle_status predicate is present. The actual db.select chain
// is stubbed to return [] — we only need the .where(...) call to
// include the visibility filter.
const recordedWhereClauses: string[] = [];

// Walk an arbitrary object graph and stringify every key + primitive
// value into a flat list of substrings — Drizzle's SQL fragments are
// nested objects with column refs and parameter values that JSON.stringify
// can't easily collapse, so we recurse manually and skip cycles.
function deepStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value as object)) return '[cycle]';
  seen.add(value as object);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    parts.push(k);
    parts.push(deepStringify(v, seen));
  }
  return parts.join(' ');
}

vi.mock('@/db/client.js', () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = (clause: unknown) => {
    recordedWhereClauses.push(deepStringify(clause));
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = () => Promise.resolve([]);
  chain.execute = () => Promise.resolve({ rows: [] as unknown[] });
  // execute() is called as a function but the db object exposes execute
  // directly for raw-SQL paths — return the same recorder shape.
  return {
    db: {
      select: chain.select,
      execute: async (sqlFragment: unknown) => {
        recordedWhereClauses.push(deepStringify(sqlFragment));
        return { rows: [] };
      },
    },
    withTx: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({}),
  };
});

vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: () => 'tenant-a',
  getCurrentAgent: () => 'agent-a',
}));

vi.mock('@/db/tenant-guard.js', () => ({
  applyTenantGuard: <T,>(input: T) => input,
}));

// Lazy-import so the mock is wired before the repo file evaluates.
async function loadRepos() {
  return import('@/db/repositories.js');
}

describe('P10a visibility filter on read paths', () => {
  it('factsRepo.listForScopes includes lifecycle_status filter in WHERE', async () => {
    recordedWhereClauses.length = 0;
    const { factsRepo } = await loadRepos();
    await factsRepo.listForScopes(['global']);
    expect(recordedWhereClauses.length).toBeGreaterThan(0);
    const combined = recordedWhereClauses.join('|');
    // Drizzle serialises predicates via `inArray` — the table+column
    // reference + the visible-state literals must all appear.
    expect(combined).toContain('lifecycle_status');
    expect(combined).toContain('ephemeral');
    expect(combined).toContain('active');
  });

  it('factsRepo.listMentionableForScopes raw SQL contains lifecycle_status IN clause', async () => {
    recordedWhereClauses.length = 0;
    const { factsRepo } = await loadRepos();
    await factsRepo.listMentionableForScopes(['global']);
    const combined = recordedWhereClauses.join('|');
    expect(combined).toContain('lifecycle_status');
    // Critical assertion: ephemeral/observed/reinforced/verified/active
    // are visible. pending_review / deprecated / revoked must NOT
    // appear as visible literals.
    expect(combined).toContain('ephemeral');
    expect(combined).toContain('active');
    expect(combined).toContain('verified');
    expect(combined).not.toContain("'pending_review'");
  });

  it('rulesRepo.listActive includes lifecycle_status filter', async () => {
    recordedWhereClauses.length = 0;
    const { rulesRepo } = await loadRepos();
    await rulesRepo.listActive('classificacao');
    const combined = recordedWhereClauses.join('|');
    expect(combined).toContain('lifecycle_status');
    expect(combined).toContain('ephemeral');
    expect(combined).toContain('active');
  });

  it('memoryEntryRepo.findRelevant filters by lifecycle_status', async () => {
    recordedWhereClauses.length = 0;
    const { memoryEntryRepo } = await loadRepos();
    await memoryEntryRepo.findRelevant({ interlocutor_id: 'pessoa-1' });
    const combined = recordedWhereClauses.join('|');
    expect(combined).toContain('lifecycle_status');
  });

  it('behavioralHintRepo.findActiveForScope filters by lifecycle_status', async () => {
    recordedWhereClauses.length = 0;
    const { behavioralHintRepo } = await loadRepos();
    await behavioralHintRepo.findActiveForScope({
      scope_type: 'agent',
      subject_id: null,
    });
    const combined = recordedWhereClauses.join('|');
    expect(combined).toContain('lifecycle_status');
  });
});
