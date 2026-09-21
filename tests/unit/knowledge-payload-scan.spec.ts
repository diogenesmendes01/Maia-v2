/**
 * P08 / G3 (spec §7.6.2) — varredura determinística do payload.
 *
 * O defeito que estes casos cercam: a classificação de risco de um item de
 * conhecimento nunca olhou o conteúdo. A heurística decide por forma
 * (`knowledge_type`, `topic`, confiança) e o texto só chegava ao gate de LLM
 * cortado em 200 caracteres. Um CPF no caractere 400 atravessava os dois.
 *
 * Duas propriedades importam mais que qualquer achado individual:
 *
 *  1. **Só eleva.** Nada aqui pode baixar risco. Um scanner capaz de dizer
 *     "não achei, pode liberar" seria fail-open com outro nome.
 *  2. **Cobertura é afirmada, não presumida.** O que não foi percorrido vira
 *     `incomplete`, e `incomplete` vale `high` — porque a alternativa é
 *     liberar um payload que ninguém terminou de ler.
 */
import { describe, it, expect } from 'vitest';
import {
  scanPayload,
  riskFloorFromScan,
  MAX_SCAN_DEPTH,
  MAX_SCAN_NODES,
  MAX_SCAN_CHARS,
} from '@/control-plane/knowledge-state-machine/payload-scan.js';

// CPF sintético com dígito verificador válido.
const CPF_VALIDO = '529.982.247-25';

describe('scanPayload — cobertura integral', () => {
  it('acha conteúdo sensível MUITO além do caractere 200', () => {
    // O caso que nomeia a fatia: o prefixo de 200 caracteres não veria isto.
    const payload = { nota: 'x'.repeat(4000) + ` doc ${CPF_VALIDO}` };
    const scan = scanPayload(payload);
    expect(scan.coverage).toBe('complete');
    expect(scan.findings.map((f) => f.signal)).toContain('cpf');
  });

  it('percorre profundidade e arrays, não só o primeiro nível', () => {
    const scan = scanPayload({ a: [{ b: { c: [`meu cpf é ${CPF_VALIDO}`] } }] });
    expect(scan.findings.some((f) => f.signal === 'cpf')).toBe(true);
    expect(scan.findings[0]?.path).toContain('a[0].b.c[0]');
  });

  it('marca segredo pelo NOME do campo, não só pelo valor', () => {
    // Um token não tem forma reconhecível; o que o denuncia é a palavra ao lado.
    const scan = scanPayload({ api_key: 'zzzzzzzzzzzz' });
    expect(scan.findings.some((f) => f.signal === 'secret_like')).toBe(true);
  });

  it('onze dígitos sem dígito verificador válido NÃO viram CPF', () => {
    // Um scanner que grita em todo número de protocolo é um scanner que
    // alguém desliga.
    const scan = scanPayload({ protocolo: '111.111.111-11' });
    expect(scan.findings.some((f) => f.signal === 'cpf')).toBe(false);
  });

  it('UUID não é telefone nem cartão — regressão do falso positivo', () => {
    // A primeira versão desta varredura reprovou o CI marcando `phone_br` num
    // `subject_id`. Um UUID é uma corrida de dígitos separados por hífen, e as
    // heurísticas de telefone e cartão são heurísticas sobre exatamente isso.
    // O efeito não era cosmético: o fato passava a exigir revisão humana por
    // causa do próprio identificador dele.
    const pid = '11111111-2222-3333-4444-555555555555';
    const scan = scanPayload({ content: 'hi', subject_id: pid });
    expect(scan.findings).toEqual([]);
    expect(riskFloorFromScan(scan)).toBeNull();

    // Sem hífen também: a casa usa as duas formas.
    expect(scanPayload({ id: pid.replace(/-/g, '') }).findings).toEqual([]);
  });

  it('telefone com +55 não vira TAMBÉM cartão', () => {
    // Treze dígitos contíguos são a faixa de um PAN. Sem mascarar o telefone
    // antes, o mesmo valor saía com dois achados, e o operador leria "cartão"
    // onde havia um telefone.
    const scan = scanPayload({ t: '+5511987654321' });
    expect(scan.findings.map((f) => f.signal)).toEqual(['phone_br']);
  });

  it('o caminho do achado não carrega o valor encontrado', () => {
    const scan = scanPayload({ cliente: { documento: CPF_VALIDO } });
    const achado = scan.findings.find((f) => f.signal === 'cpf');
    expect(achado?.path).toBe('cliente.documento');
    expect(JSON.stringify(scan.findings)).not.toContain('529');
  });
});

describe('scanPayload — o que não foi percorrido é declarado', () => {
  it('payload profundo demais vira incomplete', () => {
    let fundo: unknown = CPF_VALIDO;
    for (let i = 0; i <= MAX_SCAN_DEPTH + 2; i++) fundo = { n: fundo };
    const scan = scanPayload(fundo);
    expect(scan.coverage).toBe('incomplete');
    expect(scan.coverage === 'incomplete' && scan.reason).toBe('too_deep');
  });

  it('payload grande demais vira incomplete', () => {
    const grande: Record<string, number> = {};
    for (let i = 0; i < MAX_SCAN_NODES + 10; i++) grande[`k${i}`] = i;
    const scan = scanPayload(grande);
    expect(scan.coverage).toBe('incomplete');
    expect(scan.coverage === 'incomplete' && scan.reason).toBe('too_large');
  });

  it('referência cíclica vira incomplete em vez de laço infinito', () => {
    const a: Record<string, unknown> = {};
    a.eu = a;
    const scan = scanPayload(a);
    expect(scan.coverage).toBe('incomplete');
    expect(scan.coverage === 'incomplete' && scan.reason).toBe('cyclic');
  });

  it('chave ultrapassando teto de caracteres vira incomplete com too_large', () => {
    // Reprodução: chave maior que MAX_SCAN_CHARS deveria marcar incompleto.
    const chaveGrande = 'x'.repeat(MAX_SCAN_CHARS + 1);
    const scan = scanPayload({ [chaveGrande]: null });
    expect(scan.coverage).toBe('incomplete');
    expect(scan.coverage === 'incomplete' && scan.reason).toBe('too_large');
  });

  it('objeto com muitas chaves nomeadas sensíveis interrompe após cutoff', () => {
    // Reprodução: objeto com MAX_SCAN_NODES + 100 chaves no padrão kN-password
    // deve retornar incomplete e NÃO emitir findings para além do cutoff.
    const muitas: Record<string, number> = {};
    const numChaves = MAX_SCAN_NODES + 100;
    for (let i = 0; i < numChaves; i++) {
      muitas[`k${i}-password`] = i;
    }
    const scan = scanPayload(muitas);
    expect(scan.coverage).toBe('incomplete');
    expect(scan.coverage === 'incomplete' && scan.reason).toBe('too_large');
    // Verificar que não emitimos findings excessivos: no máximo MAX_SCAN_NODES.
    expect(scan.findings.length).toBeLessThanOrEqual(MAX_SCAN_NODES);
  });
});

describe('riskFloorFromScan — piso, nunca teto', () => {
  it('payload limpo não vota em "baixo": devolve null', () => {
    // `null` é ausência de piso, não um piso baixo. A diferença é o que
    // impede a varredura de rebaixar o que a heurística decidiu.
    expect(riskFloorFromScan(scanPayload({ nota: 'saldo conferido' }))).toBeNull();
  });

  it('cobertura incompleta vale high, mesmo sem nenhum achado', () => {
    const a: Record<string, unknown> = {};
    a.eu = a;
    expect(riskFloorFromScan(scanPayload(a))).toBe('high');
  });

  it('CPF, cartão e segredo pisam em high; e-mail e telefone em medium', () => {
    expect(riskFloorFromScan(scanPayload({ d: CPF_VALIDO }))).toBe('high');
    expect(riskFloorFromScan(scanPayload({ senha: 'x' }))).toBe('high');
    expect(riskFloorFromScan(scanPayload({ c: '4111111111111111' }))).toBe('high');
    expect(riskFloorFromScan(scanPayload({ e: 'joao@exemplo.com' }))).toBe('medium');
  });
});
