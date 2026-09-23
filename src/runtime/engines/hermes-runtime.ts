/** Journal → isolated engine → inference grant → journal composition.
 * Textual runs with NO tools only. Explicit withSyntheticCore composition
 * connects core admission; default/env live activation remains closed.
 * Manifests are reloaded from the scoped synthetic-only PostgreSQL store.
 * Deployment comes from the backend, never model input; live remains closed.
 */
import { loadSyntheticHermesManifest } from '@/db/repositories/hermes-manifest-repo.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { loadHermesLaunchContext } from '@/db/repositories/hermes-launch-repo.js';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { audit } from '@/governance/audit.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  INFERENCE_GRANT_AUDIENCE,
  toolSurfaceOf,
} from '@/integrations/hermes/inference-credential.js';
import { computeManifestDigest, parseRuntimeManifest } from '@/integrations/hermes/manifest.js';
import type { HermesSupervisorV1 } from '@/integrations/hermes/supervisor.js';
import { getTurnExecutionContext } from '@/runtime/turns/execution-context.js';
import { createHermesEngine, type HermesRunContextV1 } from './hermes-engine.js';
import { createHermesJournalPort } from './hermes-journal.js';
import { contractEnv } from '@/config/contract-env.js';
import {
  createHermesSupervisor,
  hermesSupervisorConfigV1Schema,
} from '@/integrations/hermes/supervisor.js';
import { z } from 'zod';
import { withSyntheticCoreRuntime } from './synthetic-core-context.js';
import type { EngineStartResultV1 } from './contracts.js';

const syntheticDeploymentSchema = z
  .object({
    evidence_class: z.literal('synthetic'),
    transport: z.literal('local_ipc_v1'),
    supervisor: hermesSupervisorConfigV1Schema,
    inference: z
      .object({
        base_url: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === 'http:' &&
              url.hostname === '127.0.0.1' &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              url.pathname === '/internal/hermes-inference/v1'
            );
          }),
        model: z.string().min(1),
        provider: z.literal('openai'),
      })
      .strict(),
  })
  .strict();

/** Disabled means no deployment lookup, filesystem, supervisor or worker.
 * This source-checkout lane cannot approve real data or a release image.
 * Full live deployment attestation remains a separate, closed gate (§9.4).
 */
export async function createConfiguredHermesRuntime(
  input: { enabled?: boolean; deployment?: unknown } = {},
) {
  const enabled = input.enabled ?? contractEnv.MAIA_HERMES_ENABLED;
  if (enabled === false) return null;
  if (enabled !== true) throw new Error('invalid_hermes_enabled');
  if (!input.deployment) throw new Error('deployment_required');
  const parsed = syntheticDeploymentSchema.safeParse(input.deployment);
  if (!parsed.success) throw new Error('synthetic_deployment_invalid');
  const supervisor = createHermesSupervisor(parsed.data.supervisor);
  const runtime = createJournaledHermesRuntime({ supervisor, inference: parsed.data.inference });
  return {
    ...runtime,
    withSyntheticCore<T>(fn: () => Promise<T>): Promise<T> {
      return withSyntheticCoreRuntime(
        { ...runtime, hermesSha: parsed.data.supervisor.hermes_sha },
        fn,
      );
    },
  };
}

export function createJournaledHermesRuntime(input: {
  supervisor: HermesSupervisorV1;
  inference: HermesRunContextV1['inference'];
}) {
  const engine = createHermesEngine({
    supervisor: input.supervisor,
    journal: createHermesJournalPort(engineRunsRepo),
    audit,
    async resolveRunContext(request) {
      const execution = getTurnExecutionContext();
      if (!execution) throw new Error('execution_required');
      const scope = { tenant_id: execution.tenant_id, agent_id: execution.agent_id };
      const load = () =>
        runWithTenantContext(scope, () => loadHermesLaunchContext(request.run_id, execution));
      const persisted = await load();
      if (
        !persisted ||
        persisted.phase !== 'submitting' ||
        canonicalDigest(request) !== canonicalDigest(persisted.request)
      )
        throw new Error('run_not_launchable');
      const parsed = parseRuntimeManifest(
        await loadSyntheticHermesManifest(persisted.manifest_digest),
      );
      if (parsed.kind !== 'ok') throw new Error('manifest_unavailable');
      const manifest = parsed.manifest;
      if (
        computeManifestDigest(manifest) !== persisted.manifest_digest ||
        manifest.run_id !== request.run_id ||
        manifest.mode !== 'live' ||
        manifest.control_epoch !== persisted.host.control_epoch ||
        manifest.context_digest !== canonicalDigest(request.context) ||
        manifest.runtime_pin.hermes_sha !== input.supervisor.config.hermes_sha ||
        manifest.runtime_pin.adapter_revision !== engine.pin.adapter_revision ||
        manifest.tools.length !== 0 ||
        request.context.tools.length !== 0 ||
        persisted.host.allowed_tool_names.length !== 0
      )
        throw new Error('manifest_mismatch');
      const deadline = Math.min(
        Date.parse(persisted.deadline_at),
        Date.parse(request.limits.deadline_at),
        Date.parse(manifest.limits.deadline_at),
      );
      const ttl_ms = Math.floor(deadline - Date.now());
      if (ttl_ms <= 0) throw new Error('deadline_exceeded');
      const grant = await runWithTenantContext(scope, () =>
        inferenceRepo.issueGrant({
          run_id: request.run_id,
          audience: INFERENCE_GRANT_AUDIENCE,
          model: input.inference.model,
          tool_surface: toolSurfaceOf(manifest.tools, input.inference.model),
          max_inference_calls: manifest.limits.max_inference_calls,
          max_output_tokens: Math.min(
            request.limits.max_output_tokens_per_call,
            manifest.limits.max_output_tokens,
          ),
          ttl_ms,
        }),
      );
      if (!grant.ok) throw new Error('grant_unavailable');
      let horizon = Date.parse(persisted.lease_expires_at);
      const host = persisted.host;
      return {
        manifest,
        inference: { ...input.inference },
        inference_credential: grant.token,
        binding: {
          version: 1,
          run_id: request.run_id,
          execution_id: request.run_id,
          task_id: `task-${request.run_id}`,
          initial_session_id: `session-${request.run_id}`,
          ...scope,
          pessoa_id: host.pessoa_id,
          conversa_id: host.conversa_id,
          mensagem_id: host.representative_message_id,
          turn_id: execution.turn_id,
          turn_attempt: execution.attempt,
          origin_claim_token: execution.claim_token,
          control_id: host.control_id,
          control_epoch: host.control_epoch,
          mode: 'live',
          manifest_digest: persisted.manifest_digest,
          context_digest: manifest.context_digest,
          bundle_digest: manifest.bundle_digest,
          deadline_at: new Date(deadline).toISOString(),
          acl: { pessoa_ids: [host.pessoa_id], conversa_ids: [host.conversa_id], entidade_ids: [] },
        },
        leaseHorizonMs: () => Math.min(horizon, execution.deadline.getTime()),
        async revalidate() {
          const current = await load();
          if (!current || (current.phase !== 'submitting' && current.phase !== 'running'))
            return false;
          if (
            !(await runWithTenantContext(scope, () =>
              loadSyntheticHermesManifest(current.manifest_digest),
            ))
          )
            return false;
          horizon = Date.parse(current.lease_expires_at);
          return true;
        },
      };
    },
  });

  return {
    engine,
    pin: engine.pin,
    remoteInstanceId: engine.remoteInstanceId,
    shutdown: () => engine.shutdown(),
    /** One CAS winner may start. A repeat NEVER starts a second worker. Runs in
     * any other phase require observe/reconcile, not this entry point. */
    async startPrepared(run_id: string): Promise<EngineStartResultV1> {
      const execution = getTurnExecutionContext();
      const refused = (code: string): EngineStartResultV1 => ({
        kind: 'rejected',
        definitely_not_accepted: true,
        code,
      });
      if (!execution) return refused('execution_required');
      const persisted = await loadHermesLaunchContext(run_id, execution);
      if (!persisted || persisted.phase !== 'prepared')
        return { kind: 'unknown', code: 'run_requires_reconciliation' };
      if (persisted.remote_instance_id !== engine.remoteInstanceId)
        return refused('supervisor_incarnation_mismatch');
      if (
        persisted.adapter_revision !== engine.pin.adapter_revision ||
        persisted.configuration_digest !== engine.pin.configuration_digest
      )
        return refused('pin_mismatch');
      const marked = await engineRunsRepo.markSubmitting({
        run_id,
        turn_id: execution.turn_id,
        origin_claim_token: execution.claim_token,
        expected_row_version: persisted.row_version,
      });
      if (!marked.ok) return { kind: 'unknown', code: 'submission_fenced' };
      const started = await engine.start(persisted.request, {
        signal: execution.signal,
        invokeTool: async (call) => ({
          kind: 'refused',
          call_id: call.call_id,
          code: 'tool_not_allowed',
        }),
      });
      if (started.kind === 'rejected') {
        // No retry policy is invented here. Preserve the durable submit intent
        // and revoke; a separate reconciler must close it before a new generation.
        await engineRunsRepo.revokeRunCapabilities({
          run_id,
          turn_id: execution.turn_id,
          actor: { kind: 'turn_owner', origin_claim_token: execution.claim_token },
          reason_code: 'launch_rejected',
        });
        return started;
      }
      const observed = await engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: execution.turn_id,
        origin_claim_token: execution.claim_token,
        observation: started,
      });
      return observed.ok ? started : { kind: 'unknown', code: 'start_observation_fenced' };
    },
  };
}
