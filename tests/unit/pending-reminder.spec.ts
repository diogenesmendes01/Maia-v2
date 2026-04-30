import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbExecuteMock = vi.fn();
const dbUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};
const dbUpdateMock = vi.fn().mockReturnValue(dbUpdateChain);
vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
    update: dbUpdateMock,
  },
}));

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID-REMINDER');
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PENDING_REMINDER: true, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  dbExecuteMock.mockReset();
  dbUpdateMock.mockClear();
  dbUpdateChain.set.mockClear();
  dbUpdateChain.set.mockReturnThis();
  dbUpdateChain.where.mockClear();
  dbUpdateChain.where.mockResolvedValue(undefined);
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('WAID-REMINDER');
  auditMock.mockReset();
});

describe('pending-reminder worker', () => {
  it('sends a quoted reminder for pending older than 1h with no prior reminder', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-1',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: {},
        },
      ],
    });
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511988888888@s.whatsapp.net',
      expect.stringContaining('Lembra'),
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({ id: 'WAID-Q' }),
        }),
      }),
    );
    const sent = auditMock.mock.calls.filter((c) => c[0].acao === 'pending_reminder_sent');
    expect(sent).toHaveLength(1);
  });

  it('FEATURE_PENDING_REMINDER=false → no-op (no DB scan)', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PENDING_REMINDER: false, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
    }));
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(dbExecuteMock).not.toHaveBeenCalled();
    // Re-establish the default mock so subsequent tests see FEATURE_PENDING_REMINDER=true.
    // doUnmock would let the real env.ts load, which calls process.exit(1) without prod env.
    vi.doMock('../../src/config/env.js', () => ({
      config: { FEATURE_PENDING_REMINDER: true, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
    }));
    vi.resetModules();
  });

  it('skips with audit when no outbound parent found', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-2',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: null,
          metadata: {},
        },
      ],
    });
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    const skipped = auditMock.mock.calls.filter(
      (c) => c[0].acao === 'pending_reminder_skipped_no_outbound',
    );
    expect(skipped).toHaveLength(1);
  });

  it('updates last_reminder_at BEFORE send (crash-during-send guarantee)', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-3',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: {},
        },
      ],
    });
    sendOutboundTextMock.mockRejectedValueOnce(new Error('whatsapp down'));
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(dbUpdateChain.set).toHaveBeenCalled();
    // Send was attempted but failed; the worker did not throw.
  });
});
