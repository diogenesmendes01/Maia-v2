/**
 * P6 Task 5 — channel resolver (gateway lookup, flag-gated, cross-tenant fallback).
 *
 * Atualizado pelo issue #268 — fallback default/default substituído por
 * fail-loud (TypedError). Veja `tests/unit/gateway/channel-resolver-fail-loud.spec.ts`
 * para a suite focada no novo contrato. Este arquivo cobre o smoke contract:
 *
 *   - Flag OFF (MULTI_CHANNEL=false)        -> throw TypedError('channel_resolution_failed').
 *   - Flag ON + active channel encontrado   -> {channel.tenant_id, channel.agent_id, channel.id}.
 *   - Flag ON + channel não encontrado      -> throw TypedError('channel_resolution_failed').
 *   - Flag ON + channel encontrado inativo  -> throw TypedError('channel_resolution_failed').
 *
 * O resolver é o ENTRY POINT — roda ANTES de tenant context existir. Por isso usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o tenant guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureFlagName } from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';
import { TypedError } from '@/lib/utils.js';
import type { Channel } from '@/db/schema.js';

// Mock do repositório — único side-effect que importa para o resolver.
const findByExternalCrossTenantMock = vi.fn<[args: { channel_type: string; external_id: string }], Promise<Channel | null>>();
vi.mock('@/db/repositories.js', () => ({
  channelsRepo: {
    findByExternalCrossTenant: findByExternalCrossTenantMock,
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

describe('resolveChannel — flag-gated + cross-tenant lookup + fail-loud (issue #268)', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    loggerWarnMock.mockReset();
    featureFlags.reset();
  });

  it('Flag OFF → throw TypedError("channel_resolution_failed") SEM consultar o repo', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');

    const promise = resolveChannel({ channel_type: 'whatsapp', external_id: '5511999999999' });

    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({ code: 'channel_resolution_failed' });
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
  });

  it('Flag ON + canal ativo encontrado → retorna {tenant_id, agent_id, channel_id} sem warning', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
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
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('Flag ON + canal encontrado mas INATIVO → throw com details.active:false', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
    findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ active: false }));

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

  it('Flag ON + canal NÃO encontrado → throw com details.found:false', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const promise = resolveChannel({ channel_type: 'sms', external_id: 'unknown-555' });

    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: {
        channel_type: 'sms',
        external_id: 'unknown-555',
        found: false,
        active: false,
        resolver_path: 'unknown_or_inactive_channel',
      },
    });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });
});
