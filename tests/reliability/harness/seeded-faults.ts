/**
 * Issue #510 — aleatoriedade REPRODUZÍVEL.
 *
 * A issue exige que "toda aleatoriedade recebe seed logada" e que o soak
 * aceite `--seed=`. Um harness de fault injection sem isso produz falhas que
 * ninguém consegue reproduzir: o vermelho do CI não é replicável na máquina de
 * quem vai consertar, e a bissecção vira chute.
 *
 * `Math.random()` não serve porque não é semeável no Node. `crypto` menos
 * ainda. Então o gerador é próprio, pequeno e determinístico.
 *
 * ─── Por que xorshift128 e não algo "melhor" ────────────────────────────────
 *
 * Não estamos gerando chaves nem simulando física: estamos escolhendo em que
 * ordem matar processos. O requisito é (a) determinismo bit a bit para a mesma
 * seed, em qualquer plataforma, e (b) distribuição boa o bastante para não
 * degenerar. xorshift128 entrega os dois em 6 linhas, sem dependência, sem
 * BigInt e sem depender de detalhe de ponto flutuante da plataforma.
 */

/**
 * Deriva 4 palavras de 32 bits de uma seed textual, por FNV-1a.
 *
 * Aceitar seed como STRING é deliberado: o CI publica `--seed=fi-2026-08-24-a`
 * e essa string vai inteira para o relatório, sem conversão que alguém possa
 * errar ao copiar de volta.
 */
function semear(seed: string): [number, number, number, number] {
  const estado: [number, number, number, number] = [0, 0, 0, 0];
  let h = 0x811c9dc5;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Uma volta extra por palavra para que seeds curtas não gerem estado
    // quase-idêntico entre as 4 posições.
    h ^= i + 0x9e3779b9;
    h = Math.imul(h, 0x01000193) >>> 0;
    estado[i] = h >>> 0;
  }
  // xorshift trava em zero absoluto; qualquer palavra não-nula basta.
  if ((estado[0] | estado[1] | estado[2] | estado[3]) === 0) estado[0] = 0x9e3779b9;
  return estado;
}

/** Fonte de aleatoriedade determinística. Duas instâncias com a mesma seed são indistinguíveis. */
export class SeededRandom {
  readonly seed: string;
  private s: [number, number, number, number];

  constructor(seed: string) {
    this.seed = seed;
    this.s = semear(seed);
  }

  /** Próximo inteiro sem sinal de 32 bits. */
  nextUint32(): number {
    let t = this.s[3];
    const w = this.s[0];
    this.s[3] = this.s[2];
    this.s[2] = this.s[1];
    this.s[1] = w;
    t ^= (t << 11) >>> 0;
    t ^= t >>> 8;
    this.s[0] = (t ^ w ^ (w >>> 19)) >>> 0;
    return this.s[0] >>> 0;
  }

  /** `[0, 1)`. */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Inteiro em `[0, limiteExclusivo)`. */
  nextInt(limiteExclusivo: number): number {
    if (!Number.isInteger(limiteExclusivo) || limiteExclusivo < 1) {
      throw new RangeError(`limiteExclusivo precisa ser inteiro >= 1, recebi ${limiteExclusivo}`);
    }
    return Math.floor(this.next() * limiteExclusivo);
  }

  /** Volta ao estado inicial da seed. */
  reset(): void {
    this.s = semear(this.seed);
  }
}

/**
 * Embaralha uma lista de faults de forma reproduzível.
 *
 * Fisher–Yates de trás para frente, consumindo o gerador na ordem canônica —
 * o mesmo algoritmo que qualquer implementação de referência usa, para que a
 * ordem seja função só da seed e do tamanho da lista.
 *
 * NÃO muta a entrada: o cenário costuma reusar a lista base entre repetições.
 */
export function ordemDeFaults<T>(seed: string, faults: readonly T[]): T[] {
  const rng = new SeededRandom(seed);
  const saida = [...faults];
  for (let i = saida.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const a = saida[i] as T;
    const b = saida[j] as T;
    saida[i] = b;
    saida[j] = a;
  }
  return saida;
}

/**
 * Seed default de uma rodada. Sai no relatório; passar `TEST_RELIABILITY_SEED`
 * reproduz. Prefixo `TEST_` pelo motivo documentado em `failpoints.ts`.
 */
export const SEED_ENV = 'TEST_RELIABILITY_SEED';

export function seedDaRodada(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const informada = env[SEED_ENV];
  if (informada && informada.trim().length > 0) return informada.trim();
  // Sem seed informada, geramos UMA e ela é logada pelo chamador. O importante
  // é que a rodada inteira use a mesma, e que ela apareça no artefato.
  return `auto-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}
