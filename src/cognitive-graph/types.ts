import { CognitiveLayer } from '@/types/enums.js';

/** Tier de modelo declarativo (spec §10.2). Mapping pra modelo real fica em config. */
export type ModelTier = 'fast' | 'reasoning' | 'critical' | 'deterministic';

/**
 * Descriptor declarativo de um módulo cognitivo no grafo.
 *
 * - `layer` define a camada de execução (spec §4.8: 3 camadas).
 * - `runWhen` (opcional, sync_conditional/async) — predicado que decide se o node roda.
 * - `parallelizable` (sync_conditional only) — pode rodar em paralelo com siblings.
 * - `fallback` — valor usado quando o node faz timeout/erro. Quando `undefined`, o
 *   resultado é `null` mas o turn segue (princípio: módulo periférico não derruba resposta).
 * - `version` — bumpar quando contrato do módulo muda (spec §10.5: aparece no log).
 */
export type ModuleDescriptor<TIn, TOut> = {
  name: string;
  layer: CognitiveLayer;
  modelTier: ModelTier;
  timeoutMs: number;
  version: string;
  /** Só faz sentido em SYNC_CONDITIONAL. Default: false. */
  parallelizable?: boolean;
  /** Predicado opcional — quando retorna false, o node é SKIPPED (não roda, não falha). */
  runWhen?: (input: TIn) => boolean;
  /** Valor (ou função geradora) usado em timeout/erro. Sem fallback: output=null. */
  fallback?: TOut | (() => TOut);
  /**
   * Implementação. Recebe input tipado, retorna output tipado.
   *
   * Issue #507 (achado 2 da revisão do dono) — o segundo parâmetro é o sinal
   * COMPOSTO que `runCognitiveModule` monta (cancelamento do turno + timeout
   * do node). Quem implementa o node é quem sabe onde entregá-lo: o parâmetro
   * `signal` de `callLLM`, de um port, de um `fetch`.
   *
   * Opcional na prática: em TypeScript uma função que declara MENOS parâmetros
   * é atribuível a uma que declara mais, então todo node `(ctx) => …` que
   * existia continua válido — e continua sendo NÃO cooperativo, que é o estado
   * anterior, não uma regressão nova.
   */
  run: (input: TIn, signal: AbortSignal) => Promise<TOut>;
};

/** Resultado de um único node. Mirror de `RunModuleResult` mas com nome do node. */
export type NodeRunResult<TOut> = {
  /**
   * Issue #507 — espelha `RunModuleResult['status']`, `cancelled` incluído.
   *
   * O valor É ALCANÇÁVEL desde a revisão do dono (achado 2): `runOne` repassa
   * `ctx.signal` ao runner, e o core preenche esse campo com o
   * `TurnExecutionContext.signal` da tentativa. Perdida a lease durante o
   * `procedure-selector` ou o `role-selector`, o node termina em `cancelled`
   * com `output: null` — e o guard logo após `runNodes` em `src/agent/core.ts`
   * encerra a tentativa antes que qualquer output seja consumido.
   */
  status: 'success' | 'timeout' | 'error' | 'skipped' | 'cancelled';
  output: TOut | null;
  latency_ms: number;
  fallback_triggered: boolean;
};

/** Resultado do grafo inteiro (uma layer ou o pipeline todo). */
export type GraphRunResult = {
  /**
   * Wall-clock total da execução de `runNodes` (do entry até o return),
   * em ms. Para a camada SYNC_CONDITIONAL paralela isto é dominado pelo
   * node mais lento, não pela soma — é o tempo *percebido* pelo caller,
   * que é o que importa pra budget de latência p95.
   */
  total_latency_ms: number;
  /** Outputs indexados por `descriptor.name`. */
  nodes: Record<string, NodeRunResult<unknown>>;
};

/** Input compartilhado do grafo (campos comuns a todos os nodes). */
export type GraphContext = {
  conversa_id?: string;
  turno_id?: string;
  /**
   * Issue #507 (achado 2) — o sinal de CANCELAMENTO da tentativa de turno,
   * vindo de `TurnExecutionContext.signal`.
   *
   * Sem ele, `procedure-selector` e `role-selector` — que rodam entre o
   * pending-gate e o ReAct — seguiam até o próprio timeout depois de a lease
   * cair, e seus resultados ainda podiam virar writes (`procedure_selector_
   * decisions`, `role_selector_decisions`, start/switch de execução).
   *
   * Opcional porque o grafo também roda fora de um turno reivindicado (testes,
   * workers). Ausente ⇒ comportamento idêntico ao anterior.
   */
  signal?: AbortSignal;
};
