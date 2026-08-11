/**
 * Issue #431 — boleto proposal domain adapters: registry presence + contract +
 * delegation + scope. Mirrors the #433 pattern in `baseline-gap-tools.spec.ts`:
 * exercise each handler directly with a minimal ctx and stubbed collateral, and
 * assert the REUSE boundary (no duplicated capability) rather than re-testing the
 * underlying primitive.
 *
 * Covered (per the issue's acceptance criteria):
 *   - REGISTRY contains all 8 adapters with valid audit actions.
 *   - receipt_validate delegates through the parse_receipt / parseImage path
 *     (vision cache keyed by `parse_receipt`; no second vision call site) and is
 *     FAIL-CLOSED (positive authenticity + essential fields, else reasons).
 *   - conversation_attachment_lookup returns only current-scope attachments and
 *     reads media from `metadata` (media_sha256/media_mime), not columns.
 *   - case_risk_classify composes classifyTurnRisk and maps source from
 *     decided_by; never downgrades.
 *   - company_identity_resolver targets `contrapartes` and returns an ambiguous
 *     result when fuzzy candidates are too close; exact CNPJ outranks fuzzy.
 *   - bank_account_validate reuses the shared CPF/CNPJ CHECKSUM validators and
 *     returns missing fields + warnings for incomplete data.
 *   - legal_intent_detect flags legal terms deterministically.
 *   - conversation_summary_generate wraps the shared summarizer and maps to the
 *     boleto shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RiskLevel } from '@/types/enums.js';

// ---- repository mocks (the adapters' only DB surface) ---------------------
const byDocumentoMock = vi.fn();
const searchByNameMock = vi.fn();
const byIdScopedMock = vi.fn();
const recentInConversationMock = vi.fn();

vi.mock('@/db/repositories.js', () => ({
  contrapartesRepo: {
    byDocumento: byDocumentoMock,
    searchByName: searchByNameMock,
    byIdScoped: byIdScopedMock,
  },
  mensagensRepo: { recentInConversation: recentInConversationMock },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---- vision path: assert receipt_validate goes through the cache under the
//      parse_receipt name and never makes a SECOND vision call -------------
const parseImageMock = vi.fn();
vi.mock('@/lib/vision.js', () => ({ parseImage: parseImageMock }));
const getCachedVisionMock = vi.fn();
const setCachedVisionMock = vi.fn();
vi.mock('@/tools/_vision-cache.js', () => ({
  getCachedVision: getCachedVisionMock,
  setCachedVision: setCachedVisionMock,
}));

// ---- P0 audit ch. 4: attachment_id resolution + guarded media read --------
// receipt_validate resolves an attachment ID and delegates to parse_receipt,
// which resolves it again (scoped) and reads through media-guard. The vision
// cache is keyed on the sha RECOMPUTED by media-guard.
const resolveAttachmentByIdMock = vi.fn();
vi.mock('@/lib/attachment-resolver.js', () => ({
  resolveAttachmentById: resolveAttachmentByIdMock,
}));
const readStoredMediaMock = vi.fn();
vi.mock('@/lib/media-guard.js', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media-guard.js')>(
    '@/lib/media-guard.js',
  );
  return { ...actual, readStoredMedia: readStoredMediaMock };
});

// ---- shared summarizer collateral (runner + LLM) --------------------------
// The runner mock runs the wrapped fn for the SUMMARIZER, but short-circuits the
// risk gate (`risk_assessor_llm`) to its declared fallback so `case_risk_classify`
// never instantiates the Anthropic SDK in a unit lane — fully deterministic.
vi.mock('@/cognition/runner.js', () => ({
  runCognitiveModule: vi.fn(
    async (opts: { name?: string; fallback?: unknown }, fn: () => Promise<unknown>) => {
      if (opts?.name === 'risk_assessor_llm') {
        return { status: 'success', output: opts.fallback ?? null };
      }
      return { status: 'success', output: await fn() };
    },
  ),
}));
const callLLMMock = vi.fn();
vi.mock('@/lib/claude.js', () => ({ callLLM: callLLMMock }));

beforeEach(() => {
  byDocumentoMock.mockReset();
  searchByNameMock.mockReset();
  byIdScopedMock.mockReset();
  recentInConversationMock.mockReset();
  parseImageMock.mockReset();
  getCachedVisionMock.mockReset();
  setCachedVisionMock.mockReset();
  callLLMMock.mockReset();
  resolveAttachmentByIdMock.mockReset();
  readStoredMediaMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

/** Build a realistic Contraparte row. */
function cp(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'cp-1',
    tenant_id: 'default',
    agent_id: 'default',
    entidade_id: 'e1',
    nome: 'Empresa Alpha LTDA',
    tipo: 'fornecedor',
    documento: null,
    chave_pix: null,
    banco_padrao: null,
    observacoes: null,
    metadata: {},
    status: 'ativa',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

// ===========================================================================
describe('REGISTRY — all 8 boleto adapters registered', () => {
  it('exposes the 8 adapter tools with their exact names', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const expected = [
      'company_identity_resolver',
      'company_search',
      'receipt_validate',
      'conversation_attachment_lookup',
      'conversation_summary_generate',
      'case_risk_classify',
      'legal_intent_detect',
      'bank_account_validate',
    ];
    for (const name of expected) {
      expect(REGISTRY[name], `missing ${name}`).toBeDefined();
      expect(REGISTRY[name]!.name).toBe(name);
      // Each tool must declare redis_required (cross-cutting rule §5).
      expect(typeof REGISTRY[name]!.redis_required).toBe('boolean');
    }
  });

  it('audit_action of each adapter is in the AUDIT_ACTIONS union', async () => {
    const { REGISTRY } = await import('@/tools/_registry.js');
    const { AUDIT_ACTIONS } = await import('@/governance/audit-actions.js');
    const names = [
      'company_identity_resolver',
      'company_search',
      'receipt_validate',
      'conversation_attachment_lookup',
      'conversation_summary_generate',
      'case_risk_classify',
      'legal_intent_detect',
      'bank_account_validate',
    ];
    for (const n of names) {
      expect(AUDIT_ACTIONS).toContain(REGISTRY[n]!.audit_action);
    }
  });
});

// ===========================================================================
describe('company_identity_resolver — contrapartes + ambiguity gate', () => {
  it('declares a read-only, scoped contract targeting contrapartes', async () => {
    const { companyIdentityResolverTool } = await import('@/tools/company-identity-resolver.js');
    expect(companyIdentityResolverTool.side_effect).toBe('read');
    expect(companyIdentityResolverTool.operation_type).toBe('read');
    expect(companyIdentityResolverTool.audit_action).toBe('company_identity_resolved');
  });

  it('exact CNPJ match outranks fuzzy and resolves with high confidence', async () => {
    byDocumentoMock.mockResolvedValueOnce([cp({ id: 'cp-cnpj', documento: '12345678000190' })]);
    const { companyIdentityResolverTool } = await import('@/tools/company-identity-resolver.js');
    const out = await companyIdentityResolverTool.handler(
      { cnpj: '12.345.678/0001-90' } as never,
      ctx,
    );
    expect(byDocumentoMock).toHaveBeenCalledTimes(1);
    // Did NOT fall through to a fuzzy name search.
    expect(searchByNameMock).not.toHaveBeenCalled();
    expect(out.resolved).toBe(true);
    expect(out.confidence).toBe('high');
    expect(out.company_id).toBe('cp-cnpj');
    expect(out.matched_by).toContain('cnpj');
    expect(out.needs_confirmation).toBe(false);
  });

  it('returns an AMBIGUOUS result (needs_confirmation, no company_id) when fuzzy candidates are too close', async () => {
    // Two candidates that are SYMMETRIC variants of the query ("Comercial X
    // Norte" / "Comercial X Sul") so they score within the 0.1 ambiguity gap of
    // each other — neither is a confident winner.
    searchByNameMock.mockResolvedValueOnce([
      cp({ id: 'a', nome: 'Comercial Estrela Norte' }),
      cp({ id: 'b', nome: 'Comercial Estrela Sul' }),
    ]);
    const { companyIdentityResolverTool } = await import('@/tools/company-identity-resolver.js');
    const out = await companyIdentityResolverTool.handler(
      { partial_company_name: 'Comercial Estrela' } as never,
      ctx,
    );
    // Used contrapartes (searchByName), not entidades.
    expect(searchByNameMock).toHaveBeenCalledTimes(1);
    expect(out.needs_confirmation).toBe(true);
    expect(out.resolved).toBe(false);
    expect(out.company_id).toBeUndefined();
    expect(out.alternatives.length).toBeGreaterThanOrEqual(2);
    expect(out.question).toBeTruthy();
  });

  it('resolves a clear unambiguous fuzzy winner without confirmation', async () => {
    searchByNameMock.mockResolvedValueOnce([
      cp({ id: 'win', nome: 'Transportadora Veloz LTDA' }),
      cp({ id: 'other', nome: 'Mercado Central' }),
    ]);
    const { companyIdentityResolverTool } = await import('@/tools/company-identity-resolver.js');
    const out = await companyIdentityResolverTool.handler(
      { trade_name: 'Transportadora Veloz' } as never,
      ctx,
    );
    expect(out.resolved).toBe(true);
    expect(out.company_id).toBe('win');
    expect(out.needs_confirmation).toBe(false);
  });
});

// ===========================================================================
describe('company_search — exact id/CNPJ before fuzzy', () => {
  it('prefers exact company_id (scoped) over any fuzzy search', async () => {
    byIdScopedMock.mockResolvedValueOnce(cp({ id: 'cp-x', nome: 'Beta SA' }));
    const { companySearchTool } = await import('@/tools/company-search.js');
    const out = await companySearchTool.handler({ company_id: 'cp-x' } as never, ctx);
    expect(byIdScopedMock).toHaveBeenCalledTimes(1);
    expect(searchByNameMock).not.toHaveBeenCalled();
    expect(out.found).toBe(true);
    expect(out.company?.company_id).toBe('cp-x');
    expect(out.matched_by).toBe('company_id');
  });

  it('returns found=false with no exact hit and no name signal', async () => {
    byIdScopedMock.mockResolvedValueOnce(null);
    const { companySearchTool } = await import('@/tools/company-search.js');
    const out = await companySearchTool.handler({ company_id: 'missing' } as never, ctx);
    expect(out.found).toBe(false);
  });
});

// ===========================================================================
describe('receipt_validate — delegates through parse_receipt, FAIL-CLOSED', () => {
  it('declares a parse_only contract sourcing from parse_receipt', async () => {
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    expect(receiptValidateTool.operation_type).toBe('parse_only');
    expect(receiptValidateTool.audit_action).toBe('receipt_validated');
  });

  const ATT_ID = '99999999-8888-4777-8666-555555555555';

  /** Wire the delegated parse_receipt path: attachment_id → resolved row →
   * guarded read whose RECOMPUTED sha keys the vision cache. */
  function wireAttachment(sha: string): void {
    resolveAttachmentByIdMock.mockResolvedValue({
      message_id: ATT_ID,
      path: '/media/t/2026-07/r.jpg',
      mime: 'image/jpeg',
      tipo: 'imagem',
      caption: 'comprovante',
    });
    readStoredMediaMock.mockResolvedValue({
      buf: Buffer.from('receipt-bytes'),
      sha256: sha,
      mime: 'image/jpeg',
    });
  }

  it('serves a parse_receipt CACHE HIT keyed on the RECOMPUTED sha, without any vision call', async () => {
    wireAttachment('abc123');
    // The cache is keyed by the parse_receipt tool name; a hit means NO parseImage.
    getCachedVisionMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 150.5,
      data: '2026-05-01',
      beneficiario_nome: '<ocr>Loja</ocr>',
      confianca: 0.85,
    });
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler({ attachment_ref: ATT_ID } as never, ctx);
    // The direct ref was validated against the CURRENT conversation.
    expect(resolveAttachmentByIdMock).toHaveBeenCalledWith('c1', ATT_ID);
    // Delegated cache lookup used the parse_receipt name + the sha media-guard
    // RECOMPUTED from the bytes (never a declared value).
    expect(getCachedVisionMock).toHaveBeenCalledWith('parse_receipt', 'abc123');
    // No SECOND vision call site.
    expect(parseImageMock).not.toHaveBeenCalled();
    expect(out.source_parser).toBe('parse_receipt');
    expect(out.identified_amount).toBe(150.5);
    expect(out.authenticity).toBe('plausible');
    // FAIL-CLOSED: positive authenticity + all essential fields → valid, no reasons.
    expect(out.valid).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('is FAIL-CLOSED: a parsed receipt missing the recipient is invalid with reasons', async () => {
    wireAttachment('norecipient-sha');
    getCachedVisionMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 10,
      data: '2026-05-01',
      // no beneficiario_* → no recipient identification
      confianca: 0.85,
    });
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler({ attachment_ref: ATT_ID } as never, ctx);
    expect(out.valid).toBe(false);
    expect(out.reasons).toContain('missing_recipient_identification');
    // authenticity could not reach 'plausible' (a missing field is a warning).
    expect(out.authenticity).not.toBe('plausible');
  });

  it('is FAIL-CLOSED: no attachment in the conversation → invalid with a reason', async () => {
    recentInConversationMock.mockResolvedValueOnce([]);
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler({ attachment_hint: 'comprovante' } as never, ctx);
    expect(out.valid).toBe(false);
    expect(out.reasons).toContain('no_receipt_attachment_found_in_conversation');
    expect(getCachedVisionMock).not.toHaveBeenCalled();
  });

  it('on a cache MISS, calls parseImage ONCE and caches under parse_receipt + recomputed sha', async () => {
    wireAttachment('sha9');
    getCachedVisionMock.mockResolvedValueOnce(null);
    parseImageMock.mockResolvedValueOnce({ tipo: 'pix', valor: 99, beneficiario_nome: 'Foo' });
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler({ attachment_ref: ATT_ID } as never, ctx);
    expect(parseImageMock).toHaveBeenCalledTimes(1);
    // Vision gets validated bytes + sniffed mime — never a filesystem path.
    expect(parseImageMock).toHaveBeenCalledWith(
      expect.objectContaining({ mime: 'image/jpeg', kind: 'receipt' }),
    );
    // Cache written back under the parse_receipt name (so a later parse_receipt
    // reuses it — single shared cache entry) keyed by the RECOMPUTED sha.
    expect(setCachedVisionMock).toHaveBeenCalledWith('parse_receipt', 'sha9', expect.anything());
    expect(out.source_parser).toBe('parse_receipt');
  });

  it('resolves the attachment ID from the conversation when only a hint is given', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      {
        id: ATT_ID,
        midia_url: '/media/t/2026-07/r.jpg',
        tipo: 'imagem',
        conteudo: 'comprovante',
        metadata: { media_sha256: 'DECLARED-not-used', media_mime: 'image/jpeg' },
        created_at: new Date(),
      },
    ]);
    wireAttachment('metasha');
    getCachedVisionMock.mockResolvedValueOnce({
      tipo: 'pix',
      valor: 10,
      data: '2026-01-01',
      beneficiario_nome: '<ocr>Loja</ocr>',
      confianca: 0.85,
    });
    const { receiptValidateTool } = await import('@/tools/receipt-validate.js');
    const out = await receiptValidateTool.handler({ attachment_hint: 'comprovante' } as never, ctx);
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 50);
    // The hint resolved to the message ID; the delegated parse_receipt re-read
    // the media and keyed the cache on the RECOMPUTED sha — the stored
    // metadata sha ('DECLARED-not-used') is never trusted.
    expect(resolveAttachmentByIdMock).toHaveBeenCalledWith('c1', ATT_ID);
    expect(getCachedVisionMock).toHaveBeenCalledWith('parse_receipt', 'metasha');
    expect(out.source_parser).toBe('parse_receipt');
  });
});

// ===========================================================================
describe('conversation_attachment_lookup — scope + opaque attachment ids', () => {
  it('returns only current-scope attachments with OPAQUE attachment_ids (no path, no sha)', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      {
        id: 'm1',
        midia_url: '/tmp/a.jpg',
        tipo: 'imagem',
        conteudo: 'foto',
        metadata: { media_sha256: 's1', media_mime: 'image/jpeg' },
        created_at: new Date('2026-05-01T00:00:00Z'),
      },
      // text-only message → no attachment.
      { id: 'm2', midia_url: null, tipo: 'texto', conteudo: 'oi', metadata: {}, created_at: new Date() },
      {
        id: 'm3',
        midia_url: '/tmp/b.pdf',
        tipo: 'documento',
        conteudo: null,
        metadata: { media_sha256: 's3', media_mime: 'application/pdf' },
        created_at: new Date('2026-05-02T00:00:00Z'),
      },
    ]);
    const { conversationAttachmentLookupTool } = await import(
      '@/tools/conversation-attachment-lookup.js'
    );
    const out = await conversationAttachmentLookupTool.handler({ limit: 100 } as never, ctx);
    // ALS-scoped read of the CURRENT conversation only.
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 100);
    expect(out.count).toBe(2);
    const img = out.attachments.find((a) => a.message_id === 'm1')!;
    expect(img.type).toBe('image');
    expect(img.attachment_id).toBe('m1'); // the opaque handle = mensagens row id
    expect(img.media_mime).toBe('image/jpeg'); // mapped from metadata.media_mime
    // P0 audit ch. 4: the LLM never sees a filesystem path or a sha.
    expect(img).not.toHaveProperty('media_local_path');
    expect(img).not.toHaveProperty('file_sha256');
    expect(JSON.stringify(out)).not.toContain('/tmp/a.jpg');
    expect(JSON.stringify(out)).not.toContain('s1');
    const pdf = out.attachments.find((a) => a.message_id === 'm3')!;
    expect(pdf.type).toBe('pdf'); // documento + pdf mime → pdf
    expect(pdf.attachment_id).toBe('m3');
  });

  it('hints match caption or attachment_id prefix — NOT paths or shas', async () => {
    recentInConversationMock.mockResolvedValue([
      {
        id: 'aaaa1111-0000-4000-8000-000000000001',
        midia_url: '/tmp/secret-path-token.jpg',
        tipo: 'imagem',
        conteudo: 'comprovante do aluguel',
        metadata: { media_sha256: 'shatoken', media_mime: 'image/jpeg' },
        created_at: new Date(),
      },
    ]);
    const { conversationAttachmentLookupTool } = await import(
      '@/tools/conversation-attachment-lookup.js'
    );
    // Caption hint matches.
    const byCaption = await conversationAttachmentLookupTool.handler(
      { limit: 100, attachment_hints: ['aluguel'] } as never,
      ctx,
    );
    expect(byCaption.count).toBe(1);
    // attachment_id prefix matches.
    const byIdPrefix = await conversationAttachmentLookupTool.handler(
      { limit: 100, attachment_hints: ['aaaa1111'] } as never,
      ctx,
    );
    expect(byIdPrefix.count).toBe(1);
    // A path fragment or the stored sha NO LONGER matches anything.
    const byPath = await conversationAttachmentLookupTool.handler(
      { limit: 100, attachment_hints: ['secret-path-token'] } as never,
      ctx,
    );
    expect(byPath.count).toBe(0);
    const bySha = await conversationAttachmentLookupTool.handler(
      { limit: 100, attachment_hints: ['shatoken'] } as never,
      ctx,
    );
    expect(bySha.count).toBe(0);
  });

  it('warns and ignores a divergent conversation_id (no scope escape)', async () => {
    recentInConversationMock.mockResolvedValueOnce([]);
    const { conversationAttachmentLookupTool } = await import(
      '@/tools/conversation-attachment-lookup.js'
    );
    // Parse through the schema (as the dispatcher does) so `limit` defaults to 100.
    const args = conversationAttachmentLookupTool.input_schema.parse({
      conversation_id: 'other-convo',
    });
    const out = await conversationAttachmentLookupTool.handler(args as never, ctx);
    // Still read the ALS conversation, never 'other-convo'.
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 100);
    expect(out.warnings).toContain('conversation_id_ignored_scoped_to_current_conversation');
  });

  it('filters by attachment_type', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      { id: 'm1', midia_url: '/a.jpg', tipo: 'imagem', conteudo: null, metadata: { media_sha256: 's1' }, created_at: new Date() },
      { id: 'm2', midia_url: '/a.ogg', tipo: 'audio', conteudo: null, metadata: { media_sha256: 's2' }, created_at: new Date() },
    ]);
    const { conversationAttachmentLookupTool } = await import(
      '@/tools/conversation-attachment-lookup.js'
    );
    const out = await conversationAttachmentLookupTool.handler(
      { attachment_type: 'audio' } as never,
      ctx,
    );
    expect(out.count).toBe(1);
    expect(out.attachments[0]!.type).toBe('audio');
  });
});

// ===========================================================================
describe('case_risk_classify — composes classifyTurnRisk', () => {
  it('declares a classification-only contract', async () => {
    const { caseRiskClassifyTool } = await import('@/tools/case-risk-classify.js');
    expect(caseRiskClassifyTool.side_effect).toBe('none');
    expect(caseRiskClassifyTool.operation_type).toBe('read');
    expect(caseRiskClassifyTool.audit_action).toBe('case_risk_classified');
  });

  it('maps source from decided_by and a financial case is >= MEDIUM (never downgraded)', async () => {
    const { caseRiskClassifyTool } = await import('@/tools/case-risk-classify.js');
    const out = await caseRiskClassifyTool.handler(
      { customer_message: 'preciso pagar o boleto', payment_context: { amount: 100 } } as never,
      ctx,
    );
    // Composed the shared scorer: financial/transfer floor → >= MEDIUM.
    expect([RiskLevel.MEDIUM, RiskLevel.HIGH, RiskLevel.CRITICAL]).toContain(out.risk);
    expect(out.risk).not.toBe(RiskLevel.LOW);
    // source is the scorer's decided_by ('heuristic' | 'llm_upgrade').
    expect(['heuristic', 'llm_upgrade']).toContain(out.source);
    expect(['allow', 'confirm', 'block', 'escalate']).toContain(out.recommended_policy_action);
  });

  it('legal_intent forces an escalation-leaning policy action', async () => {
    const { caseRiskClassifyTool } = await import('@/tools/case-risk-classify.js');
    const out = await caseRiskClassifyTool.handler(
      { customer_message: 'questão de reembolso', legal_intent: true } as never,
      ctx,
    );
    // Legal intent → never 'allow'; high/critical → 'escalate'.
    expect(out.recommended_policy_action).not.toBe('allow');
  });
});

// ===========================================================================
describe('legal_intent_detect — deterministic lexical rules', () => {
  it('flags a lawyer + lawsuit message with reasons/excerpts', async () => {
    const { legalIntentDetectTool } = await import('@/tools/legal-intent-detect.js');
    const out = await legalIntentDetectTool.handler(
      { customer_message: 'Vou acionar meu advogado e processar a empresa na justiça.' } as never,
      ctx,
    );
    expect(out.has_legal_intent).toBe(true);
    expect(out.identified_reasons).toContain('lawyer');
    expect(out.identified_reasons.length).toBeGreaterThanOrEqual(2);
    expect(out.confidence).toBe('high');
    expect(out.excerpts.length).toBeGreaterThan(0);
  });

  it('returns no legal intent for a neutral message', async () => {
    const { legalIntentDetectTool } = await import('@/tools/legal-intent-detect.js');
    const out = await legalIntentDetectTool.handler(
      { customer_message: 'Bom dia, gostaria de pagar meu boleto.' } as never,
      ctx,
    );
    expect(out.has_legal_intent).toBe(false);
    expect(out.confidence).toBe('low');
  });

  it('detects Procon (consumer protection) as a single-category medium', async () => {
    const { legalIntentDetectTool } = await import('@/tools/legal-intent-detect.js');
    const out = await legalIntentDetectTool.handler(
      { customer_message: 'Vou abrir uma reclamação no Procon.' } as never,
      ctx,
    );
    expect(out.has_legal_intent).toBe(true);
    expect(out.identified_reasons).toContain('consumer_protection');
  });
});

// ===========================================================================
describe('bank_account_validate — local structural validation + shared checksum', () => {
  it('returns missing fields + warnings for an incomplete bank transfer', async () => {
    const { bankAccountValidateTool } = await import('@/tools/bank-account-validate.js');
    const out = await bankAccountValidateTool.handler(
      { method: 'bank_transfer', bank_code: '12', holder_document: '123' } as never,
      ctx,
    );
    expect(out.valid).toBe(false);
    expect(out.missing_fields).toEqual(
      expect.arrayContaining(['agency', 'account_number', 'holder_name']),
    );
    // bank_code '12' is not 3 digits; holder_document '123' is not CPF/CNPJ length.
    expect(out.warnings).toEqual(expect.arrayContaining(['bank_code_not_three_digits']));
    expect(out.warnings).toContain('holder_document_invalid_length');
  });

  it('reuses the shared CPF/CNPJ CHECKSUM validator (not a length-only check)', async () => {
    const { bankAccountValidateTool } = await import('@/tools/bank-account-validate.js');
    // 11 digits but a BAD check digit — a length-only validator would accept it.
    const bad = await bankAccountValidateTool.handler(
      { method: 'pix', pix_key: 'irrelevante', holder_document: '11144477700' } as never,
      ctx,
    );
    expect(bad.warnings).toContain('holder_document_failed_checksum');
    expect(bad.normalized?.inferred_document_type).toBe('unknown');

    // A genuinely valid CPF passes the checksum → typed cpf, no doc warning.
    const ok = await bankAccountValidateTool.handler(
      { method: 'pix', pix_key: '11144477735', pix_key_type: 'cpf', holder_document: '111.444.777-35' } as never,
      ctx,
    );
    expect(ok.normalized?.inferred_document_type).toBe('cpf');
    expect(ok.warnings).not.toContain('holder_document_failed_checksum');
    expect(ok.valid).toBe(true);
  });

  it('validates a complete PIX payload and flags a key-type mismatch', async () => {
    const { bankAccountValidateTool } = await import('@/tools/bank-account-validate.js');
    const ok = await bankAccountValidateTool.handler(
      { method: 'pix', pix_key: 'fulano@example.com', pix_key_type: 'email' } as never,
      ctx,
    );
    expect(ok.valid).toBe(true);
    expect(ok.missing_fields).toEqual([]);

    const mismatch = await bankAccountValidateTool.handler(
      { method: 'pix', pix_key: 'fulano@example.com', pix_key_type: 'cpf' } as never,
      ctx,
    );
    expect(mismatch.warnings).toContain('pix_key_type_mismatch');
  });

  it('reports missing pix_key for a PIX method', async () => {
    const { bankAccountValidateTool } = await import('@/tools/bank-account-validate.js');
    const out = await bankAccountValidateTool.handler({ method: 'pix' } as never, ctx);
    expect(out.missing_fields).toContain('pix_key');
    expect(out.valid).toBe(false);
  });
});

// ===========================================================================
describe('conversation_summary_generate — wraps the shared summarizer', () => {
  it('declares a read-only contract and maps to the boleto shape', async () => {
    const { conversationSummaryGenerateTool } = await import(
      '@/tools/conversation-summary-generate.js'
    );
    expect(conversationSummaryGenerateTool.side_effect).toBe('none');
    expect(conversationSummaryGenerateTool.operation_type).toBe('read');
    expect(conversationSummaryGenerateTool.audit_action).toBe('conversation_summary_generated');
  });

  it('reads the current conversation, calls the shared summarizer, and maps fields', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      { direcao: 'out', conteudo: 'Enviei o boleto' },
      { direcao: 'in', conteudo: 'Quero pagar' },
    ]);
    callLLMMock.mockResolvedValueOnce({
      content: JSON.stringify({
        summary: 'cliente quer pagar boleto',
        open_questions: ['cliente mencionou advogado?'],
        decisions: ['boleto reenviado'],
        pending_actions: ['confirmar pagamento'],
      }),
    });
    const { conversationSummaryGenerateTool } = await import(
      '@/tools/conversation-summary-generate.js'
    );
    const out = await conversationSummaryGenerateTool.handler({ limit: 50 } as never, ctx);
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 50);
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    // Boleto shape mapping: decisions → main_actions, pending_actions →
    // pending_items, first open_question → escalation_reason.
    expect(out.conversa_id).toBe('c1');
    expect(out.summary).toBe('cliente quer pagar boleto');
    expect(out.main_actions).toEqual(['boleto reenviado']);
    expect(out.pending_items).toEqual(['confirmar pagamento']);
    expect(out.escalation_reason).toBe('cliente mencionou advogado?');
  });

  it('uses caller-provided history (role/content) without hitting the DB', async () => {
    callLLMMock.mockResolvedValueOnce({ content: JSON.stringify({ summary: 's' }) });
    const { conversationSummaryGenerateTool } = await import(
      '@/tools/conversation-summary-generate.js'
    );
    const out = await conversationSummaryGenerateTool.handler(
      { history: [{ role: 'user', content: 'oi' }] } as never,
      ctx,
    );
    expect(recentInConversationMock).not.toHaveBeenCalled();
    expect(out.summary).toBe('s');
  });
});
