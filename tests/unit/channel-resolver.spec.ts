/**
 * P6 Task 5 — channel resolver (gateway lookup, cross-tenant fallback).
 *
 * Atualizado pelo issue #268 (fail-loud) e pelo issue #411 (single-tenant
 * catch-all + remoção da flag MULTI_CHANNEL). Veja
 * `tests/unit/gateway/channel-resolver-fail-loud.spec.ts` para a suite focada
 * no contrato fail-loud cross-tenant. Este arquivo cobre o smoke contract:
 *
 *   - Exact match ativo                       -> {channel.tenant_id, channel.agent_id, channel.id}.
 *   - Miss/inativo NUM runtime single-tenant   -> (default, default, <default channel id>) via catch-all.
 *   - Miss/inativo NUM deployment multi-tenant -> throw TypedError('channel_resolution_failed') (issue #268).
 *
 * O resolver é o ENTRY POINT — roda ANTES de tenant context existir. Por isso usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o tenant guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedError } from '@/lib/utils.js';
import type { Channel } from '@/db/schema.js';

// Mock do repositório — únicos side-effects que importam para o resolver.
const findByExternalCrossTenantMock = vi.fn<[args: { channel_type: string; external_id: string }], Promise<Channel | null>>();
const findDefaultCatchAllChannelMock = vi.fn();
vi.mock('@/db/repositories.js', () => ({
  channelsRepo: {
    findByExternalCrossTenant: findByExternalCrossTenantMock,
    findDefaultCatchAllChannel: findDefaultCatchAllChannelMock,
  },
}));

// Mock do logger para espiar warn().
const loggerWarnMock = vi.fn();
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  const now = new Date();
  return {
    id: 'channel-1',
    tenant_id: 'tenant-acme',
    agent_id: 'agent-acme-main',
    external_id: '5511999999999',
    channel_type: 'whatsapp',
    display_name: 'WA principal',
    active: true,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Channel;
}

function makeDefaultChannel(overrides: Partial<Channel> = {}): Channel {
  return makeChannel({
    id: 'default-channel-uuid',
    tenant_id: 'default',
    agent_id: 'default',
    external_id: 'default-channel',
    ...overrides,
  });
}

describe('resolveChannel — cross-tenant lookup + single-tenant catch-all (issues #268, #411)', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    findDefaultCatchAllChannelMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('exact match ativo → retorna {tenant_id, agent_id, channel_id} sem warning, sem catch-all', async () => {
    const channel = makeChannel({
      id: 'ch-abc-123',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      active: true,
    });
    findByExternalCrossTenantMock.mockResolvedValueOnce(channel);

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'whatsapp', external_id: '5511999999999' });

    expect(out).toEqual({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc-123',
    });
    expect(findByExternalCrossTenantMock).toHaveBeenCalledTimes(1);
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '5511999999999',
    });
    // Exact match → não consulta o catch-all, não emite warning.
    expect(findDefaultCatchAllChannelMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('#411: miss NUM runtime single-tenant → resolve para (default, default, <default channel id>)', async () => {
    // O remetente (telefone) nunca casa com o canal semeado `default-channel`.
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    // Catch-all: nenhum tenant real → devolve o canal default semeado.
    findDefaultCatchAllChannelMock.mockResolvedValueOnce({
      multi_tenant: false,
      channel: makeDefaultChannel(),
    });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'whatsapp', external_id: '+5511988887777' });

    expect(out).toEqual({
      tenant_id: 'default',
      agent_id: 'default',
      channel_id: 'default-channel-uuid',
    });
    expect(findDefaultCatchAllChannelMock).toHaveBeenCalledWith({ channel_type: 'whatsapp' });
    // Single-tenant catch-all NÃO é fail-loud → nenhum warning.
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('#268: miss NUM deployment multi-tenant → throw (catch-all reporta multi_tenant)', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const promise = resolveChannel({ channel_type: 'whatsapp', external_id: '+5511988887777' });

    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: {
        channel_type: 'whatsapp',
        external_id: '+5511988887777',
        found: false,
        active: false,
        resolver_path: 'unknown_or_inactive_channel',
      },
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it('canal encontrado mas INATIVO + deployment multi-tenant → throw com details.active:false', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ active: false }));
    findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const promise = resolveChannel({ channel_type: 'telegram', external_id: '@bot' });

    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: {
        channel_type: 'telegram',
        external_id: '@bot',
        found: true,
        active: false,
        resolver_path: 'unknown_or_inactive_channel',
      },
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it('miss + default channel seed ausente/inativo (single-tenant mal configurado) → throw fail-loud', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    // multi_tenant=false mas sem canal default ativo (seed faltando).
    findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: false, channel: null });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const promise = resolveChannel({ channel_type: 'whatsapp', external_id: 'unknown-555' });

    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'unknown_or_inactive_channel', found: false },
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });
});
