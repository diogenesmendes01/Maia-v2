/**
 * Issue #518 — `channelLines` router: pareamento de linha WhatsApp pelo Admin
 * AUTENTICADO, sem bootstrap token em lugar nenhum.
 *
 * O que estes testes travam:
 *   - RBAC: viewer/analyst/compliance_officer recebem FORBIDDEN em TODAS as
 *     procedures (o QR é credencial, não é dado de leitura geral);
 *   - isolamento: canal de outro tenant não existe (NOT_FOUND) e o
 *     tenant vem da SESSÃO, nunca do body;
 *   - listagem inclui canal INATIVO (o whatsapp nasce declarado — antes ele
 *     sumia da tela);
 *   - idempotência do start e conflito determinístico de pairing concorrente;
 *   - auditoria com o ATOR administrativo e SEM QR/código/token;
 *   - rate limit fail-closed;
 *   - keyring ausente ⇒ PRECONDITION_FAILED (nunca material em claro).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const materialMock = vi.hoisted(() => ({
  configured: true,
  open: vi.fn(() => ({ kind: 'code' as const, code: '4F7K2M9Q' })),
}));

vi.mock('@/setup/pairing-material.js', () => ({
  isPairingMaterialConfigured: () => materialMock.configured,
  openPairingMaterial: (...a: unknown[]) => materialMock.open(...(a as [])),
  PAIRING_MATERIAL_TTL_MS: 90_000,
}));

import { channelLinesRouter } from '@/admin-ui/trpc/routers/channelLines.js';
import { _resetRateLimitForTests } from '@/admin-ui/trpc/rate-limit.js';

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';

type LineOpts = {
  /** `null` ⇒ o canal não existe NESTE escopo (linha de outro tenant). */
  line?: Record<string, unknown> | null;
  state?: Record<string, unknown> | null;
  requestResult?: Record<string, unknown>;
  deactivateRowCount?: number;
};

function baseLine(over: Record<string, unknown> = {}) {
  return {
    channel_id: CHANNEL_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    external_id: '+5511900001111',
    channel_type: 'whatsapp',
    display_name: 'Linha comercial',
    active: false,
    is_synthetic: false,
    state: 'declared',
    pairing_method: null,
    pairing_started_at: null,
    pairing_expires_at: null,
    pairing_attempts: 0,
    reason_code: null,
    verified_at: null,
    connected_at: null,
    disconnected_at: null,
    last_transition_at: null,
    command: null,
    ...over,
  };
}

function makeCtx(role: string, opts: LineOpts = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const commands: Array<Record<string, unknown>> = [];
  const disabled: string[] = [];

  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      adminAuditLogRepo: {
        async append(row: Record<string, unknown>) {
          audits.push(row);
          return row;
        },
      },
      channelsRepo: {
        async deactivate(id: string) {
          disabled.push(id);
          return { rowCount: opts.deactivateRowCount ?? 1 };
        },
      },
      rolesRepo: {
        async listActive() {
          return [{ id: 'role-1', role_key: 'atendente' }];
        },
      },
      channelPoliciesRepo: {
        async getByChannelId(id: string) {
          return id === CHANNEL_ID ? null : { id: 'pol-1', default_role_id: 'role-1' };
        },
      },
      channelLineStateRepo: {
        async listLinesForScope() {
          return [
            baseLine(),
            baseLine({
              channel_id: OTHER_CHANNEL_ID,
              external_id: '+5511900002222',
              active: true,
              state: 'connected',
            }),
          ];
        },
        async getForScope() {
          return opts.line === undefined ? baseLine() : opts.line;
        },
        async getStateForScope() {
          return opts.state === undefined ? null : opts.state;
        },
        async requestCommand(args: Record<string, unknown>) {
          commands.push(args);
          return (
            opts.requestResult ?? {
              ok: true,
              idempotent: false,
              row: { pairing_attempts: 1, pairing_expires_at: new Date('2026-07-28T12:15:00Z') },
            }
          );
        },
        /**
         * P2 do review PR #528: comando + `admin_audit_log` no MESMO commit.
         * O stub reproduz o contrato — a trilha só é escrita quando houve
         * escrita de verdade (nunca num replay idempotente).
         */
        async requestCommandWithAudit(
          args: Record<string, unknown> & { audit: Record<string, unknown> },
        ) {
          commands.push(args);
          const result = opts.requestResult ?? {
            ok: true,
            idempotent: false,
            row: { pairing_attempts: 1, pairing_expires_at: new Date('2026-07-28T12:15:00Z') },
          };
          if (result.ok && !result.idempotent) {
            const audit = args.audit as { change_summary: Record<string, unknown> };
            audits.push({
              tenant_id: (args.scope as { tenant_id: string }).tenant_id,
              resource_type: 'channel',
              resource_id: (args.scope as { channel_id: string }).channel_id,
              ...args.audit,
              change_summary: {
                ...audit.change_summary,
                attempt: (result as { row: { pairing_attempts: number } }).row.pairing_attempts,
              },
            });
          }
          return result;
        },
        async disableLineWithAudit(
          args: Record<string, unknown> & { audit: Record<string, unknown> },
        ) {
          const scope = args.scope as { tenant_id: string; channel_id: string };
          if (opts.deactivateRowCount === 0) {
            return { ok: false, reason: 'channel_not_found' };
          }
          disabled.push(scope.channel_id);
          commands.push({ ...args, command: 'stop_line' });
          audits.push({
            tenant_id: scope.tenant_id,
            resource_type: 'channel',
            resource_id: scope.channel_id,
            ...args.audit,
          });
          return { ok: true };
        },
        async markDisabled() {
          return undefined;
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant(input_tenant: string) {
      if (role === 'founder') return;
      if (input_tenant !== 'tenant-A') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Tenant isolation violation' });
      }
    },
    assertRole(...allowed: string[]) {
      if (!allowed.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `Role ${role} not allowed` });
      }
    },
  };

  return { ctx, audits, commands, disabled };
}

function caller(ctx: ReturnType<typeof makeCtx>['ctx']) {
  return channelLinesRouter.createCaller(ctx as never);
}

const REASON = 'Parear a linha comercial recém-declarada';

beforeEach(() => {
  _resetRateLimitForTests();
  materialMock.configured = true;
  materialMock.open.mockReset();
  materialMock.open.mockReturnValue({ kind: 'code', code: '4F7K2M9Q' });
});

describe('RBAC — o QR é credencial, não é leitura geral', () => {
  for (const role of ['viewer', 'analyst', 'compliance_officer']) {
    it(`${role} recebe FORBIDDEN em list/status/start/abort/disable/repair`, async () => {
      const { ctx } = makeCtx(role);
      const c = caller(ctx);
      const calls: Array<Promise<unknown>> = [
        c.list({ agentId: 'agent-a' }),
        c.getPairingStatus({ agentId: 'agent-a', channelId: CHANNEL_ID }),
        c.startPairing({
          agentId: 'agent-a',
          channelId: CHANNEL_ID,
          method: 'qr',
          idempotencyKey: IDEMPOTENCY_KEY,
          comment: REASON,
        }),
        c.abortPairing({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON }),
        c.disable({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON }),
        c.requestRepair({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON }),
      ];
      for (const p of calls) {
        await expect(p).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    });
  }

  it('owner e founder passam o gate de papel', async () => {
    for (const role of ['owner', 'founder']) {
      const { ctx } = makeCtx(role);
      await expect(caller(ctx).list({ agentId: 'agent-a' })).resolves.toBeDefined();
    }
  });
});

describe('isolamento de tenant — lookup cross-tenant não é autorização', () => {
  it('owner não opera linha de outro tenant: tenantId do body é rejeitado', async () => {
    const { ctx } = makeCtx('owner');
    await expect(
      caller(ctx).startPairing({
        tenantId: 'tenant-B',
        agentId: 'agent-b',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('canal fora do (tenant, agent) resolve para NOT_FOUND — fail-closed', async () => {
    const { ctx, commands } = makeCtx('owner', { line: null });
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(commands).toHaveLength(0);
  });

  it('o escopo enviado ao repo é sempre o triplete completo', async () => {
    const { ctx, commands } = makeCtx('owner');
    await caller(ctx).startPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      method: 'qr',
      idempotencyKey: IDEMPOTENCY_KEY,
      comment: REASON,
    });
    expect(commands[0]!.scope).toEqual({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      channel_id: CHANNEL_ID,
    });
  });
});

describe('listagem — canal inativo permanece visível', () => {
  it('list devolve o canal declarado (inativo) junto com o conectado', async () => {
    const { ctx } = makeCtx('owner');
    const res = await caller(ctx).list({ agentId: 'agent-a' });
    expect(res.lines).toHaveLength(2);
    expect(res.lines.map((l) => l.state)).toEqual(['declared', 'connected']);
    expect(res.lines.some((l) => l.active === false)).toBe(true);
    expect(res.pairing_available).toBe(true);
  });

  it('a política do canal vem na MESMA resposta — inclusive para o canal inativo', async () => {
    const { ctx } = makeCtx('owner');
    const res = await caller(ctx).list({ agentId: 'agent-a' });
    const declared = res.lines.find((l) => l.channel_id === CHANNEL_ID)!;
    const connected = res.lines.find((l) => l.channel_id === OTHER_CHANNEL_ID)!;
    expect(declared.has_policy).toBe(false);
    expect(declared.policy_ready).toBe(false);
    expect(connected.policy_ready).toBe(true);
    expect(connected.default_role_key).toBe('atendente');
  });

  it('sem keyring a listagem CONTINUA funcionando, sinalizando indisponibilidade', async () => {
    materialMock.configured = false;
    const { ctx } = makeCtx('owner');
    const res = await caller(ctx).list({ agentId: 'agent-a' });
    expect(res.lines).toHaveLength(2);
    expect(res.pairing_available).toBe(false);
  });
});

describe('startPairing — pré-condições, idempotência e concorrência', () => {
  it('linha JÁ ativa não repareia: CONFLICT (re-parear exige requestRepair)', async () => {
    const { ctx } = makeCtx('owner', { line: baseLine({ active: true, state: 'connected' }) });
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('canal não-whatsapp é BAD_REQUEST (digitar número não prova posse de outro transporte)', async () => {
    const { ctx } = makeCtx('owner', { line: baseLine({ channel_type: 'telegram' }) });
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('pairing concorrente é rejeitado de forma determinística (CONFLICT)', async () => {
    const { ctx } = makeCtx('owner', {
      requestResult: { ok: false, reason: 'pairing_in_progress' },
    });
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('replay com a MESMA idempotency key não gera audit novo', async () => {
    const { ctx, audits } = makeCtx('owner', {
      requestResult: {
        ok: true,
        idempotent: true,
        row: { pairing_attempts: 1, pairing_expires_at: null },
      },
    });
    const res = await caller(ctx).startPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      method: 'qr',
      idempotencyKey: IDEMPOTENCY_KEY,
      comment: REASON,
    });
    expect(res.idempotent).toBe(true);
    expect(audits).toHaveLength(0);
  });

  it('sem keyring configurado o start FALHA FECHADO (nunca material em claro)', async () => {
    materialMock.configured = false;
    const { ctx, commands } = makeCtx('owner');
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(commands).toHaveLength(0);
  });

  it('motivo curto é rejeitado pelo schema (toda mutação exige justificativa auditada)', async () => {
    const { ctx } = makeCtx('owner');
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: 'curto',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('auditoria — ator administrativo presente, segredo ausente', () => {
  it('channel_pairing_requested carrega ator/papel/correlação e NENHUM material', async () => {
    const { ctx, audits } = makeCtx('owner');
    await caller(ctx).startPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      method: 'qr',
      idempotencyKey: IDEMPOTENCY_KEY,
      comment: REASON,
    });
    expect(audits).toHaveLength(1);
    const entry = audits[0]!;
    expect(entry).toMatchObject({
      tenant_id: 'tenant-A',
      actor_id: 'user-1',
      actor_role: 'owner',
      action: 'channel_pairing_requested',
      resource_type: 'channel',
      resource_id: CHANNEL_ID,
    });
    // Canário: nada de material/segredo na trilha. `method: 'qr'` é metadata
    // OPERACIONAL permitida (qual método o operador escolheu) — o que não
    // pode aparecer é o conteúdo do QR/código nem qualquer credencial.
    const serialized = JSON.stringify(entry).toLowerCase();
    for (const forbidden of [
      'png_data_uri',
      'pairing_material',
      'pairing_code',
      'envelope',
      'setup_token',
      'creds',
      '4f7k2m9q',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // E a metadata é um conjunto FECHADO — um campo novo tem que passar por
    // este teste antes de entrar na trilha.
    expect(Object.keys(entry.change_summary as Record<string, unknown>).sort()).toEqual([
      'agent_id',
      'attempt',
      'correlation_id',
      'idempotency_key',
      'method',
      'reason',
    ]);
  });

  it('disable ENFILEIRA a parada do socket, não só desativa a row (review PR #528)', async () => {
    const { ctx, commands, disabled } = makeCtx('owner');
    await caller(ctx).disable({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON });

    // Desativar a row para o ROTEAMENTO na hora; o SOCKET vive no runtime e
    // só morre por comando. Sem isto a sessão seguia registrada no transporte,
    // com timers de reconexão vivos.
    expect(disabled).toEqual([CHANNEL_ID]);
    const stop = commands.find((c) => c.command === 'stop_line');
    expect(stop).toBeDefined();
    expect(stop!.scope).toEqual({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      channel_id: CHANNEL_ID,
    });
    expect(stop!.actor_id).toBe('user-1');
  });

  it('disable e requestRepair auditam com o ator e a linha', async () => {
    const { ctx, audits, disabled } = makeCtx('owner');
    await caller(ctx).disable({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON });
    await caller(ctx).requestRepair({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      comment: REASON,
    });
    expect(disabled).toEqual([CHANNEL_ID]);
    expect(audits.map((a) => a.action)).toEqual([
      'channel_disabled',
      'channel_repair_requested',
    ]);
    for (const a of audits) {
      expect(a.actor_id).toBe('user-1');
      expect(a.actor_role).toBe('owner');
    }
  });

  it('comando e trilha viajam JUNTOS para o repo — nunca em escritas separadas', async () => {
    // Review PR #528 (P2): se o processo caísse entre as duas escritas, o
    // comando sobrevivia e era executado sem `channel_pairing_requested`.
    // O contrato agora é: quem escreve o comando escreve a trilha, no mesmo
    // commit. O router não tem mais como emitir uma sem a outra.
    const { ctx, commands } = makeCtx('owner');
    const c = caller(ctx);
    await c.startPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      method: 'qr',
      idempotencyKey: IDEMPOTENCY_KEY,
      comment: REASON,
    });
    await c.abortPairing({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON });
    await c.requestRepair({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON });
    await c.disable({ agentId: 'agent-a', channelId: CHANNEL_ID, comment: REASON });

    for (const cmd of commands) {
      expect(cmd.audit, `comando ${String(cmd.command)} sem trilha atrelada`).toBeDefined();
      const audit = cmd.audit as { actor_id: string; action: string };
      expect(audit.actor_id).toBe('user-1');
      expect(audit.action).toBeTruthy();
    }
  });

  it('replay idempotente NÃO escreve trilha (a operação não aconteceu de novo)', async () => {
    const { ctx, audits } = makeCtx('owner', {
      requestResult: {
        ok: true,
        idempotent: true,
        row: { pairing_attempts: 1, pairing_expires_at: null },
      },
    });
    await caller(ctx).startPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      method: 'qr',
      idempotencyKey: IDEMPOTENCY_KEY,
      comment: REASON,
    });
    expect(audits).toHaveLength(0);
  });

  it('comando rejeitado (pairing_in_progress) não deixa trilha órfã', async () => {
    const { ctx, audits } = makeCtx('owner', {
      requestResult: { ok: false, reason: 'pairing_in_progress' },
    });
    await expect(
      caller(ctx).startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(audits).toHaveLength(0);
  });

  it('abort é idempotente do ponto de vista do chamador e sempre audita', async () => {
    const { ctx, audits } = makeCtx('owner');
    await caller(ctx).abortPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      comment: REASON,
    });
    await caller(ctx).abortPairing({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
      comment: REASON,
    });
    expect(audits.map((a) => a.action)).toEqual([
      'pairing_session_aborted',
      'pairing_session_aborted',
    ]);
  });
});

describe('getPairingStatus — material só no corpo, e só enquanto vale', () => {
  it('devolve o material decifrado quando o envelope está dentro do TTL', async () => {
    const { ctx } = makeCtx('owner', {
      line: baseLine({ state: 'pairing', pairing_method: 'code' }),
      state: {
        pairing_material: Buffer.from('envelope'),
        pairing_material_expires_at: new Date(Date.now() + 60_000),
      },
    });
    const res = await caller(ctx).getPairingStatus({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
    });
    expect(res.state).toBe('pairing');
    expect(res.material).toEqual({ kind: 'code', code: '4F7K2M9Q' });
  });

  it('material VENCIDO não é devolvido nem sequer decifrado', async () => {
    const { ctx } = makeCtx('owner', {
      line: baseLine({ state: 'pairing' }),
      state: {
        pairing_material: Buffer.from('envelope'),
        pairing_material_expires_at: new Date(Date.now() - 1),
      },
    });
    const res = await caller(ctx).getPairingStatus({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
    });
    expect(res.material).toBeNull();
    expect(res.material_expires_at).toBeNull();
    expect(materialMock.open).not.toHaveBeenCalled();
  });

  it('envelope que não abre vira material null — nunca conteúdo parcial', async () => {
    materialMock.open.mockImplementation(() => {
      throw new Error('pairing_material_unreadable');
    });
    const { ctx } = makeCtx('owner', {
      line: baseLine({ state: 'pairing' }),
      state: {
        pairing_material: Buffer.from('envelope'),
        pairing_material_expires_at: new Date(Date.now() + 60_000),
      },
    });
    const res = await caller(ctx).getPairingStatus({
      agentId: 'agent-a',
      channelId: CHANNEL_ID,
    });
    expect(res.material).toBeNull();
  });

  it('linha de outro tenant: NOT_FOUND antes de qualquer decifra', async () => {
    const { ctx } = makeCtx('owner', { line: null });
    await expect(
      caller(ctx).getPairingStatus({ agentId: 'agent-a', channelId: CHANNEL_ID }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(materialMock.open).not.toHaveBeenCalled();
  });
});

describe('rate limit — fail-closed', () => {
  it('o 6º start no mesmo canal recebe TOO_MANY_REQUESTS', async () => {
    const { ctx } = makeCtx('owner');
    const c = caller(ctx);
    for (let i = 0; i < 5; i += 1) {
      await c.startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      });
    }
    await expect(
      c.startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('o limite é POR canal: outra linha do mesmo ator ainda passa', async () => {
    const { ctx } = makeCtx('owner');
    const c = caller(ctx);
    for (let i = 0; i < 5; i += 1) {
      await c.startPairing({
        agentId: 'agent-a',
        channelId: CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      });
    }
    await expect(
      c.startPairing({
        agentId: 'agent-a',
        channelId: OTHER_CHANNEL_ID,
        method: 'qr',
        idempotencyKey: IDEMPOTENCY_KEY,
        comment: REASON,
      }),
    ).resolves.toBeDefined();
  });
});
