/**
 * P8e Task 9 — unit tests for policyRulesRepo.
 *
 * Spec §8.1. Mock-based pattern (matches operational-profile-versions-repo.spec.ts):
 * we mock `@/control-plane/policy/policy-rules-repo.js` with an in-memory state
 * that mirrors the real contract. Tests validate state-machine transitions,
 * the hard_limit guard, tenant isolation, and agent-specific precedence.
 *
 * We do NOT hit Postgres here. The integration test runs the real repo against
 * the real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type {
  PolicyRule,
  PolicyRuleBody,
  PolicyRuleKind,
  PolicyRuleScope,
  PolicySourceOfTruth,
  PolicyRulesRepo,
  DualApprovalEvidence,
} from '@/control-plane/policy/index.js';
import { isValidDualApprovalEvidence } from '@/control-plane/policy/index.js';

type ProposeInput = {
  agent_id?: string | null;
  rule_kind: PolicyRuleKind;
  rule_descriptor: string;
  rule_body: PolicyRuleBody;
  scope?: PolicyRuleScope;
  source_of_truth: PolicySourceOfTruth;
  proposed_by: string;
  proposed_reason?: string;
};

const state: Record<string, PolicyRule> = {};

vi.mock('@/control-plane/policy/policy-rules-repo.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/control-plane/policy/policy-rules-repo.js')
  >('@/control-plane/policy/policy-rules-repo.js');
  const { getCurrentTenant } = await import('@/db/tenant-context.js');

  const findActive = (
    tenant_id: string,
    agent_id: string | null,
    descriptor: string,
  ): PolicyRule | null =>
    Object.values(state).find(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.rule_descriptor === descriptor &&
        r.status === 'active',
    ) ?? null;

  const repo: PolicyRulesRepo = {
    async findActiveByDescriptor(args) {
      const tenant_id = getCurrentTenant();
      if (args.agent_id) {
        const a = findActive(tenant_id, args.agent_id, args.descriptor);
        if (a) return a;
      }
      return findActive(tenant_id, null, args.descriptor);
    },
    async listActiveForTenant() {
      const tenant_id = getCurrentTenant();
      return Object.values(state).filter(
        (r) => r.tenant_id === tenant_id && r.status === 'active',
      );
    },
    async listVersions(args) {
      const tenant_id = getCurrentTenant();
      const agent_id = args.agent_id ?? null;
      return Object.values(state)
        .filter(
          (r) =>
            r.tenant_id === tenant_id &&
            r.agent_id === agent_id &&
            r.rule_descriptor === args.descriptor,
        )
        .sort((a, b) => b.version - a.version);
    },
    async getById(id) {
      const tenant_id = getCurrentTenant();
      const r = state[id];
      if (!r || r.tenant_id !== tenant_id) return null;
      return r;
    },
    async nextVersion(args) {
      const tenant_id = getCurrentTenant();
      const agent_id = args.agent_id ?? null;
      const rows = Object.values(state).filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.rule_descriptor === args.descriptor,
      );
      if (rows.length === 0) return 1;
      return Math.max(...rows.map((r) => r.version)) + 1;
    },
    async propose(input: ProposeInput) {
      const tenant_id = getCurrentTenant();
      const agent_id = input.agent_id ?? null;
      const version = await repo.nextVersion({
        descriptor: input.rule_descriptor,
        agent_id,
      });
      const id = `pol-${Math.random().toString(36).slice(2)}`;
      const row: PolicyRule = {
        id,
        tenant_id,
        agent_id,
        rule_kind: input.rule_kind,
        rule_descriptor: input.rule_descriptor,
        rule_body: input.rule_body,
        scope: input.scope ?? {},
        source_of_truth: input.source_of_truth,
        status: 'proposed',
        version,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
        approved_by: null,
        approved_at: null,
        activated_at: null,
        deprecated_at: null,
        rolled_back_at: null,
        rollback_reason: null,
        created_at: new Date(),
      };
      state[id] = row;
      return row;
    },
    async activate(args) {
      const tenant_id = getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'proposed') {
        return { ok: false, reason: 'invalid_transition' };
      }
      const requiresDual =
        row.rule_kind === 'hard_limit' || row.rule_kind === 'lockdown_trigger';
      if (requiresDual) {
        if (!args.dual_approval_evidence) {
          return { ok: false, reason: 'hard_limit_requires_dual_approval' };
        }
        if (!isValidDualApprovalEvidence(args.dual_approval_evidence)) {
          return { ok: false, reason: 'invalid_dual_approval_evidence' };
        }
        if (args.dual_approval_evidence.approvers.includes(args.approved_by)) {
          return { ok: false, reason: 'invalid_dual_approval_evidence' };
        }
      }
      // Simulate one-active partial unique index.
      const existingActive = findActive(
        row.tenant_id,
        row.agent_id,
        row.rule_descriptor,
      );
      if (existingActive) {
        return { ok: false, reason: 'already_has_active' };
      }
      const now = new Date();
      const updated: PolicyRule = {
        ...row,
        status: 'active',
        approved_by: args.approved_by,
        approved_at: now,
        activated_at: now,
      };
      state[row.id] = updated;
      return { ok: true, updated };
    },
    async deprecate(args) {
      const tenant_id = getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status !== 'active') {
        return { ok: false, reason: 'invalid_transition' };
      }
      const updated: PolicyRule = {
        ...row,
        status: 'deprecated',
        deprecated_at: new Date(),
      };
      state[row.id] = updated;
      return { ok: true, updated };
    },
    async rollback(args) {
      const tenant_id = getCurrentTenant();
      const row = state[args.id];
      if (!row || row.tenant_id !== tenant_id) {
        return { ok: false, reason: 'not_found' };
      }
      if (row.status === 'rolled_back') {
        return { ok: false, reason: 'terminal' };
      }
      const updated: PolicyRule = {
        ...row,
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: args.rollback_reason,
      };
      state[row.id] = updated;
      return { ok: true, updated };
    },
  };

  return {
    ...actual,
    policyRulesRepo: repo,
  };
});

// Import AFTER the mock so the resolved module is the mocked one.
const { policyRulesRepo } = await import(
  '@/control-plane/policy/policy-rules-repo.js'
);

const ctx = (tenant: string = 'default', agent: string = 'default') =>
  ({ tenant_id: tenant, agent_id: agent });

const baseProposeInput = (
  overrides: Partial<ProposeInput> = {},
): ProposeInput => ({
  rule_kind: 'soft_guidance',
  rule_descriptor: 'test_descriptor',
  rule_body: {},
  source_of_truth: 'founder_explicit',
  proposed_by: 'tester',
  ...overrides,
});

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
});

describe('policyRulesRepo.propose', () => {
  it('always forces status=proposed regardless of input shape', async () => {
    await runWithTenantContext(ctx(), async () => {
      const r = await policyRulesRepo.propose(baseProposeInput());
      expect(r.status).toBe('proposed');
      expect(r.approved_by).toBeNull();
      expect(r.approved_at).toBeNull();
      expect(r.activated_at).toBeNull();
    });
  });

  it('auto-resolves version: 1, 2, 3 for the same descriptor', async () => {
    await runWithTenantContext(ctx(), async () => {
      const a = await policyRulesRepo.propose(baseProposeInput());
      const b = await policyRulesRepo.propose(baseProposeInput());
      const c = await policyRulesRepo.propose(baseProposeInput());
      expect(a.version).toBe(1);
      expect(b.version).toBe(2);
      expect(c.version).toBe(3);
    });
  });

  it('keeps independent version counters per (agent_id_or_wide, descriptor)', async () => {
    await runWithTenantContext(ctx(), async () => {
      const wideA = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'a' }),
      );
      const wideB = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'b' }),
      );
      const agentA = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'a', agent_id: 'agent-1' }),
      );
      expect(wideA.version).toBe(1);
      expect(wideB.version).toBe(1);
      expect(agentA.version).toBe(1); // independent of wideA
    });
  });
});

describe('policyRulesRepo.activate', () => {
  it('proposed → active works for soft_guidance', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'admin',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.updated.status).toBe('active');
      expect(res.updated.approved_by).toBe('admin');
      expect(res.updated.activated_at).not.toBeNull();
    });
  });

  it('hard_limit without dual_approval_evidence → reason=hard_limit_requires_dual_approval', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'admin',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('hard_limit_requires_dual_approval');
    });
  });

  it('hard_limit with VALID structured dual_approval_evidence activates', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'executor',
        dual_approval_evidence: {
          approvers: ['owner-alice', 'compliance-bob'],
          approved_at: [
            '2026-05-01T10:00:00.000Z',
            '2026-05-01T10:05:00.000Z',
          ],
        },
      });
      expect(res.ok).toBe(true);
    });
  });

  it('hard_limit REJECTS old-style truthy-object evidence (Codex #93 closed loophole)', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      // Pre-fix: this used to pass. Post-fix: rejected with the new reason.
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'admin',
        dual_approval_evidence: { compliance_signer: 'CRO' } as DualApprovalEvidence,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_dual_approval_evidence');
    });
  });

  it('hard_limit REJECTS evidence with only ONE approver', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'executor',
        dual_approval_evidence: {
          approvers: ['solo'],
          approved_at: ['2026-05-01T10:00:00.000Z'],
        },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_dual_approval_evidence');
    });
  });

  it('hard_limit REJECTS evidence with two NON-DISTINCT approvers', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'executor',
        dual_approval_evidence: {
          approvers: ['same-user', 'same-user'],
          approved_at: [
            '2026-05-01T10:00:00.000Z',
            '2026-05-01T10:05:00.000Z',
          ],
        },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_dual_approval_evidence');
    });
  });

  it('hard_limit REJECTS when executor is also one of the approvers (separation of duties)', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_kind: 'hard_limit' }),
      );
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'alice',
        dual_approval_evidence: {
          approvers: ['alice', 'bob'],
          approved_at: [
            '2026-05-01T10:00:00.000Z',
            '2026-05-01T10:05:00.000Z',
          ],
        },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_dual_approval_evidence');
    });
  });

  it('lockdown_trigger ALSO requires structured dual_approval_evidence (Codex #93: kill-switch was unguarded)', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({
          rule_kind: 'lockdown_trigger',
          rule_descriptor: 'tenant_lockdown',
        }),
      );
      // Missing evidence: rejected.
      const r1 = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'executor',
      });
      expect(r1.ok).toBe(false);
      if (r1.ok) return;
      expect(r1.reason).toBe('hard_limit_requires_dual_approval');

      // Valid evidence: activates.
      const r2 = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'executor',
        dual_approval_evidence: {
          approvers: ['owner', 'compliance'],
          approved_at: [
            '2026-05-01T10:00:00.000Z',
            '2026-05-01T10:05:00.000Z',
          ],
        },
      });
      expect(r2.ok).toBe(true);
    });
  });

  it('refuses second active for same (tenant, agent_or_wide, descriptor)', async () => {
    await runWithTenantContext(ctx(), async () => {
      const a = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.activate({ id: a.id, approved_by: 'admin' });
      const b = await policyRulesRepo.propose(baseProposeInput());
      const res = await policyRulesRepo.activate({
        id: b.id,
        approved_by: 'admin',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('already_has_active');
    });
  });

  it('proposed → already-active row returns invalid_transition when re-activated', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.activate({ id: p.id, approved_by: 'admin' });
      const res = await policyRulesRepo.activate({
        id: p.id,
        approved_by: 'admin',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_transition');
    });
  });

  it('not_found when id does not exist', async () => {
    await runWithTenantContext(ctx(), async () => {
      const res = await policyRulesRepo.activate({
        id: 'pol-doesnotexist',
        approved_by: 'admin',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('not_found');
    });
  });
});

describe('policyRulesRepo.deprecate', () => {
  it('active → deprecated works', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.activate({ id: p.id, approved_by: 'admin' });
      const res = await policyRulesRepo.deprecate({
        id: p.id,
        deprecated_by: 'admin',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.updated.status).toBe('deprecated');
      expect(res.updated.deprecated_at).not.toBeNull();
    });
  });

  it('proposed → deprecated rejected as invalid_transition', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      const res = await policyRulesRepo.deprecate({
        id: p.id,
        deprecated_by: 'admin',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('invalid_transition');
    });
  });

  it('deprecating frees the descriptor slot for a new active row', async () => {
    await runWithTenantContext(ctx(), async () => {
      const a = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.activate({ id: a.id, approved_by: 'admin' });
      await policyRulesRepo.deprecate({ id: a.id, deprecated_by: 'admin' });
      const b = await policyRulesRepo.propose(baseProposeInput());
      const res = await policyRulesRepo.activate({
        id: b.id,
        approved_by: 'admin',
      });
      expect(res.ok).toBe(true);
    });
  });
});

describe('policyRulesRepo.rollback', () => {
  it('proposed → rolled_back works', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      const res = await policyRulesRepo.rollback({
        id: p.id,
        rolled_back_by: 'admin',
        rollback_reason: 'cancel proposal',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.updated.status).toBe('rolled_back');
      expect(res.updated.rollback_reason).toBe('cancel proposal');
    });
  });

  it('active → rolled_back works', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.activate({ id: p.id, approved_by: 'admin' });
      const res = await policyRulesRepo.rollback({
        id: p.id,
        rolled_back_by: 'admin',
        rollback_reason: 'incident',
      });
      expect(res.ok).toBe(true);
    });
  });

  it('rolled_back → anything rejected as terminal', async () => {
    await runWithTenantContext(ctx(), async () => {
      const p = await policyRulesRepo.propose(baseProposeInput());
      await policyRulesRepo.rollback({
        id: p.id,
        rolled_back_by: 'admin',
        rollback_reason: 'first',
      });
      const res = await policyRulesRepo.rollback({
        id: p.id,
        rolled_back_by: 'admin',
        rollback_reason: 'second',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('terminal');
    });
  });
});

describe('policyRulesRepo.findActiveByDescriptor', () => {
  it('returns agent-specific row before tenant-wide for same descriptor', async () => {
    await runWithTenantContext(ctx(), async () => {
      // Tenant-wide rule
      const wide = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'overlap' }),
      );
      await policyRulesRepo.activate({ id: wide.id, approved_by: 'admin' });
      // Agent-specific rule for the same descriptor
      const specific = await policyRulesRepo.propose(
        baseProposeInput({
          rule_descriptor: 'overlap',
          agent_id: 'agent-1',
        }),
      );
      await policyRulesRepo.activate({
        id: specific.id,
        approved_by: 'admin',
      });

      const a = await policyRulesRepo.findActiveByDescriptor({
        descriptor: 'overlap',
        agent_id: 'agent-1',
      });
      expect(a?.id).toBe(specific.id);

      const t = await policyRulesRepo.findActiveByDescriptor({
        descriptor: 'overlap',
        agent_id: null,
      });
      expect(t?.id).toBe(wide.id);
    });
  });

  it('falls back to tenant-wide when no agent-specific rule', async () => {
    await runWithTenantContext(ctx(), async () => {
      const wide = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'wide_only' }),
      );
      await policyRulesRepo.activate({ id: wide.id, approved_by: 'admin' });
      const found = await policyRulesRepo.findActiveByDescriptor({
        descriptor: 'wide_only',
        agent_id: 'agent-2',
      });
      expect(found?.id).toBe(wide.id);
    });
  });

  it('returns null when no active row exists for descriptor', async () => {
    await runWithTenantContext(ctx(), async () => {
      const r = await policyRulesRepo.findActiveByDescriptor({
        descriptor: 'never_existed',
      });
      expect(r).toBeNull();
    });
  });
});

describe('policyRulesRepo tenant isolation', () => {
  it('tenant A cannot see active policies of tenant B', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-a', agent_id: 'default' }, async () => {
      const p = await policyRulesRepo.propose(
        baseProposeInput({ rule_descriptor: 'a_only' }),
      );
      await policyRulesRepo.activate({ id: p.id, approved_by: 'admin' });
    });
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'default' }, async () => {
      const r = await policyRulesRepo.findActiveByDescriptor({
        descriptor: 'a_only',
      });
      expect(r).toBeNull();
      const all = await policyRulesRepo.listActiveForTenant();
      expect(all.find((row) => row.rule_descriptor === 'a_only')).toBeUndefined();
    });
  });
});

describe('isValidDualApprovalEvidence (Codex #93)', () => {
  const valid = {
    approvers: ['owner', 'compliance'],
    approved_at: ['2026-05-01T10:00:00.000Z', '2026-05-01T10:05:00.000Z'],
  };

  it('accepts the canonical shape (2 distinct approvers, parallel timestamps)', () => {
    expect(isValidDualApprovalEvidence(valid)).toBe(true);
  });

  it('accepts MORE than 2 distinct approvers', () => {
    expect(
      isValidDualApprovalEvidence({
        approvers: ['a', 'b', 'c'],
        approved_at: [
          '2026-05-01T10:00:00.000Z',
          '2026-05-01T10:05:00.000Z',
          '2026-05-01T10:10:00.000Z',
        ],
      }),
    ).toBe(true);
  });

  it('rejects undefined / null / non-object', () => {
    expect(isValidDualApprovalEvidence(undefined)).toBe(false);
    expect(isValidDualApprovalEvidence(null)).toBe(false);
    expect(isValidDualApprovalEvidence('hello')).toBe(false);
    expect(isValidDualApprovalEvidence(42)).toBe(false);
  });

  it('rejects empty object (the original loophole)', () => {
    expect(isValidDualApprovalEvidence({})).toBe(false);
  });

  it('rejects fewer than 2 approvers', () => {
    expect(
      isValidDualApprovalEvidence({ approvers: [], approved_at: [] }),
    ).toBe(false);
    expect(
      isValidDualApprovalEvidence({
        approvers: ['solo'],
        approved_at: ['2026-05-01T10:00:00.000Z'],
      }),
    ).toBe(false);
  });

  it('rejects non-distinct approvers', () => {
    expect(
      isValidDualApprovalEvidence({
        approvers: ['same', 'same'],
        approved_at: ['2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z'],
      }),
    ).toBe(false);
  });

  it('rejects empty-string approver', () => {
    expect(
      isValidDualApprovalEvidence({
        approvers: ['', 'bob'],
        approved_at: ['2026-05-01T10:00:00.000Z', '2026-05-01T10:05:00.000Z'],
      }),
    ).toBe(false);
  });

  it('rejects approvers/approved_at length mismatch', () => {
    expect(
      isValidDualApprovalEvidence({
        approvers: ['alice', 'bob'],
        approved_at: ['2026-05-01T10:00:00.000Z'],
      }),
    ).toBe(false);
  });

  it('rejects unparseable timestamps', () => {
    expect(
      isValidDualApprovalEvidence({
        approvers: ['alice', 'bob'],
        approved_at: ['not-a-date', '2026-05-01T10:05:00.000Z'],
      }),
    ).toBe(false);
  });
});
