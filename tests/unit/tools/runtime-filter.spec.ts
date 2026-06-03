/**
 * Issue #408 — `computeRuntimeVisibleTools`: the end-to-end Runtime Tool Filter
 * (agent grant ∩ skill scope ∩ human permission ∩ feature flag) + the
 * `tool_visibility_resolved` provenance audit.
 *
 * Drives the REAL filter with mocked collateral (`agentToolGrantsRepo`, the
 * registry projection, `audit`) to prove:
 *   1. a baseline-only grant yields baseline tools, finance hidden;
 *   2. a domain.finance grant exposes the finance tools the PERSON is
 *      authorised for (human-permission layer still applies);
 *   3. a skill allowlist reduces the visible set;
 *   4. the provenance audit (`tool_visibility_resolved`) records the layers;
 *   5. a missing grant row degrades to the baseline floor (fail-closed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { grantState } = vi.hoisted(() => ({
  grantState: {
    grant: null as
      | { granted_packs: string[]; granted_tools: string[]; denied_tools: string[] }
      | null,
  },
}));

vi.mock('@/db/repositories.js', () => ({
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => grantState.grant),
  },
}));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the registry projection so this test is independent of the live tool
// set: it returns the visible names that pass the human-permission filter. We
// simulate a person who can do everything granted (owner) by echoing the input.
vi.mock('@/tools/_registry.js', () => ({
  getAgentToolSchemas: vi.fn(
    (visible: ReadonlySet<string> | readonly string[]) => {
      const set = visible instanceof Set ? visible : new Set(visible);
      return [...set].map((name) => ({
        name,
        description: name,
        input_schema: { type: 'object' as const, additionalProperties: true },
      }));
    },
  ),
}));

import { computeRuntimeVisibleTools } from '@/tools/runtime-filter.js';
import type { ResolvedPermission } from '@/governance/permissions.js';

const ownerByEntity = new Map<string, ResolvedPermission>();

beforeEach(() => {
  vi.clearAllMocks();
  grantState.grant = null;
});

describe('computeRuntimeVisibleTools — Runtime Tool Filter (#408)', () => {
  it('(1) baseline-only grant → baseline tools visible, finance hidden', async () => {
    grantState.grant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] };
    const res = await computeRuntimeVisibleTools({ byEntity: ownerByEntity });
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('audit_decision');
    expect(names).toContain('read_turn_context');
    expect(names).not.toContain('register_transaction');
  });

  it('(2) domain.finance grant exposes the finance tools', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = await computeRuntimeVisibleTools({ byEntity: ownerByEntity });
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('register_transaction');
    expect(names).toContain('query_balance');
  });

  it('(3) a skill allowlist reduces the visible set', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = await computeRuntimeVisibleTools({
      byEntity: ownerByEntity,
      skillScope: { skill_id: 's', allowed_tools: ['query_balance'] },
    });
    expect(res.tools.map((t) => t.name)).toEqual(['query_balance']);
  });

  it('(4) emits a tool_visibility_resolved provenance audit', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: ['cancel_transaction'],
    };
    await computeRuntimeVisibleTools({
      byEntity: ownerByEntity,
      skillScope: { skill_id: 'skill.bal', allowed_tools: ['query_balance'] },
      audit_context: { pessoa_id: 'p1', conversa_id: 'c1', mensagem_id: 'm1' },
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const row = auditMock.mock.calls[0]![0] as { acao: string; metadata: Record<string, unknown> };
    expect(row.acao).toBe('tool_visibility_resolved');
    expect(row.metadata.granted_packs).toEqual(['baseline.core', 'domain.finance']);
    expect(row.metadata.denied_by_grant).toEqual(['cancel_transaction']);
    expect(row.metadata.skill_id).toBe('skill.bal');
    expect(row.metadata.visible_tools).toEqual(['query_balance']);
  });

  it('(5) a missing grant row degrades to the baseline floor (fail-closed)', async () => {
    grantState.grant = null;
    const res = await computeRuntimeVisibleTools({ byEntity: ownerByEntity });
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('audit_decision');
    expect(names).not.toContain('register_transaction');
    // The grant returned reflects the baseline fallback.
    expect(res.grant.granted_packs).toEqual(['baseline.core']);
  });
});
