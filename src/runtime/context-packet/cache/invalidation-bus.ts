/**
 * P8a — InvalidationBus: pub/sub listener for cache invalidation events.
 *
 * Spec §4 — 11 event types invalidate specific slice caches. P8a delivers the
 * bus + handler wiring; real event emitters land in P9/P10 (policy engine,
 * knowledge lifecycle, identity profile activation, etc.).
 *
 * Event taxonomy (master §3.7):
 *  - identity_profile_activated          → invalidate `identity`
 *  - identity_profile_rolled_back        → invalidate `identity`
 *  - user_memory_upserted                → invalidate `user`
 *  - user_memory_invalidated             → invalidate `user`
 *  - user_behavioral_hint_added          → invalidate `user`
 *  - knowledge_lifecycle_transitioned    → invalidate `knowledge`
 *  - soul_bias_activated                 → invalidate `soul`
 *  - policy_rule_activated               → invalidate `policy`
 *  - policy_rule_deactivated             → invalidate `policy`
 *  - skill_activated                     → invalidate `skill`
 *  - tool_registry_updated               → invalidate `tool` (cross-tenant)
 */
import type { SliceName } from '../types.js';
import type { SliceCache } from './slice-cache.js';

export type InvalidationEventType =
  | 'identity_profile_activated'
  | 'identity_profile_rolled_back'
  | 'user_memory_upserted'
  | 'user_memory_invalidated'
  | 'user_behavioral_hint_added'
  | 'knowledge_lifecycle_transitioned'
  | 'soul_bias_activated'
  | 'policy_rule_activated'
  | 'policy_rule_deactivated'
  | 'skill_activated'
  | 'tool_registry_updated';

export interface InvalidationEvent {
  type: InvalidationEventType;
  tenant_id: string;
  agent_id?: string;
  affected_descriptors?: string[];
  occurred_at: string;
}

export type InvalidationHandler = (e: InvalidationEvent) => Promise<void>;

export class InvalidationBus {
  private handlers = new Map<InvalidationEventType, InvalidationHandler[]>();

  subscribe(eventType: InvalidationEventType, handler: InvalidationHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async dispatch(event: InvalidationEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    await Promise.all(
      handlers.map((h) =>
        h(event).catch((err: unknown) => {
          // Log via console (real impl would use the logger); never bubble.
          // Failure of a single handler should not block dispatch.
          // eslint-disable-next-line no-console
          console.error(
            `[InvalidationBus] handler error for ${event.type}:`,
            err,
          );
        }),
      ),
    );
  }

  /** Test helper: how many handlers are registered for an event type. */
  handlerCount(eventType: InvalidationEventType): number {
    return (this.handlers.get(eventType) ?? []).length;
  }

  /** Test helper: clear all handlers. */
  reset(): void {
    this.handlers.clear();
  }
}

/**
 * Default routing map: event type → slice to invalidate per tenant.
 *
 * Mounted by `wireDefaultInvalidationHandlers()` when the runtime boots, so
 * P8a code can subscribe without each slice builder caring about the bus.
 */
export const EVENT_TO_SLICE: Record<InvalidationEventType, SliceName | 'all'> = {
  identity_profile_activated: 'identity',
  identity_profile_rolled_back: 'identity',
  user_memory_upserted: 'user',
  user_memory_invalidated: 'user',
  user_behavioral_hint_added: 'user',
  knowledge_lifecycle_transitioned: 'knowledge',
  soul_bias_activated: 'soul',
  policy_rule_activated: 'policy',
  policy_rule_deactivated: 'policy',
  skill_activated: 'skill',
  // Tool registry is cross-tenant; we still scope by tenant for safety
  // (real registry will publish per-tenant overrides).
  tool_registry_updated: 'tool',
};

/**
 * Wire the default handler set: each event type invalidates its corresponding
 * slice cache for the event's tenant. Call once at runtime boot.
 */
export function wireDefaultInvalidationHandlers(
  bus: InvalidationBus,
  cache: SliceCache,
): void {
  for (const [eventType, slice] of Object.entries(EVENT_TO_SLICE) as Array<
    [InvalidationEventType, SliceName]
  >) {
    bus.subscribe(eventType, async (e) => {
      await cache.invalidateSliceForTenant(e.tenant_id, slice);
    });
  }
}
