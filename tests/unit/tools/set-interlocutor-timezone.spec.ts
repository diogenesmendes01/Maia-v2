import { describe, it, expect, vi, beforeEach } from 'vitest';

const updatePreferenciasMock = vi.fn();
vi.mock('../../../src/db/repositories/pessoa-repos.js', () => ({
  pessoasRepo: { updatePreferencias: updatePreferenciasMock },
}));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/config/env.js', () => ({
  config: { TZ: 'America/Sao_Paulo' },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  updatePreferenciasMock.mockReset();
  auditMock.mockReset();
});

function mkCtx(preferencias: Record<string, unknown> = {}) {
  return {
    pessoa: { id: 'owner-id', preferencias },
    conversa: { id: 'c1' },
    scope: { entidades: [], byEntity: new Map() },
    mensagem_id: 'm1',
    request_id: 'r1',
    idempotency_key: 'ik1',
  } as never;
}

describe('set_interlocutor_timezone tool', () => {
  it('persists a valid IANA zone into preferencias.timezone and audits', async () => {
    const { setInterlocutorTimezoneTool } = await import(
      '../../../src/tools/set-interlocutor-timezone.js'
    );
    const result = await setInterlocutorTimezoneTool.handler(
      { timezone: 'Europe/Lisbon' },
      mkCtx({ idioma: 'pt' }),
    );
    expect(result).toEqual({ pessoa_id: 'owner-id', timezone: 'Europe/Lisbon' });
    // Read-modify-write: existing prefs preserved, timezone merged in.
    expect(updatePreferenciasMock).toHaveBeenCalledWith('owner-id', {
      idioma: 'pt',
      timezone: 'Europe/Lisbon',
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0]![0] as { acao: string; metadata: { timezone: string } };
    expect(call.acao).toBe('interlocutor_timezone_set');
    expect(call.metadata.timezone).toBe('Europe/Lisbon');
  });

  it('rejects an invalid timezone at the schema boundary (no write, no audit)', async () => {
    const { setInterlocutorTimezoneTool } = await import(
      '../../../src/tools/set-interlocutor-timezone.js'
    );
    const parsed = setInterlocutorTimezoneTool.input_schema.safeParse({
      timezone: 'Mars/Phobos',
    });
    expect(parsed.success).toBe(false);
    expect(updatePreferenciasMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('is gated by the schedule_reminder action and is a self-scoped write', async () => {
    const { setInterlocutorTimezoneTool } = await import(
      '../../../src/tools/set-interlocutor-timezone.js'
    );
    expect(setInterlocutorTimezoneTool.required_actions).toEqual(['schedule_reminder']);
    expect(setInterlocutorTimezoneTool.side_effect).toBe('write');
  });
});
