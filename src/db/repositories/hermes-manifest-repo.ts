/** Durable SYNTHETIC manifests only. No publication/release approval is inferred.
 * The harness/backend supplies the compiled manifest; no wire/admin endpoint.
 * Locks: control → turn → run. Immutable bytes, one audit in the same TX.
 */
import { sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { auditTx } from '@/governance/audit.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { computeManifestDigest, parseRuntimeManifest } from '@/integrations/hermes/manifest.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';

type Result = { kind: 'stored'; digest: string } | { kind: 'refused' };
export async function persistSyntheticHermesManifest(
  value: unknown,
  execution: TurnExecutionContext,
  transaction?: typeof db,
): Promise<Result> {
  const tenant = getCurrentTenant(),
    agent = getCurrentAgent();
  const parsed = parseRuntimeManifest(value);
  if (
    execution.signal.aborted ||
    execution.tenant_id !== tenant ||
    execution.agent_id !== agent ||
    parsed.kind !== 'ok'
  )
    return { kind: 'refused' };
  const manifest = parsed.manifest;
  // A synthetic artifact cannot claim any published knowledge or business tool.
  if (
    manifest.tools.length ||
    manifest.publication_refs.length ||
    manifest.bundle_digest !== canonicalDigest([]) ||
    manifest.mode !== 'live'
  )
    return { kind: 'refused' };
  const digest = computeManifestDigest(manifest);
  const transact = transaction ? <T>(fn: (tx: typeof db) => Promise<T>) => fn(transaction) : withTx;
  return transact(async (tx) => {
    await tx.execute(sql`SELECT c.id FROM conversation_controls c JOIN engine_runs r
      ON r.tenant_id=c.tenant_id AND r.agent_id=c.agent_id AND r.control_id=c.id
      WHERE r.tenant_id=${tenant} AND r.agent_id=${agent} AND r.id=${manifest.run_id} FOR UPDATE OF c`);
    await tx.execute(
      sql`SELECT id FROM agent_turns WHERE tenant_id=${tenant} AND agent_id=${agent} AND id=${execution.turn_id} FOR UPDATE`,
    );
    await tx.execute(
      sql`SELECT id FROM engine_runs WHERE tenant_id=${tenant} AND agent_id=${agent} AND id=${manifest.run_id} FOR UPDATE`,
    );
    const row = (
      await tx.execute(sql`
      SELECT r.request_json, b.adapter_revision FROM engine_runs r
      JOIN agent_turns t ON t.tenant_id=r.tenant_id AND t.agent_id=r.agent_id AND t.id=r.turn_id
      JOIN engine_turn_bindings b ON b.tenant_id=r.tenant_id AND b.agent_id=r.agent_id AND b.turn_id=r.turn_id
      JOIN conversation_controls c ON c.tenant_id=r.tenant_id AND c.agent_id=r.agent_id AND c.id=r.control_id
      JOIN channels ch ON ch.tenant_id=c.tenant_id AND ch.agent_id=c.agent_id AND ch.id=c.channel_id
      JOIN agent_canary_policy p ON p.tenant_id=r.tenant_id AND p.agent_id=r.agent_id
      WHERE r.tenant_id=${tenant} AND r.agent_id=${agent} AND r.id=${manifest.run_id}
      AND r.turn_id=${execution.turn_id} AND r.phase='prepared' AND r.mode='live'
      AND r.manifest_digest=${digest} AND r.control_epoch::text=${manifest.control_epoch}
      AND r.origin_claim_token=${execution.claim_token}::uuid AND r.origin_turn_attempt=${execution.attempt}
      AND r.origin_worker_id=${execution.worker_id} AND r.capabilities_revoked_at IS NULL
      AND r.deadline_at>clock_timestamp() AND t.status='running' AND t.claim_token=r.origin_claim_token
      AND t.attempt_count=r.origin_turn_attempt AND t.claimed_by=r.origin_worker_id AND t.lease_expires_at>clock_timestamp()
      AND c.mode='bot' AND c.control_epoch=r.control_epoch AND ch.is_synthetic=true
      AND p.stage='synthetic' AND b.engine='hermes'
      FOR SHARE OF p,ch`)
    ).rows[0] as { request_json: { context: unknown }; adapter_revision: string } | undefined;
    if (
      !row ||
      canonicalDigest(row.request_json.context) !== manifest.context_digest ||
      row.adapter_revision !== manifest.runtime_pin.adapter_revision
    )
      return { kind: 'refused' };
    const inserted =
      await tx.execute(sql`INSERT INTO hermes_runtime_manifests(tenant_id,agent_id,run_id,digest,evidence_class,manifest_json)
      VALUES(${tenant},${agent},${manifest.run_id},${digest},'synthetic',${JSON.stringify(manifest)}::jsonb)
      ON CONFLICT (tenant_id,agent_id,run_id) DO NOTHING RETURNING digest`);
    const saved = (
      await tx.execute(
        sql`SELECT digest FROM hermes_runtime_manifests WHERE tenant_id=${tenant} AND agent_id=${agent} AND run_id=${manifest.run_id}`,
      )
    ).rows[0] as { digest: string } | undefined;
    if (saved?.digest !== digest) return { kind: 'refused' };
    if (inserted.rows.length)
      await auditTx(tx, {
        acao: 'hermes_manifest_persisted',
        alvo_id: manifest.run_id,
        metadata: { digest, evidence_class: 'synthetic', turn_id: execution.turn_id },
      });
    return { kind: 'stored', digest };
  });
}

export async function loadSyntheticHermesManifest(digest: string): Promise<unknown> {
  const tenant = getCurrentTenant(),
    agent = getCurrentAgent();
  const row = (
    await db.execute(sql`SELECT m.manifest_json FROM hermes_runtime_manifests m
    JOIN agent_canary_policy p ON p.tenant_id=m.tenant_id AND p.agent_id=m.agent_id
    JOIN engine_runs r ON r.tenant_id=m.tenant_id AND r.agent_id=m.agent_id AND r.id=m.run_id
    JOIN conversation_controls c ON c.tenant_id=r.tenant_id AND c.agent_id=r.agent_id AND c.id=r.control_id
    JOIN channels ch ON ch.tenant_id=c.tenant_id AND ch.agent_id=c.agent_id AND ch.id=c.channel_id
    WHERE m.tenant_id=${tenant} AND m.agent_id=${agent} AND m.digest=${digest}
    AND m.evidence_class='synthetic' AND p.stage='synthetic' AND ch.is_synthetic=true
    AND c.mode='bot' AND c.control_epoch=r.control_epoch AND r.capabilities_revoked_at IS NULL`)
  ).rows[0] as { manifest_json: unknown } | undefined;
  if (!row) return null;
  const parsed = parseRuntimeManifest(row.manifest_json);
  return parsed.kind === 'ok' && computeManifestDigest(parsed.manifest) === digest
    ? parsed.manifest
    : null;
}
