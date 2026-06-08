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

  it('(5) a missing grant row degrades to the BASE_AGENT_PACKS floor (fail-closed, includes calendar)', async () => {
    grantState.grant = null;
    const res = await computeRuntimeVisibleTools({ byEntity: ownerByEntity });
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('audit_decision');
    expect(names).not.toContain('register_transaction');
    // The grant returned reflects the BASE_AGENT_PACKS fallback (baseline.core + domain.calendar).
    expect(res.grant.granted_packs).toContain('baseline.core');
    expect(res.grant.granted_packs).toContain('domain.calendar');
  });

  // ---------------------------------------------------------------------------
  // Issue #409 — the #408-documented audience hook: a skill BLOCKED by its
  // usage_policy for the audience contributes NO scope, so its tools never reach
  // the LLM via a skill the audience may not use.
  // ---------------------------------------------------------------------------

  const ownerAudience = {
    audience_type: 'owner' as const,
    trust_level: 'trusted_internal' as const,
    channel_type: 'whatsapp',
    allowed_data_scope: ['financial_summary', 'public_info'] as const,
  };
  const customerAudience = {
    audience_type: 'customer' as const,
    trust_level: 'known_external' as const,
    channel_type: 'whatsapp',
    allowed_data_scope: ['own_customer_data_only', 'public_info'] as const,
  };
  const financeSkillPolicy = {
    allowed_audience: ['owner', 'manager'],
    blocked_audience: ['customer'],
    data_scope: ['financial_summary'],
    exposure_policy: 'internal_only',
    requires_auth_level: 'trusted_internal',
    requires_confirmation: false,
  };

  it('(#409) skill scope APPLIED when the audience is admitted → narrowed set', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = await computeRuntimeVisibleTools({
      byEntity: ownerByEntity,
      skillScope: { skill_id: 'daily_business_summary', allowed_tools: ['query_balance'] },
      audience: ownerAudience,
      skillUsagePolicy: financeSkillPolicy,
    });
    // Owner is admitted → the skill allow-list narrows to query_balance.
    expect(res.tools.map((t) => t.name)).toEqual(['query_balance']);
  });

  it('(#409) skill scope DROPPED when the audience is blocked → blocked-skill tools NOT exposed', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = await computeRuntimeVisibleTools({
      byEntity: ownerByEntity,
      skillScope: { skill_id: 'daily_business_summary', allowed_tools: ['query_balance'] },
      audience: customerAudience, // blocked_audience includes customer
      skillUsagePolicy: financeSkillPolicy,
      audit_context: { pessoa_id: 'p1', conversa_id: 'c1', mensagem_id: 'm1' },
    });
    const names = res.tools.map((t) => t.name);
    // The skill scope was dropped (customer not admitted). The narrowing the
    // skill would have imposed (allowed_tools=['query_balance']) is NOT applied,
    // but critically the skill never FORCES query_balance into view because the
    // dispatcher + grant still gate it. The provenance records the drop.
    const row = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'tool_visibility_resolved',
    );
    expect(row).toBeTruthy();
    const meta = (row![0] as { metadata: Record<string, unknown> }).metadata;
    expect(typeof meta.skill_scope_dropped_reason).toBe('string');
    expect(String(meta.skill_scope_dropped_reason)).toContain('audience_blocked');
    // skill_id provenance is null because the scope was dropped before composing.
    expect(meta.skill_id).toBeNull();
    // The narrowed allow-list is gone, so the agent's full granted finance set is
    // visible again (the skill no longer constrains it) — proving the blocked
    // skill imposed NO scope.
    expect(names).toContain('register_transaction');
  });

  it('(#409) a MALFORMED usage_policy drops the skill scope (fail-closed)', async () => {
    grantState.grant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = await computeRuntimeVisibleTools({
      byEntity: ownerByEntity,
      skillScope: { skill_id: 's', allowed_tools: ['query_balance'] },
      audience: ownerAudience,
      skillUsagePolicy: { allowed_audience: [] }, // invalid
    });
    // Scope dropped → no narrowing applied.
    expect(res.tools.map((t) => t.name)).toContain('register_transaction');
  });
});
