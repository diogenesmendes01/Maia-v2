import type { OFXEntry } from './ofx-parser.js';
import { parseBRL } from '@/lib/brazilian.js';

export type CSVProfile = {
  name: string;
  detect: (header: string[]) => boolean;
  extract: (row: string[], header: string[]) => OFXEntry | null;
};

const PROFILES: CSVProfile[] = [
  {
    name: 'inter',
    detect: (h) => h.some((c) => /data\s+lan/i.test(c)) && h.some((c) => /valor/i.test(c)),
    extract: (row, header) => {
      const idx = (re: RegExp) => header.findIndex((c) => re.test(c));
      const data = row[idx(/data/i)] ?? '';
      const desc = row[idx(/descric/i)] ?? row[idx(/lan[çc]amento/i)] ?? '';
      const val = parseBRL(row[idx(/valor/i)] ?? '0') ?? 0;
      const iso = brToIso(data);
      if (!iso) return null;
      return {
        tipo_oper: val >= 0 ? 'credit' : 'debit',
        valor: Math.abs(val),
        data_oper: iso,
        memo: desc,
      };
    },
  },
  {
    name: 'itau',
    detect: (h) => h.some((c) => /^data$/i.test(c.trim())) && h.some((c) => /hist[óo]rico/i.test(c)),
    extract: (row, header) => {
      const idx = (re: RegExp) => header.findIndex((c) => re.test(c));
      const data = row[idx(/^data$/i)] ?? '';
      const desc = row[idx(/hist[óo]rico/i)] ?? '';
      const val = parseBRL(row[idx(/valor/i)] ?? '0') ?? 0;
      const iso = brToIso(data);
      if (!iso) return null;
      return {
        tipo_oper: val >= 0 ? 'credit' : 'debit',
        valor: Math.abs(val),
        data_oper: iso,
        memo: desc,
      };
    },
  },
];

function brToIso(s: string): string | null {
  const m = s.match(/(\d{2})[\/-](\d{2})[\/-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

export function parseCSV(input: string): { profile: string; entries: OFXEntry[] } {
  const lines = input.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { profile: 'unknown', entries: [] };
  const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
  const header = (lines[0] ?? '').split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  const profile = PROFILES.find((p) => p.detect(header));
  if (!profile) return { profile: 'unknown', entries: [] };
  const entries: OFXEntry[] = [];
  for (const ln of lines.slice(1)) {
    const cols = ln.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const e = profile.extract(cols, header);
    if (e) entries.push(e);
  }
  return { profile: profile.name, entries };
}
