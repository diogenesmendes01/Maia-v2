/**
 * Issue #415 — role → skill scope (`applicable_to_role`) in the SkillSelector.
 *
 * Capability-taxonomy §2 step 5: `skill candidates = selector(intent) ∩
 * applicable_to_role`. A skill that declares a non-empty `applicable_to_role` is
 * a candidate ONLY when the turn's active role is one of those keys; a skill
 * with an empty list is universal (applies regardless of role — baseline
 * behaviour). The filter can only ever REMOVE a candidate, never authorize one
 * (taxonomy §3 — execution is still policy + dispatcher).
 *
 * DB-free: drives `SkillSelectorImpl` with an in-memory `SkillsRepo` and the
 * pure `filterByApplicableRole` helper. The audit/logger are mocked because the
 * usage-policy filter (only active when an `audience` is supplied) audits; these
 * tests do not supply an audience, so they exercise role scope in isolation.
 */
import { describe, it, expect, vi } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  SkillSelectorImpl,
  filterByApplicableRole,
  type SkillSelectorDeps,
} from '@/runtime/decision/skill-selector.ts';
import type { SkillsRepo, Skill } from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

const ROLE = 'whatsapp_boleto_proposta_attendant';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 't1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  };
}

function mkDeps(skills: Skill[]): SkillSelectorDeps & { findActive: ReturnType<typeof vi.fn> } {
  const findActive = vi.fn().mockResolvedValue(skills);
  const skillsRepo: SkillsRepo = { findActive, find: vi.fn().mockResolvedValue(null) };
  return { skillsRepo, findActive };
}

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill => ({
  category: 'tool_mediated',
  priority: 1,
  status: 'active',
  ...overrides,
});

describe('Issue #415 — filterByApplicableRole (pure)', () => {
  const universal = mkSkill({ id: 'baseline', applicable_to_role: [] });
  const roleBound = mkSkill({ id: 'boleto', applicable_to_role: [ROLE] });
  const otherRole = mkSkill({ id: 'sales', applicable_to_role: ['sales_attendant'] });
  const noField = mkSkill({ id: 'legacy' }); // applicable_to_role undefined

  it('keeps universal (empty list) skills regardless of active role', () => {
    expect(filterByApplicableRole([universal, noField], ROLE).map((s) => s.id)).toEqual([
      'baseline',
      'legacy',
    ]);
    // ...and also when NO role is active.
    expect(filterByApplicableRole([universal, noField], undefined).map((s) => s.id)).toEqual([
      'baseline',
      'legacy',
    ]);
  });

  it('keeps a role-bound skill only when the active role matches', () => {
    expect(filterByApplicableRole([roleBound], ROLE).map((s) => s.id)).toEqual(['boleto']);
    expect(filterByApplicableRole([roleBound], 'sales_attendant')).toEqual([]);
  });

  it('removes role-bound skills when no role is active (fail-closed)', () => {
    expect(filterByApplicableRole([roleBound, otherRole], undefined)).toEqual([]);
  });

  it('mixed set: keeps universal + matching-role, drops other-role', () => {
    const out = filterByApplicableRole([universal, roleBound, otherRole, noField], ROLE).map(
      (s) => s.id,
    );
    expect(out).toEqual(['baseline', 'boleto', 'legacy']);
  });
});

describe('Issue #415 — SkillSelector honours active_role_key', () => {
  it('passes active_role_key into the repo query (applicable_to_role)', async () => {
    const deps = mkDeps([]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase(),
      { label: 'cancelar_boleto', confidence: 0.9 },
      { active_role_key: ROLE },
    );
    expect(deps.findActive).toHaveBeenCalledWith(
      expect.objectContaining({ applicable_to_role: ROLE }),
      expect.anything(),
    );
  });

  it('does not select a role-bound skill on the wrong role even on a clear intent match', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'cancel_proposal_billing',
        applicable_to_role: [ROLE],
        applicable_to_intent: ['cancelar_boleto'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'cancelar_boleto', confidence: 0.95 },
      { active_role_key: 'sales_attendant' }, // different role
    );
    // Out of scope for this role → empty selection (routes to free-form respond).
    expect(r.candidate_skill_ids).toEqual([]);
    expect(r.selected_skill_id).toBeUndefined();
  });

  it('selects a role-bound skill when the active role matches and the intent matches', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'cancel_proposal_billing',
        applicable_to_role: [ROLE],
        applicable_to_intent: ['cancelar_boleto'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'cancelar_boleto', confidence: 0.95 },
      { active_role_key: ROLE },
    );
    expect(r.candidate_skill_ids).toContain('cancel_proposal_billing');
    expect(r.selected_skill_id).toBe('cancel_proposal_billing');
  });

  it('universal skills remain selectable regardless of active role (no regression)', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'safe_conversation',
        category: 'compose',
        applicable_to_role: [],
        applicable_to_intent: ['saudacao'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'saudacao', confidence: 0.9 },
      { active_role_key: ROLE },
    );
    expect(r.candidate_skill_ids).toContain('safe_conversation');
    expect(r.selected_skill_id).toBe('safe_conversation');
  });

  it('with no active_role_key, role-bound skills are excluded but universal ones pass (legacy callers)', async () => {
    const deps = mkDeps([
      mkSkill({ id: 'boleto', applicable_to_role: [ROLE], applicable_to_intent: ['x'] }),
      mkSkill({ id: 'universal', applicable_to_role: [], applicable_to_intent: ['x'] }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), { label: 'x', confidence: 0.9 });
    expect(r.candidate_skill_ids).toEqual(['universal']);
  });
});
