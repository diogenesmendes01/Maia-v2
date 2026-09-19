/**
 * P07 (spec §5.3.1, §5.7.3, §6.3, §6.7.2, §6.12) — `HermesEngine`: o motor
 * remoto atrás de `AgentEnginePortV1`, sobre o supervisor de processo.
 *
 * ─── De onde vem cada dado ──────────────────────────────────────────────────
 *
 * `start` recebe só o `EngineRequestV1`. Tudo que dá autoridade — `RunBinding`
 * (tenant, agente, pessoa, conversa, claim de origem), manifest compilado,
 * rota de inferência e credencial curta — vem de `resolveRunContext`, que a
 * Maia implementa lendo o próprio banco depois do claim. Nada disso vem do
 * worker nem do modelo. Falha desse lookup FECHA: `rejected`, sem processo.
 *
 * Antes de lançar, `planWorkerStart` confere que as peças concordam entre si
 * (binding ↔ request ↔ manifest ↔ pin do Hermes ↔ superfície de tools) e
 * recusa qualquer divergência. Não há "usar o que der".
 *
 * ─── O que o motor devolve ──────────────────────────────────────────────────
 *
 * Uma PROPOSTA (`EngineTerminalProposalV1`), nunca entrega. O terminal do
 * worker é gravado pelo hook do journal (`recordTerminal`, com o fence de
 * origem do binding) e só então o worker recebe `result_ack`. Quem adota,
 * congela a saída e envia continua sendo a Maia (§5.9).
 *
 * ─── Memória honesta ────────────────────────────────────────────────────────
 *
 * O registro de runs é do PROCESSO. Depois de um restart, `observe` de um run
 * desconhecido é `not_found/inconclusive`, nunca prova de não-execução
 * (§5.3.1). A continuidade é do journal.
 */
import { canonicalDigest, canonicalJsonStringify } from '@/integrations/hermes/canonical-json.js';
import { normalizeEngineContext } from '@/integrations/hermes/history.js';
import {
  computeManifestDigest,
  parseRuntimeManifest,
  type RuntimeManifestV1,
} from '@/integrations/hermes/manifest.js';
import {
  HERMES_WORKER_PROTOCOL_VERSION,
  deriveCallId,
  serializeFrame,
  type ResultFrame,
  type StartFrame,
  type ToolRequestFrame,
} from '@/integrations/hermes/protocol.js';
import {
  freezeRunBinding,
  parseRunBinding,
  workerBindingProjection,
  type RunBindingV1,
} from '@/integrations/hermes/run-binding.js';
import type {
  HermesSupervisorV1,
  ResultContextV1,
  ResultPersistenceV1,
  ToolOutcomeV1,
  WorkerSessionV1,
} from '@/integrations/hermes/supervisor.js';
import type {
  AgentEnginePortV1,
  EngineIOV1,
  EngineObservationV1,
  EnginePinV1,
  EngineRequestV1,
  EngineRunLocatorV1,
  EngineStartResultV1,
  EngineTerminalProposalV1,
  Json,
} from './contracts.js';
import {
  engineRequestV1Schema,
  engineTerminalProposalV1Schema,
  engineToolReplyV1Schema,
} from './schemas.js';

export const HERMES_ENGINE_ADAPTER_REVISION = 'hermes-engine-0.1.0';

/** Teto global de resultado quando o manifest não tem tool (o wire exige >= 1). */
const DEFAULT_RESULT_LIMIT_CHARS = 16_384;
/** Teto do `run_budget_seconds` do wire; o prazo real é do supervisor. */
const MAX_RUN_BUDGET_SECONDS = 3_600;

// ─── contexto resolvido pela Maia ───────────────────────────────────────────

/**
 * O que a Maia resolve do PRÓPRIO banco, depois do claim, para este run.
 * Nenhum campo aqui pode vir do worker ou do modelo.
 */
export interface HermesRunContextV1 {
  binding: RunBindingV1;
  /** Manifest COMPILADO; seu digest precisa ser o `binding.manifest_digest`. */
  manifest: RuntimeManifestV1;
  /** Rota autorizada do gateway de inferência da Maia (§9.1). */
  inference: { base_url: string; model: string; provider: string };
  /** Credencial curta de inferência, só para o env do filho. */
  inference_credential: string;
  /** Horizonte MÓVEL da lease do turno, ms epoch (§5.8.1). */
  leaseHorizonMs(): number;
  /** Reconsulta lease/epoch/revogação no banco. `false` ou exceção = recusa. */
  revalidate(): Promise<boolean>;
}

/** A escrita autoritativa no journal, com o fence do binding. */
export interface HermesJournalPortV1 {
  recordTerminal(input: {
    binding: Readonly<RunBindingV1>;
    proposal: EngineTerminalProposalV1;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  revokeCapabilities(input: {
    binding: Readonly<RunBindingV1>;
    reason_code: string;
  }): Promise<void>;
}

export interface HermesEngineDepsV1 {
  supervisor: HermesSupervisorV1;
  resolveRunContext(request: EngineRequestV1): Promise<HermesRunContextV1>;
  journal: HermesJournalPortV1;
  adapterRevision?: string;
  now?: () => number;
}

// ─── plano do `start` (puro) ────────────────────────────────────────────────

export type StartPlanRefusalV1 =
  | 'binding_invalid'
  | 'binding_mismatch'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'hermes_pin_mismatch'
  | 'surface_mismatch'
  | 'context_unsupported'
  | 'deadline_exceeded'
  | 'inference_not_allowed'
  | 'start_out_of_contract';

export type WorkerStartPlanV1 =
  | {
      kind: 'ok';
      start: StartFrame;
      binding: Readonly<RunBindingV1>;
      execution_deadline_ms: number;
      /** Teto REAL; pode ser 0 (o wire leva no mínimo 1). */
      max_tool_calls: number;
    }
  | { kind: 'refused'; code: StartPlanRefusalV1 };

const refused = (code: StartPlanRefusalV1): WorkerStartPlanV1 => ({ kind: 'refused', code });

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return canonicalJsonStringify(a) === canonicalJsonStringify(b);
  } catch {
    return false;
  }
}

/**
 * Monta o `start` a partir do pedido e do contexto resolvido. Função PURA.
 *
 * Cada recusa é uma divergência entre fontes que deveriam concordar. O prazo é
 * o MENOR dos três declarados (pedido, binding, manifest) e os limites são o
 * MENOR entre pedido e manifest: combinar fontes só pode estreitar.
 */
export function planWorkerStart(input: {
  request: EngineRequestV1;
  context: HermesRunContextV1;
  hermes_sha: string;
  now_ms: number;
}): WorkerStartPlanV1 {
  const { request, context } = input;

  const b = parseRunBinding(context.binding);
  if (b.kind !== 'ok') return refused('binding_invalid');
  // Cópia validada e congelada: os hooks a capturam pelo run inteiro (§6.4.1).
  const binding = freezeRunBinding(b.binding);
  if (binding.run_id !== request.run_id) return refused('binding_mismatch');

  const m = parseRuntimeManifest(context.manifest);
  if (m.kind !== 'ok') return refused('manifest_invalid');
  const manifest = m.manifest;
  if (
    manifest.run_id !== binding.run_id ||
    manifest.mode !== binding.mode ||
    manifest.bundle_digest !== binding.bundle_digest ||
    manifest.context_digest !== binding.context_digest ||
    manifest.control_epoch !== binding.control_epoch ||
    computeManifestDigest(manifest) !== binding.manifest_digest
  ) {
    return refused('manifest_mismatch');
  }
  if (manifest.runtime_pin.hermes_sha !== input.hermes_sha) return refused('hermes_pin_mismatch');

  // A superfície que o reasoner viu no pedido é EXATAMENTE a do manifest.
  const requestTools = request.context.tools;
  if (requestTools.length !== manifest.tools.length) return refused('surface_mismatch');
  const byName = new Map(manifest.tools.map((t) => [t.name, t] as const));
  const vistos = new Set<string>();
  for (const t of requestTools) {
    const mt = byName.get(t.name);
    if (!mt || vistos.has(t.name) || !sameJson(t.input_schema, mt.input_schema)) {
      return refused('surface_mismatch');
    }
    vistos.add(t.name);
  }

  const normalized = normalizeEngineContext({
    system: request.context.system,
    messages: request.context.messages,
  });
  if (normalized.kind !== 'ok') return refused('context_unsupported');

  const deadline = Math.min(
    Date.parse(request.limits.deadline_at),
    Date.parse(binding.deadline_at),
    Date.parse(manifest.limits.deadline_at),
  );
  if (!Number.isFinite(deadline) || deadline <= input.now_ms) return refused('deadline_exceeded');

  if (manifest.limits.max_inference_calls < 1) return refused('inference_not_allowed');
  const max_tool_calls = Math.min(request.limits.max_tool_calls, manifest.limits.max_tool_calls);

  // Teto real 0 = nenhuma tool exposta: o modelo não tenta o que seria recusado.
  const tools =
    max_tool_calls === 0
      ? []
      : manifest.tools.map((t) => ({
          name: t.name,
          input_schema: t.input_schema,
          result_limit_chars: t.limits.result_limit_chars,
        }));
  const start: StartFrame = {
    protocol: HERMES_WORKER_PROTOCOL_VERSION,
    type: 'start',
    run_id: binding.run_id,
    request_key: request.request_key,
    binding: workerBindingProjection(binding),
    manifest: {
      schema: 'maia-hermes-runtime-manifest/v1',
      tools,
      result_limit_chars:
        tools.length > 0
          ? Math.max(...tools.map((t) => t.result_limit_chars))
          : DEFAULT_RESULT_LIMIT_CHARS,
    },
    context: normalized.context,
    limits: {
      max_iterations: request.limits.max_iterations,
      max_output_tokens_per_call: Math.min(
        request.limits.max_output_tokens_per_call,
        manifest.limits.max_output_tokens,
      ),
      max_tool_calls: Math.max(1, max_tool_calls),
      max_inference_calls: manifest.limits.max_inference_calls,
      run_budget_seconds: Math.min(
        MAX_RUN_BUDGET_SECONDS,
        Math.max(1, Math.ceil((deadline - input.now_ms) / 1_000)),
      ),
      deadline_at: new Date(deadline).toISOString(),
    },
    inference: {
      base_url: context.inference.base_url,
      model: context.inference.model,
      provider: context.inference.provider,
      api_mode: 'chat_completions',
    },
  };
  try {
    serializeFrame(start);
  } catch {
    return refused('start_out_of_contract');
  }
  return {
    kind: 'ok',
    start,
    binding,
    execution_deadline_ms: deadline,
    max_tool_calls,
  };
}

// ─── tradução frame ↔ porta (pura) ──────────────────────────────────────────

/**
 * `result` do worker → proposta da porta. `null` = fora do contrato da porta.
 *
 * Os `call_seq` que o supervisor recusou sem repassar ao broker saem da lista:
 * o worker os reporta porque os alocou, mas o journal nunca os viu, e mantê-los
 * faria todo terminal de run cancelado cair em `observed_calls_mismatch`. Um seq
 * que o supervisor NÃO viu continua na lista — e o journal recusa, como deve.
 */
export function proposalFromResultFrame(
  frame: ResultFrame,
  context: ResultContextV1 = { locally_refused_call_seqs: [] },
): EngineTerminalProposalV1 | null {
  const refusedHere = new Set(context.locally_refused_call_seqs);
  const candidate = {
    version: 1 as const,
    run_id: frame.run_id,
    request_key: frame.request_key,
    stop: frame.stop,
    iterations: frame.iterations,
    observed_tool_call_ids: frame.observed_tool_call_seqs
      .filter((s) => !refusedHere.has(s))
      .map((s) => deriveCallId(frame.run_id, s)),
    usage: frame.usage,
  };
  const parsed = engineTerminalProposalV1Schema.safeParse(candidate);
  return parsed.success ? (parsed.data as EngineTerminalProposalV1) : null;
}

// ─── o motor ────────────────────────────────────────────────────────────────

/** Lease viva: horizonte numérico no futuro, ou +Infinity (sem lease). */
function leaseAlive(context: HermesRunContextV1, now_ms: number): boolean {
  let lease: number;
  try {
    lease = context.leaseHorizonMs();
  } catch {
    return false;
  }
  return typeof lease === 'number' && !Number.isNaN(lease) && lease > now_ms;
}

type RunRecord = {
  fingerprint: string;
  request_key: string;
  startResult: Promise<EngineStartResultV1>;
  remote_run_id: string | null;
  session: WorkerSessionV1 | null;
  proposal: EngineTerminalProposalV1 | null;
};

export interface HermesEngineV1 extends AgentEnginePortV1 {
  /** Identidade não secreta desta implantação, para `remote_instance_id`. */
  readonly remoteInstanceId: string;
  /** Encerramento do processo Maia: cancela e espera todos os workers. */
  shutdown(): Promise<void>;
}

export function createHermesEngine(deps: HermesEngineDepsV1): HermesEngineV1 {
  const now = deps.now ?? Date.now;
  const sup = deps.supervisor;
  const adapter_revision = deps.adapterRevision ?? HERMES_ENGINE_ADAPTER_REVISION;
  const runs = new Map<string, RunRecord>();

  const pin: EnginePinV1 = {
    engine: 'hermes',
    adapter_revision,
    configuration_digest: canonicalDigest({
      engine: 'hermes',
      adapter_revision,
      hermes_sha: sup.config.hermes_sha,
      expected_bridge_revision: sup.config.expected_bridge_revision,
      worker_args: sup.config.worker_args,
    }),
    protocol_version: 1,
  };
  const remoteInstanceId = `hermes-supervisor:${sup.config.hermes_sha.slice(0, 12)}`;

  async function doStart(
    request: EngineRequestV1,
    io: EngineIOV1,
    record: RunRecord,
  ): Promise<EngineStartResultV1> {
    const notAccepted = (code: string): EngineStartResultV1 => ({
      kind: 'rejected',
      definitely_not_accepted: true,
      code,
    });

    let context: HermesRunContextV1;
    try {
      context = await deps.resolveRunContext(request);
    } catch {
      return notAccepted('run_context_unavailable');
    }

    const plan = planWorkerStart({
      request,
      context,
      hermes_sha: sup.config.hermes_sha,
      now_ms: now(),
    });
    if (plan.kind !== 'ok') return notAccepted(plan.code);
    const binding = plan.binding;
    const run_id = binding.run_id;

    // §6.11 "Só uma lease válida pode lançar"; §5.8.2 proíbe submeter sob
    // claim expirado. Conferido ANTES do spawn: depois dele o filho já tem a
    // credencial e o contexto.
    if (io.signal.aborted || !leaseAlive(context, now())) return notAccepted('ownership_lost');
    const valid = await Promise.race([
      Promise.resolve()
        .then(() => context.revalidate())
        .then(
          (ok) => ok === true,
          () => false,
        ),
      new Promise<boolean>((r) => {
        const t = setTimeout(() => r(false), sup.config.hook_timeout_ms);
        t.unref?.();
      }),
    ]);
    if (!valid || io.signal.aborted) return notAccepted('ownership_lost');

    const launched = await sup.launch({
      start: plan.start,
      inference_key: context.inference_credential,
      execution_deadline_ms: plan.execution_deadline_ms,
      max_tool_calls: plan.max_tool_calls,
      signal: io.signal,
      hooks: {
        async onToolRequest(frame: ToolRequestFrame): Promise<ToolOutcomeV1> {
          const call_id = deriveCallId(run_id, frame.call_seq);
          const reply = await io.invokeTool({
            version: 1,
            run_id,
            call_id,
            ordinal: frame.call_seq,
            iteration: null,
            name: frame.name,
            args: frame.args as Json,
          });
          const parsed = engineToolReplyV1Schema.safeParse(reply);
          // Resposta fora do contrato ou de OUTRA chamada: o efeito dela é
          // desconhecido para o modelo, e ele não recebe o conteúdo.
          if (!parsed.success || parsed.data.call_id !== call_id) {
            return { kind: 'refused', code: 'effect_unknown' };
          }
          const r = parsed.data;
          if (r.kind === 'result') return { kind: 'result', result: r.result, is_error: r.is_error };
          if (r.kind === 'in_progress') return { kind: 'in_progress', retry_after_ms: r.retry_after_ms };
          return { kind: 'refused', code: r.code };
        },
        async onResult(frame: ResultFrame, rctx: ResultContextV1): Promise<ResultPersistenceV1> {
          const proposal = proposalFromResultFrame(frame, rctx);
          if (!proposal) return { kind: 'not_persisted' };
          record.proposal = proposal;
          const res = await deps.journal.recordTerminal({ binding, proposal });
          if (!res.ok) return { kind: 'not_persisted' };
          // O MESMO digest que o journal grava em `terminal_hash`.
          return { kind: 'persisted', terminal_digest: canonicalDigest(proposal) };
        },
        onRevoke: (reason_code: string) => deps.journal.revokeCapabilities({ binding, reason_code }),
        revalidate: () => context.revalidate(),
        leaseHorizonMs: () => context.leaseHorizonMs(),
      },
    });
    if (launched.kind !== 'launched') return notAccepted(`launch_${launched.reason}`);
    const session = launched.session;
    record.session = session;
    void session.released.then(() => {
      if (runs.get(request.run_id) === record) runs.delete(request.run_id);
    });

    const ready = await session.ready;
    if (ready.kind === 'accepted') {
      const remote_run_id = `hermes:${sup.incarnation}:${session.worker_instance_id}`;
      record.remote_run_id = remote_run_id;
      return { kind: 'accepted', remote_run_id };
    }
    // Readiness recusada: nenhuma tool chegou ao broker (o supervisor só
    // despacha depois do ready conferido). Com o exit confirmado, "não aceito"
    // é FATO; sem ele, o processo pode seguir vivo e a resposta é `unknown`.
    if (ready.exit_confirmed) return notAccepted(`readiness_${ready.reason}`);
    return { kind: 'unknown', code: `readiness_${ready.reason}_exit_unconfirmed` };
  }

  function lookup(locator: EngineRunLocatorV1): RunRecord | null {
    const record = runs.get(locator.run_id);
    if (!record || !record.session || record.request_key !== locator.request_key) return null;
    if (locator.remote_run_id !== null && locator.remote_run_id !== record.remote_run_id) return null;
    return record;
  }

  return {
    pin,
    remoteInstanceId,

    async start(request: EngineRequestV1, io: EngineIOV1): Promise<EngineStartResultV1> {
      const parsed = engineRequestV1Schema.safeParse(request);
      if (!parsed.success) {
        return { kind: 'rejected', definitely_not_accepted: true, code: 'invalid_request' };
      }
      const fingerprint = canonicalDigest(request as unknown as Record<string, unknown>);
      const existing = runs.get(request.run_id);
      if (existing) {
        // §5.6.1: mesma chave com bytes diferentes é conflito terminal; o
        // mesmo pedido devolve o MESMO desfecho, sem segundo processo.
        if (existing.fingerprint !== fingerprint || existing.request_key !== request.request_key) {
          return {
            kind: 'rejected',
            definitely_not_accepted: true,
            code: 'request_key_payload_conflict',
          };
        }
        return existing.startResult;
      }
      const record: RunRecord = {
        fingerprint,
        request_key: request.request_key,
        startResult: Promise.resolve({ kind: 'unknown', code: 'pending' }),
        remote_run_id: null,
        session: null,
        proposal: null,
      };
      // Registrado ANTES do primeiro await: start concorrente do mesmo run
      // encontra o registro e espera o mesmo desfecho.
      runs.set(request.run_id, record);
      record.startResult = doStart(request, io, record).catch(
        (): EngineStartResultV1 => ({ kind: 'unknown', code: 'adapter_error' }),
      );
      const result = await record.startResult;
      // Sem processo, nada a reter: um start repetido depois poderá tentar de
      // novo (é o journal quem autoriza a repetição, §5.7.2).
      if (result.kind === 'rejected' && record.session === null) runs.delete(request.run_id);
      return result;
    },

    async observe(locator: EngineRunLocatorV1, _signal: AbortSignal): Promise<EngineObservationV1> {
      const record = lookup(locator);
      if (!record || !record.session || record.remote_run_id === null) {
        return { kind: 'not_found', proof: 'inconclusive' };
      }
      const snap = record.session.snapshot();
      if (snap.terminal && !snap.terminal.conflict && record.proposal) {
        return { kind: 'terminal', remote_run_id: record.remote_run_id, proposal: record.proposal };
      }
      // Canal perdido, violado ou com terminais divergentes: não há como
      // observar. NÃO é "falhou" nem "não executou" — quem decide é o journal.
      if (snap.exit !== null || snap.protocol_violation !== null || snap.terminal?.conflict) {
        return { kind: 'unavailable', code: 'transport' };
      }
      return { kind: 'running', remote_run_id: record.remote_run_id };
    },

    async cancel(
      locator: EngineRunLocatorV1,
      signal: AbortSignal,
    ): Promise<{ kind: 'requested' | 'already_terminal' | 'unsupported' | 'unknown' }> {
      const record = lookup(locator);
      if (!record || !record.session) return { kind: 'unknown' };
      const snap = record.session.snapshot();
      if (snap.terminal && !snap.terminal.conflict) return { kind: 'already_terminal' };
      if (snap.exit !== null) return { kind: 'unknown' };
      const aborted = new Promise<'aborted'>((r) => {
        if (signal.aborted) r('aborted');
        else signal.addEventListener('abort', () => r('aborted'), { once: true });
      });
      const res = await Promise.race([record.session.requestCancel('operator'), aborted]);
      // `requested` confirma o PEDIDO, não ausência de efeito (INV-06).
      return res === 'requested' ? { kind: 'requested' } : { kind: 'unknown' };
    },

    shutdown: () => sup.shutdown(),
  };
}

