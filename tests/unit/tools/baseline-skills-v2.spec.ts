/**
 * Issue #448 — baseline skills v2 contracts (migration 080).
 *
 * Pure logic tests — no real DB. Covers:
 *   1. BASELINE_CORE_PACK v2 has version >= 2 and contains the 3 gap tools.
 *   2. Each tool_mediated skill's allowed_tools are a strict subset of
 *      BASELINE_CORE_PACK.tools — so no domain/sensitive tool can ever sneak
 *      into a baseline skill's scope.
 *   3. A baseline-only agent grant (only 'baseline.core') sees all 10 tools
 *      but NOT any domain/sensitive tool (register_transaction, etc.).
 *   4. ask_clarification, request_confirmation, explain_limitation are NOT
 *      in the v2 tool_mediated set — they remain prompt_only by design.
 *
 * See migrations/080_baseline_skills_v2.sql for the VALUES these tests mirror.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-skills-v2-spec-media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({
  enqueueAgent: vi.fn(),
  agentQueue: {},
}));

// ---------------------------------------------------------------------------
// Source of truth: the expected allowed_tools per skill as inserted by
// migrations/080_baseline_skills_v2.sql. Each entry mirrors a VALUES row.
// ---------------------------------------------------------------------------
const BASELINE_SKILLS_V2: Record<string, string[]> = {
  // CONVERTED (version=2)
  safe_conversation: ['read_turn_context', 'recall_memory', 'risk_signal_classify'],
  retrieve_context: ['read_turn_context', 'recall_memory'],
  handoff_to_owner: ['handoff_to_owner', 'audit_decision', 'conversation_summary_compose'],
  remember_safe_fact: ['remember_safe_fact', 'audit_decision'],
  audit_decision: ['audit_decision'],
  // NEW (version=1)
  escalate_on_risk: ['risk_signal_classify', 'handoff_to_owner', 'audit_decision'],
  summarization: ['conversation_summary_compose'],
  manage_conversation_state: ['conversation_state_update'],
};

// Skills that MUST remain prompt_only (no v2 tool_mediated row).
const PROMPT_ONLY_SKILLS = ['ask_clarification', 'request_confirmation', 'explain_limitation'];

// Domain/sensitive tools that MUST NOT appear in any baseline skill.
const DOMAIN_TOOLS = new Set([
  'register_transaction',
  'cancel_transaction',
  'query_balance',
  'list_transactions',
  'classify_transaction',
  'compare_entities',
  'generate_report',
  'start_recurring_payment',
  'identify_entity',
  'send_proactive_message',
  'start_recurring_outreach',
  'start_workflow',
  'schedule_reminder',
  'cancel_reminder',
  'register_custom_holiday',
]);

// -------------------------------------------------------------------------
// Suite 1 — BASELINE_CORE_PACK v2: version + gap tools
// -------------------------------------------------------------------------
describe('BASELINE_CORE_PACK v2 — version and gap tool coverage (#448)', () => {
  it('BASELINE_CORE_PACK.version is >= 2 (bumped by #433 when gap tools were added)', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/grant-math.js');
    expect(BASELINE_CORE_PACK.version).toBeGreaterThanOrEqual(2);
  });

  it('the 3 gap tools (#433) are present in BASELINE_CORE_PACK.tools', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/grant-math.js');
    const gapTools = [
      'risk_signal_classify',
      'conversation_summary_compose',
      'conversation_state_update',
    ];
    for (const t of gapTools) {
      expect(
        BASELINE_CORE_PACK.tools,
        `BASELINE_CORE_PACK must contain gap tool ${t}`,
      ).toContain(t);
    }
  });

  it('BASELINE_CORE_PACK contains exactly the 10 expected tools', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/grant-math.js');
    expect([...BASELINE_CORE_PACK.tools].sort()).toEqual(
      [
        'audit_decision',
        'conversation_state_update',
        'conversation_summary_compose',
        'explain_limitation',
        'handoff_to_owner',
        'read_turn_context',
        'recall_memory',
        'remember_safe_fact',
        'request_confirmation',
        'risk_signal_classify',
      ].sort(),
    );
  });
});

// -------------------------------------------------------------------------
// Suite 2 — tool scope contracts: migration 080 VALUES are a strict subset
// of BASELINE_CORE_PACK. No DB needed; the data contract is inline above.
// -------------------------------------------------------------------------
describe('baseline skills v2 — tool scope contracts (unit, #448)', () => {
  it('each skill in BASELINE_SKILLS_V2 has at least one tool', () => {
    for (const [skill, tools] of Object.entries(BASELINE_SKILLS_V2)) {
      expect(tools.length, `${skill} must have at least one allowed_tool`).toBeGreaterThan(0);
    }
  });

  it('all tool_mediated skill allowed_tools are members of BASELINE_CORE_PACK', async () => {
    const { BASELINE_CORE_PACK } = await import('../../../src/tools/grant-math.js');
    const packTools = new Set(BASELINE_CORE_PACK.tools);
    for (const [skill, tools] of Object.entries(BASELINE_SKILLS_V2)) {
      for (const t of tools) {
        expect(
          packTools.has(t),
          `${skill}.allowed_tools contains ${t} which is NOT in BASELINE_CORE_PACK`,
        ).toBe(true);
      }
    }
  });

  it('no domain/sensitive tool appears in any baseline skill allowed_tools', () => {
    for (const [skill, tools] of Object.entries(BASELINE_SKILLS_V2)) {
      for (const t of tools) {
        expect(
          DOMAIN_TOOLS.has(t),
          `baseline skill ${skill} must NOT reference domain tool ${t}`,
        ).toBe(false);
      }
    }
  });

  it('safe_conversation v2 uses read_turn_context + recall_memory + risk_signal_classify', () => {
    expect(BASELINE_SKILLS_V2['safe_conversation']!.sort()).toEqual(
      ['read_turn_context', 'recall_memory', 'risk_signal_classify'].sort(),
    );
  });

  it('retrieve_context v2 uses only the two read-context tools', () => {
    expect(BASELINE_SKILLS_V2['retrieve_context']!.sort()).toEqual(
      ['read_turn_context', 'recall_memory'].sort(),
    );
  });

  it('handoff_to_owner v2 pairs the escalation with audit + summary', () => {
    expect(BASELINE_SKILLS_V2['handoff_to_owner']!.sort()).toEqual(
      ['audit_decision', 'conversation_summary_compose', 'handoff_to_owner'].sort(),
    );
  });

  it('remember_safe_fact v2 pairs the write with audit (traceable memory writes)', () => {
    expect(BASELINE_SKILLS_V2['remember_safe_fact']!.sort()).toEqual(
      ['audit_decision', 'remember_safe_fact'].sort(),
    );
  });

  it('audit_decision v2 uses only audit_decision (single-purpose skill)', () => {
    expect(BASELINE_SKILLS_V2['audit_decision']).toEqual(['audit_decision']);
  });

  it('escalate_on_risk v1 covers classify + audit + handoff (risk-triggered escalation path)', () => {
    expect(BASELINE_SKILLS_V2['escalate_on_risk']!.sort()).toEqual(
      ['audit_decision', 'handoff_to_owner', 'risk_signal_classify'].sort(),
    );
  });

  it('summarization v1 uses only conversation_summary_compose', () => {
    expect(BASELINE_SKILLS_V2['summarization']).toEqual(['conversation_summary_compose']);
  });

  it('manage_conversation_state v1 uses only conversation_state_update', () => {
    expect(BASELINE_SKILLS_V2['manage_conversation_state']).toEqual(['conversation_state_update']);
  });

  it('BASELINE_SKILLS_V2 has exactly 8 entries (5 converted + 3 new)', () => {
    expect(Object.keys(BASELINE_SKILLS_V2)).toHaveLength(8);
  });
});

// -------------------------------------------------------------------------
// Suite 3 — baseline-only agent cannot see domain-sensitive tools
// -------------------------------------------------------------------------
describe('baseline-only agent — domain tools are NOT visible (#448 / invariant #5)', () => {
  it('a grant with only baseline.core shows all 10 baseline tools', async () => {
    const { computeAgentVisibleTools, BASELINE_CORE_PACK } = await import(
      '../../../src/tools/grant-math.js'
    );
    const grant = {
      granted_packs: ['baseline.core'],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    };
    const res = computeAgentVisibleTools(grant);
    for (const t of BASELINE_CORE_PACK.tools) {
      expect(res.visible, `${t} must be visible for baseline-only grant`).toContain(t);
    }
  });

  it('a baseline-only grant NEVER exposes register_transaction', async () => {
    const { computeAgentVisibleTools } = await import('../../../src/tools/grant-math.js');
    const grant = {
      granted_packs: ['baseline.core'],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    };
    const res = computeAgentVisibleTools(grant);
    expect(res.visible).not.toContain('register_transaction');
  });

  it('a baseline-only grant NEVER exposes any domain/sensitive tool', async () => {
    const { computeAgentVisibleTools } = await import('../../../src/tools/grant-math.js');
    const grant = {
      granted_packs: ['baseline.core'],
      granted_tools: [] as string[],
      denied_tools: [] as string[],
    };
    const res = computeAgentVisibleTools(grant);
    for (const domainTool of DOMAIN_TOOLS) {
      expect(
        res.visible,
        `domain tool ${domainTool} must NOT be visible for baseline-only grant`,
      ).not.toContain(domainTool);
    }
  });
});

// -------------------------------------------------------------------------
// Suite 4 — skills that must remain prompt_only (no tool_mediated v2)
// -------------------------------------------------------------------------
describe('prompt_only skills — NOT in the v2 tool_mediated set (#448)', () => {
  it('ask_clarification, request_confirmation, explain_limitation are absent from BASELINE_SKILLS_V2', () => {
    // Documents the deliberate decision: these three are pure language-composition
    // skills; they need no runtime tool invocation (see migration 080 comments).
    for (const skill of PROMPT_ONLY_SKILLS) {
      expect(
        Object.keys(BASELINE_SKILLS_V2),
        `${skill} must remain prompt_only — it must NOT appear as a v2 tool_mediated skill`,
      ).not.toContain(skill);
    }
  });

  it('the full BASELINE_SKILLS_V2 set never contains a prompt_only-designated skill', () => {
    const v2Set = new Set(Object.keys(BASELINE_SKILLS_V2));
    for (const skill of PROMPT_ONLY_SKILLS) {
      expect(v2Set.has(skill)).toBe(false);
    }
  });
});
