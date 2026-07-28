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
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { config } from '@/config/env.js';
import {
  assertSafeAuthDir,
  isReservedRootEntry,
  resolvePrimaryAuthDir,
} from '@/setup/auth-dir.js';
import { logger } from '@/lib/logger.js';
import { sha256 } from '@/lib/utils.js';
import { mensagensRepo } from '@/db/repositories.js';
import { runWithTenantContext, getCurrentTenant } from '@/db/tenant-context.js';
import {
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
  sniffMime,
  extensionForMime,
} from '@/lib/media-guard.js';
import { isDuplicate, markSeen } from './dedup.js';
import {
  markRead,
  startTyping as presenceStartTyping,
  sendReaction as presenceSendReaction,
  sendPoll as presenceSendPoll,
} from './presence.js';
import type { LineTransport } from './line-session-manager.js';
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
import { normalizeLineE164 } from './channel-resolver.js';
import { getLineSessionManager } from './line-session-manager.js';
import { channelsRepo } from '@/db/repositories/channel-repos.js';
import { lifecycle } from '@/runtime/lifecycle/controller.js';

let socket: WASocket | null = null;
let connected = false;
let lastDisconnectAt: Date | null = null;

/**
 * §1.1 (spec roteamento v4) — a LINHA desta sessão (E.164 com `+`), capturada
 * no `connection: 'open'` a partir de `socket.user.id`. É o
 * `bot_line_external_id` do contrato de inbound: a identidade CORRETA do
 * canal (a linha em que a mensagem CHEGOU), em oposição ao telefone do
 * remetente que o caminho legado usa. Null até a primeira conexão.
 */
let currentLineE164: string | null = null;

export function getCurrentLineE164(): string | null {
  return currentLineE164;
}

/**
 * Canal (se algum) sob o qual a sessão primária está registrada no manager.
 * Triplete completo (review #498 alto 2): as transições de sessão da
 * primária são auditadas sob o ALS do (tenant, agent) DONO do canal — só o
 * id não permitiria escopar colunas nem labels de métricas.
 */
let primaryChannel: { id: string; tenant_id: string; agent_id: string } | null = null;

/**
 * Transporte da linha PRIMÁRIA (fase 1, spec roteamento v4 §1.5): adapta as
 * primitivas globais deste módulo à interface por-linha do
 * LineSessionManager. Com `MAIA_MULTI_LINE=false` nada muda no envio (a
 * LineOutput usa as globais direto); com o manager ligado, o canal primário
 * resolve para ESTE transporte — mesmos bytes, agora sob posse explícita.
 */
function buildPrimaryLineTransport(): LineTransport {
  return {
    sendText: (jid, text, opts) => sendOutboundText(jid, text, opts),
    sendDocument: (jid, path, opts) => sendOutboundDocument(jid, path, opts),
    sendVoice: (jid, buf, opts) => sendOutboundVoice(jid, buf, opts),
    sendPoll: (jid, question, options) => presenceSendPoll(jid, question, options),
    sendReaction: (jid, wid, emoji) => presenceSendReaction(jid, wid, emoji),
    startTyping: (jid, mid) => presenceStartTyping(jid, mid),
    markRead: (jid, wid) => markRead(jid, wid),
    isConnected: () => connected,
  };
}

/**
 * Registra a sessão primária no LineSessionManager quando a linha capturada
 * casa um canal whatsapp ativo (observabilidade nas fases 1–2; transporte do
 * canal primário na fase 3). Best-effort: falha aqui NUNCA derruba a
 * conexão — sem registro, `MAIA_MULTI_LINE=false` segue com paridade total e
 * o modo shadow segue reportando a divergência da linha.
 */
async function registerPrimaryLineSession(): Promise<void> {
  if (!currentLineE164) {
    logger.debug('line_session.primary_line_unknown_skip_register');
    return;
  }
  try {
    const channel = await channelsRepo.findByExternalCrossTenant({
      channel_type: 'whatsapp',
      external_id: currentLineE164,
    });
    if (!channel || !channel.active) {
      logger.info(
        { line: currentLineE164, found: !!channel },
        'line_session.primary_channel_unmatched',
      );
      return;
    }
    primaryChannel = {
      id: channel.id,
      tenant_id: channel.tenant_id,
      agent_id: channel.agent_id,
    };
    getLineSessionManager().register(channel.id, buildPrimaryLineTransport(), {
      line_external_id: currentLineE164,
      is_primary: true,
    });
    // Review #498 (alto 2): audita sob o ALS do dono do canal — sem o wrap,
    // audit() cai no bucket `system` (colunas e labels de métricas erradas).
    await runWithTenantContext(
      { tenant_id: channel.tenant_id, agent_id: channel.agent_id },
      () =>
        audit({
          acao: 'line_session_transition',
          metadata: {
            channel_id: channel.id,
            line_external_id: currentLineE164,
            state: 'connected',
            is_primary: true,
          },
        }),
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'line_session.primary_register_failed',
    );
  }
}

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

/**
 * Last-resort LID→phone resolver backed by Baileys' signal LID mapping store
 * (`socket.signalRepository.lidMapping.getPNForLID`). Feature-detected: a
 * Baileys build that does not expose the store (older/forked) yields a no-op
 * (returns null), preserving the previous fail-closed behaviour. Wrapped in a
 * try/catch so a store-internal throw never escapes into the ingress loop.
 *
 * This is the second half of the `@lid` fix: `msg.key.senderPn`/`participantPn`
 * is the cheap path (handled in `extractPhoneFromJid`); when those hints are
 * absent (sync/peer events, pre-mapping window) we ask the store, which often
 * knows the phone. Only when BOTH miss do we drop fail-closed as
 * `channel_resolution_skipped_lid_unmapped`.
 */
async function resolvePhoneFromLidStore(lid: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = (socket as any)?.signalRepository?.lidMapping;
  if (!store || typeof store.getPNForLID !== 'function') return null;
  try {
    const pn = await store.getPNForLID(lid);
    return typeof pn === 'string' && pn.length > 0 ? pn : null;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'baileys.lid_store_lookup_failed');
    return null;
  }
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
    // Issue #512 review round 1 (P1 on `src/index.ts:189`): the lifecycle
    // component reaches `ready` HERE, on the first real `open` — not when
    // `startBaileys()` returns. `startBaileys()` only arms the socket, so
    // marking it ready there made a cold start (or a QR that was never
    // scanned) look identical to a transient reconnect: readiness reported
    // `degraded` and, with READINESS_REQUIRE_WHATSAPP_LIVE=false, answered 200
    // for an instance that had never been able to send a single message.
    // `degraded` is only honest AFTER the session has been established once.
    lifecycle.setComponent('whatsapp_session', 'ready');
    // §1.1 — captura a LINHA desta sessão (identidade do canal) e registra a
    // sessão primária no manager (observabilidade fase 1–2; transporte do
    // canal primário na fase 3). Best-effort — nunca bloqueia a conexão.
    currentLineE164 = normalizeLineE164(socket?.user?.id ?? null);
    void registerPrimaryLineSession();
    logger.info({ line: currentLineE164 }, 'baileys.connected');
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
    // Issue #512: a `loggedOut` close means the pairing is GONE — the session
    // cannot recover on its own and the instance genuinely cannot serve the
    // channel, so it fails closed. Any other close is the routine reconnect
    // loop: keep whatever the component already was (`ready` degrades to
    // `degraded` only for a session that was established once), so a WhatsApp
    // hiccup does not flap the whole fleet out of rotation.
    if (reason === DisconnectReason.loggedOut) {
      lifecycle.setComponent('whatsapp_session', 'failed', 'logged out — re-pairing required');
    } else if (lifecycle.getComponent('whatsapp_session').state === 'ready') {
      lifecycle.setComponent('whatsapp_session', 'degraded', 'socket closed — reconnecting');
    }
    // Espelha a transição no manager (invariante 6): loggedOut encerra a
    // posse da linha; qualquer outro close é recuperável (reconnect loop).
    if (primaryChannel) {
      const { id, tenant_id, agent_id } = primaryChannel;
      const nextState =
        reason === DisconnectReason.loggedOut ? ('closed' as const) : ('recovering' as const);
      getLineSessionManager().markState(id, nextState);
      // Review #498 (alto 2): transição auditada sob o ALS do dono do canal.
      await runWithTenantContext({ tenant_id, agent_id }, () =>
        audit({
          acao: 'line_session_transition',
          metadata: {
            channel_id: id,
            state: nextState,
            is_primary: true,
            reason,
          },
        }),
      );
      if (nextState === 'closed') primaryChannel = null;
    }
    await audit({ acao: 'whatsapp_disconnected', metadata: { reason } });
    if (reason === DisconnectReason.loggedOut) {
      await audit({ acao: 'pairing_logged_out', metadata: { reason } });
      reconnectAttempts = 0;
      // Cap. 7 — recovery POR ALVO: o LoggedOut da primária remove apenas
      // primary/ (nunca a raiz — lines/, pairing/ e control/ sobrevivem).
      triggerRecovery({
        target: 'primary',
        line: currentLineE164,
        shutdownBaileys,
        startBaileys,
      }).catch((err) => {
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
        triggerRecovery({
          target: 'primary',
          line: currentLineE164,
          shutdownBaileys,
          startBaileys,
        }).catch((err) => {
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

/** Prefixo dos staging dirs da migração de layout — dentro da raiz para o
 * `rename` de promoção ser atômico (mesmo filesystem). */
const AUTH_MIGRATION_STAGING_PREFIX = '.primary-migration-';

/**
 * Auditoria P0 cap. 7 — a sessão primária deixa de usar a RAIZ do
 * `BAILEYS_AUTH_DIR` e passa a viver em `primary/` (filho direto da raiz),
 * lado a lado com `lines/<id>`, `pairing/<id>` e `control/`. Com isso o
 * recovery da primária pode remover `primary/` sem destruir as credenciais
 * das linhas adicionais, os pareamentos em curso e o setup token.
 *
 * Migração do layout LEGADO (creds.json direto na raiz) no boot:
 *  - move CADA entrada da raiz — exceto as reservadas (`lines/`, `pairing/`,
 *    `control/`, `media/`, `setup-token.txt`) — para um staging dir e promove
 *    com `rename` atômico para `primary/` (staging dentro da raiz ⇒ mesmo
 *    filesystem);
 *  - qualquer falha faz rollback best-effort das entradas já movidas e o
 *    boot SEGUE NO CAMINHO LEGADO (raiz) — log + audit; os arquivos legados
 *    nunca ficam meio-migrados sem sessão utilizável;
 *  - um staging órfão de um boot anterior interrompido é retomado: com
 *    `creds.json` dentro, é a sessão completa (a queda ocorreu entre o move
 *    e o promote) ⇒ promove; sem, devolve as entradas para a raiz.
 * NUNCA toca `lines/`, `pairing/`, `control/` (nem `media/`).
 */
async function ensurePrimaryAuthDirMigrated(): Promise<string> {
  const root = assertSafeAuthDir(config.BAILEYS_AUTH_DIR);
  const primaryDir = resolvePrimaryAuthDir();
  if (existsSync(primaryDir)) return primaryDir;
  if (!existsSync(root)) {
    // Instalação nova — nada legado para migrar.
    mkdirSync(primaryDir, { recursive: true });
    return primaryDir;
  }

  const entries = await readdir(root);

  // Retoma migração interrompida (staging órfão de um boot anterior).
  for (const name of entries) {
    if (!name.startsWith(AUTH_MIGRATION_STAGING_PREFIX)) continue;
    const stagingPath = join(root, name);
    if (existsSync(join(stagingPath, 'creds.json'))) {
      await rename(stagingPath, primaryDir);
      logger.info({ dir: primaryDir }, 'baileys.auth_layout_staging_promoted');
      return primaryDir;
    }
    // Staging parcial sem creds — devolve o que der para a raiz (rollback).
    for (const inner of await readdir(stagingPath).catch(() => [] as string[])) {
      await rename(join(stagingPath, inner), join(root, inner)).catch(() => undefined);
    }
    await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!existsSync(join(root, 'creds.json'))) {
    // Sem sessão legada (cold start ou pós-recovery) — só cria primary/.
    mkdirSync(primaryDir, { recursive: true });
    return primaryDir;
  }

  const staging = join(root, `${AUTH_MIGRATION_STAGING_PREFIX}${process.pid}-${Date.now()}`);
  const moved: string[] = [];
  try {
    mkdirSync(staging, { recursive: true });
    for (const name of await readdir(root)) {
      if (isReservedRootEntry(name)) continue;
      if (name === basename(staging) || name.startsWith(AUTH_MIGRATION_STAGING_PREFIX)) continue;
      if (name === 'primary') continue; // defensivo — não existe neste ponto
      await rename(join(root, name), join(staging, name));
      moved.push(name);
    }
    await rename(staging, primaryDir);
    logger.info(
      { dir: primaryDir, entries: moved.length },
      'baileys.auth_layout_migrated_to_primary',
    );
    // `AUDIT_ACTIONS` é fechado e fora do escopo deste capítulo —
    // `config_loaded` é a ação existente para "estado de configuração no
    // boot"; o evento real vai em metadata.
    await audit({
      acao: 'config_loaded',
      metadata: { event: 'baileys_auth_layout_migrated_to_primary', entries: moved.length },
    }).catch(() => undefined);
    return primaryDir;
  } catch (err) {
    // Rollback best-effort — mantém o layout LEGADO utilizável neste boot;
    // os fluxos de recovery limpam a raiz ENTRADA A ENTRADA (nunca a raiz).
    for (const name of moved) {
      await rename(join(staging, name), join(root, name)).catch(() => undefined);
    }
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    logger.error(
      { err: (err as Error).message },
      'baileys.auth_layout_migration_failed_using_legacy_root',
    );
    await audit({
      acao: 'config_loaded',
      metadata: {
        event: 'baileys_auth_layout_migration_failed',
        error: (err as Error).message,
      },
    }).catch(() => undefined);
    return root;
  }
}

export async function startBaileys(): Promise<void> {
  // Backend boot (maia-app): create media dirs here, NOT at module load, so
  // importing this module (e.g. from the admin-ui tool catalog) has no fs side
  // effects. Idempotent.
  ensureMediaDirs();
  // Cap. 7 — a primária usa `primary/` (com migração transparente do layout
  // legado); só um boot cuja migração falhou continua na raiz.
  const authDir = await ensurePrimaryAuthDirMigrated();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
      await ingressUpsertMessage(msg);
    }
  });

  // Fase 0/3 (review PR #496 CRÍTICO 1): o handler é COMPARTILHADO com as
  // sessões de linha adicionais (line-sessions.ts) e escopado pelo canal da
  // sessão que entregou o evento — a primária passa o canal registrado no
  // manager (null na janela legada mono-linha ⇒ comportamento anterior; em
  // MAIA_MULTI_LINE o handler falha FECHADO sem canal — review #498).
  socket.ev.on('messages.update', (updates) => {
    void handleMessagesUpdate(updates, primaryChannel?.id ?? null);
  });
}

/**
 * Handler de `messages.update` (edits/revokes) compartilhado entre a sessão
 * primária e as sessões de linha adicionais.
 *
 * [Codex review #277 v2 BLOQUEADO fix] Resolve o whatsapp_id alvo cross-
 * tenant ANTES de entrar no ALS e roda `routeMessageUpdate` no contexto do
 * tenant dono da row (adopt-then-runWithTenantContext, mesmo ordering do
 * `runAgentForMensagem`).
 *
 * [Review PR #496 CRÍTICO 1] O lookup cross-tenant é escopado pelo CANAL da
 * sessão que recebeu o evento: com N linhas o mesmo whatsapp_id pode existir
 * em canais/tenants diferentes (dedup por canal, §1.7) e um lookup global
 * escolheria a row mais recente — edit/revoke auditado no tenant ERRADO.
 * `channel_id` informado casa a row do canal OU a legada (channel NULL,
 * desde que pertença ao MESMO tenant/agent do canal — review #498).
 *
 * [Review #498 CRÍTICO 1] Em `MAIA_MULTI_LINE`, `channel_id === null`
 * (registro da primária ainda pendente, ou permanentemente falho) NÃO cai
 * mais no lookup global: o lote é descartado fail-closed e auditado
 * (`message_update_channel_unresolved`) — a janela residual permitia
 * resolver a row de OUTRO tenant. Mono-linha (`MAIA_MULTI_LINE=false`)
 * preserva o comportamento anterior: uma única sessão ⇒ lookup global sem
 * ambiguidade entre linhas.
 */
export async function handleMessagesUpdate(
  updates: ReadonlyArray<{
    key?: { id?: string | null } | null;
    update?: { message?: proto.IMessage | null | undefined } | null;
  }>,
  channel_id: string | null,
): Promise<void> {
  if (!config.FEATURE_MESSAGE_UPDATE) return;
  if (!channel_id && config.MAIA_MULTI_LINE) {
    logger.warn(
      { updates: updates.length },
      'message_update.channel_unresolved_dropped',
    );
    await audit({
      acao: 'message_update_channel_unresolved',
      metadata: { dropped_updates: updates.length },
    });
    return;
  }
  for (const update of updates) {
    try {
      // Baileys 6.7.0 delivers `update` as `{ key, update: Partial<WAMessageInfo> }`.
      // We synthesise an IWebMessageInfo whose `message` is the `update.message`
      // payload so routeMessageUpdate can branch on editedMessage / protocolMessage.
      // The `as never` cast is intentional — runtime structure is what matters.
      const target_whatsapp_id = extractMessageUpdateTargetId(update);
      if (!target_whatsapp_id) {
        // Read receipts / status updates / unsupported envelope shapes —
        // routeMessageUpdate would no-op anyway. Skip without touching DB.
        continue;
      }
      const original = await mensagensRepo.findByWhatsappIdCrossTenant(
        target_whatsapp_id,
        channel_id ?? undefined,
      );
      if (!original) {
        // Genuinely unknown message (never inbound through us, or already
        // GC'd). Preserve the existing fail-soft contract — routeMessageUpdate
        // also returns silently on null `findByWhatsappId`. Log so triage
        // can spot a pattern (e.g., a real bug producing stranded edits).
        logger.debug(
          { whatsapp_id: target_whatsapp_id, channel_id },
          'message_update.cross_tenant_lookup_miss',
        );
        continue;
      }
      await runWithTenantContext(
        { tenant_id: original.tenant_id, agent_id: original.agent_id },
        () =>
          routeMessageUpdate(
            {
              key: update.key,
              message: update.update?.message,
            } as never,
            channel_id,
          ),
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'message_update.dispatch_failed');
    }
  }
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
/**
 * Contexto por-LINHA para o ingresso (fase 3, spec roteamento v4 §1.5): cada
 * sessão adicional processa seus upserts com a PRÓPRIA linha (exact-match) e
 * o próprio LID-store/markRead. Ausente ⇒ sessão global (primária).
 */
export type LineIngressCtx = {
  botLineE164: string | null;
  lidPhoneResolver?: (lid: string) => string | null | Promise<string | null>;
  markRead?: (jid: string, whatsapp_id: string) => void;
};

/**
 * Entrada ÚNICA do upsert (compartilhada entre a sessão global e as sessões
 * de linha da fase 3).
 *
 * [Codex review #311 — B3] Reaction stubs arrive with
 * `msg.message === undefined` (the payload is a `messageStubType`, not a
 * content envelope). The previous `if (!msg.message) continue` ran BEFORE
 * `handleIncoming`, so the `isReactionStub` branch inside it was DEAD
 * CODE — reactions never reached the one-tap dispatcher. We must let
 * reaction stubs through, but they still need a tenant context:
 * `dispatchReactionAsAnswer` calls tenant-scoped repos
 * (`mensagensRepo.findByWhatsappId`, `pessoasRepo`, …) that throw without
 * an ALS. Both reaction stubs AND content messages carry `msg.key`
 * (remoteJid), which is all the JID→tenant resolver needs — so we resolve
 * FIRST, then route inside `runWithTenantContext`. Any other envelope
 * that has neither content nor a reaction stub (pure receipts) is skipped
 * to avoid a pointless resolver round-trip.
 */
export async function ingressUpsertMessage(
  msg: proto.IWebMessageInfo,
  line?: LineIngressCtx,
): Promise<'handled' | 'dropped' | 'skipped'> {
  const reactionStub = isReactionStub(msg);
  if (!msg.message && !reactionStub) return 'skipped';
  try {
    const ctx = await resolveTenantCtxForUpsert(msg, line);
    if (!ctx) return 'dropped'; // resolution failed → audit emitted + drop/staging
    await runWithTenantContext(ctx.scope, () =>
      handleIncoming(msg, {
        channel_id: ctx.channel_id,
        resolved_tel: ctx.resolved_tel,
        bot_line_external_id: line ? line.botLineE164 : undefined,
        read: line?.markRead,
      }),
    );
    return 'handled';
  } catch (err) {
    logger.error({ err }, 'baileys.handle_failed');
    return 'dropped';
  }
}

async function resolveTenantCtxForUpsert(
  msg: proto.IWebMessageInfo,
  line?: LineIngressCtx,
): Promise<{
  scope: { tenant_id: string; agent_id: string };
  channel_id: string | null;
  /** The E.164 phone (`+digits`) the resolver actually used as `external_id`.
   *  For a `@lid` recovered via the LID mapping store this is the REAL phone,
   *  not the synthetic LID local-part — `handleIncoming` uses it so identity
   *  (pessoa lookup) stays consistent with routing. Null when the resolver did
   *  not surface a phone. */
  resolved_tel: string | null;
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
    const { scope, jid_context } = await resolveScopeForJid(jid, keyHints, {
      // Inject the socket-backed LID→PN store lookup so a `@lid` event whose
      // key hints weren't populated can still recover its real phone instead of
      // being dropped (the message-loss risk this fix closes). Sessões de
      // linha (fase 3) injetam o resolver do PRÓPRIO socket.
      lidPhoneResolver: line?.lidPhoneResolver ?? resolvePhoneFromLidStore,
      // §1.1 — a linha DESTA sessão habilita o exact-match por linha nos
      // modos shadow/exact_first/strict (fase 0: shadow só observa).
      botLineE164: line ? line.botLineE164 : currentLineE164,
    });
    // jid_context is observability metadata (LID fallback, raw_jid,
    // resolved phone) — propagated via logs, not via handleIncoming.
    // handleIncoming derives `tel` from msg.key directly, mirroring its
    // pre-#290 behavior; the ALS context is the only thing it consumes
    // from upstream.
    if (jid_context.via_lid_fallback) {
      logger.debug(
        {
          raw_jid: jid_context.raw_jid,
          // Where the phone came from: 'key_hint' (senderPn/participantPn) or
          // 'lid_store' (recovered from the signal LID mapping after the hints
          // were absent). 'lid_store' hits are the ones this fix saved from a
          // fail-closed drop.
          lid_recovery_source: jid_context.lid_recovery_source,
          // [🟠 MEDIUM fix #417] optional-chain `msg.key` — a malformed/no-key
          // envelope must not throw a raw TypeError here.
          whatsapp_id: msg.key?.id ?? null,
        },
        'baileys.lid_fallback_resolved',
      );
    }
    return {
      scope: { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
      channel_id: scope.channel_id,
      resolved_tel: jid_context.resolved_phone_e164,
    };
  } catch (err) {
    // Typed resolution failure → fail-closed audit + drop. Audit writer
    // wraps in synthetic `system` ALS when none is active (which is the
    // case here — we ARE the entry point).
    const typed = err as {
      code?: string;
      details?: { resolver_path?: string } | unknown;
    };
    const isResolutionFailure = typed?.code === 'channel_resolution_failed';
    // A `@lid` we could not map to a phone (key hints absent AND the LID store
    // missed) is split onto its own audit action so the operator alert for
    // genuine `channel_resolution_failed` (cross-tenant ownership miss / garbage
    // JID) is not polluted by benign WhatsApp sync/peer noise — while STILL
    // dropping fail-closed and staying visible as the message-loss canary.
    const resolverPath =
      typeof typed?.details === 'object' && typed.details !== null
        ? (typed.details as { resolver_path?: string }).resolver_path
        : undefined;
    const isLidUnmapped = isResolutionFailure && resolverPath === 'lid_unmapped';
    // §1.4 (spec roteamento v4) — modo strict: um miss pela LINHA não é
    // descartado, é ESTAGIADO cifrado (envelope AES-GCM + job de replay com
    // jobId estável). Só quando a linha é conhecida (strict_line_miss) — sem
    // linha não há chave de staging. O audit de falha abaixo ainda roda
    // (trilha completa: falhou a rota E foi estagiado).
    let staged = false;
    if (
      isResolutionFailure &&
      resolverPath === 'strict_line_miss' &&
      msg.key?.id &&
      (line ? line.botLineE164 : currentLineE164)
    ) {
      const { stageUnroutedInbound } = await import('./unrouted-staging.js');
      staged = await stageUnroutedInbound(
        msg,
        (line ? line.botLineE164 : currentLineE164)!,
      );
    }
    await audit({
      acao: isLidUnmapped
        ? 'channel_resolution_skipped_lid_unmapped'
        : 'channel_resolution_failed',
      metadata: {
        // mensagem_id intentionally null — the inbound was NOT persisted
        // (we audit BEFORE createInbound runs). whatsapp_id is the only
        // stable handle the operator has for triage.
        // [🟠 MEDIUM fix #417] optional-chain `msg.key`: a malformed/no-key
        // envelope reaches this catch (resolveScopeForJid(null) fails closed);
        // a raw `msg.key.id` deref here would throw a TypeError that escapes as
        // an opaque `baileys.handle_failed`, BYPASSING this intended
        // `channel_resolution_failed` audit.
        whatsapp_id: msg.key?.id ?? null,
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
        // §1.4: true quando o strict estagiou o inbound em vez de perdê-lo.
        staged,
      },
    });
    logger.warn(
      {
        err: (err as Error).message,
        err_code: typed?.code,
        resolver_path: resolverPath ?? null,
        // [🟠 MEDIUM fix #417] optional-chain `msg.key` (see audit above).
        whatsapp_id: msg.key?.id ?? null,
        raw_jid: jid,
      },
      isLidUnmapped
        ? 'baileys.channel_resolution_skipped_lid_unmapped'
        : 'baileys.channel_resolution_failed_drop',
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
  //
  // Fase 3 (spec roteamento v4 §1.5): `bot_line_external_id` e `read` chegam
  // da SESSÃO DE LINHA que recebeu o evento — a linha carimba a identidade e
  // o read receipt sai pela própria sessão. Ausentes ⇒ sessão global.
  opts?: {
    channel_id?: string | null;
    resolved_tel?: string | null;
    bot_line_external_id?: string | null;
    read?: (jid: string, whatsapp_id: string) => void;
  },
): Promise<void> {
  if (msg.key.fromMe) return;
  const _resolvedChannelId = opts?.channel_id ?? null;
  const _botLine =
    opts?.bot_line_external_id !== undefined ? opts.bot_line_external_id : currentLineE164;

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
  // Identity (`tel`) precedence — must stay consistent with how the ingress
  // resolved the TENANT (resolveScopeForJid), or a `@lid` recovered via the LID
  // mapping store would be routed under the real owner but have its pessoa
  // created under the synthetic LID number:
  //   1. senderPn/participantPn from the key (the cheap, in-envelope hint),
  //   2. `opts.resolved_tel` — the E.164 phone the resolver actually used
  //      (covers the LID-store recovery, where the key hints were absent),
  //   3. the raw JID local-part (standard `@s.whatsapp.net`; or a last-resort
  //      synthetic value for an unmapped LID that still slipped through).
  const tel =
    isLid && realPn
      ? '+' + realPn.split('@')[0]!
      : opts?.resolved_tel && opts.resolved_tel.length > 0
        ? opts.resolved_tel
        : '+' + remote_jid.split('@')[0]!;
  if (isLid && !realPn && !(opts?.resolved_tel && opts.resolved_tel.length > 0)) {
    logger.warn(
      { remote_jid, whatsapp_id },
      'baileys.lid_without_real_phone',
    );
  }

  if (await checkBotAndMaybeBlock(tel)) {
    logger.warn({ tel: '[REDACTED]' }, 'baileys.dropped_anomalous_volume');
    return;
  }

  const { type, content, mediaPath, mediaMime, mediaSha256, mediaRejected } = await extractContent(msg);

  const { row: stored, duplicate } = await mensagensRepo.createInbound({
    conversa_id: null,
    // 090 (spec roteamento v4 §1.7): canal resolvido NO ingresso, carimbado na
    // PERSISTÊNCIA — o dedup de rows novas é por (channel_id, whatsapp_id), de
    // modo que o mesmo whatsapp_id em duas linhas persiste DUAS vezes e um
    // retry na MESMA linha persiste UMA. Null (testes/entradas sem resolução)
    // cai na partial unique legada por (tenant, agent, whatsapp_id).
    channel_id: _resolvedChannelId,
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
      // P0 audit ch. 4 — why the media was refused ('too_large_declared' |
      // 'too_large' | 'bad_magic'), null when accepted/absent. The turn still
      // processes; only the media fields are withheld.
      media_rejected: mediaRejected,
      // [Issue #290] Channel resolved at the ingress. In single-tenant this is
      // the seeded default channel id (#411 catch-all); null only when the
      // resolver path didn't surface a channel_id (e.g., tests driving
      // handleIncoming directly). Persisted for triage and as defense-in-depth
      // — the worker's adoption probe is unaffected by this field.
      ingress_channel_id: _resolvedChannelId,
      // §1.1 (spec roteamento v4) — a LINHA que RECEBEU esta mensagem. O
      // probe do worker (`probeMessageForChannel`) repassa ao resolver para o
      // exact-match por linha nos modos shadow/exact_first/strict.
      bot_line_external_id: _botLine,
    },
    processada_em: null,
    ferramentas_chamadas: [],
    tokens_usados: null,
  });

  await markSeen(whatsapp_id);
  // Fase 3: o read receipt sai pela sessão da LINHA que recebeu (quando
  // fornecida); fase 0/global: sessão primária, comportamento inalterado.
  (opts?.read ?? markRead)(remote_jid, whatsapp_id);
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
  /** P0 audit ch. 4 — non-null when media was refused (size/magic). The turn
   * still processes (text/caption survives); the reason lands in metadata. */
  mediaRejected: string | null;
}> {
  const m = msg.message;
  if (!m) {
    return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null, mediaRejected: null };
  }

  if (m.conversation) {
    return { type: 'texto', content: m.conversation, mediaPath: null, mediaMime: null, mediaSha256: null, mediaRejected: null };
  }
  if (m.extendedTextMessage?.text) {
    return {
      type: 'texto',
      content: m.extendedTextMessage.text,
      mediaPath: null,
      mediaMime: null,
      mediaSha256: null,
      mediaRejected: null,
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
    return { type: 'sistema', content: null, mediaPath: null, mediaMime: null, mediaSha256: null, mediaRejected: null };
  }

  type MediaEnvelope = {
    mimetype?: string;
    caption?: string;
    fileLength?: number | { toString(): string } | null;
  };
  const envelope = (m as unknown as Record<string, MediaEnvelope | undefined>)[mediaKind];
  const mime = envelope?.mimetype ?? null;
  const caption = envelope?.caption ?? null;
  const type: WhatsAppInbound['type'] =
    mediaKind === 'audioMessage' ? 'audio' : mediaKind === 'imageMessage' ? 'imagem' : 'documento';

  // P0 audit ch. 4 — per-kind byte caps, checked against the DECLARED
  // fileLength BEFORE downloading (no unbounded in-memory download), and
  // re-checked against the actual buffer afterwards.
  const cap =
    type === 'audio' ? MAX_AUDIO_BYTES : type === 'imagem' ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  const declaredRaw = envelope?.fileLength;
  const declaredLen = declaredRaw == null ? null : Number(declaredRaw.toString());

  let mediaPath: string | null = null;
  let mediaSha256: string | null = null;
  let mediaRejected: string | null = null;
  if (declaredLen !== null && Number.isFinite(declaredLen) && declaredLen > cap) {
    mediaRejected = 'too_large_declared';
    logger.warn({ declared: declaredLen, cap, kind: type }, 'baileys.media_rejected');
  } else {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {});
      if (Buffer.isBuffer(buf)) {
        const sniffed = sniffMime(buf);
        if (buf.length > cap) {
          mediaRejected = 'too_large';
          logger.warn({ size: buf.length, cap, kind: type }, 'baileys.media_rejected');
        } else if (
          // Images/audio must sniff as such; documents accept any payload
          // (extension falls back to 'bin' below). Fail-closed on mismatch.
          (type === 'imagem' && !sniffed?.startsWith('image/')) ||
          (type === 'audio' && !sniffed?.startsWith('audio/'))
        ) {
          mediaRejected = 'bad_magic';
          logger.warn({ kind: type, sniffed: sniffed ?? null }, 'baileys.media_rejected');
        } else {
          // Extension comes from the SNIFFED magic — never from the declared
          // mimetype/filename. Sanitized; unknown magic (documents) → 'bin'.
          const rawExt = sniffed ? extensionForMime(sniffed) : null;
          const ext = rawExt && /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'bin';
          const saved = await mediaPathFor(buf, ext);
          mediaPath = saved.path;
          mediaSha256 = saved.sha;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'baileys.media_download_failed');
    }
  }
  return { type, content: caption, mediaPath, mediaMime: mime, mediaSha256, mediaRejected };
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
  return sendOutboundTextVia(socket, jid, text, opts);
}

/**
 * Variante parametrizada por socket (fase 3, spec roteamento v4 §1.5): o
 * transporte de cada LINHA adicional envia pela SUA sessão com exatamente a
 * mesma semântica de conteúdo/opções da global. A global delega aqui.
 */
export async function sendOutboundTextVia(
  sock: WASocket,
  jid: string,
  text: string,
  opts?: { quoted?: WAQuotedContext; view_once?: boolean; messageId?: string },
): Promise<string | null> {
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
  const result = await sock.sendMessage(jid, content, miscOpts);
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
  return sendOutboundDocumentVia(socket, jid, path, opts);
}

/** Variante por socket — ver `sendOutboundTextVia`. */
export async function sendOutboundDocumentVia(
  sock: WASocket,
  jid: string,
  path: string,
  opts: {
    mimetype: string;
    fileName: string;
    caption?: string;
    quoted?: WAQuotedContext;
  },
): Promise<string | null> {
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
  const result = await sock.sendMessage(
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
  return sendOutboundVoiceVia(socket, jid, buf, opts);
}

/** Variante por socket — ver `sendOutboundTextVia`. */
export async function sendOutboundVoiceVia(
  sock: WASocket,
  jid: string,
  buf: Buffer,
  opts?: { quoted?: WAQuotedContext },
): Promise<string | null> {
  const result = await sock.sendMessage(
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
  _ensurePrimaryAuthDirMigrated: ensurePrimaryAuthDirMigrated,
  RECONNECT_MAX_ATTEMPTS,
};

// Helper to deterministically create per-message media filenames.
// P0 audit ch. 4: scoped PER TENANT — `<MEDIA_ROOT>/<urlencoded tenant>/<month>/<sha>.<ext>`.
// The caller (extractContent ← handleIncoming) always runs inside
// `runWithTenantContext`, so `getCurrentTenant()` is bound; without an ALS
// context this THROWS (fail-closed — never writes into a shared bucket).
// Async write (no event-loop-blocking writeFileSync on the ingress hot path).
// Legacy rows whose midia_url points at the old un-tenanted `<MEDIA_ROOT>/<month>/`
// dirs still resolve: media-guard containment is checked against MEDIA_ROOT.
export async function mediaPathFor(buf: Buffer, ext: string): Promise<{ path: string; sha: string }> {
  // Defensive: ensure MEDIA_ROOT exists even when startBaileys() hasn't run
  // (module load no longer creates it). Idempotent.
  ensureMediaDirs();
  const sha = sha256(buf);
  const month = new Date().toISOString().slice(0, 7);
  const dir = join(MEDIA_ROOT, encodeURIComponent(getCurrentTenant()), month);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sha}.${ext}`);
  if (!existsSync(path)) await writeFile(path, buf);
  return { path, sha };
}
