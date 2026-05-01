import { formatInTimeZone } from 'date-fns-tz';

export function formatBRL(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

export function parseBRL(input: string): number | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[^0-9.,-]/g, '').trim();
  if (!cleaned) return null;
  const sign = cleaned.startsWith('-') ? -1 : 1;
  const digits = cleaned.replace('-', '');
  const hasComma = digits.includes(',');
  const hasDot = digits.includes('.');
  let normalized: string;
  if (hasComma && hasDot) {
    normalized = digits.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    normalized = digits.replace(',', '.');
  } else if (hasDot) {
    const parts = digits.split('.');
    const last = parts[parts.length - 1] ?? '';
    if (parts.length === 2 && last.length === 2) {
      normalized = digits;
    } else {
      normalized = digits.replace(/\./g, '');
    }
  } else {
    normalized = digits;
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

export function toCents(value: number): number {
  return Math.round(value * 100);
}

export function isValidCPF(input: string): boolean {
  const d = input.replace(/\D/g, '');
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i]!, 10) * (10 - i);
  let check1 = (sum * 10) % 11;
  if (check1 === 10) check1 = 0;
  if (check1 !== parseInt(d[9]!, 10)) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i]!, 10) * (11 - i);
  let check2 = (sum * 10) % 11;
  if (check2 === 10) check2 = 0;
  return check2 === parseInt(d[10]!, 10);
}

export function formatCPF(input: string): string {
  const d = input.replace(/\D/g, '').padStart(11, '0').slice(-11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function isValidCNPJ(input: string): boolean {
  const d = input.replace(/\D/g, '');
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sumWeighted = (digits: string, weights: number[]): number => {
    let s = 0;
    for (let i = 0; i < weights.length; i++) s += parseInt(digits[i]!, 10) * weights[i]!;
    return s;
  };
  const r1 = sumWeighted(d, w1) % 11;
  const check1 = r1 < 2 ? 0 : 11 - r1;
  if (check1 !== parseInt(d[12]!, 10)) return false;
  const r2 = sumWeighted(d, w2) % 11;
  const check2 = r2 < 2 ? 0 : 11 - r2;
  return check2 === parseInt(d[13]!, 10);
}

export function formatCNPJ(input: string): string {
  const d = input.replace(/\D/g, '').padStart(14, '0').slice(-14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export type DocumentClassification =
  | { kind: 'cpf'; canonical: string }
  | { kind: 'cnpj'; canonical: string }
  | { kind: 'invalid' };

export function classifyDocument(input: string): DocumentClassification {
  const d = input.replace(/\D/g, '');
  if (d.length === 11) return isValidCPF(d) ? { kind: 'cpf', canonical: d } : { kind: 'invalid' };
  if (d.length === 14)
    return isValidCNPJ(d) ? { kind: 'cnpj', canonical: d } : { kind: 'invalid' };
  return { kind: 'invalid' };
}

export type PixKeyKind = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

export function detectPixKey(input: string): { kind: PixKeyKind; canonical: string } | null {
  const t = input.trim();
  const doc = classifyDocument(t);
  if (doc.kind === 'cpf') return { kind: 'cpf', canonical: doc.canonical };
  if (doc.kind === 'cnpj') return { kind: 'cnpj', canonical: doc.canonical };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'email', canonical: t.toLowerCase() };
  const phone = normalizePhoneBR(t);
  if (phone) return { kind: 'phone', canonical: phone };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t))
    return { kind: 'random', canonical: t.toLowerCase() };
  return null;
}

const PIX_E2E_RE = /^E\d{8}\d{12}[A-Za-z0-9]{12}$/;
export function isValidEndToEndId(s: string): boolean {
  return PIX_E2E_RE.test(s);
}

export function normalizePhoneBR(input: string): string | null {
  const stripped = input.replace(/[^\d+]/g, '');
  let digits = stripped.startsWith('+') ? stripped.slice(1) : stripped;
  if (digits.length < 10) return null;
  if (!digits.startsWith('55')) {
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
    else return null;
  }
  if (digits.length < 12 || digits.length > 13) return null;
  const ddd = parseInt(digits.slice(2, 4), 10);
  if (ddd < 11 || ddd > 99) return null;
  const local = digits.slice(4);
  if (local.length === 9 && !local.startsWith('9')) return null;
  if (local.length !== 8 && local.length !== 9) return null;
  return '+' + digits;
}

const NATIONAL_HOLIDAYS_2025 = [
  '2025-01-01',
  '2025-03-03',
  '2025-03-04',
  '2025-04-18',
  '2025-04-21',
  '2025-05-01',
  '2025-06-19',
  '2025-09-07',
  '2025-10-12',
  '2025-11-02',
  '2025-11-15',
  '2025-11-20',
  '2025-12-25',
];

const NATIONAL_HOLIDAYS_2026 = [
  '2026-01-01',
  '2026-02-16',
  '2026-02-17',
  '2026-04-03',
  '2026-04-21',
  '2026-05-01',
  '2026-06-04',
  '2026-09-07',
  '2026-10-12',
  '2026-11-02',
  '2026-11-15',
  '2026-11-20',
  '2026-12-25',
];

const NATIONAL_HOLIDAYS_2027 = [
  '2027-01-01',
  '2027-02-08',
  '2027-02-09',
  '2027-03-26',
  '2027-04-21',
  '2027-05-01',
  '2027-05-27',
  '2027-09-07',
  '2027-10-12',
  '2027-11-02',
  '2027-11-15',
  '2027-11-20',
  '2027-12-25',
];

export const NATIONAL_HOLIDAYS = new Set([
  ...NATIONAL_HOLIDAYS_2025,
  ...NATIONAL_HOLIDAYS_2026,
  ...NATIONAL_HOLIDAYS_2027,
]);

export function isBusinessDayBR(date: Date, tz = 'America/Sao_Paulo'): boolean {
  const isoDate = formatInTimeZone(date, tz, 'yyyy-MM-dd');
  const weekday = parseInt(formatInTimeZone(date, tz, 'i'), 10);
  if (weekday === 6 || weekday === 7) return false;
  return !NATIONAL_HOLIDAYS.has(isoDate);
}

export function nextBusinessDayBR(date: Date, tz = 'America/Sao_Paulo'): Date {
  let d = new Date(date.getTime());
  do {
    d = new Date(d.getTime() + 86_400_000);
  } while (!isBusinessDayBR(d, tz));
  return d;
}

export function previousBusinessDayBR(date: Date, tz = 'America/Sao_Paulo'): Date {
  let d = new Date(date.getTime());
  do {
    d = new Date(d.getTime() - 86_400_000);
  } while (!isBusinessDayBR(d, tz));
  return d;
}

export function isValidLinhaDigitavel(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length !== 47) return false;
  // Validate the three field DV (mod 10)
  for (const [start, end, dvIdx] of [
    [0, 9, 9],
    [10, 20, 20],
    [21, 31, 31],
  ] as const) {
    const seg = d.slice(start, end);
    if (mod10(seg) !== parseInt(d[dvIdx]!, 10)) return false;
  }
  return true;
}

function mod10(s: string): number {
  let weight = 2;
  let sum = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    let p = parseInt(s[i]!, 10) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  const r = sum % 10;
  return r === 0 ? 0 : 10 - r;
}

export interface BoletoParseResult {
  banco_codigo: string;
  vencimento_data: string;
  valor: number;
  campo_livre: string;
  codigo_barras: string;
}

const FATOR_BASE = Date.UTC(1997, 9, 7);

export function parseLinhaDigitavel(s: string): BoletoParseResult | null {
  const d = s.replace(/\D/g, '');
  if (!isValidLinhaDigitavel(d)) return null;
  const banco_codigo = d.slice(0, 3);
  const fatorStr = d.slice(33, 37);
  const valorStr = d.slice(37, 47);
  const fator = parseInt(fatorStr, 10);
  let venc = new Date(FATOR_BASE + fator * 86_400_000);
  if (fator < 1000) {
    // wrap after 2025-02-22
    venc = new Date(FATOR_BASE + (fator + 9000) * 86_400_000);
  }
  const valor = parseInt(valorStr, 10) / 100;
  const codigo_barras =
    d.slice(0, 4) + d.slice(32, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  return {
    banco_codigo,
    vencimento_data: venc.toISOString().slice(0, 10),
    valor,
    campo_livre: d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31),
    codigo_barras,
  };
}

export const BANCOS_CODIGO: Readonly<Record<string, string>> = {
  '001': 'Banco do Brasil',
  '033': 'Santander',
  '041': 'Banrisul',
  '077': 'Inter',
  '104': 'Caixa Econômica Federal',
  '208': 'BTG Pactual',
  '237': 'Bradesco',
  '260': 'Nubank',
  '290': 'PagBank',
  '341': 'Itaú',
  '380': 'PicPay',
  '422': 'Safra',
  '748': 'Sicredi',
  '756': 'Sicoob',
};

export function fmtBR(date: Date, pattern = 'dd/MM/yyyy', tz = 'America/Sao_Paulo'): string {
  return formatInTimeZone(date, tz, pattern);
}
