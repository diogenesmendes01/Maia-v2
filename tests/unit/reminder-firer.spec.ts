import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbExecuteMock = vi.fn();
const dbSelectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};
const dbSelectMock = vi.fn().mockReturnValue(dbSelectChain);
vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
    select: dbSelectMock,
  },
}));

const sendOutboundTextMock = vi.fn();
const isBaileysConnectedMock = vi.fn().mockReturnValue(true);
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => isBaileysConnectedMock(),
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

const pessoasFindByIdMock = vi.fn();
const mensagensCreateMock = vi.fn();
const factsUpsertMock = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
  mensagensRepo: { create: mensagensCreateMock },
  factsRepo: { upsert: factsUpsertMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  dbExecuteMock.mockReset();
  dbSelectChain.limit.mockReset();
  dbSelectChain.limit.mockResolvedValue([]);
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('WAID-REM');
  isBaileysConnectedMock.mockReset();
  isBaileysConnectedMock.mockReturnValue(true);
  auditMock.mockReset();
  pessoasFindByIdMock.mockReset();
  mensagensCreateMock.mockReset();
  factsUpsertMock.mockReset();
});

const PESSOA = {
  id: 'p1',
  nome: 'Mendes',
  telefone_whatsapp: '+5519989777265',
  status: 'ativa' as const,
};

function dueRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'fact-1',
    escopo: 'pessoa:p1',
    chave: 'reminder.rem-abc',
    valor: {
      id: 'rem-abc',
      pessoa_id: 'p1',
      entidade_id: null,
      quando: new Date(Date.now() - 60_000).toISOString(),
      texto: 'Pagar boleto Vivo',
      canal: 'whatsapp',
      ...overrides,
    },
  };
}

describe('reminder-firer worker', () => {
  it('skips silently when Baileys is disconnected', async () => {
    isBaileysConnectedMock.mockReturnValue(false);
    dbExecuteMock.mockResolvedValue({ rows: [dueRow()] });
    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
  });

  it('fires a due reminder, marks fired_at, audits reminder_fired', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [dueRow()] });
    pessoasFindByIdMock.mockResolvedValue(PESSOA);
    dbSelectChain.limit.mockResolvedValueOnce([
      { metadata: { remote_jid: '168813890908183@lid' } },
    ]);

    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();

    expect(factsUpsertMock).toHaveBeenCalledTimes(1);
    const upsertArg = factsUpsertMock.mock.calls[0]![0] as { valor: Record<string, unknown> };
    expect(typeof upsertArg.valor.fired_at).toBe('string');
    expect(typeof upsertArg.valor.late_minutes).toBe('number');

    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '168813890908183@lid',
      expect.stringContaining('Pagar boleto Vivo'),
    );
    expect(mensagensCreateMock).toHaveBeenCalledTimes(1);
    const m = mensagensCreateMock.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(m.metadata.remote_jid).toBe('168813890908183@lid');
    expect(m.metadata.reminder_id).toBe('rem-abc');

    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'reminder_fired',
      ),
    ).toBe(true);
  });

  it('marks fired with skip_reason when pessoa is inactive', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [dueRow()] });
    pessoasFindByIdMock.mockResolvedValue({ ...PESSOA, status: 'bloqueada' });

    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();

    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(factsUpsertMock).toHaveBeenCalledTimes(1);
    const v = factsUpsertMock.mock.calls[0]![0].valor as Record<string, unknown>;
    expect(v.fired_at).toBeTypeOf('string');
    expect(v.skip_reason).toBe('status_bloqueada');
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'reminder_skipped',
      ),
    ).toBe(true);
  });

  it('falls back to phone-derived JID when no prior inbound exists', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [dueRow()] });
    pessoasFindByIdMock.mockResolvedValue(PESSOA);
    dbSelectChain.limit.mockResolvedValueOnce([]); // no prior inbound

    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();

    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5519989777265@s.whatsapp.net',
      expect.any(String),
    );
  });

  it('marks fired and audits failure even when WhatsApp send throws (no double-fire)', async () => {
    dbExecuteMock.mockResolvedValue({ rows: [dueRow()] });
    pessoasFindByIdMock.mockResolvedValue(PESSOA);
    dbSelectChain.limit.mockResolvedValueOnce([]);
    sendOutboundTextMock.mockRejectedValue(new Error('baileys down'));

    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();

    expect(factsUpsertMock).toHaveBeenCalledTimes(1); // fired_at set BEFORE send
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'reminder_send_failed',
      ),
    ).toBe(true);
  });

  it('handles a malformed valor (missing pessoa_id) by skipping with audit', async () => {
    dbExecuteMock.mockResolvedValue({
      rows: [
        {
          id: 'fact-2',
          escopo: 'pessoa:p1',
          chave: 'reminder.rem-malformed',
          valor: { id: 'rem-malformed', quando: new Date().toISOString() }, // no pessoa_id, no texto
        },
      ],
    });

    const { runReminderFirer } = await import('../../src/workers/reminder-firer.js');
    await runReminderFirer();

    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(
      auditMock.mock.calls.some(
        (c) =>
          (c[0] as { acao: string; metadata?: { skip_reason?: string } }).acao ===
            'reminder_skipped' &&
          (c[0] as { metadata?: { skip_reason?: string } }).metadata?.skip_reason ===
            'malformed_valor',
      ),
    ).toBe(true);
  });
});
