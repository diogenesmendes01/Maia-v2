/**
 * Issue #416 — boleto proposal vertical: per-tool contracts.
 *
 * Asserts the 19 catalog entries exist with the correct key / side_effect /
 * operation_type / audit_action, that the THREE write tools are
 * `side_effect: 'write'`, and that `receipt_validate` REUSES the existing
 * parsers (`parse_image` / `parse_receipt`) rather than introducing a new OCR
 * tool. We exercise handlers directly with a minimal ctx (the established
 * per-tool unit-test pattern in this dir), stubbing the gateway side-effect
 * sources the registry import transitively pulls in.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  MEDIA_ROOT: '/tmp/maia-boleto-tools-spec-media',
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

const ALL_19 = [
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
];

const WRITE_TOOLS = ['boleto_cancel', 'company_campaign_remove', 'refund_create'];

describe('boleto proposal tools — registry presence (issue #416)', () => {
  it('all 19 tools are registered with key === name and an audit_action', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    for (const name of ALL_19) {
      const tool = REGISTRY[name];
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool!.name).toBe(name);
      expect(typeof tool!.audit_action).toBe('string');
      expect(tool!.audit_action.length).toBeGreaterThan(0);
    }
  });

  it('company_identity_resolver is DISTINCT from company_search', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    expect(REGISTRY['company_identity_resolver']).toBeDefined();
    expect(REGISTRY['company_search']).toBeDefined();
    expect(REGISTRY['company_identity_resolver']).not.toBe(REGISTRY['company_search']);
    // The resolver returns a disambiguation/confirmation shape; search does not.
    const out = await REGISTRY['company_identity_resolver']!.handler({} as never, ctx);
    expect(out).toHaveProperty('needs_confirmation');
    expect(out).toHaveProperty('confidence');
  });
});

describe('boleto proposal tools — write side-effects (issue #416)', () => {
  it('EXACTLY the three write tools are side_effect=write among the 19', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const writes = ALL_19.filter((n) => REGISTRY[n]!.side_effect === 'write');
    expect(writes.sort()).toEqual([...WRITE_TOOLS].sort());
  });

  it('each write tool carries a granular permission action key + write operation_type', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    expect(REGISTRY['boleto_cancel']!.required_actions).toEqual(['cancel_boleto']);
    expect(REGISTRY['boleto_cancel']!.operation_type).toBe('cancel');
    expect(REGISTRY['company_campaign_remove']!.required_actions).toEqual(['remove_company_campaign']);
    expect(REGISTRY['refund_create']!.required_actions).toEqual(['create_refund']);
    expect(REGISTRY['refund_create']!.operation_type).toBe('create');
    // Write tools must NOT carry the generic financial-transaction keys (so the
    // boleto role can be authorised without inheriting finance grants).
    for (const name of WRITE_TOOLS) {
      expect(REGISTRY[name]!.required_actions).not.toContain('create_transaction');
      expect(REGISTRY[name]!.required_actions).not.toContain('cancel_transaction');
    }
  });

  it('read/analysis tools are NOT side_effect=write (no extra governed writes)', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const nonWrite = ALL_19.filter((n) => !WRITE_TOOLS.includes(n));
    for (const name of nonWrite) {
      expect(REGISTRY[name]!.side_effect, `${name} must not be a write`).not.toBe('write');
    }
  });
});

describe('receipt_validate — reuses existing parsers (issue #416 / taxonomy §6)', () => {
  it('delegates to parse_image and maps its receipt output (no new OCR)', async () => {
    // Spy on the parse-image tool's handler to prove delegation.
    const parseImageMod = await import('../../../src/tools/parse-image.js');
    const spy = vi
      .spyOn(parseImageMod.parseImageTool, 'handler')
      .mockResolvedValue({
        kind: 'receipt',
        receipt: { valor: 150.5, data: '2026-06-01', beneficiario_nome: '<ocr>ACME</ocr>', banco_origem: '<ocr>Banco X</ocr>' },
        confianca: 0.85,
      } as never);

    const { receiptValidateTool } = await import('../../../src/tools/receipt-validate.js');
    expect(receiptValidateTool.side_effect).toBe('read');
    expect(receiptValidateTool.operation_type).toBe('parse_only');
    expect(receiptValidateTool.audit_action).toBe('receipt_validated');

    const out = await receiptValidateTool.handler(
      { media_local_path: '/tmp/x.jpg', file_sha256: 'abc' } as never,
      ctx,
    );
    expect(spy).toHaveBeenCalledWith(
      { media_local_path: '/tmp/x.jpg', file_sha256: 'abc' },
      ctx,
    );
    expect(out.amount).toBe(150.5);
    expect(out.date).toBe('2026-06-01');
    expect(out.recipient_signal).toBe('<ocr>ACME</ocr>');
    expect(out.confidence).toBe(0.85);
    expect(out.valid).toBe(true);
    spy.mockRestore();
  });

  it('falls back to parse_receipt when parse_image does not route a receipt', async () => {
    const parseImageMod = await import('../../../src/tools/parse-image.js');
    const parseReceiptMod = await import('../../../src/tools/parse-receipt.js');
    const imgSpy = vi
      .spyOn(parseImageMod.parseImageTool, 'handler')
      .mockResolvedValue({ kind: 'unknown', confianca: 0 } as never);
    const rcptSpy = vi
      .spyOn(parseReceiptMod.parseReceiptTool, 'handler')
      .mockResolvedValue({ valor: 99, data: '2026-06-02', beneficiario_nome: '<ocr>Y</ocr>', confianca: 0.6 } as never);

    const { receiptValidateTool } = await import('../../../src/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler(
      { media_local_path: '/tmp/y.jpg', file_sha256: 'def' } as never,
      ctx,
    );
    expect(imgSpy).toHaveBeenCalled();
    expect(rcptSpy).toHaveBeenCalled();
    expect(out.amount).toBe(99);
    expect(out.confidence).toBe(0.6);
    imgSpy.mockRestore();
    rcptSpy.mockRestore();
  });

  it('warns and marks invalid when amount/recipient are missing', async () => {
    const parseImageMod = await import('../../../src/tools/parse-image.js');
    const spy = vi
      .spyOn(parseImageMod.parseImageTool, 'handler')
      .mockResolvedValue({ kind: 'receipt', receipt: {}, confianca: 0 } as never);
    const { receiptValidateTool } = await import('../../../src/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler(
      { media_local_path: '/tmp/z.jpg', file_sha256: 'ghi' } as never,
      ctx,
    );
    expect(out.valid).toBe(false);
    expect(out.warnings).toContain('amount_not_identified');
    expect(out.warnings).toContain('authenticity_unverified');
    spy.mockRestore();
  });
});

describe('boleto read/analysis tools — callable with conservative defaults', () => {
  it('bank_account_validate flags missing fields and normalizes a valid PIX', async () => {
    const { bankAccountValidateTool } = await import('../../../src/tools/bank-account-validate.js');
    expect(bankAccountValidateTool.side_effect).toBe('read');
    const invalid = await bankAccountValidateTool.handler({} as never, ctx);
    expect(invalid.valid).toBe(false);
    expect(invalid.missing_fields.length).toBeGreaterThan(0);

    const valid = await bankAccountValidateTool.handler(
      { pix_key: 'a@b.com', holder_name: 'ACME' } as never,
      ctx,
    );
    expect(valid.valid).toBe(true);
    expect(valid.normalized?.method).toBe('pix');
  });

  it('case_risk_classify defaults to low/allow (never fabricates risk)', async () => {
    const { caseRiskClassifyTool } = await import('../../../src/tools/case-risk-classify.js');
    expect(caseRiskClassifyTool.side_effect).toBe('none');
    const out = await caseRiskClassifyTool.handler({} as never, ctx);
    expect(out.risk_level).toBe('low');
    expect(out.recommended_policy_action).toBe('allow');
  });

  it('legal_intent_detect defaults to no legal intent', async () => {
    const { legalIntentDetectTool } = await import('../../../src/tools/legal-intent-detect.js');
    expect(legalIntentDetectTool.side_effect).toBe('none');
    const out = await legalIntentDetectTool.handler({ customer_message: 'oi' } as never, ctx);
    expect(out.has_legal_intent).toBe(false);
  });

  it('operational_ticket_create is an honest stub (created=false) and NOT a governed write', async () => {
    const { REGISTRY } = await import('../../../src/tools/_registry.js');
    const { operationalTicketCreateTool } = await import('../../../src/tools/operational-ticket-create.js');
    // It is an internal escalation sink, not one of the three customer writes.
    expect(REGISTRY['operational_ticket_create']!.side_effect).not.toBe('write');
    // Honest stub (#432): no ticketing backend → it must NOT fabricate a ticket.
    const out = await operationalTicketCreateTool.handler(
      { reason: 'fraude', summary: 'caso suspeito' } as never,
      ctx,
    );
    expect(out.created).toBe(false);
    expect(out.status).toBe('stub_not_created');
    expect(out.ticket_number).toBeUndefined();
  });
});
