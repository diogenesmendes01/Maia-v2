import { describe, it, expect } from 'vitest';
import { detectGap } from '@/agent/gap-detector.js';

describe('detectGap', () => {
  it('detecta lacuna explícita', () => {
    expect(detectGap('não sei essa informação ainda').detected).toBe(true);
    expect(detectGap('precisaria verificar o status').detected).toBe(true);
    expect(detectGap('não tenho como consultar isso agora').detected).toBe(true);
    expect(detectGap('sem acesso a esse sistema').detected).toBe(true);
  });

  it('não detecta respostas normais', () => {
    expect(detectGap('o saldo é R$ 1.500,00').detected).toBe(false);
    expect(detectGap('agendado para sexta').detected).toBe(false);
  });

  // P81 review (Important #5): question-context filter.
  it('NÃO dispara quando o signal está próximo de um ?', () => {
    // pergunta ao usuário — não declaração de lacuna
    expect(detectGap('não sei se você quer X ou Y?').detected).toBe(false);
    expect(detectGap('não consigo precisar agora — pode confirmar?').detected).toBe(false);
    expect(detectGap('você precisaria de mais detalhes?').detected).toBe(false);
  });

  it('AINDA dispara quando o signal é declaração e ? está longe', () => {
    // ? aparece muito antes do signal → não filtra
    const long = 'tudo certo? '.padEnd(200, '.') + ' realmente não tenho como consultar isso agora.';
    expect(detectGap(long).detected).toBe(true);
  });
});
