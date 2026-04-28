import { describe, it, expect } from 'vitest';
import { parseOFX } from '../../src/import/ofx-parser.js';
import { parseCSV } from '../../src/import/csv-parser.js';

const SAMPLE_OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX>
  <BANKMSGSRSV1><STMTTRNRS>
    <STMTRS>
      <BANKACCTFROM>
        <BANKID>341</BANKID>
        <ACCTID>12345-6</ACCTID>
      </BANKACCTFROM>
      <BANKTRANLIST>
        <DTSTART>20260401</DTSTART>
        <DTEND>20260430</DTEND>
        <STMTTRN>
          <TRNTYPE>DEBIT</TRNTYPE>
          <DTPOSTED>20260415</DTPOSTED>
          <TRNAMT>-1234.56</TRNAMT>
          <FITID>F-001</FITID>
          <NAME>MERCADO XPTO</NAME>
          <MEMO>Compra cartão</MEMO>
        </STMTTRN>
        <STMTTRN>
          <TRNTYPE>CREDIT</TRNTYPE>
          <DTPOSTED>20260420</DTPOSTED>
          <TRNAMT>5000.00</TRNAMT>
          <FITID>F-002</FITID>
          <NAME>CLIENTE ABC</NAME>
        </STMTTRN>
      </BANKTRANLIST>
    </STMTRS>
  </STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('ofx parser', () => {
  it('parseia header e ranges', () => {
    const r = parseOFX(SAMPLE_OFX);
    expect(r.account_number).toBe('12345-6');
    expect(r.bank_id).toBe('341');
    expect(r.periodo_de).toBe('2026-04-01');
    expect(r.periodo_ate).toBe('2026-04-30');
  });
  it('extrai 2 transações', () => {
    const r = parseOFX(SAMPLE_OFX);
    expect(r.entries.length).toBe(2);
  });
  it('classifica débito e crédito', () => {
    const r = parseOFX(SAMPLE_OFX);
    expect(r.entries[0]!.tipo_oper).toBe('debit');
    expect(r.entries[1]!.tipo_oper).toBe('credit');
  });
  it('extrai FITID', () => {
    const r = parseOFX(SAMPLE_OFX);
    expect(r.entries[0]!.fitid).toBe('F-001');
  });
});

describe('csv parser', () => {
  it('reconhece formato Inter', () => {
    const csv = `Data Lançamento;Descrição;Valor
15/04/2026;Mercado XPTO;-1234,56
20/04/2026;Cliente ABC;5000,00`;
    const r = parseCSV(csv);
    expect(r.profile).toBe('inter');
    expect(r.entries.length).toBe(2);
    expect(r.entries[0]!.tipo_oper).toBe('debit');
    expect(r.entries[1]!.tipo_oper).toBe('credit');
  });
});
