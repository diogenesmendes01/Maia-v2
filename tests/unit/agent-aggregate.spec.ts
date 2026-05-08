import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable hoisted config so individual tests can flip FEATURE_MESSAGE_DEBOUNCE
// without re-mocking the module. The reference is shared with the mock factory.
const h = vi.hoisted(() => ({
  listUnprocessedByTelefone: vi.fn(),
  config: {
    BAILEYS_AUTH_DIR: '/tmp/test',
    FEATURE_PRESENCE: false,
    FEATURE_PENDING_GATE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_PDF_REPORTS: false,
    FEATURE_OUTBOUND_VOICE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_DEBOUNCE: true,
    OWNER_TELEFONE_WHATSAPP: '+5511000000000',
  },
}));

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: {
    findById: vi.fn(),
    setConversaId: vi.fn(),
    setConversaIdMany: vi.fn(),
    markProcessed: vi.fn(),
    create: vi.fn(),
    listUnprocessedByTelefone: h.listUnprocessedByTelefone,
  },
  conversasRepo: { touch: vi.fn() },
  pessoasRepo: { findById: vi.fn() },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: h.config,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/governance/permissions.js', () => ({ resolveScope: vi.fn() }));
vi.mock('../../src/lib/claude.js', () => ({ callLLM: vi.fn() }));
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: vi.fn(),
  sendOutboundDocument: vi.fn(),
  sendOutboundVoice: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(),
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll: vi.fn(),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn(),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(),
  handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/agent/pending-gate.js', () => ({ checkPendingFirst: vi.fn() }));
vi.mock('../../src/agent/prompt-builder.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn(),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool: vi.fn() }));
vi.mock('../../src/tools/_registry.js', () => ({ REGISTRY: {}, getToolSchemas: () => [] }));
vi.mock('../../src/lib/tts.js', () => ({
  synthesizeSpeech: vi.fn(),
  OUTBOUND_VOICE_MAX_CHARS: 500,
}));
vi.mock('../../src/gateway/debouncer.js', () => ({
  clearDebounceState: vi.fn(),
}));

import { _internal } from '../../src/agent/core.js';

const TEL = '+5511999999999';

// Fixed clock so tests can reason about created_at deterministically:
// the target sits at T0; older siblings at T0-1s, T0-2s; newer at T0+1s.
const T0 = new Date('2026-05-08T12:00:00Z');
const T_MINUS_1 = new Date(T0.getTime() - 1000);
const T_MINUS_2 = new Date(T0.getTime() - 2000);
const T_PLUS_1 = new Date(T0.getTime() + 1000);

const mkInbound = (over: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  id: 'target-id',
  conversa_id: 'conv-1',
  direcao: 'in',
  tipo: 'texto',
  conteudo: '',
  midia_url: null,
  metadata: { telefone: TEL },
  processada_em: null,
  ferramentas_chamadas: [],
  tokens_usados: null,
  created_at: T0,
  ...over,
});

describe('aggregateUnprocessedTexts', () => {
  beforeEach(() => {
    h.listUnprocessedByTelefone.mockReset();
    // Default: feature on. Off-flag tests set it explicitly.
    h.config.FEATURE_MESSAGE_DEBOUNCE = true;
  });

  it('returns target text alone when there are no unprocessed siblings', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([]);
    const target = mkInbound({ conteudo: 'da empresa X?' });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('da empresa X?');
    expect(result.merged_ids).toEqual([]);
    expect(h.listUnprocessedByTelefone).toHaveBeenCalledWith(TEL, { excludeId: 'target-id' });
  });

  it('aggregates orphan siblings (conversa_id NULL) — the real-world chunked-typing case', async () => {
    // Real flow: baileys saves all inbounds with conversa_id NULL. By the
    // time the debounce job fires, only the target has been resolved by
    // the agent. Earlier chunks are still NULL — the aggregator MUST find
    // them. This is the regression test for the original bug.
    h.listUnprocessedByTelefone.mockResolvedValue([
      mkInbound({ id: 's1', conversa_id: null, conteudo: 'Oi, como esta', tipo: 'texto', created_at: T_MINUS_2 }),
      mkInbound({ id: 's2', conversa_id: null, conteudo: 'as finanças', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ id: 'target-id', conversa_id: 'conv-1', conteudo: 'da empresa X?', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('Oi, como esta\nas finanças\nda empresa X?');
    expect(result.merged_ids).toEqual(['s1', 's2']);
  });

  it('aggregates already-attached siblings whose conversa_id matches the target', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([
      mkInbound({ id: 's1', conversa_id: 'conv-1', conteudo: 'attached early', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ id: 'target-id', conversa_id: 'conv-1', conteudo: 'tail', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('attached early\ntail');
    expect(result.merged_ids).toEqual(['s1']);
  });

  it('rejects siblings already attached to a DIFFERENT conversa (cross-conversation guard)', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([
      mkInbound({ id: 's1', conversa_id: 'conv-2', conteudo: 'foreign', tipo: 'texto', created_at: T_MINUS_1 }),
      mkInbound({ id: 's2', conversa_id: null, conteudo: 'orphan ours', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ id: 'target-id', conversa_id: 'conv-1', conteudo: 'tail', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('orphan ours\ntail');
    expect(result.merged_ids).toEqual(['s2']);
  });

  it('skips siblings with empty/null content', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([
      mkInbound({ id: 's1', conversa_id: null, conteudo: 'real', tipo: 'texto', created_at: T_MINUS_1 }),
      mkInbound({ id: 's2', conversa_id: null, conteudo: null, tipo: 'texto', created_at: T_MINUS_1 }),
      mkInbound({ id: 's3', conversa_id: null, conteudo: '', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ conteudo: 'tail', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('real\ntail');
    expect(result.merged_ids).toEqual(['s1']);
  });

  it('does NOT aggregate audio/imagem/documento siblings — only texto', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([
      mkInbound({ id: 'a1', conversa_id: null, conteudo: 'caption', tipo: 'audio', created_at: T_MINUS_1 }),
      mkInbound({ id: 'i1', conversa_id: null, conteudo: 'caption', tipo: 'imagem', created_at: T_MINUS_1 }),
      mkInbound({ id: 'd1', conversa_id: null, conteudo: 'caption', tipo: 'documento', created_at: T_MINUS_1 }),
      mkInbound({ id: 't1', conversa_id: null, conteudo: 'real text', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ conteudo: 'tail', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('real text\ntail');
    expect(result.merged_ids).toEqual(['t1']);
  });

  // Gate 1: feature flag.
  it('off-flag: short-circuits without DB call — preserves "1 inbound, 1 turn" semantics', async () => {
    h.config.FEATURE_MESSAGE_DEBOUNCE = false;
    const target = mkInbound({ conteudo: 'lonely chunk' });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('lonely chunk');
    expect(result.merged_ids).toEqual([]);
    // Crucial: with debounce off, baileys enqueues 1 job per message. If we
    // queried the DB here we could pull a FUTURE sibling into THIS turn
    // (wrong order) and mark it processed before its own job runs.
    expect(h.listUnprocessedByTelefone).not.toHaveBeenCalled();
  });

  // Gate 2: chronology guard — never aggregate FUTURE siblings.
  it('rejects siblings with created_at AFTER the target (DLQ replay / recovery requeue guard)', async () => {
    h.listUnprocessedByTelefone.mockResolvedValue([
      // Future sibling — must NOT be folded in. This is the bug the user flagged:
      // with debounce off, job(M1) target=M1, but listUnprocessedByTelefone
      // returns the (future) M2 → would yield "M2\nM1" + premature mark-processed.
      // Even with debounce on, message-recovery requeueing an old stuck job
      // could trigger this — gate 2 protects both paths.
      mkInbound({ id: 'future-1', conversa_id: null, conteudo: 'arrived after target', tipo: 'texto', created_at: T_PLUS_1 }),
      mkInbound({ id: 'past-1', conversa_id: null, conteudo: 'arrived before target', tipo: 'texto', created_at: T_MINUS_1 }),
    ]);
    const target = mkInbound({ conteudo: 'target', created_at: T0 });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('arrived before target\ntarget');
    expect(result.merged_ids).toEqual(['past-1']);
  });

  it('returns target text with no merge when telefone is missing from metadata', async () => {
    const target = mkInbound({ metadata: {}, conteudo: 'lonely' });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('lonely');
    expect(result.merged_ids).toEqual([]);
    expect(h.listUnprocessedByTelefone).not.toHaveBeenCalled();
  });

  it('returns target text with no merge when metadata is null', async () => {
    const target = mkInbound({ metadata: null, conteudo: 'lonely' });

    const result = await _internal.aggregateUnprocessedTexts(target as never);

    expect(result.text).toBe('lonely');
    expect(result.merged_ids).toEqual([]);
    expect(h.listUnprocessedByTelefone).not.toHaveBeenCalled();
  });
});
