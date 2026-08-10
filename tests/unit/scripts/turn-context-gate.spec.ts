/**
 * Issue #525 — o GATE do benchmark de carga de contexto tem que REPROVAR.
 *
 * ## Por que este arquivo existe
 *
 * `scripts/turn-context-benchmark.ts` é uma ferramenta de MEDIÇÃO, e a regra de
 * "reintroduza o defeito e veja o teste falhar" não se aplica ao número que ele
 * mede — ela se aplica ao VEREDICTO que ele emite. Um harness que imprime uma
 * tabela bonita e sai com código 0 aconteça o que acontecer não é um gate: é um
 * carimbo. O que precisa de prova, então, é que cada critério do aceite derruba
 * o processo quando o valor correspondente estoura.
 *
 * A prova é feita por INJEÇÃO de valores, e não esperando uma degradação real
 * acontecer: degradação real não é reprodutível numa suíte, e um gate que só
 * fosse exercitado no dia da regressão seria exercitado pela primeira vez no
 * pior dia possível. `evaluateGate` é puro justamente para que isto seja
 * possível sem Postgres, sem carga e sem relógio.
 *
 * ## O que este arquivo NÃO prova
 *
 * Que os números medidos estão certos — isso é papel do próprio harness rodando
 * contra Postgres real, e do veredicto "leituras por turno" que fica vermelho se
 * `buildPrompt` deixar de chamar `loadTurnContext`. Aqui se prova a decisão, não
 * a medida.
 */
import { describe, it, expect } from 'vitest';
import {
  CARDINALITIES,
  applyInjection,
  evaluateGate,
  gateExitCode,
  gateMakespan,
  isDirectInvocation,
  mergeTwoPairs,
  parseArgs,
  percentile,
  syntheticPassingArm,
  type ArmResult,
  type BaselineFile,
  type Thresholds,
} from '../../../scripts/turn-context-benchmark.js';

/** Os limites do aceite, escritos aqui como o dono os escreveu. */
const TH: Thresholds = {
  p95_ms: 600,
  p99_ms: 1_000,
  max_peak_reads: 6,
  min_concurrent_tenants: 10,
  saturation_ms: 60_000,
  baseline_tolerance: 0.2,
  pairs: 50,
  concurrency: 20,
};

function armsWith(inject: Record<string, number>): ArmResult[] {
  const arms = [syntheticPassingArm('cold', TH), syntheticPassingArm('warm', TH)];
  if (Object.keys(inject).length > 0) applyInjection(arms, inject);
  return arms;
}

function run(inject: Record<string, number>, baseline: BaselineFile | null = null) {
  const arms = armsWith(inject);
  const verdicts = evaluateGate(arms, TH, baseline);
  return { verdicts, code: gateExitCode(verdicts), failed: verdicts.filter((v) => !v.passed) };
}

describe('#525 — o gate do benchmark de carga de contexto', () => {
  it('aprova uma corrida saudável, e o exit code é 0', () => {
    const { code, failed } = run({});
    expect(failed).toEqual([]);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Os três casos que o aceite exige explicitamente
  // -------------------------------------------------------------------------

  it('REPROVA quando o p95 estoura 600 ms — exit code 1', () => {
    const { code, failed } = run({ p95_ms: 900 });
    expect(code).toBe(1);
    expect(failed.map((v) => v.label)).toEqual([
      expect.stringContaining('[cold] p95 da carga de contexto ≤ 600 ms'),
      expect.stringContaining('[warm] p95 da carga de contexto ≤ 600 ms'),
    ]);
    // A mensagem carrega o número medido: uma reprovação que não diz por quanto
    // caiu obriga quem for consertar a rodar de novo só para descobrir isso.
    expect(failed[0]!.detail).toContain('900.0 ms');
  });

  it('REPROVA quando o pico de leituras simultâneas de um turno passa de 6', () => {
    // É o teto que a PR #541 restaurou (`TURN_CONTEXT_MAX_CONCURRENT_READS`).
    // Sete significa que um turno passou a poder segurar mais do que sua parte
    // do pool de 10 — o defeito que o gate compartilhado fechou.
    const { code, failed } = run({ peak_reads_per_turn: 7 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('pico de leituras simultâneas por turno ≤ 6'))).toBe(
      true,
    );
  });

  it('REPROVA com um único erro, e REPROVA com um único timeout', () => {
    const comErro = run({ 'cold.errors': 1 });
    expect(comErro.code).toBe(1);
    expect(comErro.failed.map((v) => v.label)).toEqual([
      expect.stringContaining('[cold] zero erros e zero timeouts'),
    ]);

    const comTimeout = run({ 'warm.timeouts': 1 });
    expect(comTimeout.code).toBe(1);
    expect(comTimeout.failed.map((v) => v.label)).toEqual([
      expect.stringContaining('[warm] zero erros e zero timeouts'),
    ]);
  });

  // -------------------------------------------------------------------------
  // Os demais critérios do enunciado
  // -------------------------------------------------------------------------

  it('REPROVA quando o p99 estoura 1 s', () => {
    const { code, failed } = run({ p99_ms: 1_500 });
    expect(code).toBe(1);
    expect(failed.every((v) => v.label.includes('p99'))).toBe(true);
  });

  it('REPROVA quando o pico é BAIXO demais — "consertar" serializando também cai', () => {
    // O critério de teto sozinho seria satisfeito por um loader que fizesse as
    // dez leituras em fila indiana, jogando fora tudo o que a #525 comprou.
    // Por isso o gate exige que o pico ALCANCE 6 quando há trabalho para isso.
    const { code, failed } = run({ peak_reads_per_turn: 1 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('o gate satura'))).toBe(true);
    // …e o critério de TETO continua verde, o que é o ponto: são dois
    // critérios opostos e o gate precisa dos dois.
    const ceiling = run({ peak_reads_per_turn: 1 }).verdicts.find((v) =>
      v.label.includes('pico de leituras simultâneas por turno ≤ 6'),
    );
    expect(ceiling?.passed).toBe(true);
  });

  it('REPROVA quando menos de 10 tenants estiveram concorrentes de fato', () => {
    const { code, failed } = run({ max_concurrent_tenants: 9 });
    expect(code).toBe(1);
    expect(failed.every((v) => v.label.includes('tenants concorrentes'))).toBe(true);
  });

  it('REPROVA quando o pool nunca drena, mesmo com a sequência abaixo de 60 s', () => {
    // Este é o falso verde que a primeira versão do harness produziu: numa
    // corrida de 60,1 s o pool ficou saturado em 100% das amostras e a maior
    // sequência bateu 57,2 s — "< 60 s", portanto verde. A sequência é limitada
    // pela DURAÇÃO da corrida, então comparar só com 60 s pergunta se a corrida
    // foi curta, não se o pool aguentou.
    const { code, failed } = run({
      wall_ms: 60_100,
      pool_saturation_max_streak_ms: 57_200,
      // 572 de 572 amostras saturadas — os números exatos daquela corrida.
      pool_samples: 572,
      pool_saturated_samples: 572,
    });
    expect(code).toBe(1);
    const v = failed.find((x) => x.label.includes('o pool drena'));
    expect(v).toBeDefined();
    expect(v!.detail).toContain('A FILA NUNCA ESVAZIOU');
  });

  it('REPROVA quando a sequência saturada passa de 60 s', () => {
    const { code, failed } = run({ wall_ms: 300_000, pool_saturation_max_streak_ms: 61_000 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('o pool drena'))).toBe(true);
  });

  it('marca a saturação como NÃO AVALIADA numa corrida curta e saudável, sem reprovar', () => {
    const { code, verdicts } = run({ wall_ms: 5_000, pool_saturation_max_streak_ms: 300 });
    const v = verdicts.find((x) => x.label.includes('o pool drena'))!;
    expect(v.skipped).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.detail).toContain('não observada');
    // Não avaliado ≠ reprovado: o gate segue verde, mas o relatório diz que
    // aquele critério não foi testado, em vez de carimbá-lo.
    expect(code).toBe(0);
  });

  it('REPROVA quando a métrica do aceite não observou todos os turnos', () => {
    // `maia_turn_context_load_duration_ms{phase="loader"}` é emitida por
    // `buildPrompt`. Se o harness medisse com relógio próprio e ninguém olhasse
    // a série, um dia em que ela parasse de sair passaria despercebido — e é
    // essa série que o alerta do operador lê.
    const { code, failed } = run({ metric_count: 0 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('observou todos os turnos'))).toBe(true);
  });

  it('REPROVA quando a carga não tem a forma do enunciado (50 pares)', () => {
    const { code, failed } = run({ pairs_exercised: 12 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('carga conforme o enunciado'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Baseline
  // -------------------------------------------------------------------------

  describe('comparação contra baseline', () => {
    const baseline = (p95: number): BaselineFile => ({
      recorded_at: '2026-08-10T00:00:00.000Z',
      recorded_by: 'spec',
      host: 'spec',
      note: 'fixture',
      options: { pairs: 50, concurrency: 20, turns: 600, identity: 'profile' },
      arms: { cold: { p95_ms: p95, p99_ms: p95 * 2 }, warm: { p95_ms: p95, p99_ms: p95 * 2 } },
    });

    it('sem baseline registrado o critério sai como NÃO AVALIADO — e diz isso com todas as letras', () => {
      const { verdicts, code } = run({}, null);
      const v = verdicts.find((x) => x.label.includes('baseline'))!;
      expect(v.skipped).toBe(true);
      expect(v.passed).toBe(true);
      expect(v.detail).toContain('NÃO HÁ BASELINE REGISTRADO');
      expect(code).toBe(0);
    });

    it('aprova exatamente no teto de +20% e REPROVA um passo acima', () => {
      // p95 sintético = 40 ms. Baseline 100/3 ⇒ teto = 40 exatos.
      const noLimite = run({}, baseline(40 / 1.2));
      expect(noLimite.code).toBe(0);

      // O MESMO p95 contra um baseline 1% menor já estoura.
      const acima = run({}, baseline(40 / 1.2 / 1.01));
      expect(acima.code).toBe(1);
      const v = acima.failed.find((x) => x.label.includes('baseline'))!;
      expect(v.detail).toMatch(/delta=\d+\.\d%/);
    });

    it('REPROVA uma regressão de 50% sobre o baseline', () => {
      const { code, failed } = run({ p95_ms: 60 }, baseline(40));
      expect(code).toBe(1);
      expect(failed.every((v) => v.label.includes('baseline'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // A injeção é uma prova, não uma porta dos fundos
  // -------------------------------------------------------------------------

  describe('--inject', () => {
    it('só é aceito junto de --self-test', () => {
      // Sem esta trava, `--inject p95_ms=1` transformaria o gate num carimbo:
      // qualquer regressão passaria com uma flag na linha de comando.
      expect(() => parseArgs(['--inject', 'p95_ms=1'], 6)).toThrow(/--self-test/);
      expect(() => parseArgs(['--self-test', '--inject', 'p95_ms=1'], 6)).not.toThrow();
    });

    it('recusa um campo desconhecido em vez de ignorá-lo em silêncio', () => {
      expect(() => applyInjection(armsWith({}), { naoExiste: 1 })).toThrow(/campo desconhecido/);
    });

    it('recusa um braço que não existe', () => {
      expect(() => applyInjection(armsWith({}), { 'inexistente.p95_ms': 1 })).toThrow(
        /nenhum braço casa/,
      );
    });

    it('aceita alvo por braço e alvo global', () => {
      const arms = armsWith({});
      applyInjection(arms, { 'cold.p95_ms': 111, p99_ms: 222 });
      expect(arms.find((a) => a.arm === 'cold')!.p95_ms).toBe(111);
      expect(arms.find((a) => a.arm === 'warm')!.p95_ms).toBe(40);
      expect(arms.every((a) => a.p99_ms === 222)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // A forma da carga exigida NÃO pode vir das flags
  // -------------------------------------------------------------------------

  it('os requisitos de forma vêm do enunciado, não de --pairs/--concurrency', () => {
    // Derivar o critério da flag o tornaria circular: `--pairs 4` aprovaria uma
    // corrida de quatro tenants como se fosse o gate.
    const opts = parseArgs(['--pairs', '4', '--concurrency', '2'], 6);
    expect(opts.pairs).toBe(4);
    expect(opts.concurrency).toBe(2);
    expect(opts.thresholds.pairs).toBe(50);
    expect(opts.thresholds.concurrency).toBe(20);
  });

  it('o teto de leituras por turno vem do CÓDIGO, não de um literal no gate', async () => {
    const { TURN_CONTEXT_MAX_CONCURRENT_READS } = await import(
      '../../../src/agent/turn-context/types.js'
    );
    expect(parseArgs([], TURN_CONTEXT_MAX_CONCURRENT_READS).thresholds.max_peak_reads).toBe(
      TURN_CONTEXT_MAX_CONCURRENT_READS,
    );
    expect(TURN_CONTEXT_MAX_CONCURRENT_READS).toBe(6);
  });

  // -------------------------------------------------------------------------
  // O modelo de ≤8 round-trips
  // -------------------------------------------------------------------------

  describe('modelo de makespan (a resposta a "e se fossem 8 round-trips?")', () => {
    it('reproduz o escalonamento FIFO do ReadGate', () => {
      // 10 tarefas de 10 ms sob 6 permits: duas ondas ⇒ 20 ms.
      expect(gateMakespan(new Array(10).fill(10), 6)).toBe(20);
      // 6 tarefas de 10 ms sob 6 permits: uma onda.
      expect(gateMakespan(new Array(6).fill(10), 6)).toBe(10);
      // Serialização total.
      expect(gateMakespan([5, 5, 5], 1)).toBe(15);
      expect(gateMakespan([], 6)).toBe(0);
    });

    it('a fusão preserva a POSIÇÃO da primeira leitura do par', () => {
      // Empurrar a leitura fundida para o fim da lista mudaria a ordem FIFO, e
      // o modelo passaria a medir a reordenação em vez da fusão — foi o que
      // produziu "ganho negativo" na primeira versão do harness.
      const reads = [
        { section: 'identity', ms: 1 },
        { section: 'facts', ms: 2 },
        { section: 'capabilities', ms: 3 },
        { section: 'rules', ms: 4 },
        { section: 'gaps', ms: 5 },
      ];
      expect(mergeTwoPairs(reads)).toEqual([1, 4, 5]);
      // identity intacto; facts⋈rules = max(2,4) na posição de facts;
      // capabilities⋈gaps = max(3,5) na posição de capabilities.
    });

    it('não funde nada quando o par não está completo', () => {
      const reads = [
        { section: 'facts', ms: 2 },
        { section: 'history', ms: 3 },
      ];
      expect(mergeTwoPairs(reads)).toEqual([2, 3]);
    });

    it('fundir duas leituras nunca aumenta o makespan modelado', () => {
      const reads = [
        { section: 'identity', ms: 7 },
        { section: 'history', ms: 6 },
        { section: 'entities', ms: 9 },
        { section: 'facts', ms: 8 },
        { section: 'rules', ms: 5 },
        { section: 'memories', ms: 11 },
        { section: 'hints', ms: 4 },
        { section: 'capabilities', ms: 3 },
        { section: 'gaps', ms: 2 },
        { section: 'procedure', ms: 6 },
      ];
      const agora = gateMakespan(reads.map((r) => r.ms), 6);
      const com8 = gateMakespan(mergeTwoPairs(reads), 6);
      expect(com8).toBeLessThanOrEqual(agora);
    });
  });

  it('percentile usa o rank mais próximo por cima', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });

  it('as cardinalidades são as do enunciado', () => {
    expect([...CARDINALITIES]).toEqual([1, 10, 100]);
  });

  it('importar o script NÃO roda main() (guarda de entrypoint)', () => {
    // Se `main()` tivesse rodado no import, este processo teria semeado 50
    // tenants no Postgres compartilhado só para carregar o arquivo.
    expect(isDirectInvocation(undefined, 'file:///qualquer.js')).toBe(false);
    expect(isDirectInvocation('/outro/script.ts', 'file:///diferente.js')).toBe(false);
  });
});
