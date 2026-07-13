/**
 * Issue #290 — JID → tenant scope resolver for the Baileys ingress.
 *
 * BEFORE THIS FIX (the runtime bypass this file closes):
 *   `src/gateway/baileys.ts` wrapped EVERY inbound message in
 *   `runWithTenantContext({tenant_id:'default', agent_id:'default'}, ...)`.
 *   The downstream gateway layers (`channel-resolver`, `rate-limit`,
 *   `bot-detection`, `dedup`, `debouncer`, `pub/sub`, `vision-cache`),
 *   which were SCOPED per-tenant in PRs #252/#253/#257/#258/#259/#264/#277,
 *   all read tenant/agent from `getCurrentTenant()/getCurrentAgent()`. With
 *   the gateway hardcoded to `default/default`, every downstream key
 *   collapsed to a single shared bucket in production:
 *
 *       maia:ratelimit:default:default:*    ← shared across all tenants
 *       maia:dedup:default:default:*        ← shared across all tenants
 *       …
 *
 *   The downstream PRs passed their adversarial cross-tenant fixture tests
 *   (they inject ALS context manually), but did NOT deliver isolation in
 *   production. This file fixes that — it resolves the REAL (tenant_id,
 *   agent_id) tuple from the inbound WhatsApp JID BEFORE `handleIncoming`
 *   runs, so every downstream layer sees the correct context.
 *
 * STRATEGY:
 *   Reuse the sanctioned cross-tenant resolver `resolveChannel` (the same
 *   one `agent/core.ts` uses for the post-persist adoption flow — see
 *   `probeMessageForChannel`). That resolver already:
 *     - calls `channelsRepo.findByExternalCrossTenant` (the one method
 *       authorized to bypass `applyTenantGuard`, because the entry point
 *       legitimately operates WITHOUT a tenant context — it IS the one
 *       discovering which tenant owns the inbound),
 *     - in a single-tenant runtime, resolves any sender to (default, default)
 *       via the catch-all (issue #411),
 *     - in a multi-tenant deployment, throws
 *       `TypedError('channel_resolution_failed')` fail-loud on miss/
 *       inactive/ambiguous (issue #268 fail-loud contract),
 *     - canonicalizes the (channel_type, external_id) → (tenant_id,
 *       agent_id, channel_id) mapping.
 *
 *   Reusing the existing resolver (rather than duplicating it) means the
 *   ambiguity/inactive/UNIQUE-constraint policies remain the SINGLE source
 *   of truth, and the downstream worker's adoption step becomes a true
 *   no-op (idempotent — adopting from the resolved tenant to itself).
 *
 * JID PARSING (`extractPhoneFromJid`):
 *   WhatsApp delivers JIDs in several formats:
 *     - `5511999999999@s.whatsapp.net`  — standard direct message
 *     - `5511999999999@c.us`            — legacy WA-Web format
 *     - `XXXXX@lid`                     — privacy-mode "Linked ID" (synthetic).
 *                                         The real phone lives on
 *                                         `msg.key.senderPn` / `participantPn`.
 *     - `120363...@g.us`                — group JID (NOT a sender)
 *
 *   For `@lid`, we extract the real phone from `senderPn`/`participantPn`
 *   when available; otherwise we return null (caller treats as
 *   unresolvable JID → audit + drop, NOT a silent collapse to default/default).
 *
 *   Groups (`@g.us`) are rejected here as "unresolvable for tenant routing"
 *   even though `handleIncoming` drops them anyway — defense in depth, so a
 *   future change that lifts the group-drop won't accidentally route group
 *   messages under a synthetic tenant.
 *
 * FAIL-CLOSED CONTRACT (issue #290 explicit owner decision):
 *   Anything that does NOT successfully resolve to a real (tenant_id,
 *   agent_id) tuple → throw `TypedError('channel_resolution_failed')`.
 *   The caller (`baileys.ts`) catches, writes the system audit, and DROPS
 *   the message. We do NOT fall back to `default/default`. That fallback
 *   is exactly the bypass issue #240/#268 closed at the worker layer —
 *   reintroducing it here would re-collapse all unknown traffic into one
 *   tenant bucket on a different code path.
 */
import { resolveChannel } from './channel-resolver.js';
import { TypedError } from '@/lib/utils.js';

/**
 * Resolved scope returned by `resolveScopeForJid`. The contract mirrors
 * `ChannelResolution` from `channel-resolver.ts` exactly, so the caller can
 * feed the tuple directly into `runWithTenantContext` and pass `channel_id`
 * along to the downstream handler.
 */
export type ResolvedScope = {
  tenant_id: string;
  agent_id: string;
  /** Null only when the resolver path is legacy default/default (not used
   *  by this helper — kept consistent with `ChannelResolution`). */
  channel_id: string | null;
};

/**
 * Optional metadata the caller surfaces to Baileys for richer logging
 * and audit emission, but NEVER read by `handleIncoming` — purely
 * observability. Helps triage operators distinguish `@lid` LIDs that
 * fell back to `senderPn` from clean `@s.whatsapp.net` numbers.
 */
type JidContext = {
  raw_jid: string;
  /** The phone (E.164 with '+' prefix) used as `external_id` for the lookup.
   *  Null when the JID parse failed BEFORE we found a usable phone (e.g. raw
   *  `@lid` with no `senderPn`, group JID, malformed JID). */
  resolved_phone_e164: string | null;
  /** Did we have to pull the phone from `senderPn`/`participantPn` (or the LID
   *  mapping store) because the JID was `@lid`? Useful in audit triage. */
  via_lid_fallback: boolean;
  /** WHERE the `@lid` phone came from when `via_lid_fallback` is true:
   *   - `'key_hint'`  → `msg.key.senderPn` / `participantPn` (the cheap path).
   *   - `'lid_store'` → recovered from the injected LID→PN resolver (Baileys'
   *     signal LID mapping store) AFTER the key hints were absent.
   *  Null when no LID fallback was needed (standard `@s.whatsapp.net`/`@c.us`). */
  lid_recovery_source: 'key_hint' | 'lid_store' | null;
};

/**
 * Parse a Baileys JID + key metadata into the sender's E.164 phone (with
 * the existing `+` prefix convention used by `mensagens.metadata.telefone`
 * — the same convention `channelsRepo.create({external_id: '+5511…'})`
 * persists). Returns null when the JID is unparseable, a group, or `@lid`
 * with no `senderPn` fallback.
 *
 * Mirrors the LID handling already in `baileys.ts:handleIncoming` so the
 * resolver lookup uses the SAME external_id the channel was registered
 * under (otherwise active channels in `whatsapp_channels` would silently
 * miss for any `@lid` contact).
 */
/**
 * Normalize a phone candidate (a bare `5511…` local-part OR a JID-shaped
 * `5511…@s.whatsapp.net`) into the `+<digits>` E.164 convention. Returns null
 * when the candidate is empty or its local-part is not digits-only — we never
 * invent a phone from a value we can't trust. Shared by the `@lid` senderPn
 * fallback (`extractPhoneFromJid`) and the LID-mapping-store recovery in
 * `resolveScopeForJid`, so both apply the SAME validation.
 */
function phoneFromCandidate(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const at = candidate.indexOf('@');
  const local = at > 0 ? candidate.slice(0, at) : candidate;
  if (!/^\d+$/.test(local)) return null;
  return '+' + local;
}

export function extractPhoneFromJid(
  jid: string | null | undefined,
  key?: {
    senderPn?: string | null | undefined;
    participantPn?: string | null | undefined;
  },
): { phone_e164: string; via_lid_fallback: boolean } | null {
  if (!jid || typeof jid !== 'string' || jid.length === 0) return null;

  // Groups are not senders — defense in depth (handleIncoming already
  // drops them, but a future change that lifts that drop must not silently
  // route group messages through here).
  if (jid.endsWith('@g.us')) return null;

  const atIdx = jid.indexOf('@');
  if (atIdx <= 0) return null; // missing or empty local-part — unparseable
  const localPart = jid.slice(0, atIdx);
  const domain = jid.slice(atIdx + 1);

  // Allowed direct-message domains. Unknown domains are unparseable —
  // we never invent a phone for a JID we don't recognize.
  const isLid = domain === 'lid';
  const isStandard = domain === 's.whatsapp.net' || domain === 'c.us';
  if (!isLid && !isStandard) return null;

  if (isLid) {
    // `@lid` is synthetic — local-part is NOT a phone. Pull the real phone
    // from `senderPn` / `participantPn` (Baileys populates these on `@lid`
    // messages). Mirror the same precedence as `baileys.handleIncoming`.
    const candidate =
      typeof key?.senderPn === 'string' && key.senderPn.length > 0
        ? key.senderPn
        : typeof key?.participantPn === 'string' && key.participantPn.length > 0
          ? key.participantPn
          : null;
    // candidate may be `5511…@s.whatsapp.net` or bare `5511…`
    const phone = phoneFromCandidate(candidate);
    if (!phone) return null;
    return { phone_e164: phone, via_lid_fallback: true };
  }

  // Standard JID — local part MUST be digits-only (Baileys' contract). If
  // it isn't, the JID is malformed — fail-closed rather than invent a phone.
  if (!/^\d+$/.test(localPart)) return null;
  return { phone_e164: '+' + localPart, via_lid_fallback: false };
}

/**
 * Resolve a Baileys JID to the owning (tenant_id, agent_id, channel_id).
 *
 * Returns the `ResolvedScope` plus a `JidContext` for observability.
 *
 * THROWS `TypedError('channel_resolution_failed')` when:
 *   - JID cannot be parsed (malformed, group, unknown domain) —
 *     `details.resolver_path = 'jid_unparseable'`.
 *   - JID is `@lid` but no real phone is recoverable (senderPn/participantPn
 *     absent AND the injected `lidPhoneResolver` missed) —
 *     `details.resolver_path = 'lid_unmapped'`. Split from `jid_unparseable`
 *     because a `@lid` we can't map is the canary for real `@lid` message loss
 *     (the WhatsApp LID migration), and operators must alert on it separately
 *     from a genuinely foreign/garbage JID. The caller maps it to the dedicated
 *     `channel_resolution_skipped_lid_unmapped` audit action.
 *   - In a MULTI-TENANT deployment, no channel is registered for the resolved
 *     phone — `details.resolver_path = 'unknown_or_inactive_channel'` (from
 *     `resolveChannel`). In a single-tenant runtime this case resolves to
 *     (default, default) via the #411 catch-all instead of throwing.
 *   - The phone matches multiple active channels across distinct tenants —
 *     `details.resolver_path = 'ambiguous_active_channels'` (from
 *     `channelsRepo.findByExternalCrossTenant` via `resolveChannel`).
 *
 * Does NOT swallow DB errors — they propagate as-is. The Baileys caller
 * audits + drops on any throw (fail-closed) and the per-message `for`
 * loop continues with the next message, so a transient DB blip drops
 * one message without taking down the listener.
 */
export async function resolveScopeForJid(
  jid: string | null | undefined,
  key?: {
    senderPn?: string | null | undefined;
    participantPn?: string | null | undefined;
  },
  opts?: {
    /**
     * Last-resort LID→phone resolver, injected by the Baileys caller from the
     * socket's signal LID mapping store. Consulted ONLY when the JID is `@lid`
     * and `senderPn`/`participantPn` were absent — it recovers the real phone
     * for `@lid` events whose key hints weren't populated (initial sync / peer
     * events, or once the LID↔PN mapping has synced). Injected (not imported)
     * so this resolver stays pure and unit-testable without a live socket; a
     * deployment whose Baileys build lacks the store simply passes nothing and
     * keeps the previous fail-closed behaviour.
     */
    lidPhoneResolver?: (lid: string) => string | null | Promise<string | null>;
    /**
     * §1.1 (spec roteamento v4) — a LINHA DO BOT (número da sessão que
     * recebeu, E.164 com `+`). Habilita o exact-match correto nos modos
     * shadow/exact_first/strict; ausente ⇒ resolução legada (fase 0).
     */
    botLineE164?: string | null;
  },
): Promise<{ scope: ResolvedScope; jid_context: JidContext }> {
  const raw_jid = typeof jid === 'string' ? jid : '';
  const isLid = typeof jid === 'string' && jid.endsWith('@lid');

  let parsed = extractPhoneFromJid(jid, key);
  let lid_recovery_source: 'key_hint' | 'lid_store' | null = parsed?.via_lid_fallback
    ? 'key_hint'
    : null;

  // `@lid` with no usable senderPn/participantPn hint: before failing closed,
  // try the injected LID→PN resolver (Baileys' signal LID mapping store). This
  // is what prevents real `@lid` message loss as WhatsApp migrates addressing
  // to LID — the key hints are not always populated, but the mapping store
  // often knows the phone.
  if (!parsed && isLid && opts?.lidPhoneResolver) {
    const recovered = phoneFromCandidate(await opts.lidPhoneResolver(jid as string));
    if (recovered) {
      parsed = { phone_e164: recovered, via_lid_fallback: true };
      lid_recovery_source = 'lid_store';
    }
  }

  if (!parsed) {
    // Split the audit signal: a `@lid` we couldn't map (benign sync noise
    // today, the message-loss canary tomorrow) is NOT the same operational
    // event as a foreign/garbage JID. See the THROWS contract above.
    if (isLid) {
      throw new TypedError(
        'channel_resolution_failed',
        'lid jid without a recoverable phone number (senderPn/participantPn absent and LID mapping miss)',
        {
          resolver_path: 'lid_unmapped',
          raw_jid,
        },
      );
    }
    throw new TypedError(
      'channel_resolution_failed',
      'jid unparseable for tenant routing',
      {
        resolver_path: 'jid_unparseable',
        raw_jid,
      },
    );
  }

  // Reuse the canonical resolver (single source of truth for
  // (channel_type, external_id) → tenant ownership policy). A linha do bot
  // (quando conhecida) habilita o exact-match por LINHA nos modos §1.2.
  const resolved = await resolveChannel({
    channel_type: 'whatsapp',
    external_id: parsed.phone_e164,
    bot_line_external_id: opts?.botLineE164 ?? null,
  });

  return {
    scope: {
      tenant_id: resolved.tenant_id,
      agent_id: resolved.agent_id,
      channel_id: resolved.channel_id,
    },
    jid_context: {
      raw_jid,
      resolved_phone_e164: parsed.phone_e164,
      via_lid_fallback: parsed.via_lid_fallback,
      lid_recovery_source,
    },
  };
}
