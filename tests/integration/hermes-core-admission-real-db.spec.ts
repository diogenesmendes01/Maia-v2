import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { createConfiguredHermesRuntime } from '@/runtime/engines/hermes-runtime.js';
import { registerHermesInferenceRoute } from '@/integrations/hermes/inference-route.js';
import { inferenceRepo } from '@/db/repositories/inference-repos.js';
import { createChatCompletionsRelay } from '@/lib/llm/providers/chat-completions-relay.js';
import { startStubProvider } from '../helpers/hermes-stub-provider.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';

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
vi.mock('../../src/gateway/queue.js', () => ({
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
const tenant_id = `core-admission-${randomUUID()}`;
const agent_id = `core-admission-${randomUUID()}`;
let pool: pg.Pool;
let runCore: typeof import('@/agent/core.js').runAgentForMensagem;
let promptProbe: ReturnType<typeof vi.spyOn>;
let pendingProbe: ReturnType<typeof vi.spyOn>;
const scoped = <T>(fn: () => Promise<T>) => runWithTenantContext({ tenant_id, agent_id }, fn);
async function fixture() {
  const turn_id = randomUUID();
  const message = randomUUID();
  const control_id = randomUUID();
  const channel_id = randomUUID();
  const host = {
    pessoa_id: randomUUID(),
    conversa_id: randomUUID(),
    channel_id,
    representative_message_id: message,
    stream_key: `v1:${canonicalDigest({ fixture_stream: control_id })}`,
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
    VALUES($1,$2,$3,$4,'queued',NULL,0,NULL,NULL)`,
    [turn_id, tenant_id, agent_id, message],
  );
  await pool.query(
    `UPDATE mensagens SET stream_key=$2,stream_key_version=1,ingress_seq=1 WHERE id=$1`,
    [message, host.stream_key],
  );
  await pool.query(`UPDATE agent_turns SET stream_key=$2,stream_key_version=1 WHERE id=$1`, [
    turn_id,
    host.stream_key,
  ]);
  return { host, execution: { turn_id }, control_id };
}

d('SYNTHETIC core admission: real DB + AIAgent pin, STUB provider, FAKE channel', () => {
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
    'concurrent',
    'pause_admission',
    'non_synthetic',
    'pause',
    'lease_expired',
    'prepare_error',
    'prepared_error',
    'submitting_error',
    'readback_error',
    'empty_jid',
    'long_jid',
  ])(
    'core new message admission: %s',
    async (scenario) => {
      channel.sent = [];
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
        const f = await fixture();
        await pool.query(
          `INSERT INTO agent_canary_policy(tenant_id,agent_id,stage,updated_by) VALUES($1,$2,'synthetic','test-harness') ON CONFLICT(tenant_id,agent_id) DO UPDATE SET stage='synthetic'`,
          [tenant_id, agent_id],
        );
        await pool.query('UPDATE channels SET is_synthetic=true WHERE id=$1', [f.host.channel_id]);
        await pool.query(
          `INSERT INTO agent_engine_policies(tenant_id,agent_id,channel_id,engine,updated_by) VALUES($1,$2,$3,'hermes','test-harness')`,
          [tenant_id, agent_id, f.host.channel_id],
        );
        await scoped(() =>
          inferenceRepo.openBudgetAccount({
            period_start_utc: new Date().toISOString().slice(0, 10),
            limit_microusd: '1000000',
          }),
        );
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
        expect(
          (await pool.query('SELECT id FROM engine_runs WHERE turn_id=$1', [f.execution.turn_id]))
            .rows,
        ).toHaveLength(0);
        expect(
          (
            await pool.query('SELECT turn_id FROM engine_turn_bindings WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows,
        ).toHaveLength(0);
        if (scenario === 'pause_admission') {
          await pool.query(
            `INSERT INTO conversation_controls(id,tenant_id,agent_id,stream_key,stream_key_version,channel_id,conversa_id,pessoa_id,mode,control_epoch,owner_app_user_id,paused_at)
            VALUES($1,$2,$3,$4,1,$5,$6,$7,'pausing',1,'synthetic-operator',now())`,
            [
              f.control_id,
              tenant_id,
              agent_id,
              f.host.stream_key,
              f.host.channel_id,
              f.host.conversa_id,
              f.host.pessoa_id,
            ],
          );
        }
        if (scenario === 'non_synthetic')
          await pool.query('UPDATE channels SET is_synthetic=false WHERE id=$1', [
            f.host.channel_id,
          ]);
        if (scenario === 'empty_jid' || scenario === 'long_jid') {
          await pool.query(
            `UPDATE mensagens SET metadata=metadata || jsonb_build_object('remote_jid',$2::text) WHERE id=$1`,
            [f.host.representative_message_id, scenario === 'empty_jid' ? '' : 'x'.repeat(257)],
          );
        }
        channel.beforeResolve = async () => {
          if (scenario === 'pause')
            await pool.query(
              `UPDATE conversation_controls SET mode='pausing',control_epoch=control_epoch+1,owner_app_user_id='synthetic-operator',paused_at=now() WHERE tenant_id=$1 AND agent_id=$2 AND stream_key=$3`,
              [tenant_id, agent_id, f.host.stream_key],
            );
          if (scenario === 'lease_expired')
            await pool.query(
              `UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
              [f.execution.turn_id],
            );
        };
        const invoke = () =>
          runtime.withSyntheticCore(() => runCore(f.host.representative_message_id));
        if (scenario.endsWith('_error')) {
          const admission = await import('@/db/repositories/hermes-admission-repo.js');
          const { engineRunsRepo } = await import('@/db/repositories/engine-repos.js');
          const { TurnLease } = await import('@/runtime/turns/lease.js');
          const release = vi.spyOn(TurnLease.prototype, 'release');
          const context = vi.spyOn(TurnLease.prototype, 'context');
          const error = new Error('injected lifecycle failure');
          const findState = engineRunsRepo.findTurnEngineState.bind(engineRunsRepo);
          const fault =
            scenario === 'prepare_error'
              ? vi.spyOn(admission, 'prepareSyntheticHermesAdmission').mockRejectedValueOnce(error)
              : scenario === 'prepared_error'
                ? vi.spyOn(engineRunsRepo, 'markSubmitting').mockRejectedValueOnce(error)
                : scenario === 'submitting_error'
                  ? vi.spyOn(runtime.engine, 'start').mockRejectedValueOnce(error)
                  : vi
                      .spyOn(engineRunsRepo, 'findTurnEngineState')
                      .mockImplementationOnce(findState)
                      .mockImplementationOnce(async () => {
                        await expect
                          .poll(
                            async () =>
                              (
                                await pool.query('SELECT phase FROM engine_runs WHERE turn_id=$1', [
                                  f.execution.turn_id,
                                ])
                              ).rows[0].phase,
                            { timeout: 60000, interval: 100 },
                          )
                          .toBe('result_ready');
                        throw error;
                      });
          try {
            await expect(invoke()).rejects.toThrow('injected lifecycle failure');
            expect(release).toHaveBeenCalledTimes(1);
            expect(context.mock.instances[0].alive).toBe(false);
            expect(context.mock.instances[0].signal.aborted).toBe(true);
            expect(
              (
                await pool.query(
                  'SELECT lease_expires_at <= clock_timestamp() AS released FROM agent_turns WHERE id=$1',
                  [f.execution.turn_id],
                )
              ).rows[0].released,
            ).toBe(true);
          } finally {
            fault.mockRestore();
            for (const lease of context.mock.instances) lease.stop();
            context.mockRestore();
            release.mockRestore();
          }
          expect(channel.sent).toEqual([]);
          if (scenario === 'prepared_error' || scenario === 'submitting_error') {
            const before = (
              await pool.query('SELECT * FROM engine_runs WHERE turn_id=$1', [f.execution.turn_id])
            ).rows;
            expect(before).toHaveLength(1);
            expect(before[0].phase).toBe(scenario === 'prepared_error' ? 'prepared' : 'submitting');
            const startProbe = vi.spyOn(runtime.engine, 'start');
            await invoke(); // released claim can be recovered, journal prevents new start
            expect(startProbe).not.toHaveBeenCalled();
            startProbe.mockRestore();
            const after = (
              await pool.query('SELECT * FROM engine_runs WHERE turn_id=$1', [f.execution.turn_id])
            ).rows;
            expect(after).toHaveLength(1);
            expect(after[0]).toMatchObject({
              id: before[0].id,
              phase: before[0].phase,
              request_json: before[0].request_json,
              request_key: before[0].request_key,
              submit_count: before[0].submit_count,
              closed_reason: null,
            });
            expect(stub.requests).toHaveLength(0);
            expect(channel.sent).toEqual([]);
            expect((await scoped(() => findState({ turn_id: f.execution.turn_id }))).kind).toBe(
              'open_run',
            );
            return;
          }
          if (scenario === 'readback_error') await runtime.shutdown();
        }
        if (scenario === 'concurrent') await Promise.all([invoke(), invoke()]);
        else await invoke();
        if (
          scenario === 'pause_admission' ||
          scenario === 'non_synthetic' ||
          scenario === 'empty_jid' ||
          scenario === 'long_jid'
        ) {
          expect(channel.sent).toEqual([]);
          expect(stub.requests).toHaveLength(0);
          expect(
            (await pool.query('SELECT id FROM engine_runs WHERE turn_id=$1', [f.execution.turn_id]))
              .rows,
          ).toHaveLength(0);
          expect(
            (
              await pool.query('SELECT turn_id FROM engine_turn_bindings WHERE turn_id=$1', [
                f.execution.turn_id,
              ])
            ).rows,
          ).toHaveLength(0);
          if (scenario === 'non_synthetic') {
            expect(
              (
                await pool.query(
                  "SELECT id FROM audit_log WHERE alvo_id=$1 AND acao='hermes_admission_refused'",
                  [f.execution.turn_id],
                )
              ).rows,
            ).toHaveLength(1);
          }
          await invoke();
          expect(stub.requests).toHaveLength(0);
          return;
        }
        if (scenario === 'pause' || scenario === 'lease_expired') {
          expect(channel.sent).toEqual([]);
          expect(stub.requests).toHaveLength(1);
          expect(
            (
              await pool.query('SELECT * FROM outbound_messages WHERE turn_id=$1', [
                f.execution.turn_id,
              ])
            ).rows,
          ).toHaveLength(0);
          await invoke();
          expect(stub.requests).toHaveLength(1);
          expect(channel.sent).toEqual([]);
          return;
        }
        expect(channel.sent).toEqual(['synthetic response']);
        const runs = (
          await pool.query('SELECT * FROM engine_runs WHERE turn_id=$1', [f.execution.turn_id])
        ).rows;
        expect(runs).toHaveLength(1);
        const run = runs[0];
        expect(run).toMatchObject({
          phase: 'closed',
          closed_reason: 'handed_to_outbox',
          submit_count: 1,
          origin_turn_attempt: scenario === 'prepare_error' ? 2 : 1,
          adopted_by_turn_attempt:
            scenario === 'prepare_error' || scenario === 'readback_error' ? 2 : 1,
        });
        expect(
          (
            await pool.query('SELECT * FROM engine_turn_bindings WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows,
        ).toHaveLength(1);
        expect(
          (
            await pool.query(
              "SELECT * FROM audit_log WHERE alvo_id=$1 AND acao='hermes_manifest_persisted'",
              [run.id],
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          (
            await pool.query(
              "SELECT * FROM audit_log WHERE alvo_id=$1 AND acao='conversation_control_created'",
              [run.control_id],
            )
          ).rows,
        ).toHaveLength(1);
        expect(run.request_json.context.messages).toEqual([{ role: 'user', content: 'synthetic' }]);
        const saved = JSON.stringify(run.request_json);
        for (const table of [
          'engine_inference_grants',
          'engine_inference_attempts',
          'hermes_runtime_manifests',
        ]) {
          expect(
            (await pool.query(`SELECT * FROM ${table} WHERE run_id=$1`, [run.id])).rows,
          ).toHaveLength(1);
        }
        expect(
          (
            await pool.query('SELECT * FROM outbound_messages WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows,
        ).toHaveLength(1);
        await runtime.withSyntheticCore(() => runCore(f.host.representative_message_id));
        expect(channel.sent).toEqual(['synthetic response']);
        expect(
          JSON.stringify(
            (await pool.query('SELECT request_json FROM engine_runs WHERE id=$1', [run.id])).rows[0]
              .request_json,
          ),
        ).toBe(saved);
        expect(stub.requests).toHaveLength(1);
        expect(stub.requests[0]?.toolNames).toEqual([]);
        const { getSyntheticCoreRuntime } =
          await import('@/runtime/engines/synthetic-core-context.js');
        expect(getSyntheticCoreRuntime()).toBeUndefined();
      } finally {
        await runtime?.shutdown();
        await app.close();
        await stub.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000,
  );
});
