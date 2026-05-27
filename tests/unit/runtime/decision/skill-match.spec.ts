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

  it('returns a partial ratio when only some intent tokens overlap', () => {
    const skill = mkSkill({
      id: 's_pay',
      when_to_use: 'Use to process a payment.',
    });
    // intent tokens {schedule, payment, reminder}; only "payment" overlaps.
    const score = scoreSkillMatch(skill, {
      label: 'schedule_payment_reminder',
      confidence: 0.8,
    });
    expect(score).toBeCloseTo(1 / 3, 5);
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
});
