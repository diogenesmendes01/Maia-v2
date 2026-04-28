export type OFXEntry = {
  fitid?: string;
  tipo_oper: 'credit' | 'debit';
  valor: number;
  data_oper: string;
  memo?: string;
  contraparte_raw?: string;
};

export type OFXParsed = {
  account_number: string | null;
  bank_id: string | null;
  periodo_de: string | null;
  periodo_ate: string | null;
  entries: OFXEntry[];
};

/** Parses both OFX 1.x (SGML) and OFX 2.x (XML). */
export function parseOFX(input: string): OFXParsed {
  const text = input.replace(/\r/g, '');
  const account_number = match1(text, /<ACCTID>([^<\n]+)/i);
  const bank_id = match1(text, /<BANKID>([^<\n]+)/i);
  const periodo_de = isoDate(match1(text, /<DTSTART>([^<\n]+)/i));
  const periodo_ate = isoDate(match1(text, /<DTEND>([^<\n]+)/i));
  const entries: OFXEntry[] = [];
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>|<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTTRNRS>)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const block = m[1] ?? m[2] ?? '';
    const trntype = match1(block, /<TRNTYPE>([^<\n]+)/i)?.toUpperCase() ?? '';
    const dtposted = match1(block, /<DTPOSTED>([^<\n]+)/i);
    const trnamt = match1(block, /<TRNAMT>([^<\n]+)/i);
    const fitid = match1(block, /<FITID>([^<\n]+)/i)?.trim();
    const memo = match1(block, /<MEMO>([^<\n]+)/i)?.trim();
    const name = match1(block, /<NAME>([^<\n]+)/i)?.trim();
    if (!dtposted || !trnamt) continue;
    const valor = Math.abs(parseFloat(trnamt));
    if (!Number.isFinite(valor)) continue;
    entries.push({
      fitid,
      tipo_oper: trntype === 'CREDIT' || parseFloat(trnamt) > 0 ? 'credit' : 'debit',
      valor,
      data_oper: isoDate(dtposted) ?? dtposted.slice(0, 10),
      memo,
      contraparte_raw: name,
    });
  }
  return {
    account_number: account_number?.trim() ?? null,
    bank_id: bank_id?.trim() ?? null,
    periodo_de,
    periodo_ate,
    entries,
  };
}

function match1(s: string, re: RegExp): string | undefined {
  const m = s.match(re);
  return m?.[1];
}

function isoDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const t = raw.replace(/\D/g, '');
  if (t.length < 8) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}
