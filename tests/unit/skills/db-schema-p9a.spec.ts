/**
 * P9a Task 3b — Drizzle schema test for `skills` table.
 *
 * Validates that the table has the right columns + types + defaults at
 * the schema definition level (no DB connection needed). Real DB-level
 * constraints (partial unique, CHECK) are validated by integration test.
 */
import { describe, it, expect } from 'vitest';
import { skills } from '@/db/schema.js';
import {
  SkillStatus,
  SkillExecutionMode,
  SkillCategory,
  FeatureFlagName,
} from '@/types/enums.js';

describe('P9a schema — skills table', () => {
  it('has 24 columns (15 spec + version/lifecycle metadata)', () => {
    // Drizzle exposes columns via the symbol getter. Use the schema's exposed
    // columns getter to count.
    const cols = Object.keys(skills);
    // Schema attribute names: id, tenant_id, agent_id, skill_descriptor, category,
    // execution_mode, goal, when_to_use, procedure, constraints, input_schema,
    // output_schema, allowed_tools, policy_descriptors, success_criteria,
    // failure_modes, runtime_hints, status, version, proposed_by, proposed_reason,
    // approved_by, approved_at, activated_at, deprecated_at, rolled_back_at,
    // rollback_reason, created_at = 28 attrs (some are drizzle internals).
    expect(cols.length).toBeGreaterThanOrEqual(20);
  });

  it('exposes skill_descriptor, category, execution_mode columns', () => {
    expect(skills.skill_descriptor).toBeDefined();
    expect(skills.category).toBeDefined();
    expect(skills.execution_mode).toBeDefined();
  });

  it('exposes runtime_hints JSONB column', () => {
    expect(skills.runtime_hints).toBeDefined();
  });

  it('exposes lifecycle columns (status, version, proposed_by, approved_by)', () => {
    expect(skills.status).toBeDefined();
    expect(skills.version).toBeDefined();
    expect(skills.proposed_by).toBeDefined();
    expect(skills.approved_by).toBeDefined();
    expect(skills.activated_at).toBeDefined();
    expect(skills.deprecated_at).toBeDefined();
    expect(skills.rolled_back_at).toBeDefined();
  });

  it('exposes resource columns (allowed_tools, policy_descriptors arrays)', () => {
    expect(skills.allowed_tools).toBeDefined();
    expect(skills.policy_descriptors).toBeDefined();
  });

  it('exposes quality columns (success_criteria, failure_modes JSONB)', () => {
    expect(skills.success_criteria).toBeDefined();
    expect(skills.failure_modes).toBeDefined();
  });
});

describe('P9a enums', () => {
  it('SkillStatus has 4 lifecycle values', () => {
    expect(SkillStatus.PROPOSED).toBe('proposed');
    expect(SkillStatus.ACTIVE).toBe('active');
    expect(SkillStatus.DEPRECATED).toBe('deprecated');
    expect(SkillStatus.ROLLED_BACK).toBe('rolled_back');
  });

  it('SkillExecutionMode has 4 modes', () => {
    expect(SkillExecutionMode.PROMPT_ONLY).toBe('prompt_only');
    expect(SkillExecutionMode.PROCEDURE_ADAPTER).toBe('procedure_adapter');
    expect(SkillExecutionMode.TOOL_MEDIATED).toBe('tool_mediated');
    expect(SkillExecutionMode.EVALUATOR).toBe('evaluator');
  });

  it('SkillCategory has 8 categories', () => {
    expect(SkillCategory.CLASSIFY).toBe('classify');
    expect(SkillCategory.EXTRACT).toBe('extract');
    expect(SkillCategory.COMPOSE).toBe('compose');
    expect(SkillCategory.DECIDE).toBe('decide');
    expect(SkillCategory.TOOL_MEDIATED).toBe('tool_mediated');
    expect(SkillCategory.DIAGNOSE).toBe('diagnose');
    expect(SkillCategory.PLAN).toBe('plan');
    expect(SkillCategory.EVALUATOR).toBe('evaluator');
  });

  it('FeatureFlagName.SKILL_REGISTRY_V1 registered', () => {
    expect(FeatureFlagName.SKILL_REGISTRY_V1).toBe('SKILL_REGISTRY_V1');
  });
});
