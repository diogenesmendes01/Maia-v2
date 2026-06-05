/**
 * Issue #432 — missing boleto proposal tool contracts (typed stubs):
 * registry presence + side-effect classification + deterministic stub behavior.
 *
 * Mirrors the #431 `boleto-adapters.spec.ts` / #433 `baseline-gap-tools.spec.ts`
 * pattern: exercise each handler directly with a minimal ctx (the stubs have NO
 * DB/vision/LLM collateral, so only the logger is stubbed) and assert the
 * CONTRACT — typed schemas, correct side_effect/operation_type, explicit
 * non-executed write status (no fake protocol/number), `payment_verification`
 * never returning `paid:false`, `boleto_search` distinct from `parse_boleto`,
 * and the new ACTION_KEYS/AUDIT_ACTIONS being present + append-only.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
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

const WRITE_TOOLS: Record<string, { operation_type: string }> = {
  boleto_cancel: { operation_type: 'cancel' },
  company_campaign_remove: { operation_type: 'update_meta' },
  refund_create: { operation_type: 'create' },
  operational_ticket_create: { operation_type: 'create' },
};

// ===========================================================================
describe('REGISTRY — all 11 boleto proposal stub contracts registered', () => {
  it('exposes the 11 stub tools with their exact names + required metadata', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    for (const name of ALL_STUB_TOOLS) {
      const tool = REGISTRY[name];
      expect(tool, `missing ${name}`).toBeDefined();
      expect(tool!.name).toBe(name);
      // Every stub declares redis_required:false (cross-cutting rule §3).
      expect(tool!.redis_required).toBe(false);
      // Typed Zod schemas present.
      expect(tool!.input_schema).toBeDefined();
      expect(tool!.output_schema).toBeDefined();
      // No stub defines extractEffect (no real external effect at stub stage).
      expect(tool!.extractEffect).toBeUndefined();
    }
  });

  it('boleto_search is registered DISTINCT from parse_boleto', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    expect(REGISTRY.boleto_search).toBeDefined();
    expect(REGISTRY.parse_boleto).toBeDefined();
    expect(REGISTRY.boleto_search).not.toBe(REGISTRY.parse_boleto);
    // boleto_search queries operational records (operation_type 'read'); it does
    // NOT carry the OCR parser's 'parse_only'.
    expect(REGISTRY.boleto_search!.operation_type).toBe('read');
    expect(REGISTRY.parse_boleto!.operation_type).toBe('parse_only');
  });

  it('each stub audit_action is in the AUDIT_ACTIONS union', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { AUDIT_ACTIONS } = await import('@/governance/audit-actions.js');
    for (const name of ALL_STUB_TOOLS) {
      expect(AUDIT_ACTIONS).toContain(REGISTRY[name]!.audit_action);
    }
  });

  it('each stub required_actions is a subset of ACTION_KEYS', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { ACTION_KEYS } = await import('@/governance/audit-actions.js');
    const keys = new Set<string>(ACTION_KEYS);
    for (const name of ALL_STUB_TOOLS) {
      for (const a of REGISTRY[name]!.required_actions) {
        expect(keys.has(a), `${name} declares unknown action key ${a}`).toBe(true);
      }
    }
  });
});

// ===========================================================================
describe('side-effect classification — reads vs writes', () => {
  it('the 7 read stubs declare side_effect=read, operation_type=read', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const readTools = ALL_STUB_TOOLS.filter((n) => !(n in WRITE_TOOLS));
    expect(readTools.length).toBe(7);
    for (const name of readTools) {
      expect(REGISTRY[name]!.side_effect, `${name} side_effect`).toBe('read');
      expect(REGISTRY[name]!.operation_type, `${name} operation_type`).toBe('read');
    }
  });

  it('the 4 write stubs declare side_effect=write with the correct operation_type', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    for (const [name, { operation_type }] of Object.entries(WRITE_TOOLS)) {
      expect(REGISTRY[name]!.side_effect, `${name} side_effect`).toBe('write');
      expect(REGISTRY[name]!.operation_type, `${name} operation_type`).toBe(operation_type);
    }
  });
});

// ===========================================================================
describe('write stubs — explicit non-executed status, no fake success', () => {
  it('boleto_cancel returns executed=false / stub_not_executed with NO protocol', async () => {
    const { boletoCancelTool } = await import('@/tools/boleto-cancel.js');
    const out = await boletoCancelTool.handler(
      { boleto_id: 'b1', reason: 'cliente pediu baixa' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.operation_protocol).toBeUndefined();
    expect(out.resulting_status).toBeUndefined();
  });

  it('company_campaign_remove returns executed=false / stub_not_executed with NO protocol', async () => {
    const { companyCampaignRemoveTool } = await import('@/tools/company-campaign-remove.js');
    const out = await companyCampaignRemoveTool.handler(
      { company_id: 'co1', reason: 'opt-out' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.operation_protocol).toBeUndefined();
    expect(out.updated_status).toBeUndefined();
  });

  it('refund_create returns executed=false / stub_not_executed with NO refund_protocol', async () => {
    const { refundCreateTool } = await import('@/tools/refund-create.js');
    const out = await refundCreateTool.handler(
      { company_id: 'co1', reason: 'cobrança indevida' } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
    expect(out.refund_protocol).toBeUndefined();
    expect(out.created_at).toBeUndefined();
  });

  it('operational_ticket_create returns created=false / stub_not_created with NO ticket_number', async () => {
    const { operationalTicketCreateTool } = await import('@/tools/operational-ticket-create.js');
    const out = await operationalTicketCreateTool.handler(
      { reason: 'precisa de humano', summary: 'caso complexo' } as never,
      ctx,
    );
    expect(out.created).toBe(false);
    expect(out.status).toBe('stub_not_created');
    expect(out.ticket_number).toBeUndefined();
    expect(out.responsible_queue).toBeUndefined();
  });

  it('write stubs ACCEPT governance fields without enforcing them (no throw, still stubbed)', async () => {
    const { boletoCancelTool } = await import('@/tools/boleto-cancel.js');
    // confirmation_id / dual_approval_granted / actor_context are accepted but
    // do NOT flip the stub into a fake success (enforcement is the #416 slice).
    const out = await boletoCancelTool.handler(
      {
        boleto_id: 'b1',
        reason: 'r',
        confirmation_id: 'conf-123',
        dual_approval_granted: true,
        actor_context: { who: 'owner' },
      } as never,
      ctx,
    );
    expect(out.executed).toBe(false);
    expect(out.status).toBe('stub_not_executed');
  });

  it('operational_ticket_create pins to ctx.conversa.id and ignores a divergent conversation_id', async () => {
    const { operationalTicketCreateTool } = await import('@/tools/operational-ticket-create.js');
    const out = await operationalTicketCreateTool.handler(
      { reason: 'r', summary: 's', conversation_id: 'other-convo' } as never,
      ctx,
    );
    expect(out.created).toBe(false);
    expect(out.status).toBe('stub_not_created');
    // Divergence is surfaced (invariant #1) — never used to attach elsewhere.
    expect(out.message).toMatch(/divergente/i);
  });
});

// ===========================================================================
describe('read stubs — structured unknown/not-found, no throw on missing ids', () => {
  it('company_history_lookup returns empty arrays + source=stub (no identifiers)', async () => {
    const { companyHistoryLookupTool } = await import('@/tools/company-history-lookup.js');
    const out = await companyHistoryLookupTool.handler({} as never, ctx);
    expect(out.found).toBe(false);
    expect(out.previous_service_interactions).toEqual([]);
    expect(out.complaints).toEqual([]);
    expect(out.refunds).toEqual([]);
    expect(out.operational_notes).toEqual([]);
    expect(out.source).toBe('stub');
  });

  it('company_blacklist_check returns status=unknown / blocked=false / source=stub', async () => {
    const { companyBlacklistCheckTool } = await import('@/tools/company-blacklist-check.js');
    const out = await companyBlacklistCheckTool.handler({} as never, ctx);
    expect(out.status).toBe('unknown');
    expect(out.blocked).toBe(false);
    expect(out.observations).toEqual([]);
    expect(out.source).toBe('stub');
  });

  it('boleto_search returns empty matched_boletos + count 0 + source=stub', async () => {
    const { boletoSearchTool } = await import('@/tools/boleto-search.js');
    const out = await boletoSearchTool.handler({ company_id: 'co1' } as never, ctx);
    expect(out.matched_boletos).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.source).toBe('stub');
  });

  it('dda_lookup returns found=false + source=stub', async () => {
    const { ddaLookupTool } = await import('@/tools/dda-lookup.js');
    const out = await ddaLookupTool.handler({} as never, ctx);
    expect(out.found).toBe(false);
    expect(out.source).toBe('stub');
  });

  it('campaign_status_lookup returns found=false + source=stub', async () => {
    const { campaignStatusLookupTool } = await import('@/tools/campaign-status-lookup.js');
    const out = await campaignStatusLookupTool.handler({} as never, ctx);
    expect(out.found).toBe(false);
    expect(out.source).toBe('stub');
  });

  it('refund_lookup returns found=false + empty history/pending + source=stub', async () => {
    const { refundLookupTool } = await import('@/tools/refund-lookup.js');
    const out = await refundLookupTool.handler({} as never, ctx);
    expect(out.found).toBe(false);
    expect(out.history).toEqual([]);
    expect(out.pending_items).toEqual([]);
    expect(out.source).toBe('stub');
  });
});

// ===========================================================================
describe('payment_verification — NEVER paid:false absent real evidence', () => {
  it('returns paid:null (not false) with source=stub', async () => {
    const { paymentVerificationTool } = await import('@/tools/payment-verification.js');
    const out = await paymentVerificationTool.handler(
      { boleto_id: 'b1', amount: 100 } as never,
      ctx,
    );
    expect(out.paid).toBeNull();
    expect(out.paid).not.toBe(false);
    expect(out.source).toBe('stub');
  });

  it('the output schema admits null but the stub never emits false', async () => {
    const { paymentVerificationTool } = await import('@/tools/payment-verification.js');
    // Schema accepts boolean|null (a future integration may set true/false)...
    expect(paymentVerificationTool.output_schema.safeParse({ paid: null, source: 'stub' }).success).toBe(true);
    expect(paymentVerificationTool.output_schema.safeParse({ paid: true, source: 'integration' }).success).toBe(true);
    // ...but the stub handler, with no inputs, yields exactly null.
    const out = await paymentVerificationTool.handler({} as never, ctx);
    expect(out.paid).toBeNull();
  });
});

// ===========================================================================
describe('ACTION_KEYS / AUDIT_ACTIONS — appended (present + append-only)', () => {
  it('the 11 new audit actions are present', async () => {
    const { AUDIT_ACTIONS } = await import('@/governance/audit-actions.js');
    const expected = [
      'company_history_lookup_completed',
      'company_blacklist_checked',
      'boleto_searched',
      'boleto_cancel_requested',
      'dda_lookup_completed',
      'payment_verified',
      'campaign_status_lookup_completed',
      'company_campaign_remove_requested',
      'refund_create_requested',
      'refund_lookup_completed',
      'operational_ticket_create_requested',
    ];
    for (const a of expected) {
      expect(AUDIT_ACTIONS).toContain(a);
    }
  });

  it('the 4 new write action keys are present and prior keys are unchanged (append-only)', async () => {
    const { ACTION_KEYS } = await import('@/governance/audit-actions.js');
    for (const k of ['cancel_boleto', 'remove_campaign', 'create_refund', 'create_ticket']) {
      expect(ACTION_KEYS).toContain(k);
    }
    // Append-only: the historically-first keys keep their positions (prefix
    // preserved — nothing was reordered or removed ahead of the new tail).
    expect(ACTION_KEYS[0]).toBe('read_balance');
    expect(ACTION_KEYS.slice(0, 3)).toEqual([
      'read_balance',
      'read_transactions',
      'read_reports',
    ]);
    // The 4 new keys are the trailing entries (appended at the end).
    expect(ACTION_KEYS.slice(-4)).toEqual([
      'cancel_boleto',
      'remove_campaign',
      'create_refund',
      'create_ticket',
    ]);
  });
});
