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
});
