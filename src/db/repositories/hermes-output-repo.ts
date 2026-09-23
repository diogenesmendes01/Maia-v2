/** Synthetic textual terminal recovery. Read-only preparation; no business pipeline.
 * Output authority is rechecked under locks by the existing outbox transaction.
 * This is NOT an admission path for new runs or a live bundle approval.
 */
import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { computeManifestDigest, parseRuntimeManifest } from '@/integrations/hermes/manifest.js';
import {
  engineTerminalProposalV1Schema,
  hostContextSnapshotV1Schema,
  engineRequestV1Schema,
} from '@/runtime/engines/schemas.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import { assembleTurnResult } from '@/runtime/engines/assembler.js';

/** Durable correlation, not a facade delivery boolean. Closed runs are not
 * candidates for maintenance and uncorrelated local artifacts prove nothing. */
export async function readSyntheticHermesHandoff(turn_id: string) {
  const tenant = getCurrentTenant(),
    agent = getCurrentAgent();
  const row = (
    await db.execute(sql`
    SELECT r.id AS run_id, r.row_version, o.id AS outbound_id, o.status AS outbound_status, o.conversa_id, o.in_reply_to FROM engine_runs r
    JOIN agent_turns t ON t.tenant_id=r.tenant_id AND t.agent_id=r.agent_id AND t.id=r.turn_id
    JOIN hermes_runtime_manifests m ON m.tenant_id=r.tenant_id AND m.agent_id=r.agent_id AND m.run_id=r.id AND m.digest=r.manifest_digest
    JOIN outbound_messages o ON o.tenant_id=r.tenant_id AND o.agent_id=r.agent_id AND o.turn_id=r.turn_id
    WHERE r.tenant_id=${tenant} AND r.agent_id=${agent} AND r.turn_id=${turn_id}
      AND r.phase='result_ready' AND r.adopted_by_turn_attempt IS NOT NULL
      AND m.evidence_class='synthetic' AND t.status IN ('outbound_pending','completed')
      AND o.status IN ('delivered','completed') AND o.sequence_in_turn=0 AND o.origin='bot'
      AND EXISTS (SELECT 1 FROM mensagens h WHERE h.tenant_id=o.tenant_id AND h.agent_id=o.agent_id AND h.outbound_id=o.id AND h.direcao='out' AND h.conversa_id=o.conversa_id)
      AND o.control_id=r.control_id AND o.control_epoch=r.control_epoch
      AND (SELECT count(*) FROM outbound_messages x WHERE x.tenant_id=r.tenant_id AND x.agent_id=r.agent_id AND x.turn_id=r.turn_id)=1
      AND EXISTS (SELECT 1 FROM audit_log a WHERE a.tenant_id=r.tenant_id AND a.agent_id=r.agent_id
        AND a.acao='outbound_committed' AND a.alvo_id=o.id
        AND a.metadata->>'engine_run_id'=r.id::text AND a.metadata->>'engine_terminal_hash'=r.terminal_hash)
  `)
  ).rows[0] as
    | {
        run_id: string;
        row_version: number;
        outbound_id: string;
        outbound_status: string;
        conversa_id: string;
        in_reply_to: string;
      }
    | undefined;
  return row ?? null;
}

/** Authorizes synthetic egress, not generic terminal reconciliation/adoption.
 * Revocation is monotonic; a valid terminal/claim never grants permission by itself.
 * This optimistic read must still be fenced by the outbox commit transaction. */
export async function loadSyntheticHermesOutput(run_id: string, execution: TurnExecutionContext) {
  const tenant = getCurrentTenant(),
    agent = getCurrentAgent();
  if (execution.signal.aborted || execution.tenant_id !== tenant || execution.agent_id !== agent)
    return null;
  const row = (
    await db.execute(sql`
    SELECT r.terminal_json, r.terminal_hash, r.host_context_json, r.host_context_hash,
      r.request_json, r.request_hash, r.request_key, r.manifest_digest,
      r.output_preparation_json, r.row_version, m.manifest_json,
      c.id AS control_id, c.control_epoch::text, c.stream_key, c.pessoa_id, c.conversa_id,
      c.channel_id, t.representative_message_id
    FROM engine_runs r
    JOIN engine_turn_bindings b ON b.tenant_id=r.tenant_id AND b.agent_id=r.agent_id AND b.turn_id=r.turn_id
    JOIN agent_turns t ON t.tenant_id=r.tenant_id AND t.agent_id=r.agent_id AND t.id=r.turn_id
    JOIN conversation_controls c ON c.tenant_id=r.tenant_id AND c.agent_id=r.agent_id AND c.id=r.control_id
    JOIN conversas cv ON cv.tenant_id=r.tenant_id AND cv.agent_id=r.agent_id AND cv.id=c.conversa_id AND cv.pessoa_id=c.pessoa_id AND cv.channel_id=c.channel_id
    JOIN pessoas p ON p.tenant_id=r.tenant_id AND p.agent_id=r.agent_id AND p.id=cv.pessoa_id
    JOIN channels ch ON ch.tenant_id=r.tenant_id AND ch.agent_id=r.agent_id AND ch.id=cv.channel_id
    JOIN mensagens msg ON msg.tenant_id=r.tenant_id AND msg.agent_id=r.agent_id AND msg.id=t.representative_message_id AND msg.conversa_id=cv.id AND msg.channel_id=ch.id
    JOIN hermes_runtime_manifests m ON m.tenant_id=r.tenant_id AND m.agent_id=r.agent_id AND m.run_id=r.id AND m.digest=r.manifest_digest
    JOIN agent_canary_policy cp ON cp.tenant_id=r.tenant_id AND cp.agent_id=r.agent_id
    WHERE r.tenant_id=${tenant} AND r.agent_id=${agent} AND r.id=${run_id} AND r.turn_id=${execution.turn_id}
      AND r.phase='result_ready' AND r.mode='live' AND b.engine='hermes'
      AND r.capabilities_revoked_at IS NULL
      AND t.status='running' AND t.claim_token=${execution.claim_token}::uuid AND t.attempt_count=${execution.attempt}
      AND t.claimed_by=${execution.worker_id} AND t.lease_expires_at>clock_timestamp()
      AND c.mode='bot' AND c.control_epoch=r.control_epoch AND t.stream_key=c.stream_key
      AND ch.is_synthetic=true AND ch.active=true AND cp.stage='synthetic' AND m.evidence_class='synthetic'
      AND NOT EXISTS (SELECT 1 FROM engine_tool_calls tc WHERE tc.tenant_id=r.tenant_id AND tc.agent_id=r.agent_id AND tc.run_id=r.id)
  `)
  ).rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const host = hostContextSnapshotV1Schema.safeParse(row.host_context_json);
  const proposal = engineTerminalProposalV1Schema.safeParse(row.terminal_json);
  const request = engineRequestV1Schema.safeParse(row.request_json);
  const parsed = parseRuntimeManifest(row.manifest_json);
  if (!host.success || !proposal.success || !request.success || parsed.kind !== 'ok') return null;
  const h = host.data,
    manifest = parsed.manifest;
  if (
    canonicalDigest(row.host_context_json) !== row.host_context_hash ||
    canonicalDigest(row.terminal_json) !== row.terminal_hash ||
    canonicalDigest(row.request_json) !== row.request_hash ||
    computeManifestDigest(manifest) !== row.manifest_digest ||
    manifest.run_id !== run_id ||
    manifest.tools.length ||
    manifest.publication_refs.length ||
    manifest.context_digest !== canonicalDigest(request.data.context) ||
    manifest.control_epoch !== row.control_epoch ||
    manifest.mode !== 'live' ||
    request.data.run_id !== run_id ||
    request.data.request_key !== row.request_key ||
    proposal.data.run_id !== run_id ||
    proposal.data.request_key !== row.request_key ||
    proposal.data.observed_tool_call_ids.length ||
    request.data.context.tools.length ||
    h.allowed_tool_names.length ||
    h.tenant_id !== tenant ||
    h.agent_id !== agent ||
    h.turn_id !== execution.turn_id ||
    h.control_id !== row.control_id ||
    h.control_epoch !== row.control_epoch ||
    h.pessoa_id !== row.pessoa_id ||
    h.conversa_id !== row.conversa_id ||
    h.channel_id !== row.channel_id ||
    h.stream_key !== row.stream_key ||
    h.representative_message_id !== row.representative_message_id
  )
    return null;
  const assembled = assembleTurnResult({
    proposal: proposal.data,
    receipts: [],
    outboundPrefix: h.outbound_prefix,
  });
  if (!assembled.candidate) return null; // Non-reply needs its own lifecycle policy.
  const preparation = {
    version: 1,
    run_id,
    terminal_hash: String(row.terminal_hash),
    text: assembled.candidate.text,
  };
  if (
    row.output_preparation_json !== null &&
    canonicalDigest(row.output_preparation_json) !== canonicalDigest(preparation)
  )
    return null;
  return { host: h, assembled, preparation, row_version: Number(row.row_version) };
}
