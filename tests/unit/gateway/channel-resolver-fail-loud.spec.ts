/**
 * Issue #268 — channel-resolver fail-loud (replaces default/default fallback)
 * + Issue #411 — single-tenant catch-all + MULTI_CHANNEL flag removal.
 *
 * Antes (legacy P0..P5): qualquer falha de resolução caía em
 * `{ tenant_id: 'default', agent_id: 'default', channel_id: null }`. Isso
 * colapsava buckets de rate-limit entre tenants distintos (todos os "miss"
 * compartilhavam `maia:ratelimit:default:default:*` — cross-tenant DoS).
 *
 * Contrato atual (resolver puro):
 *   - Exact match ativo                       → retorna {tenant_id, agent_id, channel_id} reais.
 *   - Miss/inativo NUM runtime single-tenant   → (default, default, <default channel id>) via catch-all (#411).
 *   - Miss/inativo NUM deployment multi-tenant → throw TypedError('channel_resolution_failed') (#268).
 *   - Ambíguo (2+ ativos cross-tenant)         → throw (propagado do repo).
 *
 * INVARIANTE CRÍTICO PRESERVADO (#268): o fallback default/default só é
 * entregue quando o catch-all confirma que NÃO existe canal ativo de outro
 * tenant (`multi_tenant:false`). Num deployment com tenants reais
 * (`multi_tenant:true`) o resolver SEMPRE lança — jamais colapsa buckets
 * cross-tenant.
 *
 * Contrato testado aqui (resolver puro). Os testes do caller (agent/core.ts)
 * estão em `tests/unit/agent-core-channel-resolution.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedError } from '@/lib/utils.js';
import type { Channel } from '@/db/schema.js';

// Mock do repositório — únicos side-effects que importam para o resolver.
const findByExternalCrossTenantMock = vi.fn<
  [args: { channel_type: string; external_id: string }],
  Promise<Channel | null>
>();
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

describe('resolveChannel — fail-loud (issue #268) + single-tenant catch-all (#411)', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    findDefaultCatchAllChannelMock.mockReset();
    loggerWarnMock.mockReset();
  });

  describe('happy path', () => {
    it('exact match ativo → retorna {tenant_id, agent_id, channel_id} sem warning, sem catch-all', async () => {
      const channel = makeChannel({
        id: 'ch-abc-123',
        tenant_id: 'tenant-acme',
        agent_id: 'agent-main',
        active: true,
      });
      findByExternalCrossTenantMock.mockResolvedValueOnce(channel);

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');
      const out = await resolveChannel({
        channel_type: 'whatsapp',
        external_id: '5511999999999',
      });

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
      expect(findDefaultCatchAllChannelMock).not.toHaveBeenCalled();
      expect(loggerWarnMock).not.toHaveBeenCalled();
    });
  });

  describe('single-tenant catch-all (#411)', () => {
    it('miss + nenhum tenant real → resolve para (default, default, <default channel id>) sem warning', async () => {
      findByExternalCrossTenantMock.mockResolvedValueOnce(null);
      findDefaultCatchAllChannelMock.mockResolvedValueOnce({
        multi_tenant: false,
        channel: makeDefaultChannel(),
      });

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');
      const out = await resolveChannel({
        channel_type: 'whatsapp',
        external_id: '+5511988887777',
      });

      expect(out).toEqual({
        tenant_id: 'default',
        agent_id: 'default',
        channel_id: 'default-channel-uuid',
      });
      expect(findDefaultCatchAllChannelMock).toHaveBeenCalledWith({
        channel_type: 'whatsapp',
      });
      // Catch-all single-tenant NÃO é fail-loud.
      expect(loggerWarnMock).not.toHaveBeenCalled();
    });

    it('canal inativo + nenhum tenant real → ainda resolve via catch-all (mensagem não cai em DLQ)', async () => {
      // Mesmo com um canal default INATIVO no exact-match, o catch-all decide.
      findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ active: false }));
      findDefaultCatchAllChannelMock.mockResolvedValueOnce({
        multi_tenant: false,
        channel: makeDefaultChannel(),
      });

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');
      const out = await resolveChannel({
        channel_type: 'whatsapp',
        external_id: 'qualquer',
      });

      expect(out).toEqual({
        tenant_id: 'default',
        agent_id: 'default',
        channel_id: 'default-channel-uuid',
      });
    });
  });

  describe('fail-loud — multi-tenant miss / inativo (issue #268)', () => {
    it('miss NUM deployment multi-tenant → throw com resolver_path="unknown_or_inactive_channel" + found:false', async () => {
      findByExternalCrossTenantMock.mockResolvedValueOnce(null);
      findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      const promise = resolveChannel({
        channel_type: 'sms',
        external_id: 'unknown-555',
      });

      await expect(promise).rejects.toBeInstanceOf(TypedError);
      await expect(promise).rejects.toMatchObject({
        code: 'channel_resolution_failed',
        details: {
          channel_type: 'sms',
          external_id: 'unknown-555',
          resolver_path: 'unknown_or_inactive_channel',
          found: false,
          active: false,
        },
      });
      expect(loggerWarnMock).toHaveBeenCalledTimes(1);
      expect(loggerWarnMock.mock.calls[0]![1]).toBe(
        'channel_resolver.unknown_or_inactive_channel_throw',
      );
    });

    it('canal INATIVO NUM deployment multi-tenant → throw com found:true, active:false', async () => {
      findByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel({ active: false }));
      findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      const promise = resolveChannel({
        channel_type: 'telegram',
        external_id: '@bot',
      });

      await expect(promise).rejects.toBeInstanceOf(TypedError);
      await expect(promise).rejects.toMatchObject({
        code: 'channel_resolution_failed',
        details: {
          channel_type: 'telegram',
          external_id: '@bot',
          resolver_path: 'unknown_or_inactive_channel',
          found: true,
          active: false,
        },
      });
      expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    });

    it('miss multi-tenant → NÃO retorna default/default/null (regression guard contra o bypass do #268)', async () => {
      findByExternalCrossTenantMock.mockResolvedValueOnce(null);
      findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      let resolved: unknown = null;
      let threw = false;
      try {
        resolved = await resolveChannel({
          channel_type: 'whatsapp',
          external_id: 'never-seen',
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(resolved).toBeNull();
    });
  });

  describe('ambiguous lookup — multiple active matches (issue #268 reval)', () => {
    it('repo lança ambiguous_active_channels → resolver propaga, audit/triagem visível', async () => {
      // O resolver não captura o throw do repo — o caller (agent/core.ts)
      // captura via try/catch padrão. Aqui simulamos o throw direto do repo.
      const ambiguous = new TypedError(
        'channel_resolution_failed',
        'channel ownership ambiguous: multiple active channels match (channel_type, external_id)',
        {
          channel_type: 'whatsapp',
          external_id: '5511999999999',
          resolver_path: 'ambiguous_active_channels',
          conflicting_tenant_ids: ['tenant-a', 'tenant-b'],
        },
      );
      findByExternalCrossTenantMock.mockRejectedValueOnce(ambiguous);

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');
      const promise = resolveChannel({
        channel_type: 'whatsapp',
        external_id: '5511999999999',
      });

      await expect(promise).rejects.toBeInstanceOf(TypedError);
      await expect(promise).rejects.toMatchObject({
        code: 'channel_resolution_failed',
        details: {
          resolver_path: 'ambiguous_active_channels',
          conflicting_tenant_ids: ['tenant-a', 'tenant-b'],
        },
      });
      // Ambiguidade aborta ANTES do catch-all — nunca colapsa em default.
      expect(findDefaultCatchAllChannelMock).not.toHaveBeenCalled();
    });
  });

  describe('isolation invariant', () => {
    it('NUNCA retorna {tenant_id: "default", agent_id: "default"} quando há tenant real — lança erro', async () => {
      // Cenários que ANTES (pré-#268) colapsavam em default/default, agora num
      // deployment multi-tenant (catch-all → multi_tenant:true) DEVEM lançar.
      const scenarios: Array<{
        name: string;
        mockReturn: Channel | null;
      }> = [
        { name: 'channel_not_found', mockReturn: null },
        { name: 'channel_inactive', mockReturn: makeChannel({ active: false }) },
      ];

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      for (const s of scenarios) {
        findByExternalCrossTenantMock.mockReset();
        findDefaultCatchAllChannelMock.mockReset();
        loggerWarnMock.mockReset();
        findByExternalCrossTenantMock.mockResolvedValueOnce(s.mockReturn);
        findDefaultCatchAllChannelMock.mockResolvedValueOnce({ multi_tenant: true, channel: null });

        let result: unknown = null;
        let typedErr: TypedError | null = null;
        try {
          result = await resolveChannel({
            channel_type: 'whatsapp',
            external_id: `ext-${s.name}`,
          });
        } catch (err) {
          if (err instanceof TypedError) typedErr = err;
        }

        // Hard invariant: jamais o triplete default que colapsa cross-tenant
        // quando existe um tenant real.
        expect(result).not.toEqual({
          tenant_id: 'default',
          agent_id: 'default',
          channel_id: null,
        });
        expect(typedErr).not.toBeNull();
        expect(typedErr!.code).toBe('channel_resolution_failed');
      }
    });
  });
});
