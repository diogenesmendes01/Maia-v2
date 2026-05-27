import { describe, it, expect } from 'vitest';
import {
  SKILL_MATCH_THRESHOLD,
  scoreSkillMatch,
} from '@/runtime/decision/skill-match.ts';
import type { Skill } from '@/runtime/decision/types.js';

const mkSkill = (overrides: Partial<Skill> & { id: string }): Skill => ({
  category: 'respond',
  priority: 1,
  status: 'active',
  ...overrides,
});

describe('F1 Phase 0 — scoreSkillMatch', () => {
  it('exposes a threshold strictly within (0, 1]', () => {
    expect(SKILL_MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(SKILL_MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('scores 1.0 on an exact applicable_to_intent membership (case-insensitive)', () => {
    const skill = mkSkill({
      id: 's',
      applicable_to_intent: ['Balance_Query', 'statement_query'],
    });
    expect(scoreSkillMatch(skill, { label: 'balance_query', confidence: 0.9 })).toBe(1);
  });

  it('scores 0 for a non-committal/unknown intent label even with active skill', () => {
    const skill = mkSkill({
      id: 's',
      applicable_to_intent: ['greet'],
      when_to_use: 'A general responder for greetings.',
    });
    expect(scoreSkillMatch(skill, { label: 'unknown', confidence: 0.99 })).toBe(0);
    expect(scoreSkillMatch(skill, { label: '', confidence: 0.99 })).toBe(0);
  });

  it('uses token-overlap ratio against when_to_use when no exact intent match', () => {
    const skill = mkSkill({
      id: 's_transfer',
      when_to_use: 'Use to transfer money between two accounts.',
    });
    // intent tokens {transfer, money} both present → ratio 1.0
    expect(
      scoreSkillMatch(skill, { label: 'transfer_money', confidence: 0.8 }),
    ).toBe(1);
  });

  it('damps a single-token partial overlap (anti-hijack) well below threshold', () => {
    const skill = mkSkill({
      id: 's_pay',
      when_to_use: 'Use to process a payment.',
    });
    // intent tokens {schedule, payment, reminder}; only "payment" overlaps →
    // raw ratio 1/3, then damped (×0.5) because exactly one token is covered
    // while the intent has more. BLOCKER 1: a lone shared token must not select.
    const score = scoreSkillMatch(skill, {
      label: 'schedule_payment_reminder',
      confidence: 0.8,
    });
    expect(score).toBeCloseTo((1 / 3) * 0.5, 5);
    expect(score).toBeLessThan(SKILL_MATCH_THRESHOLD);
  });

  it('threshold boundary — a 2/2 overlap clears, a 1/3 overlap does not', () => {
    const clears = mkSkill({
      id: 's_clears',
      when_to_use: 'transfer money',
    });
    const fails = mkSkill({
      id: 's_fails',
      when_to_use: 'process a payment now',
    });
    expect(
      scoreSkillMatch(clears, { label: 'transfer_money', confidence: 0.8 }),
    ).toBeGreaterThanOrEqual(SKILL_MATCH_THRESHOLD);
    expect(
      scoreSkillMatch(fails, {
        label: 'schedule_payment_reminder',
        confidence: 0.8,
      }),
    ).toBeLessThan(SKILL_MATCH_THRESHOLD);
  });

  it('ignores generic stopwords so a verbose when_to_use does not over-match', () => {
    const skill = mkSkill({
      id: 's',
      // Only stopwords overlap with the intent's meaningful tokens.
      when_to_use: 'Use this skill when the user asks about something.',
    });
    // intent token {refund} is meaningful and NOT present.
    expect(scoreSkillMatch(skill, { label: 'refund_request', confidence: 0.8 })).toBe(0);
  });

  it('matches against the skill id/descriptor token as a fallback signal', () => {
    const skill = mkSkill({ id: 'refund', when_to_use: '' });
    expect(scoreSkillMatch(skill, { label: 'refund', confidence: 0.8 })).toBe(1);
  });

  it('scores 0 when there is no overlap and no exact match', () => {
    const skill = mkSkill({
      id: 's_weather',
      applicable_to_intent: ['weather_lookup'],
      when_to_use: 'Use to fetch the weather forecast.',
    });
    expect(
      scoreSkillMatch(skill, { label: 'transfer_money', confidence: 0.9 }),
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // BLOCKER 1 (Codex PR #215 review): the exact 1-of-2-tokens boundary.
  // ---------------------------------------------------------------------------

  it('BLOCKER 1 — a 1-of-2 token overlap (raw ratio 0.5) does NOT clear the threshold', () => {
    // The canonical hijack case: a 2-token intent `cancel_order` shares exactly
    // ONE meaningful token (`cancel`) with a `cancel_subscription` skill. The
    // raw coverage ratio is 1/2 == 0.5 == SKILL_MATCH_THRESHOLD; un-damped this
    // would select and hijack the turn. Damping pushes it to 0.25 < threshold.
    const skill = mkSkill({
      id: 's_billing',
      applicable_to_intent: ['billing_question', 'cancel_subscription'],
      when_to_use: 'When the customer asks to cancel their subscription.',
    });
    const score = scoreSkillMatch(skill, {
      label: 'cancel_order',
      confidence: 0.9,
    });
    // Raw ratio would be exactly 0.5; damped single-token coverage is 0.25.
    expect(score).toBeCloseTo(0.25, 5);
    expect(score).toBeLessThan(SKILL_MATCH_THRESHOLD);
  });

  it('BLOCKER 1 — a clearly-matching 2-of-2 token overlap DOES clear the threshold', () => {
    // Contrast case: every meaningful intent token is covered → full coverage →
    // raw ratio 1.0, no damping, selects.
    const skill = mkSkill({
      id: 's_cancel',
      when_to_use: 'Use to cancel an order for the customer.',
    });
    const score = scoreSkillMatch(skill, {
      label: 'cancel_order',
      confidence: 0.9,
    });
    expect(score).toBe(1);
    expect(score).toBeGreaterThanOrEqual(SKILL_MATCH_THRESHOLD);
  });

  it('BLOCKER 1 — covering 2 of 3 tokens (no full coverage) still clears via the ≥2 rule', () => {
    // Two meaningful tokens covered out of three → ratio 2/3 ≈ 0.667, kept
    // (not damped) because ≥2 tokens are covered. This is a legitimately strong
    // partial match and SHOULD select.
    const skill = mkSkill({
      id: 's_transfer',
      when_to_use: 'Use to transfer money to another account.',
    });
    const score = scoreSkillMatch(skill, {
      label: 'transfer_money_now',
      confidence: 0.8,
    });
    expect(score).toBeCloseTo(2 / 3, 5);
    expect(score).toBeGreaterThanOrEqual(SKILL_MATCH_THRESHOLD);
  });

  // ---------------------------------------------------------------------------
  // ROBUSTNESS 5 (Codex PR #215 review): NFD diacritic-insensitive tokenizing.
  // ---------------------------------------------------------------------------

  it('ROBUSTNESS 5 — matches an unaccented intent against an accented when_to_use (pt-BR NFD)', () => {
    // The classified intent label is unaccented snake_case (`saudacao`); the
    // skill guidance is accented pt-BR (`saudação`). After NFD + diacritic
    // stripping both reduce to `saudacao`, so the single-token intent is fully
    // covered → ratio 1.0.
    const skill = mkSkill({
      id: 's_greet',
      when_to_use: 'Use para uma saudação calorosa ao cliente.',
    });
    expect(
      scoreSkillMatch(skill, { label: 'saudacao', confidence: 0.9 }),
    ).toBe(1);
  });
});
