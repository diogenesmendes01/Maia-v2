/**
 * Issue #415 — STATIC contract test for the boleto proposta attendant role +
 * skills seed (migration 079). DB-free: parses the migration SQL and asserts the
 * acceptance criteria are encoded, so a future edit that drops a pack, a tool, a
 * policy descriptor, or hardcodes confirmation fails here without needing
 * Postgres. The end-to-end seed-on-real-DB behaviour is covered by
 * tests/integration/boleto-proposta-role-seed-real-db.spec.ts (Docker-gated).
 *
 * Canonical spec: docs/architecture/concerns/capability-taxonomy.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SkillUsagePolicySchema } from '@/skills/usage-policy.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../migrations/079_boleto_proposta_attendant_role_and_skills.sql', import.meta.url)),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  fileURLToPath(new URL('../../../migrations/079_boleto_proposta_attendant_role_and_skills_down.sql', import.meta.url)),
  'utf8',
);

const ROLE_KEY = 'whatsapp_boleto_proposta_attendant';
const DISPLAY_NAME = 'Atendente de Boleto Proposta - WhatsApp';

const SKILL_KEYS = [
  'identify_company_customer',
  'inspect_customer_billing_context',
  'cancel_proposal_billing',
  'refund_intake',
  'refund_followup',
  'analyze_customer_documents',
  'answer_boleto_proposal_questions',
  'evaluate_escalation_need',
] as const;

// #416 names referenced BY STRING (the name contract).
const TOOL_PACKS = [
  'boleto_proposal_read_pack',
  'boleto_proposal_write_pack',
  'refund_intake_pack',
  'refund_followup_pack',
  'document_analysis_pack',
  'risk_escalation_pack',
] as const;

const POLICY_DESCRIPTORS = [
  'confirm_before_write_policy',
  'small_risk_write_policy',
  'human_confirmation_policy',
] as const;

const TOOL_NAMES = [
  'company_identity_resolver',
  'company_search',
  'company_history_lookup',
  'company_blacklist_check',
  'boleto_search',
  'boleto_cancel',
  'dda_lookup',
  'payment_verification',
  'campaign_status_lookup',
  'company_campaign_remove',
  'conversation_attachment_lookup',
  'receipt_validate',
  'bank_account_validate',
  'refund_create',
  'refund_lookup',
  'conversation_summary_generate',
  'legal_intent_detect',
  'case_risk_classify',
  'operational_ticket_create',
] as const;

/**
 * The skills INSERT ... SELECT ... FROM (VALUES ...) block. We anchor tuple
 * extraction to this region so a descriptor that ALSO appears in the role
 * metadata's `role_specific_skills` array (earlier in the file) is not matched
 * by mistake.
 */
const VALUES_BLOCK = (() => {
  const insertIdx = MIGRATION.indexOf('INSERT INTO skills');
  const valuesIdx = MIGRATION.indexOf('FROM (VALUES', insertIdx);
  const asVIdx = MIGRATION.indexOf(') AS v(', valuesIdx);
  expect(insertIdx).toBeGreaterThan(-1);
  expect(valuesIdx).toBeGreaterThan(insertIdx);
  expect(asVIdx).toBeGreaterThan(valuesIdx);
  return MIGRATION.slice(valuesIdx, asVIdx);
})();

/**
 * Extract the parenthesised tuple for a given skill_descriptor from the VALUES
 * block (between its `'descriptor',` and the next `\n  ),` / end-of-block). Good
 * enough for asserting which tool names / policy descriptors appear inside a
 * skill's tuple, since each tuple ends with the two text[] array literals
 * (allowed_tools, policy_descriptors).
 */
function skillTuple(descriptor: string): string {
  const start = VALUES_BLOCK.indexOf(`'${descriptor}',`);
  expect(start, `tuple for ${descriptor} present in VALUES block`).toBeGreaterThan(-1);
  const rest = VALUES_BLOCK.slice(start);
  const end = rest.search(/\n {2}\),|\n {2}\)\s*$/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

/**
 * The two trailing text[] array literals of a skill tuple, in order:
 * [allowed_tools, policy_descriptors]. Each is the content BETWEEN `'{` and
 * `}'`. Returns the comma-split, trimmed, non-empty members.
 */
function tupleArrayLiterals(descriptor: string): { allowed: string[]; policies: string[] } {
  const tuple = skillTuple(descriptor);
  const groups = (tuple.match(/'\{([^}]*)\}'/g) ?? []).map((g) =>
    g
      .replace(/^'\{/, '')
      .replace(/\}'$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // allowed_tools is the first {...}, policy_descriptors the second.
  return { allowed: groups[0] ?? [], policies: groups[1] ?? [] };
}

describe('Issue #415 — role seed (migration 079)', () => {
  it('represents the EXACT role key and display name', () => {
    expect(MIGRATION).toContain(`'${ROLE_KEY}'`);
    expect(MIGRATION).toContain(DISPLAY_NAME);
  });

  it('seeds the role into the roles catalog with INSERT ... ON CONFLICT DO NOTHING (idempotent)', () => {
    expect(MIGRATION).toMatch(/INSERT INTO roles\b/);
    expect(MIGRATION).toMatch(/ON CONFLICT \(tenant_id, agent_id, role_key\) DO NOTHING/);
  });

  it('role is NOT the default role (specialized, opt-in)', () => {
    // The role INSERT passes is_default = false (commented `is_default`).
    expect(MIGRATION).toMatch(/false,\s*--\s*is_default/);
  });

  it('grants all 6 boleto tool packs to the role (role → tool-pack axis)', () => {
    for (const pack of TOOL_PACKS) {
      expect(MIGRATION, `pack ${pack} granted`).toContain(`'${pack}'`);
    }
  });

  it('responsibility + operational objectives are present (Admin UI / runtime config)', () => {
    expect(MIGRATION.toLowerCase()).toContain('responsibility');
    expect(MIGRATION).toContain('operational_objectives');
    // The 6 operational objectives from the issue.
    expect(MIGRATION).toContain('Resolve the case on first contact whenever possible.');
    expect(MIGRATION).toContain('Identify the company correctly before operational actions.');
    expect(MIGRATION).toContain('Keep relevant actions auditable.');
  });

  it('models the role as INCREMENTAL over baseline (does NOT re-declare baseline skills)', () => {
    // The 8 role-specific skill descriptors must NOT include any baseline skill.
    const baseline = [
      'safe_conversation',
      'ask_clarification',
      'request_confirmation',
      'handoff_to_owner',
      'remember_safe_fact',
      'retrieve_context',
      'explain_limitation',
      'audit_decision',
    ];
    for (const b of baseline) {
      expect(SKILL_KEYS as readonly string[]).not.toContain(b);
    }
    // The metadata documents the incremental-over-baseline contract.
    expect(MIGRATION).toContain('incremental_over_baseline');
  });

  it('references the capability taxonomy doc', () => {
    expect(MIGRATION).toContain('docs/architecture/concerns/capability-taxonomy.md');
  });
});

describe('Issue #415 — 8 role-specific skills (migration 079)', () => {
  it('seeds exactly the 8 EXACT skill keys, scoped to the role via applicable_to_role', () => {
    for (const key of SKILL_KEYS) {
      expect(MIGRATION, `skill ${key} present`).toContain(`'${key}'`);
    }
    // The INSERT INTO skills writes applicable_to_role = ARRAY['<role>'].
    expect(MIGRATION).toMatch(/ARRAY\['whatsapp_boleto_proposta_attendant'\]::text\[\]/);
    // And the skills are tenant-wide system seeds (agent_id NULL, active, v1).
    expect(MIGRATION).toMatch(/INSERT INTO skills\b/);
    expect(MIGRATION).toContain("'active', 1, 'system'");
  });

  it('every skill tuple has the EXACT allowed_tools from the issue', () => {
    const expected: Record<(typeof SKILL_KEYS)[number], string[]> = {
      identify_company_customer: [
        'company_identity_resolver',
        'company_search',
        'company_history_lookup',
        'company_blacklist_check',
      ],
      inspect_customer_billing_context: [
        'boleto_search',
        'dda_lookup',
        'payment_verification',
        'campaign_status_lookup',
        'company_history_lookup',
      ],
      cancel_proposal_billing: ['boleto_cancel', 'company_campaign_remove'],
      refund_intake: [
        'payment_verification',
        'receipt_validate',
        'bank_account_validate',
        'refund_create',
        'conversation_attachment_lookup',
      ],
      refund_followup: [
        'refund_lookup',
        'conversation_attachment_lookup',
        'conversation_summary_generate',
      ],
      analyze_customer_documents: ['conversation_attachment_lookup', 'receipt_validate'],
      answer_boleto_proposal_questions: [], // usually no tools beyond loaded context
      evaluate_escalation_need: [
        'legal_intent_detect',
        'case_risk_classify',
        'operational_ticket_create',
        'conversation_summary_generate',
      ],
    };
    for (const key of SKILL_KEYS) {
      const { allowed } = tupleArrayLiterals(key);
      expect([...allowed].sort(), `${key} allowed_tools exact set`).toEqual(
        [...expected[key]].sort(),
      );
    }
  });

  it('all referenced tool names belong to the #416 name contract', () => {
    // Every tool name string in the migration's skill tuples is one of the 19
    // declared in the issue (no typo / drift).
    const known = new Set<string>(TOOL_NAMES);
    for (const key of SKILL_KEYS) {
      const { allowed } = tupleArrayLiterals(key);
      for (const n of allowed) {
        expect(known.has(n), `${key}: tool '${n}' is a known #416 tool name`).toBe(true);
      }
    }
  });
});

describe('Issue #415 — correctness rules (taxonomy §3, §6, §7)', () => {
  it('NO skill hardcodes confirmation / write authorization / human-approval rules', () => {
    // The skill tuples must not contain procedural confirmation logic. We assert
    // there is no `if (needsConfirmation)`-style branch and no requires_confirmation
    // literal inside the seed (confirmation is a policy decision, taxonomy §6).
    expect(MIGRATION).not.toMatch(/needsConfirmation/i);
    expect(MIGRATION).not.toMatch(/requires_confirmation\s*[:=]/i);
    // procedure is a placeholder ('{}'::jsonb) for every skill — no executable
    // authorization logic is embedded.
    expect(MIGRATION).toMatch(/'\{\}'::jsonb,\s*'\[\]'::jsonb,/); // procedure, constraints
  });

  it('cancel_proposal_billing delegates confirmation/authorization to policy descriptors', () => {
    const tuple = skillTuple('cancel_proposal_billing');
    expect(tuple).toContain('confirm_before_write_policy');
    expect(tuple).toContain('human_confirmation_policy');
    // It declares the write tools as INTENT/SCOPE only.
    expect(tuple).toContain('boleto_cancel');
    expect(tuple).toContain('company_campaign_remove');
  });

  it('refund_intake references write policy descriptors (intent + scope, not execution)', () => {
    const tuple = skillTuple('refund_intake');
    for (const d of POLICY_DESCRIPTORS) {
      expect(tuple, `refund_intake references ${d}`).toContain(d);
    }
    expect(tuple).toContain('refund_create');
  });

  it('refund is SPLIT into refund_intake (create) and refund_followup (status only)', () => {
    expect(SKILL_KEYS).toContain('refund_intake');
    expect(SKILL_KEYS).toContain('refund_followup');
    // intake can create; followup must NOT reference refund_create.
    expect(skillTuple('refund_intake')).toContain('refund_create');
    expect(skillTuple('refund_followup')).not.toContain('refund_create');
    expect(skillTuple('refund_followup')).toContain('refund_lookup');
  });

  it('company identification places company_identity_resolver BEFORE company_search', () => {
    const tuple = skillTuple('identify_company_customer');
    const resolverIdx = tuple.indexOf('company_identity_resolver');
    const searchIdx = tuple.indexOf('company_search');
    expect(resolverIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    // Informal resolver listed first in allowed_tools (ordering encodes the flow).
    expect(resolverIdx).toBeLessThan(searchIdx);
    // ...and the behaviour text states "informal antes da busca formal".
    expect(tuple).toMatch(/informal antes da busca formal/i);
  });

  it('non-write skills carry NO policy descriptors (only the write-intent skills do)', () => {
    const writeSkills = new Set<string>(['cancel_proposal_billing', 'refund_intake']);
    for (const key of SKILL_KEYS) {
      const { policies } = tupleArrayLiterals(key);
      if (writeSkills.has(key)) {
        expect(policies.length, `${key} should reference a write policy`).toBeGreaterThan(0);
      } else {
        expect(policies, `${key} should have empty policy_descriptors`).toEqual([]);
      }
    }
  });
});

describe('Issue #415 — migration shape', () => {
  it('adds the two NEW capability-taxonomy axis columns idempotently', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE roles\s+ADD COLUMN IF NOT EXISTS granted_packs TEXT\[\]/);
    expect(MIGRATION).toMatch(
      /ALTER TABLE skills\s+ADD COLUMN IF NOT EXISTS applicable_to_role TEXT\[\]/,
    );
  });

  it('down migration reverses the seed and drops both columns', () => {
    expect(MIGRATION_DOWN).toMatch(/DELETE FROM skills/);
    expect(MIGRATION_DOWN).toMatch(/DELETE FROM roles/);
    expect(MIGRATION_DOWN).toMatch(/DROP COLUMN IF EXISTS applicable_to_role/);
    expect(MIGRATION_DOWN).toMatch(/DROP COLUMN IF EXISTS granted_packs/);
    expect(MIGRATION_DOWN).toContain(ROLE_KEY);
  });
});

describe('Issue #415 — usage_policy admits the external WhatsApp audience (review #430)', () => {
  // Extract the `WHEN '<skill>' THEN '<json>'` arms of the usage_policy CASE.
  const policyBySkill = new Map<string, unknown>();
  for (const m of MIGRATION.matchAll(/WHEN '([a-z_]+)' THEN '(\{[^']*\})'/g)) {
    policyBySkill.set(m[1]!, JSON.parse(m[2]!));
  }

  it('seeds a usage_policy for every one of the 8 skills (not the conservative NULL default)', () => {
    for (const key of SKILL_KEYS) {
      expect(policyBySkill.has(key), `${key} must carry a seeded usage_policy`).toBe(true);
    }
  });

  it('every seeded usage_policy is a VALID SkillUsagePolicy (#409 schema)', () => {
    for (const key of SKILL_KEYS) {
      const parsed = SkillUsagePolicySchema.safeParse(policyBySkill.get(key));
      expect(
        parsed.success,
        `${key} usage_policy invalid: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }
  });

  it('every usage_policy ADMITS the external customer audience (the #430 fix)', () => {
    for (const key of SKILL_KEYS) {
      const p = policyBySkill.get(key) as { allowed_audience: string[] };
      expect(p.allowed_audience, `${key} must admit 'customer'`).toContain('customer');
    }
  });

  it('write-intent skills do NOT self-confirm (confirmation stays a policy decision)', () => {
    for (const key of SKILL_KEYS) {
      const p = policyBySkill.get(key) as { requires_confirmation: boolean };
      expect(p.requires_confirmation, `${key} usage_policy must not self-confirm`).toBe(false);
    }
  });
});
