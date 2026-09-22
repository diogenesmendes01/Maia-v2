/**
 * P05 (spec §5.2, §6.9.1) — `EngineToolGateway`: o que transforma a decisão do
 * broker em execução.
 *
 * ─── A fronteira que este módulo materializa ────────────────────────────────
 *
 * `decideToolCall` (`./tool-broker.ts`) é puro e diz, no próprio docstring, o
 * que NÃO decide: lease viva, deadline, epoch de controle humano, orçamento,
 * idempotência e efeito. O `admit` dele significa "nenhuma regra ESTÁTICA
 * barra" — nunca "pode executar". Entre esse `admit` e o handler existe uma
 * releitura obrigatória do banco (§6.9.1 item 2), e é ela que este módulo faz.
 *
 * Ou seja: o broker responde sobre o CATÁLOGO, o gateway responde sobre o
 * MUNDO. Juntar os dois num módulo só teria colapsado uma decisão pura e
 * testável numa que precisa de banco — e a parte pura é justamente a que se
 * consegue provar.
 *
 * ─── Por que ele tem a forma de `invokeTool` ────────────────────────────────
 *
 * A assinatura de saída é exatamente `EngineIOV1.invokeTool`. Não é
 * coincidência: o gateway É o `invokeTool` que o motor recebe. O motor — local
 * ou remoto — nunca fala com `dispatchTool`; ele fala com esta função, que é a
 * única porta pela qual uma chamada de ferramenta atravessa para o lado da
 * Maia. Um motor que conseguisse chamar o dispatcher direto tornaria todo o
 * resto decorativo.
 *
 * ─── A segunda linha de defesa ──────────────────────────────────────────────
 *
 * `dispatchTool` tem o próprio fence de posse (#504) e ele NÃO é removido nem
 * duplicado aqui. Os dois existem porque respondem a perguntas diferentes: o
 * gateway pergunta "esta chamada foi admitida por ESTE run, nesta ordem, com
 * estes argumentos?", e o dispatcher pergunta "esta tentativa ainda é dona do
 * turno no instante do efeito?". A segunda continua sendo a última palavra.
 */
import type { EngineToolCallV1, EngineToolReplyV1, Json } from '@/runtime/engines/contracts.js';
import type { ToolAdmissionV1 } from './tool-broker.js';
import type {
  ToolCallAdmission,
  ToolClassification,
  ToolSettlement,
  FreezeIdentityResult,
  HandlerStartedResult,
} from '@/db/repositories/engine-repos.js';
import type { ToolContext, DispatchResult } from '@/tools/_dispatcher.js';
import { logger } from '@/lib/logger.js';
import { canonicalDigest } from './canonical-json.js';

/** Identidade durável do run, resolvida uma vez e usada em toda chamada. */
export type GatewayRunIdentityV1 = {
  run_id: string;
  turn_id: string;
  /** Fence da tentativa que ORIGINOU o run (§5.7.1). */
  origin_claim_token: string;
  request_id: string;
};

/**
 * Dependências injetadas.
 *
 * Elas existem pela mesma razão que em `MaiaEngine`: sem injeção, exercitar o
 * gateway exigiria banco, dispatcher e manifest reais, e o que se prova de um
 * caminho assim é quase nada. Com injeção, cada desfecho do §6.9.1 vira um
 * caso.
 */
export type ToolGatewayDepsV1 = {
  /** A decisão ESTÁTICA. Pura; ver `decideToolCall`. */
  decide: (call: EngineToolCallV1) => ToolAdmissionV1;
  /** Releitura do banco: lease, deadline, controle, ordem, idempotência. */
  admit: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    request_id: string;
    call: { call_id: string; ordinal: number; iteration: number | null; name: string; args: Json };
  }) => Promise<ToolCallAdmission>;
  /** Congela a classificação de efeito antes do handler (§5.7.4). */
  markDispatching: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    classification: ToolClassification;
  }) => Promise<
    { ok: true; dispatch_token: string; row_version: number } | { ok: false; reason: string }
  >;
  /** Congela a identidade de idempotência (§5.6.3). */
  freezeToolIdentity: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    idempotency_key: string;
    idempotency_payload_hash: string;
    normalized_args: Json;
  }) => Promise<FreezeIdentityResult>;
  /** Marca que o handler começou a rodar (§5.6.4). */
  markToolHandlerStarted: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    reservation_token: string;
    approval_claim_token?: string | null;
  }) => Promise<HandlerStartedResult>;
  /** Liquida a chamada com o desfecho observado (§5.7.4). */
  settle: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    outcome: ToolSettlement;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** O dispatcher da casa. Mantém o PRÓPRIO fence de posse. */
  dispatch: (input: { tool: string; args: unknown; ctx: ToolContext }) => Promise<DispatchResult>;
  /** Item 4 do §6.9.1: contexto derivado do BINDING, não do frame. */
  buildToolContext: (call: EngineToolCallV1) => Promise<ToolContext>;
  /** Classificação da tool no registry da casa. */
  classify: (toolName: string) => ToolClassification | null;
  /**
   * Quanto o motor espera antes de reperguntar por uma chamada que ainda não
   * tem desfecho. Ver a nota sobre `defer` mais abaixo.
   */
  retryAfterMs?: number;
  /**
   * A auditoria da recusa (T19).
   *
   * Injetada como as demais dependências, e por um motivo que não é só
   * testabilidade: `@/governance/audit.js` resolve tenant e agent pelo ALS, e
   * amarrá-lo estaticamente aqui tornaria este módulo — que é puro fora das
   * deps — dependente de contexto de execução para ser importado.
   *
   * Opcional para que um caller que já audita noutro ponto não duplique a
   * linha. Ausente, a recusa continua acontecendo: o que se perde é a trilha,
   * e o caller assume essa escolha explicitamente ao não passar a dependência.
   */
  audit?: (input: {
    acao: 'unauthorized_access_attempt';
    alvo_id: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Abre (ou reencontra) o pedido de aprovação humana de uma chamada adiada.
   *
   * T30 — "o gate Maia permanece". O caller liga isto a
   * `ensureApprovalRequest` (`@/governance/approval-requests.js`), a MESMA
   * máquina do dispatcher: mesmo `intent_hash`, mesma deduplicação por
   * impressão digital. A dedupe é o que faz o repolling do motor reencontrar o
   * pedido em vez de encher a fila do humano com a mesma decisão.
   *
   * Não decide a classe de aprovação: quem sabe se é `requester_plus_one_owner`
   * ou `two_distinct_owners` é `dualClassFor`, com a pessoa na mão — e a pessoa
   * é contexto do turno, que este módulo não carrega.
   */
  ensureApproval?: (input: {
    call: EngineToolCallV1;
    run_id: string;
  }) => Promise<{ ref: string; created: boolean }>;
};

const RETRY_PADRAO_MS = 30_000;

/** Resultado do dispatcher que representa erro do handler, não do transporte. */
function ehErroDeHandler(r: DispatchResult): boolean {
  return typeof r === 'object' && r !== null && 'error' in r;
}

/**
 * Traduz o conflito da admissão para o vocabulário FECHADO do wire.
 *
 * O wire tem seis códigos e o banco tem mais motivos que isso. A tradução
 * agrupa de propósito: um motor não precisa distinguir "a lease morreu" de "o
 * epoch de controle mudou" — nos dois casos ele não está autorizado a agir, e
 * detalhar a diferença contaria ao lado não autorizado o estado interno do
 * turno. O detalhe fica no log, do lado de cá.
 */
function recusaDoWire(
  admissao: Extract<ToolCallAdmission, { ok: false }>,
): Extract<EngineToolReplyV1, { kind: 'refused' }>['code'] {
  return admissao.reason === 'payload_conflict' ? 'payload_conflict' : 'run_not_authorized';
}

/**
 * `row_version` de uma chamada recém-admitida.
 *
 * A coluna nasce `DEFAULT 0` na 140 (`engine_tool_calls`), e o congelamento da
 * classificação é a PRIMEIRA escrita depois da admissão. Nomear o valor em vez
 * de chumbar um `0` no call site é o que liga essa expectativa à migration:
 * quem mudar o default encontra a constante, não um literal solto no meio de
 * um objeto.
 */
const ROW_VERSION_DA_ADMISSAO = 0;

export function createEngineToolGateway(
  identity: GatewayRunIdentityV1,
  deps: ToolGatewayDepsV1,
): (call: EngineToolCallV1) => Promise<EngineToolReplyV1> {
  const retryAfterMs = deps.retryAfterMs ?? RETRY_PADRAO_MS;

  return async function invokeTool(call: EngineToolCallV1): Promise<EngineToolReplyV1> {
    const base = {
      run_id: identity.run_id,
      turn_id: identity.turn_id,
      origin_claim_token: identity.origin_claim_token,
    };

    // ── (1) DECISÃO ESTÁTICA ────────────────────────────────────────────
    const estatica = deps.decide(call);

    if (estatica.kind === 'refuse') {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: estatica.reason },
        'engine.tool_gateway.refused_static',
      );

      /**
       * T19 — a recusa de binding cruzado exige "recusa **E** auditoria".
       *
       * Um log não cumpre isso. Log é diagnóstico: rotaciona, é amostrado, e
       * ninguém responde a uma pergunta de governança lendo log. Uma tentativa
       * de um run agir sobre o binding de OUTRO é evento de autorização, e
       * evento de autorização precisa de linha durável.
       *
       * A ação é `unauthorized_access_attempt`, que já existe e já é usada pelo
       * dispatcher para exatamente esta classe de fato (INV-12: auditoria não
       * se inventa). Cunhar uma ação nova para o mesmo fato partiria as
       * consultas de governança em duas.
       *
       * `await` de propósito: se a auditoria não gravar, a recusa não é
       * silenciosa — o erro sobe. Uma recusa auditada que não auditou é pior
       * que uma recusa ruidosa.
       */
      if (deps.audit !== undefined) {
        await deps.audit({
          acao: 'unauthorized_access_attempt',
          alvo_id: identity.run_id,
          metadata: {
            source: 'engine_tool_gateway',
            call_id: call.call_id,
            tool: call.name,
            reason: estatica.reason,
            wire_code: estatica.wire,
            // `detail` fica FORA: ele é texto livre do broker e pode carregar
            // material do frame. A linha de auditoria diz o QUE foi recusado e
            // por qual regra, não o conteúdo da tentativa.
          },
        });
      }

      return { kind: 'refused', call_id: call.call_id, code: estatica.wire };
    }

    if (estatica.kind === 'defer') {
      /**
       * `approval_required` NÃO tem código no wire (C33 / C-P05-2 — decisão em
       * aberto do dono). Os seis códigos de `refused` não incluem aprovação, e
       * usar um deles diria ao motor algo falso: `tool_not_allowed` afirmaria
       * que a ferramenta não é dele, quando o fato é que ela é e está esperando
       * um humano.
       *
       * Então o wire recebe `in_progress`, que é a única coisa VERDADEIRA que
       * ele sabe expressar: ainda não há desfecho. O estado real —
       * `approval_required` — fica durável no journal, onde o console o lê.
       *
       * Isto é um paliativo declarado, não a solução. Enquanto durar, um
       * motor que espere aprovação fica repolando em `retryAfterMs`. Fechar
       * isso exige abrir o protocolo congelado, que é a PR de Fase 0.
       */
      /**
       * T30 — O GATE DA MAIA PERMANECE.
       *
       * Devolver `in_progress` sem mais nada era pedir ao motor que esperasse
       * por algo que NÃO EXISTIA: nenhum pedido de aprovação era aberto, então
       * nenhum humano tinha o que aprovar, e a espera era infinita por
       * construção. O gate não estava sendo contornado — ele simplesmente não
       * chegava a existir neste caminho.
       *
       * `ensureApproval` é a MESMA máquina que o dispatcher usa
       * (`ensureApprovalRequest`), com o mesmo `intent_hash` e a mesma
       * deduplicação por impressão digital. Isso importa: um caminho paralelo
       * de aprovação seria uma segunda autoridade, e duas autoridades sobre o
       * mesmo efeito é como uma delas acaba sendo contornada.
       *
       * A dedupe por `intent_hash` é o que torna o repolling seguro: a segunda
       * chamada do motor reencontra o MESMO pedido em vez de abrir outro, e o
       * humano não vê a mesma decisão N vezes na fila.
       */
      const aprovacao =
        deps.ensureApproval !== undefined
          ? await deps.ensureApproval({ call, run_id: identity.run_id })
          : null;

      logger.info(
        {
          run_id: identity.run_id,
          call_id: call.call_id,
          tool: call.name,
          approval_ref: aprovacao?.ref ?? null,
          approval_created: aprovacao?.created ?? null,
        },
        'engine.tool_gateway.deferred_pending_approval',
      );

      /**
       * Sem `ensureApproval` o gateway NÃO finge que há aprovação a caminho.
       *
       * `in_progress` diria ao motor "espere, isto vai resolver". Se ninguém
       * abriu pedido, não vai — e o motor repolaria até o deadline do run.
       * `tool_not_allowed` é a verdade disponível no wire: esta chamada não
       * pode prosseguir por este caminho.
       */
      if (aprovacao === null) {
        logger.error(
          { run_id: identity.run_id, call_id: call.call_id, tool: call.name, ops_alert: true },
          'engine.tool_gateway.defer_without_approval_channel',
        );
        return { kind: 'refused', call_id: call.call_id, code: 'tool_not_allowed' };
      }

      return { kind: 'in_progress', call_id: call.call_id, retry_after_ms: retryAfterMs };
    }

    // ── (2) CLASSIFICAÇÃO ESTÁTICA — ANTES DA ADMISSÃO ──────────────────
    //
    // `effect_class: null` NUNCA autoriza handler (§4.1). Uma tool que o
    // registry não classifica é uma tool cujo efeito ninguém sabe descrever, e
    // liberar isso é liberar o desconhecido.
    //
    // Isto roda ANTES de `admit` de propósito (achado de revisão sobre a
    // PR #773): `classify` é ESTÁTICO — vem do registry da casa, não do banco
    // — então ele pode ser checado junto da decisão estática do broker, no
    // mesmo fôlego que `decide`. A alternativa (checar depois de `admit`)
    // deixava a chamada ADMITIDA no journal sem nunca ser finalizada: nenhuma
    // transição de encerramento válida existe para uma chamada admitida que
    // não pode prosseguir por falta de classe, e o revisor foi explícito que
    // liquidar indiscriminadamente ali seria errado — uma recusa de CAS pode
    // significar perda de posse, e não dá para tratar todo caso do mesmo jeito.
    // Recusando ANTES do `admit`, a chamada nunca entra no journal e não há
    // o que reconciliar.
    const classificacao = deps.classify(call.name);
    if (classificacao === null || classificacao.effect_class === null) {
      logger.error(
        { run_id: identity.run_id, call_id: call.call_id, tool: call.name, ops_alert: true },
        'engine.tool_gateway.unclassified_tool_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'tool_not_allowed' };
    }

    // ── (3) RELEITURA DO BANCO (§6.9.1 item 2) ──────────────────────────
    const admissao = await deps.admit({
      ...base,
      request_id: identity.request_id,
      call: {
        call_id: call.call_id,
        ordinal: call.ordinal,
        iteration: call.iteration,
        name: call.name,
        args: call.args,
      },
    });

    if (!admissao.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: admissao.reason },
        'engine.tool_gateway.refused_durable',
      );
      return { kind: 'refused', call_id: call.call_id, code: recusaDoWire(admissao) };
    }

    // Redelivery com o vencedor ainda em voo: journalado, não liberado. NÃO
    // roda o handler de novo — é exatamente a duplicação que o journal existe
    // para impedir.
    if (admissao.kind === 'in_progress') {
      return { kind: 'in_progress', call_id: call.call_id, retry_after_ms: retryAfterMs };
    }

    // Já conciliada: devolve o que está PERSISTIDO. O resultado vem do banco,
    // nunca de reexecutar — mesmo que reexecutar fosse barato, o efeito não é.
    if (admissao.kind === 'receipt') {
      return {
        kind: 'result',
        call_id: call.call_id,
        result: admissao.result,
        is_error: admissao.state === 'denied' || admissao.state === 'effect_unknown',
      };
    }

    // ── (4) CLASSIFICAÇÃO CONGELADA ANTES DO HANDLER ────────────────────
    const congelou = await deps.markDispatching({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: ROW_VERSION_DA_ADMISSAO,
      classification: classificacao,
    });
    if (!congelou.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: congelou.reason },
        'engine.tool_gateway.dispatch_freeze_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (4a) IDENTIDADE DE IDEMPOTÊNCIA CONGELADA (§5.6.3) ──────────────
    // Antes de marcar que o handler começou, é preciso congelar a identidade
    // de idempotência. Isso garante que a chamada é determinística.
    const congelada = await deps.freezeToolIdentity({
      ...base,
      call_id: admissao.call_id,
      idempotency_key: call.call_id,
      idempotency_payload_hash: canonicalDigest(call.args),
      normalized_args: call.args,
    });

    if (!congelada.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: congelada.reason },
        'engine.tool_gateway.freeze_identity_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (4b) CONTEXTO DO HANDLER — ANTES DO MARCADOR ────────────────────
    //
    // `buildToolContext` é resolvido AQUI, antes de `markToolHandlerStarted`
    // (achado de revisão sobre a PR #773). Antes, ele rodava DEPOIS do
    // marcador ter sucesso, fora de qualquer `try`: se rejeitasse, a exceção
    // propagava com o marcador já chamado uma vez, `dispatch` zero e `settle`
    // zero — a chamada ficava carimbada `handler_started` no journal sem
    // nunca ser liquidada, um estado que só reconciliação manual resolve
    // (nada garante, olhando só o journal, se o handler chegou a rodar).
    //
    // Resolvendo o contexto ANTES do marcador, uma falha aqui acontece com a
    // chamada ainda em `dispatching` — estado que não mente sobre o handler
    // ter começado, porque ele DE FATO não começou. Isso é consistente com
    // as demais falhas pré-handler acima (`admit`, `markDispatching`,
    // `freezeToolIdentity`): nenhuma delas é envolvida em `try/catch` aqui,
    // porque nenhuma tem como ter produzido efeito ainda.
    const ctx = await deps.buildToolContext(call);

    // ── (4c) MARCADOR DO HANDLER (§5.6.4) ───────────────────────────────
    // Depois de congelar a identidade E resolver o contexto, marca que o
    // handler vai começar. Isso separa "não começou" de "pode ter começado".
    // A row_version é incrementada neste passo; precisamos dessa versão nova
    // para o settle. A partir daqui, nada mais pode falhar entre o marcador
    // e a tentativa de despachar — é isso que o passo acima garante.
    const marcou = await deps.markToolHandlerStarted({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: congelou.row_version,
      dispatch_token: congelou.dispatch_token,
      reservation_token: `res-${call.call_id}`,
    });

    if (!marcou.ok) {
      logger.warn(
        { run_id: identity.run_id, call_id: call.call_id, reason: marcou.reason },
        'engine.tool_gateway.handler_started_refused',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
    }

    // ── (5) O HANDLER ────────────────────────────────────────────────────
    let resultado: DispatchResult;
    try {
      resultado = await deps.dispatch({ tool: call.name, args: call.args, ctx });
    } catch (err) {
      /**
       * O handler lançou. NÃO é `denied`: uma exceção depois de o dispatcher
       * ter começado não prova que nada aconteceu — a tool pode ter emitido o
       * boleto e falhado ao gravar o retorno. `effect_unknown` é o único
       * desfecho honesto, e é o que impede um retry de duplicar efeito.
       */
      logger.error(
        {
          run_id: identity.run_id,
          call_id: call.call_id,
          tool: call.name,
          err: (err as Error).message,
          ops_alert: true,
        },
        'engine.tool_gateway.handler_threw_effect_unknown',
      );

      /**
       * A liquidação abaixo é a tentativa de gravar `effect_unknown` — mas ela
       * PRÓPRIA pode falhar (achado de revisão sobre a PR #773): seja
       * rejeitando (o erro do repositório escapando, como a sonda do revisor
       * reproduziu), seja resolvendo `{ ok: false }` (conflito de versão ou
       * estado). A sonda NÃO demonstra duplicação efetiva de efeito — só que a
       * liquidação em si não gravou.
       *
       * Nenhum dos dois pode escapar desta função sem resposta: o caller
       * precisa de um `EngineToolReplyV1` do contrato sempre, nunca de uma
       * promise rejeitada por um detalhe de persistência. O desfecho devolvido
       * ao motor já é o mais conservador que existe — `effect_unknown` nunca
       * autoriza retry — e não muda com o resultado desta liquidação; o que
       * muda é o log: é dele que um operador vai precisar para saber que o
       * journal pode NÃO refletir isto, e que a chamada segue elegível à
       * reconciliação segura.
       */
      try {
        const liquidouAposExcecao = await deps.settle({
          ...base,
          call_id: admissao.call_id,
          expected_row_version: marcou.row_version,
          dispatch_token: congelou.dispatch_token,
          outcome: { kind: 'effect_unknown', result: null },
        });
        if (!liquidouAposExcecao.ok) {
          logger.error(
            {
              run_id: identity.run_id,
              call_id: call.call_id,
              reason: liquidouAposExcecao.reason,
              ops_alert: true,
            },
            'engine.tool_gateway.settle_not_persisted_after_handler_threw',
          );
        }
      } catch (settleErr) {
        logger.error(
          {
            run_id: identity.run_id,
            call_id: call.call_id,
            err: (settleErr as Error).message,
            ops_alert: true,
          },
          'engine.tool_gateway.settle_rejected_after_handler_threw',
        );
      }

      return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
    }

    // ── (6) LIQUIDAÇÃO ───────────────────────────────────────────────────
    const erro = ehErroDeHandler(resultado);
    const outcome: ToolSettlement = erro
      ? { kind: 'denied', result: resultado as Json }
      : { kind: 'completed', result: resultado as Json, receipt: null };

    const liquidou = await deps.settle({
      ...base,
      call_id: admissao.call_id,
      expected_row_version: marcou.row_version,
      dispatch_token: congelou.dispatch_token,
      outcome,
    });

    if (!liquidou.ok) {
      /**
       * O handler RODOU e a liquidação falhou. O efeito existe no mundo e o
       * journal não o registrou — a definição de incerteza. Devolver o
       * resultado aqui faria o motor seguir em cima de um efeito que a Maia não
       * consegue provar depois de um crash.
       */
      logger.error(
        {
          run_id: identity.run_id,
          call_id: call.call_id,
          reason: liquidou.reason,
          ops_alert: true,
        },
        'engine.tool_gateway.settle_failed_after_effect',
      );
      return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
    }

    return {
      kind: 'result',
      call_id: call.call_id,
      result: resultado as Json,
      is_error: erro,
    };
  };
}
