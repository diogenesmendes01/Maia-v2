/**
 * Issue #416 — boleto proposal vertical: tool-pack contracts.
 *
 * Asserts the SIX packs exist, map to EXACTLY the tools the issue specifies, are
 * grantable (`domain.*`-style, exposed in `TOOL_PACKS`, never in
 * `DEFAULT_AGENT_PACKS`), and that the registry/pack drift guards in `packs.ts`
 * pass (the module-load `assertDomainPackToolsKnown` runs on import).
 *
 * Like the #408/#410 pack specs, importing `packs.ts` transitively loads the
 * registry (→ gateway), so we stub the gateway side-effect sources.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-boleto-packs-spec-media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({
  enqueueAgent: vi.fn(),
  agentQueue: {},
}));

const EXPECTED: Record<string, string[]> = {
  boleto_proposal_read_pack: [
    'company_identity_resolver',
    'company_search',
    'company_history_lookup',
    'company_blacklist_check',
    'boleto_search',
    'dda_lookup',
    'payment_verification',
    'campaign_status_lookup',
  ],
  boleto_proposal_write_pack: ['boleto_cancel', 'company_campaign_remove'],
  refund_intake_pack: [
    'payment_verification',
    'receipt_validate',
    'bank_account_validate',
    'refund_create',
    'conversation_attachment_lookup',
  ],
  refund_followup_pack: [
    'refund_lookup',
    'conversation_attachment_lookup',
    'conversation_summary_generate',
  ],
  document_analysis_pack: ['conversation_attachment_lookup', 'receipt_validate'],
  risk_escalation_pack: [
    'legal_intent_detect',
    'case_risk_classify',
    'operational_ticket_create',
    'conversation_summary_generate',
  ],
};

describe('boleto proposal tool packs (issue #416)', () => {
  it('TOOL_PACKS exposes all 6 packs by id with name/domain/risk_level', async () => {
    const { TOOL_PACKS } = await import('../../../src/tools/packs.js');
    for (const id of Object.keys(EXPECTED)) {
      const pack = TOOL_PACKS[id];
      expect(pack, `${id} must be registered (grantable)`).toBeDefined();
      expect(pack!.id).toBe(id);
      expect(pack!.domain).toBe('boleto_proposal');
      expect(typeof pack!.name).toBe('string');
      expect(['low', 'medium', 'high']).toContain(pack!.risk_level);
      expect(pack!.version).toBeGreaterThanOrEqual(1);
    }
  });

  for (const [id, tools] of Object.entries(EXPECTED)) {
    it(`${id} maps to exactly its issue-specified tools`, async () => {
      const { TOOL_PACKS } = await import('../../../src/tools/packs.js');
      expect([...TOOL_PACKS[id]!.tools].sort()).toEqual([...tools].sort());
    });
  }

  it('every pack tool exists in the registry', async () => {
    const { TOOL_PACKS } = await import('../../../src/tools/packs.js');
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    for (const id of Object.keys(EXPECTED)) {
      for (const name of TOOL_PACKS[id]!.tools) {
        expect(REGISTRY[name], `pack ${id} tool ${name} must be registered`).toBeDefined();
      }
    }
  });

  it('boleto packs are NEVER in DEFAULT_AGENT_PACKS (domain is opt-in)', async () => {
    const { DEFAULT_AGENT_PACKS } = await import('../../../src/tools/packs.js');
    expect([...DEFAULT_AGENT_PACKS]).toEqual(['baseline.core']);
    for (const id of Object.keys(EXPECTED)) {
      expect(DEFAULT_AGENT_PACKS).not.toContain(id);
    }
  });

  it('boleto packs are grantable via resolvePackTools (the role-grant entry point)', async () => {
    const { resolvePackTools } = await import('../../../src/tools/packs.js');
    // Granting the read pack yields exactly its tools (the #415 role grants these).
    expect(resolvePackTools(['boleto_proposal_read_pack']).sort()).toEqual(
      [...EXPECTED.boleto_proposal_read_pack].sort(),
    );
    // Granting multiple packs unions their tools (deduped).
    const union = resolvePackTools(['boleto_proposal_write_pack', 'refund_intake_pack']);
    expect(union).toContain('boleto_cancel');
    expect(union).toContain('refund_create');
    // payment_verification appears in both read + intake; union has no dupes.
    expect(union.filter((t) => t === 'payment_verification').length).toBeLessThanOrEqual(1);
  });

  it('BOLETO_PROPOSAL_PACKS is exactly the six packs', async () => {
    const { BOLETO_PROPOSAL_PACKS } = await import('../../../src/tools/packs.js');
    expect(BOLETO_PROPOSAL_PACKS.map((p) => p.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('the write pack contains ONLY the two declared write tools, both side_effect=write', async () => {
    const { TOOL_PACKS } = await import('../../../src/tools/packs.js');
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const writePack = TOOL_PACKS['boleto_proposal_write_pack']!;
    for (const name of writePack.tools) {
      expect(REGISTRY[name]!.side_effect, `${name} must be a write`).toBe('write');
    }
  });

  it('every boleto-pack tool is KNOWN to the catalog (drift guard passes)', async () => {
    const { BOLETO_PROPOSAL_PACKS } = await import('../../../src/tools/packs.js');
    const { buildToolCatalog } = await import('../../../src/tools/_registry.js');
    const known = new Set(buildToolCatalog().map((e) => e.tool.name));
    for (const pack of BOLETO_PROPOSAL_PACKS) {
      for (const t of pack.tools) {
        expect(known.has(t), `pack ${pack.id} tool ${t} must be known`).toBe(true);
      }
    }
  });
});
