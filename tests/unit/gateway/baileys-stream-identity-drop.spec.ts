/**
 * Issue #505 — o DESFECHO de um ingresso cuja identidade de stream é
 * irresolúvel, no CALL SITE REAL do gateway.
 *
 * ─── Por que este arquivo existe além do teste do repositório ─────────────
 *
 * `tests/unit/db/createinbound-stream-fail-closed.spec.ts` prova que
 * `mensagensRepo.createInbound` RECUSA e não persiste. Isso é a metade da
 * invariante. A outra metade é o que o gateway faz com a recusa, e ela não é
 * observável de lá:
 *
 *   * a mensagem é DERRUBADA — não vira `baileys.handle_failed` opaco, e não
 *     segue para a fila;
 *   * a recusa vira `audit_log` (`stream_ingress_rejected`) e duas séries de
 *     métrica com vocabulário FECHADO.
 *
 * Essa divisão não é arbitrária: `src/db/repositories/` é COMPARTILHADO com o
 * console `admin-ui`, e `tests/unit/config/admin-import-boundary.spec.ts`
 * proíbe que ele alcance a camada de métrica (que alcança `src/config/env.ts`).
 * A decisão fica no repositório; o relato, aqui. Este teste é o que impede o
 * relato de sumir sem que nada fique vermelho.
 *
 * Entrada pelo `ingressUpsertMessage` REAL — o mesmo ponto por onde o Baileys
 * entrega `messages.upsert`. Nada aqui reconstrói o caminho.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  createInboundMock,
  enqueueAgentMock,
  resolveScopeForJidMock,
  auditMock,
  counterMock,
  loggerMock,
} = vi.hoisted(() => ({
  createInboundMock: vi.fn(),
  enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
  resolveScopeForJidMock: vi.fn(),
  auditMock: vi.fn().mockResolvedValue(undefined),
  counterMock: vi.fn(),
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
  downloadMediaMessage: vi.fn(),
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('../../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: join(tmpdir(), 'maia-stream-drop-auth'),
    FEATURE_PRESENCE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_MESSAGE_DEBOUNCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_TURN_STATE_MACHINE: false,
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({ logger: loggerMock }));
vi.mock('../../../src/db/repositories.js', () => ({
  mensagensRepo: { createInbound: createInboundMock },
}));
vi.mock('../../../src/gateway/dedup.js', () => ({
  isDuplicate: vi.fn().mockResolvedValue(false),
  markSeen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: enqueueAgentMock,
  shutdownQueue: vi.fn(),
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/observability/metrics.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, counter: counterMock };
});
vi.mock('../../../src/gateway/jid-tenant-resolver.js', () => ({
  resolveScopeForJid: resolveScopeForJidMock,
}));
vi.mock('../../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../../src/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: vi.fn().mockResolvedValue(false),
}));

const { ingressUpsertMessage } = await import('../../../src/gateway/baileys.js');
const { StreamIdentityUnresolvedError } = await import(
  '../../../src/runtime/turns/stream-key.js'
);

const WAID = 'WAID-STREAM-DROP-1';

function textMsg() {
  return {
    key: { fromMe: false, remoteJid: '5511999990001@s.whatsapp.net', id: WAID },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Cliente',
    message: { conversation: 'oi' },
  } as never;
}

beforeEach(() => {
  createInboundMock.mockReset();
  enqueueAgentMock.mockClear();
  auditMock.mockClear();
  counterMock.mockClear();
  loggerMock.error.mockClear();
  loggerMock.warn.mockClear();
  resolveScopeForJidMock.mockReset();
  resolveScopeForJidMock.mockResolvedValue({
    scope: { tenant_id: 'tenant-x', agent_id: 'agent-x', channel_id: 'ch-1' },
    jid_context: {
      via_lid_fallback: false,
      resolved_phone_e164: '+5511999990001',
      raw_jid: '5511999990001@s.whatsapp.net',
      lid_recovery_source: null,
    },
  });
});

describe('#505 — identidade de stream irresolúvel derruba o ingresso com trilha', () => {
  it('não vira erro opaco, NÃO enfileira, audita e mede', async () => {
    createInboundMock.mockRejectedValue(
      new StreamIdentityUnresolvedError('missing_channel'),
    );

    // O desfecho é o MESMO que este arquivo já dá a toda falha de resolução —
    // derrubar a mensagem COM trilha. O que NÃO pode acontecer é o erro
    // escapar até o `catch` do listener e virar `baileys.handle_failed`, que
    // perde o motivo tipado e some com o audit.
    await expect(ingressUpsertMessage(textMsg())).resolves.toBe('handled');
    expect(loggerMock.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'baileys.handle_failed',
    );

    // A mensagem NÃO seguiu para a fila.
    expect(enqueueAgentMock).not.toHaveBeenCalled();

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'stream_ingress_rejected',
        metadata: expect.objectContaining({
          reason: 'missing_channel',
          channel_kind: 'whatsapp',
          whatsapp_id: WAID,
        }),
      }),
    );
    expect(counterMock).toHaveBeenCalledWith(
      'maia_stream_ingress_rejected_total',
      expect.objectContaining({ reason: 'missing_channel' }),
    );
    expect(counterMock).toHaveBeenCalledWith(
      'maia_stream_ingress_total',
      expect.objectContaining({ channel_kind: 'whatsapp', result: 'rejected' }),
    );
  });

  it('NENHUMA série desta fronteira carrega stream_key, jid, telefone ou turn_id como LABEL', async () => {
    // A issue proíbe explicitamente: "Não usar `stream_key`, `remote_jid`,
    // `turn_id` ou conteúdo como labels". São as três dimensões cuja
    // cardinalidade cresce com o TRÁFEGO.
    createInboundMock.mockRejectedValue(
      new StreamIdentityUnresolvedError('unnormalizable_remote_identity'),
    );
    await ingressUpsertMessage(textMsg());

    const proibidos = ['stream_key', 'remote_jid', 'jid', 'telefone', 'turn_id', 'mensagem_id'];
    for (const [, labels] of counterMock.mock.calls) {
      for (const chave of Object.keys((labels ?? {}) as Record<string, unknown>)) {
        expect(proibidos).not.toContain(chave);
      }
    }
  });

  it('um erro que NÃO é de identidade de stream continua propagando', async () => {
    // A rede não pode virar um `catch` genérico: um bug de banco tem de
    // continuar visível como falha do envelope (`dropped` +
    // `baileys.handle_failed`), e NÃO pode ser auditado como recusa de stream —
    // isso inventaria uma decisão de fronteira que ninguém tomou.
    createInboundMock.mockRejectedValue(new Error('conexão caiu'));
    await expect(ingressUpsertMessage(textMsg())).resolves.toBe('dropped');
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.anything(),
      'baileys.handle_failed',
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'stream_ingress_rejected' }),
    );
  });

  it('ingresso resolvido: sequência registrada e série `resolved` incrementada', async () => {
    createInboundMock.mockResolvedValue({
      row: {
        id: 'msg-1',
        stream_key: 'v1:' + 'a'.repeat(64),
        stream_key_version: 1,
        ingress_seq: 1,
      },
      duplicate: false,
    });
    await ingressUpsertMessage(textMsg());

    expect(counterMock).toHaveBeenCalledWith(
      'maia_stream_ingress_total',
      expect.objectContaining({ channel_kind: 'whatsapp', result: 'resolved' }),
    );
    // `ingress_seq === 1` é o NASCIMENTO da stream — o único ingresso que vira
    // `audit_log`. Os subsequentes ficam só no log estruturado.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'stream_ingress_sequenced',
        metadata: expect.objectContaining({ ingress_seq: 1, event: 'stream_opened' }),
      }),
    );
  });

  it('reentrega (duplicate) NÃO registra sequência de novo', async () => {
    // A reentrega reusa a sequência da row original; contá-la aqui registraria
    // a mesma posição duas vezes na trilha.
    createInboundMock.mockResolvedValue({
      row: {
        id: 'msg-1',
        stream_key: 'v1:' + 'a'.repeat(64),
        stream_key_version: 1,
        ingress_seq: 1,
      },
      duplicate: true,
    });
    await ingressUpsertMessage(textMsg());

    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'stream_ingress_sequenced' }),
    );
    expect(counterMock).not.toHaveBeenCalledWith(
      'maia_stream_ingress_total',
      expect.objectContaining({ result: 'resolved' }),
    );
  });
});
