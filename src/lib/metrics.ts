/**
 * Minimal in-memory Prometheus exposition. No external dep — keeps the spec
 * 17 §5 surface available for owners who scrape, and a no-op for everyone
 * else. Counters survive only the process lifetime; gauges are recomputed
 * on each scrape via the `gaugeProviders` map.
 */
const counters = new Map<string, number>();
const gaugeProviders = new Map<string, () => number | Promise<number>>();
const histograms = new Map<string, { sum: number; count: number; buckets: number[]; counts: number[] }>();

const DEFAULT_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

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

export function incCounter(name: string, labels?: Record<string, string>, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function setGaugeProvider(name: string, provider: () => number | Promise<number>): void {
  gaugeProviders.set(name, provider);
}

export function observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
  const k = key(name, labels);
  let h = histograms.get(k);
  if (!h) {
    h = { sum: 0, count: 0, buckets: DEFAULT_BUCKETS_MS, counts: new Array(DEFAULT_BUCKETS_MS.length + 1).fill(0) };
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
    const base = k.includes('{') ? k.slice(0, -1) : k;
    let cumulative = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cumulative += h.counts[i]!;
      const sep = base.endsWith('{') ? '' : ',';
      lines.push(`${base}_bucket${base.endsWith('{') ? '' : sep}le="${h.buckets[i]}"} ${cumulative}`);
    }
    cumulative += h.counts[h.buckets.length]!;
    lines.push(`${base}_bucket${base.endsWith('{') ? '' : ','}le="+Inf"} ${cumulative}`);
    lines.push(`${base.replace('_bucket', '')}_sum ${h.sum}`);
    lines.push(`${base.replace('_bucket', '')}_count ${h.count}`);
  }
  return lines.join('\n') + '\n';
}

export const _internal = { key };
