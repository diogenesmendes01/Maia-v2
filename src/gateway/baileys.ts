import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { sha256 } from '@/lib/utils.js';
import { mensagensRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { isDuplicate, markSeen } from './dedup.js';
import { markRead } from './presence.js';
import { enqueueAgent, QueueRedisUnavailableError } from './queue.js';
import { scheduleDebouncedAgent } from './debouncer.js';
import { checkBotAndMaybeBlock } from './bot-detection.js';
import { audit } from '@/governance/audit.js';
import { dispatchReactionAsAnswer, dispatchPollVote } from '@/agent/one-tap.js';
import { routeMessageUpdate } from '@/agent/message-update.js';
import type { WhatsAppInbound, WAQuotedContext } from './types.js';
import { setupState } from '@/setup/state.js';
import { triggerRecovery } from '@/setup/recovery.js';
import { resolveScopeForJid } from './jid-tenant-resolver.js';

let socket: WASocket | null = null;
let connected = false;
let lastDisconnectAt: Date | null = null;

/**
 * Exponential backoff for transient reconnects. Each `connection: 'close'`
 * with reason ≠ loggedOut increments the attempt counter; the next reconnect
 * waits `attempt * 1000ms` capped at 30s. After RECONNECT_MAX_ATTEMPTS
 * consecutive failures we stop the auto-loop and flip setupState to
 * `recovering`, forcing the operator path. A successful `connection: 'open'`
 * resets the counter.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 5;
let reconnectAttempts = 0;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(attempt * RECONNECT_BASE_MS, RECONNECT_MAX_MS);
}

export const MEDIA_ROOT = join(config.BAILEYS_AUTH_DIR, '..', 'media');

/**
 * Create the media directories (`<MEDIA_ROOT>` and `<MEDIA_ROOT>/tmp`).
 *
 * Idempotent (`recursive: true`). IMPORTING THIS MODULE MUST HAVE NO
 * FILESYSTEM SIDE EFFECTS: the admin-ui imports the tool registry (via
 * `send-proactive-message.ts` → baileys), and an admin-ui process must never
 * write `media/` dirs on import. The backend (`maia-app`) calls this at boot
 * from `startBaileys()`; every code path that WRITES under `MEDIA_ROOT` /
 * `MEDIA_ROOT/tmp` (inbound media downloads via `mediaPathFor`, PDF report
 * generation in `lib/pdf/*`) also calls it (or guards with `existsSync`), so
 * the dirs exist before any write even when `startBaileys()` has not run
 * (tests, isolated PDF generation). Backend behaviour is unchanged — the only
 * difference is that a bare `import` no longer touches the filesystem.
 */
export function ensureMediaDirs(): void {
  mkdirSync(MEDIA_ROOT, { recursive: true });
  // B3b: tmp subdir for in-flight PDF reports.
  mkdirSync(join(MEDIA_ROOT, 'tmp'), { recursive: true });
}

export function isBaileysConnected(): boolean {
  return connected;
}

/**
 * SETUP: request an 8-digit pairing code from WhatsApp. Used when the
 * operator chooses "Pair with phone number" in the /setup endpoint.
 * Throws `baileys_socket_not_ready` if the socket hasn't been initialised
 * yet (boot race: startServer() runs before startBaileys()). Caller (the
 * /setup/start route) translates the throw into 503 + retry_after_s.
 *
 * Strips a leading "+" before delegating: Baileys' `requestPairingCode`
 * pipes the phone through `jidEncode(phone, 's.whatsapp.net')`, so a "+"
 * leaks into the JID (`+55…@s.whatsapp.net`) and WhatsApp rejects the
 * request. WhatsApp's pairing-code API expects digits-only.
 */
export async function triggerPairingCode(phone: string): Promise<string> {
  if (!socket) throw new Error('baileys_socket_not_ready');
  const normalized = phone.replace(/^\+/, '');
  return socket.requestPairingCode(normalized);
}

export function getSocket(): WASocket | null {
  return socket;
}

type StubLike = { messageStubType?: number | null | undefined };

/**
 * Numeric value of `proto.WebMessageInfo.StubType.REACTION` in Baileys.
 * Hard-coded as a number to keep `proto` as a type-only import (importing
 * it as a value pulls in the full protobuf runtime). If Baileys ever
 * renumbers the enum, the unit test for `isReactionStub` will catch it.
 */
export const REACTION_STUB_TYPE = 67;

export function isReactionStub(msg: StubLike): boolean {
  return msg.messageStubType === REACTION_STUB_TYPE;
}

type ConnectionUpdate = {
  connection?: 'open' | 'close' | 'connecting';
  lastDisconnect?: { error?: unknown } | null;
  qr?: string;
};

async function handleConnectionUpdate(update: ConnectionUpdate): Promise<void> {
  const { connection: conn, lastDisconnect, qr } = update;
  if (qr) {
    const phaseBefore = setupState.current().phase;
    setupState.setQr(qr);
    if (phaseBefore !== 'pairing_qr') {
      await audit({ acao: 'pairing_qr_displayed', metadata: {} });
    }
    qrcodeTerminal.generate(qr, { small: true }); // keep stdout for dev/log spelunking
  }
  if (conn === 'open') {
    connected = true;
    reconnectAttempts = 0;
    logger.info('baileys.connected');
    await audit({ acao: 'whatsapp_connected' });
    // pairing_completed is one-shot per successful pair (spec §4.7(b)). Skip
    // when the previous phase was already 'connected' — that path is a
    // transient reconnect (no QR/code was exchanged), not a new pair event.
    const phaseBefore = setupState.current().phase;
    setupState.markPaired();
    if (phaseBefore !== 'connected') {
      await audit({ acao: 'pairing_completed' });
    }
  } else if (conn === 'close') {
    connected = false;
    lastDisconnectAt = new Date();
    const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
    logger.warn({ reason }, 'baileys.connection_closed');
    await audit({ acao: 'whatsapp_disconnected', metadata: { reason } });
    if (reason === DisconnectReason.loggedOut) {
      await audit({ acao: 'pairing_logged_out', metadata: { reason } });
      reconnectAttempts = 0;
      triggerRecovery({ shutdownBaileys, startBaileys }).catch((err) => {
        logger.error({ err }, 'setup.recovery_failed');
      });
    } else {
      setupState.markDisconnected();
      reconnectAttempts += 1;
      if (reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
        logger.error({ attempts: reconnectAttempts }, 'baileys.reconnect_giving_up');
        reconnectAttempts = 0;
        // Flip to recovering — the auto-loop is exhausted, the operator
        // path takes over via the same recovery hook used for loggedOut.
        triggerRecovery({ shutdownBaileys, startBaileys }).catch((err) => {
          logger.error({ err }, 'setup.recovery_failed');
        });
        return;
      }
      const delay = reconnectDelayMs(reconnectAttempts);
      logger.info(
        { attempt: reconnectAttempts, delay_ms: delay },
        'baileys.reconnect_scheduled',
      );
      setTimeout(() => {
        startBaileys().catch((e) => logger.error({ err: e }, 'baileys.reconnect_failed'));
      }, delay);
    }
  }
}

export async function startBaileys(): Promise<void> {
  // Backend boot (maia-app): create media dirs here, NOT at module load, so
  // importing this module (e.g. from the admin-ui tool catalog) has no fs side
  // effects. Idempotent.
  ensureMediaDirs();
  const { state, saveCreds } = await useMultiFileAuthState(config.BAILEYS_AUTH_DIR);
  // Pin the WA Web protocol version to whatever WhatsApp is currently
  // serving. Without this, Baileys uses the version hardcoded at the time
  // the library was published — when WhatsApp ships a server-side bump,
  // the handshake fails with "Connection Failure / reason: 405" before
  // any QR or pairing code is emitted. fetchLatestBaileysVersion hits
  // the upstream Baileys version manifest (cached by the library) and
  // returns the current { version, isLatest } pair. Best-effort: if the
  // fetch fails (offline boot, DNS), fall back to the library default.
  let version: [number, number, number] | undefined;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    logger.info({ version, isLatest: latest.isLatest }, 'baileys.version_resolved');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'baileys.version_fetch_failed');
  }
  socket = makeWASocket({ auth: state, version, printQRInTerminal: false });

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', handleConnectionUpdate);

  // Baileys ingress entry-points wrap every callback in a tenant context.
  // The repos called by `handleIncoming`/`routeMessageUpdate`
  // (mensagensRepo.findByWhatsappId, createInbound, …) call
  // `getCurrentTenant()` and throw MissingTenantContextError when run
  // outside a context — without this wrap the try/catch below would log
  // `baileys.handle_failed` and silently drop every inbound message in
  // production.
  //
  // [Issue #290 — CRITICAL runtime tenant resolution]
  // PRs #252/#253/#257/#258/#259/#264/#277 scoped the gateway downstream
  // (rate-limit, dedup, bot-detection, debouncer, pub/sub, vision-cache)
  // by `tenant_id`+`agent_id` read from the ALS. Before this fix, the
  // upsert handler hardcoded `{tenant_id:'default', agent_id:'default'}`
  // as the ALS context, which collapsed EVERY tenant's traffic into the
  // same shared bucket in production:
  //   - `maia:ratelimit:default:default:*` shared across tenants,
  //   - `maia:dedup:default:default:*` shared across tenants,
  //   - bot-detection windowed counters shared,
  //   - debounce identities shared (same phone in tenant A would
  //     debounce tenant B's pending message),
  //   - …
  // Tests passed because the adversarial fixtures inject ALS manually;
  // production never resolved the real tenant at the entry point.
  //
  // POST-FIX (this block) — MULTI_CHANNEL removed / always on after #411:
  //   - Always call `resolveScopeForJid` BEFORE `handleIncoming`. The resolver
  //     reuses the same `channelsRepo.findByExternalCrossTenant` policy as
  //     agent/core.ts (single source of truth for channel ownership + the
  //     issue #268 fail-loud contract). On success, every downstream layer
  //     sees the REAL (tenant_id, agent_id) via the ALS.
  //   - SINGLE-TENANT runtime: the resolver's catch-all (#411) maps any
  //     parseable sender JID to the seeded `default/default` channel, so the
  //     bot keeps answering everyone without a per-sender channel row.
  //   - Fail-closed on resolution failure (unknown JID in a MULTI-TENANT
  //     config, inactive/ambiguous channel, malformed JID, DB error): emit
  //     `channel_resolution_failed` audit (system bucket — `audit()`
  //     auto-wraps when no ALS context is active) and DROP the message.
  //     We do NOT fall back to `default/default` — that is exactly the
  //     bypass issue #240/#268 closed downstream; reintroducing it here
  //     would re-collapse all unknown traffic on a different code path.
  //
  // The agent worker's adoption step (`adoptToResolvedTenantCrossTenant`
  // in `runAgentForMensagem`) is a true no-op in single-tenant (resolved
  // tenant IS default/default) and an idempotent UPDATE for multi-tenant
  // retries — safe defense-in-depth either way.
  socket.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      // [Codex review #311 — B3] Reaction stubs arrive with
      // `msg.message === undefined` (the payload is a `messageStubType`, not a
      // content envelope). The previous `if (!msg.message) continue` ran BEFORE
      // `handleIncoming`, so the `isReactionStub` branch inside it was DEAD
      // CODE — reactions never reached the one-tap dispatcher. We must let
      // reaction stubs through, but they still need a tenant context:
      // `dispatchReactionAsAnswer` calls tenant-scoped repos
      // (`mensagensRepo.findByWhatsappId`, `pessoasRepo`, …) that throw without
      // an ALS. Both reaction stubs AND content messages carry `msg.key`
      // (remoteJid), which is all the JID→tenant resolver needs — so we resolve
      // FIRST, then route inside `runWithTenantContext`. Any other envelope
      // that has neither content nor a reaction stub (pure receipts) is skipped
      // to avoid a pointless resolver round-trip.
      const reactionStub = isReactionStub(msg);
      if (!msg.message && !reactionStub) continue;
      try {
        const ctx = await resolveTenantCtxForUpsert(msg);
        if (!ctx) continue; // resolution failed → audit emitted + drop
        await runWithTenantContext(ctx.scope, () =>
          handleIncoming(msg, { channel_id: ctx.channel_id }),
        );
      } catch (err) {
        logger.error({ err }, 'baileys.handle_failed');
      }
    }
  });

  socket.ev.on('messages.update', async (updates) => {
    if (!config.FEATURE_MESSAGE_UPDATE) return;
    for (const update of updates) {
      try {
        // Baileys 6.7.0 delivers `update` as `{ key, update: Partial<WAMessageInfo> }`.
        // We synthesise an IWebMessageInfo whose `message` is the `update.message`
        // payload so routeMessageUpdate can branch on editedMessage / protocolMessage.
        // The `as never` cast is intentional — runtime structure is what matters.
        //
        // [Codex review #277 v2 BLOQUEADO fix] Resolve target whatsapp_id
        // cross-tenant BEFORE entering ALS, then run routeMessageUpdate in
        // the resolved tenant context. Rationale: `runAgentForMensagem`
        // adopts inbound rows from (default, default) into the real
        // (tenant_id, agent_id) when the resolver succeeds. A subsequent
        // edit/revoke arriving via this listener has no tenant context;
        // running `routeMessageUpdate` under `default/default` would
        // cause `mensagensRepo.findByWhatsappId` to miss the (now-adopted)
        // original and the edit/revoke would be silently dropped
        // (edit_unknown_original / revoke_unknown_original). The fix
        // mirrors `runAgentForMensagem`'s adopt-then-runWithTenantContext
        // ordering: discover the owning tenant via the sanctioned cross-
        // tenant lookup, then operate fully scoped from that point on.
        const target_whatsapp_id = extractMessageUpdateTargetId(update);
        if (!target_whatsapp_id) {
          // Read receipts / status updates / unsupported envelope shapes —
          // routeMessageUpdate would no-op anyway. Skip without touching DB.
          continue;
        }
        const original = await mensagensRepo.findByWhatsappIdCrossTenant(
          target_whatsapp_id,
        );
        if (!original) {
          // Genuinely unknown message (never inbound through us, or already
          // GC'd). Preserve the existing fail-soft contract — routeMessageUpdate
          // also returns silently on null `findByWhatsappId`. Log so triage
          // can spot a pattern (e.g., a real bug producing stranded edits).
          logger.debug(
            { whatsapp_id: target_whatsapp_id },
            'message_update.cross_tenant_lookup_miss',
          );
          continue;
        }
        await runWithTenantContext(
          { tenant_id: original.tenant_id, agent_id: original.agent_id },
          () =>
            routeMessageUpdate({
              key: update.key,
              message: update.update.message,
            } as never),
        );
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'message_update.dispatch_failed');
      }
    }
  });
}

/**
 * Extract the whatsapp_id of the message being edited/revoked from a Baileys
 * `messages.update` payload. Mirrors the dispatch logic in
 * `routeMessageUpdate` (src/agent/message-update.ts):
 *   - editedMessage  → the envelope's key.id IS the target id (the edit is
 *                      delivered as an update for the original message key).
 *   - protocolMessage type=0 (REVOKE) → target id is `protocolMessage.key.id`.
 *   - anything else (read receipts, status updates) → null (caller skips).
 *
 * Exported as a `_internal` member so the unit test can drive it directly
 * without a full Baileys handshake.
 */
function extractMessageUpdateTargetId(update: {
  key?: { id?: string | null } | null;
  update?: { message?: proto.IMessage | null | undefined } | null;
}): string | null {
  const envelopeId = update.key?.id ?? null;
  const m = update.update?.message ?? null;
  if (!m) return null;
  if (m.editedMessage) return envelopeId;
  if (m.protocolMessage?.type === 0 && m.protocolMessage.key?.id) {
    return m.protocolMessage.key.id;
  }
  return null;
}

/**
 * Issue #290 — resolve the (tenant_id, agent_id, channel_id) for an inbound
 * Baileys message BEFORE entering `runWithTenantContext`, so every downstream
 * tenant-scoped layer (rate-limit, dedup, bot-detection, debouncer, …) sees
 * the real tenant in ALS instead of the synthetic `default/default`.
 *
 * RETURN CONTRACT:
 *   - `{ scope, channel_id }`  → caller MUST run handleIncoming inside
 *     `runWithTenantContext(scope, …)`.
 *   - `null`                   → resolution failed (or skip path). Caller
 *     MUST NOT process this message. The audit has already been written
 *     (system bucket) and the message is dropped fail-closed.
 *
 * Always calls `resolveScopeForJid` (MULTI_CHANNEL removed / always on after
 * issue #411). The resolver canonicalizes JID parsing (`@s.whatsapp.net` /
 * `@c.us` / `@lid` w/ senderPn) and delegates to the shared `resolveChannel`
 * (the same one `agent/core.ts` uses for the post-persist adoption — single
 * source of truth for ownership policy).
 *
 *   - SINGLE-TENANT runtime: `resolveChannel`'s catch-all (issue #411) maps
 *     ANY parseable sender JID to the seeded `default/default` channel, so
 *     every real inbound resolves and the bot answers everyone. The worker's
 *     adoption step stays a no-op (resolved tenant IS default/default).
 *   - MULTI-TENANT deployment: exact-match scopes the inbound to its real
 *     owner; an unknown/inactive/ambiguous sender throws
 *     `TypedError('channel_resolution_failed')` (issue #268 fail-loud) — we
 *     emit the `channel_resolution_failed` audit and return null. We DO NOT
 *     fall back to `default/default`; that bypass is exactly what #240/#268
 *     closed.
 *
 *   A `TypedError('channel_resolution_failed')` also covers an unparseable
 *   JID (malformed, group, `@lid` w/o senderPn) — audited + dropped.
 *
 * Errors that are NOT TypedError (e.g. a sudden DB outage) are also
 * audited and dropped here so a single transient failure does not crash
 * the upsert listener — the per-message `for` loop continues with the
 * next message.
 */
async function resolveTenantCtxForUpsert(
  msg: proto.IWebMessageInfo,
): Promise<{
  scope: { tenant_id: string; agent_id: string };
  channel_id: string | null;
} | null> {
  // [Codex review #311 — minor] `msg.key` can be absent on malformed
  // envelopes; optional-chain so a missing key resolves to a null JID
  // (→ fail-closed in resolveScopeForJid) instead of a raw TypeError that
  // would escape to the listener's catch as an opaque `baileys.handle_failed`.
  const jid = msg.key?.remoteJid ?? null;
  // Mirror `handleIncoming`'s LID fallback: pull the real phone from
  // senderPn/participantPn when the visible JID is `@lid`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const key = msg.key as any;
  const keyHints = {
    senderPn: typeof key?.senderPn === 'string' ? key.senderPn : null,
    participantPn:
      typeof key?.participantPn === 'string' ? key.participantPn : null,
  };

  try {
    const { scope, jid_context } = await resolveScopeForJid(jid, keyHints);
    // jid_context is observability metadata (LID fallback, raw_jid,
    // resolved phone) — propagated via logs, not via handleIncoming.
    // handleIncoming derives `tel` from msg.key directly, mirroring its
    // pre-#290 behavior; the ALS context is the only thing it consumes
    // from upstream.
    if (jid_context.via_lid_fallback) {
      logger.debug(
        {
          raw_jid: jid_context.raw_jid,
          whatsapp_id: msg.key.id ?? null,
        },
        'baileys.lid_fallback_resolved',
      );
    }
    return {
      scope: { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
      channel_id: scope.channel_id,
    };
  } catch (err) {
    // Typed resolution failure → fail-closed audit + drop. Audit writer
    // wraps in synthetic `system` ALS when none is active (which is the
    // case here — we ARE the entry point).
    const typed = err as { code?: string; details?: unknown };
    const isResolutionFailure = typed?.code === 'channel_resolution_failed';
    await audit({
      acao: 'channel_resolution_failed',
      metadata: {
        // mensagem_id intentionally null — the inbound was NOT persisted
        // (we audit BEFORE createInbound runs). whatsapp_id is the only
        // stable handle the operator has for triage.
        whatsapp_id: msg.key.id ?? null,
        raw_jid: jid,
        error_code: isResolutionFailure
          ? 'channel_resolution_failed'
          : (typed?.code ?? 'unknown'),
        error_message: (err as Error).message,
        resolver_details: typed?.details ?? null,
        // Surface where this audit was emitted from so triage can
        // distinguish gateway-entry failures from worker-level ones
        // (agent/core.ts emits the same action name).
        emitter: 'baileys_ingress',
      },
    });
    logger.warn(
      {
        err: (err as Error).message,
        err_code: typed?.code,
        whatsapp_id: msg.key.id ?? null,
        raw_jid: jid,
      },
      'baileys.channel_resolution_failed_drop',
    );
    return null;
  }
}

async function handleIncoming(
  msg: proto.IWebMessageInfo,
  // [Issue #290] Optional channel_id resolved at the upsert listener. Kept
  // optional so existing unit tests that drive `handleIncoming` directly
  // continue to work unchanged. The metadata is recorded on the inbound row
  // when present so downstream agent logic can short-circuit the resolver
  // probe (defense-in-depth; the worker's probe still functions as fallback).
  opts?: { channel_id?: string | null },
): Promise<void> {
  if (msg.key.fromMe) return;
  const _resolvedChannelId = opts?.channel_id ?? null;

  // B1: poll vote arrives as a pollUpdateMessage. When FEATURE_ONE_TAP is on,
  // route to the one-tap dispatcher and drop. When off, fall through to the
  // existing pipeline (preserves pre-B1 behaviour).
  if (msg.message?.pollUpdateMessage) {
    if (config.FEATURE_ONE_TAP) {
      await dispatchPollVote(msg).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'one_tap.poll_dispatch_failed'),
      );
      return;
    }
    // flag off → fall through; existing extractContent classifies as 'sistema'
  }

  if (isReactionStub(msg)) {
    // existing behaviour: never persist reactions; absorb as one-tap when on.
    if (config.FEATURE_ONE_TAP) {
      await dispatchReactionAsAnswer(msg).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'one_tap.reaction_dispatch_failed'),
      );
    }
    return;
  }
  const remote_jid = msg.key.remoteJid;
  const whatsapp_id = msg.key.id;
  if (!remote_jid || !whatsapp_id) return;

  const is_group = remote_jid.endsWith('@g.us');
  if (is_group) {
    await audit({ acao: 'group_message_ignored', metadata: { remote_jid } });
    return;
  }

  if (await isDuplicate(whatsapp_id)) {
    await audit({ acao: 'duplicate_message_dropped', metadata: { whatsapp_id } });
    return;
  }

  // WhatsApp privacy: alguns contatos chegam como `XXX@lid` (Linked ID)
  // em vez de `5511...@s.whatsapp.net`. O LID é sintético — usá-lo como
  // telefone faz a resolução de identidade falhar pra sempre. Quando vier
  // `@lid`, tenta extrair o telefone real do `senderPn` / `participantPn`
  // que o Baileys popula nessas mensagens. Fallback: split do JID (padrão).
  const isLid = remote_jid.endsWith('@lid');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const k = msg.key as any;
  const realPn: string | undefined =
    typeof k?.senderPn === 'string'
      ? k.senderPn
      : typeof k?.participantPn === 'string'
        ? k.participantPn
        : undefined;
  const rawPhone = isLid && realPn ? realPn.split('@')[0]! : remote_jid.split('@')[0]!;
  const tel = '+' + rawPhone;
  if (isLid && !realPn) {
    logger.warn(
      { remote_jid, whatsapp_id },
      'baileys.lid_without_real_phone',
    );
  }

  if (await checkBotAndMaybeBlock(tel)) {
    logger.warn({ tel: '[REDACTED]' }, 'baileys.dropped_anomalous_volume');
    return;
  }

  const { type, content, mediaPath, mediaMime, mediaSha256 } = await extractContent(msg);

  const { row: stored, duplicate } = await mensagensRepo.createInbound({
    conversa_id: null,
    direcao: 'in',
    tipo: type,
    conteudo: content,
    midia_url: mediaPath,
    metadata: {
      whatsapp_id,
      remote_jid,
      telefone: tel,
      pushname: msg.pushName ?? null,
      timestamp_ms: Number(msg.messageTimestamp ?? 0) * 1000,
      media_mime: mediaMime,
      media_sha256: mediaSha256,
      // [Issue #290] Channel resolved at the ingress. In single-tenant this is
      // the seeded default channel id (#411 catch-all); null only when the
      // resolver path didn't surface a channel_id (e.g., tests driving
      // handleIncoming directly). Persisted for triage and as defense-in-depth
      // — the worker's adoption probe is unaffected by this field.
      ingress_channel_id: _resolvedChannelId,
    },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
  });

  await markSeen(whatsapp_id);
  markRead(remote_jid, whatsapp_id);
  if (duplicate) {
    await audit({ acao: 'duplicate_message_dropped', metadata: { whatsapp_id, source: 'db_unique' } });
    return;
  }

  // Debounce path: only chunked-typing of TEXT messages benefits from
  // buffering. Media (audio/imagem/documento) carries enough self-contained
  // signal to process immediately, and aggregating media + text in one turn
  // would require reshaping extractContent and several agent-core branches
  // — out of scope for this change.
  //
  // FAIL-CLOSED CONTRACT (PR #259 review, MAJOR A second half):
  //   When `scheduleDebouncedAgent` throws (Redis down, BullMQ blip, or
  //   tenant-context error), we MUST NOT fall through to
  //   `enqueueAgent` for the immediate (non-debounced) path. Doing so
  //   re-creates the very bypass the tenant-scoped debounce key was
  //   designed to prevent: `enqueueAgent` uses a different namespace
  //   contract (`process-message` vs. `process-message-debounced`) and
  //   issuing an unscoped job during a Redis outage on a shared phone
  //   number would replay tenant A's pending message under tenant B's
  //   context once Redis recovered. The message is preserved in
  //   `mensagensRepo` (the inbound is already persisted upstream of this
  //   block at line 333), so the next message under the same conversa
  //   will trigger aggregation and the agent will pick up the stranded
  //   inbound — no data loss, just delayed processing during the blip.
  //   The metric / log here is the signal an operator uses to surface
  //   the outage.
  if (config.FEATURE_MESSAGE_DEBOUNCE && type === 'texto') {
    try {
      // `phone` (the user's tel) feeds the tenant-scoped debounce identity.
      // The composite key (`${tenant_id}:${agent_id}:${phone}`) is derived
      // inside `scheduleDebouncedAgent` from the ALS tenant context that
      // `messages.upsert` installs above — so a shared phone across two
      // tenants gets two INDEPENDENT debouncers (issue #248).
      const result = await scheduleDebouncedAgent({ phone: tel, mensagem_id: stored.id });
      logger.info(
        {
          mensagem_id: stored.id,
          tel: '[REDACTED]',
          debounce: result.kind,
          ...(result.kind === 'scheduled' ? { reset: result.reset } : {}),
        },
        'baileys.message.debounced',
      );
      return;
    } catch (err) {
      // FAIL-CLOSED: stop here. The message is already persisted in
      // `mensagensRepo` and `aggregateUnprocessedTexts` will sweep it
      // up on the next debounce cycle (or when the operator restores
      // Redis). Do NOT silently bypass the tenant-scoped debounce by
      // dropping to `enqueueAgent` — see contract block above.
      const errCode = (err as { code?: string }).code;
      logger.warn(
        {
          err: (err as Error).message,
          err_code: errCode,
          mensagem_id: stored.id,
          tel: '[REDACTED]',
          // Distinguishing the two main failure modes lets ops alerts
          // route correctly: REDIS_UNAVAILABLE is infrastructure (page),
          // MISSING_TENANT_CONTEXT is a deploy regression (revert).
          failure_class:
            errCode === 'DEBOUNCER_REDIS_UNAVAILABLE'
              ? 'redis_unavailable'
              : errCode === 'MISSING_TENANT_CONTEXT'
                ? 'tenant_context_missing'
                : 'other',
        },
        'baileys.debounce_failed_fail_closed',
      );
      return;
    }
  }

  // Non-debounced path (media, or debounce feature off). FAIL-CLOSED on a
  // Redis OOM (#309 follow-up, PR #324 B1): the inbound is already persisted
  // above (`createInbound` with `processada_em: null`), so an OOM on
  // `agentQueue.add` must NOT crash the ingress and must NOT mark the row
  // processed — we stop here and let `runMessageRecovery` re-enqueue the
  // still-pending row once Redis has headroom. `enqueueAgent` has already
  // recorded `redis_oom_degraded_total{operation="enqueue_agent"}`; this log
  // is the per-message breadcrumb. A NON-OOM error is left to propagate to the
  // outer `handleIncoming` handler (real bug — surface it), again leaving the
  // row pending (we never reach the "processed" write).
  try {
    await enqueueAgent({ mensagem_id: stored.id });
  } catch (err) {
    if (err instanceof QueueRedisUnavailableError) {
      logger.warn(
        { mensagem_id: stored.id, tel: '[REDACTED]', failure_class: 'redis_unavailable', oom: err.oom },
        'baileys.enqueue_failed_fail_closed',
      );
      return;
    }
    throw err;
  }
  logger.info({ mensagem_id: stored.id, tel: '[REDACTED]' }, 'baileys.message.enqueued');
}

async function extractContent(msg: proto.IWebMessageInfo): Promise<{
  type: WhatsAppInbound['type'];
  content: string | null;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaSha256: string | null;
}> {
  const m = msg.message;
  if (!m) return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null };

  if (m.conversation) {
    return { type: 'texto', content: m.conversation, mediaPath: null, mediaMime: null, mediaSha256: null };
  }
  if (m.extendedTextMessage?.text) {
    return {
      type: 'texto',
      content: m.extendedTextMessage.text,
      mediaPath: null,
      mediaMime: null,
      mediaSha256: null,
    };
  }
  // Media branches: we save the buffer (when available)
  type MediaKind = 'audioMessage' | 'imageMessage' | 'documentMessage';
  const mediaKind: MediaKind | null = m.audioMessage
    ? 'audioMessage'
    : m.imageMessage
      ? 'imageMessage'
      : m.documentMessage
        ? 'documentMessage'
        : null;
  if (!mediaKind) {
    return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null };
  }

  const mime = (m as Record<string, { mimetype?: string; caption?: string }>)[mediaKind]?.mimetype ?? null;
  const caption = (m as Record<string, { mimetype?: string; caption?: string }>)[mediaKind]?.caption ?? null;
  const type: WhatsAppInbound['type'] =
    mediaKind === 'audioMessage' ? 'audio' : mediaKind === 'imageMessage' ? 'imagem' : 'documento';
  let mediaPath: string | null = null;
  let mediaSha256: string | null = null;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {});
    if (Buffer.isBuffer(buf)) {
      const ext =
        mime?.split('/')[1]?.split(';')[0] ?? (type === 'audio' ? 'ogg' : type === 'imagem' ? 'jpg' : 'bin');
      const saved = mediaPathFor(buf, ext);
      mediaPath = saved.path;
      mediaSha256 = saved.sha;
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'baileys.media_download_failed');
  }
  return { type, content: caption, mediaPath, mediaMime: mime, mediaSha256 };
}

/**
 * Send a plain WhatsApp text.
 *
 * `opts.messageId` (issue #327): a CLIENT-PROVIDED, deterministic WhatsApp
 * message id. Baileys forwards it to `MiscMessageGenerationOptions.messageId`,
 * which becomes the outgoing message's key id verbatim (see
 * `generateWAMessageFromContent`: `id: options?.messageId || generateMessageIDV2()`).
 * The WhatsApp protocol keys every message on `(remoteJid, fromMe, id)` — the
 * SAME primitive this gateway already relies on for INBOUND dedup
 * (`isDuplicate(whatsapp_id)`). Supplying a stable id therefore makes a
 * re-dispatch of the same logical effect carry the SAME key, so the transport /
 * recipient client treats the retry as the same message (provider-side dedup)
 * instead of rendering a duplicate. The relayer derives this id from the outbox
 * row's stable identity so a crash-induced re-send is idempotent end-to-end.
 *
 * When `messageId` is omitted, Baileys generates a fresh random id as before
 * (unchanged behaviour for the interactive/non-outbox callers).
 */
export async function sendOutboundText(
  jid: string,
  text: string,
  opts?: { quoted?: WAQuotedContext; view_once?: boolean; messageId?: string },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send');
    return null;
  }
  const useViewOnce = !!opts?.view_once && config.FEATURE_VIEW_ONCE_SENSITIVE;
  const content = useViewOnce ? { text, viewOnce: true } : { text };
  // Baileys' sendMessage accepts `quoted` + `messageId` on the third-arg
  // MiscMessageGenerationOptions. We pass the third arg only when at least one
  // option is present (undefined otherwise) so call arity stays stable.
  const miscOpts =
    opts?.quoted || opts?.messageId
      ? {
          ...(opts.quoted ? { quoted: opts.quoted } : {}),
          ...(opts.messageId ? { messageId: opts.messageId } : {}),
        }
      : undefined;
  const result = await socket.sendMessage(jid, content, miscOpts);
  return result?.key.id ?? null;
}

/**
 * B3b: send a document (PDF) to the recipient. Reads the file into a Buffer
 * (PDFs are bounded by the 500-row hard limit at <500KB, well within memory),
 * eliminating the partially-sent-on-error edge case. View-once is intentionally
 * NOT supported here — see B3b spec §11 for rationale.
 */
export async function sendOutboundDocument(
  jid: string,
  path: string,
  opts: {
    mimetype: string;
    fileName: string;
    caption?: string;
    quoted?: WAQuotedContext;
  },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send document');
    return null;
  }
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    // Read failure happens BEFORE socket.sendMessage → nothing was sent. THROW
    // (instead of returning null) so the caller can't confuse this with the
    // disconnected / sent-without-id null cases and misclassify it as delivered
    // (Codex #216 round-4 — document silent-drop). The sole caller (PDF dispatch)
    // tags this delivered:false and recovers.
    //
    // #227 review: tag the throw with `code = 'DOC_READ_FAILED'` so the dispatch
    // catch can discriminate "definitely pre-send" (this branch) from "transport
    // throw that may have delivered" (socket.sendMessage failure). Without the
    // discriminator the dispatch records 'unknown' for read failures too — and
    // 'unknown' marks the turn as "do-not-retry", reviving the HIGH-1 silent-drop
    // that #216 closed for the document path.
    logger.error({ err, path }, 'baileys.send_document.read_failed');
    const wrapped = new Error(
      `document_read_failed: ${(err as Error).message}`,
    ) as Error & { code?: string };
    wrapped.code = 'DOC_READ_FAILED';
    throw wrapped;
  }
  const result = await socket.sendMessage(
    jid,
    {
      document: buf,
      mimetype: opts.mimetype,
      fileName: opts.fileName,
      caption: opts.caption,
    },
    opts.quoted ? { quoted: opts.quoted } : undefined,
  );
  return result?.key.id ?? null;
}

/**
 * B4: send a voice note (PTT — push-to-talk). Renders as a voice-bubble in
 * the WhatsApp UI (the round one), not a music-player attachment. Buffer-only —
 * voice notes are small (≤100KB for ≤20s) and ephemeral; no disk persistence.
 *
 * The buffer must be OGG-Opus (the format WhatsApp's voice-note protocol
 * expects). OpenAI TTS with `response_format: 'opus'` emits exactly this.
 */
export async function sendOutboundVoice(
  jid: string,
  buf: Buffer,
  opts?: { quoted?: WAQuotedContext },
): Promise<string | null> {
  if (!socket || !connected) {
    logger.warn('baileys.not_connected — cannot send voice');
    return null;
  }
  const result = await socket.sendMessage(
    jid,
    { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true },
    opts?.quoted ? { quoted: opts.quoted } : undefined,
  );
  return result?.key.id ?? null;
}

export async function shutdownBaileys(): Promise<void> {
  if (socket) {
    socket.end(undefined);
    socket = null;
  }
}

export function getLastDisconnectAt(): Date | null {
  return lastDisconnectAt;
}

// Test-only seam. Production code never calls this. Lets unit tests inject a
// mock socket without booting the full WA pairing flow.
export const _internal = {
  _setSocketForTests(s: WASocket | null, isConnected: boolean): void {
    socket = s;
    connected = isConnected;
  },
  _handleConnectionUpdate: handleConnectionUpdate,
  _resetReconnectAttempts(): void {
    reconnectAttempts = 0;
  },
  _getReconnectAttempts(): number {
    return reconnectAttempts;
  },
  _extractMessageUpdateTargetId: extractMessageUpdateTargetId,
  RECONNECT_MAX_ATTEMPTS,
};

// Helper to deterministically create per-message media filenames
export function mediaPathFor(buf: Buffer, ext: string): { path: string; sha: string } {
  // Defensive: ensure MEDIA_ROOT exists even when startBaileys() hasn't run
  // (module load no longer creates it). Idempotent.
  ensureMediaDirs();
  const sha = sha256(buf);
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(MEDIA_ROOT, month);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.${ext}`);
  if (!existsSync(path)) writeFileSync(path, buf);
  return { path, sha };
}
