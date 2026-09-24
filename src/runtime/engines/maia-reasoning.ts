/**
 * SC01 (spec §5.2, §5.3.1, §5.4.2) — `runReasoning`: o RACIOCÍNIO do motor local,
 * atrás da porta.
 *
 * ─── O que saiu de `runReActLoop` e o que ficou ─────────────────────────────
 *
 * Antes da extração, `runReActLoop` fazia três coisas no mesmo corpo: iterava o
 * reasoner, DESPACHAVA as ferramentas e ENTREGAVA a resposta. Este módulo é a
 * primeira delas — e só ela. Ele não conhece `safeDispatchOutput`, não decide
 * desfecho de turno, não conclui run. Devolve uma `ReasoningOutcomeV1`: por que
 * parou, quantas iterações rodou, quais chamadas de ferramenta afirma ter feito
 * e o uso reportado.
 *
 * ─── As duas fronteiras que ele atravessa ───────────────────────────────────
 *
 * 1. **O provedor** — `runCognitiveModule` + `callLLM`, exatamente como antes:
 *    mesmo `workload: 'reasoner'`, mesmo `max_tokens: 1024`, mesmo sinal da
 *    tentativa. O gateway de LLM da casa continua sendo o dono de tier, retry,
 *    backoff e fallback (§5.2, "adapter local mantém `runCognitiveModule` e
 *    gateway LLM").
 * 2. **A ferramenta** — via `io.invokeTool`, e NÃO mais por `dispatchTool`
 *    direto. Essa troca é o ponto: quem despacha, governa e REGISTRA é a Maia
 *    (`EngineToolGateway`), e é o receipt dela que o assembler lê depois. O
 *    raciocínio só sabe pedir; ele não tem como afirmar efeito que ninguém
 *    despachou.
 *
 * ─── O que este módulo deliberadamente NÃO faz ──────────────────────────────
 *
 * - Não entrega, não audita entrega, não dispara reflexão de lacuna. Reações,
 *   auditoria por tool-use e o hook de lacuna continuam em Maia — reações e
 *   auditoria no gateway, lacuna no coordenador (§5.2: "Reações/gap/reflection
 *   deixam o loop mas continuam em hooks Maia").
 * - Não constrói `ReActDelivery`. O adaptador de compatibilidade local constrói
 *   a máscara de entrega **depois** do coordenador (§5.4.2) — o motor nunca
 *   recebe essa função.
 * - Não decide o que fazer com perda de posse. `assertTurnOwnership` lança
 *   (o guard real do turno), o gateway traduz a recusa do dispatcher, e quem
 *   tem a lease decide o desfecho mais acima.
 *
 * ─── Por que os ids do host vêm de um escopo de ALS ─────────────────────────
 *
 * `runCognitiveModule` grava `cognitive_module_log` chaveado por
 * `conversa_id`/`turno_id`, e o `pessoa_id` acompanha a chamada ao provedor.
 * Nada disso pertence a `EngineRequestV1` (§5.3.1: identidade e claim token são
 * exclusivamente da Maia). O host do turno é ligado pelo stage em
 * `./local-engine-host.js` — composição do processo, nunca transporte.
 */
import { callLLM } from '@/lib/claude.js';
import type { LLMMessage } from '@/lib/llm/types.js';
import { logger } from '@/lib/logger.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { instrumentReactIteration } from '@/observability/instrumentation.js';
import { assertTurnOwnership, getTurnExecutionContext } from '@/runtime/turns/execution-context.js';
import type {
  EngineRequestV1,
  EngineStopV1,
  EngineToolCallV1,
  EngineToolReplyV1,
} from './contracts.js';
import type { ReasoningOutcomeV1, RunReasoningV1 } from './maia-engine.js';
import { currentLocalEngineHost } from './local-engine-host.js';

/**
 * Teto de iterações do motor LOCAL.
 *
 * É um limite do raciocínio, não da porta: um motor remoto traz o teto dele no
 * pedido (`request.limits.max_iterations`) e o supervisor revalida. Aqui o valor
 * tem de permanecer 5 — `tests/unit/react-loop-characterization.spec.ts` e
 * `tests/integration/turn-lease-lost-react-loop-real-db.spec.ts` contam as cinco
 * iterações para provar o rastro pós-iteração (§5.1.1).
 */
export const MAX_REACT_ITERATIONS = 5;

/** Resposta do dispatcher empacotada como `tool_result` do protocolo. */
function conteudoDoReply(reply: EngineToolReplyV1): { content: string; is_error: boolean } {
  switch (reply.kind) {
    case 'result':
      return { content: JSON.stringify(reply.result), is_error: reply.is_error };
    case 'refused':
      // Recusa NÃO é resultado: o handler não rodou. Vira erro visível para o
      // modelo (ele não pode acreditar que a ferramenta aconteceu) e a chamada
      // fica FORA de `observed_tool_call_ids` — o motor não pode afirmar uma
      // chamada que a Maia não journalou.
      return { content: JSON.stringify({ error: reply.code }), is_error: true };
    case 'in_progress':
      // Sem retry interno no piloto: uma tool que ainda não terminou é reportada
      // como indisponível em vez de inventar um resultado.
      return {
        content: JSON.stringify({ error: 'tool_reply_in_progress_unsupported' }),
        is_error: true,
      };
  }
}

export const runReasoning: RunReasoningV1 = async (
  request: EngineRequestV1,
  io,
): Promise<ReasoningOutcomeV1> => {
  const host = currentLocalEngineHost();
  /**
   * O MESMO array de mensagens do pedido, mutado in-place.
   *
   * Não é descuido: `runReActLoop` sempre empilhou os turnos de assistant/tool
   * no array do caller, e a caracterização pina isso. Copiar mudaria o que o
   * chamador observa depois do turno — comportamento, não implementação.
   */
  const conversation: LLMMessage[] = request.context.messages;
  const { system, tools } = request.context;

  let totalTokens = 0;
  /** Iterações efetivamente executadas — entra na proposta terminal. */
  let iteracoes = 0;
  const observadas: string[] = [];
  /** Chamadas de ferramenta pedidas ao gateway, 0-based — régua do ordinal. */
  let chamadas = 0;
  /** O desfecho deliberativo, atribuído dentro da closure de iteração. */
  const saida: { stop: EngineStopV1 | null } = { stop: null };
  /** Teto de iterações alcançado com ferramentas executadas. */
  const cap: { atingido: boolean } = { atingido: false };

  // Issue #507 — o sinal da tentativa, lido UMA vez, como antes da extração.
  const turnSignal = getTurnExecutionContext()?.signal;

  const runIteration = async (i: number): Promise<'stop' | 'continue'> => {
    // Issue #504 §Fencing — LIMITE DE EFEITO, no topo de cada iteração.
    // Uma iteração nova é um round-trip pago em nome de um turno que pode já
    // não ser nosso. Lança, em vez de sair com um motivo: quem tem a lease
    // decide o desfecho, e "reasoner_failed" viraria RETRY de turno alheio.
    assertTurnOwnership('react_iteration');

    const reasonerResult = await runCognitiveModule(
      {
        name: 'reasoner',
        version: 'v1',
        triggered_by: 'sync_required',
        timeoutMs: 30000,
        conversa_id: host?.conversa_id ?? request.run_id,
        turno_id: host?.turno_id ?? request.run_id,
        signal: turnSignal,
      },
      (signal) =>
        callLLM({
          workload: 'reasoner',
          system,
          messages: conversation,
          tools,
          max_tokens: 1024,
          pessoa_id: host?.pessoa_id ?? request.run_id,
          signal,
        }),
    );

    // Issue #507 — cancelamento NÃO é falha de raciocínio: cai no guard real
    // para que a perda de posse seja decidida por quem tem a lease.
    if (reasonerResult.status === 'cancelled') {
      assertTurnOwnership('react_reasoner');
    }

    const res = reasonerResult.output;
    if (!res) {
      // Reasoner falhou (timeout/erro) — encerra o loop com resposta vazia.
      // Não joga exception nem trava o worker; o turno termina sem reply útil.
      // O log é parte do comportamento congelado pela caracterização: é ele que
      // distingue "o modelo não respondeu" de "o turno não rodou".
      logger.warn(
        {
          conversa_id: host?.conversa_id ?? request.run_id,
          mensagem_id: host?.turno_id ?? request.run_id,
          status: reasonerResult.status,
        },
        'react_loop.reasoner_failed',
      );
      // #503 cenário A: o turno NÃO está concluído — nada foi produzido nem
      // entregue. O caller agenda retry em vez de marcar `completed`.
      saida.stop = { kind: 'failed', code: 'reasoner_failed' };
      return 'stop';
    }
    totalTokens += res.usage.input_tokens + res.usage.output_tokens;

    if (res.tool_uses.length === 0) {
      const rawText = res.content?.trim() ?? '';
      /**
       * Texto vazio NÃO é `reply`. O schema estrito da proposta
       * (`./schemas.js`, `engineStopV1Schema`) recusa `reply` com texto que
       * fica vazio depois do trim — e por um motivo de produto: um turno sem
       * texto não tem nada a entregar, e chamá-lo de "resposta" convidaria o
       * coordenador a despachar um balão vazio (ou só o prefixo de role).
       * `no_reply/empty_final_text` é o vocabulário que o `decideTurnAction`
       * já traduz para `no_reply_produced` sem retry.
       */
      saida.stop =
        rawText.length > 0
          ? { kind: 'reply', raw_text: rawText }
          : { kind: 'no_reply', reason: 'empty_final_text' };
      return 'stop';
    }

    conversation.push({
      role: 'assistant',
      content: res.tool_uses.map((tu) => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.tool,
        input: tu.args,
      })),
    });

    const results = [];
    for (const tu of res.tool_uses) {
      /**
       * O ordinal é do MOTOR e é 0-based por run, sem lacunas (§5.3.1) — é a
       * mesma régua do receipt no journal. Contador próprio, e não
       * `observadas.length`: uma recusa não vira receipt e uma contagem por
       * sucesso faria a chamada seguinte reusar o ordinal da recusada.
       */
      const ordinal = chamadas;
      chamadas += 1;
      const reply = await io.invokeTool({
        version: 1,
        run_id: request.run_id,
        call_id: tu.id,
        ordinal,
        // 1-based quando presente (schema `engineToolCallV1Schema`); é
        // telemetria, nunca a régua de nada.
        iteration: i + 1,
        name: tu.tool,
        args: tu.args as EngineToolCallV1['args'],
      });
      if (reply.kind === 'result') observadas.push(tu.id);
      const { content, is_error } = conteudoDoReply(reply);
      results.push({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content,
        is_error,
      });
    }
    conversation.push({ role: 'user', content: results });

    if (i === MAX_REACT_ITERATIONS - 1) cap.atingido = true;
    return 'continue';
  };

  // Issue #535 — UM span por iteração, 1-based, como antes da extração.
  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    iteracoes = i + 1;
    const step = await instrumentReactIteration(i + 1, () => runIteration(i));
    if (step === 'stop') break;
  }

  const stop: EngineStopV1 = saida.stop ?? {
    kind: 'no_reply',
    reason: cap.atingido ? 'iteration_cap' : 'empty_final_text',
  };

  return {
    stop,
    iterations: iteracoes,
    observed_tool_call_ids: observadas,
    usage: {
      input_tokens: null,
      output_tokens: totalTokens > 0 ? totalTokens : null,
      cost_microusd: null,
      source: 'engine_reported',
    },
  };
};