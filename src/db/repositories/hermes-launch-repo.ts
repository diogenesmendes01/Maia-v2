/** Read-only launch boundary. Never authorizes effects: admission still locks and
 * revalidates in engineRunsRepo/inferenceRepo. No transaction spans worker IO. */
import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { engineRequestV1Schema, hostContextSnapshotV1Schema } from '@/runtime/engines/schemas.js';
import type { EngineRequestV1, HostContextSnapshotV1 } from '@/runtime/engines/contracts.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';

export interface HermesLaunchContext {
  request: EngineRequestV1;
  host: HostContextSnapshotV1;
  phase: 'prepared' | 'submitting' | 'running';
  row_version: number;
  remote_instance_id: string;
  manifest_digest: string;
  adapter_revision: string;
  configuration_digest: string;
  deadline_at: string;
  lease_expires_at: string;
}

type Row = Omit<HermesLaunchContext, 'request' | 'host'> & {
  request_json: unknown;
  host_context_json: unknown;
  request_hash: string;
  host_context_hash: string;
  request_key: string;
  control_id: string;
  control_epoch: string;
  channel_id: string;
  stream_key: string;
  pessoa_id: string;
  conversa_id: string;
  representative_message_id: string;
};

export async function loadHermesLaunchContext(
  runId: string,
  execution: TurnExecutionContext,
): Promise<HermesLaunchContext | null> {
  const tenant = getCurrentTenant();
  const agent = getCurrentAgent();
  if (execution.signal.aborted || tenant !== execution.tenant_id || agent !== execution.agent_id)
    return null;
  const result = await db.execute(sql`
    SELECT r.request_json, r.request_hash, r.host_context_json, r.host_context_hash,
           r.request_key, r.phase, r.row_version, r.manifest_digest, r.remote_instance_id,
           b.adapter_revision, b.configuration_digest,
           r.deadline_at, t.lease_expires_at, r.control_id, r.control_epoch::text,
           c.channel_id, c.stream_key, c.pessoa_id, c.conversa_id, t.representative_message_id
      FROM engine_runs r
      JOIN engine_turn_bindings b ON b.tenant_id=r.tenant_id AND b.agent_id=r.agent_id AND b.turn_id=r.turn_id
      JOIN agent_turns t ON t.tenant_id=r.tenant_id AND t.agent_id=r.agent_id AND t.id=r.turn_id
      JOIN conversation_controls c ON c.tenant_id=r.tenant_id AND c.agent_id=r.agent_id AND c.id=r.control_id
      JOIN conversas cv ON cv.tenant_id=r.tenant_id AND cv.agent_id=r.agent_id
        AND cv.id=c.conversa_id AND cv.pessoa_id=c.pessoa_id AND cv.channel_id=c.channel_id
      JOIN pessoas p ON p.tenant_id=r.tenant_id AND p.agent_id=r.agent_id AND p.id=cv.pessoa_id
      JOIN channels ch ON ch.tenant_id=r.tenant_id AND ch.agent_id=r.agent_id AND ch.id=cv.channel_id
      JOIN mensagens m ON m.tenant_id=r.tenant_id AND m.agent_id=r.agent_id
        AND m.id=t.representative_message_id AND m.conversa_id=cv.id AND m.channel_id=ch.id
     WHERE r.tenant_id=${tenant} AND r.agent_id=${agent} AND r.id=${runId}
       AND r.turn_id=${execution.turn_id} AND r.origin_claim_token=${execution.claim_token}::uuid
       AND r.origin_turn_attempt=${execution.attempt} AND r.origin_worker_id=${execution.worker_id}
       AND t.claim_token=r.origin_claim_token AND t.attempt_count=r.origin_turn_attempt
       AND t.claimed_by=r.origin_worker_id AND t.status='running'
       AND t.lease_expires_at > clock_timestamp() AND r.deadline_at > clock_timestamp()
       AND c.mode='bot' AND c.control_epoch=r.control_epoch
       AND r.capabilities_revoked_at IS NULL AND r.mode='live'
       AND r.phase IN ('prepared','submitting','running') AND b.engine='hermes'`);
  const row = (result.rows as unknown as Row[])[0];
  if (!row) return null;
  const request = engineRequestV1Schema.safeParse(row.request_json);
  const host = hostContextSnapshotV1Schema.safeParse(row.host_context_json);
  if (!request.success || !host.success) return null;
  if (
    canonicalDigest(row.request_json) !== row.request_hash ||
    canonicalDigest(row.host_context_json) !== row.host_context_hash ||
    request.data.run_id !== runId ||
    request.data.request_key !== row.request_key ||
    host.data.tenant_id !== tenant ||
    host.data.agent_id !== agent ||
    host.data.turn_id !== execution.turn_id ||
    host.data.control_id !== row.control_id ||
    host.data.control_epoch !== row.control_epoch ||
    host.data.channel_id !== row.channel_id ||
    host.data.stream_key !== row.stream_key ||
    host.data.pessoa_id !== row.pessoa_id ||
    host.data.conversa_id !== row.conversa_id ||
    host.data.representative_message_id !== row.representative_message_id
  )
    return null;
  return {
    request: request.data as EngineRequestV1,
    host: host.data,
    phase: row.phase,
    row_version: Number(row.row_version),
    remote_instance_id: row.remote_instance_id,
    manifest_digest: row.manifest_digest,
    adapter_revision: row.adapter_revision,
    configuration_digest: row.configuration_digest,
    deadline_at: new Date(row.deadline_at).toISOString(),
    lease_expires_at: new Date(row.lease_expires_at).toISOString(),
  };
}
