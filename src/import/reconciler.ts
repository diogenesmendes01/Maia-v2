import { transacoesRepo } from '@/db/repositories.js';
import { trigramSim, stripDiacritics } from '@/lib/utils.js';
import type { OFXEntry } from './ofx-parser.js';
import type { Transacao } from '@/db/schema.js';

export type EntryStatus = 'matched' | 'candidate' | 'new';
export type ReconciledEntry = {
  entry: OFXEntry;
  status: EntryStatus;
  matched?: { transacao_id: string; score: number };
  candidates?: Array<{ transacao_id: string; score: number; descricao: string }>;
};

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function score(entry: OFXEntry, t: Transacao): number {
  if (entry.fitid) {
    const meta = (t.metadata ?? {}) as { fitid?: string };
    if (meta.fitid && meta.fitid === entry.fitid) return 1.0;
  }
  let s = 0;
  if (Math.abs(Number(t.valor) - entry.valor) < 0.01) s += 0.4;
  if (
    (entry.tipo_oper === 'debit' && t.natureza === 'despesa') ||
    (entry.tipo_oper === 'credit' && t.natureza === 'receita')
  )
    s += 0.1;
  s +=
    0.4 *
    trigramSim(
      stripDiacritics(((entry.memo ?? '') + ' ' + (entry.contraparte_raw ?? '')).toLowerCase()),
      stripDiacritics((t.descricao + ' ' + (t.contraparte ?? '')).toLowerCase()),
    );
  s += Math.max(0, 0.1 - daysBetween(entry.data_oper, t.data_competencia) * 0.02);
  return Math.min(1, s);
}

export async function reconcile(input: {
  conta_id: string;
  entidade_id: string;
  pessoa_id: string;
  entries: OFXEntry[];
}): Promise<ReconciledEntry[]> {
  const out: ReconciledEntry[] = [];
  for (const e of input.entries) {
    const from = new Date(new Date(e.data_oper).getTime() - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const to = new Date(new Date(e.data_oper).getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const candidates = await transacoesRepo.byScope(
      { pessoa_id: input.pessoa_id, entidades: [input.entidade_id] },
      { date_from: from, date_to: to, limit: 200 },
    );
    const ranked = candidates
      .map((t) => ({ t, sc: score(e, t) }))
      .sort((a, b) => b.sc - a.sc);
    const top = ranked[0];
    if (!top || ranked.length === 0) {
      out.push({ entry: e, status: 'new' });
      continue;
    }
    if (top.sc >= 0.9) {
      out.push({
        entry: e,
        status: 'matched',
        matched: { transacao_id: top.t.id, score: top.sc },
      });
    } else if (top.sc >= 0.6) {
      out.push({
        entry: e,
        status: 'candidate',
        candidates: ranked.slice(0, 3).map((r) => ({
          transacao_id: r.t.id,
          score: r.sc,
          descricao: r.t.descricao,
        })),
      });
    } else {
      out.push({ entry: e, status: 'new' });
    }
  }
  return out;
}
