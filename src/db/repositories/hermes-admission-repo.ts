/** Tool-free SYNTHETIC admission. No prompt pipeline, classifiers or business effects.
 * Identity and input come only from scoped persisted rows. Control → turn → run;
 * request/binding/manifest commit together, before any worker I/O.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTx } from '../client.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';
import { ensureHermesConversationControl } from './hermes-control-producer.js';
import { engineRunsRepo } from './engine-repos.js';
import { persistSyntheticHermesManifest } from './hermes-manifest-repo.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { computeManifestDigest, parseRuntimeManifest } from '@/integrations/hermes/manifest.js';
import { engineRequestV1Schema, hostContextSnapshotV1Schema } from '@/runtime/engines/schemas.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import type { SyntheticCoreRuntime } from '@/runtime/engines/synthetic-core-context.js';
import { config } from '@/config/env.js';
class Refused extends Error {}

export async function prepareSyntheticHermesAdmission(input: {
  message_id: string;
  execution: TurnExecutionContext;
  runtime: SyntheticCoreRuntime;
}): Promise<string | null> {
  const { execution: e, runtime } = input;
  const tenant = getCurrentTenant(),
    agent = getCurrentAgent();
  if (
    e.tenant_id !== tenant ||
    e.agent_id !== agent ||
    e.signal.aborted ||
    config.MAIA_HERMES_KILL_SWITCH ||
    !config.FEATURE_OUTBOUND_DURABLE_COMMIT
  )
    return null;
  const control = await ensureHermesConversationControl({
    turn_id: e.turn_id,
    claim_token: e.claim_token,
  });
  if (control.kind !== 'ok') return null;
  try {
    return await withTx(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM conversation_controls WHERE tenant_id=${tenant} AND agent_id=${agent} AND id=${control.control_id} FOR UPDATE`,
      );
      await tx.execute(
        sql`SELECT id FROM agent_turns WHERE tenant_id=${tenant} AND agent_id=${agent} AND id=${e.turn_id} FOR UPDATE`,
      );
      const row = (
        await tx.execute(sql`
        SELECT c.pessoa_id,c.conversa_id,c.channel_id,c.stream_key,c.control_epoch::text,
          m.conteudo,m.metadata
        FROM agent_turns t
        JOIN mensagens m ON m.tenant_id=t.tenant_id AND m.agent_id=t.agent_id AND m.id=t.representative_message_id
        JOIN conversas cv ON cv.tenant_id=t.tenant_id AND cv.agent_id=t.agent_id AND cv.id=m.conversa_id AND cv.channel_id=m.channel_id
        JOIN pessoas p ON p.tenant_id=t.tenant_id AND p.agent_id=t.agent_id AND p.id=cv.pessoa_id
        JOIN conversation_controls c ON c.tenant_id=t.tenant_id AND c.agent_id=t.agent_id AND c.id=${control.control_id}
          AND c.conversa_id=cv.id AND c.pessoa_id=p.id AND c.channel_id=cv.channel_id AND c.stream_key=t.stream_key
        JOIN channels ch ON ch.tenant_id=t.tenant_id AND ch.agent_id=t.agent_id AND ch.id=c.channel_id
        JOIN agent_canary_policy canary ON canary.tenant_id=t.tenant_id AND canary.agent_id=t.agent_id
        JOIN agent_engine_policies policy ON policy.tenant_id=t.tenant_id AND policy.agent_id=t.agent_id AND policy.channel_id=ch.id
        WHERE t.tenant_id=${tenant} AND t.agent_id=${agent} AND t.id=${e.turn_id}
          AND m.id=${input.message_id} AND m.direcao='in' AND m.tipo='texto'
          AND m.stream_key=t.stream_key AND m.stream_key_version=1 AND t.stream_key_version=1
          AND t.status='running' AND t.claim_token=${e.claim_token}::uuid
          AND t.claimed_by=${e.worker_id} AND t.attempt_count=${e.attempt} AND t.lease_expires_at>clock_timestamp()
          AND c.mode='bot' AND c.control_epoch::text=${control.control_epoch}
          AND ch.is_synthetic=true AND canary.stage='synthetic' AND policy.engine='hermes'
        FOR SHARE OF m,cv,p,ch,canary,policy`)
      ).rows[0] as
        | {
            pessoa_id: string;
            conversa_id: string;
            channel_id: string;
            stream_key: string;
            control_epoch: string;
            conteudo: string;
            metadata: Record<string, unknown>;
          }
        | undefined;
      if (
        !row ||
        typeof row.conteudo !== 'string' ||
        !row.conteudo.trim() ||
        !hostContextSnapshotV1Schema.shape.remote_jid.safeParse(row.metadata?.remote_jid).success
      )
        throw new Refused();
      // This narrow lane does not silently drop a debounced multi-message turn.
      const inputs = (
        await tx.execute(sql`SELECT mensagem_id FROM agent_turn_inputs
        WHERE tenant_id=${tenant} AND agent_id=${agent} AND turn_id=${e.turn_id}`)
      ).rows;
      if (inputs.length !== 1 || inputs[0]?.mensagem_id !== input.message_id) throw new Refused();
      const deadline_ms = Math.min(120000, e.deadline.getTime() - Date.now());
      if (deadline_ms <= 0 || e.signal.aborted) throw new Refused();
      const run_id = randomUUID();
      const request = engineRequestV1Schema.parse({
        version: 1,
        run_id,
        request_key: randomUUID(),
        task: 'reasoner',
        isolation: 'one_run_no_shared_memory',
        context: {
          system:
            'Synthetic text-only evaluation. No tools, business actions or persistent memory.',
          messages: [{ role: 'user', content: row.conteudo }],
          tools: [],
        },
        limits: {
          max_iterations: 5,
          max_output_tokens_per_call: 1024,
          max_tool_calls: 1,
          deadline_at: new Date(Date.now() + deadline_ms).toISOString(),
          max_cost_microusd: '1000',
        },
      });
      const host = hostContextSnapshotV1Schema.parse({
        version: 1,
        tenant_id: tenant,
        agent_id: agent,
        turn_id: e.turn_id,
        pessoa_id: row.pessoa_id,
        conversa_id: row.conversa_id,
        channel_id: row.channel_id,
        representative_message_id: input.message_id,
        input_message_ids: [input.message_id],
        stream_key: row.stream_key,
        control_id: control.control_id,
        control_epoch: row.control_epoch,
        remote_jid: row.metadata.remote_jid,
        trace_id: randomUUID(),
        active_role_id: null,
        active_execution_id: null,
        outbound_prefix: null,
        allowed_entity_ids: [],
        allowed_tool_names: [],
        policy_digest: canonicalDigest({
          evidence_class: 'synthetic',
          engine: 'hermes',
          channel_id: row.channel_id,
        }),
        source_versions: [],
      });
      const parsed = parseRuntimeManifest({
        schema: 'maia-hermes-runtime-manifest/v1',
        run_id,
        policy_revision: 'synthetic-text-v1',
        mode: 'live',
        bundle_digest: canonicalDigest([]),
        context_digest: canonicalDigest(request.context),
        control_epoch: row.control_epoch,
        exposure_epoch: '0',
        runtime_pin: {
          hermes_sha: runtime.hermesSha,
          adapter_revision: runtime.pin.adapter_revision,
          // Explicit synthetic labels, NEVER release attestations.
          image_digest: canonicalDigest({
            evidence_class: 'synthetic',
            source_checkout: runtime.hermesSha,
          }),
          dependency_lock_digest: canonicalDigest({
            evidence_class: 'synthetic',
            unattested: true,
          }),
        },
        tools: [],
        limits: {
          deadline_at: request.limits.deadline_at,
          max_tool_calls: 1,
          max_inference_calls: 1,
          max_context_tokens: 100000,
          max_output_tokens: 1024,
          max_payload_bytes: 262144,
          max_json_depth: 32,
          budget: { amount_microusd: '1000', unit: 'microusd' },
        },
        data_policy: { ref: 'synthetic-only', version: '1' },
        publication_refs: [],
        retention_policy_ref: 'synthetic-only',
        denies: {
          native_memory: true,
          generic_filesystem: true,
          code_execution: true,
          browsing: true,
          mcp: true,
          delegation: true,
          background_review: true,
          cron: true,
          messaging: true,
          discovery_expanding_tools: true,
        },
      });
      if (parsed.kind !== 'ok') throw new Refused();
      const manifest = parsed.manifest;
      const prepared = await engineRunsRepo.pinEngineAndPrepareRun(
        {
          run_id,
          turn_id: e.turn_id,
          origin_claim_token: e.claim_token,
          origin_turn_attempt: e.attempt,
          origin_worker_id: e.worker_id,
          control_id: control.control_id,
          control_epoch: row.control_epoch,
          mode: 'live',
          manifest_digest: computeManifestDigest(manifest),
          engine: 'hermes',
          adapter_revision: runtime.pin.adapter_revision,
          configuration_digest: runtime.pin.configuration_digest,
          max_generations: 1,
          request_key: request.request_key,
          remote_instance_id: runtime.remoteInstanceId,
          request_json: JSON.parse(JSON.stringify(request)),
          request_hash: canonicalDigest(request),
          host_context_json: JSON.parse(JSON.stringify(host)),
          host_context_hash: canonicalDigest(host),
          deadline_ms,
          reconcile_deadline_ms: deadline_ms + 60000,
        },
        tx,
      );
      if (!prepared.ok) throw new Refused();
      const saved = await persistSyntheticHermesManifest(manifest, e, tx);
      if (saved.kind !== 'stored') throw new Refused();
      return run_id;
    });
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}
