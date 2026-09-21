import { pgErrorCode } from '@/db/client.js';
import { mensagensRepo, pendingQuestionsRepo } from '@/db/repositories.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import { callLLM, type LLMMessage, type ToolSchema } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { REGISTRY } from '@/tools/_registry.js';
import { forCurrentAgentChannel } from '@/gateway/line-output.js';
import { withDeclaredEgressExceptionSync } from '@/runtime/outbound/egress-guard.js';
import { uuid } from '@/lib/utils.js';
import { safeDispatchOutput, type LatestPending, type LatestReportPdf } from './output-dispatch.js';
import { detectGap } from './gap-detector.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { CognitiveEventType } from '@/types/enums.js';
import { buildToolSummary, type ToolExecutionSummary } from './tool-execution-summary.js';
import { instrumentReactIteration } from '@/observability/instrumentation.js';
import {
  assertTurnOwnership,
  getTurnExecutionContext,
  TurnOwnershipLostError,
} from '@/runtime/turns/execution-context.js';
import { assembleTurnResult, type EngineToolReceiptV1 } from '@/runtime/engines/assembler.js';
import { coordinateOutput } from '@/runtime/engines/coordinator.js';

/**
 * `run_id`/`request_key` do motor LOCAL.
 *
 * A porta os exige porque um motor remoto precisa deles para correlacionar
 * frames. O laço local não tem run durável — ele É o turno —, então usa um
 * UUID nulo em vez de fabricar identificadores que ninguém poderia procurar
 * depois. Um id inventado aqui vazaria para a proposta e pareceria referência
 * a um run que não existe.
 */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Gatilho de reflexão de lacuna, disparado SÓ depois de algo chegar ao usuário.
 *
 * Saiu de dentro da fachada de saída quando ela virou o coordenador, e a regra
 * que ele carrega é a mesma de antes: fire-and-forget, nunca bloqueia a
 * resposta, e recebe o texto CRU — sem o prefixo de anúncio de role, que é
 * frase da Maia e dispararia lacuna por conta própria ([P88-C4]).
 */
function dispararReflexaoDeLacuna(
  rawText: string,
  ctx: { conversa_id: string; inbound_id: string; pessoa_id: string },
): void {
  const gap = detectGap(rawText);
  if (!gap.detected) return;
  const signal = gap.signal ?? '';
  void (async () => {
    try {
      const event = {
        type: CognitiveEventType.INTERNAL_GAP,
        conversa_id: ctx.conversa_id,
        inbound_mensagem_id: ctx.inbound_id,
        gap_description: signal,
        attempted_response: rawText,
      } as const;
      const reflected = await reflect(event, { pessoa_id: ctx.pessoa_id });
      if (!reflected || !reflected.insight) return;
      const classified = await classify(reflected.insight);
      if (!classified) return;
      await persistCandidate(classified, event);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, mensagem_id: ctx.inbound_id },
        'gap.reflection.failed',
      );
    }
  })();
}

/**
 * Codex C1 (PR #74): when the ReAct loop exits without dispatching outbound
 * (iteration cap, empty final text, or outbound failure) but tools ran,
 * persist the tool summaries via a placeholder "event-only" mensagem so
 * the next turn's prompt-builder can still surface them in the
 * "## Eventos confirmados pelo backend" block.
 *
 * Issue #577 — `tipo: 'evento'` só passou a caber no CHECK de `mensagens.tipo`
 * em `migrations/116_mensagens_tipo_evento.sql`. Antes disso TODO INSERT daqui
 * violava `mensagens_tipo_check`, o catch abaixo engolia, e o helper era código
 * morto: o rastro de ferramentas de qualquer turno sem outbound sumia do
 * histórico deixando só um `warn`.
 *
 * ─── Por que continua best-effort ──────────────────────────────────────────
 *
 * Porque falhar o turno aqui é ESTRITAMENTE PIOR, e a razão está escrita no
 * caller: em `src/agent/core.ts` ("`iteration_cap` NÃO é retryable: tools já
 * rodaram, reexecutar duplicaria efeito colateral"). Este flush só roda nos
 * caminhos SEM outbound — exatamente aqueles em que as tools já rodaram e
 * `sideEffectsCommitted` pode estar marcado. Um throw daqui subiria como erro
 * genérico, o turno viraria falha e o recovery reexecutaria o ReAct do zero:
 * trocaríamos a perda de UM anchor de prompt pela duplicação de um efeito
 * externo irreversível (um boleto emitido duas vezes).
 *
 * E o invariante de auditoria da §4 não depende desta row: o laço já escreveu
 * um `audit()` em `audit_log` por tool-use, ANTES de chegar aqui. Esta row é o
 * anchor anti-anchoring do turno SEGUINTE, não o livro-razão.
 *
 * ─── O log tem de ser distinguível ─────────────────────────────────────────
 *
 * O que não pode voltar a acontecer é o modo de falha desta issue: um defeito
 * PERMANENTE de esquema/código indistinguível de um soluço de banco. Por isso
 * classificamos pelo SQLSTATE — classe 22 (data exception) e 23 (integrity
 * constraint violation) são determinísticas: vão falhar de novo, idênticas, em
 * toda tentativa. Essas saem em `error` com `failure_kind: 'permanent'` e o
 * nome da constraint; o resto (conexão caída, deadlock, timeout) segue em
 * `warn` como `'transient'`.
 */
function classifyFlushFailure(err: unknown): {
  failure_kind: 'permanent' | 'transient';
  pg_code: string | undefined;
  pg_constraint: string | undefined;
} {
  const pg_code = pgErrorCode(err);
  // 22xxx data exception, 23xxx integrity constraint violation — nenhuma delas
  // muda de resultado na próxima tentativa: é esquema ou código, não infra.
  const permanent =
    typeof pg_code === 'string' && (pg_code.startsWith('22') || pg_code.startsWith('23'));
  let constraint: unknown;
  for (let cur: unknown = err, depth = 0; cur != null && depth < 8; depth++) {
    const c = (cur as { constraint?: unknown }).constraint;
    if (typeof c === 'string' && c.length > 0) {
      constraint = c;
      break;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return {
    failure_kind: permanent ? 'permanent' : 'transient',
    pg_code,
    pg_constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

async function flushUnconfirmedToolSummaries(
  conversa_id: string,
  inbound_id: string,
  toolSummaries: ToolExecutionSummary[],
  reason: ReActExitReason,
): Promise<void> {
  if (toolSummaries.length === 0) return;
  try {
    await mensagensRepo.create({
      conversa_id,
      direcao: 'out',
      tipo: 'evento',
      conteudo: '',
      midia_url: null,
      metadata: {
        in_reply_to: inbound_id,
        event_only: true,
        flush_reason: reason,
      },
      processada_em: new Date(),
      ferramentas_chamadas: toolSummaries,
      tokens_usados: null,
    });
    logger.info(
      { conversa_id, inbound_id, count: toolSummaries.length, reason },
      'agent.tool_summaries_flushed_no_outbound',
    );
  } catch (err) {
    const { failure_kind, pg_code, pg_constraint } = classifyFlushFailure(err);
    // `err` do Drizzle traz a query e os PARÂMETROS inteiros na mensagem — ou
    // seja, o conteúdo das ferramentas — então nunca o repassamos cru.
    const fields = {
      conversa_id,
      inbound_id,
      reason,
      count: toolSummaries.length,
      failure_kind,
      pg_code: pg_code ?? null,
      pg_constraint: pg_constraint ?? null,
      err: (err as Error).name,
    };
    if (failure_kind === 'permanent') {
      // Defeito nosso: o mesmo INSERT vai falhar igual na próxima vez. Some o
      // rastro de ferramentas de TODO turno sem outbound até alguém consertar.
      logger.error(fields, 'agent.tool_summaries_flush_rejected');
    } else {
      logger.warn(fields, 'agent.tool_summaries_flush_failed');
    }
  }
}

export const MAX_REACT_ITERATIONS = 5;

export type RunReActLoopParams = {
  pessoa: Pessoa;
  conversa: Conversa;
  inbound: Mensagem;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  jid: string;
  system: string;
  messages: LLMMessage[];
  tools: ToolSchema[];
  /**
   * [P88-C4] Optional announcement (e.g., "switching to suporte mode")
   * prepended to the final outbound text. null when policy.announce_mode
   * says no announcement should be emitted this turn. The model never sees
   * this text — it's a system-emitted prefix attached at dispatch time.
   */
  outboundPrefix?: string | null;
};

export type ReActLoopResult = {
  totalTokens: number;
  /** Final assistant text sent to the user (empty string when no end_turn produced text). */
  outboundText: string;
  /**
   * P3b Task 9: captured tool invocations across all iterations so the
   * post-turn step-evaluator can match tool_result success criteria.
   * Each entry has the tool name and the raw dispatcher output.
   */
  toolsCalled: Array<{ name: string; result: unknown }>;
  /**
   * Issue #503 — resultado DURÁVEL do turno, para que `core.ts` decida o
   * outcome da máquina de estados em vez de assumir "a função retornou, logo o
   * turno terminou". Antes desta issue o loop encerrava com texto vazio tanto
   * numa falha do reasoner quanto numa falha pre-send do outbound, e o caller
   * marcava tudo como processado — os cenários A e B da issue.
   */
  delivery: ReActDelivery;
};

export type ReActDelivery = {
  /** true quando o outbound foi efetivamente despachado ao usuário. */
  dispatched: boolean;
  /**
   * Por que o loop terminou sem despachar (ou, quando despachou, o motivo é
   * irrelevante e vale `empty_final_text`).
   *   reasoner_failed  — timeout/erro do LLM: NADA foi produzido, retry é seguro;
   *   outbound_failure — resposta produzida, envio falhou PRE-SEND: nada chegou
   *                      ao usuário, retry é seguro;
   *   empty_final_text — o modelo terminou sem texto: turno concluído sem resposta;
   *   iteration_cap    — teto de iterações com tools executadas: NÃO reexecutar
   *                      (efeitos colaterais já ocorreram).
   */
  exitReason: ReActExitReason;
  /**
   * Enviado ao usuário, mas a persistência do outbound falhou/ficou ambígua.
   * NUNCA reenviar: o outcome correto é `reply_delivery_unknown`.
   */
  persistUnknown: boolean;
  /**
   * Alguma tool com `side_effect` `write`/`communication` foi INVOCADA neste
   * turno. Quando true, um retry pode DUPLICAR o efeito (transação criada duas
   * vezes, mensagem enviada duas vezes), então o turno não pode voltar para a
   * fila — vai para dead letter com outcome `unsafe_to_retry` e exige decisão
   * humana. Conservador por construção: marca na invocação, não no sucesso.
   */
  sideEffectsCommitted: boolean;
};

export type ReActExitReason =
  | 'reasoner_failed'
  | 'outbound_failure'
  | 'empty_final_text'
  | 'iteration_cap';

/**
 * Runs the ReAct iteration loop. Keeps the LLM call → tool execution cycle
 * going until the model stops requesting tools (or the iteration cap is
 * reached). On end_turn (`tool_uses.length === 0`) it hands off to
 * `dispatchOutput` so the right output channel (PDF/voice/text/poll) is used.
 *
 * Returns the total tokens consumed across iterations so the caller can
 * persist it via `mensagensRepo.markProcessed`, plus the final outbound
 * text and the list of tools invoked — both used by the post-turn
 * procedure step-evaluator wired in `core.ts`.
 */
export async function runReActLoop(params: RunReActLoopParams): Promise<ReActLoopResult> {
  const { pessoa, conversa: c, inbound, jid, system, messages, tools } = params;
  let totalTokens = 0;
  const conversation: LLMMessage[] = messages;
  let latestPending: LatestPending | null = null;
  let turnHasSensitive = false;
  const sensitiveTools: string[] = [];
  let latestReportPdf: LatestReportPdf | null = null;
  let outboundText = '';
  /**
   * P02.2 (spec §5.2, §5.3.3) — SEPARAÇÃO ENTRE DELIBERAR E ENTREGAR.
   *
   * Até aqui o laço despachava a resposta DENTRO da iteração e devolvia um
   * veredito de entrega junto com o de raciocínio. Quem chamava não conseguia
   * distinguir "o modelo não produziu texto" de "o envio falhou antes de sair"
   * sem ler `exitReason`, e um motor em outro processo não teria como produzir
   * esse veredito — ele não entrega nada.
   *
   * Agora a iteração só REGISTRA o candidato (texto cru e texto final com o
   * prefixo de role); o despacho acontece depois do laço, na fachada de saída
   * abaixo. O comportamento observável é o mesmo — é o que os 57 casos de
   * `tests/unit/react-loop-characterization.spec.ts` verificam —, mas a
   * fronteira passa a existir.
   */
  const candidato: { atual: { rawText: string; text: string } | null } = { atual: null };
  const toolsCalled: Array<{ name: string; result: unknown }> = [];
  // Issue #73 — accumulator of structured per-tool summaries used both for
  // anti-anchoring (next-turn events block) and as the audit trail. Persisted
  // in `mensagens.ferramentas_chamadas` of the dispatched outbound, or via
  // `flushUnconfirmedToolSummaries` when no outbound was dispatched.
  const toolSummaries: ToolExecutionSummary[] = [];
  /**
   * P02 (§5.9.2.1) — os RECEIPTS desta execução, na ordem do despacho.
   *
   * O acumulador que o `EngineResultAssembler` consome. Ele coexiste com
   * `toolsCalled`/`toolSummaries` em vez de substituí-los porque os dois
   * antigos têm consumidores próprios (step-evaluator pós-turno e bloco de
   * eventos do prompt), e trocar a fonte deles caberia noutra fatia.
   */
  const receipts: EngineToolReceiptV1[] = [];
  /** Iterações efetivamente executadas — entra na proposta terminal. */
  let iteracoes = 0;
  // Codex C1 (PR #74): tracks whether any iteration successfully ran the
  // outbound dispatch path. `false` at exit + non-empty toolSummaries triggers
  // the placeholder flush so the next turn's anchor isn't lost.
  let outboundDispatched = false;
  // Reason recorded when we exit the loop without dispatching outbound.
  // Defaults to empty_final_text (the model returned no end_turn text);
  // overridden to 'iteration_cap' when we hit MAX_REACT_ITERATIONS.
  // Container mutável pela MESMA razão de `candidato` acima: as atribuições
  // acontecem dentro da closure da iteração, e o compilador não as acompanha
  // através dessa fronteira — com `let`, ele estreita o tipo para o valor
  // inicial e a leitura lá embaixo vira comparação "sem sobreposição".
  const saida: { motivo: ReActExitReason } = { motivo: 'empty_final_text' };
  // Issue #503 — dispatch entregue mas persistência ambígua: o usuário TEM a
  // resposta, então nunca reenviar; o outcome é `reply_delivery_unknown`.
  let persistUnknown = false;
  // Issue #503 — alguma tool com efeito externo irreversível chegou a rodar?
  // Enquanto false, um retry é seguro; a partir de true, não é.
  let sideEffectsCommitted = false;
  // Issue #507 — o sinal da tentativa, lido UMA vez. O `TurnExecutionContext`
  // é estável durante todo o turno (o ALS não muda de store no meio), e ler
  // fora do laço deixa explícito que é o mesmo orçamento de cancelamento em
  // todas as iterações. `undefined` fora de um turno reivindicado: workers de
  // agenda, playground e testes seguem com o comportamento anterior.
  const turnSignal = getTurnExecutionContext()?.signal;

  /**
   * Issue #535 — o corpo de UMA iteração, extraído para que o span
   * `react.iteration` possa envolvê-lo.
   *
   * Extraído, e não envolvido no lugar, porque `withSpan` recebe um callback e
   * `break` não atravessa fronteira de função: o corpo devolve `'stop'` onde
   * antes dava `break`, e o laço abaixo lê esse valor. A indentação do corpo é
   * a mesma de antes — o `diff` desta mudança é a primeira linha, a última, e
   * os três `break`.
   *
   * Uma arrow function que fecha sobre os acumuladores do turno
   * (`conversation`, `toolSummaries`, `exitReason`, …) em vez de recebê-los:
   * são os mesmos objetos de antes, no mesmo escopo de antes.
   */
  const runIteration = async (i: number): Promise<'stop' | 'continue'> => {
    // Issue #504 §Fencing — LIMITE DE EFEITO, no topo de cada iteração.
    //
    // O dispatcher e o outbound já recusam individualmente; este guard existe
    // porque a review apontou o custo ANTES deles: "o worker antigo pode
    // continuar chamando LLM". Uma iteração de ReAct é um round-trip pago ao
    // provedor e mais uma volta de raciocínio em nome de um turno que não é
    // mais nosso. Perguntar aqui é a diferença entre parar e apenas ser
    // barrado.
    //
    // Lança em vez de sair do laço com um `exitReason`: sair devolveria um
    // resultado que `decideTurnAction` traduziria em conclusão ou retry — duas
    // escritas de estado que esta tentativa não tem mais autoridade para fazer.
    // Quem tem a lease decide o desfecho. `core.ts` captura este erro e retorna
    // sem concluir.
    assertTurnOwnership('react_iteration');
    const reasonerResult = await runCognitiveModule(
      {
        name: 'reasoner',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 30000,
        conversa_id: c.id,
        turno_id: inbound.id,
        // Issue #507 — o sinal da TENTATIVA entra no runner.
        //
        // O guard acima recusa uma iteração NOVA. Ele não alcança a chamada JÁ
        // EM VOO: perdida a lease no meio do round-trip do reasoner — que é o
        // trecho mais longo do turno, logo o instante mais provável — o
        // provedor seguia gerando e sendo cobrado até o fim, e o
        // `cognitive_module_log` registrava `success` para um turno que já não
        // era nosso. O sinal aqui é o que transforma isso em cancelamento.
        signal: turnSignal,
      },
      (signal) =>
        callLLM({
          // Issue #508: workload declarado → o backend decide tier, política
          // de retry e se fallback é permitido (src/lib/llm/workloads.ts).
          workload: 'reasoner',
          system,
          messages: conversation,
          tools,
          max_tokens: 1024,
          pessoa_id: pessoa.id,
          // Issue #507 — sem ESTA linha o resto é decoração: o gateway já
          // cancela provider, retry, backoff e fallback quando recebe o sinal
          // (`src/lib/llm/gateway.ts`), e o runner já compõe o sinal — mas o
          // `Promise.race` sozinho apenas devolve ao caller enquanto a
          // requisição HTTP continua viva.
          signal,
        }),
    );

    // Issue #507 — CANCELAMENTO NÃO É FALHA DE RACIOCÍNIO.
    //
    // Sem este ramo, `output: null` cairia no `if (!res)` abaixo e o turno
    // sairia como `reasoner_failed` — que `core.ts` traduz em RETRY. Reenfileirar
    // um turno cuja lease pertence a outro worker é exatamente a gravação que a
    // #504 proíbe, agora escrita por engano de vocabulário.
    //
    // Lança pelo mesmo motivo do guard do topo: quem tem a lease decide o
    // desfecho, e `core.ts:1526` sai sem concluir, sem retry e sem carimbar
    // `processada_em`. Se o sinal tiver vindo de outra fonte que não a perda de
    // posse, `assertTurnOwnership` não lança e o fluxo segue para o tratamento
    // de `!res` — conservador de propósito.
    if (reasonerResult.status === 'cancelled') {
      assertTurnOwnership('react_reasoner');
    }

    const res = reasonerResult.output;
    if (!res) {
      // Reasoner falhou (timeout/erro) — encerra loop com resposta vazia.
      // Não joga exception nem trava o worker; turn termina sem reply útil.
      logger.warn(
        { conversa_id: c.id, mensagem_id: inbound.id, status: reasonerResult.status },
        'react_loop.reasoner_failed',
      );
      // #503 cenário A: o turno NÃO está concluído — nada foi produzido nem
      // entregue. O caller agenda retry em vez de marcar `completed`.
      saida.motivo = 'reasoner_failed';
      return 'stop';
    }
    totalTokens += res.usage.input_tokens + res.usage.output_tokens;

    if (res.tool_uses.length === 0) {
      const rawText = res.content?.trim() ?? '';
      // [P88-C4] Prepend the role-switch announcement (if any) to the
      // final outbound. Only attaches when the model actually produced
      // text — an empty turn stays empty (no orphan announcement bubble).
      const prefix = params.outboundPrefix;
      const text =
        rawText && typeof prefix === 'string' && prefix.length > 0
          ? `${prefix}\n\n${rawText}`
          : rawText;
      outboundText = text;
      // P02.2: a deliberação termina AQUI. O candidato fica registrado e a
      // entrega acontece depois do laço — ver `candidato` lá em cima.
      candidato.atual = { rawText, text };
      return 'stop';
    }

    // Append assistant turn with tool uses
    conversation.push({
      role: 'assistant',
      content: res.tool_uses.map((tu) => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.tool,
        input: tu.args,
      })),
    });

    // Execute tools and add results
    const results = [];
    for (const tu of res.tool_uses) {
      // Superpowers I4 (PR #74): capture the dispatch START timestamp so the
      // summary's `occurred_at` reflects when the side effect was requested,
      // not when it completed. Matters for long-running tools whose
      // completion straddles the events-block 24h window boundary.
      const dispatched_at = Date.now();
      const out = await dispatchTool({
        tool: tu.tool,
        args: tu.args,
        ctx: {
          pessoa,
          scope: params.scope,
          conversa: c,
          mensagem_id: inbound.id,
          request_id: uuid(),
        },
      });
      const isError = typeof out === 'object' && out !== null && 'error' in out;

      // Issue #504 §Fencing — a RECUSA POR POSSE ENCERRA A TENTATIVA.
      //
      // O dispatcher recusa devolvendo `{ error }` (o contrato dele; um throw
      // seria lido pelo caller como quebra de plataforma). O efeito colateral
      // disso era o ReAct tratar a perda da lease como erro comum de tool:
      // seguia montando resumo, auditava a chamada e, sem outbound, o
      // `flushUnconfirmedToolSummaries()` do fim do laço criava uma row nova em
      // `mensagens`. Três gravações depois de o turno já não ser nosso — o
      // oposto de "perda de lease impede gravações posteriores".
      //
      // Traduzimos a recusa para o vocabulário que o CORE já entende: o catch
      // dedicado de `src/agent/core.ts:1496` sai sem concluir, sem retry e sem
      // carimbar `processada_em`. Quem tem a lease decide o desfecho.
      //
      // ANTES de `sideEffectsCommitted`, de `toolsCalled`, do `audit()` e do
      // `results.push` de propósito: cada um deles é estado ou gravação desta
      // tentativa, e nenhum lhe pertence mais.
      if (isError && (out as { error: unknown }).error === 'turn_ownership_lost') {
        throw new TurnOwnershipLostError(
          'react_tool_refused',
          getTurnExecutionContext()?.turn_id ?? null,
        );
      }

      // Issue #503 — RASTREIO DE EFEITO IRREVERSÍVEL. Uma tool `write` ou
      // `communication` pode ter alterado estado externo (transação criada,
      // mensagem enviada). Se o turno falhar DEPOIS disso, reexecutar o ReAct
      // duplicaria o efeito, então o turno não pode ser `retryable`.
      //
      // Deliberadamente conservador: marcamos na INVOCAÇÃO, não no sucesso. Um
      // `isError` do dispatcher não prova que nada foi aplicado (pode ter
      // falhado depois do commit externo), e o custo de errar para o lado
      // seguro é uma intervenção manual; para o outro lado é cobrar o cliente
      // duas vezes.
      const spec = REGISTRY[tu.tool];
      if (spec?.side_effect === 'write' || spec?.side_effect === 'communication') {
        sideEffectsCommitted = true;
      }

      // P3b Task 9: capture every tool invocation for the post-turn
      // step-evaluator (tool_result success criteria).
      toolsCalled.push({ name: tu.tool, result: out });

      // Estado ANTES desta chamada, para o receipt registrar o DELTA dela.
      // Sem isto, a segunda chamada de um turno reafirmaria o pending que a
      // primeira abriu, e o journal passaria a atribuir a cada chamada tudo
      // que aconteceu antes dela.
      const pendingAntes = latestPending;
      const pdfAntes = latestReportPdf;

      // B0: capture the freshly-created pending id, with re-validation against
      // the dispatcher's 5-min idempotency cache.
      if (
        tu.tool === 'ask_pending_question' &&
        typeof out === 'object' &&
        out !== null &&
        'pending_question_id' in out &&
        typeof (out as { pending_question_id: string }).pending_question_id === 'string'
      ) {
        const candidate = out as {
          pending_question_id: string;
          opcoes_validas: Array<{ key: string; label: string }>;
        };
        // Re-validate that the candidate is still 'aberta'. Defends against
        // dispatcher-cache returning a stale id from a prior retry within the
        // 5-min idempotency bucket.
        const stillActive = await pendingQuestionsRepo.findActiveSnapshot(c.id).catch(() => null);
        if (stillActive && stillActive.id === candidate.pending_question_id) {
          latestPending = {
            id: candidate.pending_question_id,
            opcoes_validas: candidate.opcoes_validas,
          };
        } else {
          logger.warn(
            { tool: tu.tool, candidate: candidate.pending_question_id, conversa_id: c.id },
            'agent.stale_pending_id_dropped',
          );
        }
      }

      // Sub-A: silent ack via reaction on side-effect tool outcomes.
      const tool = REGISTRY[tu.tool];
      // B3a: track sensitive tools dispatched in this turn. The dedup guard
      // (`!sensitiveTools.includes`) keeps the audit's `sensitive_tools`
      // list as a unique set even when the LLM dispatches the same tool
      // multiple times (e.g., balance for two entidade_ids).
      if (tool?.sensitive && !sensitiveTools.includes(tu.tool)) {
        turnHasSensitive = true;
        sensitiveTools.push(tu.tool);
      }

      // B3b: capture PDF report result for outbound document send.
      if (
        tu.tool === 'generate_report' &&
        !isError &&
        typeof out === 'object' &&
        out !== null &&
        'path' in out &&
        'fileName' in out &&
        'mimetype' in out &&
        'tipo' in out
      ) {
        const r = out as {
          path: string;
          fileName: string;
          mimetype: string;
          tipo: 'extrato' | 'comparativo';
        };
        latestReportPdf = {
          path: r.path,
          fileName: r.fileName,
          mimetype: r.mimetype,
          tipo: r.tipo,
        };
      }
      const isSideEffect =
        tool && (tool.side_effect === 'write' || tool.side_effect === 'communication');
      if (isSideEffect) {
        const wid = (inbound.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
        if (typeof wid === 'string') {
          // Fase 0 (spec roteamento v4 §1.6): reação (efêmera) sai pela
          // fronteira LineOutput do canal da conversa. Best-effort — falha de
          // resolução só suprime a reação, nunca o turno.
          const emoji: '✅' | '❌' | null = !isError
            ? '✅'
            : ['forbidden', 'requires_dual_approval'].includes((out as { error: string }).error)
              ? '❌'
              : null;
          if (emoji) {
            // #634 — exceção INVENTARIADA (`agent.react_loop_tool_reaction`):
            // sinal EFÊMERO sobre a mensagem de ENTRADA. A primitiva do Baileys
            // devolve `void`, então um artefato durável para ela nasceria em
            // `delivery_unknown` e alimentaria a reconciliação humana de #633
            // com ruído. Ver `send-paths.ts`.
            await forCurrentAgentChannel(c.channel_id)
              .then((line) =>
                withDeclaredEgressExceptionSync('agent.react_loop_tool_reaction', () =>
                  line.sendReaction(jid, wid, emoji),
                ),
              )
              .catch((err) =>
                logger.debug(
                  { err: (err as Error).message },
                  'react_loop.reaction_line_unresolved',
                ),
              );
          }
        }
      }

      results.push({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: isError,
      });

      // Issue #73 — accumulate a structured summary for next-turn persistence.
      // Side-effect 'none' tools (parse_only) still get summarized to keep
      // the audit trail intact; the prompt-builder events-block filters by
      // priority later.
      const summary = buildToolSummary({
        tool_call_id: tu.id,
        tool_name: tu.tool,
        side_effect: tool?.side_effect ?? 'none',
        args: tu.args,
        result: out,
        status: isError ? 'error' : 'success',
        dispatched_at,
      });
      toolSummaries.push(summary);

      /**
       * P02 (§5.9.2.1) — O RECEIPT.
       *
       * Um por chamada DESPACHADA, na ordem em que despachamos. É o que o
       * `EngineResultAssembler` lê para montar o resultado do turno, e a razão
       * de ele existir aqui em vez de ser derivado depois: o que prova a
       * chamada é o dispatcher ter rodado, não o laço ter lembrado.
       *
       * `pending` e `report_pdf` entram como DELTA desta chamada — o assembler
       * é quem decide que o último vence. Gravar o acumulado aqui faria toda
       * chamada posterior reafirmar um pending que não foi dela.
       */
      receipts.push({
        call_id: tu.id,
        ordinal: receipts.length,
        tool_name: tu.tool,
        result: out,
        status: isError ? 'error' : 'success',
        side_effect: tool?.side_effect ?? null,
        sensitive: tool?.sensitive === true,
        summary,
        pending: latestPending !== pendingAntes ? latestPending : null,
        report_pdf: latestReportPdf !== pdfAntes ? latestReportPdf : null,
      });

      await audit({
        acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { tool: tu.tool },
      });
    }
    conversation.push({ role: 'user', content: results });
    // If we completed the final iteration with tool_uses, we'll exit the
    // for-loop without dispatching outbound. Mark for the flush path.
    if (i === MAX_REACT_ITERATIONS - 1) {
      saida.motivo = 'iteration_cap';
    }
    return 'continue';
  };

  // Issue #535 — UM span por iteração, e ele é o pai declarado de
  // `llm.request` e de `tool.dispatch`. Até aqui esses dois — os únicos spans
  // que já saíam desta região — se penduravam direto em `turn`: um turno com
  // três iterações e cinco tools virava uma fileira plana de oito irmãos, sem
  // nada dizendo qual chamada ao modelo levou a quais tools. Com este escopo
  // aberto no ALS eles aninham, e "o segundo round-trip é o lento" passa a ser
  // legível na waterfall em vez de inferível pelos timestamps.
  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    iteracoes = i + 1;
    const step = await instrumentReactIteration(i + 1, () => runIteration(i));
    if (step === 'stop') break;
  }

  // ─── FACHADA DE SAÍDA (P02.2) ─────────────────────────────────────────────
  //
  // O que era o miolo do `if (text)` da iteração, agora DEPOIS da deliberação.
  // A ordem preservada é deliberada: `outboundText` já foi atribuído no laço
  // (antes de qualquer tentativa de envio), o `not_sent` continua encerrando
  // sem marcar entrega, o `sent_no_persist` continua marcando incerteza E
  // entrega, e a reflexão de lacuna continua acontecendo SÓ quando algo chegou
  // ao usuário — nunca depois de uma falha pre-send.
  // Capturado numa const: o acumulador é um container mutável porque a
  // atribuição acontece dentro da closure da iteração, e o compilador não
  // acompanha atribuições através dessa fronteira.
  /**
   * P02 (§5.2, §5.9.2) — A ENTREGA MUDOU DE DONO.
   *
   * O que estava aqui — `safeDispatchOutput`, a classificação do desfecho, o
   * gatilho de lacuna e o flush de sumários — virou `coordinateOutput`
   * (`@/runtime/engines/coordinator.js`), e o laço passou a CHAMÁ-LO.
   *
   * O call site continua sendo este, de propósito. Arrancar a fachada para o
   * `core.ts` de uma vez obrigaria a reescrever os 37 casos de caracterização
   * que provam o comportamento atual — e o ponto de uma extração é preservar
   * comportamento, não trocar a prova dele. Aqui o que muda é QUEM entrega; o
   * que se observa de fora é o mesmo.
   *
   * O ganho é que o coordenador deixa de ser código sem chamador: quando o
   * motor remoto entrar, ele chega no mesmo assembler e no mesmo coordenador,
   * por um caminho que já roda em produção todo dia.
   */
  const proposta = candidato.atual;
  const assembled = assembleTurnResult({
    proposal: {
      version: 1,
      run_id: getTurnExecutionContext()?.turn_id ?? ZERO_UUID,
      request_key: ZERO_UUID,
      stop: proposta
        ? { kind: 'reply', raw_text: proposta.rawText }
        : saida.motivo === 'reasoner_failed'
          ? { kind: 'failed', code: 'reasoner_failed' }
          : {
              kind: 'no_reply',
              reason: saida.motivo === 'iteration_cap' ? 'iteration_cap' : 'empty_final_text',
            },
      iterations: iteracoes,
      // O laço LOCAL não afirma nada além do que gravou: a lista de ids
      // afirmados é a própria lista de receipts, então a divergência é
      // estruturalmente `none`. Num motor remoto as duas podem diferir, e é
      // exatamente essa diferença que o assembler existe para pegar.
      observed_tool_call_ids: receipts.map((r) => r.call_id),
      usage: {
        input_tokens: null,
        output_tokens: totalTokens > 0 ? totalTokens : null,
        cost_microusd: null,
        source: 'engine_reported',
      },
    },
    receipts,
    outboundPrefix: params.outboundPrefix ?? null,
  });

  const coordenado = await coordinateOutput({ pessoa, conversa: c, inbound, jid }, assembled, {
    dispatch: safeDispatchOutput,
    flushUnconfirmedToolSummaries: (conversa_id, inbound_id, summaries, reason) =>
      flushUnconfirmedToolSummaries(conversa_id, inbound_id, summaries, reason),
    onDelivered: (rawText) =>
      dispararReflexaoDeLacuna(rawText, {
        conversa_id: c.id,
        inbound_id: inbound.id,
        pessoa_id: pessoa.id,
      }),
  });

  return {
    totalTokens,
    // `outboundText` continua sendo o texto MONTADO no laço, e não o do
    // coordenador: ele é lido por quem só quer saber o que o modelo produziu,
    // inclusive quando o envio falhou.
    outboundText,
    toolsCalled,
    delivery: {
      ...coordenado.delivery,
      // O efeito irreversível é rastreado na INVOCAÇÃO pelo laço (linha do
      // `spec?.side_effect`), que é mais conservador que derivá-lo do receipt:
      // ele marca mesmo quando o receipt não chegou a ser construído.
      sideEffectsCommitted,
    },
  };
}
