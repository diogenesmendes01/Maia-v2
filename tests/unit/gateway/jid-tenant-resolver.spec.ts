/**
 * Issue #290 — JID → tenant scope resolver (gateway entry-point).
 *
 * Contract:
 *   - extractPhoneFromJid: pure parser that accepts the WhatsApp JID
 *     variants Baileys emits (`@s.whatsapp.net`, `@c.us`, `@lid` with
 *     senderPn/participantPn fallback) and rejects everything else
 *     (groups, unknown domains, malformed, empty, non-digit local parts).
 *   - resolveScopeForJid: parses + delegates to `resolveChannel`
 *     (single source of truth for ownership). Fails LOUDLY (TypedError
 *     'channel_resolution_failed') on any path that cannot return a real
 *     (tenant_id, agent_id) — never falls back to primary/primary.
 *
 * Cross-tenant adversarial coverage:
 *   - Phone A → tenant A: must resolve to tenant A.
 *   - Phone B → tenant B: must resolve to tenant B (different mock call).
 *   - Phone A's JID must NEVER inject tenant B's context (covered by the
 *     resolver delegating ownership to channelsRepo — see the cross-tenant
 *     test in baileys-tenant-resolution.spec.ts that wires the full chain).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedError } from '@/lib/utils.js';
import type { Channel } from '@/db/schema.js';

const findByExternalCrossTenantMock = vi.fn<
  [args: { channel_type: string; external_id: string }],
  Promise<Channel | null>
>();
const findPrimaryCatchAllChannelMock = vi.fn();
vi.mock('@/db/repositories.js', () => ({
  channelsRepo: {
    findByExternalCrossTenant: findByExternalCrossTenantMock,
    findPrimaryCatchAllChannel: findPrimaryCatchAllChannelMock,
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  const now = new Date();
  return {
    id: 'channel-default',
    tenant_id: 'tenant-acme',
    agent_id: 'agent-acme-main',
    external_id: '+5511999999999',
    channel_type: 'whatsapp',
    display_name: 'WA',
    active: true,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Channel;
}

describe('extractPhoneFromJid — pure JID parser', () => {
  it('parses standard `@s.whatsapp.net` JID → {phone_e164: "+<digits>", via_lid_fallback: false}', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const out = extractPhoneFromJid('5511999999999@s.whatsapp.net');
    expect(out).toEqual({
      phone_e164: '+5511999999999',
      via_lid_fallback: false,
    });
  });

  it('parses legacy `@c.us` JID → {phone_e164: "+<digits>", via_lid_fallback: false}', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const out = extractPhoneFromJid('5511888888888@c.us');
    expect(out).toEqual({
      phone_e164: '+5511888888888',
      via_lid_fallback: false,
    });
  });

  it('@lid + senderPn (bare digits) → fallback resolves via senderPn', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const out = extractPhoneFromJid('12345@lid', {
      senderPn: '5511777777777',
    });
    expect(out).toEqual({
      phone_e164: '+5511777777777',
      via_lid_fallback: true,
    });
  });

  it('@lid + senderPn (JID-shaped) → strips domain and resolves', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const out = extractPhoneFromJid('12345@lid', {
      senderPn: '5511777777777@s.whatsapp.net',
    });
    expect(out?.phone_e164).toBe('+5511777777777');
    expect(out?.via_lid_fallback).toBe(true);
  });

  it('@lid + participantPn fallback (senderPn missing)', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const out = extractPhoneFromJid('12345@lid', {
      participantPn: '5511666666666',
    });
    expect(out?.phone_e164).toBe('+5511666666666');
    expect(out?.via_lid_fallback).toBe(true);
  });

  it('@lid with neither senderPn nor participantPn → null (caller treats as unresolvable)', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(extractPhoneFromJid('12345@lid')).toBeNull();
    expect(extractPhoneFromJid('12345@lid', {})).toBeNull();
    expect(
      extractPhoneFromJid('12345@lid', {
        senderPn: '',
        participantPn: null,
      }),
    ).toBeNull();
  });

  it('group JID (@g.us) → null (defense in depth: groups must not route through tenant resolver)', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(extractPhoneFromJid('120363025111111111@g.us')).toBeNull();
  });

  it('unknown domain → null', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(extractPhoneFromJid('5511999999999@example.com')).toBeNull();
    expect(extractPhoneFromJid('5511999999999@broadcast')).toBeNull();
  });

  it('malformed JID (no @) → null', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(extractPhoneFromJid('5511999999999')).toBeNull();
    expect(extractPhoneFromJid('@s.whatsapp.net')).toBeNull();
  });

  it('non-digit local part on standard JID → null (cannot invent a phone)', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(
      extractPhoneFromJid('abc-not-a-phone@s.whatsapp.net'),
    ).toBeNull();
    expect(
      extractPhoneFromJid('5511-999-999@s.whatsapp.net'),
    ).toBeNull();
  });

  it('empty / null / undefined JID → null', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(extractPhoneFromJid('')).toBeNull();
    expect(extractPhoneFromJid(null)).toBeNull();
    expect(extractPhoneFromJid(undefined)).toBeNull();
  });

  it('@lid senderPn with non-digit local part → null (rejects malformed fallback)', async () => {
    const { extractPhoneFromJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    expect(
      extractPhoneFromJid('12345@lid', { senderPn: 'not-a-phone' }),
    ).toBeNull();
  });
});

describe('resolveScopeForJid — JID + channel delegation', () => {
  beforeEach(() => {
    findByExternalCrossTenantMock.mockReset();
    findPrimaryCatchAllChannelMock.mockReset();
    // Default to a MULTI-TENANT deployment so a channel miss is fail-loud
    // (the cross-tenant contract this resolver protects). The single-tenant
    // catch-all is exercised by its own dedicated test below.
    findPrimaryCatchAllChannelMock.mockResolvedValue({ multi_tenant: true, channel: null });
  });

  it('happy path: known JID → returns correct {tenant_id, agent_id, channel_id}', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({
        id: 'ch-abc-123',
        tenant_id: 'tenant-acme',
        agent_id: 'agent-main',
        external_id: '+5511999999999',
      }),
    );
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const { scope, jid_context } = await resolveScopeForJid(
      '5511999999999@s.whatsapp.net',
    );
    expect(scope).toEqual({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc-123',
    });
    expect(jid_context.resolved_phone_e164).toBe('+5511999999999');
    expect(jid_context.via_lid_fallback).toBe(false);
    expect(jid_context.raw_jid).toBe('5511999999999@s.whatsapp.net');
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '+5511999999999',
    });
  });

  it('cross-tenant: different JIDs resolve to different tenants (each call hits the resolver fresh)', async () => {
    findByExternalCrossTenantMock
      .mockResolvedValueOnce(
        makeChannel({
          id: 'ch-A',
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          external_id: '+5511111111111',
        }),
      )
      .mockResolvedValueOnce(
        makeChannel({
          id: 'ch-B',
          tenant_id: 'tenant-B',
          agent_id: 'agent-B',
          external_id: '+5511222222222',
        }),
      );
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const a = await resolveScopeForJid('5511111111111@s.whatsapp.net');
    const b = await resolveScopeForJid('5511222222222@s.whatsapp.net');

    expect(a.scope.tenant_id).toBe('tenant-A');
    expect(b.scope.tenant_id).toBe('tenant-B');
    expect(a.scope.tenant_id).not.toBe(b.scope.tenant_id);
  });

  it('unknown JID (channel miss) → throws TypedError("channel_resolution_failed")', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const p = resolveScopeForJid('5511999999999@s.whatsapp.net');
    await expect(p).rejects.toBeInstanceOf(TypedError);
    await expect(p).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: {
        resolver_path: 'unknown_or_inactive_channel',
        found: false,
        active: false,
      },
    });
  });

  it('channel inactive → throws with resolver_path=unknown_or_inactive_channel and active:false', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({ active: false }),
    );
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const p = resolveScopeForJid('5511999999999@s.whatsapp.net');
    await expect(p).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { active: false, found: true },
    });
  });

  it('malformed JID → throws with resolver_path=jid_unparseable WITHOUT hitting the repo', async () => {
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const p = resolveScopeForJid('not-a-jid');
    await expect(p).rejects.toBeInstanceOf(TypedError);
    await expect(p).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'jid_unparseable', raw_jid: 'not-a-jid' },
    });
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
  });

  it('group JID → throws jid_unparseable WITHOUT hitting the repo (defense in depth)', async () => {
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    await expect(
      resolveScopeForJid('120363025111111111@g.us'),
    ).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'jid_unparseable' },
    });
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
  });

  it('@lid without senderPn → throws jid_unparseable (no synthetic tenant routing)', async () => {
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    await expect(
      resolveScopeForJid('12345@lid'),
    ).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'jid_unparseable' },
    });
  });

  it('@lid + senderPn → calls resolver with the REAL phone (not the synthetic LID)', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({
        tenant_id: 'tenant-lid',
        agent_id: 'agent-lid',
        external_id: '+5511777777777',
      }),
    );
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const { scope, jid_context } = await resolveScopeForJid('999@lid', {
      senderPn: '5511777777777',
    });
    expect(scope.tenant_id).toBe('tenant-lid');
    expect(jid_context.via_lid_fallback).toBe(true);
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '+5511777777777',
    });
  });

  it('null JID → throws jid_unparseable', async () => {
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    await expect(resolveScopeForJid(null)).rejects.toMatchObject({
      code: 'channel_resolution_failed',
      details: { resolver_path: 'jid_unparseable' },
    });
  });

  it('DB-layer throw propagates as-is (caller audits + drops)', async () => {
    findByExternalCrossTenantMock.mockRejectedValueOnce(
      new Error('connection refused'),
    );
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    await expect(
      resolveScopeForJid('5511999999999@s.whatsapp.net'),
    ).rejects.toThrow('connection refused');
  });

  it('#411 single-tenant: unknown JID (no real tenant) → resolves to (primary, primary) via catch-all (NOT a throw)', async () => {
    // Exact-match misses (the sender phone is not a registered bot line) but no
    // real tenant exists → catch-all maps it to the seeded primary channel.
    findByExternalCrossTenantMock.mockResolvedValueOnce(null);
    findPrimaryCatchAllChannelMock.mockResolvedValueOnce({
      multi_tenant: false,
      channel: makeChannel({
        id: 'primary-channel-uuid',
        tenant_id: 'primary',
        agent_id: 'primary',
        external_id: 'default-channel',
      }),
    });
    const { resolveScopeForJid } = await import(
      '@/gateway/jid-tenant-resolver.js'
    );
    const { scope } = await resolveScopeForJid('5511999999999@s.whatsapp.net');
    expect(scope).toEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: 'primary-channel-uuid',
    });
  });
});
