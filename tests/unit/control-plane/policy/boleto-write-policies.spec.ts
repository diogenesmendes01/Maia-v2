/**
 * Issue #416 — boleto proposal vertical: write/risk policy descriptors.
 *
 * Asserts the three descriptor constants + the governed-tools constant, AND that
 * the migration 078 seed is correct:
 *   - `confirm_before_write_policy` governs EXACTLY boleto_cancel /
 *     company_campaign_remove / refund_create (acceptance criterion).
 *   - the three descriptors are seeded as policy_rules rows (the existing
 *     policy-descriptor pattern), idempotently, with the correct active/proposed
 *     posture (#416 does NOT enable automatic low-risk writes).
 *   - confirmation lives in POLICY, not in a skill body (we assert the seed
 *     carries the require_confirmation effect; the tools themselves declare no
 *     confirmation branch — covered by the tool specs).
 *
 * The migration-SQL assertions mirror tests/unit/migration-042-drift-type-enum.spec.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UP = join(process.cwd(), 'migrations', '078_boleto_write_risk_policies.sql');
const DOWN = join(process.cwd(), 'migrations', '078_boleto_write_risk_policies_down.sql');

describe('boleto write/risk policy descriptors — constants (issue #416)', () => {
  it('exports the three EXACT descriptor names', async () => {
    const mod = await import('../../../../src/control-plane/policy/boleto-write-policies.js');
    expect(mod.CONFIRM_BEFORE_WRITE_POLICY).toBe('confirm_before_write_policy');
    expect(mod.SMALL_RISK_WRITE_POLICY).toBe('small_risk_write_policy');
    expect(mod.HUMAN_CONFIRMATION_POLICY).toBe('human_confirmation_policy');
    expect([...mod.BOLETO_WRITE_RISK_POLICY_DESCRIPTORS]).toEqual([
      'confirm_before_write_policy',
      'small_risk_write_policy',
      'human_confirmation_policy',
    ]);
  });

  it('confirm_before_write_policy governs EXACTLY the three write tools', async () => {
    const mod = await import('../../../../src/control-plane/policy/boleto-write-policies.js');
    expect([...mod.CONFIRM_BEFORE_WRITE_GOVERNED_TOOLS].sort()).toEqual(
      ['boleto_cancel', 'company_campaign_remove', 'refund_create'].sort(),
    );
  });
});

describe('migration 078 — write/risk policy seed (issue #416)', () => {
  let up: string;
  let down: string;

  beforeAll(() => {
    up = readFileSync(UP, 'utf-8');
    down = readFileSync(DOWN, 'utf-8');
  });

  it('the SQL files exist and are non-empty', () => {
    expect(up.length).toBeGreaterThan(0);
    expect(down.length).toBeGreaterThan(0);
  });

  it('seeds into policy_rules (the existing policy-descriptor table)', () => {
    expect(up).toContain('INSERT INTO policy_rules');
  });

  it('seeds all three descriptors', () => {
    for (const d of [
      'confirm_before_write_policy',
      'small_risk_write_policy',
      'human_confirmation_policy',
    ]) {
      expect(up, `seed must define ${d}`).toContain(`'${d}'`);
    }
  });

  it('confirm_before_write_policy predicate targets EXACTLY the three write tools', () => {
    // The seed predicate matches tool_call.name in [the three writes].
    expect(up).toContain('"boleto_cancel","company_campaign_remove","refund_create"');
    // ...via a kind-tagged DSL leaf on tool_call.name. It must NOT key on a
    // `side_effect_level` literal (that field's domain is none|low|medium|high,
    // so "write" there would never evaluate).
    expect(up).toContain('"field":"tool_call.name"');
    expect(up).not.toContain('"tool_call.side_effect_level"');
  });

  it('confirm_before_write_policy requires confirmation + identity + audit, and blocks ambiguity', () => {
    expect(up).toContain('"user_confirmation":true');
    expect(up).toContain('"company_identified":true');
    expect(up).toContain('"audit_before_and_after":true');
    expect(up).toContain('"identity_ambiguous":true');
    expect(up).toContain('"risk_requires_escalation":true');
  });

  it('small_risk_write_policy is seeded as proposed (NOT active) — auto-write stays OFF', () => {
    // It must be present but explicitly NOT activated by default. We assert the
    // descriptor appears alongside the 'proposed' status literal in the VALUES.
    expect(up).toContain('small_risk_write_policy');
    expect(up).toContain("'proposed'");
  });

  it('human_confirmation_policy escalates on risk/legal/dispute signals', () => {
    expect(up).toContain('human_confirmation_policy');
    expect(up).toContain('"legal_intent.detected"');
    // The DSL action vocabulary has no 'escalate'; escalation maps to the
    // human-approval gate and the escalate intent lives in metadata.
    expect(up).toContain('"intent":"escalate_to_human"');
  });

  it('seed is idempotent (NOT EXISTS guard per descriptor)', () => {
    expect(up).toContain('WHERE NOT EXISTS');
    expect(up).toContain('pr.rule_descriptor = v.rule_descriptor');
  });

  it('each seeded rule_body is a DSL-shaped PolicyRuleBody (kind-tagged predicate + valid DSL action)', () => {
    // The rows must be parseable by the P9b DSL the day runtime evaluation is
    // wired (no data migration needed). Extract the single-quoted rule_body JSON
    // literals (they start with {"rule_id") and assert the DSL shape.
    const VALID_ACTIONS = new Set(['allow', 'block', 'require_dual_approval', 'warn', 'log']);
    const VALID_KINDS = new Set(['leaf', 'and', 'or', 'not']);
    const bodies = [...up.matchAll(/'(\{"rule_id":[^']*)'/g)].map(
      (m) =>
        JSON.parse(m[1]!) as {
          rule_id: string;
          predicate: { kind: string };
          effect: { action: string };
        },
    );
    expect(bodies.length).toBe(3);
    for (const body of bodies) {
      expect(
        VALID_KINDS.has(body.predicate?.kind),
        `${body.rule_id} predicate.kind=${body.predicate?.kind}`,
      ).toBe(true);
      expect(
        VALID_ACTIONS.has(body.effect?.action),
        `${body.rule_id} effect.action=${body.effect?.action}`,
      ).toBe(true);
    }
  });

  it('down migration removes ONLY the seeded bootstrap rows (proposed_by guard)', () => {
    expect(down).toContain('DELETE FROM policy_rules');
    expect(down).toContain("proposed_by = 'issue_416_seed'");
    for (const d of [
      'confirm_before_write_policy',
      'small_risk_write_policy',
      'human_confirmation_policy',
    ]) {
      expect(down).toContain(`'${d}'`);
    }
  });
});
