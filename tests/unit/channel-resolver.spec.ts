/**
 * P6 Task 5 — channel resolver (gateway lookup, cross-tenant fallback).
 *
 * Atualizado pelo issue #268 (fail-loud) e pelo issue #411 (single-tenant
 * catch-all + remoção da flag MULTI_CHANNEL). Veja
 * `tests/unit/gateway/channel-resolver-fail-loud.spec.ts` para a suite focada
 * no contrato fail-loud cross-tenant. Este arquivo cobre o smoke contract:
 *
 *   - Exact match ativo                       -> {channel.tenant_id, channel.agent_id, channel.id}.
 *   - Miss/inativo NUM runtime single-tenant   -> (primary, primary, <primary channel id>) via catch-all.
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
const findPrimaryCatchAllChannelMock = vi.fn();
vi.mock('@/db/repositories.js', () => ({
  channelsRepo: {
    findByExternalCrossTenant: findByExternalCrossTenantMock,
    findPrimaryCatchAllChannel: findPrimaryCatchAllChannelMock,
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

// Modos §1.2 (spec roteamento v4): config mutável por teste + audit espiado
// (shadow_divergence / legacy_catch_all são os gates do rollout).
const configMock = vi.hoisted(() => ({
  MAIA_CHANNEL_ROUTING_MODE: 'shadow' as 'shadow' | 'exact_first' | 'strict',
}));
vi.mock('@/config/env.js', () => ({ config: configMock }));
const auditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

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

function makePrimaryChannel(overrides: Partial<Channel> = {}): Channel {
  return makeChannel({
    id: 'primary-channel-uuid',
    tenant_id: 'primary',
    agent_id: 'primary',
    external_id: 'default-channel',
    ...overrides,
  });
}

describe('resolveChannel — cross-tenant lookup + single-tenant catch-all (issues #268, #411)', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    findPrimaryCatchAllChannelMock.mockReset();
    loggerWarnMock.mockReset();
    auditMock.mockClear();
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'shadow';
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
      resolved_via: 'legacy',
    });
    expect(findByExternalCrossTenantMock).toHaveBeenCalledTimes(1);
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '5511999999999',
    });
    // Exact match → não consulta o catch-all, não emite warning.
    expect(findPrimaryCatchAllChannelMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('#411+#323: miss NUM runtime single-tenant → resolve para (primary, primary, <primary channel id>)', async () => {
    // O remetente (telefone) nunca casa com o canal semeado `default-channel`.
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    // Catch-all: nenhum tenant real → devolve o canal catch-all semeado (primary).
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({
      multi_tenant: false,
      channel: makePrimaryChannel(),
    });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'whatsapp', external_id: '+5511988887777' });

    expect(out).toEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: 'primary-channel-uuid',
      resolved_via: 'legacy',
    });
    expect(findPrimaryCatchAllChannelMock).toHaveBeenCalledWith({ channel_type: 'whatsapp' });
    // Single-tenant catch-all NÃO é fail-loud → nenhum warning.
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('#268: miss NUM deployment multi-tenant → throw (catch-all reporta multi_tenant)', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

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
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

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
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: false, channel: null });

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

/**
 * §1.2 (spec roteamento v4) — modos tri-state. O exact-match usa a LINHA DO
 * BOT (`bot_line_external_id`), não o remetente; shadow só observa,
 * exact_first usa com fallback auditado, strict exige.
 */
describe('resolveChannel — modos shadow / exact_first / strict (§1.2)', () => {
  const LINE = '+5511900001111';
  const lineChannel = makeChannel({
    id: 'ch-line-1',
    tenant_id: 'tenant-line',
    agent_id: 'agent-line',
    external_id: LINE,
  });

  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    findPrimaryCatchAllChannelMock.mockReset();
    loggerWarnMock.mockReset();
    auditMock.mockClear();
  });

  it('shadow: resultado é o LEGADO; divergência do exact pela linha é auditada', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'shadow';
    // 1º lookup: exact pela LINHA → canal da linha; 2º: legado pelo remetente → miss.
    findByExternalCrossTenantMock
      .mockResolvedValueOnce(lineChannel)
      .mockResolvedValueOnce(null);
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({
      multi_tenant: false,
      channel: makePrimaryChannel(),
    });

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({
      channel_type: 'whatsapp',
      external_id: '+5511988887777',
      bot_line_external_id: LINE,
    });

    // Comportamento INALTERADO (fase 2): devolve o legado…
    expect(out).toMatchObject({ channel_id: 'primary-channel-uuid', resolved_via: 'legacy' });
    // …mas a divergência (exact ch-line-1 ≠ legado primary-channel-uuid) foi auditada.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'shadow_divergence',
        metadata: expect.objectContaining({
          exact_channel_id: 'ch-line-1',
          legacy_channel_id: 'primary-channel-uuid',
        }),
      }),
    );
  });

  it('shadow: exact e legado convergem → nenhuma divergência auditada', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'shadow';
    findByExternalCrossTenantMock
      .mockResolvedValueOnce(lineChannel) // exact pela linha
      .mockResolvedValueOnce(lineChannel); // legado casa o mesmo canal
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({
      channel_type: 'whatsapp',
      external_id: LINE,
      bot_line_external_id: LINE,
    });
    expect(out.channel_id).toBe('ch-line-1');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('shadow sem bot line (chamador legado) → caminho legado puro, sem comparação', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'shadow';
    findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ id: 'ch-x' }));
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({ channel_type: 'whatsapp', external_id: '+551188' });
    expect(out.channel_id).toBe('ch-x');
    expect(findByExternalCrossTenantMock).toHaveBeenCalledTimes(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('exact_first: hit pela linha → triplete do canal da LINHA, sem catch-all, sem audit', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'exact_first';
    findByExternalCrossTenantMock.mockResolvedValueOnce(lineChannel);
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({
      channel_type: 'whatsapp',
      external_id: '+5511988887777',
      bot_line_external_id: LINE,
    });
    expect(out).toEqual({
      tenant_id: 'tenant-line',
      agent_id: 'agent-line',
      channel_id: 'ch-line-1',
      resolved_via: 'exact_line',
    });
    expect(findPrimaryCatchAllChannelMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('exact_first: miss pela linha → legado + audit legacy_catch_all (gate fase 4)', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'exact_first';
    findByExternalCrossTenantMock
      .mockResolvedValueOnce(null) // exact pela linha: miss
      .mockResolvedValueOnce(null); // legado pelo remetente: miss → catch-all
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({
      multi_tenant: false,
      channel: makePrimaryChannel(),
    });
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({
      channel_type: 'whatsapp',
      external_id: '+5511988887777',
      bot_line_external_id: LINE,
    });
    expect(out.channel_id).toBe('primary-channel-uuid');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'legacy_catch_all' }),
    );
  });

  it('strict: hit pela linha → triplete exato', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'strict';
    findByExternalCrossTenantMock.mockResolvedValueOnce(lineChannel);
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const out = await resolveChannel({
      channel_type: 'whatsapp',
      external_id: '+5511988887777',
      bot_line_external_id: LINE,
    });
    expect(out.resolved_via).toBe('exact_line');
    expect(out.channel_id).toBe('ch-line-1');
  });

  it('strict: miss pela linha → throw (o ingress estagia — R5), NUNCA catch-all', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'strict';
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    await expect(
      resolveChannel({
        channel_type: 'whatsapp',
        external_id: '+5511988887777',
        bot_line_external_id: LINE,
      }),
    ).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'strict_line_miss' },
    });
    expect(findPrimaryCatchAllChannelMock).not.toHaveBeenCalled();
  });

  it('strict sem bot line → throw strict_no_bot_line (fail-closed)', async () => {
    configMock.MAIA_CHANNEL_ROUTING_MODE = 'strict';
    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    await expect(
      resolveChannel({ channel_type: 'whatsapp', external_id: '+5511988887777' }),
    ).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'strict_no_bot_line' },
    });
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
  });
});

describe('normalizeLineE164 — E.164 canônico COM + (§1.5)', () => {
  it('normaliza variantes e rejeita lixo', async () => {
    const { normalizeLineE164 } = await import('@/gateway/channel-resolver.js');
    expect(normalizeLineE164('+5511999999999')).toBe('+5511999999999');
    expect(normalizeLineE164('5511999999999')).toBe('+5511999999999');
    expect(normalizeLineE164('5511999999999:12@s.whatsapp.net')).toBe('+5511999999999');
    expect(normalizeLineE164('0123')).toBeNull(); // começa com 0
    expect(normalizeLineE164('abc')).toBeNull();
    expect(normalizeLineE164('')).toBeNull();
    expect(normalizeLineE164(null)).toBeNull();
    expect(normalizeLineE164('../etc/passwd')).toBeNull(); // traversal rejeitado
  });
});
