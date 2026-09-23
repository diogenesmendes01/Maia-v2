import * as manifestsRepo from '@/db/repositories/hermes-manifest-repo.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import type { EngineRequestV1, HostContextSnapshotV1 } from '@/runtime/engines/contracts.js';
import type { TurnExecutionContext } from '@/runtime/turns/claim.js';
import { ensureHermesConversationControl } from '@/db/repositories/hermes-control-producer.js';
import { loadHermesLaunchContext } from '@/db/repositories/hermes-launch-repo.js';
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

const enabled = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = enabled ? describe : describe.skip;
const tenant_id = `launch-${randomUUID()}`;
const agent_id = `launch-${randomUUID()}`;
let pool: pg.Pool;
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

d('Hermes launch context — real PostgreSQL', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 2 });
    await pool.query('INSERT INTO tenants(id,nome) VALUES($1,$1)', [tenant_id]);
    await pool.query('INSERT INTO agents(id,tenant_id,nome) VALUES($1,$2,$1)', [
      agent_id,
      tenant_id,
    ]);
  });
  afterAll(async () => {
    await pool?.end();
  });
  it('persists a synthetic manifest once with scoped readback and audit', async () => {
    const manifests = new Map<string, RuntimeManifestV1>();
    const f = await fixture({
      pin: {
        engine: 'hermes',
        adapter_revision: 'test',
        configuration_digest: canonicalDigest({ synthetic: true }),
        protocol_version: 1,
      },
      remote: 'synthetic',
      manifests,
    });
    await pool.query(
      `INSERT INTO agent_canary_policy(tenant_id,agent_id,stage,updated_by) VALUES($1,$2,'synthetic','test-harness') ON CONFLICT(tenant_id,agent_id) DO UPDATE SET stage='synthetic'`,
      [tenant_id, agent_id],
    );
    await pool.query('UPDATE channels SET is_synthetic=true WHERE id=$1', [f.host.channel_id]);
    const [digest, manifest] = [...manifests.entries()][0]!;
    expect(
      await scoped(() =>
        manifestsRepo.persistSyntheticHermesManifest(manifest, {
          ...f.execution,
          claim_token: randomUUID(),
        }),
      ),
    ).toEqual({ kind: 'refused' });
    expect(
      await scoped(() =>
        manifestsRepo.persistSyntheticHermesManifest(
          { ...manifest, policy_revision: 'changed' },
          f.execution,
        ),
      ),
    ).toEqual({ kind: 'refused' });
    const results = await Promise.all(
      [0, 1].map(() =>
        scoped(() => manifestsRepo.persistSyntheticHermesManifest(manifest, f.execution)),
      ),
    );
    expect(results).toEqual([
      { kind: 'stored', digest },
      { kind: 'stored', digest },
    ]);
    expect(await scoped(() => manifestsRepo.loadSyntheticHermesManifest(digest))).toEqual(manifest);
    expect(
      await runWithTenantContext({ tenant_id, agent_id: 'other' }, () =>
        manifestsRepo.loadSyntheticHermesManifest(digest),
      ),
    ).toBeNull();
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND agent_id=$2 AND acao='hermes_manifest_persisted' AND alvo_id=$3`,
      [tenant_id, agent_id, f.run_id],
    );
    expect(audit.rows[0].n).toBe(1);
    await expect(
      pool.query(`UPDATE hermes_runtime_manifests SET manifest_json='{}'::jsonb WHERE run_id=$1`, [
        f.run_id,
      ]),
    ).rejects.toThrow('immutable');
    await pool.query(
      `UPDATE agent_canary_policy SET stage='off' WHERE tenant_id=$1 AND agent_id=$2`,
      [tenant_id, agent_id],
    );
    expect(await scoped(() => manifestsRepo.loadSyntheticHermesManifest(digest))).toBeNull();
    expect(
      await scoped(() => manifestsRepo.persistSyntheticHermesManifest(manifest, f.execution)),
    ).toEqual({ kind: 'refused' });
    await pool.query(
      `UPDATE agent_canary_policy SET stage='synthetic' WHERE tenant_id=$1 AND agent_id=$2`,
      [tenant_id, agent_id],
    );
    await pool.query('UPDATE channels SET is_synthetic=false WHERE id=$1', [f.host.channel_id]);
    expect(await scoped(() => manifestsRepo.loadSyntheticHermesManifest(digest))).toBeNull();
    expect(
      await scoped(() => manifestsRepo.persistSyntheticHermesManifest(manifest, f.execution)),
    ).toEqual({ kind: 'refused' });
  });
  it.skipIf(!process.env.HERMES_PIN_PYTHON || !process.env.HERMES_PIN_UPSTREAM)(
    'prepared run → real AIAgent → real inference ledger → terminal (provider STUB)',
    async () => {
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
        const stale = await fixture({
          pin: runtime.pin,
          remote: 'hermes-supervisor:old',
          manifests,
        });
        expect(
          await scoped(() =>
            runWithTurnExecution(stale.execution, () => runtime.startPrepared(stale.run_id)),
          ),
        ).toEqual({
          kind: 'rejected',
          definitely_not_accepted: true,
          code: 'supervisor_incarnation_mismatch',
        });
        expect(
          (await pool.query('SELECT phase FROM engine_runs WHERE id=$1', [stale.run_id])).rows[0]
            .phase,
        ).toBe('prepared');
        manifests.clear();
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
        manifests.clear(); // launch MUST reload from PostgreSQL, not fixture memory.
        await scoped(() =>
          inferenceRepo.openBudgetAccount({
            period_start_utc: new Date().toISOString().slice(0, 10),
            limit_microusd: '1000000',
          }),
        );
        const starts = await Promise.all(
          [0, 1].map(() =>
            scoped(() => runWithTurnExecution(f.execution, () => runtime.startPrepared(f.run_id))),
          ),
        );
        expect(starts.filter((s) => s.kind === 'accepted')).toHaveLength(1);
        expect(starts.filter((s) => s.kind === 'unknown')).toHaveLength(1);
        await expect
          .poll(
            async () =>
              (await pool.query('SELECT phase FROM engine_runs WHERE id=$1', [f.run_id])).rows[0]
                ?.phase,
            { timeout: 60000, interval: 100 },
          )
          .toBe('result_ready');
        const result = (
          await pool.query(
            'SELECT terminal_json,request_json,host_context_json FROM engine_runs WHERE id=$1',
            [f.run_id],
          )
        ).rows[0];
        expect(result.terminal_json.stop).toEqual({
          kind: 'reply',
          raw_text: 'synthetic response',
        });
        expect(result.request_json).toEqual(f.request);
        const grants = (
          await pool.query('SELECT token_hash,model FROM engine_inference_grants WHERE run_id=$1', [
            f.run_id,
          ])
        ).rows;
        expect(grants).toHaveLength(1);
        expect(grants[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(result)).not.toContain('mhi1_');
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS n FROM engine_inference_attempts WHERE run_id=$1',
              [f.run_id],
            )
          ).rows[0].n,
        ).toBe(1);
        expect(
          (
            await pool.query('SELECT count(*)::int AS n FROM outbound_messages WHERE turn_id=$1', [
              f.execution.turn_id,
            ])
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await runtime?.shutdown();
        await app.close();
        await stub.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
    90000,
  );
  it('refuses a persisted snapshot after its conversation changes to another real subject', async () => {
    const a = await fixture();
    const b = await fixture();
    await pool.query('UPDATE conversas SET pessoa_id=$1 WHERE id=$2', [
      b.host.pessoa_id,
      a.host.conversa_id,
    ]);
    expect(await scoped(() => loadHermesLaunchContext(a.run_id, a.execution))).toBeNull();
  });
  it('loads the exact persisted request and host only for the live origin owner', async () => {
    const f = await fixture();
    const got = await scoped(() => loadHermesLaunchContext(f.run_id, f.execution));
    expect(got?.request).toEqual(f.request);
    expect(got?.host).toEqual(f.host);
    expect(got?.phase).toBe('prepared');
    expect(
      await scoped(() =>
        loadHermesLaunchContext(f.run_id, { ...f.execution, claim_token: randomUUID() }),
      ),
    ).toBeNull();
    expect(
      await runWithTenantContext({ tenant_id, agent_id: 'another-agent' }, () =>
        loadHermesLaunchContext(f.run_id, f.execution),
      ),
    ).toBeNull();
    await pool.query('UPDATE conversation_controls SET control_epoch=control_epoch+1 WHERE id=$1', [
      f.control_id,
    ]);
    expect(await scoped(() => loadHermesLaunchContext(f.run_id, f.execution))).toBeNull();
  });
});
