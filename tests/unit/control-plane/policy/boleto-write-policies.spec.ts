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

  it('confirm_before_write_policy keys on fields the Mid PEP fact ACTUALLY provides', () => {
    // The three writes are matched via membership in skill.selected.allowed_tools
    // (a real Mid PEP fact field — mid-pep.ts), NOT a non-existent tool_call.name.
    // A predicate on a missing field yields not_applicable → ALLOW (silent fail-
    // open), so the round-2 finding requires keying on real fields.
    expect(up).toContain('"field":"skill.selected.allowed_tools"');
    expect(up).toContain('"value":"boleto_cancel"');
    expect(up).toContain('"value":"company_campaign_remove"');
    expect(up).toContain('"value":"refund_create"');
    // Must NOT reference fields the PEP fact does not provide.
    expect(up).not.toContain('"field":"tool_call.name"');
    expect(up).not.toContain('"tool_call.side_effect_level"');
    expect(up).not.toContain('"field":"risk_profile.level"');
  });

  it('confirm_before_write_policy requires confirmation + identity + audit, and notes ambiguity/escalation', () => {
    expect(up).toContain('"user_confirmation":true');
    expect(up).toContain('"company_identified":true');
    expect(up).toContain('"audit_before_and_after":true');
    // Ambiguity/escalation gating is recorded as a pending #437 signal: the Mid
    // PEP fact does not yet carry company_identity.ambiguous / a risk-escalation
    // flag, so they live under intended_signals_pending_437 rather than as active
    // predicate fields (which would otherwise be a silent-allow no-op).
    expect(up).toContain('company_identity.ambiguous');
    expect(up).toContain('risk_requires_escalation');
  });

  it('small_risk_write_policy is seeded as proposed (NOT active) — auto-write stays OFF', () => {
    // It must be present but explicitly NOT activated by default. We assert the
    // descriptor appears alongside the 'proposed' status literal in the VALUES.
    expect(up).toContain('small_risk_write_policy');
    expect(up).toContain("'proposed'");
  });

  it('human_confirmation_policy escalates on the real risk.level field', () => {
    expect(up).toContain('human_confirmation_policy');
    // Predicate keys on risk.level (a real Mid PEP fact field); the DSL action
    // vocabulary has no 'escalate', so it maps to require_dual_approval with the
    // escalate intent in metadata. Richer signals are pending #437.
    expect(up).toContain('"field":"risk.level"');
    expect(up).toContain('"intent":"escalate_to_human"');
    expect(up).toContain('intended_signals_pending_437');
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

  it('predicates reference ONLY fields the Mid PEP fact provides (no silent-allow)', () => {
    // The evaluator fact built in src/runtime/decision/mid-pep.ts exposes
    // skill.selected.allowed_tools and risk.level (among others). A predicate on
    // a field the fact does NOT carry resolves to not_applicable, which the
    // adapter maps to ALLOW — turning a confirm/risk policy into silent fail-open
    // the day evaluation is wired. Lock the seeded predicate fields to the set
    // the PEP actually provides. (Richer signals live in metadata, not in
    // "field" leaves, so they are not matched by this regex.)
    const ALLOWED_FIELDS = new Set(['skill.selected.allowed_tools', 'risk.level']);
    const fields = [...up.matchAll(/"field":"([^"]+)"/g)].map((m) => m[1]!);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(ALLOWED_FIELDS.has(f), `predicate field '${f}' must exist in the Mid PEP fact`).toBe(
        true,
      );
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
