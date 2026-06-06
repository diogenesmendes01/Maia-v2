/**
 * Issue #437 — the ROLE → tool-pack axis of the visibility intersection
 * (capability-taxonomy §2 step 7: `agent grant ∩ active-role packs ∩ skill
 * scope`). Pure-logic tests (REGISTRY-FREE) over `computeAgentVisibleTools`'s
 * new `roleScope` parameter:
 *
 *   - a role WITH packs limits the visible set to its packs ∪ baseline;
 *   - a role with EMPTY packs imposes NO restriction (fail-safe — roles default
 *     to '{}', and a role that adds no packs must not strip the agent to baseline);
 *   - no active role (absent/null) imposes NO restriction (back-compat);
 *   - the role axis can only REMOVE a tool, never AUTHORIZE one (it is
 *     intersected with the agent grant);
 *   - the universal baseline floor survives the role axis even when the role's
 *     packs don't list it;
 *   - provenance records active_role_key / role_granted_packs / dropped_by_role.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAgentVisibleTools,
  BASELINE_CORE_PACK,
  BOLETO_PROPOSAL_READ_PACK,
  BOLETO_PROPOSAL_WRITE_PACK,
  DOMAIN_FINANCE_PACK,
  type AgentToolGrant,
  type RoleToolScope,
} from '../../../src/tools/grant-math.js';

const READ_TOOL = BOLETO_PROPOSAL_READ_PACK.tools[0]!; // company_identity_resolver
const WRITE_TOOL = BOLETO_PROPOSAL_WRITE_PACK.tools[0]!; // boleto_cancel
const FINANCE_TOOL = DOMAIN_FINANCE_PACK.tools[0]!; // register_transaction
const BASELINE_TOOL = BASELINE_CORE_PACK.tools[0]!; // read_turn_context

// An agent that installed finance + boleto read + boleto write packs.
const fullGrant: AgentToolGrant = {
  granted_packs: [
    'baseline.core',
    'domain.finance',
    'boleto_proposal_read_pack',
    'boleto_proposal_write_pack',
  ],
  granted_tools: [],
  denied_tools: [],
};

describe('Issue #437 — role → tool-pack axis (computeAgentVisibleTools)', () => {
  it('a role WITH packs limits the visible set to its packs ∪ baseline', () => {
    const role: RoleToolScope = {
      role_key: 'whatsapp_boleto_proposta_attendant',
      granted_packs: ['boleto_proposal_read_pack'],
    };
    const res = computeAgentVisibleTools(fullGrant, null, role);

    // Read-pack tool stays (granted by agent AND allowed by the active role).
    expect(res.visible).toContain(READ_TOOL);
    // Baseline floor survives the role axis.
    expect(res.visible).toContain(BASELINE_TOOL);
    // Finance + write tools are DROPPED — the agent has them but the active role
    // does not grant their packs.
    expect(res.visible).not.toContain(FINANCE_TOOL);
    expect(res.visible).not.toContain(WRITE_TOOL);

    // Provenance.
    expect(res.provenance.active_role_key).toBe('whatsapp_boleto_proposta_attendant');
    expect(res.provenance.role_granted_packs).toEqual(['boleto_proposal_read_pack']);
    expect(res.provenance.dropped_by_role).toContain(FINANCE_TOOL);
    expect(res.provenance.dropped_by_role).toContain(WRITE_TOOL);
  });

  it('a role with EMPTY granted_packs imposes NO restriction (fail-safe default)', () => {
    const role: RoleToolScope = { role_key: 'default', granted_packs: [] };
    const withRole = computeAgentVisibleTools(fullGrant, null, role);
    const withoutRole = computeAgentVisibleTools(fullGrant, null);

    expect([...withRole.visible].sort()).toEqual([...withoutRole.visible].sort());
    // The agent keeps its domain tools — an empty-pack role does not narrow.
    expect(withRole.visible).toContain(FINANCE_TOOL);
    expect(withRole.visible).toContain(WRITE_TOOL);
    // Provenance marks "no role restriction applied".
    expect(withRole.provenance.active_role_key).toBeNull();
    expect(withRole.provenance.dropped_by_role).toEqual([]);
  });

  it('no active role (undefined) imposes NO restriction (back-compat)', () => {
    const res = computeAgentVisibleTools(fullGrant);
    expect(res.visible).toContain(FINANCE_TOOL);
    expect(res.visible).toContain(WRITE_TOOL);
    expect(res.provenance.active_role_key).toBeNull();
    expect(res.provenance.role_granted_packs).toEqual([]);
    expect(res.provenance.dropped_by_role).toEqual([]);
  });

  it('the role axis can only REMOVE, never AUTHORIZE a tool the agent lacks', () => {
    // Agent has ONLY baseline; the role grants finance — the intersection must
    // NOT surface finance tools (the role authorizes nothing).
    const baselineOnly: AgentToolGrant = {
      granted_packs: ['baseline.core'],
      granted_tools: [],
      denied_tools: [],
    };
    const role: RoleToolScope = { role_key: 'r', granted_packs: ['domain.finance'] };
    const res = computeAgentVisibleTools(baselineOnly, null, role);
    expect(res.visible).not.toContain(FINANCE_TOOL);
    // Still has the baseline floor.
    expect(res.visible).toContain(BASELINE_TOOL);
    expect([...res.visible].sort()).toEqual([...BASELINE_CORE_PACK.tools].sort());
  });

  it('the baseline floor survives a role whose packs do not list baseline', () => {
    const role: RoleToolScope = { role_key: 'r', granted_packs: ['boleto_proposal_read_pack'] };
    const res = computeAgentVisibleTools(fullGrant, null, role);
    for (const t of BASELINE_CORE_PACK.tools) {
      expect(res.visible).toContain(t);
    }
  });

  it('composes with the skill scope (role ∩ skill both narrow)', () => {
    const role: RoleToolScope = { role_key: 'r', granted_packs: ['boleto_proposal_read_pack'] };
    // Skill allowlist further narrows to a single read tool.
    const res = computeAgentVisibleTools(
      fullGrant,
      { allowed_tools: [READ_TOOL, BASELINE_TOOL] },
      role,
    );
    expect(res.visible.sort()).toEqual([BASELINE_TOOL, READ_TOOL].sort());
  });
});
