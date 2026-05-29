import { z } from 'zod';
import { sha256 } from '@/lib/utils.js';

/**
 * Issue #316 — transactional outbox effect definitions.
 *
 * A "planned effect" is the description of a NON-IDEMPOTENT external side
 * effect that a tool WOULD have fired inline. Instead of firing it, the tool
 * returns the plan and the dispatcher records it in `idempotency_effect_outbox`
 * IN THE SAME TRANSACTION as the winning idempotency reservation completion
 * (idempotency_keys → completed). A single relayer
 * (src/workers/idempotency-outbox-relayer.ts) later dispatches it EXACTLY ONCE.
 *
 * Why a typed discriminated union: the table stores `effect_type` +
 * `effect_payload` (opaque JSONB). The relayer must re-validate the payload
 * before dispatching — a row could have been written by an older code version,
 * hand-edited, or corrupted. The schema below is the single source of truth for
 * both the write side (dispatcher) and the read side (relayer).
 *
 * Adding a new effect type:
 *   1. Add a member to `EffectType` + a branch to `plannedEffectSchema`.
 *   2. Add a `case` to the relayer's dispatch switch (idempotency-outbox-relayer.ts).
 *   3. Update any tool that plans the effect to return it via `extractEffect`.
 */

/** Stable discriminator persisted in `idempotency_effect_outbox.effect_type`. */
export const EFFECT_TYPES = ['whatsapp_text'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/**
 * `whatsapp_text` — send a plain WhatsApp text message via the Baileys gateway.
 * This is the concrete non-idempotent external effect named in #316
 * (send_proactive_message): the gateway has no native idempotency, so a
 * double-dispatch is a duplicate user-visible message.
 *
 * `jid` is the resolved WhatsApp JID (recipient). `text` is the message body.
 * `mensagem_id` (optional) is the persisted outbound `mensagens` row id the
 * planning handler already created, carried for audit correlation only — the
 * relayer does NOT re-persist the message, it only fires the gateway send.
 */
const whatsappTextPayloadSchema = z.object({
  kind: z.literal('whatsapp_text'),
  jid: z.string().min(1),
  text: z.string().min(1),
  mensagem_id: z.string().optional(),
});

/**
 * Discriminated union over every effect payload. The `kind` literal MUST equal
 * the row's `effect_type` (the dispatcher stamps both from the same plan); the
 * relayer asserts that equality defensively before dispatch.
 */
export const plannedEffectSchema = z.discriminatedUnion('kind', [
  whatsappTextPayloadSchema,
]);

export type PlannedEffect = z.infer<typeof plannedEffectSchema>;
export type WhatsappTextEffect = z.infer<typeof whatsappTextPayloadSchema>;

/**
 * Narrow an unknown JSONB payload (from `idempotency_effect_outbox.effect_payload`)
 * into a typed `PlannedEffect`, cross-checking the row's `effect_type` against
 * the payload's `kind`. Returns null on any mismatch / invalid shape so the
 * relayer can mark the row failed (never dispatch an unrecognized effect).
 */
export function parseEffectPayload(
  effect_type: string,
  effect_payload: unknown,
): PlannedEffect | null {
  const parsed = plannedEffectSchema.safeParse(effect_payload);
  if (!parsed.success) return null;
  // Defense in depth: the column discriminator and the payload discriminator
  // must agree. A divergence means a corrupted/hand-edited row.
  if (parsed.data.kind !== effect_type) return null;
  return parsed.data;
}

/**
 * Issue #327 — PROVIDER-SIDE DEDUP KEY (closing the at-least-once tail).
 *
 * The relayer's `gateway send → markEffectSent` is two steps. A crash AFTER the
 * send but BEFORE markEffectSent leaves the row pending → a later tick
 * re-dispatches → a duplicate user-visible message. #316 is exactly-once on the
 * ENQUEUE side; this closes the DISPATCH side by deriving a DETERMINISTIC
 * provider-side message id from the outbox row's STABLE identity, so a re-send
 * of the SAME logical effect carries the SAME provider id. A transport that
 * keys on the message id (WhatsApp keys every message on `(remoteJid, fromMe,
 * id)`) then treats the retry as the same message → exactly-once end-to-end.
 *
 * STABLE IDENTITY = (tenant_id, agent_id, idempotency_key):
 *   - `idempotency_key` is the dispatcher's deterministic per-operation key
 *     (computed from pessoa/entity/tool/operation), written verbatim onto the
 *     outbox row and NEVER mutated. The outbox PK (`id`) is equally stable, but
 *     we key on `idempotency_key` because it is the logical operation identity
 *     the rest of the exactly-once machinery already uses (the outbox's own
 *     ON CONFLICT target is `(tenant, agent, idempotency_key)`), so two outbox
 *     rows can never exist for the same logical effect.
 *   - `tenant_id` + `agent_id` are folded into the hash input so the key is
 *     TENANT-SCOPED: two tenants that happen to compute the same
 *     `idempotency_key` (different DBs, same derivation inputs) get DIFFERENT
 *     provider ids and can never collide on the transport. Tenant isolation is
 *     inviolable — the dedup key must never be a cross-tenant correlation
 *     handle.
 */
export type OutboxRowIdentity = {
  tenant_id: string;
  agent_id: string;
  idempotency_key: string;
};

/**
 * Native WhatsApp message-id format produced by Baileys' `generateMessageIDV2`:
 * the literal prefix `'3EB0'` followed by 18 uppercase hex chars (the leading
 * bytes of a SHA-256), 22 chars total. We MIRROR that exact shape so the
 * derived id is a valid WhatsApp message key id (not a foreign-looking token
 * the transport might reject), while being a pure function of the row identity.
 *
 * Determinism: identical (tenant, agent, idempotency_key) → identical id, on
 * every relayer pass, forever. Collision resistance: SHA-256 over a
 * NUL-delimited tuple (the delimiter prevents `(a,bc)` and `(ab,c)` from
 * hashing equally); 18 hex chars = 72 bits, far beyond the per-tenant volume
 * where a birthday collision would matter for a dedup key.
 */
const WHATSAPP_MSG_ID_PREFIX = '3EB0';
const WHATSAPP_MSG_ID_HEX_LEN = 18;
/**
 * Unambiguous separator for the hash material. A NUL byte (`\u0000`) never
 * occurs inside any identity component (tenant/agent slugs, derived idempotency
 * key), so no pair of DISTINCT (tenant, agent, key) tuples can ever produce the
 * same joined string — unlike a printable delimiter (`('a b','c')` vs
 * `('a','b c')` collide under a space, never under NUL).
 */
const DEDUP_IDENTITY_SEP = '\u0000';

function deriveWhatsappMessageId(identity: OutboxRowIdentity): string {
  const material = [
    identity.tenant_id,
    identity.agent_id,
    identity.idempotency_key,
  ].join(DEDUP_IDENTITY_SEP);
  const hex = sha256(material).toUpperCase().slice(0, WHATSAPP_MSG_ID_HEX_LEN);
  return WHATSAPP_MSG_ID_PREFIX + hex;
}

/**
 * Per-effect-type provider-side dedup key. The relayer dispatch switch is
 * exhaustive-checked; this derivation is the SAME shape so a NEW effect type
 * supplies its OWN provider key (or `null` when its transport is natively
 * idempotent / has no client-id concept) without touching unrelated branches.
 *
 * Returns:
 *   - a string → pass it to the send as the provider-side id (the transport
 *     dedups a duplicate carrying the same id).
 *   - `null`   → this effect type has NO usable provider-side dedup key (its
 *     transport cannot accept a client-supplied id, OR is already idempotent).
 *     The relayer falls back to the narrowest feasible mitigation and dispatch
 *     proceeds without a provider key. NEVER fabricate a key a transport will
 *     ignore — that would be a false exactly-once guarantee.
 *
 * `whatsapp_text`: Baileys forwards `MiscMessageGenerationOptions.messageId`
 * straight into the outgoing message key id, and WhatsApp keys messages on
 * `(remoteJid, fromMe, id)` — so a deterministic id IS a genuine provider-side
 * dedup key for this transport.
 */
export function deriveProviderDedupKey(
  effect: PlannedEffect,
  identity: OutboxRowIdentity,
): string | null {
  switch (effect.kind) {
    case 'whatsapp_text':
      return deriveWhatsappMessageId(identity);
    default: {
      // Exhaustiveness: a new EffectType must decide its dedup-key story here.
      const _never: never = effect.kind;
      void _never;
      return null;
    }
  }
}
