/**
 * P9b — Build a BaseContextPacket from agent/core.ts turn state.
 *
 * This helper bridges the legacy turn data shape (Mensagem + Conversa + Pessoa
 * already resolved in runAgentForMensagemInner) into the BaseContextPacket type
 * expected by the Decision Engine.
 *
 * Constraints:
 *  - Must be <10ms (no DB calls, no async I/O)
 *  - All fields are derived from data already available at call site
 *  - feature_flags_snapshot is minimal; full snapshot deferred to P9c
 */

import type { BaseContextPacket } from '../context-packet/types.js';
import type { Mensagem, Conversa, Pessoa } from '@/db/schema.js';

export interface BuildBaseContextInput {
  inbound: Mensagem;
  conversa: Conversa;
  pessoa: Pessoa;
  tenant_id: string;
  agent_id: string;
  /** Channel id resolved by P6 channel-resolver. null means whatsapp default. */
  channel_id: string | null;
  /** Active procedure execution id, if any. */
  active_procedure_execution_id: string | null;
}

/**
 * Builds a BaseContextPacket from turn state already available in
 * runAgentForMensagemInner. No async I/O.
 */
export function buildBaseContextPacketFromTurn(
  input: BuildBaseContextInput,
): BaseContextPacket {
  const { inbound, conversa, pessoa, tenant_id, agent_id, channel_id, active_procedure_execution_id } =
    input;

  const channelId = channel_id ?? 'default';
  const receivedAt = inbound.created_at?.toISOString() ?? new Date().toISOString();

  // Minimal feature flag snapshot. P11: the Decision Engine is always-on, so
  // the snapshot records it as such (the gating flag + kill switch were
  // removed). Full async snapshot arrives in P9c when the flag store is unified.
  const feature_flags_snapshot: Record<string, boolean> = {
    FEATURE_DECISION_ENGINE_V1: true,
  };

  return {
    trace_id: inbound.id,
    tenant_id,
    agent_id,
    session_id: conversa.id,
    conversation_id: conversa.id,
    channel: {
      id: channelId,
      kind: 'whatsapp',
      is_locked_down: false, // lockdown checked by Early PEP via LockdownReader
    },
    actor: {
      user_id: null,
      pessoa_id: pessoa.id,
      role: 'end_user',
      is_authenticated: true,
    },
    input: {
      kind: inbound.tipo === 'texto' ? 'text'
        : inbound.tipo === 'audio' ? 'audio'
        : inbound.tipo === 'imagem' ? 'image'
        : inbound.tipo === 'documento' ? 'pdf'
        : 'text',
      content_ref: inbound.id,
      content_hmac: '', // HMAC computed by BaseContextBuilder; stub ok for hot path
      received_at: receivedAt,
    },
    active_procedure_execution_id,
    feature_flags_snapshot,
    entered_at_ms: Date.now(),
    // Fail-open default: 0 sensitive memories. The real count is provided by
    // BaseContextBuilder.build(); this hot-path builder lacks access to the
    // memory resolver, so we use the conservative floor (no false floor).
    active_sensitive_memory_count: 0,
  };
}

/**
 * Apply tool_reductions from DecisionPacket to the current toolSet.
 *
 * Filters out any tool whose name appears in `blocked_tools`. The Decision
 * Engine's ActionDecider already merges Mid PEP `reduce_tool_set` entries into
 * `blocked_tools`; we just enforce them here.
 *
 * @param toolSet - Output of getToolSchemas (array of { name, description, input_schema })
 * @param tool_permissions - From DecisionPacket.tool_permissions
 */
export function applyToolReductions<T extends { name: string }>(
  toolSet: T[],
  tool_permissions: { allowed_tools: string[]; blocked_tools: string[]; requires_confirmation: string[] },
): T[] {
  if (!tool_permissions.blocked_tools.length) return toolSet;
  const blocked = new Set(tool_permissions.blocked_tools);
  return toolSet.filter((t) => !blocked.has(t.name));
}
