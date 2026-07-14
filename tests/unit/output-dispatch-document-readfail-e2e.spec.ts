/**
 * Codex #216 round-4 (non-blocking suggestion) — INTEGRATED proof of the full
 * document silent-drop chain: a REAL readFile failure flows through the REAL
 * `sendOutboundDocument` (which now THROWS) → REAL `dispatchOutput` → tagged
 * `OutboundDeliveryError(delivered:false)`. The sibling specs prove the links
 * separately (baileys throws; dispatch maps a mockRejectedValue); this locks the
 * two together so a regression in either layer can't silently reopen the drop.
 *
 * baileys is REAL here (only `@whiskeysockets/baileys` + the redis/queue
 * transitive deps are stubbed so the module loads without TCP), and
 * `node:fs/promises` is REAL so `readFile` genuinely fails on a missing path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

const { sendMessage, fakeSocket, cleanupPDF } = vi.hoisted(() => {
  const sendMessage = vi.fn();
  return { sendMessage, fakeSocket: { sendMessage }, cleanupPDF: vi.fn() };
});

// --- stubs so importing the REAL baileys.ts doesn't open TCP / auth state ---
vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  downloadMediaMessage: vi.fn(),
}));
vi.mock('@/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('@/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('@/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/gateway/dedup.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  markSeen: vi.fn(),
}));

// --- dispatchOutput's other (non-gateway) deps ---
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    createInbound: vi.fn(),
  },
  pessoasRepo: { findById: vi.fn() },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(tmpdir(), '.baileys-readfail-e2e'),
    FEATURE_OUTBOUND_VOICE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_PDF_REPORTS: true,
  },
}));
vi.mock('@/lib/tts.js', () => ({ synthesizeSpeech: vi.fn(), OUTBOUND_VOICE_MAX_CHARS: 300 }));
vi.mock('@/gateway/presence.js', () => ({
  quotedReplyContext: () => undefined,
  sendReaction: vi.fn(),
  sendPoll: vi.fn(),
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('@/agent/reflection.js', () => ({ detectCorrection: () => false }));
vi.mock('@/agent/pdf-cleanup.js', () => ({ cleanupPDF }));

import { dispatchOutput, safeDispatchOutput, OutboundDeliveryError } from '@/agent/output-dispatch.js';
import * as baileys from '@/gateway/baileys.js';

const pessoa = { id: 'p_1', telefone_whatsapp: '+5511999999999', preferencias: null } as unknown as Pessoa;
const conversa = { id: 'c_1' } as Conversa;
const inbound = { id: 'msg_1', conteudo: 'manda o extrato', metadata: null, tipo: 'texto' } as unknown as Mensagem;

// Fresh ctx each call with a NEW random missing path so the real readFile is the
// thing that fails (deterministically — the file cannot pre-exist).
function mkPdfCtx(): Parameters<typeof dispatchOutput>[0] {
  return {
    pessoa,
    conversa,
    inbound,
    jid: '5511999999999@s.whatsapp.net',
    text: 'Segue o extrato.',
    latestPending: null,
    latestReportPdf: {
      path: join(tmpdir(), `nope-${Math.random().toString(36).slice(2)}.pdf`),
      fileName: 'extrato.pdf',
      mimetype: 'application/pdf',
      tipo: 'extrato',
    },
    turnHasSensitive: false,
    sensitiveTools: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // REAL baileys socket set CONNECTED, so sendOutboundDocument passes the
  // connection guard and reaches readFile (which fails on the missing path).
  (
    baileys as unknown as {
      _internal: { _setSocketForTests: (s: unknown, c: boolean) => void };
    }
  )._internal._setSocketForTests(fakeSocket as never, true);
});

describe('dispatchOutput — document readFile failure (integrated, Codex #216 round-4)', () => {
  it('real readFile failure → real sendOutboundDocument throws → delivered:false (not a silent drop)', async () => {
    const err = await dispatchOutput(mkPdfCtx()).catch((e) => e);

    expect(err).toBeInstanceOf(OutboundDeliveryError);
    // readFile failed BEFORE the send → nothing reached the user → recoverable.
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    // The socket was never asked to send (the throw came from readFile).
    expect(sendMessage).not.toHaveBeenCalled();
    // The tmp PDF cleanup still ran via `finally`.
    expect(cleanupPDF).toHaveBeenCalledOnce();
  });

  it('through safeDispatchOutput ⇒ { status: "not_sent" } — the contract the skill caller maps', async () => {
    // Same real chain, one level up: the centralised wrapper must classify the
    // readFile failure as not_sent (→ caller falls through to ReAct), never as a
    // silently-handled delivery.
    const outcome = await safeDispatchOutput(mkPdfCtx());

    expect(outcome).toMatchObject({ status: 'not_sent' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cleanupPDF).toHaveBeenCalledOnce();
  });
});
