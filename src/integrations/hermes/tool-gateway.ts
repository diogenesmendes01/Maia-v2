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
import type {
  DurableDispatchControlV1,
  DurableDispatchResultV1,
  EngineToolCallV1,
  EngineToolReplyV1,
  Json,
  ToolReceiptV1,
} from '@/runtime/engines/contracts.js';
import type { ToolAdmissionV1 } from './tool-broker.js';
import type {
  ToolCallAdmission,
  ToolClassification,
  ToolSettlement,
  FreezeIdentityResult,
  HandlerStartedResult,
} from '@/db/repositories/engine-repos.js';
import type { ToolContext, DispatchResult } from '@/tools/_dispatcher.js';
import { BeforeHandlerError } from '@/tools/_dispatcher.js';
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
    /** §5.3.2 (SC04): o UUID COMPLETO do pedido de aprovação, quando houve. */
    approval_request_id?: string | null;
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
  /**
   * §5.3.2 (SC04) — O CAMINHO DURÁVEL.
   *
   * Quando presente, o gateway deixa de orquestrar handler/marcador à mão e
   * passa a chamar `dispatchToolDurable`, que roda o MESMO corpo do dispatcher
   * legado acrescentando os três hooks do controle. Isso importa por dois
   * motivos que o caminho anterior não conseguia cumprir:
   *
   *  1. A identidade de idempotência era congelada com `call_id` como chave,
   *     ANTES do corpo — e o corpo recalcula a chave real (com bucket) para o
   *     lookup/reserva. Dois donos para a mesma identidade, e o journal ficava
   *     com a que o despacho não usava.
   *  2. O `reservation_token` era `res-<call_id>`, inventado aqui: não é o
   *     token da reserva de idempotência (que nasce dentro do corpo), e
   *     "inventado" é o oposto de "real" para quem for reconciliar.
   *
   * Opcional para que o caminho anterior continue válido para os callers que
   * ainda não têm os hooks — e é o que mantém as regressões do gateway
   * intactas. Quem liga o durável assume o contrato inteiro.
   */
  dispatchDurable?: (
    input: { tool: string; args: Json; ctx: ToolContext },
    control: DurableDispatchControlV1,
  ) => Promise<DurableDispatchResultV1>;
  /**
   * Grava a aprovação REAL da chamada no instante em que o UUID/claim existem
   * (§5.3.2). Ligado a `recordToolCallApproval`.
   */
  recordToolApproval?: (input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    approval_request_id: string;
    approval_claim_token: string | null;
    state: 'pending' | 'claimed';
  }) => Promise<{ ok: true; row_version: number } | { ok: false; reason: string }>;
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
    //
    // SÓ no caminho LEGADO. No caminho durável (4d), quem congela a identidade
    // é o CORPO do dispatcher — `freezeIdentity` é o primeiro hook que ele
    // chama, ANTES do lookup da cache, da aprovação e da reserva atômica.
    //
    // Congelar aqui TAMBÉM era um defeito real, não uma redundância inofensiva:
    // este passo grava `idempotency_key = call_id` e
    // `payload_hash = canonicalDigest(args)`, e o corpo chega logo depois com a
    // chave REAL (`computeIdempotencyKey`, com bucket) e o hash `v2:`. O
    // journal tem UM dono para a identidade (§5.6.3), então a segunda gravação
    // responde `identity_conflict` — e, como o payload persistido
    // (`canonicalDigest`) difere do candidato (`v2:`), nem a regra de adoção
    // por virada de bucket se aplica: o hook falha, o corpo devolve
    // `journal_unavailable{handler_may_have_started:false}` e a chamada morre
    // em `dispatching` com ZERO handlers. O caminho durável não despachava
    // nada, e o journal ficava com uma identidade que o despacho não usa.
    //
    // O caminho legado mantém este passo byte a byte (é o que a API de SC01
    // espera: `idempotency_key`/`payload_hash` congelados antes do marcador).
    if (deps.dispatchDurable === undefined) {
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

    // ── (4d) DESPACHO DURÁVEL (§5.3.2) ───────────────────────────────────
    //
    // A partir daqui o caminho muda de dono: quem orquestra marcador, reserva
    // de idempotência e handler é o CORPO do dispatcher, não este módulo. O
    // gateway entrega os três hooks (identidade, aprovação, marcador) e recebe
    // um RECEIPT — ou um dos dois desfechos que não são receipt.
    //
    // O que NÃO muda: a releitura do banco (3), o congelamento da classificação
    // (4) e o contexto (4b) continuam aqui, porque são gates de ADMISSÃO. O que
    // sai daqui é a orquestração do efeito — e, junto com ela, a IDENTIDADE de
    // idempotência (4a), que passa a ser congelada pelo próprio corpo, uma vez
    // só, com a chave real. Dois congelamentos = nenhum dono para a identidade;
    // ver o comentário do passo (4a).
    if (deps.dispatchDurable !== undefined) {
      const despachar = deps.dispatchDurable;
      const gravarAprovacao = deps.recordToolApproval;

      /**
       * O fence da linha é uma CORRENTE, não uma constante.
       *
       * Cada transição devolve a versão nova e a próxima exige exatamente
       * aquela. Chumbar `ROW_VERSION_DA_ADMISSAO` aqui — como o caminho
       * anterior fazia — só funciona enquanto o número de escritas entre a
       * admissão e o marcador for exatamente o previsto; qualquer transição
       * acrescentada no meio (uma aprovação registrada, por exemplo) faria o
       * marcador falhar com `version_conflict`, e a leitura errada seria "o
       * journal está quebrado".
       */
      let rowVersion = congelou.row_version;
      let handlerComecou = false;
      let aprovacaoJaJournalada = false;

      const control: DurableDispatchControlV1 = {
        call_id: admissao.call_id,
        call_ordinal: call.ordinal,
        dispatch_token: congelou.dispatch_token,
        classification: classificacao,

        freezeIdentity: async (candidate) => {
          const congeladaAgora = await deps.freezeToolIdentity({
            ...base,
            call_id: admissao.call_id,
            idempotency_key: candidate.key,
            idempotency_payload_hash: candidate.payload_hash,
            normalized_args: candidate.normalized_args,
          });
          if (!congeladaAgora.ok) {
            /**
             * §5.3.2 / AC02 — "o relógio andou" NÃO é "a intenção mudou".
             *
             * `computeIdempotencyKey` carrega o bucket temporal: um retry
             * depois da virada de bucket recalcula uma chave DIFERENTE para a
             * MESMA intenção. Recusar ali quebraria o retry legítimo — e o
             * T26/T27 proibiram as duas saídas fáceis: reexecutar (efeito
             * duplicado) e recalcular a identidade (chave que o journal não
             * reconhece).
             *
             * O que autoriza adotar a identidade PERSISTIDA é prova de que a
             * intenção é a mesma, e ela existe: `freezeToolIdentity` já
             * verificou a invariante C15 (`normalized_args` reproduz o
             * `args_hash` gravado na admissão) ANTES de comparar as chaves, e o
             * `payload_hash` persistido é devolvido junto do conflito. Os dois
             * batendo, a diferença de chave só pode vir do bucket — e a
             * identidade que vale é a CONGELADA.
             *
             * Sem essa prova, o conflito é real e o despacho para: mesmo
             * `call_id` com outro payload é o T27, e ali nenhum handler roda.
             */
            if (
              congeladaAgora.reason === 'identity_conflict' &&
              typeof congeladaAgora.current_idempotency_payload_hash === 'string' &&
              congeladaAgora.current_idempotency_payload_hash === candidate.payload_hash
            ) {
              logger.warn(
                {
                  run_id: identity.run_id,
                  call_id: call.call_id,
                  tool: call.name,
                  // O motivo é operacionalmente relevante: se isto aparecer
                  // com frequência, a janela de bucket está curta para o
                  // intervalo de retry do engine.
                  bucket_rollover: true,
                },
                'engine.tool_gateway.identity_frozen_adopted',
              );
              return {
                key: congeladaAgora.current_idempotency_key,
                payload_hash: congeladaAgora.current_idempotency_payload_hash,
              };
            }
            /**
             * Fail-closed, e o motivo TIPADO vai na mensagem de propósito: o
             * corpo trata isto como `journal_unavailable`, e quem for
             * reconciliar precisa saber se a causa foi `identity_conflict`
             * (args divergentes na mesma call) ou `normalized_args_mismatch`
             * (o objeto gravado não reproduz o `args_hash`).
             */
            throw new Error(`freeze_identity:${congeladaAgora.reason}`);
          }
          /**
           * A identidade REAL é a PERSISTIDA. Sem ela não se segue: aceitar a
           * candidata "porque é igual" seria reintroduzir, no caminho novo, o
           * defeito que o congelamento existe para corrigir (chave recalculada
           * depois de virada de bucket). Ver `FreezeIdentityResult`.
           */
          if (congeladaAgora.key === undefined || congeladaAgora.payload_hash === undefined) {
            throw new Error('freeze_identity:identidade_persistida_ausente');
          }
          if (congeladaAgora.row_version !== undefined) rowVersion = congeladaAgora.row_version;
          return { key: congeladaAgora.key, payload_hash: congeladaAgora.payload_hash };
        },

        recordApproval: async (input) => {
          if (gravarAprovacao === undefined) {
            throw new Error('record_approval:sem_canal');
          }
          const gravou = await gravarAprovacao({
            ...base,
            call_id: admissao.call_id,
            expected_row_version: rowVersion,
            dispatch_token: congelou.dispatch_token,
            approval_request_id: input.approval.request_id,
            approval_claim_token: input.claim_token,
            state: input.state,
          });
          if (!gravou.ok) {
            throw new Error(`record_approval:${gravou.reason}`);
          }
          rowVersion = gravou.row_version;
          // A chamada já está TERMINAL no journal (`approval_required`): quem
          // liquidar por cima disso recebe `state_conflict`, e o run ficaria
          // com um erro de CAS no lugar do fato. Registrar que ela já foi
          // journalada evita o settle redundante.
          if (input.state === 'pending') aprovacaoJaJournalada = true;
        },

        beforeHandler: async (input) => {
          const marcou = await deps.markToolHandlerStarted({
            ...base,
            call_id: admissao.call_id,
            expected_row_version: rowVersion,
            dispatch_token: congelou.dispatch_token,
            reservation_token: input.reservation_token,
            approval_claim_token: input.approval_claim_token,
            approval_request_id: input.approval_request_id,
          });
          if (!marcou.ok) {
            /**
             * `already_started` é o único motivo que NÃO prova ausência de
             * início: a call já tem carimbo, então o marcador existe e o efeito
             * pode ter acontecido. Marcar `handler_may_have_started: true` nele
             * manda o run para reconciliação em vez de fechar o turno como se
             * nada tivesse rodado.
             */
            throw new BeforeHandlerError(marcou.reason === 'already_started');
          }
          rowVersion = marcou.row_version;
          handlerComecou = true;
        },
      };

      const desfecho = await despachar(
        { tool: call.name, args: call.args, ctx },
        control,
      );

      if (desfecho.kind === 'ownership_lost') {
        // O dispatcher perdeu a posse NO INSTANTE do efeito. Não há receipt
        // para liquidar nem resultado a devolver: o turno não é mais dono.
        return { kind: 'refused', call_id: call.call_id, code: 'run_not_authorized' };
      }

      if (desfecho.kind === 'journal_unavailable') {
        /**
         * O journal pode não ter registrado o início. Seja qual for o caso,
         * NÃO existe receipt de sucesso para devolver: `effect_unknown` quando
         * o handler pode ter começado (o run vai para reconciliação),
         * `run_not_authorized` quando o hook recusou ANTES do efeito — e a
         * diferença é exatamente `handler_may_have_started`.
         */
        logger.error(
          {
            run_id: identity.run_id,
            call_id: call.call_id,
            handler_may_have_started: desfecho.handler_may_have_started,
            ops_alert: true,
          },
          'engine.tool_gateway.journal_unavailable',
        );

        /**
         * §5.6.2 / AC08 — recusa PROVADA antes do efeito ENCERRA a call.
         *
         * `handler_may_have_started: false` é uma afirmação verificável: o
         * carimbo de início não existe, então nada rodou e nenhum efeito pode
         * ter ficado. Sem encerrar, a linha fica em `dispatching` — e
         * `dispatching` é justamente o estado que OCUPA a vaga sequencial do
         * run (§6.9.1). A recusa não é lenta, é definitiva: o run não anda mais
         * e o desfecho honesto do que nunca começou é `denied` com evidência
         * `none` (não `completed`, que afirmaria um resultado sem prova; não
         * `effect_unknown`, que mandaria reconciliar um efeito inexistente).
         *
         * O `settle` aqui é o MESMO caminho que o corpo usa para uma recusa de
         * governança antes do handler: um dono só para o desfecho. Se a
         * liquidação não gravar — recusa de CAS, estado já terminal por um
         * registro de aprovação que sobreviveu à falha, fence vencido —, ela
         * NÃO muda o que o motor ouve (a recusa já é conservadora) nem pode
         * escapar como exceção: o log fica, e quem reconciliar sabe que o
         * journal pode não refletir isto.
         */
        if (!desfecho.handler_may_have_started) {
          try {
            const encerrou = await deps.settle({
              ...base,
              call_id: admissao.call_id,
              expected_row_version: rowVersion,
              dispatch_token: congelou.dispatch_token,
              outcome: { kind: 'denied', result: { error: 'journal_unavailable' } },
            });
            if (!encerrou.ok) {
              logger.error(
                {
                  run_id: identity.run_id,
                  call_id: call.call_id,
                  reason: encerrou.reason,
                  ops_alert: true,
                },
                'engine.tool_gateway.settle_not_persisted_after_refusal',
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
              'engine.tool_gateway.settle_rejected_after_refusal',
            );
          }
        }

        return {
          kind: 'refused',
          call_id: call.call_id,
          code: desfecho.handler_may_have_started ? 'effect_unknown' : 'run_not_authorized',
        };
      }

      const receipt: ToolReceiptV1 = desfecho.receipt;
      const erroDoReceipt = receipt.status === 'error';

      /**
       * Quando liquidar, e por quê.
       *
       *  - O handler começou: o desfecho PERTENCE ao journal, sempre — inclusive
       *    (e principalmente) quando é erro. `denied` porque nada de bom saiu
       *    do handler, `completed` quando saiu.
       *  - Não começou e a aprovação já foi journalada como pendente: a linha
       *    está TERMINAL em `approval_required`. Liquidar por cima seria um
       *    segundo desfecho para a mesma call.
       *  - Não começou e não houve aprovação pendente: é uma recusa de
       *    governança ANTES do efeito (grant, regra, args). A linha está em
       *    `dispatching` e precisa terminar — senão ocupa a vaga sequencial do
       *    run para sempre. `denied` é o desfecho honesto: nada rodou.
       */
      const deveLiquidar = handlerComecou || !aprovacaoJaJournalada;
      if (deveLiquidar) {
        /**
         * A ORDEM importa, e `unknown` vem primeiro.
         *
         * O receipt pode ter `status: 'error'` com `effect_evidence: 'unknown'`
         * — é o caso do handler que lançou DEPOIS do marcador (§5.6.2/ADR-11).
         * Liquidar isso como `denied` gravaria a afirmação "nada rodou" sobre
         * uma call que pode ter emitido efeito, e ainda deixaria a linha
         * incoerente com o próprio receipt (`state='denied'` +
         * `effect_evidence='unknown'`). A migração 140 tem CHECK justamente
         * para o `effect_unknown`; o mapeamento tem de chegar nele.
         */
        const outcome: ToolSettlement =
          receipt.effect_evidence === 'unknown'
            ? { kind: 'effect_unknown', result: receipt.result }
            : erroDoReceipt
              ? { kind: 'denied', result: receipt.result }
              : {
                  kind: 'completed',
                  result: receipt.result,
                  /**
                   * O receipt vai para o journal com o hash do seu conteúdo
                   * canônico. É o que permite a quem reconciliar detectar que o
                   * receipt lido não é o que foi gravado.
                   *
                   * O cast é de forma, não de conteúdo: `ToolReceiptV1` é uma
                   * interface com campos nomeados e `Json` é o tipo de payload
                   * serializável. O valor gravado é o objeto do receipt — o mesmo
                   * que o hash acima cobriu.
                   */
                  receipt: { json: receipt as unknown as Json, hash: canonicalDigest(receipt) },
                };

        try {
          const liquidou = await deps.settle({
            ...base,
            call_id: admissao.call_id,
            expected_row_version: rowVersion,
            dispatch_token: congelou.dispatch_token,
            outcome,
          });
          if (!liquidou.ok) {
            logger.error(
              {
                run_id: identity.run_id,
                call_id: call.call_id,
                reason: liquidou.reason,
                handler_started: handlerComecou,
                ops_alert: true,
              },
              'engine.tool_gateway.settle_failed_durable',
            );
            // Liquidar falhou DEPOIS do efeito: o journal não registra o
            // desfecho, então o desfecho não pode ser devolvido como certo.
            if (handlerComecou) {
              return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
            }
          }
        } catch (settleErr) {
          logger.error(
            {
              run_id: identity.run_id,
              call_id: call.call_id,
              err: (settleErr as Error).message,
              handler_started: handlerComecou,
              ops_alert: true,
            },
            'engine.tool_gateway.settle_rejected_durable',
          );
          if (handlerComecou) {
            return { kind: 'refused', call_id: call.call_id, code: 'effect_unknown' };
          }
        }
      }

      /**
       * O motor recebe a PROJEÇÃO, nunca o resultado cru do handler
       * (`result_for_engine`): caminhos de arquivo, nome de arquivo interno e
       * resumo de relatório são material do backend. O protegido
       * (`receipt.result`) fica no receipt/jornal, para o step-evaluator.
       */
      return {
        kind: 'result',
        call_id: call.call_id,
        result: receipt.result_for_engine,
        is_error: erroDoReceipt,
      };
    }

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
