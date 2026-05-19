/**
 * P8d §3 — proposal-generator priorities extractor.
 *
 * Determinístico, sem LLM. Extrai `priorities[]` (slugs snake_case) do
 * `maia-prompt.md` em ordem de precedência:
 *  1. Seção `## Prioridades` (lista numerada → slug)
 *  2. Senão, primeiras 3 entradas de `## Princípios` (slugifyFirstSentence)
 */
import { describe, it, expect } from 'vitest';
import { parsePrioritiesFromMarkdown } from '@/identity/proposal-generator.js';

describe('proposal-generator priorities (§3)', () => {
  it('extrai slugs de ## Prioridades (formato numerado)', () => {
    const md = `
# Maia

## Prioridades
1. preservar_capital_do_cliente
2. clareza_de_comunicacao
3. conformidade_regulatoria
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result).toContain('preservar_capital_do_cliente');
    expect(result).toContain('clareza_de_comunicacao');
    expect(result).toContain('conformidade_regulatoria');
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('deriva de ## Princípios (primeiras 3) quando não há ## Prioridades', () => {
    const md = `
## Princípios
1. Transparência na comunicação
2. Segurança financeira absoluta
3. Respeito aos limites regulatórios
4. Quarto princípio que deve ser ignorado
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
    // todos devem ser slugs válidos snake_case
    for (const slug of result) {
      expect(slug).toMatch(/^[a-z][a-z0-9_]{2,79}$/);
    }
  });

  it('Prioridades têm precedência sobre Princípios', () => {
    const md = `
## Princípios
1. principio_um
2. principio_dois

## Prioridades
1. prioridade_alfa
2. prioridade_beta
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result).toContain('prioridade_alfa');
    expect(result).toContain('prioridade_beta');
    expect(result).not.toContain('principio_um');
  });

  it('filtra slugs inválidos (regex não casa)', () => {
    const md = `
## Prioridades
1. 123_invalid
2. foo
3. valid_slug_123
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result).not.toContain('123_invalid'); // começa com número
    // 'foo' tem 3 chars que é fronteira do regex {2,79} (pelo menos 3 chars total: a + 2)
    expect(result).toContain('valid_slug_123');
  });

  it('respeita máximo 5 entries em Prioridades', () => {
    const md = `
## Prioridades
1. one
2. two
3. three
4. four
5. five
6. six
7. seven
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('retorna [] quando nem Prioridades nem Princípios existem', () => {
    const md = `
# Maia

Sem prioridades ou princípios.
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result).toEqual([]);
  });

  it('lida com Princípios formato bold (legado maia-prompt.md)', () => {
    const md = `
## Princípios

1. **Separação acima de tudo.** PF é PF. Cada empresa é uma entidade.
2. **Confirme antes de agir.** Lançamentos abaixo do limite confirmado.
3. **Direta, não burocrática.** Mendes prefere objetividade.
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
    // primeira sentença → slug
    expect(result[0]).toMatch(/separacao/);
  });

  it('handles acentos via NFD normalization', () => {
    const md = `
## Princípios
1. transparência absoluta
2. confiança recíproca
`;
    const result = parsePrioritiesFromMarkdown(md);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe('transparencia_absoluta');
  });
});
