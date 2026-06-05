/**
 * Issue #408 — `getAgentToolSchemas`: the AGENT-grant ∩ HUMAN-permission ∩
 * feature-flag projection onto the registry view (the registry half of the
 * Runtime Tool Filter).
 *
 * Proves:
 *   1. only tools in the precomputed visible set are returned (agent grant ∩
 *      skill scope is applied UPSTREAM by computeAgentVisibleTools and passed in);
 *   2. the HUMAN-permission filter still applies — a non-owner only sees tools
 *      whose `required_actions ⊆ allowed`, even if granted;
 *   3. an owner (acoes includes '*') sees every VISIBLE tool regardless of
 *      required_actions — but still ONLY the visible ones (grant is additive,
 *      it never widens past the grant);
 *   4. an empty visible set yields zero tools (fail-closed).
 *
 * Imports the real registry (gateway stubbed, like registry-tool-catalog.spec).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-agent-schemas-media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn(), agentQueue: {} }));

import type { ResolvedPermission } from '../../../src/governance/permissions.js';

function byEntityWith(acoes: string[]): Map<string, ResolvedPermission> {
  return new Map([
    [
      'e-1',
      {
        permissao: { status: 'ativa' },
        profile: { acoes },
        effective_limits: { valor_max: 0 },
      } as unknown as ResolvedPermission,
    ],
  ]);
}

describe('getAgentToolSchemas — grant ∩ human-permission ∩ flag (#408)', () => {
  it('(1) returns only tools present in the visible set (owner)', async () => {
    const { getAgentToolSchemas } = await import('../../../src/tools/_registry.js');
    const visible = new Set(['query_balance', 'audit_decision']);
    const schemas = getAgentToolSchemas(visible, byEntityWith(['*']));
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(['audit_decision', 'query_balance']);
  });

  it('(2) a non-owner only sees granted tools whose required_actions ⊆ allowed', async () => {
    const { getAgentToolSchemas } = await import('../../../src/tools/_registry.js');
    // Grant BOTH tools, but the person can only read_balance (not read_transactions).
    const visible = new Set(['query_balance', 'list_transactions']);
    const schemas = getAgentToolSchemas(visible, byEntityWith(['read_balance']));
    const names = schemas.map((s) => s.name);
    // query_balance requires read_balance (allowed) → visible.
    expect(names).toContain('query_balance');
    // list_transactions requires read_transactions (NOT allowed) → hidden.
    expect(names).not.toContain('list_transactions');
  });

  it('(3) an owner sees every VISIBLE tool but the grant never widens past it', async () => {
    const { getAgentToolSchemas } = await import('../../../src/tools/_registry.js');
    // Owner, but only audit_decision is in the grant → only audit_decision shows.
    const schemas = getAgentToolSchemas(new Set(['audit_decision']), byEntityWith(['*']));
    expect(schemas.map((s) => s.name)).toEqual(['audit_decision']);
  });

  it('(4) an empty visible set yields zero tools (fail-closed)', async () => {
    const { getAgentToolSchemas } = await import('../../../src/tools/_registry.js');
    expect(getAgentToolSchemas(new Set(), byEntityWith(['*']))).toEqual([]);
    expect(getAgentToolSchemas([], byEntityWith(['*']))).toEqual([]);
  });
});
