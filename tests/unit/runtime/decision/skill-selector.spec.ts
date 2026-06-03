import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #409 — the candidate filter audits each admit/remove decision. Mock the
// audit writer so we can assert the reasons without a DB. (Existing anti-hijack
// tests never supply an `audience`, so they never trigger the filter / audit.)
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  SkillSelectorImpl,
  type SkillSelectorDeps,
} from '@/runtime/decision/skill-selector.ts';
import { SKILL_MATCH_THRESHOLD } from '@/runtime/decision/skill-match.ts';
import type {
  SkillsRepo,
  Skill,
  SkillSelectorAudience,
} from '@/runtime/decision/types.js';
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';
import {
  allowedDataScopesForAudience,
  type SkillUsagePolicy,
} from '@/skills/usage-policy.js';

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

function mkDeps(skills: Skill[]): SkillSelectorDeps {
  const skillsRepo: SkillsRepo = {
    findActive: vi.fn().mockResolvedValue(skills),
    find: vi.fn().mockResolvedValue(null),
  };
  return { skillsRepo };
}

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill => ({
  category: 'respond',
  priority: 1,
  status: 'active',
  ...overrides,
});

describe('P9b — SkillSelector', () => {
  it('returns empty when no skills found', async () => {
    const deps = mkDeps([]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'unknown',
      confidence: 0.2,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual([]);
  });

  it('selects top matching skill ranked by (category match × priority)', async () => {
    // All three declare the intent; selection then prefers the best
    // category×priority among the matches.
    const deps = mkDeps([
      mkSkill({
        id: 's_low',
        category: 'respond',
        priority: 1,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_high',
        category: 'respond',
        priority: 5,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_tool',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['balance_query'],
      }),
      // tool_mediated × 1 = 10; respond × 2 = 10 — tie broken by stable sort
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.candidate_skill_ids).toContain('s_high');
    expect(r.candidate_skill_ids).toContain('s_tool');
    expect(r.selected_skill_id).toBeDefined();
  });

  it('limits candidate_skill_ids to top 5', async () => {
    const skills: Skill[] = Array.from({ length: 8 }, (_, i) =>
      mkSkill({
        id: `s${i}`,
        category: 'respond',
        priority: 10 - i,
        applicable_to_intent: ['balance_query'],
      }),
    );
    const deps = mkDeps(skills);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.candidate_skill_ids).toHaveLength(5);
    expect(r.selected_skill_id).toBe('s0'); // highest priority among matches
  });

  it('passes intent label and workflow_id to repo query', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase(),
      { label: 'transfer_intent', confidence: 0.8 },
      { workflow_id: 'wf_123' },
    );
    // Round-2 finding 4: findActive now accepts a second arg for AbortSignal
    // propagation, so match the first arg precisely and tolerate the rest.
    expect(deps.skillsRepo.findActive).toHaveBeenCalledWith(
      {
        tenant_id: 'tn1',
        agent_id: 'ag1',
        applicable_to_intent: 'transfer_intent',
        applicable_to_workflow: 'wf_123',
      },
      expect.any(Object),
    );
  });

  it('Codex #103 — uses agent_id_override when provided (routed agent ≠ base agent)', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase({ agent_id: 'base_agent_X' }),
      { label: 'transfer_intent', confidence: 0.8 },
      { agent_id_override: 'routed_agent_Y' },
    );
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call?.agent_id).toBe('routed_agent_Y');
    expect(call?.agent_id).not.toBe('base_agent_X');
  });

  it('Codex #103 — falls back to base.agent_id when no override given', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(
      mkBase({ agent_id: 'base_only' }),
      { label: 'greet', confidence: 0.95 },
    );
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call?.agent_id).toBe('base_only');
  });

  it('omits workflow_id from query when undefined', async () => {
    const deps = mkDeps([mkSkill({ id: 's_x' })]);
    const selector = new SkillSelectorImpl(deps);
    await selector.select(mkBase(), { label: 'greet', confidence: 0.95 });
    const call = (deps.skillsRepo.findActive as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    expect(call).toEqual({
      tenant_id: 'tn1',
      agent_id: 'ag1',
      applicable_to_intent: 'greet',
    });
  });

  it('ranks respond category higher than other categories at equal priority', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_decide',
        category: 'decide',
        priority: 3,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_respond',
        category: 'respond',
        priority: 3,
        applicable_to_intent: ['balance_query'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_respond');
  });

  // ---------------------------------------------------------------------------
  // F1 Phase 0 — anti-hijack intent matching
  // ---------------------------------------------------------------------------

  it('F1 Phase 0 — returns EMPTY selection when an active skill does NOT match the message', async () => {
    // The anti-hijack guard: an active billing skill must NOT be selected for
    // an unrelated greeting. Candidates are still listed, but nothing is
    // committed, so ActionDecider routes the turn to a normal `respond`.
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['billing_question', 'cancel_subscription'],
        when_to_use: 'When the customer asks about invoices or billing charges.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'greet',
      confidence: 0.95,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.selected_skill).toBeUndefined();
    // Candidate list still reflects what was in scope.
    expect(r.candidate_skill_ids).toEqual(['s_billing']);
  });

  it('F1 Phase 0 — selects a skill whose applicable_to_intent matches exactly', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['billing_question'],
        when_to_use: 'When the customer asks about invoices.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'billing_question',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBe('s_billing');
    expect(r.selected_skill?.id).toBe('s_billing');
  });

  it('F1 Phase 0 — selects a skill whose when_to_use clearly overlaps the intent tokens', async () => {
    // No applicable_to_intent declared; selection relies on token overlap with
    // when_to_use. intent tokens {transfer, money} both appear → ratio 1.0.
    const deps = mkDeps([
      mkSkill({
        id: 's_transfer',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to transfer money between accounts.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'transfer_money',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBe('s_transfer');
  });

  it('F1 Phase 0 — does NOT select on a single weak token overlap below threshold', async () => {
    // intent tokens {schedule, payment, reminder}; only "payment" overlaps →
    // ratio 1/3 ≈ 0.33 < threshold (0.5). Ambiguous ⇒ no selection.
    const deps = mkDeps([
      mkSkill({
        id: 's_pay',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to process a payment immediately.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'schedule_payment_reminder',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBeUndefined();
  });

  it('Codex #217 item 2 — anti-hijack holds at the SELECTOR level for the 1-of-2 boundary', async () => {
    // The canonical hijack case proven end-to-end through SkillSelector (not
    // just scoreSkillMatch): a 2-token intent `cancel_order` sharing exactly ONE
    // token (`cancel`) with a `cancel_subscription` skill scores a damped 0.25,
    // so NO selection is committed while the candidate stays visible.
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['billing_question', 'cancel_subscription'],
        when_to_use: 'When the customer asks to cancel their subscription.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'cancel_order',
      confidence: 0.9,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.selected_skill).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual(['s_billing']);
  });

  it('Issue #219 — the 2-of-4 boundary (ratio exactly 0.5) does NOT select under strict `>`', async () => {
    // Inverted from the previous pin. Owner decision (issue #219): with the
    // selector hardened to `bestScore > SKILL_MATCH_THRESHOLD`, an intent with
    // four meaningful tokens that shares exactly two with the skill scores 2/4
    // = 0.5 and lands EXACTLY on the threshold — no longer commits a selection.
    // The candidate stays visible; ActionDecider falls back to free-form respond.
    const deps = mkDeps([
      mkSkill({
        id: 's_transfer',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to transfer money.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'transfer_money_international_urgent',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.selected_skill).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual(['s_transfer']);
  });

  it('Issue #219 — a score JUST ABOVE the threshold (3-of-5 = 0.6) STILL selects', async () => {
    // Positive boundary: strictness only rejects EXACT ties. A 3-of-5 overlap
    // = 0.6, which is strictly greater than 0.5, must still commit a selection
    // so the hardening does not break legitimately strong partial matches.
    const deps = mkDeps([
      mkSkill({
        id: 's_transfer',
        category: 'tool_mediated',
        priority: 5,
        when_to_use: 'Use to transfer money urgent.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      // 5 meaningful tokens: transfer, money, urgent, international, business.
      // 3 covered (transfer, money, urgent) → 3/5 = 0.6 > 0.5.
      label: 'transfer_money_urgent_international_business',
      confidence: 0.8,
    });
    expect(r.selected_skill_id).toBe('s_transfer');
  });

  it('Issue #219 — SINGLE_TOKEN_DAMPING regression: 1-of-2 still rejects', async () => {
    // Regression guard for the original BLOCKER 1 path: a 2-token intent that
    // shares exactly ONE token gets the single-token damping (0.5 * 0.5 = 0.25),
    // landing well below the threshold. Hardening the selector to strict `>` must
    // not weaken this case.
    const deps = mkDeps([
      mkSkill({
        id: 's_billing',
        category: 'tool_mediated',
        priority: 10,
        applicable_to_intent: ['billing_question', 'cancel_subscription'],
        when_to_use: 'When the customer asks to cancel their subscription.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'cancel_order',
      confidence: 0.9,
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.selected_skill).toBeUndefined();
  });

  it('F1 Phase 0 — picks the BEST match, not the highest-ranked irrelevant skill', async () => {
    // High-priority skill is irrelevant to the turn; a lower-priority skill
    // matches. The matcher must win over raw category×priority ranking.
    const deps = mkDeps([
      mkSkill({
        id: 's_irrelevant_high',
        category: 'respond',
        priority: 100,
        applicable_to_intent: ['complaint'],
        when_to_use: 'When the user files a complaint.',
      }),
      mkSkill({
        id: 's_relevant_low',
        category: 'tool_mediated',
        priority: 1,
        applicable_to_intent: ['balance_query'],
        when_to_use: 'When the user asks for their balance.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_relevant_low');
  });

  it('F1 Phase 0 — never selects when intent label is unknown, even with active skills', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_any',
        category: 'respond',
        priority: 10,
        applicable_to_intent: ['greet'],
        when_to_use: 'A generic responder.',
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'unknown',
      confidence: 0.9, // even high confidence on an unknown label must not select
    });
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual(['s_any']);
  });

  it('F1 Phase 0 — exposes a sane match threshold constant', () => {
    expect(SKILL_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(SKILL_MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // CORRECTNESS 3 (Codex PR #215 review): selected_skill_id ∈ candidate_skill_ids
  // ---------------------------------------------------------------------------

  it('CORRECTNESS 3 — selected_skill_id is always present in candidate_skill_ids', async () => {
    // Six irrelevant HIGH-priority skills fill the top-5 candidate slice; the
    // ONLY skill that matches the intent has the LOWEST priority, so it ranks
    // outside the top-5 by category×priority. The invariant requires the
    // committed selection to still appear in the (bounded) candidate list.
    const skills: Skill[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        mkSkill({
          id: `irrelevant_${i}`,
          category: 'respond',
          priority: 100 - i, // all high; fill the top of the ranking
          applicable_to_intent: ['complaint'],
          when_to_use: 'When the user files a complaint.',
        }),
      ),
      mkSkill({
        id: 's_match_low',
        category: 'tool_mediated',
        priority: 1, // lowest → ranks last
        applicable_to_intent: ['balance_query'],
        when_to_use: 'When the user asks for their account balance.',
      }),
    ];
    const deps = mkDeps(skills);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });

    expect(r.selected_skill_id).toBe('s_match_low');
    // The invariant: the selection must be in the candidate set...
    expect(r.candidate_skill_ids).toContain('s_match_low');
    // ...and the candidate set must stay bounded at MAX_CANDIDATES (5).
    expect(r.candidate_skill_ids.length).toBeLessThanOrEqual(5);
  });

  it('CORRECTNESS 3 — does not duplicate the selected id when it is already a top candidate', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_top',
        category: 'respond',
        priority: 10,
        applicable_to_intent: ['balance_query'],
      }),
      mkSkill({
        id: 's_other',
        category: 'respond',
        priority: 1,
        applicable_to_intent: ['something_else'],
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'balance_query',
      confidence: 0.85,
    });
    expect(r.selected_skill_id).toBe('s_top');
    expect(
      r.candidate_skill_ids.filter((id) => id === 's_top'),
    ).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #409 — usage-policy candidate filter (audience/channel/data_scope)
  // ---------------------------------------------------------------------------

  const DAILY_BUSINESS_SUMMARY: SkillUsagePolicy = {
    allowed_audience: ['owner', 'manager'],
    blocked_audience: ['customer', 'lead', 'vendor'],
    data_scope: ['financial_summary', 'operations_summary'],
    exposure_policy: 'internal_only',
    requires_auth_level: 'trusted_internal',
    requires_confirmation: false,
  };

  const ownerAudience: SkillSelectorAudience = {
    audience_type: 'owner',
    trust_level: 'trusted_internal',
    channel_type: 'whatsapp',
    allowed_data_scope: allowedDataScopesForAudience('owner', 'trusted_internal'),
  };
  const customerAudience: SkillSelectorAudience = {
    audience_type: 'customer',
    trust_level: 'known_external',
    channel_type: 'whatsapp',
    allowed_data_scope: allowedDataScopesForAudience('customer', 'known_external'),
  };

  beforeEach(() => auditMock.mockClear());

  it('#409 — daily_business_summary is SELECTED for owner', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'daily_business_summary',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        usage_policy: DAILY_BUSINESS_SUMMARY as unknown as Record<string, unknown>,
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'daily_summary', confidence: 0.9 },
      { audience: ownerAudience },
    );
    expect(r.selected_skill_id).toBe('daily_business_summary');
    expect(r.candidate_skill_ids).toEqual(['daily_business_summary']);
    // Audited as allowed.
    const allowed = auditMock.mock.calls.find((c) => c[0].acao === 'skill_allowed');
    expect(allowed).toBeTruthy();
    expect(allowed?.[0].metadata.skill_id).toBe('daily_business_summary');
  });

  it('#409 — daily_business_summary is BLOCKED for customer (removed + audited)', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'daily_business_summary',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        usage_policy: DAILY_BUSINESS_SUMMARY as unknown as Record<string, unknown>,
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'daily_summary', confidence: 0.9 },
      { audience: customerAudience },
    );
    // No safe skill → empty selection (fail-closed) → ActionDecider responds.
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual([]);
    const blocked = auditMock.mock.calls.find(
      (c) => c[0].acao === 'skill_blocked_by_audience',
    );
    expect(blocked).toBeTruthy();
    expect(blocked?.[0].metadata.skill_id).toBe('daily_business_summary');
    expect(blocked?.[0].metadata.audience_type).toBe('customer');
  });

  it('#409 — an unknown audience is blocked from a policy-less skill (conservative default)', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_no_policy',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        // No usage_policy → conservative internal-only default applies.
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const unknownAudience: SkillSelectorAudience = {
      audience_type: 'unknown',
      trust_level: 'unknown',
      channel_type: 'whatsapp',
      allowed_data_scope: allowedDataScopesForAudience('unknown', 'unknown'),
    };
    const r = await selector.select(
      mkBase(),
      { label: 'daily_summary', confidence: 0.9 },
      { audience: unknownAudience },
    );
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual([]);
    // Conservative default blocks an unknown audience (not in internal allow-list).
    expect(
      auditMock.mock.calls.some((c) => c[0].acao === 'skill_blocked_by_audience'),
    ).toBe(true);
  });

  it('#409 — an unauthorized channel removes the candidate (channel_blocked)', async () => {
    const channelScoped: SkillUsagePolicy = {
      allowed_audience: ['owner'],
      allowed_channels: ['whatsapp'],
      data_scope: ['internal_business_summary'],
      exposure_policy: 'internal_only',
      requires_auth_level: 'trusted_internal',
      requires_confirmation: false,
    };
    const deps = mkDeps([
      mkSkill({
        id: 's_channel',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        usage_policy: channelScoped as unknown as Record<string, unknown>,
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'daily_summary', confidence: 0.9 },
      {
        audience: {
          audience_type: 'owner',
          trust_level: 'trusted_internal',
          channel_type: 'web', // NOT whatsapp
          allowed_data_scope: allowedDataScopesForAudience('owner', 'trusted_internal'),
        },
      },
    );
    expect(r.selected_skill_id).toBeUndefined();
    expect(
      auditMock.mock.calls.some((c) => c[0].acao === 'skill_blocked_by_channel'),
    ).toBe(true);
  });

  it('#409 — keeps the SAFE candidate and drops the unsafe one for a customer', async () => {
    const customerSkill: SkillUsagePolicy = {
      allowed_audience: ['customer'],
      data_scope: ['own_customer_data_only'],
      exposure_policy: 'subject_only',
      requires_auth_level: 'known_external',
      requires_confirmation: false,
    };
    const deps = mkDeps([
      mkSkill({
        id: 'daily_business_summary',
        category: 'tool_mediated',
        priority: 100, // ranks first, but is blocked for customer
        applicable_to_intent: ['my_orders'],
        when_to_use: 'Show my recent orders and account status.',
        usage_policy: DAILY_BUSINESS_SUMMARY as unknown as Record<string, unknown>,
      }),
      mkSkill({
        id: 'my_account',
        category: 'tool_mediated',
        priority: 1,
        applicable_to_intent: ['my_orders'],
        when_to_use: 'Show my recent orders and account status.',
        usage_policy: customerSkill as unknown as Record<string, unknown>,
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'my_orders', confidence: 0.9 },
      { audience: customerAudience },
    );
    // The high-priority internal skill is removed; the safe customer skill wins.
    expect(r.candidate_skill_ids).toEqual(['my_account']);
    expect(r.selected_skill_id).toBe('my_account');
  });

  it('#409 — a MALFORMED usage_policy fails closed (skill removed)', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 's_malformed',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        usage_policy: { allowed_audience: [] }, // invalid (≥1 required)
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(
      mkBase(),
      { label: 'daily_summary', confidence: 0.9 },
      { audience: ownerAudience },
    );
    expect(r.selected_skill_id).toBeUndefined();
    expect(r.candidate_skill_ids).toEqual([]);
  });

  it('#409 — when NO audience is supplied the filter is skipped (legacy contract)', async () => {
    const deps = mkDeps([
      mkSkill({
        id: 'daily_business_summary',
        category: 'tool_mediated',
        priority: 5,
        applicable_to_intent: ['daily_summary'],
        when_to_use: 'When the owner asks how the business day went.',
        usage_policy: DAILY_BUSINESS_SUMMARY as unknown as Record<string, unknown>,
      }),
    ]);
    const selector = new SkillSelectorImpl(deps);
    const r = await selector.select(mkBase(), {
      label: 'daily_summary',
      confidence: 0.9,
    });
    // No audience → no early filter → selection proceeds (runner gate 4.6 is the
    // fail-closed backstop). No usage-policy audit emitted.
    expect(r.selected_skill_id).toBe('daily_business_summary');
    expect(
      auditMock.mock.calls.some((c) =>
        String(c[0].acao).startsWith('skill_'),
      ),
    ).toBe(false);
  });
});
