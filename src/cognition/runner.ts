import type { RunModuleOptions, RunModuleResult } from './types.js';
import { cognitiveModuleLogRepo } from '@/db/repositories.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { counter, METRIC } from '@/observability/metrics.js';

/**
 * Motivo com que o runner aborta o sinal COMPOSTO quando o timeout local vence.
 * Fica no `reason` do abort para que quem observa consiga distinguir "o caller
 * cancelou" de "este módulo estourou o próprio limite".
 */
const TIMEOUT_ABORT_REASON = 'cognitive_module_timeout';

/**
 * Por que a execução terminou em `cancelled` — cardinalidade FECHADA, vai para
 * `cognitive_module_log.metadata.cancel_cause` e para a label da métrica.
 *
 *   `signal_aborted`          — o `fn` rejeitou porque o sinal foi abortado.
 *                               É o caminho COOPERATIVO: a operação subjacente
 *                               (a requisição HTTP ao provedor, por exemplo)
 *                               de fato parou.
 *   `late_result_discarded`   — o `fn` RESOLVEU, mas o sinal do caller já
 *                               estava abortado quando o resultado chegou. O
 *                               trabalho foi feito e pago; o que não pode
 *                               acontecer é o resultado ser usado ou auditado
 *                               como sucesso desta tentativa.
 *   `caller_already_aborted`  — o sinal do caller JÁ estava abortado quando
 *                               este módulo foi chamado. O `fn` NÃO é
 *                               invocado: nada é pago, nada roda.
 *                               Distinto de `signal_aborted` de propósito —
 *                               ali a perda aconteceu DURANTE este módulo;
 *                               aqui ela aconteceu ANTES dele, num boundary a
 *                               montante, e o valor é o que revela onde a
 *                               propagação começou.
 */
type CancelCause = 'signal_aborted' | 'late_result_discarded' | 'caller_already_aborted';

/**
 * Compõe o sinal do caller com o timeout local do módulo.
 *
 * Existe por uma razão que o `Promise.race` sozinho não cobre: o race decide
 * quem responde ao CALLER, e não cancela nada. Com o controller, o timeout
 * também vira um abort que chega ao `fn` — e daí à requisição subjacente, se o
 * `fn` repassar o sinal. O race continua ali como rede para dependências NÃO
 * cooperativas (as que ignoram o sinal): elas não podem prender o caller.
 *
 * `dispose()` é obrigatório em TODOS os caminhos de saída: sem ele o listener
 * fica pendurado no sinal do caller (que vive o turno inteiro, não a chamada) e
 * retém o controller — o mesmo vazamento que a PR #221 fechou no skill-runner.
 */
function composeSignal(caller: AbortSignal | undefined): {
  signal: AbortSignal;
  abortForTimeout: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (caller?.aborted) {
    controller.abort(caller.reason);
    return { signal: controller.signal, abortForTimeout: () => {}, dispose: () => {} };
  }
  const onCallerAbort = (): void => controller.abort(caller?.reason);
  if (caller) caller.addEventListener('abort', onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    abortForTimeout: () => controller.abort(TIMEOUT_ABORT_REASON),
    dispose: () => {
      if (caller) caller.removeEventListener('abort', onCallerAbort);
    },
  };
}

export async function runCognitiveModule<TOut>(
  opts: RunModuleOptions<TOut>,
  /**
   * Issue #507 — o `fn` passa a RECEBER o sinal composto (caller + timeout do
   * módulo). Parâmetro, e não campo de `opts`, porque é o `fn` que conhece a
   * operação subjacente e sabe onde entregá-lo — o parâmetro `signal` do
   * gateway de LLM, por exemplo.
   *
   * Compatível com os call sites existentes: em TypeScript uma função que
   * declara MENOS parâmetros é atribuível a uma que declara mais, então todo
   * `() => Promise<T>` continua valendo sem alteração.
   */
  fn: (signal: AbortSignal) => Promise<TOut>,
): Promise<RunModuleResult<TOut>> {
  const startTime = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const audit = opts.audit ?? true;
  let status: RunModuleResult<TOut>['status'] = 'success';
  // PR #82 review: declare output without an initial null assignment —
  // `let foo = null` followed by an unconditional re-assignment in both
  // try and catch arms trips `no-useless-assignment`. TS already forces
  // a definite assignment along every reachable path.
  let output: TOut | null;
  let fallback_triggered = false;
  let error_message: string | undefined;
  let cancel_cause: CancelCause | undefined;

  // Issue #224: store the timeout handle and clear it once the race settles.
  // Without this, every fn() that resolves (or rejects) before the timer fires
  // leaves a pending setTimeout in the event loop — accumulating closures,
  // delaying graceful shutdowns, and producing "open handles" warnings in
  // tests. The same shape as the listener-cleanup fix landing in
  // skill-runner.ts (sibling PR #221).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  /**
   * Issue #507 — o timer disparou?
   *
   * Antes bastava comparar `e.message === 'timeout'`, porque o único jeito de o
   * timeout chegar ao caller era a promessa sintética do race. Agora o timer
   * ABORTA o sinal composto ANTES de rejeitar, e um `fn` COOPERATIVO rejeita na
   * hora, de dentro do listener de abort — ou seja, síncronamente antes do
   * `reject(new Error('timeout'))`. Sem esta flag, o race passaria a ser vencido
   * pela rejeição do `fn` e um estouro de limite seria classificado como
   * `error`: a cooperação que acabamos de ganhar apagaria a causa.
   */
  let timedOut = false;
  /**
   * Issue #507 (achado 3 da revisão do dono) — PREFLIGHT: caller já abortado
   * ⇒ o `fn` NEM É INVOCADO.
   *
   * Antes, `composeSignal` devolvia o sinal composto já abortado e mesmo assim
   * `fn(composed.signal)` era avaliado. O gateway de LLM tem preflight próprio,
   * então ReAct e pending-gate não abriam request ao provedor — mas o contrato
   * deste runner é GENÉRICO: um `fn` que ignora o sinal ficava pendurado até o
   * timeout inteiro (5 s / 30 s) prendendo o caller, e um `fn` com efeito
   * SÍNCRONO antes do primeiro `await` já tinha produzido o efeito.
   *
   * Com a propagação do sinal pelo grafo cognitivo (achado 2) este caminho
   * deixa de ser hipotético: o segundo node de uma camada paralela e cada volta
   * do laço do `procedure-selector` chegam aqui com o sinal JÁ abortado.
   *
   * O desfecho auditado é o mesmo `cancelled`, com causa própria
   * (`caller_already_aborted`) — ver `CancelCause`.
   */
  if (opts.signal?.aborted) {
    output = null;
    status = 'cancelled';
    cancel_cause = 'caller_already_aborted';
  } else {
    const composed = composeSignal(opts.signal);
    try {
      output = await Promise.race([
        fn(composed.signal),
        new Promise<TOut>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Issue #507 — abortar ANTES de rejeitar. O race só escolhe quem
            // responde ao caller; quem manda a operação subjacente parar é o
            // abort. Na ordem inversa o caller sairia enquanto o trabalho seguia.
            timedOut = true;
            composed.abortForTimeout();
            reject(new Error('timeout'));
          }, timeoutMs);
        }),
      ]);
      // Issue #507 — RESULTADO TARDIO. O `fn` resolveu, mas o caller já tinha
      // cancelado. Auditar isto como `success` era a mentira que o dono apontou:
      // uma row afirmando que um turno que já não era nosso deu certo. O output é
      // DESCARTADO (não vira mutação nem resposta) e o desfecho é `cancelled`.
      if (opts.signal?.aborted) {
        output = null;
        status = 'cancelled';
        cancel_cause = 'late_result_discarded';
      }
    } catch (err) {
      const e = err as Error;
      error_message = e.message;
      if (opts.signal?.aborted) {
        // Cancelamento do caller vence o timeout: se o sinal já estava abortado,
        // a causa REAL é o cancelamento, mesmo que o timer tenha disparado no
        // mesmo tick. `fallback_triggered` fica false — ver RunModuleResult.
        status = 'cancelled';
        cancel_cause = 'signal_aborted';
        output = null;
      } else {
        status = timedOut || e.message === 'timeout' ? 'timeout' : 'error';
        fallback_triggered = true;
        if (opts.fallback !== undefined) {
          output = typeof opts.fallback === 'function'
            ? (opts.fallback as () => TOut)()
            : opts.fallback;
        } else {
          output = null;
        }
      }
    } finally {
      // Always clear the timeout — covers all exit paths:
      //  - fn() resolved first (timeoutHandle still scheduled)
      //  - fn() rejected first (timeoutHandle still scheduled)
      //  - timeout fired first (clearTimeout on an already-fired handle is a no-op)
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      // Issue #507 — e SEMPRE soltar o listener do sinal do caller. Ele vive o
      // turno inteiro; a chamada, não.
      composed.dispose();
    }
  }

  const latency_ms = Date.now() - startTime;

  if (status === 'cancelled') {
    /**
     * Issue #507 (achado 4 da revisão do dono) — emitido pela camada
     * SANCIONADA (`src/observability/metrics.ts`), não por `incCounter` direto.
     *
     * O que a chamada direta contornava:
     *   1. ATRIBUIÇÃO. Sem `tenant_id` + `agent_id` a série não pode ser
     *      apontada ao tenant do turno — e a invariante #1 do AGENTS.md exige
     *      isso de todo limite com estado. `counter()` os anexa do ALS.
     *   2. GUARDA de PII/cardinalidade. `module`/`cause` nem sequer estão na
     *      allowlist (`ALLOWED_LABEL_KEYS`), então as duas dimensões seriam
     *      emitidas cruas, sem passar pelo sanitizador.
     *   3. CARDINALIDADE REALMENTE FECHADA. A alegação anterior ("`module` é
     *      enum de fato") é FALSA: `RunModuleOptions.name` é `string` e o
     *      `procedure-selector` deriva o nome do módulo do NOME DO PROCEDIMENTO
     *      (`procedure-selector.${def.nome}` em
     *      `src/cognition/procedure-selector.ts`), que é dado de tenant. O tipo
     *      não fecha nada; quem fecha é o budget por (métrica, chave) do
     *      sanitizador, que colapsa o excedente em `__overflow__` e o texto
     *      livre em `__sanitized__`.
     *
     * Dimensões: as JÁ sancionadas `workload` (a unidade de trabalho cognitivo)
     * e `reason` (a `CancelCause`). Nenhuma chave nova — mudar a taxonomia para
     * acomodar esta série seria decisão de produto, não desta correção.
     */
    counter(METRIC.COGNITIVE_MODULE_CANCELLED, {
      workload: opts.name,
      reason: cancel_cause ?? 'signal_aborted',
    });
    logger.warn(
      {
        module: opts.name,
        cause: cancel_cause,
        latency_ms,
        conversa_id: opts.conversa_id ?? null,
        turno_id: opts.turno_id ?? null,
      },
      'runner.module_cancelled',
    );
  }

  if (audit) {
    const ctx = tryGetCurrentContext();
    if (!ctx) {
      // Tenant context missing → fail-closed on AUDIT only (the primary
      // module already ran and the user-facing path must not break).
      //
      // Before PR #269: this branch wrote a `cognitive_module_log` row
      // scoped to ('default','default'), polluting the audit table with a
      // cross-tenant shared bucket and silencing the caller bug that forgot
      // to wrap in `runWithTenantContext`. That violated the same invariant
      // PR #232/#237/#241/#262 enforce on every other tenant-scoped store.
      //
      // After: we surface the gap loudly via logger.warn and **skip the
      // audit write**. The cognitive_module_log row is lost, but the
      // alternative (writing under a poisoned tenant id) is strictly
      // worse — auditors would see ghost rows and cross-tenant
      // cognitive_candidates correlation would break.
      logger.warn(
        { module: opts.name },
        'runner.audit_skipped_missing_tenant_context',
      );
      return { output, status, fallback_triggered, latency_ms };
    }
    try {
      await cognitiveModuleLogRepo.record({
        tenant_id: ctx.tenant_id,
        agent_id: ctx.agent_id,
        conversa_id: opts.conversa_id ?? null,
        turno_id: opts.turno_id ?? null,
        module_name: opts.name,
        module_version: opts.version ?? 'v1',
        prompt_version: null,
        triggered_by: opts.triggered_by,
        started_at: new Date(startTime),
        ended_at: new Date(),
        latency_ms,
        model_used: null,
        tokens_in: null,
        tokens_out: null,
        cost_estimate: null,
        output_summary_hash: null,
        confidence: null,
        fallback_triggered,
        // `fallback_reason` só é preenchido quando houve degradação de fato.
        // Num cancelamento não houve — a causa vai em `metadata.cancel_cause`.
        fallback_reason: status === 'cancelled' ? null : (error_message ?? null),
        status,
        // Issue #507 — a causa do cancelamento fica em `metadata`, e NÃO em
        // `fallback_reason`: aquela coluna só faz sentido ao lado de
        // `fallback_triggered=true`, e num cancelamento ela é false.
        metadata: cancel_cause ? { cancel_cause } : {},
      });
    } catch (logErr) {
      logger.warn({ err: (logErr as Error).message, module: opts.name }, 'runner.audit_failed');
    }
  }

  return { output, status, fallback_triggered, latency_ms };
}
