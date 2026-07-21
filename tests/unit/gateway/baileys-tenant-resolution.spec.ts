/**
 * Issue #290 — Baileys ingress runs `handleIncoming` inside the RESOLVED
 * tenant context (NOT `primary/primary` synthetic). Issue #411 — MULTI_CHANNEL
 * removed: the resolver ALWAYS runs and, in a single-tenant runtime, maps any
 * sender to (primary, primary) via the catch-all.
 *
 * Coverage (in-process, mocked Baileys + mocked channelsRepo):
 *
 *   1. Two JIDs registered to two different tenants → each message lands
 *      under its own tenant ALS (cross-tenant happy path).
 *   2. Cross-tenant ADVERSARIAL: a JID resolved to tenant A must NEVER
 *      enter tenant B's ALS — even when tenant B has a row in `channels`
 *      with overlapping data. This is the defense the issue calls out as
 *      the runtime guarantee the downstream PRs need.
 *   3. Unknown JID in a MULTI-TENANT deployment → `handleIncoming` is NEVER
 *      invoked; audit emitted with `channel_resolution_failed` (fail-closed;
 *      no primary/primary fallback).
 *   4. #411 single-tenant → unknown sender resolves to primary/primary via the
 *      catch-all and IS processed (the bot keeps answering everyone).
 *   5. @lid + senderPn → resolved via the real phone, runs under the
 *      owning tenant's ALS.
 *
 * The default `findPrimaryCatchAllChannel` mock returns `multi_tenant:true` so
 * a miss is fail-loud (the cross-tenant contract). The single-tenant scenario
 * overrides it.
 *
 * These tests exercise the full Baileys upsert pipeline at the boundary
 * — they mock Baileys, the channels repo, and downstream sinks
 * (createInbound, enqueueAgent, debouncer) so the assertions focus on the
 * ALS context active when the downstream sinks fire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Channel } from '@/db/schema.js';

// --- Mocks (vi.hoisted so they're available at import time) ----------------

const {
  findByExternalCrossTenantMock,
  findPrimaryCatchAllChannelMock,
  createInboundMock,
  enqueueAgentMock,
  auditMock,
  isDuplicateMock,
  markSeenMock,
  checkBotAndMaybeBlockMock,
  fakeSocket,
  handlerState,
} = vi.hoisted(() => {
  const state: {
    upsertHandler:
      | ((args: { messages: unknown[] }) => Promise<void>)
      | null;
  } = { upsertHandler: null };
  return {
    findByExternalCrossTenantMock: vi.fn<
      [args: { channel_type: string; external_id: string }],
      Promise<Channel | null>
    >(),
    findPrimaryCatchAllChannelMock: vi.fn(),
    createInboundMock: vi.fn(),
    enqueueAgentMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    isDuplicateMock: vi.fn().mockResolvedValue(false),
    markSeenMock: vi.fn().mockResolvedValue(undefined),
    checkBotAndMaybeBlockMock: vi.fn().mockResolvedValue(false),
    handlerState: state,
    fakeSocket: {
      ev: {
        on: (event: string, handler: (...args: unknown[]) => Promise<void>) => {
          if (event === 'messages.upsert') {
            state.upsertHandler = handler as typeof state.upsertHandler;
          }
        },
      },
      end: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: () => fakeSocket,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi
    .fn()
    .mockResolvedValue({ version: [2, 3000, 0], isLatest: true }),
  downloadMediaMessage: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));

vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-baileys-issue-290-test',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_MESSAGE_DEBOUNCE: false,
    FEATURE_PRESENCE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: { createInbound: createInboundMock },
  channelsRepo: {
    findByExternalCrossTenant: findByExternalCrossTenantMock,
    findPrimaryCatchAllChannel: findPrimaryCatchAllChannelMock,
  },
}));

vi.mock('@/gateway/dedup.js', () => ({
  isDuplicate: isDuplicateMock,
  markSeen: markSeenMock,
}));

vi.mock('@/gateway/presence.js', () => ({ markRead: vi.fn() }));

vi.mock('@/gateway/queue.js', () => ({ enqueueAgent: enqueueAgentMock }));

vi.mock('@/gateway/debouncer.js', () => ({
  scheduleDebouncedAgent: vi.fn(),
}));

vi.mock('@/gateway/bot-detection.js', () => ({
  checkBotAndMaybeBlock: checkBotAndMaybeBlockMock,
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('@/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));

vi.mock('@/agent/message-update.js', () => ({
  routeMessageUpdate: vi.fn(),
}));

vi.mock('@/setup/state.js', () => ({
  setupState: {
    current: () => ({ phase: 'connected' }),
    setQr: vi.fn(),
    markPaired: vi.fn(),
    markDisconnected: vi.fn(),
  },
}));

vi.mock('@/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: () => true,
    writeFileSync: vi.fn(),
  };
});

// --- Helpers ---------------------------------------------------------------

function makeChannel(overrides: Partial<Channel>): Channel {
  const now = new Date();
  return {
    id: 'ch-default',
    tenant_id: 'tenant-default-test',
    agent_id: 'agent-default-test',
    external_id: '+5511000000000',
    channel_type: 'whatsapp',
    display_name: 'WA',
    active: true,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Channel;
}

function inbound(jid: string, id: string, extras: Record<string, unknown> = {}) {
  return {
    key: { fromMe: false, remoteJid: jid, id, ...extras },
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: 'olá' },
    pushName: 'Cliente',
  };
}

// --- Tests -----------------------------------------------------------------

describe('baileys messages.upsert — runs handleIncoming inside RESOLVED tenant context (issue #290)', () => {
  beforeEach(async () => {
    findByExternalCrossTenantMock.mockReset();
    findPrimaryCatchAllChannelMock.mockReset();
    // Default: MULTI-TENANT deployment → a channel miss is fail-loud (the
    // cross-tenant contract). The single-tenant scenario overrides this.
    findPrimaryCatchAllChannelMock.mockResolvedValue({ multi_tenant: true, channel: null });
    createInboundMock.mockReset();
    enqueueAgentMock.mockClear();
    auditMock.mockClear();
    isDuplicateMock.mockClear();
    markSeenMock.mockClear();
    checkBotAndMaybeBlockMock.mockReset();
    checkBotAndMaybeBlockMock.mockResolvedValue(false);
    handlerState.upsertHandler = null;
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.reset();
  });

  it('two JIDs → each handleIncoming runs under its own resolved tenant (cross-tenant happy path)', async () => {
    findByExternalCrossTenantMock.mockImplementation(async (args) => {
      if (args.external_id === '+5511111111111') {
        return makeChannel({
          id: 'ch-A',
          tenant_id: 'tenant-A',
          agent_id: 'agent-A',
          external_id: '+5511111111111',
        });
      }
      if (args.external_id === '+5511222222222') {
        return makeChannel({
          id: 'ch-B',
          tenant_id: 'tenant-B',
          agent_id: 'agent-B',
          external_id: '+5511222222222',
        });
      }
      return null;
    });

    const observed: Array<{ tenant_id: string; agent_id: string }> = [];
    createInboundMock.mockImplementation(async () => {
      const { tryGetCurrentContext } = await import(
        '@/db/tenant-context.js'
      );
      const ctx = tryGetCurrentContext();
      if (!ctx) throw new Error('no ALS context');
      observed.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
      return {
        row: {
          id: `msg-${observed.length}`,
          tenant_id: ctx.tenant_id,
          agent_id: ctx.agent_id,
        },
        duplicate: false,
      };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();
    expect(handlerState.upsertHandler).not.toBeNull();

    await handlerState.upsertHandler!({
      messages: [
        inbound('5511111111111@s.whatsapp.net', 'WAID-A'),
        inbound('5511222222222@s.whatsapp.net', 'WAID-B'),
      ],
    });

    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
    });
    expect(observed[1]).toEqual({
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
    });
    // Neither message landed in primary/primary — the bug this PR closes.
    expect(observed).not.toContainEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
    });
  });

  it('cross-tenant ADVERSARIAL: tenant A JID NEVER injects context into tenant B', async () => {
    // Simulate the scenario the issue calls out: the resolver returns the
    // ACTIVE owner for a given phone. Even when the same phone has historic
    // rows in another tenant (inactive — recently switched providers), the
    // active resolution wins and ONLY that tenant's ALS is entered.
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        external_id: '+5511333333333',
      }),
    );

    let observedTenant: string | null = null;
    let observedAgent: string | null = null;
    createInboundMock.mockImplementation(async () => {
      const { getCurrentTenant, getCurrentAgent } = await import(
        '@/db/tenant-context.js'
      );
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      return {
        row: {
          id: 'msg-adv',
          tenant_id: observedTenant,
          agent_id: observedAgent,
        },
        duplicate: false,
      };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('5511333333333@s.whatsapp.net', 'WAID-ADV')],
    });

    expect(observedTenant).toBe('tenant-A');
    expect(observedAgent).toBe('agent-A');
    // Defensive: explicit non-match against any other tenant the test
    // mentions, anchoring that no leak occurs even by accident.
    expect(observedTenant).not.toBe('tenant-B');
    expect(observedTenant).not.toBe('primary');
  });

  it('unknown JID → handleIncoming NOT invoked; audit channel_resolution_failed emitted (fail-closed)', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(null); // miss
    createInboundMock.mockImplementation(async () => {
      throw new Error('createInbound MUST NOT run for unknown JID');
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('5511999999999@s.whatsapp.net', 'WAID-UNKNOWN')],
    });

    // handleIncoming never reached createInbound.
    expect(createInboundMock).not.toHaveBeenCalled();
    expect(enqueueAgentMock).not.toHaveBeenCalled();

    // Audit emitted with the resolution-failure action and resolver details.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => (call[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
    const audited = failedAudits[0]![0] as {
      acao: string;
      metadata: Record<string, unknown>;
    };
    expect(audited.metadata.error_code).toBe('channel_resolution_failed');
    expect(audited.metadata.raw_jid).toBe('5511999999999@s.whatsapp.net');
    expect(audited.metadata.whatsapp_id).toBe('WAID-UNKNOWN');
    expect(audited.metadata.emitter).toBe('baileys_ingress');
    expect(
      (audited.metadata.resolver_details as { resolver_path?: string })
        ?.resolver_path,
    ).toBe('unknown_or_inactive_channel');
  });

  it('malformed JID → audit + drop, NO repo lookup (jid_unparseable)', async () => {
    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('not-a-jid', 'WAID-MALFORMED')],
    });

    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(createInboundMock).not.toHaveBeenCalled();
    const failedAudits = auditMock.mock.calls.filter(
      (call) => (call[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
    const md = (failedAudits[0]![0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(
      (md.resolver_details as { resolver_path?: string })?.resolver_path,
    ).toBe('jid_unparseable');
  });

  it('🟠 MEDIUM (#417): malformed envelope with NO key → fail-closed audit (channel_resolution_failed), NOT an opaque handle_failed crash', async () => {
    // A content envelope that is missing `msg.key` entirely. The upsert loop
    // does NOT skip it (it has `message` content), so it reaches
    // resolveTenantCtxForUpsert. There `jid = msg.key?.remoteJid ?? null` → null
    // → resolveScopeForJid(null) fails closed → the catch builds the audit. The
    // bug this guards: the audit/log path dereferenced `msg.key.id` directly, so
    // a no-key envelope threw a TypeError that escaped as `baileys.handle_failed`
    // — BYPASSING the intended channel_resolution_failed audit. With
    // `msg.key?.id` the audit is emitted cleanly with whatsapp_id: null.
    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    // No `key` property at all — only content.
    const noKeyMsg = {
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'olá sem key' },
      pushName: 'Cliente',
    };

    // Must NOT throw out of the handler (the deref bug would crash the audit).
    await expect(
      handlerState.upsertHandler!({ messages: [noKeyMsg] }),
    ).resolves.toBeUndefined();

    // No tenant resolution, no inbound persisted.
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(createInboundMock).not.toHaveBeenCalled();

    // The intended fail-closed audit IS emitted (it was bypassed before the fix).
    const failedAudits = auditMock.mock.calls.filter(
      (call) => (call[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
    const md = (failedAudits[0]![0] as { metadata: Record<string, unknown> }).metadata;
    // whatsapp_id safely null (no key) instead of throwing a TypeError.
    expect(md.whatsapp_id).toBeNull();
    expect(md.raw_jid).toBeNull();
    expect(md.emitter).toBe('baileys_ingress');
  });

  it('group JID (@g.us) → audit + drop with resolver_path=jid_unparseable (defense in depth)', async () => {
    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('120363025111111111@g.us', 'WAID-GROUP')],
    });

    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(createInboundMock).not.toHaveBeenCalled();
  });

  it('#411 single-tenant → arbitrary sender resolves to primary/primary via catch-all and IS processed', async () => {
    // Exact-match misses (the sender phone is not a registered bot line), and
    // no real tenant exists → catch-all maps it to the seeded primary channel.
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

    let observedTenant: string | null = null;
    let observedAgent: string | null = null;
    createInboundMock.mockImplementation(async () => {
      const { getCurrentTenant, getCurrentAgent } = await import(
        '@/db/tenant-context.js'
      );
      observedTenant = getCurrentTenant();
      observedAgent = getCurrentAgent();
      return {
        row: { id: 'msg-single', tenant_id: 'primary', agent_id: 'primary' },
        duplicate: false,
      };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('5511444444444@s.whatsapp.net', 'WAID-SINGLE')],
    });

    // The message IS processed (the bug #411 fixed: no DLQ drop).
    expect(createInboundMock).toHaveBeenCalled();
    expect(observedTenant).toBe('primary');
    expect(observedAgent).toBe('primary');
    // No fail-loud audit — the catch-all resolved it.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => (call[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(0);
  });

  it('@lid JID with senderPn → resolves via the real phone and runs under the owning tenant', async () => {
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({
        tenant_id: 'tenant-lid',
        agent_id: 'agent-lid',
        external_id: '+5511555555555',
      }),
    );

    let observedTenant: string | null = null;
    createInboundMock.mockImplementation(async () => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      return {
        row: { id: 'msg-lid', tenant_id: observedTenant, agent_id: 'agent-lid' },
        duplicate: false,
      };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [
        inbound('99999@lid', 'WAID-LID', { senderPn: '5511555555555' }),
      ],
    });

    expect(observedTenant).toBe('tenant-lid');
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '+5511555555555',
    });
  });

  it('@lid without senderPn and no LID store mapping → audit channel_resolution_skipped_lid_unmapped (NOT channel_resolution_failed), dropped', async () => {
    // No LID mapping store on the socket → resolvePhoneFromLidStore returns null.
    delete (fakeSocket as Record<string, unknown>).signalRepository;
    createInboundMock.mockImplementation(async () => {
      throw new Error('createInbound MUST NOT run for an unmapped @lid');
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('168813890908183@lid', 'WAID-LID-SYNC')],
    });

    // Never reached the channel repo or persisted anything (fail-closed drop).
    expect(findByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(createInboundMock).not.toHaveBeenCalled();
    expect(enqueueAgentMock).not.toHaveBeenCalled();

    // The de-noised, dedicated action — NOT the generic failure.
    const skipped = auditMock.mock.calls.filter(
      (c) =>
        (c[0] as { acao?: string })?.acao ===
        'channel_resolution_skipped_lid_unmapped',
    );
    expect(skipped).toHaveLength(1);
    const md = (skipped[0]![0] as { metadata: Record<string, unknown> }).metadata;
    expect(md.raw_jid).toBe('168813890908183@lid');
    expect(md.whatsapp_id).toBe('WAID-LID-SYNC');
    expect(md.emitter).toBe('baileys_ingress');
    expect(
      (md.resolver_details as { resolver_path?: string })?.resolver_path,
    ).toBe('lid_unmapped');

    // The generic ownership-miss action stays clean of this benign sync noise.
    const failed = auditMock.mock.calls.filter(
      (c) => (c[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failed).toHaveLength(0);
  });

  it('@lid without senderPn but LID store maps it → recovers the real phone, resolves and processes', async () => {
    const getPNForLID = vi
      .fn()
      .mockResolvedValue('5511555555555@s.whatsapp.net');
    (fakeSocket as Record<string, unknown>).signalRepository = {
      lidMapping: { getPNForLID },
    };
    findByExternalCrossTenantMock.mockResolvedValueOnce(
      makeChannel({
        tenant_id: 'tenant-lid-store',
        agent_id: 'agent-lid-store',
        external_id: '+5511555555555',
      }),
    );

    let observedTenant: string | null = null;
    let observedTel: unknown = null;
    createInboundMock.mockImplementation(async (arg: unknown) => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observedTenant = getCurrentTenant();
      observedTel = (arg as { metadata?: { telefone?: unknown } })?.metadata
        ?.telefone;
      return {
        row: { id: 'msg-lid-store', tenant_id: observedTenant, agent_id: 'agent-lid-store' },
        duplicate: false,
      };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [inbound('168813890908183@lid', 'WAID-LID-STORE')],
    });

    expect(getPNForLID).toHaveBeenCalledWith('168813890908183@lid');
    // Routing used the store-recovered phone, not the synthetic LID.
    expect(observedTenant).toBe('tenant-lid-store');
    expect(findByExternalCrossTenantMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '+5511555555555',
    });
    expect(createInboundMock).toHaveBeenCalled();
    // Identity (tel) is the REAL phone too — consistent with routing.
    expect(observedTel).toBe('+5511555555555');

    // No drop audits of either kind.
    const drops = auditMock.mock.calls.filter((c) =>
      [
        'channel_resolution_failed',
        'channel_resolution_skipped_lid_unmapped',
      ].includes((c[0] as { acao?: string })?.acao ?? ''),
    );
    expect(drops).toHaveLength(0);

    // Cleanup so the shared fakeSocket doesn't leak the store into other tests.
    delete (fakeSocket as Record<string, unknown>).signalRepository;
  });

  it('one failure does not poison the rest: unknown JID followed by known JID in the same batch', async () => {
    findByExternalCrossTenantMock
      .mockResolvedValueOnce(null) // first message: unknown
      .mockResolvedValueOnce(
        makeChannel({
          tenant_id: 'tenant-known',
          agent_id: 'agent-known',
          external_id: '+5511666666666',
        }),
      );

    const observed: string[] = [];
    createInboundMock.mockImplementation(async () => {
      const { getCurrentTenant } = await import('@/db/tenant-context.js');
      observed.push(getCurrentTenant());
      return { row: { id: 'msg', tenant_id: 'x', agent_id: 'x' }, duplicate: false };
    });

    const { startBaileys } = await import('@/gateway/baileys.js');
    await startBaileys();

    await handlerState.upsertHandler!({
      messages: [
        inbound('5510000000000@s.whatsapp.net', 'WAID-1'), // unknown
        inbound('5511666666666@s.whatsapp.net', 'WAID-2'), // known
      ],
    });

    expect(observed).toEqual(['tenant-known']);
    // One audit for the failure path; none for the success path.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => (call[0] as { acao?: string })?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
  });
});
