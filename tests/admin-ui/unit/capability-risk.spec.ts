/**
 * P8.5 — Capability risk derivation (post Codex review #101).
 *
 * Verifies that capability proposals are classified by spec content rather
 * than hardcoded to 'medium'. Destructive/side-effect specs must escalate
 * to dual-approval-eligible risk levels, and unknown shapes fail closed.
 */
import { describe, it, expect } from 'vitest';
import { deriveCapabilityRisk, deriveCapabilityLocks } from '@/db/capability-risk.js';
import { getApprovalClassFor, requiresDualApproval } from '@/admin-ui/lib/approval-matrix.js';

describe('deriveCapabilityRisk', () => {
  // round-2 fix: self-declared risk is an ESCALATION HINT only.
  // proposed_spec.risk cannot lower the computed severity (max-only).
  it('self-declared risk cannot lower type-floor (tool floor=critical)', () => {
    // A tool self-declaring risk:'low' must still resolve to 'critical' (type floor).
    expect(deriveCapabilityRisk('tool', { risk: 'low' })).toBe('critical');
    // A tool self-declaring risk:'medium' must still resolve to 'critical'.
    expect(deriveCapabilityRisk('tool', { risk: 'medium' })).toBe('critical');
    // Self-declaring 'critical' is fine (same as floor).
    expect(deriveCapabilityRisk('tool', { risk: 'critical' })).toBe('critical');
  });

  it('self-declared risk can escalate above marker-derived risk', () => {
    // A knowledge type with read_only would normally be 'low', but self-declaring
    // 'high' escalates it (max-only: higher wins).
    expect(deriveCapabilityRisk('knowledge', { read_only: true, risk: 'high' })).toBe('high');
    // A procedure (floor=medium) self-declaring 'critical' escalates.
    expect(deriveCapabilityRisk('procedure', { risk: 'critical' })).toBe('critical');
    // Self-declaring 'low' for procedure (floor=medium) → still 'medium'.
    expect(deriveCapabilityRisk('procedure', { risk: 'low' })).toBe('medium');
  });

  it('destructive markers force critical', () => {
    expect(deriveCapabilityRisk('tool', { destructive: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { irreversible: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { sends_money: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { deletes_data: true })).toBe('critical');
    expect(deriveCapabilityRisk('integration', { sends_message_external: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { mass_writes: true })).toBe('critical');
  });

  it('side-effect markers escalate to high, capped at type-floor (round-2)', () => {
    // tool/integration floor=critical dominates: maxRisk(high,critical)=critical.
    expect(deriveCapabilityRisk('tool', { has_side_effects: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { mutates_state: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { writes_data: true })).toBe('critical');
    expect(deriveCapabilityRisk('integration', { external_post: true })).toBe('critical');
    // procedure floor=medium: maxRisk(high,medium)=high.
    expect(deriveCapabilityRisk('procedure', { has_side_effects: true })).toBe('high');
    // knowledge floor=low: maxRisk(high,low)=high.
    expect(deriveCapabilityRisk('knowledge', { mutates_state: true })).toBe('high');
  });

  it('read-only knowledge is low; read-only tool/integration are critical (type-floor wins)', () => {
    expect(deriveCapabilityRisk('knowledge', { read_only: true })).toBe('low');
    // procedure floor=medium: maxRisk(medium,medium)=medium.
    expect(deriveCapabilityRisk('procedure', { idempotent: true })).toBe('medium');
    // tool/integration floor=critical: maxRisk(medium,critical)=critical.
    expect(deriveCapabilityRisk('tool', { idempotent: true })).toBe('critical');
    expect(deriveCapabilityRisk('integration', { safe_read: true })).toBe('critical');
  });

  it('costly-read markers capped at type-floor (round-2)', () => {
    // tool floor=critical: maxRisk(medium,critical)=critical.
    expect(deriveCapabilityRisk('tool', { paid_api: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { high_cost: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { large_scan: true })).toBe('critical');
    // procedure floor=medium: maxRisk(medium,medium)=medium.
    expect(deriveCapabilityRisk('procedure', { paid_api: true })).toBe('medium');
    // knowledge floor=low: maxRisk(medium,low)=medium.
    expect(deriveCapabilityRisk('knowledge', { paid_api: true })).toBe('medium');
  });

  it('FAIL CLOSED: unknown capability_type + no markers → critical', () => {
    expect(deriveCapabilityRisk(null, {})).toBe('critical');
    expect(deriveCapabilityRisk(undefined, null)).toBe('critical');
    expect(deriveCapabilityRisk('made_up_type', {})).toBe('critical');
    expect(deriveCapabilityRisk('tool', null)).toBe('critical');
    expect(deriveCapabilityRisk('integration', undefined)).toBe('critical');
  });

  it('FAIL CLOSED: known type but empty spec → type floor', () => {
    expect(deriveCapabilityRisk('knowledge', {})).toBe('low');
    expect(deriveCapabilityRisk('procedure', {})).toBe('medium');
    expect(deriveCapabilityRisk('tool', {})).toBe('critical');
    expect(deriveCapabilityRisk('integration', {})).toBe('critical');
    expect(deriveCapabilityRisk('other', {})).toBe('critical');
  });

  it('type-floor dominates: read_only tool stays critical (round-2 fix)', () => {
    // round-2: self-declared or marker-inferred 'medium' cannot lower the
    // type-floor for tool (critical). read_only narrows the read-marker hint
    // to medium, but maxRisk(medium, critical) = critical.
    expect(deriveCapabilityRisk('tool', { read_only: true })).toBe('critical');
    // integration shares the same floor.
    expect(deriveCapabilityRisk('integration', { safe_read: true })).toBe('critical');
    // knowledge read_only → 'low' (floor is low, read_only hint = low → max = low).
    expect(deriveCapabilityRisk('knowledge', { read_only: true })).toBe('low');
    // procedure read_only → medium (floor is medium, hint = medium → max = medium).
    expect(deriveCapabilityRisk('procedure', { read_only: true })).toBe('medium');
  });

  it('destructive overrides everything else', () => {
    expect(
      deriveCapabilityRisk('knowledge', { read_only: true, destructive: true }),
    ).toBe('critical');
  });

  it('coerces stringy/numeric truthy values', () => {
    expect(deriveCapabilityRisk('tool', { destructive: 'true' })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { destructive: 1 })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { destructive: '1' })).toBe('critical');
    // Falsy markers don't escalate.
    expect(deriveCapabilityRisk('knowledge', { destructive: false })).toBe('low');
  });
});

describe('deriveCapabilityLocks', () => {
  it('destructive marker engages tool_blast_radius', () => {
    expect(deriveCapabilityLocks('tool', { destructive: true })).toContain('tool_blast_radius');
  });

  it('sends_message_external engages external_egress', () => {
    expect(deriveCapabilityLocks('integration', { sends_message_external: true })).toContain(
      'external_egress',
    );
  });

  it('sends_money engages financial_movement AND tool_blast_radius', () => {
    const locks = deriveCapabilityLocks('tool', { sends_money: true });
    expect(locks).toContain('financial_movement');
    expect(locks).toContain('tool_blast_radius');
  });

  it('integration without read_only engages external_egress', () => {
    expect(deriveCapabilityLocks('integration', {})).toContain('external_egress');
    expect(deriveCapabilityLocks('integration', { read_only: true })).not.toContain(
      'external_egress',
    );
  });

  it('explicit architecture_locks merge into the result', () => {
    const locks = deriveCapabilityLocks('tool', {
      architecture_locks: ['precedence_pyramid', 'soul_immutable_core'],
    });
    expect(locks).toContain('precedence_pyramid');
    expect(locks).toContain('soul_immutable_core');
  });

  it('safe knowledge proposal has no locks', () => {
    expect(deriveCapabilityLocks('knowledge', { read_only: true })).toEqual([]);
  });
});

describe('risk → approval matrix integration (Codex #101 — no destructive single-approval)', () => {
  it('destructive capability lands on capability_dangerous_tool (dual approval)', () => {
    const risk = deriveCapabilityRisk('tool', { destructive: true });
    const cls = getApprovalClassFor('capability_proposal', risk);
    expect(cls).toBe('capability_dangerous_tool');
    expect(requiresDualApproval(cls)).toBe(true);
  });

  it('side-effect tool lands on capability_dangerous_tool (type-floor critical, round-2)', () => {
    // tool + side-effect → maxRisk(high, critical) = critical → dangerous_tool.
    const risk = deriveCapabilityRisk('tool', { has_side_effects: true });
    expect(risk).toBe('critical');
    const cls = getApprovalClassFor('capability_proposal', risk);
    expect(cls).toBe('capability_dangerous_tool');
    expect(requiresDualApproval(cls)).toBe(true);
  });

  it('side-effect procedure lands on capability_side_effect (procedure floor=medium)', () => {
    // procedure + side-effect → maxRisk(high, medium) = high → capability_side_effect.
    const risk = deriveCapabilityRisk('procedure', { has_side_effects: true });
    expect(risk).toBe('high');
    const cls = getApprovalClassFor('capability_proposal', risk);
    expect(cls).toBe('capability_side_effect');
    expect(requiresDualApproval(cls)).toBe(true);
  });

  it('REGRESSION — unknown spec must NOT slip into capability_safe_tool', () => {
    const risk = deriveCapabilityRisk(null, null);
    const cls = getApprovalClassFor('capability_proposal', risk);
    expect(cls).not.toBe('capability_safe_tool');
    expect(requiresDualApproval(cls)).toBe(true);
  });

  it('only proved-safe capabilities land on capability_safe_tool', () => {
    const safeRisk = deriveCapabilityRisk('knowledge', { read_only: true });
    expect(getApprovalClassFor('capability_proposal', safeRisk)).toBe('capability_safe_tool');
  });
});
