/**
 * Issue #432 — boleto proposal tool stubs must be HONEST.
 *
 * The 11 boleto-proposal stub tools were brought to main by the #416 epic, but
 * their handlers FAKED success on dangerous operations (a cancelled boleto with
 * a fabricated protocol, a "created" refund, a fabricated ticket number, and a
 * `payment_verification` that asserted `paid:false`). This spec pins the #432
 * acceptance criteria on the corrected stubs:
 *
 *   - the 4 customer/operational WRITE-or-communication stubs report an EXPLICIT
 *     non-executed status (`executed/created:false`, `*_not_executed/_created`)
 *     and NEVER a fabricated protocol / ticket number;
 *   - `payment_verification` returns `paid:null` (uncertain) — NEVER `false`;
 *   - `company_blacklist_check` returns `status:'unknown'` — NEVER a false
 *     `'clear'` safety certainty;
 *   - the read stubs return structured not-found / unknown (no faked data).
 *
 * It also re-pins the registry contract this slice MUST preserve (it deliberately
 * does NOT change the #416 governance keys): the stub `audit_action`s stay in
 * `AUDIT_ACTIONS`, the `required_actions` stay in `ACTION_KEYS`, and the
 * side-effect classification is unchanged (7 read, 3 write, 1 communication).
 *
 * Handlers are exercised directly with a minimal ctx (the stubs carry no DB /
 * vision / LLM collateral, so only the gateway side-effect sources the registry
 * import transitively pulls in are stubbed — mirroring boleto-tools.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-boleto-stubs-spec-media',
  ensureMediaDirs: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../../src/gateway/queue.js', () => ({
  enqueueAgent: vi.fn(),
  agentQueue: {},
}));

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

const ALL_STUB_TOOLS = [
  'company_history_lookup',
  'company_blacklist_check',
  'boleto_search',
  'boleto_cancel',
  'dda_lookup',
  'payment_verification',
  'campaign_status_lookup',
  'company_campaign_remove',
  'refund_create',
  'refund_lookup',
  'operational_ticket_create',
] as const;

// On main these three are the ONLY side_effect:'write' stubs. operational_ticket_create
// is deliberately side_effect:'communication' (an internal escalation sink, like
// handoff_to_owner) — #432 does NOT reclassify it.
const WRITE_TOOLS: Record<string, { operation_type: string }> = {
  boleto_cancel: { operation_type: 'cancel' },
  company_campaign_remove: { operation_type: 'update_meta' },
  refund_create: { operation_type: 'create' },
};

// ===========================================================================
describe('REGISTRY — all 11 boleto proposal stub contracts registered', () => {
  it('exposes the 11 stub tools with their exact names + required metadata', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    for (const name of ALL_STUB_TOOLS) {
      const tool = REGISTRY[name];
      expect(tool, `missing ${name}`).toBeDefined();
      expect(tool!.name).toBe(name);
      // Every stub declares redis_required:false (cross-cutting rule §3).
      expect(tool!.redis_required).toBe(false);
      // Typed Zod schemas present.
      expect(tool!.input_schema).toBeDefined();
      expect(tool!.output_schema).toBeDefined();
      // No stub plans a real external effect at stub stage.
      expect(tool!.extractEffect).toBeUndefined();
    }
  });

  it('boleto_search is registered DISTINCT from parse_boleto', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    expect(REGISTRY.boleto_search).toBeDefined();
    expect(REGISTRY.parse_boleto).toBeDefined();
    expect(REGISTRY.boleto_search).not.toBe(REGISTRY.parse_boleto);
    // boleto_search queries operational records (operation_type 'read'); it does
    // NOT carry the OCR parser's 'parse_only'.
    expect(REGISTRY.boleto_search!.operation_type).toBe('read');
    expect(REGISTRY.parse_boleto!.operation_type).toBe('parse_only');
  });

  it('each stub audit_action is in the AUDIT_ACTIONS union (#416 keys preserved)', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const { AUDIT_ACTIONS } = await import('../../../src/governance/audit-actions.js');
    for (const name of ALL_STUB_TOOLS) {
      expect(AUDIT_ACTIONS).toContain(REGISTRY[name]!.audit_action);
    }
  });

  it('each stub required_actions is a subset of ACTION_KEYS (#416 keys preserved)', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const { ACTION_KEYS } = await import('../../../src/governance/audit-actions.js');
    const keys = new Set<string>(ACTION_KEYS);
    for (const name of ALL_STUB_TOOLS) {
      for (const a of REGISTRY[name]!.required_actions) {
        expect(keys.has(a), `${name} declares unknown action key ${a}`).toBe(true);
      }
    }
  });
});

// ===========================================================================
describe('side-effect classification — unchanged from #416 (7 read / 3 write / 1 communication)', () => {
  it('the 7 read stubs declare side_effect=read, operation_type=read', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const readTools = ALL_STUB_TOOLS.filter(
      (n) => !(n in WRITE_TOOLS) && n !== 'operational_ticket_create',
    );
    expect(readTools.length).toBe(7);
    for (const name of readTools) {
      expect(REGISTRY[name]!.side_effect, `${name} side_effect`).toBe('read');
      expect(REGISTRY[name]!.operation_type, `${name} operation_type`).toBe('read');
    }
  });

  it('the 3 write stubs declare side_effect=write with the correct operation_type', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    for (const [name, { operation_type }] of Object.entries(WRITE_TOOLS)) {
      expect(REGISTRY[name]!.side_effect, `${name} side_effect`).toBe('write');
      expect(REGISTRY[name]!.operation_type, `${name} operation_type`).toBe(operation_type);
    }
  });

  it('operational_ticket_create stays an internal communication (NOT reclassified to write)', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    expect(REGISTRY.operational_ticket_create!.side_effect).toBe('communication');
    expect(REGISTRY.operational_ticket_create!.operation_type).toBe('communicate');
  });
});

// ===========================================================================
describe('write stubs — explicit non-executed status, no fake success', () => {
  it('boleto_cancel returns executed=false / stub_not_executed with NO protocol', async () => {
    const { boletoCancelTool } = await import('../../../src/tools/boleto-cancel.js');
    const out = await boletoCancelTool.handler(
      { entidade_id: 'e1', boleto_id: 'b1', reason: 'cliente pediu baixa' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.operation_protocol).toBeUndefined();
    expect(out.resulting_status).toBeUndefined();
  });

  it('company_campaign_remove returns executed=false / stub_not_executed with NO protocol', async () => {
    const { companyCampaignRemoveTool } = await import(
      '../../../src/tools/company-campaign-remove.js'
    );
    const out = await companyCampaignRemoveTool.handler(
      { entidade_id: 'e1', company_id: 'co1', reason: 'opt-out' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.operation_protocol).toBeUndefined();
    expect(out.updated_status).toBeUndefined();
  });

  it('refund_create returns executed=false / stub_not_executed with NO refund_protocol', async () => {
    const { refundCreateTool } = await import('../../../src/tools/refund-create.js');
    const out = await refundCreateTool.handler(
      { entidade_id: 'e1', valor: 100, receipt_reference: 'r1', reason: 'cobrança indevida' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.refund_protocol).toBeUndefined();
    expect(out.created_at).toBeUndefined();
  });

  it('operational_ticket_create returns created=false / stub_not_created with NO ticket_number', async () => {
    const { operationalTicketCreateTool } = await import(
      '../../../src/tools/operational-ticket-create.js'
    );
    const out = await operationalTicketCreateTool.handler(
      { reason: 'precisa de humano', summary: 'caso complexo' } as never,
      ctx,
    );
    expect(out.created).toBe(false);
    expect(out.status).toBe('stub_not_created');
    expect(out.ticket_number).toBeUndefined();
    expect(out.responsible_queue).toBeUndefined();
  });

  it('write stubs ACCEPT governance fields without faking success (no auto-execute)', async () => {
    const { boletoCancelTool } = await import('../../../src/tools/boleto-cancel.js');
    // dual_approval_granted is accepted but does NOT flip the stub into a fake
    // success (enforcement is the #416 policy slice, not the stub).
    const out = await boletoCancelTool.handler(
      {
        entidade_id: 'e1',
        boleto_id: 'b1',
        reason: 'r',
        dual_approval_granted: true,
      } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
  });
});

// ===========================================================================
describe('read stubs — structured unknown/not-found, no faked data', () => {
  it('company_history_lookup returns empty history arrays (no fabricated rows)', async () => {
    const { companyHistoryLookupTool } = await import(
      '../../../src/tools/company-history-lookup.js'
    );
    const out = await companyHistoryLookupTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.interactions).toEqual([]);
    expect(out.complaints).toEqual([]);
    expect(out.refunds).toEqual([]);
    expect(out.operational_notes).toEqual([]);
  });

  it('boleto_search returns an empty boletos list (no fabricated matches)', async () => {
    const { boletoSearchTool } = await import('../../../src/tools/boleto-search.js');
    const out = await boletoSearchTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.boletos).toEqual([]);
  });

  it('dda_lookup returns dda_situation=unknown (never a fabricated situation)', async () => {
    const { ddaLookupTool } = await import('../../../src/tools/dda-lookup.js');
    const out = await ddaLookupTool.handler({ boleto_id: 'b1' } as never, ctx);
    expect(out.dda_situation).toBe('unknown');
  });

  it('campaign_status_lookup returns status=unknown (never a fabricated status)', async () => {
    const { campaignStatusLookupTool } = await import(
      '../../../src/tools/campaign-status-lookup.js'
    );
    const out = await campaignStatusLookupTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.status).toBe('unknown');
  });

  it('refund_lookup returns found=false + empty history/pending (no fabricated refund)', async () => {
    const { refundLookupTool } = await import('../../../src/tools/refund-lookup.js');
    const out = await refundLookupTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.found).toBe(false);
    expect(out.history).toEqual([]);
    expect(out.pending_items).toEqual([]);
  });
});

// ===========================================================================
describe('company_blacklist_check — NEVER a false `clear` certainty (#432)', () => {
  it('returns status=unknown (not clear) absent a real blocklist check', async () => {
    const { companyBlacklistCheckTool } = await import(
      '../../../src/tools/company-blacklist-check.js'
    );
    const out = await companyBlacklistCheckTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.status).toBe('unknown');
    expect(out.status).not.toBe('clear');
    expect(out.observations).toEqual([]);
  });

  it('the output schema admits a future clear/blocked, but the stub emits unknown', async () => {
    const { companyBlacklistCheckTool } = await import(
      '../../../src/tools/company-blacklist-check.js'
    );
    // A real integration may later return clear/blocked/attention...
    expect(
      companyBlacklistCheckTool.output_schema.safeParse({ status: 'blocked', observations: [] }).success,
    ).toBe(true);
    // ...but the stub, with no integration, yields exactly 'unknown'.
    const out = await companyBlacklistCheckTool.handler({ cnpj: '00000000000000' } as never, ctx);
    expect(out.status).toBe('unknown');
  });
});

// ===========================================================================
describe('payment_verification — NEVER paid:false absent real evidence (#432)', () => {
  it('returns paid:null (not false) with source=stub', async () => {
    const { paymentVerificationTool } = await import(
      '../../../src/tools/payment-verification.js'
    );
    const out = await paymentVerificationTool.handler(
      { boleto_id: 'b1' } as never,
      ctx,
    );
    expect(out.paid).toBeNull();
    expect(out.paid).not.toBe(false);
    expect(out.source).toBe('stub');
  });

  it('the output schema admits boolean|null but the stub never emits false', async () => {
    const { paymentVerificationTool } = await import(
      '../../../src/tools/payment-verification.js'
    );
    // Schema accepts boolean|null (a future integration may set true/false)...
    expect(
      paymentVerificationTool.output_schema.safeParse({ paid: null, source: 'stub' }).success,
    ).toBe(true);
    expect(
      paymentVerificationTool.output_schema.safeParse({ paid: true, source: 'integration' }).success,
    ).toBe(true);
    // ...but the stub handler yields exactly null.
    const out = await paymentVerificationTool.handler({ boleto_id: 'b1' } as never, ctx);
    expect(out.paid).toBeNull();
  });
});
