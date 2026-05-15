/**
 * P6 Task 5 — channel resolver (gateway lookup, flag-gated, cross-tenant fallback).
 *
 * O resolver é o ENTRY POINT — roda ANTES de tenant context existir. Por isso usa
 * `channelsRepo.findByExternalCrossTenant` que explicitamente bypassa o tenant guard.
 *
 * Contrato:
 *   - Flag OFF (MULTI_CHANNEL=false)        -> {default,default,null}, sem consultar repo.
 *   - Flag ON + active channel encontrado   -> {channel.tenant_id, channel.agent_id, channel.id}.
 *   - Flag ON + channel não encontrado      -> fallback {default,default,null} + warning.
 *   - Flag ON + channel encontrado inativo  -> fallback {default,default,null} + warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureFlagName } from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';
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

describe('resolveChannel — flag-gated + cross-tenant lookup + warning fallback', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    loggerWarnMock.mockReset();
    featureFlags.reset();
  });

  it('Flag OFF → retorna default/default/null SEM consultar o repo', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');

    const out = await resolveChannel({ channel_type: 'whatsapp', external_id: '5511999999999' });

    expect(out).toEqual({ tenant_id: 'default', agent_id: 'default', channel_id: null });
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
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

  it('Flag ON + canal encontrado mas INATIVO → fallback default + warning com active:false', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
    findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ active: false }));

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'telegram', external_id: '@bot' });

    expect(out).toEqual({ tenant_id: 'default', agent_id: 'default', channel_id: null });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarnMock.mock.calls[0]!;
    expect(meta).toMatchObject({
      channel_type: 'telegram',
      external_id: '@bot',
      found: true,
      active: false,
    });
    expect(msg).toBe('channel_resolver.unknown_or_inactive_channel_fallback');
  });

  it('Flag ON + canal NÃO encontrado → fallback default + warning com found:false', async () => {
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'sms', external_id: 'unknown-555' });

    expect(out).toEqual({ tenant_id: 'default', agent_id: 'default', channel_id: null });
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarnMock.mock.calls[0]!;
    expect(meta).toMatchObject({
      channel_type: 'sms',
      external_id: 'unknown-555',
      found: false,
      active: false,
    });
    expect(msg).toBe('channel_resolver.unknown_or_inactive_channel_fallback');
  });
});
