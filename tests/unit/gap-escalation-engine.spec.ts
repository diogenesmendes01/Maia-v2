/**
 * P5 Task 6 — gap escalation engine tests (determinístico, sem LLM).
 *
 * Cobre a cadeia silent -> dashboard -> mentionable -> proposed, cobrindo todas
 * as transições e bloqueios (combined/contexts/cooldown). Não há mocks de
 * repositórios: o engine é uma função pura e os testes constroem entradas
 * sintéticas via helpers locais.
 */
import { describe, it, expect } from 'vitest';
import { decideEscalation } from '@/cognition/gap-escalation/engine.js';
import { DEFAULT_RULES } from '@/cognition/gap-escalation/types.js';
import { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap, GapEscalationRule } from '@/db/schema.js';

function makeGap(overrides: Partial<AgentCapabilityGap> = {}): AgentCapabilityGap {
  const now = new Date();
  return {
    id: 'gap-1',
    tenant_id: 'default',
    agent_id: 'default',
    capability_description: 'test gap',
    tipo: 'tool',
    contexto: null,
    frequency_score: 1,
    severity_score: 1,
    current_level: GapLevel.SILENT,
    source_candidate_id: null,
    last_observed: now,
    last_level_change_at: now,
    created_at: now,
    ...overrides,
  } as AgentCapabilityGap;
}

function makeRules(overrides: Partial<GapEscalationRule> = {}): GapEscalationRule {
  const now = new Date();
  return {
    id: 'r-1',
    tenant_id: 'default',
    agent_id: 'default',
    ...DEFAULT_RULES,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as GapEscalationRule;
}

describe('gap escalation engine (determinístico)', () => {
  it('silent + freq<threshold → no change', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.SILENT, frequency_score: 2, severity_score: 1 }),
      rules: makeRules(),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(false);
    expect(out.current_level).toBe(GapLevel.SILENT);
    expect(out.new_level).toBe(GapLevel.SILENT);
    expect(out.reason).toMatch(/freq 2 < 3/);
  });

  it('silent + freq=threshold → dashboard', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.SILENT, frequency_score: 3, severity_score: 1 }),
      rules: makeRules(),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(true);
    expect(out.current_level).toBe(GapLevel.SILENT);
    expect(out.new_level).toBe(GapLevel.DASHBOARD);
    expect(out.reason).toMatch(/freq 3 >= 3/);
  });

  it('silent + freq>threshold → dashboard', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.SILENT, frequency_score: 10, severity_score: 1 }),
      rules: makeRules(),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(true);
    expect(out.new_level).toBe(GapLevel.DASHBOARD);
    expect(out.reason).toMatch(/freq 10 >= 3/);
  });

  it('dashboard + severity<threshold → no change', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.DASHBOARD, frequency_score: 5, severity_score: 4 }),
      rules: makeRules(),
      distinct_contexts_count: 3,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(false);
    expect(out.current_level).toBe(GapLevel.DASHBOARD);
    expect(out.new_level).toBe(GapLevel.DASHBOARD);
    expect(out.reason).toMatch(/severity 4 < 5/);
  });

  it('dashboard + severity>=threshold → mentionable', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.DASHBOARD, frequency_score: 5, severity_score: 5 }),
      rules: makeRules(),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(true);
    expect(out.current_level).toBe(GapLevel.DASHBOARD);
    expect(out.new_level).toBe(GapLevel.MENTIONABLE);
    expect(out.reason).toMatch(/severity 5 >= 5/);
  });

  it('mentionable + combined<threshold → no change (reason mentions combined)', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 3,
        severity_score: 4,
      }),
      rules: makeRules(),
      distinct_contexts_count: 5,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(false);
    expect(out.new_level).toBe(GapLevel.MENTIONABLE);
    expect(out.reason).toMatch(/combined 7 < 8/);
  });

  it('mentionable + combined>=threshold + contexts<min → no change (reason mentions contexts)', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
      }),
      rules: makeRules(),
      distinct_contexts_count: 1,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(false);
    expect(out.new_level).toBe(GapLevel.MENTIONABLE);
    expect(out.reason).toMatch(/distinct_contexts 1 < 2/);
  });

  it('mentionable + combined>=threshold + contexts>=min + cooldown not met → no change (reason mentions cooldown)', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
      }),
      rules: makeRules(),
      distinct_contexts_count: 3,
      days_since_last_proposed_in_tenant: 5,
    });
    expect(out.changed).toBe(false);
    expect(out.new_level).toBe(GapLevel.MENTIONABLE);
    expect(out.reason).toMatch(/cooldown 5d < 14d/);
  });

  it('mentionable + combined>=threshold + contexts>=min + never proposed → proposed', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
      }),
      rules: makeRules(),
      distinct_contexts_count: 2,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(true);
    expect(out.current_level).toBe(GapLevel.MENTIONABLE);
    expect(out.new_level).toBe(GapLevel.PROPOSED);
    expect(out.reason).toMatch(/all conditions met/);
    expect(out.reason).toMatch(/combined=9/);
    expect(out.reason).toMatch(/contexts=2/);
  });

  it('mentionable + all conditions met after cooldown → proposed', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 5,
        severity_score: 5,
      }),
      rules: makeRules(),
      distinct_contexts_count: 4,
      days_since_last_proposed_in_tenant: 14,
    });
    expect(out.changed).toBe(true);
    expect(out.new_level).toBe(GapLevel.PROPOSED);
    expect(out.reason).toMatch(/all conditions met/);
    expect(out.reason).toMatch(/combined=10/);
    expect(out.reason).toMatch(/contexts=4/);
  });

  it('proposed → no change (terminal for this engine)', () => {
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.PROPOSED,
        frequency_score: 100,
        severity_score: 100,
      }),
      rules: makeRules(),
      distinct_contexts_count: 50,
      days_since_last_proposed_in_tenant: 365,
    });
    expect(out.changed).toBe(false);
    expect(out.current_level).toBe(GapLevel.PROPOSED);
    expect(out.new_level).toBe(GapLevel.PROPOSED);
    expect(out.reason).toBe('already_at_proposed_terminal_for_this_engine');
  });

  it('custom rules: tenant overrides freq_threshold to 5; gap with freq=4 stays silent', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.SILENT, frequency_score: 4, severity_score: 1 }),
      rules: makeRules({ dashboard_freq_threshold: 5 }),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(false);
    expect(out.new_level).toBe(GapLevel.SILENT);
    expect(out.reason).toMatch(/freq 4 < 5/);
  });

  it('custom rules: tenant overrides freq_threshold to 5; gap with freq=5 escalates', () => {
    const out = decideEscalation({
      gap: makeGap({ current_level: GapLevel.SILENT, frequency_score: 5, severity_score: 1 }),
      rules: makeRules({ dashboard_freq_threshold: 5 }),
      distinct_contexts_count: 0,
      days_since_last_proposed_in_tenant: null,
    });
    expect(out.changed).toBe(true);
    expect(out.new_level).toBe(GapLevel.DASHBOARD);
    expect(out.reason).toMatch(/freq 5 >= 5/);
  });

  it('mentionable + cooldown exactly at threshold → proposed (>= boundary)', () => {
    // cooldown check usa < (strictly less): igualar threshold deve liberar
    const out = decideEscalation({
      gap: makeGap({
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 4,
      }),
      rules: makeRules(),
      distinct_contexts_count: 2,
      days_since_last_proposed_in_tenant: 14,
    });
    expect(out.changed).toBe(true);
    expect(out.new_level).toBe(GapLevel.PROPOSED);
  });
});
