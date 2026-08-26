/**
 * Issue #504 §Fencing — o `TurnExecutionContext` AMBIENTE da tentativa em curso.
 *
 * ─── O que este módulo resolve ──────────────────────────────────────────────
 *
 * `TurnLease.#lose()` aborta um `AbortController` desde a primeira entrega da
 * issue. O problema era que ninguém escutava: o core consultava o claim só na
 * ENTRADA (`beginTurnExecution`) e depois disso o sinal não chegava ao ReAct,
 * às skills nem ao dispatcher. Entre o heartbeat perder a lease (ou um takeover
 * acontecer) e a transição final ser recusada pelo fence, o worker antigo
 * seguia chamando LLM e executando side effects — e o fence do banco, que só
 * protege `agent_turns`, chegava tarde demais para impedir o EFEITO.
 *
 * Um critério da issue é explícito: "perda de lease cancela a tentativa local e
 * impede gravações posteriores" e "esse contexto deve chegar aos limites
 * stateful e de efeito lateral relevantes".
 *
 * ─── Por que AsyncLocalStorage, e não um parâmetro ──────────────────────────
 *
 * Enfiar `TurnExecutionContext` na assinatura de `dispatchTool`, `runSkill`,
 * `runReActLoop`, `sendOutbound` e de cada handler seria a propagação mais
 * explícita — e mudaria a fronteira pública de cinco módulos que a #507 já vai
 * mexer (deadline/cancelamento), garantindo conflito. Mais importante: uma
 * assinatura opcional é fácil de esquecer num call site novo, e um call site
 * esquecido é um limite de efeito SEM guarda — que é o defeito atual.
 *
 * O ALS já é o mecanismo canônico deste repositório para exatamente esta forma
 * de problema: `src/db/tenant-context.ts` propaga `tenant_id`/`agent_id` para
 * TODA query sem que ninguém os passe à mão, e é a base da invariante de
 * isolamento. Seguimos o padrão que existe (AGENTS.md §5.2).
 *
 * Módulo à parte, e não uma extensão de `tenant-context.ts`, porque aquela
 * fronteira declara não ter ponto de extensão — e por uma boa razão, ver o
 * comentário de `runWithTenantContext`.
 *
 * ─── O que este módulo NÃO faz ──────────────────────────────────────────────
 *
 * Não decide nada sobre o turno e não fala com o banco. Ele só responde
 * "a tentativa que está rodando aqui ainda tem a posse?". Quem produz o `false`
 * é a `TurnLease` (heartbeat morto, takeover, `release()`); quem reage são os
 * limites de efeito.
 *
 * FORA de um turno (`getTurnExecutionContext() === null`) todo guard é NO-OP:
 * é o regime de `FEATURE_TURN_CLAIM` OFF, dos workers de agenda, do playground
 * e dos testes. Um guard que barrasse por ausência de contexto derrubaria meio
 * runtime sem provar nada.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/lib/logger.js';
import { counter, METRIC } from '@/observability/metrics.js';
import { EFFECT_BOUNDARY_VALUES, closedVocabulary } from '@/observability/taxonomy.js';
import type { EffectBoundary } from '@/observability/taxonomy.js';
import type { TurnExecutionContext } from './claim.js';

const storage = new AsyncLocalStorage<TurnExecutionContext>();

/**
 * Abre o escopo da tentativa. Tudo que `fn` chamar — direta ou
 * assincronamente — enxerga este contexto.
 *
 * Chamado por `src/agent/core.ts` DEPOIS da barreira do claim: antes dela não
 * existe tentativa autorizada, e abrir o escopo cedo demais daria contexto a um
 * turno que não é nosso.
 */
export function runWithTurnExecution<T>(
  ctx: TurnExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** O contexto da tentativa corrente, ou `null` fora de um turno reivindicado. */
export function getTurnExecutionContext(): TurnExecutionContext | null {
  return storage.getStore() ?? null;
}

/**
 * A posse foi perdida DURANTE esta tentativa?
 *
 * `false` também quando não há contexto — "não estou num turno reivindicado"
 * não é "perdi a posse". Ver o parágrafo sobre no-op acima.
 */
export function turnOwnershipLost(): boolean {
  const ctx = storage.getStore();
  return ctx !== undefined && ctx.signal.aborted;
}

/**
 * Erro de LIMITE DE EFEITO: a tentativa perdeu a posse e a operação foi
 * cancelada ANTES de produzir efeito.
 *
 * É um erro (e não um retorno) nos limites cuja assinatura já é "lança ou
 * entrega" — o outbound, por exemplo. No dispatcher de tools, cujo contrato é
 * devolver `{ error }`, o guard devolve `turn_ownership_lost` em vez de lançar:
 * cada fronteira recusa no vocabulário que ela já tem, senão o caller trata a
 * recusa como quebra de plataforma.
 */
export class TurnOwnershipLostError extends Error {
  readonly code = 'TURN_OWNERSHIP_LOST';
  readonly boundary: EffectBoundary;
  readonly turn_id: string | null;

  constructor(boundary: EffectBoundary, turn_id: string | null) {
    super(
      `turn_ownership_lost: a tentativa perdeu a posse do turno${
        turn_id ? ` ${turn_id}` : ''
      } e o limite de efeito '${boundary}' foi cancelado antes de executar. ` +
        `Quem tem a lease vigente é quem deve produzir este efeito.`,
    );
    this.name = 'TurnOwnershipLostError';
    this.boundary = boundary;
    this.turn_id = turn_id;
  }
}

/**
 * Registra a recusa de um limite de efeito. Separado do throw porque nem todo
 * limite lança — e a observabilidade tem de ser a mesma nos dois.
 *
 * `turn_id` fica só no log, nunca em label.
 *
 * ─── Issue #601: por que `counter()` e não `incCounter()` ───────────────────
 *
 * Até a #601 esta linha chamava `src/lib/metrics.ts::incCounter` DIRETO, que é
 * o transporte, e contornava a camada de política. Três consequências, as três
 * fechadas aqui:
 *
 *   1. ATRIBUIÇÃO. A série não recebia `tenant_id` + `agent_id`, então um pico
 *      dizia que o fencing atuou e não dizia PARA QUEM — a primeira pergunta de
 *      um incidente multi-tenant, e a invariante #1 do AGENTS.md.
 *      `counter()` os anexa do ALS (`src/db/tenant-context.ts`), com o fallback
 *      sancionado `system` fora de escopo de tenant.
 *   2. GUARD de PII/forma/cardinalidade. `boundary` nem estava em
 *      `ALLOWED_LABEL_KEYS`: o rótulo saía cru, sem passar pelo sanitizador.
 *      Agora está na taxonomia, com budget próprio.
 *   3. FECHAMENTO REAL do vocabulário. A alegação de "cardinalidade fechada"
 *      era só um comentário. Agora é (a) uma regra do compilador — o parâmetro
 *      é `EffectBoundary`, não `string` — e (b) uma defesa de runtime:
 *      `closedVocabulary` colapsa em `other` qualquer valor que chegue por cast
 *      ou por `unknown`, ANTES do sanitizador, para que nenhum valor fora do
 *      contrato chegue a existir como série.
 *
 * O que NÃO mudou, e é requisito: a dimensão `boundary` continua sendo emitida.
 * A barreira da #599
 * (`tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts`) lê este
 * rótulo para afirmar QUAL limite recusou o efeito. Sem ele o teste voltaria a
 * medir "alguém barrou", que é o falso verde que aquela revisão pegou.
 */
export function reportBlockedEffect(boundary: EffectBoundary): void {
  const ctx = storage.getStore();
  counter(METRIC.TURN_EFFECT_BLOCKED, {
    boundary: closedVocabulary(boundary, EFFECT_BOUNDARY_VALUES),
  });
  logger.error(
    {
      turn_id: ctx?.turn_id ?? null,
      attempt: ctx?.attempt ?? null,
      worker_id: ctx?.worker_id ?? null,
      boundary,
      ops_alert: true,
    },
    'turn.effect_blocked_ownership_lost',
  );
}

/**
 * GUARD de limite de efeito, versão que lança.
 *
 * Use imediatamente antes de qualquer coisa irreversível (envio ao usuário,
 * chamada externa) em caminhos cujo caller já trata exceção.
 */
export function assertTurnOwnership(boundary: EffectBoundary): void {
  if (!turnOwnershipLost()) return;
  reportBlockedEffect(boundary);
  throw new TurnOwnershipLostError(boundary, storage.getStore()?.turn_id ?? null);
}
