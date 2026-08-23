import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import type { ModuleDescriptor, NodeRunResult, GraphRunResult, GraphContext } from './types.js';
import { CognitiveLayer } from '@/types/enums.js';

/**
 * Executa uma lista de nodes respeitando a camada de cada um.
 *
 * - **SYNC_REQUIRED**: serial, na ordem do array. Falha de qualquer um ainda
 *   retorna fallback e continua os próximos — princípio "não trava resposta"
 *   vale também aqui (a *resposta* user-facing depende do reasoner; periféricos
 *   sync_required existem mas não devem ser bloqueadores).
 * - **SYNC_CONDITIONAL**: nodes com `parallelizable=true` rodam em paralelo
 *   (Promise.all); demais rodam serial após. `runWhen=false` skipa o node.
 * - **ASYNC**: fire-and-forget. Retorna placeholder `success/null` imediato
 *   sem esperar a promessa. Erros são swallowed + logados.
 *
 * Mistura de camadas no mesmo array é permitida — cada node é tratado
 * isoladamente conforme sua `layer`. Caller normalmente passa nodes de uma
 * camada só por chamada (`runNodes(syncRequired, ...)` então `runNodes(syncCond, ...)`),
 * mas heterogêneo funciona.
 */
export async function runNodes<TCtx extends GraphContext>(
  nodes: ModuleDescriptor<TCtx, unknown>[],
  context: TCtx,
): Promise<GraphRunResult> {
  const results: Record<string, NodeRunResult<unknown>> = {};
  const t0 = Date.now();

  // Particiona por camada para política de execução.
  const required: ModuleDescriptor<TCtx, unknown>[] = [];
  const conditional: ModuleDescriptor<TCtx, unknown>[] = [];
  const asyncs: ModuleDescriptor<TCtx, unknown>[] = [];
  for (const n of nodes) {
    if (n.layer === CognitiveLayer.SYNC_REQUIRED) required.push(n);
    else if (n.layer === CognitiveLayer.SYNC_CONDITIONAL) conditional.push(n);
    else asyncs.push(n);
  }

  // SYNC_REQUIRED — serial.
  for (const n of required) {
    results[n.name] = await runOne(n, context);
  }

  // SYNC_CONDITIONAL — paralelos (Promise.all) + serial após.
  const parallels = conditional.filter((n) => n.parallelizable === true);
  const serials = conditional.filter((n) => n.parallelizable !== true);
  if (parallels.length > 0) {
    const ps = await Promise.all(parallels.map((n) => runOne(n, context)));
    parallels.forEach((n, i) => { results[n.name] = ps[i]!; });
  }
  for (const n of serials) {
    results[n.name] = await runOne(n, context);
  }

  // ASYNC — fire-and-forget. Placeholder result.
  for (const n of asyncs) {
    results[n.name] = { status: 'success', output: null, latency_ms: 0, fallback_triggered: false };
    void runOne(n, context).catch((err) => {
      logger.warn(
        { module: n.name, err: (err as Error).message },
        'cognitive-graph.async_node_failed',
      );
    });
  }

  return { total_latency_ms: Date.now() - t0, nodes: results };
}

async function runOne<TCtx extends GraphContext>(
  n: ModuleDescriptor<TCtx, unknown>,
  ctx: TCtx,
): Promise<NodeRunResult<unknown>> {
  // runWhen=false → SKIPPED, não chama runCognitiveModule (sem audit).
  if (n.runWhen && !n.runWhen(ctx)) {
    return { status: 'skipped', output: null, latency_ms: 0, fallback_triggered: false };
  }

  const r = await runCognitiveModule(
    {
      name: n.name,
      version: n.version,
      triggered_by: n.layer, // mesma string literal pelo design dos enums (Task 1)
      timeoutMs: n.timeoutMs,
      fallback: n.fallback,
      conversa_id: ctx.conversa_id,
      turno_id: ctx.turno_id,
      // Issue #507 (achado 2 da revisão do dono) — o sinal da TENTATIVA de
      // turno atravessa o grafo. Sem isto o runner nunca via cancelamento por
      // aqui e `cancelled` era literalmente inalcançável no grafo: os nodes
      // rodavam até o próprio timeout depois de a lease cair, e o resultado
      // ainda podia virar write.
      signal: ctx.signal,
    },
    // ... e o sinal COMPOSTO (turno + timeout do node) chega ao `run` do node,
    // que é quem sabe entregá-lo à operação subjacente (`callLLM`, um port).
    (signal) => n.run(ctx, signal),
  );

  return {
    status: r.status,
    output: r.output,
    latency_ms: r.latency_ms,
    fallback_triggered: r.fallback_triggered,
  };
}
