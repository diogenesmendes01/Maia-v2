import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-pdf-flow-test-' + Date.now());

const { flagState, dbState } = vi.hoisted(() => ({
  flagState: { FEATURE_PDF_REPORTS: true, FEATURE_VIEW_ONCE_SENSITIVE: false, FEATURE_ONE_TAP: false, FEATURE_PENDING_GATE: false },
  dbState: { conversaResult: [] as unknown[] },
}));

const sendOutboundText = vi.fn();
const sendOutboundDocument = vi.fn();
const findById = vi.fn();
const audit = vi.fn();
const createMensagem = vi.fn();
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const recentInConversation = vi.fn();
const dispatchTool = vi.fn();
const callLLM = vi.fn();
const buildPrompt = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText, sendOutboundDocument, isBaileysConnected: () => true,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem,
    findById: findMensagem,
    markProcessed,
    recentInConversation,
    setConversaId: vi.fn(),
    createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/db/client.js', () => {
  const fakeQuery = {
    from: () => fakeQuery, innerJoin: () => fakeQuery, where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return { db: { select: () => fakeQuery }, withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) };
});
vi.mock('../../src/db/schema.js', () => ({ conversas: {}, pessoas: {} }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'FEATURE_PDF_REPORTS') return flagState.FEATURE_PDF_REPORTS;
      if (prop === 'FEATURE_VIEW_ONCE_SENSITIVE') return flagState.FEATURE_VIEW_ONCE_SENSITIVE;
      if (prop === 'FEATURE_ONE_TAP') return flagState.FEATURE_ONE_TAP;
      if (prop === 'FEATURE_PENDING_GATE') return flagState.FEATURE_PENDING_GATE;
      if (prop === 'OWNER_TELEFONE_WHATSAPP') return '+5511999999999';
      return undefined;
    },
  }),
}));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt, PROMPT_TOKEN_BUDGET_INPUT: 11000, PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));
vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(), handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(), quotedReplyContext: vi.fn(), sendPoll: vi.fn(),
}));
vi.mock('../../src/workflows/pending-questions.js', () => ({ getActivePending: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(), findPreviousAssistantMessage: vi.fn(),
}));

const PESSOA = { id: 'p1', telefone_whatsapp: '+5511888888888', nome: 'Owner', tipo: 'owner', preferencias: {} } as never;
const CONVERSA = { id: 'c1', pessoa_id: 'p1', status: 'ativa' } as never;
const INBOUND = { id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'texto' as const, conteudo: 'manda extrato', metadata: { whatsapp_id: 'WAID-IN' }, processada_em: null };

describe('agent loop — PDF flow (B3b)', () => {
  let pdfPath: string;

  beforeAll(async () => {
    await mkdir(join(SANDBOX, 'media', 'tmp'), { recursive: true });
  });
  afterAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true });
  });

  beforeEach(async () => {
    callLLM.mockReset(); dispatchTool.mockReset();
    sendOutboundText.mockReset(); sendOutboundDocument.mockReset();
    audit.mockReset(); createMensagem.mockReset();
    findById.mockReset(); findMensagem.mockReset(); markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findMensagem.mockResolvedValue({ ...INBOUND });
    findById.mockResolvedValue(PESSOA);
    sendOutboundDocument.mockResolvedValue('WAID-OUT');
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];

    pdfPath = join(SANDBOX, 'media', 'tmp', `${Math.random().toString(36).slice(2)}.pdf`);
    await writeFile(pdfPath, '%PDF-1.4 sample\n%%EOF');
  });

  it('routes to sendOutboundDocument when generate_report ran; emits outbound_sent_document audit; unlinks tmp', async () => {
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Aqui está o extrato de Outubro:',
      tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath,
      fileName: 'extrato-empresa-x-2026-04.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026', rowCount: 3, totals: { receita: 100, despesa: 50, lucro: 50 } },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    // sendOutboundText must NOT have been called (PDF route taken instead)
    expect(sendOutboundText).not.toHaveBeenCalled();
    // sendOutboundDocument WAS called with the right shape
    expect(sendOutboundDocument).toHaveBeenCalledTimes(1);
    const [jid, path, opts] = sendOutboundDocument.mock.calls[0]!;
    expect(jid).toMatch(/@s\.whatsapp\.net$/);
    expect(path).toBe(pdfPath);
    expect(opts).toMatchObject({
      mimetype: 'application/pdf',
      fileName: 'extrato-empresa-x-2026-04.pdf',
      caption: 'Aqui está o extrato de Outubro:',
    });
    // audit fired
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).toContain('outbound_sent_document');
    // mensagens row created with tipo=documento, midia_url=null
    const docMensagem = createMensagem.mock.calls.find((c) => c[0].tipo === 'documento')?.[0];
    expect(docMensagem).toBeDefined();
    expect(docMensagem.midia_url).toBeNull();
    // tmp file unlinked
    await expect(import('node:fs/promises').then((m) => m.access(pdfPath))).rejects.toThrow();
  });

  it('null WAID (Baileys disconnected) → no audit; tmp file STILL unlinked', async () => {
    sendOutboundDocument.mockResolvedValueOnce(null);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'Aqui está', tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath, fileName: 'x.pdf', mimetype: 'application/pdf', tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026' },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).not.toContain('outbound_sent_document');
    await expect(import('node:fs/promises').then((m) => m.access(pdfPath))).rejects.toThrow();
  });

  it('caption truncated to 1024 chars', async () => {
    const longText = 'x'.repeat(2000);
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    callLLM.mockResolvedValueOnce({
      content: longText, tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath, fileName: 'x.pdf', mimetype: 'application/pdf', tipo: 'extrato',
      summary: { period: '01/04/2026 a 30/04/2026' },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    const [, , opts] = sendOutboundDocument.mock.calls[0]!;
    expect(opts.caption.length).toBe(1024);
  });

  it('non-generate_report turn falls through to sendOutboundText (existing behaviour)', async () => {
    callLLM.mockResolvedValueOnce({
      content: 'plain reply', tool_uses: [], usage: { input_tokens: 50, output_tokens: 20 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(sendOutboundDocument).not.toHaveBeenCalled();
  });
});
