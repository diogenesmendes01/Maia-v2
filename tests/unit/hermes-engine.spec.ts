/**
 * P07 — `HermesEngine` atrás de `AgentEnginePortV1`.
 *
 * `planWorkerStart` é puro: cada recusa é uma divergência entre fontes que
 * deveriam concordar (pedido, binding, manifest, pin). O motor inteiro roda
 * com o supervisor REAL e o worker falso em Node: o turno atravessa a porta,
 * a tool chega ao `invokeTool` com a identidade derivada pela Maia, e o
 * terminal é gravado pelo journal com o binding do resolvedor antes do ACK.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDigest } from '@/integrations/hermes/canonical-json.js';
import {
  RUNTIME_MANIFEST_SCHEMA,
  computeManifestDigest,
  parseRuntimeManifest,
  type RuntimeManifestV1,
} from '@/integrations/hermes/manifest.js';
import { parseMaiaFrame, serializeFrame, type ResultFrame } from '@/integrations/hermes/protocol.js';
import { parseRunBinding, type RunBindingV1 } from '@/integrations/hermes/run-binding.js';
import {
  createHermesSupervisor,
  type HermesSupervisorV1,
} from '@/integrations/hermes/supervisor.js';
import { computeToolSchemaDigest } from '@/integrations/hermes/tool-schema-digest.js';
import type {
  EngineIOV1,
  EngineRequestV1,
  EngineToolCallV1,
  EngineToolReplyV1,
} from '@/runtime/engines/contracts.js';
import {
  createHermesEngine,
  planWorkerStart,
  proposalFromResultFrame,
  type HermesJournalPortV1,
  type HermesRunContextV1,
} from '@/runtime/engines/hermes-engine.js';

const REPO = resolve(process.cwd());
const FAKE = join(REPO, 'tests', 'fixtures', 'hermes-fake-worker.mjs');
const SHA = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
const HEX64 = 'a'.repeat(64);
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'maia-hermes-eng-'));
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const ECHO_SCHEMA = {
  type: 'object',
  properties: { texto: { type: 'string' } },
  required: ['texto'],
  additionalProperties: false,
};

const inHour = () => new Date(Date.now() + 3_600_000).toISOString();

function manifestFor(run_id: string, over: Partial<RuntimeManifestV1> = {}): RuntimeManifestV1 {
  const raw = {
    schema: RUNTIME_MANIFEST_SCHEMA,
    run_id,
    policy_revision: 'rev-1',
    mode: 'live',
    bundle_digest: HEX64,
    context_digest: HEX64,
    control_epoch: '7',
    exposure_epoch: '1',
    runtime_pin: {
      hermes_sha: SHA,
      adapter_revision: 'hermes-engine-0.1.0',
      image_digest: HEX64,
      dependency_lock_digest: HEX64,
    },
    tools: [
      {
        name: 'fixture_echo',
        maia_tool_name: 'fixture_echo',
        input_schema: ECHO_SCHEMA,
        output_schema: { type: 'object', additionalProperties: false, properties: {} },
        input_schema_hash: HEX64,
        output_schema_hash: HEX64,
        implementation_version: '1.0.0',
        side_effect: 'read',
        effect_class: 'abort_safe',
        required_actions: [],
        authorization_target: 'current_turn',
        output_projection_id: 'echo_v1',
        audit_action: 'memory_recalled',
        limits: { max_calls: 4, result_limit_chars: 4096, timeout_ms: 5_000 },
        approval_mode: 'none',
      },
    ],
    limits: {
      deadline_at: inHour(),
      max_tool_calls: 8,
      max_inference_calls: 12,
      max_context_tokens: 100_000,
      max_output_tokens: 1_024,
      max_payload_bytes: 262_144,
      max_json_depth: 32,
      budget: { amount_microusd: '250000', unit: 'microusd' },
    },
    data_policy: { ref: 'dp', version: '1' },
    publication_refs: [],
    retention_policy_ref: 'ret',
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
    ...over,
  };
  const parsed = parseRuntimeManifest(raw);
  if (parsed.kind !== 'ok') throw new Error(`fixture de manifest inválida: ${parsed.code}`);
  return parsed.manifest;
}

function bindingFor(manifest: RuntimeManifestV1, over: Partial<RunBindingV1> = {}): RunBindingV1 {
  const run_id = manifest.run_id;
  const parsed = parseRunBinding({
    version: 1,
    run_id,
    execution_id: run_id,
    task_id: `task-${run_id}`,
    initial_session_id: `sess-${run_id}`,
    tenant_id: 'tenant-a',
    agent_id: 'agent-a',
    pessoa_id: randomUUID(),
    conversa_id: randomUUID(),
    mensagem_id: randomUUID(),
    turn_id: randomUUID(),
    turn_attempt: 1,
    origin_claim_token: randomUUID(),
    control_id: randomUUID(),
    control_epoch: '7',
    mode: 'live',
    manifest_digest: computeManifestDigest(manifest),
    context_digest: HEX64,
    bundle_digest: HEX64,
    deadline_at: inHour(),
    acl: { pessoa_ids: [], conversa_ids: [], entidade_ids: [] },
    ...over,
  });
  if (parsed.kind !== 'ok') throw new Error(`fixture de binding inválida: ${parsed.code}`);
  return parsed.binding;
}

function requestFor(run_id: string, over: Partial<EngineRequestV1> = {}): EngineRequestV1 {
  return {
    version: 1,
    run_id,
    request_key: randomUUID(),
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: {
      system: 'Atendente de teste.',
      messages: [
        { role: 'user', content: 'bom dia' },
        { role: 'assistant', content: 'olá' },
        { role: 'user', content: '<user_message>oi</user_message>' },
      ],
      tools: [{ name: 'fixture_echo', description: 'eco', input_schema: ECHO_SCHEMA }],
    },
    limits: {
      max_iterations: 3,
      max_output_tokens_per_call: 512,
      max_tool_calls: 4,
      deadline_at: inHour(),
      max_cost_microusd: '100000',
    },
    ...over,
  };
}

function contextFor(
  request: EngineRequestV1,
  over: Partial<HermesRunContextV1> = {},
  manifestOver: Partial<RuntimeManifestV1> = {},
): HermesRunContextV1 {
  const manifest = manifestFor(request.run_id, manifestOver);
  return {
    binding: bindingFor(manifest),
    manifest,
    inference: {
      base_url: 'http://127.0.0.1:9/internal/hermes-inference/v1',
      model: 'stub',
      provider: 'openai',
    },
    inference_credential: 'credencial-curta',
    leaseHorizonMs: () => Date.now() + 60_000,
    revalidate: async () => true,
    ...over,
  };
}

describe('planWorkerStart — o start só sai se as fontes concordam', () => {
  it('monta um start válido no wire, sem tenant nem claim no binding do filho', () => {
    const request = requestFor(randomUUID());
    const context = contextFor(request);
    const plan = planWorkerStart({ request, context, hermes_sha: SHA, now_ms: Date.now() });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(parseMaiaFrame(serializeFrame(plan.start)).kind).toBe('ok');
    expect(Object.keys(plan.start.binding).sort()).toEqual(
      ['execution_id', 'initial_session_id', 'manifest_digest', 'mode', 'task_id'].sort(),
    );
    const bytes = JSON.stringify(plan.start);
    expect(bytes).not.toContain(context.binding.origin_claim_token);
    expect(bytes).not.toContain('tenant-a');
    expect(bytes).not.toContain('credencial-curta');
    expect(plan.start.context).toEqual({
      system: 'Atendente de teste.',
      user_message: '<user_message>oi</user_message>',
      history: [
        { role: 'user', text: 'bom dia' },
        { role: 'assistant', text: 'olá' },
      ],
    });
    expect(plan.start.manifest.tools).toEqual([
      { name: 'fixture_echo', input_schema: ECHO_SCHEMA, result_limit_chars: 4096 },
    ]);
  });

  it('limites e prazo: sempre o MENOR entre as fontes', () => {
    const request = requestFor(randomUUID(), {
      limits: {
        max_iterations: 3,
        max_output_tokens_per_call: 4_000,
        max_tool_calls: 20,
        deadline_at: new Date(Date.now() + 30_000).toISOString(),
        max_cost_microusd: '1',
      },
    });
    const plan = planWorkerStart({
      request,
      context: contextFor(request),
      hermes_sha: SHA,
      now_ms: Date.now(),
    });
    if (plan.kind !== 'ok') throw new Error(plan.code);
    expect(plan.start.limits.max_output_tokens_per_call).toBe(1_024);
    expect(plan.max_tool_calls).toBe(8);
    expect(plan.start.limits.deadline_at).toBe(request.limits.deadline_at);
    expect(plan.execution_deadline_ms).toBe(Date.parse(request.limits.deadline_at));
    expect(plan.start.limits.run_budget_seconds).toBeLessThanOrEqual(30);
  });

  it('manifest com zero tool calls: teto real 0, nenhuma tool exposta, wire 1', () => {
    const request = requestFor(randomUUID());
    const context = contextFor(request, {}, {});
    const manifest = manifestFor(request.run_id, {
      limits: { ...context.manifest.limits, max_tool_calls: 0 },
    });
    const plan = planWorkerStart({
      request,
      context: { ...context, manifest, binding: bindingFor(manifest) },
      hermes_sha: SHA,
      now_ms: Date.now(),
    });
    if (plan.kind !== 'ok') throw new Error(plan.code);
    expect(plan.max_tool_calls).toBe(0);
    expect(plan.start.limits.max_tool_calls).toBe(1);
    expect(plan.start.manifest.tools).toEqual([]);
  });

  const cases: Array<[string, (r: EngineRequestV1, c: HermesRunContextV1) => [EngineRequestV1, HermesRunContextV1]]> = [
    ['binding_invalid', (r, c) => [r, { ...c, binding: { ...c.binding, execution_id: randomUUID() } }]],
    ['binding_mismatch', (r, c) => [{ ...r, run_id: randomUUID() }, c]],
    ['manifest_invalid', (r, c) => [r, { ...c, manifest: { ...c.manifest, tools: 'x' } as never }]],
    [
      'manifest_mismatch',
      (r, c) => [r, { ...c, binding: { ...c.binding, manifest_digest: 'f'.repeat(64) } }],
    ],
    ['manifest_mismatch', (r, c) => [r, { ...c, binding: { ...c.binding, control_epoch: '8' } }]],
    [
      'hermes_pin_mismatch',
      (r, c) => {
        const manifest = manifestFor(r.run_id, {
          runtime_pin: { ...c.manifest.runtime_pin, hermes_sha: '1'.repeat(40) },
        });
        return [r, { ...c, manifest, binding: bindingFor(manifest) }];
      },
    ],
    [
      'surface_mismatch',
      (r, c) => [
        {
          ...r,
          context: {
            ...r.context,
            tools: [...r.context.tools, { name: 'terminal', description: '', input_schema: {} }],
          },
        },
        c,
      ],
    ],
    ['surface_mismatch', (r, c) => [{ ...r, context: { ...r.context, tools: [] } }, c]],
    [
      'surface_mismatch',
      (r, c) => [
        {
          ...r,
          context: {
            ...r.context,
            tools: [{ name: 'fixture_echo', description: 'eco', input_schema: { type: 'object' } }],
          },
        },
        c,
      ],
    ],
    [
      'context_unsupported',
      (r, c) => [
        {
          ...r,
          context: {
            ...r.context,
            messages: [
              {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }],
              },
              { role: 'user', content: 'oi' },
            ] as EngineRequestV1['context']['messages'],
          },
        },
        c,
      ],
    ],
    [
      'deadline_exceeded',
      (r, c) => [{ ...r, limits: { ...r.limits, deadline_at: new Date(Date.now() - 1).toISOString() } }, c],
    ],
    [
      'inference_not_allowed',
      (r, c) => {
        const manifest = manifestFor(r.run_id, {
          limits: { ...c.manifest.limits, max_inference_calls: 0 },
        });
        return [r, { ...c, manifest, binding: bindingFor(manifest) }];
      },
    ],
  ];

  it.each(cases)('recusa %s', (code, mutate) => {
    const r0 = requestFor(randomUUID());
    const [request, context] = mutate(r0, contextFor(r0));
    expect(planWorkerStart({ request, context, hermes_sha: SHA, now_ms: Date.now() })).toEqual({
      kind: 'refused',
      code,
    });
  });
});

describe('proposalFromResultFrame', () => {
  const run_id = randomUUID();
  const frame: ResultFrame = {
    protocol: 'maia.hermes.worker.v1',
    type: 'result',
    run_id,
    request_key: randomUUID(),
    stop: { kind: 'reply', raw_text: 'oi' },
    iterations: 2,
    observed_tool_call_seqs: [0, 1],
    usage: { input_tokens: 1, output_tokens: 1, cost_microusd: null, source: 'engine_reported' },
    observed: {
      model: null,
      provider: null,
      final_session_id: null,
      turn_exit_reason: null,
      failure_code: null,
    },
  };

  it('tira da lista os seqs que o supervisor recusou sem broker', () => {
    expect(
      proposalFromResultFrame(frame, { locally_refused_call_seqs: [1] })?.observed_tool_call_ids,
    ).toEqual([`${run_id}:0`]);
  });

  it('deriva os call_ids da Maia a partir do call_seq', () => {
    expect(proposalFromResultFrame(frame)?.observed_tool_call_ids).toEqual([
      `${run_id}:0`,
      `${run_id}:1`,
    ]);
  });

  it('call_seq repetido não vira proposta', () => {
    expect(proposalFromResultFrame({ ...frame, observed_tool_call_seqs: [0, 0] })).toBeNull();
  });
});

// ─── o motor com processo real ──────────────────────────────────────────────

const supervisors: HermesSupervisorV1[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.shutdown();
});

function supervisor(scenario: string): HermesSupervisorV1 {
  const sup = createHermesSupervisor({
    python_executable: process.execPath,
    worker_args: [
      FAKE,
      scenario,
      computeToolSchemaDigest([
        { name: 'fixture_echo', input_schema: ECHO_SCHEMA, result_limit_chars: 4096 },
      ]),
    ],
    worker_cwd: REPO,
    python_path: [],
    hermes_sha: SHA,
    expected_bridge_revision: null,
    platform_env: Object.fromEntries(
      ['SystemRoot', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR']
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k] as string]),
    ),
    home_root: HOME_ROOT,
    ready_timeout_ms: 5_000,
    cancel_grace_ms: 300,
    exit_wait_ms: 5_000,
    post_result_exit_ms: 5_000,
    hook_timeout_ms: 1_000,
    watchdog_interval_ms: 50,
    session_retention_ms: 60_000,
  });
  supervisors.push(sup);
  return sup;
}

function journal(over: Partial<HermesJournalPortV1> = {}) {
  return {
    recordTerminal: vi.fn(async () => ({ ok: true as const })),
    revokeCapabilities: vi.fn(async () => undefined),
    ...over,
  } satisfies HermesJournalPortV1;
}

function io(
  invoke: (c: EngineToolCallV1) => Promise<EngineToolReplyV1> = async (c) => ({
    kind: 'result',
    call_id: c.call_id,
    result: { ok: true },
    is_error: false,
  }),
): EngineIOV1 & { invokeTool: ReturnType<typeof vi.fn> } {
  return { signal: new AbortController().signal, invokeTool: vi.fn(invoke) };
}

const locator = (request: EngineRequestV1, remote_run_id: string | null) => ({
  run_id: request.run_id,
  request_key: request.request_key,
  remote_instance_id: 'x',
  remote_run_id,
});

describe('HermesEngine — turno pela porta, com processo real', () => {
  it('start aceito, tool com identidade da Maia, terminal gravado pelo journal com o binding', async () => {
    const sup = supervisor('happy');
    const j = journal();
    const request = requestFor(randomUUID());
    const context = contextFor(request);
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => context,
      journal: j,
    });
    expect(engine.pin.engine).toBe('hermes');
    const i = io();
    const start = await engine.start(request, i);
    expect(start.kind).toBe('accepted');
    if (start.kind !== 'accepted') return;

    const exit = await sup.get(request.run_id)!.exited;
    expect(exit.code).toBe(0); // o fake só sai 0 se recebeu o result_ack

    expect(i.invokeTool).toHaveBeenCalledTimes(1);
    expect(i.invokeTool.mock.calls[0]![0]).toEqual({
      version: 1,
      run_id: request.run_id,
      call_id: `${request.run_id}:0`,
      ordinal: 0,
      iteration: null,
      name: 'fixture_echo',
      args: { texto: 'oi' },
    });

    const obs = await engine.observe(locator(request, start.remote_run_id), new AbortController().signal);
    expect(obs.kind).toBe('terminal');
    if (obs.kind !== 'terminal') return;
    expect(obs.proposal.observed_tool_call_ids).toEqual([`${request.run_id}:0`]);
    expect(obs.proposal.stop).toEqual({ kind: 'reply', raw_text: 'tool=result:{"ok":true}' });

    expect(j.recordTerminal).toHaveBeenCalledTimes(1);
    const gravado = j.recordTerminal.mock.calls[0]![0] as { binding: RunBindingV1; proposal: unknown };
    expect(gravado.binding).toEqual(context.binding);
    expect(Object.isFrozen(gravado.binding.acl)).toBe(true);
    expect(canonicalDigest(gravado.proposal)).toBe(canonicalDigest(obs.proposal));
  });

  it('resolvedor que falha: rejected, nenhum processo', async () => {
    const sup = supervisor('happy');
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => {
        throw new Error('db fora');
      },
      journal: journal(),
    });
    const request = requestFor(randomUUID());
    expect(await engine.start(request, io())).toEqual({
      kind: 'rejected',
      definitely_not_accepted: true,
      code: 'run_context_unavailable',
    });
    expect(sup.get(request.run_id)).toBeUndefined();
  });

  it('posse perdida antes do spawn (sinal, lease, revalidação): rejected, nenhum processo', async () => {
    const variantes: Array<(c: HermesRunContextV1) => HermesRunContextV1> = [
      (c) => c,
      (c) => ({ ...c, leaseHorizonMs: () => Date.now() - 1 }),
      (c) => ({ ...c, leaseHorizonMs: () => Number.NaN }),
      (c) => ({ ...c, revalidate: async () => false }),
      (c) => ({
        ...c,
        revalidate: () => {
          throw new Error('db fora');
        },
      }),
    ];
    for (const [i, muda] of variantes.entries()) {
      const sup = supervisor('happy');
      const request = requestFor(randomUUID());
      const engine = createHermesEngine({
        supervisor: sup,
        resolveRunContext: async () => muda(contextFor(request)),
        journal: journal(),
      });
      const sinal = i === 0 ? AbortSignal.abort() : new AbortController().signal;
      const i0 = { ...io(), signal: sinal };
      expect(await engine.start(request, i0)).toEqual({
        kind: 'rejected',
        definitely_not_accepted: true,
        code: 'ownership_lost',
      });
      expect(sup.get(request.run_id)).toBeUndefined();
    }
  });

  it('tool recusada pelo supervisor não quebra o terminal no journal', async () => {
    const sup = supervisor('unlisted_tool');
    const j = journal();
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: j,
    });
    const start = await engine.start(request, io());
    if (start.kind !== 'accepted') throw new Error(start.kind);
    expect((await sup.get(request.run_id)!.exited).code).toBe(0);
    const gravado = j.recordTerminal.mock.calls[0]![0] as { proposal: { observed_tool_call_ids: string[] } };
    // O worker reportou o seq 0; ele foi recusado aqui e nunca chegou ao journal.
    expect(gravado.proposal.observed_tool_call_ids).toEqual([]);
  });

  it('plano recusado: rejected com o código do plano, nenhum processo', async () => {
    const sup = supervisor('happy');
    const request = requestFor(randomUUID());
    const context = contextFor(request);
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => ({
        ...context,
        binding: { ...context.binding, manifest_digest: 'f'.repeat(64) },
      }),
      journal: journal(),
    });
    expect(await engine.start(request, io())).toEqual({
      kind: 'rejected',
      definitely_not_accepted: true,
      code: 'manifest_mismatch',
    });
    expect(sup.get(request.run_id)).toBeUndefined();
  });

  it('readiness recusada com exit confirmado: rejected, nenhuma tool', async () => {
    const sup = supervisor('bad_digest');
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: journal(),
    });
    const i = io();
    expect(await engine.start(request, i)).toEqual({
      kind: 'rejected',
      definitely_not_accepted: true,
      code: 'readiness_schema_digest_mismatch',
    });
    expect(i.invokeTool).not.toHaveBeenCalled();
  });

  it('start repetido devolve o MESMO desfecho sem segundo processo; payload diferente é conflito', async () => {
    const sup = supervisor('cooperative');
    const request = requestFor(randomUUID());
    const resolveRunContext = vi.fn(async () => contextFor(request));
    const engine = createHermesEngine({ supervisor: sup, resolveRunContext, journal: journal() });
    const [a, b] = await Promise.all([engine.start(request, io()), engine.start(request, io())]);
    expect(a).toEqual(b);
    expect(a.kind).toBe('accepted');
    expect(resolveRunContext).toHaveBeenCalledTimes(1);
    expect(
      await engine.start({ ...request, limits: { ...request.limits, max_iterations: 2 } }, io()),
    ).toEqual({ kind: 'rejected', definitely_not_accepted: true, code: 'request_key_payload_conflict' });
  });

  it('cancel pela porta: requested, e o terminal de cancelamento aparece no observe', async () => {
    const sup = supervisor('cooperative');
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: journal(),
    });
    const start = await engine.start(request, io());
    if (start.kind !== 'accepted') throw new Error(start.kind);
    const loc = locator(request, start.remote_run_id);
    expect(await engine.cancel(loc, new AbortController().signal)).toEqual({ kind: 'requested' });
    await sup.get(request.run_id)!.exited;
    const obs = await engine.observe(loc, new AbortController().signal);
    expect(obs.kind === 'terminal' && obs.proposal.stop).toEqual({ kind: 'cancelled', reason: 'operator' });
    expect(await engine.cancel(loc, new AbortController().signal)).toEqual({ kind: 'already_terminal' });
  });

  it('observe: run desconhecido ou remote_run_id divergente é inconclusivo', async () => {
    const sup = supervisor('cooperative');
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: journal(),
    });
    const sinal = new AbortController().signal;
    expect(await engine.observe(locator(request, null), sinal)).toEqual({
      kind: 'not_found',
      proof: 'inconclusive',
    });
    const start = await engine.start(request, io());
    if (start.kind !== 'accepted') throw new Error(start.kind);
    expect(await engine.observe(locator(request, 'hermes:outro'), sinal)).toEqual({
      kind: 'not_found',
      proof: 'inconclusive',
    });
    expect(await engine.observe(locator(request, start.remote_run_id), sinal)).toEqual({
      kind: 'running',
      remote_run_id: start.remote_run_id,
    });
    expect(await engine.cancel(locator(request, 'hermes:outro'), sinal)).toEqual({ kind: 'unknown' });
  });

  it('worker que morre sem terminal: observe unavailable, nunca terminal inventado', async () => {
    const sup = supervisor('crash');
    const request = requestFor(randomUUID());
    const j = journal();
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: j,
    });
    const start = await engine.start(request, io());
    if (start.kind !== 'accepted') throw new Error(start.kind);
    await sup.get(request.run_id)!.exited;
    expect(await engine.observe(locator(request, start.remote_run_id), new AbortController().signal)).toEqual({
      kind: 'unavailable',
      code: 'transport',
    });
    expect(j.recordTerminal).not.toHaveBeenCalled();
    expect(j.revokeCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ reason_code: 'worker_exited' }),
    );
  });

  it('resposta do broker para OUTRA chamada: o modelo recebe effect_unknown', async () => {
    const sup = supervisor('happy');
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: journal(),
    });
    const start = await engine.start(
      request,
      io(async () => ({ kind: 'result', call_id: 'outra:0', result: 'segredo', is_error: false })),
    );
    if (start.kind !== 'accepted') throw new Error(start.kind);
    await sup.get(request.run_id)!.exited;
    const obs = await engine.observe(locator(request, start.remote_run_id), new AbortController().signal);
    expect(obs.kind === 'terminal' && obs.proposal.stop).toEqual({
      kind: 'reply',
      raw_text: 'tool=refused:effect_unknown',
    });
  });

  it('journal que recusa o terminal: nenhum result_ack (o fake sai 7)', async () => {
    const sup = supervisor('happy');
    const request = requestFor(randomUUID());
    const engine = createHermesEngine({
      supervisor: sup,
      resolveRunContext: async () => contextFor(request),
      journal: journal({ recordTerminal: async () => ({ ok: false, reason: 'stale_claim' }) }),
    });
    const start = await engine.start(request, io());
    expect(start.kind).toBe('accepted');
    expect((await sup.get(request.run_id)!.exited).code).toBe(7);
  });
});
