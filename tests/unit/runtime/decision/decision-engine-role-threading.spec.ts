/**
 * Issue #415/#416 — the Decision Engine threads the turn's active role key
 * (`base.active_role_key`) into the SkillSelector options
 * (`skillOptions.active_role_key`), so role-bound skills (`applicable_to_role`)
 * are candidates ONLY on a matching role.
 *
 * #430 implemented the SkillSelector role filter (`filterByApplicableRole`) and
 * the `active_role_key` option, but left the engine wiring as a marked TODO —
 * the BaseContextPacket did not yet carry the resolved role, so role-bound
 * skills were never candidates via the decision-engine path (fail-closed). This
 * is that wiring.
 *
 * Coverage:
 *  - End-to-end through a REAL SkillSelectorImpl + in-memory repo: a role-bound
 *    skill IS selected on a role match (a) and is NOT selected on mismatch or
 *    when no role is active (b).
 *  - A spy SkillSelector pinning the exact option the engine populates.
 *
 * DB-free. audit/logger are mocked because SkillSelectorImpl imports them; the
 * usage-policy filter that would call audit only runs when an `audience` is
 * supplied, and these turns supply none, so role scope is exercised in
 * isolation.
 */
import { describe, it, expect, vi } from 'vitest';

const { auditMock } = vi.hoisted(() => ({
  auditMock: vi.fn(async () => undefined),
}));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  DecisionEngine,
  type DecisionEngineDeps,
} from '@/runtime/decision/decision-engine.ts';
import { SkillSelectorImpl } from '@/runtime/decision/skill-selector.ts';
import type {
  ActionDecider,
  AgentSelector,
  EarlyPep,
  IntentClassifier,
  LockdownReader,
  MetricsClient,
  MidPep,
  PolicyDescriptorResolver,
  RiskScorer,
  Skill,
  SkillSelector,
  SkillsRepo,
  WorkflowSelector,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';

const ROLE = 'whatsapp_boleto_proposta_attendant';
const INTENT = 'cancelar_boleto';

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 'trace_role_1',
    tenant_id: 'tn1',
    agent_id: 'ag1',
    channel: { id: 'ch1', kind: 'whatsapp', is_locked_down: false },
    actor: { id: 'a1', is_authenticated: true },
    input: { content_ref: 'cref', received_at: new Date() },
    ...overrides,
  } as unknown as BaseContextPacket;
}

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill =>
  ({
    category: 'tool_mediated',
    priority: 1,
    status: 'active',
    ...overrides,
  }) as Skill;

/** A DecisionEngine wired with the REAL SkillSelectorImpl over an in-memory repo. */
function realSelector(skills: Skill[]): SkillSelector {
  const findActive = vi.fn().mockResolvedValue(skills);
  const skillsRepo = {
    findActive,
    find: vi.fn().mockResolvedValue(null),
  } as unknown as SkillsRepo;
  return new SkillSelectorImpl({ skillsRepo });
}

function mkDeps(overrides: Partial<DecisionEngineDeps> = {}): DecisionEngineDeps {
  const resolver: PolicyDescriptorResolver = {
    resolveDescriptors: vi.fn().mockResolvedValue([]),
  };
  const earlyPep: EarlyPep = {
    evaluate: vi.fn().mockResolvedValue({ pep: 'early', warnings: [] }),
  };
  const midPep: MidPep = {
    evaluate: vi.fn().mockResolvedValue({ pep: 'mid', warnings: [] }),
  };
  const intentClassifier: IntentClassifier = {
    classify: vi.fn().mockResolvedValue({ label: INTENT, confidence: 0.95 }),
  };
  const riskScorer: RiskScorer = {
    score: vi.fn().mockResolvedValue({
      level: 'low',
      reasons: [],
      requires_human_review: false,
    }),
  };
  const workflowSelector: WorkflowSelector = {
    select: vi.fn().mockResolvedValue({ mode: 'none' }),
  };
  const agentSelector: AgentSelector = {
    select: vi.fn().mockResolvedValue({ agent_id: 'ag1' }),
  };
  const skillSelector: SkillSelector = {
    select: vi.fn().mockResolvedValue({ candidate_skill_ids: [] }),
  };
  const actionDecider: ActionDecider = {
    decide: vi.fn().mockResolvedValue({
      action_mode: 'respond',
      tool_permissions: {
        allowed_tools: [],
        blocked_tools: [],
        requires_confirmation: [],
      },
      context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
      evaluation_plan: {
        validators: [],
        llm_judge_required: false,
        human_review_required: false,
      },
      rationale: 'respond',
    }),
  };
  const lockdownReader: LockdownReader = {
    isChannelLockedDown: vi.fn().mockResolvedValue(false),
    isTenantInGlobalLockdown: vi.fn().mockResolvedValue(false),
    tenantHasSensitiveContext: vi.fn().mockResolvedValue(false),
  };
  const metrics: MetricsClient = {
    increment: vi.fn(),
    recordHistogram: vi.fn(),
  };
  return {
    resolver,
    earlyPep,
    midPep,
    intentClassifier,
    riskScorer,
    workflowSelector,
    agentSelector,
    skillSelector,
    actionDecider,
    lockdownReader,
    metrics,
    clock: () => Date.now(),
    ...overrides,
  };
}

const roleBoundSkill = mkSkill({
  id: 'cancel_proposal_billing',
  applicable_to_role: [ROLE],
  applicable_to_intent: [INTENT],
});

describe('Issue #415/#416 — DecisionEngine threads active_role_key to the SkillSelector', () => {
  it('(a) selects a role-bound skill when base.active_role_key matches applicable_to_role', async () => {
    const deps = mkDeps({ skillSelector: realSelector([roleBoundSkill]) });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase({ active_role_key: ROLE }) });
    expect(r.packet.routing.selected_skill_id).toBe('cancel_proposal_billing');
    expect(r.packet.routing.candidate_skill_ids).toContain(
      'cancel_proposal_billing',
    );
  });

  it('(b) does NOT select a role-bound skill when base.active_role_key is a different role', async () => {
    const deps = mkDeps({ skillSelector: realSelector([roleBoundSkill]) });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({
      base: mkBase({ active_role_key: 'sales_attendant' }),
    });
    expect(r.packet.routing.selected_skill_id).toBeUndefined();
    expect(r.packet.routing.candidate_skill_ids).not.toContain(
      'cancel_proposal_billing',
    );
  });

  it('(b) does NOT select a role-bound skill when no role is active (fail-closed)', async () => {
    const deps = mkDeps({ skillSelector: realSelector([roleBoundSkill]) });
    const engine = new DecisionEngine(deps);
    const r = await engine.run({ base: mkBase() }); // no active_role_key
    expect(r.packet.routing.selected_skill_id).toBeUndefined();
    expect(r.packet.routing.candidate_skill_ids).not.toContain(
      'cancel_proposal_billing',
    );
  });

  it('passes base.active_role_key through to skillOptions.active_role_key (exact wiring)', async () => {
    const spy = vi.fn().mockResolvedValue({ candidate_skill_ids: [] });
    const deps = mkDeps({ skillSelector: { select: spy } });
    const engine = new DecisionEngine(deps);
    await engine.run({ base: mkBase({ active_role_key: ROLE }) });
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ active_role_key: ROLE });
  });

  it('omits active_role_key from skillOptions when no role is active', async () => {
    const spy = vi.fn().mockResolvedValue({ candidate_skill_ids: [] });
    const deps = mkDeps({ skillSelector: { select: spy } });
    const engine = new DecisionEngine(deps);
    await engine.run({ base: mkBase() });
    expect(spy.mock.calls[0]?.[2]?.active_role_key).toBeUndefined();
  });
});
