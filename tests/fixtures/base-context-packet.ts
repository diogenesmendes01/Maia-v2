/**
 * Typed builder for the production `BaseContextPacket` (Camada 1 of the
 * Context Packet pipeline — `src/runtime/context-packet/types.ts:18-50`).
 *
 * Why this exists: ad-hoc `mkBase` helpers scattered across specs (e.g. the
 * action-decider tests) returned a STRIPPED-DOWN packet missing required
 * fields — `session_id`, `conversation_id`, `actor.user_id`/`pessoa_id`/`role`,
 * `input.kind`/`content_hmac`/`received_at: string`,
 * `active_procedure_execution_id`, `feature_flags_snapshot`, `entered_at_ms`,
 * `active_sensitive_memory_count`. A spec relying on the stripped shape can
 * "pass" while the production decider would fail at runtime on a missing
 * `actor.role` (used by policy decisions) or `received_at: string` (the wire
 * shape is an ISO string, not a Date).
 *
 * The builder returns a COMPLETE packet whose every field matches the real
 * type. Spec authors override only what they care about via `Partial`.
 *
 * Usage:
 *   const base = mkBaseContextPacket();
 *   const base = mkBaseContextPacket({ tenant_id: 'tenant-A', agent_id: 'agent-A' });
 *   const base = mkBaseContextPacket({
 *     channel: { id: 'web-1', kind: 'web', is_locked_down: false },
 *     actor: { user_id: 'u1', pessoa_id: 'p1', role: 'owner', is_authenticated: true },
 *   });
 */
import type { BaseContextPacket } from '@/runtime/context-packet/types.js';

/**
 * Default packet values. The `received_at` is an ISO string (NOT a Date) —
 * production wire shape — to catch spec-side regressions that smuggle a Date
 * through and would crash on `received_at.split(...)` / JSON serialisation
 * boundaries downstream.
 */
const DEFAULT_RECEIVED_AT = new Date('2026-01-01T00:00:00.000Z').toISOString();

/**
 * Build a complete BaseContextPacket for use in specs. Every required field
 * has a sensible default; pass `overrides` to tune only what the spec
 * exercises.
 *
 * The defaults map 1:1 to a generic authenticated WhatsApp turn from a
 * single-tenant single-agent setup — the most common test shape across the
 * Decision Engine specs.
 */
export function mkBaseContextPacket(
  overrides?: Partial<BaseContextPacket>,
): BaseContextPacket {
  return {
    trace_id: 'trace-fixture-1',
    tenant_id: 'tenant-fixture',
    agent_id: 'agent-fixture',
    session_id: 'session-fixture',
    conversation_id: 'conversation-fixture',
    channel: {
      id: 'channel-fixture',
      kind: 'whatsapp',
      is_locked_down: false,
    },
    actor: {
      user_id: 'user-fixture',
      pessoa_id: 'pessoa-fixture',
      role: 'end_user',
      is_authenticated: true,
    },
    input: {
      kind: 'text',
      content_ref: 'content-fixture',
      content_hmac: 'hmac-fixture',
      received_at: DEFAULT_RECEIVED_AT,
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: 0,
    active_sensitive_memory_count: 0,
    ...overrides,
  };
}
