import * as manifestsRepo from '@/db/repositories/hermes-manifest-repo.js';
import { loadSyntheticHermesOutput } from '@/db/repositories/hermes-output-repo.js';
import { outboundOutboxRepo } from '@/db/repositories/outbound-outbox-repo.js';
import { buildOutboundArtifact } from '@/runtime/outbound/contract.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import type { EngineRequestV1, HostContextSnapshotV1 } from '@/runtime/engines/contracts.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import { ensureHermesConversationControl } from '@/db/repositories/hermes-control-producer.js';
import { createConfiguredHermesRuntime } from '@/runtime/engines/hermes-runtime.js';
import {
  parseRuntimeManifest,
  computeManifestDigest,
  type RuntimeManifestV1,
} from '@/integrations/hermes/manifest.js';
import { registerHermesInferenceRoute } from '@/integrations/hermes/inference-route.js';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { startStubProvider } from '../helpers/hermes-stub-provider.js';
import { runWithTurnExecution } from '@/runtime/turns/execution-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import type { EnginePinV1 } from '@/runtime/engines/contracts.js';

const previous = vi.hoisted(() => {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({
    FEATURE_TURN_STATE_MACHINE: 'true',
    FEATURE_TURN_CLAIM: 'true',
    FEATURE_OUTBOUND_DURABLE_COMMIT: 'true',
    FEATURE_OUTBOUND_DEDUP: 'false',
    FEATURE_OUTBOUND_VOICE: 'false',
  })) {
    values[key] = process.env[key];
    process.env[key] = value;
  }
  return values;
});
// External infrastructure only. The core, channel resolver, repositories,
// claim, assembler, output facade, commit and delivery fences are REAL.
vi.mock('../../src/gateway/queue.js', async (original) => ({
  enqueueAgentForRecovery: (await original<typeof import('@/gateway/queue.js')>())
    .enqueueAgentForRecovery,
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));
const channel = vi.hoisted(() => ({
  sent: [] as string[],
  loseAck: false,
  beforeResolve: null as null | (() => Promise<void>),
}));
vi.mock('../../src/gateway/line-output.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  forCurrentAgentChannel: async (channel_id: string) => {
    await channel.beforeResolve?.();
    const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
    return {
      scope: { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent(), channel_id },
      sendText: async (_jid: string, text: string) => {
        const { assertEgressAuthorized } = await import('@/runtime/outbound/egress-guard.js');
        assertEgressAuthorized();
        channel.sent.push(text);
        if (channel.loseAck) throw new Error('FAKE: delivery acknowledgement lost');
        return `FAKE-${channel.sent.length}`;
      },
      isConnected: () => true,
      sendDocument: async () => {
        throw new Error('FAKE: no documents');
      },
      sendVoice: async () => {
        throw new Error('FAKE: no voice');
      },
      sendPoll: async () => {
        throw new Error('FAKE: no polls');
      },
    };
  },
}));
const enabled =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL &&
  !!process.env.HERMES_PIN_PYTHON;
const d = enabled ? describe : describe.skip;
const tenant_id = `core-recovery-${randomUUID()}`;
const agent_id = `core-recovery-${randomUUID()}`;
let pool: pg.Pool;
let runCore: typeof import('@/agent/core.js').runAgentForMensagem;
let promptProbe: ReturnType<typeof vi.spyOn>;
let pendingProbe: ReturnType<typeof vi.spyOn>;
const scoped = <T>(fn: () => Promise<T>) => runWithTenantContext({ tenant_id, agent_id }, fn);
async function fixture(options?: {
  pin: EnginePinV1;
  remote: string;
  manifests: Map<string, RuntimeManifestV1>;
}) {
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  const message = randomUUID();
  let control_id = randomUUID();
  const channel_id = randomUUID();
  const run_id = randomUUID();
  const request: EngineRequestV1 = {
    version: 1,
    run_id,
    request_key: randomUUID(),
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: {
      system: 'Synthetic only.',
      messages: [{ role: 'user', content: '<user_message>oi</user_message>' }],
      tools: [],
    },
    limits: {
      max_iterations: 5,
      max_output_tokens_per_call: 1024,
      max_tool_calls: 1,
      deadline_at: new Date(Date.now() + 120_000).toISOString(),
      max_cost_microusd: '1000',
    },
  };
  const host: HostContextSnapshotV1 = {
    version: 1,
    tenant_id,
    agent_id,
    turn_id,
    pessoa_id: randomUUID(),
    conversa_id: randomUUID(),
    channel_id,
    representative_message_id: message,
    input_message_ids: [message],
    stream_key: `v1:${canonicalDigest({ fixture_stream: control_id })}`,
    control_id,
    control_epoch: '0',
    remote_jid: 'synthetic@invalid',
    trace_id: randomUUID(),
    active_role_id: null,
    active_execution_id: null,
    outbound_prefix: null,
    allowed_entity_ids: [],
    allowed_tool_names: [],
    policy_digest: canonicalDigest({ synthetic: true }),
    source_versions: [],
  };
  await pool.query(
    `INSERT INTO channels(id,tenant_id,agent_id,external_id,channel_type) VALUES($1::uuid,$2,$3,$1::text,'whatsapp')`,
    [channel_id, tenant_id, agent_id],
  );
  await pool.query(
    `INSERT INTO pessoas(id,tenant_id,agent_id,nome,telefone_whatsapp,tipo) VALUES($1::uuid,$2,$3,'Synthetic',$1::text,'dono')`,
    [host.pessoa_id, tenant_id, agent_id],
  );
  await pool.query(
    `INSERT INTO conversas(id,tenant_id,agent_id,pessoa_id,channel_id) VALUES($1,$2,$3,$4,$5)`,
    [host.conversa_id, tenant_id, agent_id, host.pessoa_id, channel_id],
  );
  await pool.query(
    `INSERT INTO mensagens(id,tenant_id,agent_id,conversa_id,channel_id,direcao,tipo,conteudo) VALUES($1,$2,$3,$4,$5,'in','texto','synthetic')`,
    [message, tenant_id, agent_id, host.conversa_id, channel_id],
  );
  await pool.query(
    `INSERT INTO agent_turns(id,tenant_id,agent_id,representative_message_id,status,claim_token,attempt_count,claimed_by,lease_expires_at)
    VALUES($1,$2,$3,$4,'running',$5,1,'synthetic-worker',now()+interval '5 minutes')`,
    [turn_id, tenant_id, agent_id, message, claim_token],
  );
  await pool.query(
    `UPDATE mensagens SET stream_key=$2,stream_key_version=1,ingress_seq=1 WHERE id=$1`,
    [message, host.stream_key],
  );
  await pool.query(`UPDATE agent_turns SET stream_key=$2,stream_key_version=1 WHERE id=$1`, [
    turn_id,
    host.stream_key,
  ]);
  const control = await scoped(() => ensureHermesConversationControl({ turn_id, claim_token }));
  if (control.kind !== 'ok') throw new Error('control producer refused fixture');
  control_id = control.control_id;
  host.control_id = control_id;
  host.control_epoch = control.control_epoch;
  let manifest_digest = canonicalDigest({ synthetic: true });
  if (options) {
    const m = parseRuntimeManifest({
      schema: 'maia-hermes-runtime-manifest/v1',
      run_id,
      policy_revision: 'synthetic-1',
      mode: 'live',
      bundle_digest: canonicalDigest([]),
      context_digest: canonicalDigest(request.context),
      control_epoch: '0',
      exposure_epoch: '0',
      runtime_pin: {
        hermes_sha: process.env.HERMES_PIN_SHA,
        adapter_revision: options.pin.adapter_revision,
        image_digest: canonicalDigest({ synthetic_source_checkout: true }),
        dependency_lock_digest: canonicalDigest({ fixture: true }),
      },
      tools: [],
      limits: {
        deadline_at: request.limits.deadline_at,
        max_tool_calls: 1,
        max_inference_calls: 3,
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
    if (m.kind !== 'ok') throw new Error('invalid fixture manifest');
    manifest_digest = computeManifestDigest(m.manifest);
    options.manifests.set(manifest_digest, m.manifest);
  }
  const prepared = await scoped(() =>
    engineRunsRepo.pinEngineAndPrepareRun({
      run_id,
      turn_id,
      origin_claim_token: claim_token,
      origin_turn_attempt: 1,
      origin_worker_id: 'synthetic-worker',
      control_id,
      control_epoch: '0',
      mode: 'live',
      manifest_digest,
      engine: 'hermes',
      adapter_revision: options?.pin.adapter_revision ?? 'test',
      configuration_digest:
        options?.pin.configuration_digest ?? canonicalDigest({ synthetic: true }),
      max_generations: 1,
      request_key: request.request_key,
      remote_instance_id: options?.remote ?? 'synthetic',
      request_json: JSON.parse(JSON.stringify(request)),
      request_hash: canonicalDigest(request),
      host_context_json: JSON.parse(JSON.stringify(host)),
      host_context_hash: canonicalDigest(host),
      deadline_ms: 120_000,
      reconcile_deadline_ms: 180_000,
    }),
  );
  expect(prepared.ok).toBe(true);
  const execution: TurnExecutionContext = {
    tenant_id,
    agent_id,
    turn_id,
    claim_token,
    attempt: 1,
    worker_id: 'synthetic-worker',
    deadline: new Date(Date.now() + 120_000),
    signal: new AbortController().signal,
  };
  return { run_id, request, host, execution, control_id };
}

d('SYNTHETIC core recovery: real DB + AIAgent pin, STUB provider, FAKE channel', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    await pool.query('INSERT INTO tenants(id,nome) VALUES($1,$1)', [tenant_id]);
    await pool.query('INSERT INTO agents(id,tenant_id,nome) VALUES($1,$2,$1)', [
      agent_id,
      tenant_id,
    ]);
    runCore = (await import('@/agent/core.js')).runAgentForMensagem;
    // Passthrough spies measure absence of pipeline work, not substitute results.
    promptProbe = vi.spyOn(await import('@/agent/prompt-builder.js'), 'buildPrompt');
    pendingProbe = vi.spyOn(await import('@/agent/pending-gate.js'), 'checkPendingFirst');
  }, 60000);
  afterEach(() => {
    expect(promptProbe).not.toHaveBeenCalled();
    expect(pendingProbe).not.toHaveBeenCalled();
  });
  afterAll(async () => {
    promptProbe?.mockRestore();
    pendingProbe?.mockRestore();
    await pool?.end();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it.each([
    'deliver',
    'close_crash',
    'scanner_close',
    'scanner_unknown',
    'close_cas',
    'outbound_unknown',
    'pause',
    'pause_resume',
    'lease_expired',
    'revoked_before_load',
    'revoked_before_commit',
    'revoked_pause_resume',
  ])(
    'core terminal recovery: %s',
    async (scenario) => {
      channel.sent = [];
      channel.loseAck = scenario === 'outbound_unknown';
      channel.beforeResolve = null;
      const home = mkdtempSync('/root/maia-work/synthetic-hermes-');
      const stub = await startStubProvider({
        script: [{ kind: 'text', content: 'synthetic response' }],
      });
      const app = Fastify();
      await registerHermesInferenceRoute(app, {
        ledger: inferenceRepo,
        relay: createChatCompletionsRelay({
          provider: 'stub',
          apiKey: 'synthetic-only',
          baseURL: stub.baseUrl,
        }),
        tariffFor: async () => ({
          version: 'synthetic-1',
          input_nanousd_per_token: 1,
          output_nanousd_per_token: 1,
        }),
        runInScope: (s, fn) => runWithTenantContext(s, fn),
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const supervisorConfig = {
        python_executable: process.env.HERMES_PIN_PYTHON!,
        worker_args: ['-m', 'services.hermes_worker.main'],
        worker_cwd: resolve('.'),
        python_path: [process.env.HERMES_PIN_UPSTREAM!, resolve('.')],
        hermes_sha: process.env.HERMES_PIN_SHA!,
        expected_bridge_revision: null,
        platform_env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR! },
        home_root: home,
        ready_timeout_ms: 60000,
        cancel_grace_ms: 1000,
        exit_wait_ms: 5000,
        post_result_exit_ms: 5000,
        hook_timeout_ms: 5000,
        watchdog_interval_ms: 100,
        session_retention_ms: 10000,
      };
      const manifests = new Map<string, RuntimeManifestV1>();
      const runtime = await createConfiguredHermesRuntime({
        enabled: true,
        deployment: {
          evidence_class: 'synthetic',
          transport: 'local_ipc_v1',
          supervisor: supervisorConfig,
          inference: {
            base_url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/internal/hermes-inference/v1`,
            model: 'maia-stub-model',
            provider: 'openai',
          },
        },
      });

      try {
        if (!runtime) throw new Error('runtime disabled');
        const f = await fixture({ pin: runtime.pin, remote: runtime.remoteInstanceId, manifests });
        await pool.query(
          `INSERT INTO agent_canary_policy(tenant_id,agent_id,stage,updated_by) VALUES($1,$2,'synthetic','test-harness') ON CONFLICT(tenant_id,agent_id) DO UPDATE SET stage='synthetic'`,
          [tenant_id, agent_id],
        );
        await pool.query('UPDATE channels SET is_synthetic=true WHERE id=$1', [f.host.channel_id]);
        expect(
          await scoped(() =>
            manifestsRepo.persistSyntheticHermesManifest([...manifests.values()][0], f.execution),
          ),
        ).toMatchObject({ kind: 'stored' });
        manifests.clear();
        await scoped(() =>
          inferenceRepo.openBudgetAccount({
            period_start_utc: new Date().toISOString().slice(0, 10),
            limit_microusd: '1000000',
          }),
        );
        expect(
          await scoped(() =>
            runWithTurnExecution(f.execution, () => runtime.startPrepared(f.run_id)),
          ),
        ).toMatchObject({ kind: 'accepted' });
        await expect
          .poll(
            async () =>
              (await pool.query('SELECT phase FROM engine_runs WHERE id=$1', [f.run_id])).rows[0]
                .phase,
            { timeout: 60000, interval: 100 },
          )
          .toBe('result_ready');
        const authorized = await scoped(() => loadSyntheticHermesOutput(f.run_id, f.execution));
        expect(authorized).not.toBeNull();
        if (!authorized) throw new Error('fixture output not authorized');
        if (scenario === 'deliver') {
          // Forge both the ALS and claimed scope: these must reach the SQL
          // authority, not merely fail the execution-context equality check.
          for (const foreign of [
            { tenant_id: `foreign-${randomUUID()}`, agent_id },
            { tenant_id, agent_id: `foreign-${randomUUID()}` },
          ]) {
            await runWithTenantContext(foreign, async () => {
              expect(
                await loadSyntheticHermesOutput(f.run_id, { ...f.execution, ...foreign }),
              ).toBeNull();
              expect(
                await engineRunsRepo.revokeRunCapabilities({
                  run_id: f.run_id,
                  turn_id: f.execution.turn_id,
                  actor: { kind: 'recovery', actor_ref: 'foreign-scope' },
                  reason_code: 'synthetic_revocation',
                }),
              ).toMatchObject({ ok: false, reason: 'not_found' });
              await expect(
                outboundOutboxRepo.commitTurnOutboundTx({
                  engine_origin: {
                    run_id: f.run_id,
                    terminal_hash: authorized.preparation.terminal_hash,
                  },
                  artifact: buildOutboundArtifact({
                    ...foreign,
                    turn_id: f.execution.turn_id,
                    sequence_in_turn: 0,
                    payload: { type: 'text', text: authorized.preparation.text },
                    channel: 'whatsapp',
                  }),
                  conversa_id: f.host.conversa_id,
                  pessoa_id: f.host.pessoa_id,
                  in_reply_to: f.host.representative_message_id,
                  expected_claim_token: f.execution.claim_token,
                }),
              ).rejects.toThrow('outbound_commit_rejected:engine_origin_invalid');
            });
          }
          expect(
            await scoped(() => loadSyntheticHermesOutput(f.run_id, f.execution)),
          ).not.toBeNull();
        }
        if (scenario === 'revoked_before_load') {
          expect(
            await scoped(() =>
              engineRunsRepo.revokeRunCapabilities({
                run_id: f.run_id,
                turn_id: f.execution.turn_id,
                actor: { kind: 'turn_owner', origin_claim_token: f.execution.claim_token },
                reason_code: 'synthetic_revocation',
              }),
            ),
          ).toMatchObject({ ok: true });
          // Adoption is reconciliation, NOT permission to send. Preserve its
          // existing capability to retain terminal evidence after revocation.
          expect(
            await scoped(() =>
              engineRunsRepo.adoptTerminalResult({
                run_id: f.run_id,
                turn_id: f.execution.turn_id,
                claim_token: f.execution.claim_token,
                output_preparation: authorized.preparation,
                expected_row_version: authorized.row_version,
              }),
            ),
          ).toMatchObject({ ok: true });
          expect(await scoped(() => loadSyntheticHermesOutput(f.run_id, f.execution))).toBeNull();
        }
        // Simulate process death AFTER terminal, before output. Real core obtains
        // a NEW claim. Neither the old origin token nor request is rewritten.
        await pool.query(
          `INSERT INTO agent_turn_inputs(tenant_id,agent_id,turn_id,mensagem_id) VALUES($1,$2,$3,$4)`,
          [tenant_id, agent_id, f.execution.turn_id, f.host.representative_message_id],
        );
        await pool.query(
          `UPDATE mensagens SET metadata=jsonb_build_object('telefone',$2::text,'remote_jid','synthetic@invalid') WHERE id=$1`,
          [f.host.representative_message_id, f.host.channel_id],
        );
        await pool.query(
          `UPDATE agent_turns SET status='queued',claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,conversa_id=$2,channel_id=$3 WHERE id=$1`,
          [f.execution.turn_id, f.host.conversa_id, f.host.channel_id],
        );
        // Race AFTER adoption, inside the real facade before its commit.
        channel.beforeResolve = async () => {
          if (scenario === 'revoked_before_commit' || scenario === 'revoked_pause_resume') {
            // This external channel boundary is reached only AFTER the real
            // coordinator authorized egress. Revoke through the DB authority.
            expect(
              await scoped(() =>
                engineRunsRepo.revokeRunCapabilities({
                  run_id: f.run_id,
                  turn_id: f.execution.turn_id,
                  actor: { kind: 'recovery', actor_ref: 'synthetic-revoker' },
                  reason_code: 'synthetic_revocation',
                }),
              ),
            ).toMatchObject({ ok: true });
          }
          if (scenario === 'pause')
            await pool.query(
              `UPDATE conversation_controls SET mode='pausing',control_epoch=control_epoch+1,owner_app_user_id='synthetic-operator',paused_at=now() WHERE id=$1`,
              [f.control_id],
            );
          if (scenario === 'pause_resume' || scenario === 'revoked_pause_resume')
            await pool.query(
              `UPDATE conversation_controls SET control_epoch=control_epoch+2 WHERE id=$1`,
              [f.control_id],
            );
          if (scenario === 'lease_expired')
            await pool.query(
              `UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
              [f.execution.turn_id],
            );
        };
        if (
          scenario === 'close_crash' ||
          scenario === 'scanner_close' ||
          scenario === 'scanner_unknown'
        ) {
          // Commit the real five-second reservation, then lose the process at
          // close. Also seeds a legacy reservation when the caller is atomic.
          const failOnce = vi
            .spyOn(engineRunsRepo, 'closeRunAfterHandoff')
            .mockImplementationOnce(async (input) => {
              await engineRunsRepo.reserveMaintenanceObservation({
                run_id: input.run_id,
                window_ms: 5000,
                actor: { kind: 'recovery', actor_ref: 'crash_fixture' },
              });
              throw new Error('synthetic crash after reservation');
            });
          // Real BullMQ retry persists in the disposable Redis, NOT a loose
          // timer. Replace the worker after failure, before its 2-second retry.
          const { Queue, Worker } = await import('bullmq');
          const redis = new URL(process.env.REDIS_URL!);
          expect(['127.0.0.1', 'localhost']).toContain(redis.hostname);
          const connection = {
            host: '127.0.0.1',
            port: Number(redis.port),
            db: Number(redis.pathname.slice(1) || 0),
            ...(redis.password ? { password: decodeURIComponent(redis.password) } : {}),
          };
          const name = `synthetic-close-${randomUUID()}`;
          const queue = new Queue(name, { connection });
          let worker = new Worker(name, async (job) => runCore(job.data.message_id), {
            connection,
          });
          try {
            const failed = new Promise<Error>((resolve) =>
              worker.once('failed', (_job, err) => resolve(err)),
            );
            const job = await queue.add(
              'agent',
              { message_id: f.host.representative_message_id },
              {
                jobId: f.execution.turn_id,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: false,
              },
            );
            expect((await failed).message).toBe('synthetic crash after reservation');
            await worker.close();
            failOnce.mockRestore();
            expect(await job.getState()).toBe('delayed');
            expect(
              (
                await pool.query(
                  'SELECT phase, next_poll_at > clock_timestamp() AS reserved FROM engine_runs WHERE id=$1',
                  [f.run_id],
                )
              ).rows[0],
            ).toMatchObject({ phase: 'result_ready', reserved: true });
            await runtime.shutdown();
            expect(
              (
                await pool.query('SELECT status FROM agent_turns WHERE id=$1', [
                  f.execution.turn_id,
                ])
              ).rows[0].status,
            ).toBe('completed');
            if (scenario === 'scanner_close' || scenario === 'scanner_unknown') {
              await pool.query("UPDATE engine_runs SET next_poll_at='1900-01-01' WHERE id=$1", [
                f.run_id,
              ]);
            }
            if (scenario === 'scanner_unknown') {
              await pool.query(
                `INSERT INTO engine_tool_calls(tenant_id,agent_id,turn_id,run_id,call_id,ordinal,tool_name,args_json,args_hash,request_id,state,effect_evidence,finished_at,result_json)
                VALUES($1,$2,$3,$4,'call-1',0,'synthetic_tool','{}',$5,$6,'effect_unknown','unknown',now(),'{}')`,
                [tenant_id, agent_id, f.execution.turn_id, f.run_id, 'a'.repeat(64), randomUUID()],
              );
            }
            worker = new Worker(
              name,
              async (retry) => {
                if (scenario === 'scanner_close' || scenario === 'scanner_unknown') {
                  const { JOBS } = await import('@/workers/index.js');
                  const tick = JOBS.find((j) => j.name === 'engine_recovery')!.fn as (opts: {
                    scopeLimit: number;
                    maxPages: number;
                  }) => Promise<void>;
                  if (scenario === 'scanner_close') {
                    // Older debt needs Redis; the already-delivered orphan behind
                    // it must close using PostgreSQL even while TCP blackholes.
                    const debt = await fixture();
                    await pool.query(
                      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
                      [debt.execution.turn_id],
                    );
                    await pool.query(
                      "UPDATE engine_runs SET phase='result_ready',terminal_json='{}',terminal_hash=$2,next_poll_at='1800-01-01' WHERE id=$1",
                      [debt.run_id, 'a'.repeat(64)],
                    );
                    const { recoveryRedisTransport } =
                      await import('../helpers/recovery-redis-transport.js');
                    const transport = await recoveryRedisTransport(process.env.REDIS_URL!);
                    const producerModule = await import('@/gateway/queue.js');
                    const realProducer = producerModule.enqueueAgentForRecovery;
                    const producer = vi
                      .spyOn(producerModule, 'enqueueAgentForRecovery')
                      .mockImplementation((data) =>
                        realProducer(data, { redisUrl: transport.url, timeoutMs: 150 }),
                      );
                    const { createEngineRecoveryRunner } =
                      await import('@/workers/engine-recovery.js');
                    const scheduler = await import('@/workers/index.js');
                    const recoveryJob = scheduler.JOBS.find((j) => j.name === 'engine_recovery')!;
                    const realQueue = (
                      await vi.importActual<typeof import('@/gateway/queue.js')>(
                        '@/gateway/queue.js',
                      )
                    ).agentQueue;
                    const { agentTurnJobId } = await import('@/runtime/turns/job.js');
                    const id = agentTurnJobId(debt.execution.turn_id);
                    try {
                      scheduler._internal.runTick({
                        ...recoveryJob,
                        fn: () =>
                          createEngineRecoveryRunner()({
                            scopeLimit: 1,
                            runLimit: 20,
                            maxPages: 1,
                          }),
                      });
                      expect(await scheduler.drainWorkers(2000)).toEqual({
                        drained: ['engine_recovery'],
                        pending: [],
                      });
                      await expect.poll(() => transport.sockets).toBe(0);
                      expect(transport.accepted).toBe(1);
                      expect(
                        (await pool.query('SELECT phase FROM engine_runs WHERE id=$1', [f.run_id]))
                          .rows[0].phase,
                      ).toBe('closed');
                      expect(
                        (
                          await pool.query(
                            'SELECT phase,closed_reason FROM engine_runs WHERE id=$1',
                            [debt.run_id],
                          )
                        ).rows[0],
                      ).toEqual({ phase: 'result_ready', closed_reason: null });
                      expect(await realQueue.getJob(id)).toBeUndefined();
                      transport.recover();
                      for (let attempt = 0; attempt < 2; attempt++) {
                        await pool.query(
                          "UPDATE engine_runs SET next_poll_at='1800-01-01' WHERE id=$1",
                          [debt.run_id],
                        );
                        await createEngineRecoveryRunner()({
                          scopeLimit: 1,
                          runLimit: 20,
                          maxPages: 1,
                        });
                      }
                      const queued = await realQueue.getJob(id);
                      expect(queued?.id).toBe(id);
                      expect(await queued?.getState()).toBe('waiting');
                      expect(
                        (await realQueue.getJobs(['waiting'])).filter((j) => j.id === id),
                      ).toHaveLength(1);
                      expect(
                        (
                          await pool.query('SELECT attempt_count FROM agent_turns WHERE id=$1', [
                            debt.execution.turn_id,
                          ])
                        ).rows[0].attempt_count,
                      ).toBe(1);
                    } finally {
                      producer.mockRestore();
                      await (await realQueue.getJob(id))?.remove();
                      await transport.close();
                      await pool.query(
                        "UPDATE engine_runs SET next_poll_at=now()+interval '100 years' WHERE id=$1",
                        [debt.run_id],
                      );
                    }
                  } else {
                    await tick({ scopeLimit: 1, maxPages: 1 });
                  }
                  return;
                }
                // Retry is still inside the reserved window; it must converge,
                // not acknowledge `not_due` and abandon the journal.
                expect(
                  (
                    await pool.query(
                      'SELECT next_poll_at > clock_timestamp() AS reserved FROM engine_runs WHERE id=$1',
                      [f.run_id],
                    )
                  ).rows[0].reserved,
                ).toBe(true);
                await runCore(retry.data.message_id);
              },
              { connection },
            );
            await expect
              .poll(() => job.getState(), { timeout: 10000, interval: 50 })
              .toBe('completed');
            expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
          } finally {
            failOnce.mockRestore();
            await worker.close();
            await queue.obliterate({ force: true }); // this UUID queue only
            await queue.close();
          }
        } else if (scenario === 'close_cas') {
          const close = engineRunsRepo.closeRunAfterHandoff.bind(engineRunsRepo);
          const conflict = vi
            .spyOn(engineRunsRepo, 'closeRunAfterHandoff')
            .mockImplementationOnce(async (input) => {
              // Real concurrent metadata writer advances the DB row version.
              const reservation = await engineRunsRepo.reserveMaintenanceObservation({
                run_id: input.run_id,
                window_ms: 5000,
                actor: { kind: 'recovery', actor_ref: 'concurrent_fixture' },
              });
              expect(reservation.ok).toBe(true);
              const result = await close(input);
              expect(result).toMatchObject({ ok: false, reason: 'version_conflict' });
              return result;
            });
          try {
            await expect(runCore(f.host.representative_message_id)).rejects.toThrow(
              'synthetic_handoff_pending:version_conflict',
            );
          } finally {
            conflict.mockRestore();
          }
          await runtime.shutdown();
          // Fresh proof/version and concurrent redelivery: one close event.
          await Promise.all([
            runCore(f.host.representative_message_id),
            runCore(f.host.representative_message_id),
          ]);
        } else {
          await runCore(f.host.representative_message_id);
        }
        if (scenario === 'scanner_unknown') {
          expect(
            (
              await pool.query('SELECT phase,closed_reason FROM engine_runs WHERE id=$1', [
                f.run_id,
              ])
            ).rows[0],
          ).toEqual({ phase: 'blocked', closed_reason: null });
          expect(channel.sent).toEqual(['synthetic response']);
          expect(stub.requests).toHaveLength(1);
          return;
        }
        if (scenario === 'outbound_unknown') {
          const before = (await pool.query('SELECT * FROM engine_runs WHERE id=$1', [f.run_id]))
            .rows[0];
          await runtime.shutdown();
          await runCore(f.host.representative_message_id);
          expect(channel.sent).toEqual(['synthetic response']);
          const artifacts = (
            await pool.query('SELECT status FROM outbound_messages WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows;
          expect(artifacts).toEqual([{ status: 'delivery_unknown' }]);
          expect(
            (await pool.query('SELECT * FROM engine_runs WHERE id=$1', [f.run_id])).rows[0],
          ).toMatchObject({
            phase: 'result_ready',
            closed_reason: null,
            terminal_hash: before.terminal_hash,
            request_json: before.request_json,
            output_preparation_json: before.output_preparation_json,
          });
          expect(
            (
              await pool.query(
                'SELECT status, lease_expires_at <= clock_timestamp() AS released FROM agent_turns WHERE id=$1',
                [f.execution.turn_id],
              )
            ).rows[0],
          ).toMatchObject({ status: 'outbound_pending', released: true });
          return;
        }
        if (scenario.startsWith('revoked_')) {
          expect(
            (
              await pool.query('SELECT status,outcome FROM agent_turns WHERE id=$1', [
                f.execution.turn_id,
              ])
            ).rows[0],
          ).toMatchObject({ status: 'dead_letter', outcome: 'unsafe_to_retry' });
          const revoked = (
            await pool.query(
              'SELECT capabilities_revoked_at::text, phase, closed_reason, request_json FROM engine_runs WHERE id=$1',
              [f.run_id],
            )
          ).rows[0];
          expect(revoked.capabilities_revoked_at).not.toBeNull();
          expect(revoked).toMatchObject({
            phase: 'result_ready',
            closed_reason: null,
            request_json: f.request,
          });
          expect(
            await scoped(() =>
              engineRunsRepo.revokeRunCapabilities({
                run_id: f.run_id,
                turn_id: f.execution.turn_id,
                actor: { kind: 'recovery', actor_ref: 'synthetic-repeat' },
                reason_code: 'synthetic_revocation',
              }),
            ),
          ).toMatchObject({ ok: true, already: true, revoked_at: revoked.capabilities_revoked_at });
          expect(
            (
              await pool.query('SELECT outbound_committed_at FROM agent_turns WHERE id=$1', [
                f.execution.turn_id,
              ])
            ).rows[0].outbound_committed_at,
          ).toBeNull();
          // Redelivery may reconcile/retry metadata, never another inference or send.
          channel.beforeResolve = null;
          await runtime.shutdown();
          await runCore(f.host.representative_message_id);
          expect(
            (
              await pool.query(
                'SELECT capabilities_revoked_at::text FROM engine_runs WHERE id=$1',
                [f.run_id],
              )
            ).rows[0].capabilities_revoked_at,
          ).toBe(revoked.capabilities_revoked_at);
        }
        if (
          scenario !== 'deliver' &&
          scenario !== 'close_crash' &&
          scenario !== 'scanner_close' &&
          scenario !== 'close_cas'
        ) {
          expect(channel.sent).toEqual([]);
          expect(
            (
              await pool.query('SELECT count(*)::int n FROM outbound_messages WHERE turn_id=$1', [
                f.execution.turn_id,
              ])
            ).rows[0].n,
          ).toBe(0);
          expect(
            (
              await pool.query(
                'SELECT count(*)::int n FROM engine_inference_attempts WHERE run_id=$1',
                [f.run_id],
              )
            ).rows[0].n,
          ).toBe(1);
          return;
        }
        expect(channel.sent).toEqual(['synthetic response']);
        const output = (
          await pool.query('SELECT * FROM outbound_messages WHERE turn_id=$1', [
            f.execution.turn_id,
          ])
        ).rows;
        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
          origin: 'bot',
          control_id: f.control_id,
          control_epoch: '0',
        });
        const run = (await pool.query('SELECT * FROM engine_runs WHERE id=$1', [f.run_id])).rows[0];
        expect(run.adopted_by_turn_attempt).toBe(2);
        expect(run.request_json).toEqual(f.request);
        expect(run.origin_claim_token).toBe(f.execution.claim_token);
        expect(run.output_preparation_json).not.toBeNull();
        expect(run.phase).toBe('closed');
        expect(run.closed_reason).toBe('handed_to_outbox');
        expect(output[0].status).toBe('completed');
        expect(
          (
            await pool.query('SELECT status,outcome FROM agent_turns WHERE id=$1', [
              f.execution.turn_id,
            ])
          ).rows[0],
        ).toMatchObject({ status: 'completed', outcome: 'reply_delivered' });
        const proof = (
          await pool.query(
            `SELECT metadata FROM audit_log WHERE alvo_id=$1 AND acao='outbound_committed'`,
            [output[0].id],
          )
        ).rows;
        expect(proof).toHaveLength(1);
        expect(proof[0].metadata).toMatchObject({
          engine_run_id: f.run_id,
          engine_terminal_hash: run.terminal_hash,
        });
        expect(
          (
            await pool.query('SELECT count(*)::int n FROM mensagens WHERE outbound_id=$1', [
              output[0].id,
            ])
          ).rows[0].n,
        ).toBe(1);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM engine_run_events WHERE run_id=$1 AND event_type='closed'",
              [f.run_id],
            )
          ).rows[0].n,
        ).toBe(1);
        await runCore(f.host.representative_message_id);
        expect(channel.sent).toEqual(['synthetic response']);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int n FROM engine_inference_attempts WHERE run_id=$1',
              [f.run_id],
            )
          ).rows[0].n,
        ).toBe(1);
        expect(
          (
            await pool.query('SELECT count(*)::int n FROM outbound_messages WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows[0].n,
        ).toBe(1);
      } finally {
        expect(stub.requests).toHaveLength(1);
        await runtime?.shutdown();
        await app.close();
        await stub.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000,
  );
});
