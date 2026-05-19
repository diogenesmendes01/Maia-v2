import { describe, it, expect } from 'vitest';
import { PepAudit } from '@/runtime/decision/pep-audit.ts';
import type {
  BlockDecision,
  RequireDualApprovalDecision,
} from '@/runtime/decision/types.js';

describe('P9b — PepAudit', () => {
  it('starts empty', () => {
    const audit = new PepAudit();
    expect(audit.size()).toBe(0);
    expect(audit.toArray()).toEqual([]);
  });

  it('records a single entry', () => {
    const audit = new PepAudit();
    audit.record('early', 'p_1', 'd_1', 'block', 'reason');
    expect(audit.size()).toBe(1);
    expect(audit.toArray()[0]).toEqual({
      pep: 'early',
      policy_id: 'p_1',
      rule_descriptor: 'd_1',
      decision: 'block',
      reason: 'reason',
    });
  });

  it('records from BlockDecision', () => {
    const audit = new PepAudit();
    const block: BlockDecision = {
      pep: 'mid',
      policy_id: 'p_block',
      rule_descriptor: 'transfer.skill_restricted',
      decision: 'block',
      reason: 'denied',
      severity: 'high',
    };
    audit.recordFromBlock(block);
    expect(audit.toArray()[0]?.decision).toBe('block');
    expect(audit.toArray()[0]?.policy_id).toBe('p_block');
  });

  it('records from RequireDualApprovalDecision', () => {
    const audit = new PepAudit();
    const dual: RequireDualApprovalDecision = {
      pep: 'mid',
      policy_id: 'p_dual',
      rule_descriptor: 'transfer.dual',
      decision: 'require_dual_approval',
      reason: 'big',
      approval_class: 'owner_plus_compliance',
    };
    audit.recordFromDualApproval(dual);
    expect(audit.toArray()[0]?.decision).toBe('require_dual_approval');
  });

  it('records all warnings from ContinueDecision', () => {
    const audit = new PepAudit();
    audit.recordWarnings('early', [
      { policy_id: 'p1', rule_descriptor: 'd1', reason: 'r1' },
      { policy_id: 'p2', rule_descriptor: 'd2', reason: 'r2' },
    ]);
    expect(audit.size()).toBe(2);
    expect(audit.toArray()[0]?.decision).toBe('warn');
    expect(audit.toArray()[1]?.policy_id).toBe('p2');
  });

  it('appends late entries via recordLate', () => {
    const audit = new PepAudit();
    audit.record('early', 'p1', 'd1', 'warn', 'r1');
    audit.recordLate([
      {
        pep: 'late',
        policy_id: 'p_redact',
        rule_descriptor: 'output.redaction',
        decision: 'block',
        reason: 'PII detected',
      },
    ]);
    expect(audit.size()).toBe(2);
    expect(audit.toArray()[1]?.pep).toBe('late');
  });

  it('toArray returns a defensive copy', () => {
    const audit = new PepAudit();
    audit.record('early', 'p1', 'd1', 'warn', 'r1');
    const a = audit.toArray();
    a.push({ pep: 'mid', policy_id: 'x', rule_descriptor: 'y', decision: 'allow', reason: 'z' });
    expect(audit.size()).toBe(1);
  });

  it('preserves insertion order across multiple PEPs', () => {
    const audit = new PepAudit();
    audit.record('early', 'pe', 'de', 'warn', 'r');
    audit.record('mid', 'pm', 'dm', 'block', 'r');
    audit.record('late', 'pl', 'dl', 'allow', 'r');
    const peps = audit.toArray().map((e) => e.pep);
    expect(peps).toEqual(['early', 'mid', 'late']);
  });
});
