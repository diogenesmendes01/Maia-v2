/**
 * Issue #268 — channel-resolver fail-loud (replaces default/default fallback).
 *
 * Antes (legacy): qualquer falha de resolução caía em
 * `{ tenant_id: 'default', agent_id: 'default', channel_id: null }`. Isso
 * colapsava buckets de rate-limit entre tenants distintos (todos os "miss"
 * compartilhavam `maia:ratelimit:default:default:*` — cross-tenant DoS).
 *
 * Agora:
 *   - Resolução bem-sucedida  → retorna {tenant_id, agent_id, channel_id} reais.
 *   - Flag MULTI_CHANNEL OFF  → throw TypedError('channel_resolution_failed').
 *     (Em produção multi-tenant a flag está ON; OFF nesse caminho é defesa
 *      em profundidade contra callers que pulem a checagem.)
 *   - Miss/inativo (flag ON)  → throw TypedError('channel_resolution_failed').
 *   - Caller em agent/core.ts → audit `channel_resolution_failed` + re-throw.
 *
 * Contrato testado aqui (resolver puro). Os testes do caller (agent/core.ts)
 * estão em `tests/unit/agent-core-channel-resolution.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeatureFlagName } from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';
import { TypedError } from '@/lib/utils.js';
import type { Channel } from '@/db/schema.js';

// Mock do repositório — único side-effect que importa para o resolver.
const findByExternalCrossTenantMock = vi.fn<
  [args: { channel_type: string; external_id: string }],
  Promise<Channel | null>
>();
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

describe('resolveChannel — fail-loud (issue #268)', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    loggerWarnMock.mockReset();
    featureFlags.reset();
  });

  describe('happy path', () => {
    it('Flag ON + canal ativo encontrado → retorna {tenant_id, agent_id, channel_id} sem warning, sem throw', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
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
      // NÃO deve emitir warning quando a resolução foi bem-sucedida.
      expect(loggerWarnMock).not.toHaveBeenCalled();
    });
  });

  describe('first fallback — flag MULTI_CHANNEL OFF', () => {
    it('Flag OFF → throw TypedError("channel_resolution_failed") com resolver_path="legacy_flag_off"', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);
      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      const promise = resolveChannel({
        channel_type: 'whatsapp',
        external_id: '5511999999999',
      });

      await expect(promise).rejects.toBeInstanceOf(TypedError);
      await expect(promise).rejects.toMatchObject({
        code: 'channel_resolution_failed',
        details: {
          channel_type: 'whatsapp',
          external_id: '5511999999999',
          resolver_path: 'legacy_flag_off',
        },
      });
      // NÃO chama o repo — short-circuit antes do lookup.
      expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
      // Warning emitido pra triagem operacional.
      expect(loggerWarnMock).toHaveBeenCalledTimes(1);
      expect(loggerWarnMock.mock.calls[0]![1]).toBe(
        'channel_resolver.legacy_flag_off_throw',
      );
    });

    it('Flag OFF → NÃO retorna default/default/null (regression guard contra o bypass do #268)', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);
      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      // Resolve deve REJEITAR, não resolver com default. Se um futuro refactor
      // reintroduzir o fallback, este teste pega.
      let resolved: unknown = null;
      let threw = false;
      try {
        resolved = await resolveChannel({
          channel_type: 'whatsapp',
          external_id: 'anything',
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(resolved).toBeNull(); // nunca foi setado
    });
  });

  describe('second fallback — miss / inativo (flag ON)', () => {
    it('Flag ON + canal NÃO encontrado → throw TypedError com resolver_path="unknown_or_inactive_channel" + found:false', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
      findByExternalCrossTenantMock.mockResolvedValueOnce(null);

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

    it('Flag ON + canal encontrado mas INATIVO → throw com found:true, active:false', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
      findByExternalCrossTenantMock.mockResolvedValueOnce(
        makeChannel({ active: false }),
      );

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

    it('Flag ON + miss → NÃO retorna default/default/null (regression guard)', async () => {
      featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);
      findByExternalCrossTenantMock.mockResolvedValueOnce(null);

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

  describe('isolation invariant', () => {
    it('NUNCA retorna {tenant_id: "default", agent_id: "default"} — qualquer path que faria isso lança erro', async () => {
      // Itera os 3 caminhos que ANTES colapsavam em default/default.
      // Todos devem lançar agora; nenhum deve retornar o triplete default.
      const scenarios: Array<{
        name: string;
        flag: boolean;
        mockReturn: Channel | null;
      }> = [
        { name: 'legacy_flag_off', flag: false, mockReturn: null },
        {
          name: 'channel_not_found',
          flag: true,
          mockReturn: null,
        },
        {
          name: 'channel_inactive',
          flag: true,
          mockReturn: makeChannel({ active: false }),
        },
      ];

      const { resolveChannel } = await import('@/gateway/channel-resolver.js');

      for (const s of scenarios) {
        findByExternalCrossTenantMock.mockReset();
        loggerWarnMock.mockReset();
        featureFlags.override(FeatureFlagName.MULTI_CHANNEL, s.flag);
        if (s.flag) findByExternalCrossTenantMock.mockResolvedValueOnce(s.mockReturn);

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

        // Hard invariant: jamais o triplete default que colapsa cross-tenant.
        expect(result).not.toEqual({
          tenant_id: 'default',
          agent_id: 'default',
          channel_id: null,
        });
        // E o caminho falhou via TypedError tipado, não silenciosamente.
        expect(typedErr).not.toBeNull();
        expect(typedErr!.code).toBe('channel_resolution_failed');
      }
    });
  });
});
