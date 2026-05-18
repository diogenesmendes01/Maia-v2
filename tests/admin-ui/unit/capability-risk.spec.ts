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
  it('explicit risk in spec wins', () => {
    expect(deriveCapabilityRisk('tool', { risk: 'low' })).toBe('low');
    expect(deriveCapabilityRisk('tool', { risk: 'critical' })).toBe('critical');
  });

  it('destructive markers force critical', () => {
    expect(deriveCapabilityRisk('tool', { destructive: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { irreversible: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { sends_money: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { deletes_data: true })).toBe('critical');
    expect(deriveCapabilityRisk('integration', { sends_message_external: true })).toBe('critical');
    expect(deriveCapabilityRisk('tool', { mass_writes: true })).toBe('critical');
  });

  it('side-effect markers escalate to high', () => {
    expect(deriveCapabilityRisk('tool', { has_side_effects: true })).toBe('high');
    expect(deriveCapabilityRisk('tool', { mutates_state: true })).toBe('high');
    expect(deriveCapabilityRisk('tool', { writes_data: true })).toBe('high');
    expect(deriveCapabilityRisk('integration', { external_post: true })).toBe('high');
  });

  it('read-only knowledge is low; read-only tool is medium', () => {
    expect(deriveCapabilityRisk('knowledge', { read_only: true })).toBe('low');
    expect(deriveCapabilityRisk('tool', { idempotent: true })).toBe('medium');
    expect(deriveCapabilityRisk('integration', { safe_read: true })).toBe('medium');
  });

  it('costly-read markers are medium', () => {
    expect(deriveCapabilityRisk('tool', { paid_api: true })).toBe('medium');
    expect(deriveCapabilityRisk('tool', { high_cost: true })).toBe('medium');
    expect(deriveCapabilityRisk('tool', { large_scan: true })).toBe('medium');
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

  it('explicit safe spec downgrades a tool to medium, not below', () => {
    // Even if marked read_only, tool stays medium (not low) because tool's
    // type-floor is critical and read_only opens the floor only to medium.
    expect(deriveCapabilityRisk('tool', { read_only: true })).toBe('medium');
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

  it('side-effect capability lands on capability_side_effect (dual approval)', () => {
    const risk = deriveCapabilityRisk('tool', { has_side_effects: true });
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
