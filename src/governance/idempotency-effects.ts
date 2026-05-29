import { z } from 'zod';

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
