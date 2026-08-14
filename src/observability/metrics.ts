/**
 * Issue #514 — the sanitized metric surface.
 *
 * Every metric introduced by the observability work goes through here instead
 * of calling `src/lib/metrics.ts` directly, so that:
 *
 *   - the label allowlist / PII guard / cardinality budget in `labels.ts` is
 *     unavoidable rather than a convention someone can forget;
 *   - `tenant_id` + `agent_id` are attached automatically from ALS (AGENTS.md
 *     §4.1), with the sanctioned `system` fallback used by `governance/audit.ts`
 *     for genuinely tenant-less paths;
 *   - instrumentation can never break a turn: emission is wrapped so a bug in
 *     the metric path degrades into a dropped sample, not a failed message.
 *
 * `src/lib/metrics.ts` stays the transport (in-memory Prometheus exposition);
 * this module is the policy layer on top of it.
 */
import { incCounter, observeHistogram, setGaugeProvider } from '@/lib/metrics.js';
import { tryGetCurrentContext } from '@/db/tenant-context.js';
import { logger } from '@/lib/logger.js';
import { sanitizeLabels, SELF_METRICS, type LabelViolation } from './labels.js';
import { METRIC } from './taxonomy.js';

/**
 * Reserved attribution used when there is no ALS tenant context. Mirrors
 * `src/governance/audit.ts`'s synthetic `system` fallback — NOT the `'default'`
 * literal, which AGENTS.md §4.8 rejects outright.
 */
const SYSTEM_ATTRIBUTION = { tenant_id: 'system', agent_id: 'system' } as const;

export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

/**
 * Atribuição EXPLÍCITA a partir de um escopo que pode não existir ainda.
 *
 * Existe porque passar `{ tenant_id: null }` para `counter()` NÃO é atribuir a
 * `system`: `prepare()` resolve com `??`, então `null` cai no ALS do momento da
 * emissão. Numa varredura global isso é a diferença entre uma série rotulada
 * `system` e uma série rotulada com o tenant do contexto que por acaso estava
 * vazando — e o rótulo errado é indistinguível do certo no dashboard.
 *
 * O colapso `null → system` é uma decisão de ROTULAGEM, não de dado: o bucket
 * sancionado para trabalho sem dono (ARCHITECTURE.md §7 e `governance/audit.ts`),
 * nunca o literal `'default'` que a invariante MUST nº 8 recusa. Quem precisa
 * saber que o escopo era ausente (e não igual ao da plataforma) tem a auditoria
 * e o evento, onde `target_tenant_id` continua `null`.
 */
export function scopeAttribution(scope: {
  tenant_id: string | null | undefined;
  agent_id: string | null | undefined;
}): { tenant_id: string; agent_id: string } {
  return {
    tenant_id: scope.tenant_id ?? SYSTEM_ATTRIBUTION.tenant_id,
    agent_id: scope.agent_id ?? SYSTEM_ATTRIBUTION.agent_id,
  };
}

/**
 * Read `tenant_id`/`agent_id` from ALS. Fail-SOFT by design: observability must
 * not be the thing that throws on a tenant-less path. Security decisions still
 * use the strict getters (`getCurrentTenant`), which fail closed.
 */
function attribution(): { tenant_id: string; agent_id: string } {
  try {
    const ctx = tryGetCurrentContext();
    if (!ctx) return SYSTEM_ATTRIBUTION;
    return { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id };
  } catch {
    return SYSTEM_ATTRIBUTION;
  }
}

function accountViolations(metric: string, violations: LabelViolation[]): void {
  if (violations.length === 0) return;
  for (const v of violations) {
    // Hand-built label set: `metric` and `reason` are both on the allowlist and
    // both come from our own enum, so this cannot recurse into a violation.
    if (v.reason === 'cardinality_overflow') {
      incCounter(SELF_METRICS.overflow, { metric, reason: v.key });
    } else {
      incCounter(SELF_METRICS.rejected, { metric, reason: v.reason });
    }
  }
  logger.debug(
    { metric, violations: violations.map((v) => `${v.key}:${v.reason}`) },
    'observability.metric_labels_sanitized',
  );
}

function prepare(
  metric: string,
  labels: MetricLabels | undefined,
  opts: { attribute?: boolean },
): Record<string, string> {
  const merged: Record<string, unknown> = { ...(labels ?? {}) };
  if (opts.attribute !== false) {
    const attr = attribution();
    // Caller-supplied tenant/agent wins (workers that iterate tenants set it
    // explicitly); ALS fills the gap otherwise.
    merged.tenant_id = merged.tenant_id ?? attr.tenant_id;
    merged.agent_id = merged.agent_id ?? attr.agent_id;
  }
  const { labels: safe, violations } = sanitizeLabels(metric, merged);
  accountViolations(metric, violations);
  return safe;
}

export interface EmitOptions {
  /**
   * Attach `tenant_id`/`agent_id` from ALS. Default true. Set false for
   * genuinely global series (process-level gauges) where a tenant label would
   * be meaningless and would multiply cardinality for nothing.
   */
  attribute?: boolean;
}

/** Increment a counter with sanitized labels. Never throws. */
export function counter(
  metric: string,
  labels?: MetricLabels,
  by = 1,
  opts: EmitOptions = {},
): void {
  try {
    incCounter(metric, prepare(metric, labels, opts), by);
  } catch (err) {
    logger.debug({ err, metric }, 'observability.counter_failed');
  }
}

/** Observe a histogram sample with sanitized labels. Never throws. */
export function histogram(
  metric: string,
  value: number,
  labels?: MetricLabels,
  opts: EmitOptions = {},
): void {
  if (!Number.isFinite(value)) return;
  try {
    observeHistogram(metric, value, prepare(metric, labels, opts));
  } catch (err) {
    logger.debug({ err, metric }, 'observability.histogram_failed');
  }
}

/**
 * Register a gauge provider. Gauges are process-global in `lib/metrics.ts`
 * (the name is the whole key), so labels are baked into the registered name by
 * the caller via `gaugeName()`.
 */
export function gauge(
  metric: string,
  provider: () => number | Promise<number>,
  labels?: MetricLabels,
): void {
  const safe = prepare(metric, labels, { attribute: false });
  setGaugeProvider(gaugeName(metric, safe), async () => {
    try {
      return await provider();
    } catch {
      // A gauge that cannot be read is NOT zero (issue #514: "métrica ausente
      // não é interpretada como zero saudável"). NaN renders as `NaN`, which
      // Prometheus treats as a stale/absent sample rather than a healthy 0.
      return Number.NaN;
    }
  });
}

/** Render `name{k="v",...}` with keys sorted, matching `lib/metrics.ts`. */
export function gaugeName(metric: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return metric;
  return `${metric}{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

export { METRIC };
