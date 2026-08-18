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
  /** Implementação. Recebe input tipado, retorna output tipado. */
  run: (input: TIn) => Promise<TOut>;
};

/** Resultado de um único node. Mirror de `RunModuleResult` mas com nome do node. */
export type NodeRunResult<TOut> = {
  /**
   * Issue #507 — espelha `RunModuleResult['status']`, e por isso ganhou
   * `cancelled` junto. Hoje o valor é INALCANÇÁVEL por aqui: `runOne` não passa
   * `signal` ao runner, e sem sinal o runner nunca produz `cancelled`. O tipo
   * acompanha assim mesmo porque a alternativa — estreitar com um `else`
   * inventado no orchestrator — criaria um ramo morto que mentiria sobre o
   * desfecho no dia em que o grafo receber o sinal do turno.
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
};
