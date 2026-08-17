/**
 * Avaliador de PromQL — SUBCONJUNTO INSTANTÂNEO, para testes de regra de alerta.
 *
 * ## Por que ele existe
 *
 * Uma regra de alerta em YAML só é verificável de duas formas: `grep` no texto,
 * ou executar a expressão. `grep` passa com uma expressão sintaticamente
 * correta e semanticamente errada — `> 600` num arquivo onde o operador certo
 * seria `<`, ou um `and` que virou `or`, atravessam qualquer busca por
 * substring. Este módulo executa a `expr` LIDA DO ARQUIVO DE PRODUÇÃO contra
 * amostras sintéticas, então o que o teste afirma é o que a regra calcula.
 *
 * ## O que ele NÃO é
 *
 * Não é o Prometheus. Não há vetor de intervalo (`[5m]`), `rate()`,
 * `histogram_quantile()`, recording rules, nem — e isto importa — semântica de
 * `for:`. O `for:` é uma propriedade TEMPORAL: só um motor com linha do tempo
 * a prova. A cobertura dele vem do arquivo `promtool` commitado ao lado das
 * regras (`monitoring/alerts/tests/`), que é a fonte de verdade; aqui o `for:`
 * é apenas lido e conferido como literal.
 *
 * ## A regra que impede falso verde
 *
 * Todo token fora do subconjunto **lança**. Um avaliador que devolve vetor
 * vazio para o que não entendeu transformaria "não sei calcular isto" em "a
 * condição não disparou" — que é exatamente o falso verde que ele deveria
 * pegar. Se uma regra futura crescer além deste subconjunto, o teste QUEBRA e
 * alguém estende o avaliador (ou move a asserção para o promtool). Silêncio,
 * não.
 *
 * Semântica conferida contra `promtool test rules` v2.53.0 (ver
 * `monitoring/alerts/tests/onboarding.rules.test.yml`): `max()` ignora `NaN`
 * enquanto houver amostra finita; comparação com `NaN` é sempre falsa; `x != x`
 * é VERDADEIRA para `NaN` e preserva os rótulos do lado esquerdo — é o idioma
 * de detecção de `NaN` já usado em `monitoring/alerts/slo.rules.yml`.
 */

export interface Sample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export type Vector = readonly Sample[];

/** Séries disponíveis para a avaliação, por nome de métrica. */
export type SeriesDb = Readonly<Record<string, Vector>>;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'ident'; text: string }
  | { kind: 'number'; value: number }
  | { kind: 'op'; text: string }
  | { kind: 'punct'; text: string };

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'] as const;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '(' || c === ')') {
      out.push({ kind: 'punct', text: c });
      i += 1;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ kind: 'number', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_:]/.test(c)) {
      const m = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(src.slice(i))!;
      out.push({ kind: 'ident', text: m[0] });
      i += m[0].length;
      continue;
    }
    throw new Error(
      `promql-instant: caractere fora do subconjunto (${JSON.stringify(c)}) em ${JSON.stringify(src)}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser (precedência do Prometheus: `or` < `and`/`unless` < comparação)
// ---------------------------------------------------------------------------

type Node =
  | { t: 'selector'; metric: string }
  | { t: 'call'; fn: 'max' | 'min' | 'absent'; arg: Node }
  | { t: 'number'; value: number }
  | { t: 'binop'; op: string; lhs: Node; rhs: Node };

const CALLS = new Set(['max', 'min', 'absent']);

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: readonly Token[],
    private readonly src: string,
  ) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private fail(msg: string): never {
    throw new Error(`promql-instant: ${msg} em ${JSON.stringify(this.src)}`);
  }

  parse(): Node {
    const n = this.parseOr();
    if (this.pos !== this.toks.length) this.fail('sobra de tokens');
    return n;
  }

  private parseOr(): Node {
    let lhs = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'ident' && t.text === 'or') {
        this.pos += 1;
        lhs = { t: 'binop', op: 'or', lhs, rhs: this.parseAnd() };
        continue;
      }
      return lhs;
    }
  }

  private parseAnd(): Node {
    let lhs = this.parseComparison();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'ident' && (t.text === 'and' || t.text === 'unless')) {
        this.pos += 1;
        lhs = { t: 'binop', op: t.text, lhs, rhs: this.parseComparison() };
        continue;
      }
      return lhs;
    }
  }

  private parseComparison(): Node {
    let lhs = this.parseAtom();
    for (;;) {
      const t = this.peek();
      if (t?.kind === 'op') {
        this.pos += 1;
        lhs = { t: 'binop', op: t.text, lhs, rhs: this.parseAtom() };
        continue;
      }
      return lhs;
    }
  }

  private parseAtom(): Node {
    const t = this.peek();
    if (!t) this.fail('expressão truncada');
    if (t.kind === 'number') {
      this.pos += 1;
      return { t: 'number', value: t.value };
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.pos += 1;
      const inner = this.parseOr();
      const close = this.peek();
      if (close?.kind !== 'punct' || close.text !== ')') this.fail('`(` sem `)`');
      this.pos += 1;
      return inner;
    }
    if (t.kind === 'ident') {
      // `by (...)` / `without (...)`, seletores com rótulos (`{...}`) e vetores
      // de intervalo (`[5m]`) NÃO estão no subconjunto — o tokenizer já rejeita
      // `{`, `}`, `[`, `]` e `,`, então isto aqui só vê nome puro ou chamada.
      const next = this.toks[this.pos + 1];
      if (next?.kind === 'punct' && next.text === '(') {
        if (!CALLS.has(t.text)) this.fail(`função fora do subconjunto: ${t.text}()`);
        this.pos += 2;
        const arg = this.parseOr();
        const close = this.peek();
        if (close?.kind !== 'punct' || close.text !== ')') this.fail('chamada sem `)`');
        this.pos += 1;
        return { t: 'call', fn: t.text as 'max' | 'min' | 'absent', arg };
      }
      if (t.text === 'and' || t.text === 'or' || t.text === 'unless') {
        this.fail(`operador de conjunto \`${t.text}\` sem operando à esquerda`);
      }
      this.pos += 1;
      return { t: 'selector', metric: t.text };
    }
    this.fail('token inesperado');
  }
}

// ---------------------------------------------------------------------------
// Avaliação
// ---------------------------------------------------------------------------

/** Assinatura de rótulos, para casamento de vetor a vetor e para `and`/`or`. */
function sig(s: Sample): string {
  return JSON.stringify(
    Object.keys(s.labels)
      .sort()
      .map((k) => [k, s.labels[k]]),
  );
}

/** Comparação escalar do Prometheus: qualquer envolvimento de `NaN` é falso… */
function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '==':
      return a === b;
    // …exceto `!=`, onde `NaN != NaN` é VERDADEIRO. É o que sustenta o idioma
    // `x != x` como detector de `NaN` nas regras deste repositório.
    case '!=':
      return a !== b;
    default:
      throw new Error(`promql-instant: operador não suportado: ${op}`);
  }
}

function evalNode(n: Node, db: SeriesDb): Vector | number {
  if (n.t === 'number') return n.value;
  if (n.t === 'selector') return db[n.metric] ?? [];
  if (n.t === 'call') {
    const arg = evalNode(n.arg, db);
    if (typeof arg === 'number') throw new Error('promql-instant: função sobre escalar');
    if (n.fn === 'absent') {
      return arg.length === 0 ? [{ labels: {}, value: 1 }] : [];
    }
    if (arg.length === 0) return [];
    const finite = arg.map((s) => s.value).filter((v) => Number.isFinite(v));
    // `max()`/`min()` do Prometheus IGNORAM `NaN` enquanto houver amostra
    // finita; com TODAS `NaN`, o resultado é `NaN`. Conferido no promtool.
    const value =
      finite.length === 0
        ? Number.NaN
        : n.fn === 'max'
          ? Math.max(...finite)
          : Math.min(...finite);
    return [{ labels: {}, value }];
  }

  const lhs = evalNode(n.lhs, db);
  const rhs = evalNode(n.rhs, db);

  if (n.op === 'and' || n.op === 'unless' || n.op === 'or') {
    if (typeof lhs === 'number' || typeof rhs === 'number') {
      throw new Error(`promql-instant: \`${n.op}\` exige vetor dos dois lados`);
    }
    const right = new Set(rhs.map(sig));
    if (n.op === 'and') return lhs.filter((s) => right.has(sig(s)));
    if (n.op === 'unless') return lhs.filter((s) => !right.has(sig(s)));
    const left = new Set(lhs.map(sig));
    return [...lhs, ...rhs.filter((s) => !left.has(sig(s)))];
  }

  // Comparação vetor↔escalar: FILTRA, preservando rótulo e valor.
  if (typeof rhs === 'number') {
    if (typeof lhs === 'number') throw new Error('promql-instant: comparação escalar↔escalar');
    return lhs.filter((s) => cmp(n.op, s.value, rhs));
  }
  if (typeof lhs === 'number') throw new Error('promql-instant: escalar à esquerda');

  // Comparação vetor↔vetor: casa por conjunto de rótulos idêntico.
  const byS = new Map(rhs.map((s) => [sig(s), s] as const));
  return lhs.filter((s) => {
    const m = byS.get(sig(s));
    return m !== undefined && cmp(n.op, s.value, m.value);
  });
}

/**
 * Avalia `expr` (PromQL, subconjunto instantâneo) contra `db` e devolve o vetor
 * resultante. Um alerta DISPARARIA (ignorando `for:`) se o vetor for não-vazio.
 *
 * Lança para qualquer construção fora do subconjunto — ver o cabeçalho.
 */
export function evalInstant(expr: string, db: SeriesDb): Vector {
  const out = evalNode(new Parser(tokenize(expr), expr).parse(), db);
  if (typeof out === 'number') throw new Error('promql-instant: expressão escalar, não vetorial');
  return out;
}

/** Açúcar: a expressão dispara contra estas séries? */
export function fires(expr: string, db: SeriesDb): boolean {
  return evalInstant(expr, db).length > 0;
}
