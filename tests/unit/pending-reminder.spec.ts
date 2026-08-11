import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbExecuteMock = vi.fn();
// Issue #362: the reminder UPDATE is now a compare-and-swap that ends in
// `.returning({ id })` and skips the send when 0 rows came back (lost race vs
// `pending_expirer`). The mock chain therefore terminates in `returning`, which
// each test seeds: `[{ id }]` = CAS won, `[]` = CAS lost (row expired between
// SELECT and UPDATE).
const dbUpdateReturningMock = vi.fn().mockResolvedValue([{ id: 'pq-1' }]);
const dbUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: dbUpdateReturningMock,
};
const dbUpdateMock = vi.fn().mockReturnValue(dbUpdateChain);
vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
    update: dbUpdateMock,
  },
}));

// Issue #345 (Phase 4): the worker is now a DISPATCHER. It first enumerates the
// (tenant_id, agent_id) tuples with remindable questions, then runs the inner
// once per tuple under `runWithTenantContext`. These tests exercise the INNER
// reminder logic, so:
//   - the enumeration helper yields exactly ONE real tuple,
//   - `runWithTenantContext` is pass-through, and
//   - `getCurrentTenant`/`getCurrentAgent` return that tuple's ids (the inner's
//     scoped JOIN + scoped UPDATE bind them — see worker).
// Net effect: `dbExecuteMock` is consumed ONCE by the inner JOIN exactly as
// before this change (the enumeration uses the repo mock, not `db.execute`).
const listRemindablePairsMock = vi.fn(async () => [
  { tenant_id: 'tenant-A', agent_id: 'agent-A' },
]);
vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    listTenantAgentPairsWithRemindableQuestions: listRemindablePairsMock,
  },
}));
vi.mock('../../src/db/tenant-context.js', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  getCurrentTenant: () => 'tenant-A',
  getCurrentAgent: () => 'agent-A',
}));

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID-REMINDER');
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

// Fase 0 do roteamento multi-linha (spec 2026-07-09 §1.6): o lembrete agora sai
// pela FRONTEIRA ÚNICA de saída — `forCurrentAgentChannel(row.channel_id ?? null)`
// → `line.sendText(jid, texto, { quoted })`. O mock devolve uma linha cujo
// `sendText` delega para o MESMO spy de antes, então as asserções existentes
// sobre (jid, texto, quoted) continuam provando o contrato de envio.
const forCurrentAgentChannelMock = vi.fn(async () => ({
  sendText: (jid: string, text: string, opts?: unknown) =>
    sendOutboundTextMock(jid, text, opts),
}));
vi.mock('../../src/gateway/line-output.js', () => ({
  forCurrentAgentChannel: forCurrentAgentChannelMock,
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
  dbUpdateChain.where.mockReturnThis();
  dbUpdateReturningMock.mockClear();
  dbUpdateReturningMock.mockResolvedValue([{ id: 'pq-1' }]); // CAS won by default
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('WAID-REMINDER');
  forCurrentAgentChannelMock.mockClear();
  auditMock.mockReset();
  listRemindablePairsMock.mockClear();
  listRemindablePairsMock.mockResolvedValue([{ tenant_id: 'tenant-A', agent_id: 'agent-A' }]);
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
          // Fase 0: o SELECT agora projeta `c.channel_id` (LEFT JOIN conversas);
          // NULL = conversa legada sem canal → resolução do canal único do agente.
          channel_id: null,
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
    // Fase 0: o envio resolve a linha pela fronteira única, no canal do pending
    // (NULL legado ⇒ canal único ativo do agente).
    expect(forCurrentAgentChannelMock).toHaveBeenCalledWith(null);
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
          // Fase 0: o SELECT agora projeta `c.channel_id` (LEFT JOIN conversas);
          // NULL = conversa legada sem canal → resolução do canal único do agente.
          channel_id: null,
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
          // Fase 0: o SELECT agora projeta `c.channel_id` (LEFT JOIN conversas);
          // NULL = conversa legada sem canal → resolução do canal único do agente.
          channel_id: null,
        },
      ],
    });
    sendOutboundTextMock.mockRejectedValueOnce(new Error('whatsapp down'));
    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();
    expect(dbUpdateChain.set).toHaveBeenCalled();
    // Send was attempted but failed; the worker did not throw.
  });

  // Issue #362: race between `pending_expirer` (every 1min) and `pending_reminder`
  // (every 30min). The SELECT picks an open/non-expired row, but if `pending_expirer`
  // flips it to `expirada` BEFORE the bookkeeping UPDATE lands, the CAS-guarded
  // UPDATE (status='aberta' AND expira_em > now() AND reminder_count < MAX) matches
  // 0 rows. The worker MUST skip the send and NOT advance reminder_count.
  it('LOST RACE — row concurrently expired between SELECT and UPDATE (CAS matches 0): no send, count not advanced', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-stale',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: {},
          // Fase 0: o SELECT agora projeta `c.channel_id` (LEFT JOIN conversas);
          // NULL = conversa legada sem canal → resolução do canal único do agente.
          channel_id: null,
        },
      ],
    });
    // CAS loses: the row was expired by `pending_expirer` between SELECT and UPDATE,
    // so the guarded UPDATE returns 0 rows.
    dbUpdateReturningMock.mockResolvedValueOnce([]);

    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();

    // The send is CONDITIONAL on the CAS winning — a 0-row UPDATE must skip it.
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    // No stale `pending_reminder_sent` audit, and reminder_count was NOT bumped
    // (the UPDATE that would have set it matched no still-valid row).
    const sent = auditMock.mock.calls.filter((c) => c[0].acao === 'pending_reminder_sent');
    expect(sent).toHaveLength(0);
    const skipped = auditMock.mock.calls.filter(
      (c) => c[0].acao === 'pending_reminder_skipped_stale',
    );
    expect(skipped).toHaveLength(1);
  });

  it('CAS WON — UPDATE matches the still-valid row (1 row): reminder IS sent and count advances', async () => {
    dbExecuteMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'pq-live',
          tipo: 'gate',
          pergunta: 'Confirma?',
          telefone_whatsapp: '+5511988888888',
          outbound_metadata: {
            whatsapp_id: 'WAID-Q',
            remote_jid: '5511988888888@s.whatsapp.net',
          },
          metadata: { reminder_count: 0 },
          channel_id: null,
        },
      ],
    });
    // CAS wins: the row is still open/non-expired, so the guarded UPDATE returns it.
    dbUpdateReturningMock.mockResolvedValueOnce([{ id: 'pq-live' }]);

    const { runPendingReminder } = await import('../../src/workers/pending-reminder.js');
    await runPendingReminder();

    expect(sendOutboundTextMock).toHaveBeenCalledTimes(1);
    const sent = auditMock.mock.calls.filter((c) => c[0].acao === 'pending_reminder_sent');
    expect(sent).toHaveLength(1);
    // reminder_count advanced from 0 → 1 (the metadata the UPDATE persisted).
    expect(sent[0][0].metadata.reminder_count).toBe(1);
  });
});
