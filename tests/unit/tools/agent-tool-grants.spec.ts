/**
 * Issue #408 — the Runtime Tool Filter intersection (AGENT grant ∩ SKILL scope).
 *
 * Covers the DoD acceptance criteria that are pure-logic (no DB, no registry):
 *   (a) agente sem pack de domínio → só baseline;
 *   (b) agente com `domain.finance` → as tools financeiras autorizadas;
 *   (c) uma skill reduz o conjunto;
 *   (d) `denied_tools` (grant E skill) nunca aparece (visibilidade HARD);
 *   (e) provenance registra packs/grants/skills que produziram o conjunto.
 *
 * Imports `grant-math.ts` (REGISTRY-FREE) so this stays a fast, side-effect-free
 * unit test. The registry-validated pack surface is tested in packs.spec.ts; the
 * human-permission + flag intersection in registry-agent-tool-schemas.spec.ts;
 * the dispatcher HARD enforcement in dispatcher-tool-not-granted.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAgentVisibleTools,
  resolveGrantedToolNames,
  defaultAgentGrant,
  BASELINE_CORE_PACK,
  DOMAIN_FINANCE_PACK,
  DOMAIN_CALENDAR_PACK,
  type AgentToolGrant,
} from '../../../src/tools/grant-math.js';
import { BASE_AGENT_PACKS } from '../../../src/tools/base-agent-packs.js';

const BASELINE = [...BASELINE_CORE_PACK.tools].sort();

describe('Runtime Tool Filter — agent grant ∩ skill scope (#408)', () => {
  it('(a) an agent WITHOUT a domain pack sees only baseline tools', () => {
    const grant: AgentToolGrant = { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] };
    const res = computeAgentVisibleTools(grant);
    expect([...res.visible].sort()).toEqual(BASELINE);
    // #433 — the 3 new gap tools ARE part of the baseline floor…
    expect(res.visible).toContain('risk_signal_classify');
    expect(res.visible).toContain('conversation_summary_compose');
    expect(res.visible).toContain('conversation_state_update');
    // …but NO domain/sensitive tool leaks in (negative-visibility invariant #5).
    expect(res.visible).not.toContain('register_transaction');
    expect(res.visible).not.toContain('query_balance');
    expect(res.visible).not.toContain('send_proactive_message');
    expect(res.visible).not.toContain('start_workflow');
  });

  it('defaultAgentGrant() == BASE_AGENT_PACKS (baseline.core + domain.calendar)', () => {
    expect(defaultAgentGrant()).toEqual({
      granted_packs: [...BASE_AGENT_PACKS],
      granted_tools: [],
      denied_tools: [],
    });
    // resolveGrantedToolNames must include both baseline AND calendar tools.
    const granted = [...resolveGrantedToolNames(defaultAgentGrant())].sort();
    const expected = [...BASELINE_CORE_PACK.tools, ...DOMAIN_CALENDAR_PACK.tools].sort();
    expect(granted).toEqual(expected);
  });

  it('(b) an agent with domain.finance sees baseline ∪ the finance tools', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = computeAgentVisibleTools(grant);
    // Every finance tool is now visible…
    for (const t of DOMAIN_FINANCE_PACK.tools) expect(res.visible).toContain(t);
    // …plus the baseline floor.
    for (const t of BASELINE_CORE_PACK.tools) expect(res.visible).toContain(t);
    // …and nothing from OTHER domains (e.g. proactive send is domain.sales).
    expect(res.visible).not.toContain('send_proactive_message');
  });

  it('(c) a skill allowlist REDUCES the visible set to the intersection', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = computeAgentVisibleTools(grant, {
      skill_id: 'skill.read_balance',
      // The skill only needs to read the balance — even though the agent has the
      // full finance pack, the LLM sees just this tool.
      allowed_tools: ['query_balance'],
    });
    expect(res.visible).toEqual(['query_balance']);
    expect(res.provenance.dropped_by_skill_allowlist).toContain('register_transaction');
    expect(res.provenance.skill_id).toBe('skill.read_balance');
  });

  it('(c2) an EMPTY/absent skill allowlist does not restrict (agent grant decides)', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const withEmpty = computeAgentVisibleTools(grant, { skill_id: 's', allowed_tools: [] });
    const without = computeAgentVisibleTools(grant);
    expect([...withEmpty.visible].sort()).toEqual([...without.visible].sort());
  });

  it('(d) grant.denied_tools is HARD — never visible even if in a granted pack', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      // Deny a tool the pack grants.
      denied_tools: ['cancel_transaction'],
    };
    const res = computeAgentVisibleTools(grant);
    expect(res.visible).not.toContain('cancel_transaction');
    // Other finance tools remain.
    expect(res.visible).toContain('register_transaction');
    expect(res.provenance.denied_by_grant).toContain('cancel_transaction');
  });

  it('(d2) skill.denied_tools is HARD — removes a tool the agent + allowlist would show', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = computeAgentVisibleTools(grant, {
      skill_id: 's',
      allowed_tools: ['query_balance', 'register_transaction'],
      denied_tools: ['register_transaction'],
    });
    expect([...res.visible].sort()).toEqual(['query_balance']);
    expect(res.provenance.denied_by_skill).toContain('register_transaction');
  });

  it('granted_tools (outside a pack) are added and still subject to denies', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core'],
      granted_tools: ['query_balance'],
      denied_tools: [],
    };
    expect(computeAgentVisibleTools(grant).visible).toContain('query_balance');

    const denied: AgentToolGrant = { ...grant, denied_tools: ['query_balance'] };
    expect(computeAgentVisibleTools(denied).visible).not.toContain('query_balance');
  });

  it('requires_confirmation_for is carried through (∩ visible), NOT a visibility filter', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: [],
      denied_tools: [],
    };
    const res = computeAgentVisibleTools(grant, {
      skill_id: 's',
      allowed_tools: ['query_balance', 'register_transaction'],
      requires_confirmation_for: ['register_transaction', 'not_visible_tool'],
    });
    // Still visible…
    expect(res.visible).toContain('register_transaction');
    // …and flagged requires-confirmation, but only for visible tools.
    expect(res.requires_confirmation).toEqual(['register_transaction']);
  });

  it('(e) provenance records packs/grants/skills that produced the set', () => {
    const grant: AgentToolGrant = {
      granted_packs: ['baseline.core', 'domain.finance'],
      granted_tools: ['some_extra_tool'],
      denied_tools: ['cancel_transaction'],
    };
    const res = computeAgentVisibleTools(grant, {
      skill_id: 'skill.x',
      allowed_tools: ['query_balance'],
      denied_tools: ['list_transactions'],
    });
    expect(res.provenance.granted_packs).toEqual(['baseline.core', 'domain.finance']);
    expect(res.provenance.granted_tools).toEqual(['some_extra_tool']);
    expect(res.provenance.denied_by_grant).toEqual(['cancel_transaction']);
    expect(res.provenance.skill_id).toBe('skill.x');
    expect(res.provenance.skill_allowed_tools).toEqual(['query_balance']);
    expect(res.provenance.denied_by_skill).toEqual(['list_transactions']);
  });
});
