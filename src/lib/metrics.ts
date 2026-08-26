/**
 * Minimal in-memory Prometheus exposition. No external dep — keeps the spec
 * 17 §5 surface available for owners who scrape, and a no-op for everyone
 * else. Counters survive only the process lifetime; gauges are recomputed
 * on each scrape via the `gaugeProviders` map.
 */
const counters = new Map<string, number>();
const gaugeProviders = new Map<string, () => number | Promise<number>>();
const histograms = new Map<
  string,
  { sum: number; count: number; buckets: number[]; counts: number[] }
>();

const DEFAULT_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

/**
 * Baldes por MÉTRICA, para as histogramas que não medem milissegundos.
 *
 * Issue #628: `maia_stream_debounce_batch_size` mede QUANTAS mensagens um batch
 * de debounce agrupou — um número entre 1 e uma dezena. Com os baldes de
 * milissegundos acima, TODA amostra cairia em `le="50"`, e a série pareceria
 * uma distribuição enquanto na prática só `_sum`/`_count` diriam alguma coisa.
 * Um histograma cujos baldes não separam nada é pior que nenhum: ele responde a
 * `histogram_quantile()` com um número que parece medido.
 *
 * O registro é por NOME (sem labels), preenchido no import do módulo que é dono
 * da métrica, e lido só na PRIMEIRA amostra de cada série — trocar os baldes de
 * uma série já iniciada mudaria o significado das contagens acumuladas, então a
 * escolha é congelada junto com a série.
 */
const bucketsPorMetrica = new Map<string, readonly number[]>();

/**
 * Declara os baldes de uma histograma que não mede tempo. Idempotente; sem
 * efeito sobre séries JÁ criadas (ver acima).
 */
export function registerHistogramBuckets(name: string, buckets: readonly number[]): void {
  bucketsPorMetrica.set(name, [...buckets].sort((a, b) => a - b));
}

function key(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escape(v)}"`);
  return `${name}{${parts.join(',')}}`;
}

function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function splitNameAndInnerLabels(k: string): { name: string; inner: string } {
  const i = k.indexOf('{');
  if (i === -1) return { name: k, inner: '' };
  return { name: k.slice(0, i), inner: k.slice(i + 1, -1) };
}

export function incCounter(name: string, labels?: Record<string, string>, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function setGaugeProvider(name: string, provider: () => number | Promise<number>): void {
  gaugeProviders.set(name, provider);
}

export function observeHistogram(
  name: string,
  value: number,
  labels?: Record<string, string>,
): void {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    // Os baldes vêm do registro por nome quando a métrica os declarou; do
    // padrão de milissegundos quando não. A leitura acontece UMA vez por série,
    // na primeira amostra — ver `bucketsPorMetrica`.
    const buckets = [...(bucketsPorMetrica.get(name) ?? DEFAULT_BUCKETS_MS)];
    h = {
      sum: 0,
      count: 0,
      buckets,
      counts: new Array(buckets.length + 1).fill(0),
    };
    histograms.set(k, h);
  }
  h.sum += value;
  h.count += 1;
  let placed = false;
  for (let i = 0; i < h.buckets.length; i++) {
    if (value <= h.buckets[i]!) {
      h.counts[i]! += 1;
      placed = true;
      break;
    }
  }
  if (!placed) h.counts[h.buckets.length]! += 1;
}

export async function renderPrometheus(): Promise<string> {
  const lines: string[] = [];
  for (const [k, v] of counters) lines.push(`${k} ${v}`);
  for (const [name, provider] of gaugeProviders) {
    try {
      const v = await provider();
      lines.push(`${name} ${v}`);
    } catch {
      // skip on provider error
    }
  }
  for (const [k, h] of histograms) {
    const { name, inner } = splitNameAndInnerLabels(k);
    const sumCountLabels = inner ? `{${inner}}` : '';
    const bucketLabel = (le: string): string => (inner ? `{${inner},le="${le}"}` : `{le="${le}"}`);
    let cumulative = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative += h.counts[i]!;
      lines.push(`${name}_bucket${bucketLabel(String(h.buckets[i]))} ${cumulative}`);
    }
    cumulative += h.counts[h.buckets.length]!;
    lines.push(`${name}_bucket${bucketLabel('+Inf')} ${cumulative}`);
    lines.push(`${name}_sum${sumCountLabels} ${h.sum}`);
    lines.push(`${name}_count${sumCountLabels} ${h.count}`);
  }
  return lines.join('\n') + '\n';
}

export function _resetForTests(): void {
  counters.clear();
  gaugeProviders.clear();
  histograms.clear();
}

export const _internal = { key };
