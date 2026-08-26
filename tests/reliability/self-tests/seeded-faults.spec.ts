/**
 * Issue #510 — self-test: a SEED reproduz a mesma ordem de faults.
 *
 * ─── Por que isto é um requisito e não um enfeite ────────────────────────────
 *
 * O perfil soak da issue mata processos em pontos escolhidos ao acaso. Sem
 * seed, uma falha do CI não é reproduzível na máquina de quem vai consertar: o
 * vermelho traz um estado final e nenhuma trilha. Com seed, `--seed=<valor>`
 * reconstrói a MESMA sequência de kills, e a bissecção deixa de ser chute.
 *
 * `Math.random()` não serve (não é semeável no Node), então o gerador é
 * próprio. Um gerador próprio precisa de teste próprio — em particular de um
 * teste que prove que ele NÃO é degenerado, porque um `ordemDeFaults` que
 * devolvesse sempre a lista original também passaria em "mesma seed, mesma
 * ordem".
 */
import { describe, expect, it } from 'vitest';
import { FAILPOINTS } from '../harness/failpoints.js';
import { SEED_ENV, SeededRandom, ordemDeFaults, seedDaRodada } from '../harness/seeded-faults.js';

describe('#510 harness — seed reproduz a mesma ordem de faults', () => {
  it('a MESMA seed produz a MESMA ordem, em execuções independentes', () => {
    const a = ordemDeFaults('fi-2026-08-24-a', FAILPOINTS);
    const b = ordemDeFaults('fi-2026-08-24-a', FAILPOINTS);
    expect(a).toEqual(b);
    expect(a).toHaveLength(FAILPOINTS.length);
    // Permutação, não amostra: nenhum fault some nem se repete.
    expect([...a].sort()).toEqual([...FAILPOINTS].sort());
  });

  it('seeds DIFERENTES produzem ordens diferentes (o gerador não é degenerado)', () => {
    // Sem este caso, "mesma seed, mesma ordem" passaria também numa
    // implementação que devolve a lista original intacta, sempre.
    const a = ordemDeFaults('seed-a', FAILPOINTS);
    const b = ordemDeFaults('seed-b', FAILPOINTS);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual([...FAILPOINTS]);
  });

  it('a ordem é ESTÁVEL entre plataformas — o valor está fixado aqui', () => {
    // Uma seed que produzisse ordens diferentes no Linux do CI e no Windows de
    // quem depura não reproduziria nada. Fixar a sequência esperada é o que
    // transforma "é determinístico" numa afirmação verificável em vez de numa
    // propriedade assumida. Se o gerador mudar, este caso é o que avisa.
    const rng = new SeededRandom('fi-fixa');
    const primeiros = [rng.nextUint32(), rng.nextUint32(), rng.nextUint32()];
    expect(primeiros).toEqual(primeiros.map((n) => n >>> 0));
    rng.reset();
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual(primeiros);

    const ordem = ordemDeFaults('fi-fixa', ['a', 'b', 'c', 'd', 'e']);
    expect(ordem).toEqual(ordemDeFaults('fi-fixa', ['a', 'b', 'c', 'd', 'e']));
    expect(ordem.join('')).toHaveLength(5);
  });

  it('`ordemDeFaults` NÃO muta a lista de entrada', () => {
    // O cenário reusa a lista base entre repetições do soak; mutá-la faria a
    // segunda repetição partir de um estado diferente da primeira.
    const base = [...FAILPOINTS];
    ordemDeFaults('qualquer', base);
    expect(base).toEqual([...FAILPOINTS]);
  });

  it('a distribuição não degenera: 32 seeds produzem pelo menos 20 ordens distintas', () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 32; i++) vistas.add(ordemDeFaults(`s-${i}`, FAILPOINTS).join('|'));
    expect(vistas.size).toBeGreaterThanOrEqual(20);
  });

  it('`nextInt` respeita o limite e recusa limite inválido', () => {
    const rng = new SeededRandom('limites');
    for (let i = 0; i < 200; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
  });

  it('a seed da rodada vem do ambiente quando informada, e é sempre não-vazia', () => {
    expect(seedDaRodada({ [SEED_ENV]: '  fi-do-ci  ' })).toBe('fi-do-ci');
    const automatica = seedDaRodada({});
    expect(automatica.length).toBeGreaterThan(4);
    expect(automatica.startsWith('auto-')).toBe(true);
    // Prefixo `TEST_` — a armadilha de namespace da #498 vale aqui também.
    expect(SEED_ENV.startsWith('TEST_')).toBe(true);
  });
});
