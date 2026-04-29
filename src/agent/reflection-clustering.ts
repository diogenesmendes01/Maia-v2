import { stripDiacritics } from '@/lib/utils.js';

export type CorrectionSignal = {
  alvo_id: string | null;
  descricao: string;
  contexto: Record<string, unknown>;
};

export type Cluster = {
  key: string;
  descricao_normalized: string;
  signals: CorrectionSignal[];
};

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'no', 'na',
  'um', 'uma', 'pra', 'para', 'por', 'com', 'sem',
]);

export function normalizeDescricao(input: string): string {
  return stripDiacritics(input.toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .slice(0, 4)
    .join(' ');
}

/**
 * Group correction signals by normalized descricao prefix. A cluster of size
 * >=2 means the same kind of mistake repeated — strongest signal that a rule
 * is needed. Singletons still produce a candidate but with lower priority.
 */
export function clusterCorrections(signals: CorrectionSignal[]): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const s of signals) {
    const norm = normalizeDescricao(s.descricao);
    if (!norm) continue;
    const existing = map.get(norm);
    if (existing) {
      existing.signals.push(s);
    } else {
      map.set(norm, { key: norm, descricao_normalized: norm, signals: [s] });
    }
  }
  // Sort: clusters with more signals first (strongest evidence).
  return [...map.values()].sort((a, b) => b.signals.length - a.signals.length);
}
