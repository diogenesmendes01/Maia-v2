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
 * ## A fronteira, e por que ela também é coberta aqui
 *
 * `evaluateGate` ser puro é cômodo, e é onde mora um risco: uma correção que só
 * exista no AVALIADOR deixa o spec verde enquanto a corrida real segue mentindo
 * — bastaria `runArm` continuar publicando `pool_samples: 0` como se fosse uma
 * observação. Por isso a contabilidade da amostragem do pool vive em
 * `createPoolSaturationTracker` + `poolMetricsFromSummary`, fora do
 * `setInterval`, e há casos que atravessam o caminho inteiro: amostrador REAL
 * (`startPoolSampler`, o mesmo que `runArm` usa) → métricas → veredicto.
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
  BASELINE_SCHEMA_VERSION,
  NEVER_DRAINED,
  CARDINALITIES,
  applyInjection,
  checkBaselineCompatibility,
  createPoolSaturationTracker,
  evaluateGate,
  gateExitCode,
  coberturaAtual,
  COBERTURA_DA_MEDICAO,
  gateMakespan,
  isDirectInvocation,
  mergeTwoPairs,
  parseArgs,
  percentile,
  poolMetricsFromSummary,
  runFingerprint,
  startPoolSampler,
  syntheticPassingArm,
  SCOPE_READS_PER_TURN,
  SCOPE_SECTIONS,
  type ArmResult,
  type BaselineFile,
  type RunFingerprint,
  type RunMode,
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
  sample_gap_factor: 10,
};

/** A forma da corrida canônica — a mesma que o `--sustain-s 60` do runbook produz. */
const FP: RunFingerprint = {
  pairs: 50,
  concurrency: 20,
  think_ms: 150,
  identity: 'profile',
  cardinalities: [1, 10, 100],
  pool_max: 10,
  max_concurrent_reads: 6,
  turns: 600,
  sustain_s: 60,
  cobertura: coberturaAtual(),
};

/**
 * Um baseline COMPARÁVEL com folga, para que os testes de outros critérios não
 * fiquem falhando pelo critério relativo. Cada teste que fala DE baseline monta
 * o seu.
 */
function baselineWith(p95: number, fingerprint: RunFingerprint = FP): BaselineFile {
  return {
    schema_version: BASELINE_SCHEMA_VERSION,
    recorded_at: '2026-08-10T00:00:00.000Z',
    recorded_by: 'spec',
    host: 'spec',
    note: 'fixture',
    fingerprint,
    context: {
      timeout_ms: 5_000,
      sample_ms: 100,
      node: '22.0.0',
      platform: 'linux',
      mode: 'measure',
    },
    arms: {
      cold: { p95_ms: p95, p99_ms: p95 * 2, turns: 600, wall_ms: 61_000 },
      warm: { p95_ms: p95, p99_ms: p95 * 2, turns: 600, wall_ms: 61_000 },
    },
  };
}

/** Baseline folgado: 40 ms medidos contra 1000 ms de referência nunca reprovam. */
const BASELINE_FOLGADO = baselineWith(1_000);

function armsWith(inject: Record<string, number>): ArmResult[] {
  const arms = [syntheticPassingArm('cold', TH), syntheticPassingArm('warm', TH)];
  if (Object.keys(inject).length > 0) applyInjection(arms, inject);
  return arms;
}

/**
 * O rótulo do critério do orçamento COMPLETO — o agregado que a #700 passou a
 * avaliar (antes dela ele saía `n/a` e reprovava por contenção).
 */
const CONTENCAO = 'aceite completo do orçamento do turno';

function run(
  inject: Record<string, number>,
  baseline: BaselineFile | null = BASELINE_FOLGADO,
  mode: RunMode = 'gate',
) {
  const arms = armsWith(inject);
  const verdicts = evaluateGate(arms, TH, baseline, { mode, fingerprint: FP });
  const parciais = verdicts.filter((v) => !v.label.includes(CONTENCAO));
  return {
    verdicts,
    /** O exit code REAL da corrida, com TODOS os critérios. */
    code: gateExitCode(verdicts, mode),
    /**
     * O exit code SEM o critério agregado do orçamento completo. Os testes de
     * um critério específico usam este para dizer "foi ESTE critério que
     * derrubou a corrida", sem que o agregado (que também reprova quando a
     * evidência do escopo some) apareça como segundo culpado.
     */
    codeParcial: gateExitCode(parciais, mode),
    /** Reprovações entre os critérios individuais (o agregado não entra). */
    failed: parciais.filter((v) => !v.passed),
    /** O critério agregado do orçamento completo, para os testes que falam DELE. */
    contencao: verdicts.find((v) => v.label.includes(CONTENCAO)),
    /** Todas as reprovações, agregado incluído. */
    todasAsFalhas: verdicts.filter((v) => !v.passed),
  };
}

describe('#525 — o gate do benchmark de carga de contexto', () => {
  it('nenhum critério reprova uma corrida saudável — e o gate SAI 0', () => {
    const { code, codeParcial, failed, todasAsFalhas } = run({});
    expect(failed).toEqual([]);
    expect(codeParcial).toBe(0);
    // Antes da #700 esta linha era `expect(code).toBe(1)`: o aceite completo
    // saía `n/a` porque o `resolveScope` estava fora da medição, e não
    // avaliado reprova. Com o `resolveScope` DENTRO do relógio e a evidência
    // nos números, o critério passa a ser avaliado — e uma corrida saudável
    // sai 0. A contenção saiu porque a premissa dela deixou de valer.
    expect(todasAsFalhas).toEqual([]);
    expect(code).toBe(0);
  });

  // -------------------------------------------------------------------------
  // #700 — o aceite COMPLETO do orçamento do turno (resolveScope + buildPrompt)
  //
  // A flag `COBERTURA_DA_MEDICAO.resolve_scope_medido` é um RÓTULO. O que
  // aprova este critério é a EVIDÊNCIA MEDIDA: as duas leituras do escopo em
  // todo turno, a cardinalidade resolvida batendo com a semeada, e turnos > 0.
  // Virar a flag sem incluir a medição tem de REPROVAR — é o defeito que esta
  // bateria existe para pegar.
  // -------------------------------------------------------------------------

  describe('aceite completo do orçamento do turno (#700)', () => {
    it('APROVA quando a evidência do resolveScope está nos números medidos', () => {
      const { contencao, code } = run({});
      expect(contencao, 'o critério do orçamento completo sumiu da lista').toBeDefined();
      expect(contencao?.skipped).toBeFalsy();
      expect(contencao?.passed).toBe(true);
      expect(contencao?.detail).toContain('resolveScope');
      expect(code).toBe(0);
    });

    it('REPROVA quando a flag diz que mede e os NÚMEROS dizem que não — a flag não prova a si mesma', () => {
      // O defeito que a #700 nomeia: alguém vira `resolve_scope_medido` para
      // `true` sem incluir a medição. Sem as leituras do escopo no contador
      // por turno, o critério é AVALIADO e REPROVADO — não aprovado por
      // decreto, e não `n/a`.
      expect(COBERTURA_DA_MEDICAO.resolve_scope_medido).toBe(true);
      const { contencao, code } = run({ scope_reads_per_turn_min: 0, scope_reads_per_turn_max: 0 });
      expect(contencao?.passed).toBe(false);
      expect(contencao?.skipped).toBeFalsy();
      expect(contencao?.detail).toContain('A FLAG DIZ QUE MEDE, OS NÚMEROS DIZEM QUE NÃO');
      expect(contencao?.detail).toContain('leituras do escopo por turno=0–0');
      expect(code).toBe(1);

      // CONTROLE, no mesmo `it`: com as duas leituras de volta, o MESMO
      // critério aprova. Sem isto o teste passaria por qualquer motivo.
      expect(run({}).contencao?.passed).toBe(true);
    });

    it('REPROVA quando o escopo resolvido não bate com a massa semeada (com controle)', () => {
      // "As duas leituras aconteceram" não basta: elas podem ter devolvido
      // vazio — massa sem `permissoes`/`permission_profiles`, ou permissão
      // descartada pelo teto de 500 do `profilesRepo.byIds`.
      const semMassa = run({ scope_entities_min: 0, scope_entities_max: 0 });
      expect(semMassa.contencao?.passed).toBe(false);
      expect(semMassa.code).toBe(1);

      const divergente = run({ scope_cardinality_mismatches: 1 });
      expect(divergente.contencao?.passed).toBe(false);
      expect(divergente.code).toBe(1);

      // CONTROLE: cardinalidades 1–100 e zero divergências ⇒ aprova.
      expect(run({}).contencao?.passed).toBe(true);
    });

    it('o critério do orçamento completo vem PRIMEIRO — a fronteira antes dos números', () => {
      // Quem lê a tabela de cima para baixo encontra a fronteira antes de já
      // ter formado opinião sobre os p95. Ordem é conteúdo aqui.
      const { verdicts } = run({});
      expect(verdicts[0]?.label).toContain(CONTENCAO);
    });

    it('em modo `measure` o exit code segue 0 — mas o critério continua sendo emitido', () => {
      // O opt-out explícito não pode virar uma porta para declarar aprovação:
      // `measure` não emite veredicto de gate, e o relatório dele diz isso em
      // caixa alta. O que NÃO pode acontecer é o critério sumir.
      const { code, contencao } = run({ scope_reads_per_turn_min: 0 }, BASELINE_FOLGADO, 'measure');
      expect(code).toBe(0);
      expect(contencao?.passed).toBe(false);
    });

    it('a cobertura entra no fingerprint: baseline da cobertura ANTERIOR é RECUSADO (com controle)', () => {
      // É isto que impede um número medido sob `buildPrompt-sem-resolveScope`
      // de ser reapresentado como medição do turno completo. Vale nos dois
      // sentidos, e é testável sem medir nada — que é o que o aceite 3 da #700
      // pede enquanto os baselines novos não existem.
      const coberturaAntiga = baselineWith(1_000, {
        ...FP,
        cobertura: COBERTURA_DA_MEDICAO.rotulo,
      });
      const recusa = checkBaselineCompatibility(coberturaAntiga, FP);
      expect(recusa.status).toBe('incompatible');
      expect(recusa.diffs.join(' ')).toContain('cobertura');
      expect(recusa.diffs.join(' ')).toContain('buildPrompt-sem-resolveScope');
      // E o efeito é REPROVAR o critério relativo, não decorar o relatório.
      const { code, verdicts } = run({}, coberturaAntiga);
      const rel = verdicts.find((x) => x.label.includes('p95 ≤ baseline'))!;
      expect(rel.skipped).toBe(true);
      expect(rel.passed).toBe(false);
      expect(rel.detail).toContain('BASELINE MEDIDO COM OUTRA CARGA');
      expect(code).toBe(1);

      // CONTROLE: mesma cobertura, mesma corrida — a comparação acontece.
      expect(checkBaselineCompatibility(baselineWith(1_000, FP), FP).status).toBe('ok');
    });

    it('um baseline do schema anterior é recusado — ele não diz o que mediu', () => {
      expect(BASELINE_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
      const antigo = { ...baselineWith(1_000), schema_version: 2 };
      expect(checkBaselineCompatibility(antigo, FP).status).toBe('legacy_schema');
    });

    it('o rótulo da cobertura MUDA quando a flag muda — é o que invalida os baselines antigos', () => {
      // Se os dois estados produzissem o mesmo rótulo, virar a flag não
      // invalidaria baseline nenhum e a comparação silenciosamente misturaria
      // duas réguas. Este teste é o que impede essa regressão.
      const rotuloSemResolveScope = COBERTURA_DA_MEDICAO.rotulo;
      expect(coberturaAtual()).toBe(
        COBERTURA_DA_MEDICAO.resolve_scope_medido ? 'resolveScope+buildPrompt' : rotuloSemResolveScope,
      );
      expect(rotuloSemResolveScope).not.toBe('resolveScope+buildPrompt');
    });
  });

  // -------------------------------------------------------------------------
  // #700 — os três critérios do ESTÁGIO `resolveScope`, um por regressão
  // -------------------------------------------------------------------------

  describe('o estágio resolveScope', () => {
    const EXERCITADO = 'foi EXERCITADO';
    const DO_BANCO = 'veio do BANCO';
    const P95_ESTAGIO = 'p95 do estágio';

    it('REPROVA quando as leituras do escopo somem — o escopo voltou a ser fabricado em memória', () => {
      const { code, failed } = run({ scope_reads_per_turn_min: 0, scope_reads_per_turn_max: 0 });
      expect(code).toBe(1);
      const v = failed.filter((x) => x.label.includes(EXERCITADO));
      expect(v.map((x) => x.label)).toEqual([
        expect.stringContaining('[cold]'),
        expect.stringContaining('[warm]'),
      ]);
      expect(v[0]!.detail).toContain('leituras do escopo por turno=0–0 (esperado 2)');

      // CONTROLE: com as duas leituras, o mesmo critério aprova.
      expect(run({}).failed.some((x) => x.label.includes(EXERCITADO))).toBe(false);
    });

    it('REPROVA um N+1 no caminho do escopo — mais leituras também é regressão', () => {
      // O `byId` por permissão que a #511 removeu: 1 + 100 leituras em vez de
      // 2. Um critério que só cobrasse "≥ 2" não veria isto.
      const { code, failed } = run({ scope_reads_per_turn_max: 101 });
      expect(code).toBe(1);
      expect(failed.some((v) => v.label.includes(EXERCITADO))).toBe(true);

      // CONTROLE: exatamente 2 aprova.
      expect(run({}).failed.some((v) => v.label.includes(EXERCITADO))).toBe(false);
    });

    it('REPROVA quando o escopo resolvido não tem a cardinalidade semeada (com controle)', () => {
      const vazio = run({ scope_entities_min: 0, scope_entities_max: 0 });
      expect(vazio.code).toBe(1);
      expect(vazio.failed.some((v) => v.label.includes(DO_BANCO))).toBe(true);

      const divergente = run({ scope_cardinality_mismatches: 3 });
      expect(divergente.code).toBe(1);
      const v = divergente.failed.find((x) => x.label.includes(DO_BANCO))!;
      expect(v.detail).toContain('divergências de cardinalidade=3');

      // CONTROLE: 1–100 entidades e zero divergências.
      expect(run({}).failed.some((x) => x.label.includes(DO_BANCO))).toBe(false);
    });

    it('REPROVA uma degradação de latência DENTRO do resolveScope (com controle)', () => {
      // A demonstração que o aceite 2 da #700 exige: uma degradação que more
      // no estágio do escopo — um plano perdido, um índice caído — derruba o
      // gate por um critério que NOMEIA o estágio.
      const { code, failed } = run({ scope_p95_ms: 900 });
      expect(code).toBe(1);
      const v = failed.find((x) => x.label.includes(P95_ESTAGIO))!;
      expect(v).toBeDefined();
      expect(v.detail).toContain('900.0 ms');

      // CONTROLE: o p95 sintético do estágio (6 ms) passa.
      expect(run({}).failed.some((x) => x.label.includes(P95_ESTAGIO))).toBe(false);
    });

    it('a degradação no estágio também é vista pelo p95 do TURNO — o estágio está dentro do relógio', () => {
      // O estágio não é medido "ao lado": ele entra no p95 do turno, e por
      // isso o critério absoluto e a comparação relativa contra o baseline
      // também reagem. Aqui isso é afirmado sobre o número, não sobre a
      // intenção: um turno de 40 ms cujo estágio custa 900 ms é impossível.
      const arm = syntheticPassingArm('cold', TH);
      expect(arm.scope_p95_ms).toBeLessThanOrEqual(arm.p95_ms);
      expect(arm.reads_per_turn_min).toBe(10 + SCOPE_READS_PER_TURN);
    });

    it('o número de leituras do escopo vem do ORÇAMENTO da #525, não de um literal do gate', () => {
      // `resolveScope` = `permissoesRepo.forPessoa` + `profilesRepo.byIds`:
      // 2 das 13 queries que `src/agent/turn-context/types.ts` orça.
      expect(SCOPE_READS_PER_TURN).toBe(2);
      expect(Object.values(SCOPE_SECTIONS)).toEqual(['scope_permissoes', 'scope_profiles']);
    });
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

  // -------------------------------------------------------------------------
  // Os dois perfis: o dono separou o que se mede em cada um
  //
  // > "Concorrência 20 continua como máximo de requisições em voo, mas o perfil
  // > normal deve definir ritmo/think_ms. O perfil sem ritmo passa a ser teste
  // > de saturação; nele, exige-se zero erros/timeouts e drenagem depois que o
  // > produtor para — não drenagem enquanto 20 turnos são repostos
  // > continuamente."
  // -------------------------------------------------------------------------

  describe('perfil de saturação (--think-ms 0)', () => {
    /** Carga saturada de ponta a ponta — o que a aritmética garante com ritmo 0. */
    const SATURADO_NA_CARGA = {
      think_ms: 0,
      pool_saturated_samples: 590,
      pool_load_samples: 590,
      pool_load_saturated_samples: 590,
      pool_saturation_max_streak_ms: 59_000,
    };

    it('APROVA carga 100% saturada quando a fila escoa depois que o produtor para', () => {
      // Este é o caso que saía vermelho sem significar regressão: com 20 turnos
      // repostos continuamente contra um pool de 10, a fila não PODE esvaziar
      // durante a carga. O critério do perfil é outro.
      const { codeParcial, verdicts } = run({
        ...SATURADO_NA_CARGA,
        pool_drain_samples: 20,
        pool_drain_saturated_samples: 0,
        pool_drained_after_ms: 120,
      });
      const v = verdicts.find((x) => x.label.includes('perfil de SATURAÇÃO'))!;
      expect(v.passed).toBe(true);
      expect(v.detail).toContain('drenou 120 ms depois de o produtor parar');
      // E o critério do perfil normal NÃO é emitido: é um veredicto por braço,
      // escolhido pelo perfil, não os dois somados.
      expect(verdicts.some((x) => x.label.includes('nunca fica saturado por 60 s'))).toBe(false);
      // `codeParcial` e não `code`: o gate reprova hoje pela contenção do
      // `resolveScope`, e o que este teste afirma é sobre o critério de
      // saturação — não sobre a fronteira da medição.
      expect(codeParcial).toBe(0);
    });

    it('REPROVA quando a fila NÃO escoa depois que o produtor para', () => {
      // Fila cheia sem ninguém pedindo nada é conexão vazando, não carga.
      const { code, failed } = run({
        ...SATURADO_NA_CARGA,
        pool_drain_samples: 20,
        pool_drain_saturated_samples: 20,
        pool_drained_after_ms: -1,
      });
      expect(code).toBe(1);
      const v = failed.find((x) => x.label.includes('perfil de SATURAÇÃO'))!;
      expect(v).toBeDefined();
      expect(v.skipped).toBeFalsy();
      expect(v.detail).toContain('A FILA NÃO ESVAZIOU DEPOIS QUE O PRODUTOR PAROU');
    });

    it('amostras SÓ da fase de carga não são evidência de drenagem', () => {
      // O segundo caso do achado, um passo além do `pool_samples === 0`: houve
      // 590 amostras, todas ANTES da fronteira. A corrida terminou no instante
      // em que o produtor parou e não observou nada do que interessa.
      const { code, verdicts } = run({
        ...SATURADO_NA_CARGA,
        pool_drain_samples: 0,
        pool_drain_saturated_samples: 0,
        pool_drained_after_ms: -1,
      });
      const v = verdicts.find((x) => x.label.includes('perfil de SATURAÇÃO'))!;
      expect(v.skipped).toBe(true);
      expect(v.passed).toBe(false);
      expect(v.detail).toContain('FASE DE ESCOAMENTO NÃO OBSERVADA');
      expect(code).toBe(1);
    });

    it('o perfil normal TAMBÉM exige que a fila escoe depois do produtor parar', () => {
      // A evidência de escoamento é barata e detecta vazamento de conexão nos
      // dois perfis; o que muda entre eles é o critério da fase de CARGA.
      const { code, failed } = run({
        pool_drain_samples: 20,
        pool_drain_saturated_samples: 20,
        pool_drained_after_ms: -1,
      });
      expect(code).toBe(1);
      const v = failed.find((x) => x.label.includes('nunca fica saturado por 60 s'))!;
      expect(v).toBeDefined();
      expect(v.detail).toContain('A FILA NÃO ESVAZIOU DEPOIS QUE O PRODUTOR PAROU');
    });

    it('o perfil vem do RITMO medido no braço, não de uma flag lida à parte', () => {
      // `think_ms` viaja no `ArmResult` porque é o braço que sabe com que ritmo
      // rodou. Ler a flag noutro lugar deixaria o veredicto e a corrida
      // discordarem no dia em que alguém rodasse os braços com ritmos
      // diferentes.
      const normal = run({});
      expect(normal.verdicts.some((v) => v.label.includes('perfil de SATURAÇÃO'))).toBe(false);
      const saturacao = run({ think_ms: 0, pool_drain_samples: 20 });
      expect(saturacao.verdicts.some((v) => v.label.includes('perfil de SATURAÇÃO'))).toBe(true);
    });
  });

  it('REPROVA quando a sequência saturada passa de 60 s', () => {
    const { code, failed } = run({ wall_ms: 300_000, pool_saturation_max_streak_ms: 61_000 });
    expect(code).toBe(1);
    expect(failed.some((v) => v.label.includes('o pool drena'))).toBe(true);
  });

  it('numa corrida curta e saudável a saturação sai NÃO AVALIADA — e em modo gate isso REPROVA', () => {
    // Não avaliado ≠ aprovado. A janela de 60 s é o que torna o critério
    // falsificável; uma corrida de 5 s não a observou, então o gate não tem a
    // evidência que promete e não pode sair verde.
    const gate = run({ wall_ms: 5_000, pool_saturation_max_streak_ms: 300 });
    const v = gate.verdicts.find((x) => x.label.includes('o pool drena'))!;
    expect(v.skipped).toBe(true);
    expect(v.passed).toBe(false);
    expect(v.detail).toContain('não observada');
    expect(gate.code).toBe(1);

    // Em modo `measure` o mesmo critério é informativo: ali não há veredicto de
    // gate para ficar verde.
    const medicao = run(
      { wall_ms: 5_000, pool_saturation_max_streak_ms: 300 },
      BASELINE_FOLGADO,
      'measure',
    );
    expect(medicao.verdicts.find((x) => x.label.includes('o pool drena'))!.skipped).toBe(true);
    expect(medicao.code).toBe(0);
  });

  it('INVARIANTE: nenhum veredicto sai "não avaliado" e "aprovado" ao mesmo tempo', () => {
    // Era esta igualdade — `skipped: true, passed: true` — que deixava o
    // veredicto final verde sem a evidência prometida, nos DOIS critérios que a
    // review apontou (baseline ausente e janela de saturação não observada).
    const casos: Array<Record<string, number>> = [
      {},
      { wall_ms: 5_000 },
      { pool_samples: 0, pool_saturated_samples: 0 },
      { pool_saturation_max_streak_ms: 61_000 },
    ];
    for (const caso of casos) {
      for (const baseline of [null, BASELINE_FOLGADO]) {
        for (const v of run(caso, baseline).verdicts) {
          if (v.skipped) expect({ label: v.label, passed: v.passed }).toEqual({
            label: v.label,
            passed: false,
          });
        }
      }
    }
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
    const baseline = baselineWith;

    it('SEM baseline, o modo gate REPROVA — um checkout limpo não sai verde', () => {
      // O achado: sem baseline o critério obrigatório saía `passed: true`, e
      // como o exit code só olhava `passed`, todo checkout limpo saía 0 sem ter
      // avaliado o critério. O estado "não tenho a referência" era o estado
      // GARANTIDO de qualquer máquina nova, porque o arquivo não é versionado.
      const { verdicts, code, failed } = run({}, null);
      const v = verdicts.find((x) => x.label.includes('baseline'))!;
      expect(v.skipped).toBe(true);
      expect(v.passed).toBe(false);
      expect(v.detail).toContain('NÃO HÁ BASELINE REGISTRADO');
      // …e diz COMO sair desse estado, sem sugerir que uma corrida de gate grave.
      expect(v.detail).toContain('--mode measure');
      expect(v.detail).toContain('--write-baseline');
      expect(code).toBe(1);
      expect(failed.map((x) => x.label)).toEqual([
        expect.stringContaining('[cold] p95 ≤ baseline + 20%'),
        expect.stringContaining('[warm] p95 ≤ baseline + 20%'),
      ]);
    });

    it('SEM baseline, o modo measure não reprova — mas também não se apresenta como gate', () => {
      // O opt-out explícito que o dono admitiu: medir sem baseline é legítimo,
      // desde que a corrida NÃO se apresente como gate. O critério continua
      // marcado como não avaliado; o que muda é que ali não há veredicto.
      const { verdicts, code } = run({}, null, 'measure');
      const v = verdicts.find((x) => x.label.includes('baseline'))!;
      expect(v.skipped).toBe(true);
      expect(v.passed).toBe(false);
      expect(code).toBe(0);
    });

    it('o baseline não é o único critério: um p95 estourado em modo measure segue sem veredicto', () => {
      // O preço do opt-out, explícito: `measure` sai 0 mesmo com critério
      // vermelho. É por isso que o relatório dele carrega a tarja "NÃO É O
      // GATE" e o modo default é `gate`.
      const { code, failed } = run({ p95_ms: 900 }, BASELINE_FOLGADO, 'measure');
      expect(failed.length).toBeGreaterThan(0);
      expect(code).toBe(0);
    });

    it('aprova exatamente no teto de +20% e REPROVA um passo acima', () => {
      // p95 sintético = 40 ms. Baseline 100/3 ⇒ teto = 40 exatos.
      const noLimite = run({}, baseline(40 / 1.2));
      expect(noLimite.codeParcial).toBe(0);

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
  // O fingerprint da carga: comparar dois p95 medidos com cargas diferentes é
  // comparar duas coisas diferentes
  // -------------------------------------------------------------------------

  describe('fingerprint da carga (o baseline precisa medir a MESMA corrida)', () => {
    it('RECUSA a comparação quando o baseline foi medido com outro --think-ms', () => {
      // Não é hipotético: nesta PR o `--think-ms` sozinho move o p95 de 28,8 ms
      // (150) para 187,7 ms (0). Comparar através dessa diferença produz falso
      // verde ou falso vermelho por mudança de CARGA, não de código.
      const outraCarga = baselineWith(40, { ...FP, think_ms: 0 });
      const { code, verdicts } = run({}, outraCarga);
      const v = verdicts.find((x) => x.label.includes('baseline'))!;
      expect(v.skipped).toBe(true);
      expect(v.passed).toBe(false);
      expect(v.detail).toContain('BASELINE MEDIDO COM OUTRA CARGA');
      expect(v.detail).toContain('think_ms: baseline=0 · agora=150');
      expect(code).toBe(1);
    });

    it('RECUSA — não apenas avisa — cada campo que muda o número medido', () => {
      const divergencias: Array<[Partial<RunFingerprint>, string]> = [
        [{ pairs: 10 }, 'pairs'],
        [{ concurrency: 4 }, 'concurrency'],
        [{ think_ms: 0 }, 'think_ms'],
        [{ identity: 'legacy' }, 'identity'],
        [{ cardinalities: [1, 10] }, 'cardinalities'],
        [{ pool_max: 20 }, 'pool_max'],
        [{ max_concurrent_reads: 8 }, 'max_concurrent_reads'],
        // A duração amortiza o transiente de aquecimento (JIT, conexões, cache
        // do Postgres). Medido neste host, mesmo código, minutos de intervalo:
        // 600 turnos (5,7 s) deram p95 118,6 ms; 60 s sustentados (7 389
        // turnos) deram 22,4 ms. Comparar através disso é falso vermelho
        // garantido — e foi a corrida real que corrigiu este julgamento, que
        // na primeira versão deixava os dois campos só REGISTRADOS.
        [{ turns: 100 }, 'turns'],
        [{ sustain_s: 0 }, 'sustain_s'],
      ];
      for (const [patch, campo] of divergencias) {
        const compat = checkBaselineCompatibility(baselineWith(40, { ...FP, ...patch }), FP);
        expect({ campo, status: compat.status }).toEqual({ campo, status: 'incompatible' });
        expect(compat.diffs.join(' ')).toContain(campo);
        // E o efeito é REPROVAR o critério, não decorar o relatório.
        expect(run({}, baselineWith(40, { ...FP, ...patch })).code).toBe(1);
      }
    });

    it('NÃO invalida o baseline por coisa que não muda o número medido', () => {
      // O outro extremo do erro: um fingerprint barulhento invalida o baseline
      // a cada corrida e o operador aprende a ignorá-lo. Host, versão de Node,
      // timeout e período de amostragem NÃO entram no p95 do turno — ficam
      // registrados, não comparados. (A DURAÇÃO entra, e por isso subiu para o
      // fingerprint: ver o caso de `turns`/`sustain_s` acima.)
      const mesmoNumeroOutroContexto = baselineWith(1_000);
      mesmoNumeroOutroContexto.host = 'outra-maquina-completamente-diferente';
      mesmoNumeroOutroContexto.context = {
        timeout_ms: 60_000,
        sample_ms: 250,
        node: '24.9.9',
        platform: 'darwin',
        mode: 'gate',
      };
      expect(checkBaselineCompatibility(mesmoNumeroOutroContexto, FP).status).toBe('ok');
      expect(run({}, mesmoNumeroOutroContexto).codeParcial).toBe(0);
    });

    it('RECUSA um baseline no formato antigo, que não prova com que carga foi medido', () => {
      // Aceitar o formato sem fingerprint em silêncio reabriria o buraco: o
      // arquivo antigo gravava `pairs/concurrency/turns/identity` e ninguém
      // olhava — e nem gravava `think_ms`, que é o campo que mais move o p95.
      const antigo = {
        recorded_at: '2026-08-10T00:00:00.000Z',
        recorded_by: 'spec',
        host: 'spec',
        note: 'formato v1',
        options: { pairs: 50, concurrency: 20, turns: 600, identity: 'profile' },
        arms: { cold: { p95_ms: 40, p99_ms: 80 }, warm: { p95_ms: 40, p99_ms: 80 } },
      } as unknown as BaselineFile;
      const compat = checkBaselineCompatibility(antigo, FP);
      expect(compat.status).toBe('legacy_schema');
      const { code, verdicts } = run({}, antigo);
      expect(verdicts.find((x) => x.label.includes('baseline'))!.detail).toContain(
        'BASELINE EM FORMATO ANTIGO',
      );
      expect(code).toBe(1);
    });

    it('RECUSA quando o baseline não tem o braço que está sendo medido', () => {
      const soCold = baselineWith(1_000);
      delete soCold.arms.warm;
      const { code, verdicts } = run({}, soCold);
      const warm = verdicts.find((x) => x.label.includes('[warm] p95 ≤ baseline'))!;
      expect(warm.skipped).toBe(true);
      expect(warm.passed).toBe(false);
      expect(verdicts.find((x) => x.label.includes('[cold] p95 ≤ baseline'))!.passed).toBe(true);
      expect(code).toBe(1);
    });

    it('o fingerprint lê o pool e o teto de leituras do AMBIENTE, não de literais', () => {
      // Mesmo motivo do teto de 6 vir do código: um fingerprint que digitasse
      // `pool_max: 10` concordaria consigo mesmo no dia em que alguém subisse o
      // pool para 20 — que é o dia em que o baseline deixa de valer.
      const fp = runFingerprint(
        { pairs: 50, concurrency: 20, think_ms: 150, identity: 'profile', turns: 600, sustain_s: 60 },
        8,
        20,
      );
      expect(fp.max_concurrent_reads).toBe(8);
      expect(fp.pool_max).toBe(20);
      expect(fp.cardinalities).toEqual([...CARDINALITIES]);
    });
  });

  // -------------------------------------------------------------------------
  // Amostragem do pool: zero amostras NÃO é "drenou"
  // -------------------------------------------------------------------------

  describe('amostragem do pool', () => {
    it('REPROVA com zero amostras — nenhuma observação não é uma observação boa', () => {
      // O achado: `pool_samples === 0` era tratado como "drenou". Uma corrida
      // com `--sample-ms` maior que a duração, ou com o event loop impedindo o
      // amostrador de rodar, passava num dos critérios centrais do gate sem
      // observação alguma.
      // A ÚNICA coisa fora do lugar é a contagem de amostras: a lacuna cega
      // segue no valor de uma corrida sadia. Injetar também uma lacuna enorme
      // faria o teste passar por outro motivo e deixaria o defeito coberto por
      // acidente — foi o que aconteceu na primeira versão deste caso.
      const { code, verdicts, failed } = run({
        pool_samples: 0,
        pool_saturated_samples: 0,
        pool_sampled_span_ms: 0,
      });
      expect(code).toBe(1);
      const cobertura = failed.find((v) => v.label.includes('a amostragem do pool observou'))!;
      expect(cobertura).toBeDefined();
      expect(cobertura.detail).toContain('NENHUMA AMOSTRA DO POOL');
      // E o critério que dependia dessa observação NÃO pode sair aprovado.
      const drena = verdicts.find((v) => v.label.includes('o pool drena'))!;
      expect(drena.passed).toBe(false);
      expect(drena.detail).toContain('SEM AMOSTRAGEM VÁLIDA DO POOL');
    });

    it('REPROVA quando o amostrador ficou cego por uma lacuna grande', () => {
      // 610 amostras num período de 100 ms, mas 6 s sem nenhuma no meio: houve
      // 6 s de corrida sobre os quais o critério de saturação nada sabe.
      const { code, failed } = run({ pool_max_sample_gap_ms: 6_000 });
      expect(code).toBe(1);
      expect(failed.some((v) => v.label.includes('a amostragem do pool observou'))).toBe(true);
    });

    it('a maior sequência saturada é medida por TIMESTAMPS, não somando períodos', () => {
      // O acumulador antigo (`streak += periodMs`) contava períodos PEDIDOS.
      // Quando o event loop atrasa — que é exatamente quando a máquina está sob
      // a carga que interessa medir — ele conta muito menos tempo do que
      // passou, e uma saturação de 60 s aparece como 1 s.
      const t = createPoolSaturationTracker(0);
      // Amostrador pedido a cada 100 ms, mas STARVED: 10 amostras em 61 s.
      for (let i = 1; i <= 10; i++) t.observe(i * 6_100, true);
      const s = t.summary(61_000);
      expect(s.samples).toBe(10);
      expect(s.saturated_samples).toBe(10);
      // Somando períodos daria 1 000 ms; o relógio diz 61 000 ms.
      expect(s.max_streak_ms).toBe(61_000);
      expect(s.max_gap_ms).toBe(6_100);
    });

    it('a sequência começa no último instante em que se SABE que o pool drenou', () => {
      const t = createPoolSaturationTracker(0);
      t.observe(100, false); // drenado
      t.observe(200, true);
      t.observe(300, true);
      t.observe(400, false); // drenou de novo
      t.observe(500, true);
      const s = t.summary(500);
      // A maior sequência vai de 100 (última drenada) a 300: 200 ms. Erra para
      // MAIS em até um período, que é a direção segura para este critério.
      expect(s.max_streak_ms).toBe(200);
      expect(s.saturated_samples).toBe(3);
      expect(s.samples).toBe(5);
    });

    it('sem observação alguma, a lacuna cega é a corrida INTEIRA', () => {
      const s = createPoolSaturationTracker(0).summary(61_000);
      expect(s).toEqual({
        samples: 0,
        saturated_samples: 0,
        max_streak_ms: 0,
        sampled_span_ms: 0,
        max_gap_ms: 61_000,
        load: { samples: 0, saturated_samples: 0 },
        drain: { samples: 0, saturated_samples: 0 },
        drained_after_ms: NEVER_DRAINED,
      });
    });

    it('a lacuna cega inclui as PONTAS — um amostrador que morreu no meio se denuncia', () => {
      const t = createPoolSaturationTracker(0);
      t.observe(100, false);
      t.observe(200, false);
      const s = t.summary(30_000); // morreu aos 200 ms de uma corrida de 30 s
      expect(s.sampled_span_ms).toBe(100);
      expect(s.max_gap_ms).toBe(29_800);
    });

    // -----------------------------------------------------------------------
    // A FRONTEIRA: não basta o avaliador saber. Se `runArm` continuar
    // publicando `pool_samples: 0` como se fosse observação, o spec passa e a
    // corrida real segue mentindo.
    // -----------------------------------------------------------------------

    it('o que o amostrador REAL produz atravessa até o veredicto', async () => {
      // Um pool de mentira, mas o amostrador de verdade — o mesmo
      // `startPoolSampler` que `runArm` usa — com período MAIOR que a duração
      // da corrida: o caso que produzia 0/0 amostras e "drenou".
      const poolStub = {
        options: { max: 10 },
        waitingCount: 0,
        totalCount: 10,
        idleCount: 0,
      } as unknown as Parameters<typeof startPoolSampler>[0];

      const t0 = performance.now();
      const sampler = startPoolSampler(poolStub, 5_000, t0);
      await new Promise((r) => setTimeout(r, 30));
      const metrics = poolMetricsFromSummary(sampler.stop(performance.now()), 5_000);

      expect(metrics.pool_samples).toBe(0);
      expect(metrics.pool_sample_ms).toBe(5_000);
      expect(metrics.pool_max_sample_gap_ms).toBeGreaterThan(0);

      // E o veredicto, alimentado com o que o amostrador REALMENTE produziu:
      const arms = armsWith({});
      for (const a of arms) Object.assign(a, metrics);
      const verdicts = evaluateGate(arms, TH, BASELINE_FOLGADO, { mode: 'gate', fingerprint: FP });
      expect(gateExitCode(verdicts, 'gate')).toBe(1);
      expect(
        verdicts.filter((v) => !v.passed).some((v) => v.label.includes('a amostragem do pool')),
      ).toBe(true);
    });

    it('o amostrador REAL separa carga de escoamento na fronteira do produtor', async () => {
      // A fronteira só existe se `runArm` a MARCAR e continuar amostrando
      // depois dela. Sem isso não há fase de escoamento: o gerador é de malha
      // fechada, então quando os workers retornam todo turno já terminou e o
      // amostrador era parado nesse mesmo instante — zero amostras depois da
      // fronteira, que é o segundo caso do achado.
      const poolStub = {
        options: { max: 10 },
        waitingCount: 3,
        totalCount: 10,
        idleCount: 0,
      } as unknown as Parameters<typeof startPoolSampler>[0];

      const t0 = performance.now();
      const sampler = startPoolSampler(poolStub, 5, t0);
      await new Promise((r) => setTimeout(r, 60));

      // O produtor para: ninguém mais pede conexão e a fila escoa.
      sampler.markProducerStopped(performance.now());
      poolStub.waitingCount = 0;
      poolStub.idleCount = 10;
      await new Promise((r) => setTimeout(r, 60));

      const m = poolMetricsFromSummary(sampler.stop(performance.now()), 5);
      expect(m.pool_load_samples).toBeGreaterThan(0);
      expect(m.pool_load_saturated_samples).toBe(m.pool_load_samples);
      expect(m.pool_drain_samples).toBeGreaterThan(0);
      expect(m.pool_drain_saturated_samples).toBe(0);
      expect(m.pool_drained_after_ms).toBeGreaterThanOrEqual(0);
      expect(m.pool_load_samples + m.pool_drain_samples).toBe(m.pool_samples);

      // E o veredicto do perfil de saturação aceita essa corrida.
      const arms = armsWith({ think_ms: 0 });
      for (const a of arms) Object.assign(a, m);
      const verdicts = evaluateGate(arms, TH, BASELINE_FOLGADO, { mode: 'gate', fingerprint: FP });
      const v = verdicts.find((x) => x.label.includes('perfil de SATURAÇÃO'))!;
      expect(v.passed).toBe(true);
    });

    it('o amostrador real conta amostras e saturação quando o período cabe na corrida', async () => {
      const poolStub = {
        options: { max: 10 },
        waitingCount: 3,
        totalCount: 10,
        idleCount: 0,
      } as unknown as Parameters<typeof startPoolSampler>[0];
      const t0 = performance.now();
      const sampler = startPoolSampler(poolStub, 5, t0);
      await new Promise((r) => setTimeout(r, 120));
      const m = poolMetricsFromSummary(sampler.stop(performance.now()), 5);
      expect(m.pool_samples).toBeGreaterThan(5);
      expect(m.pool_saturated_samples).toBe(m.pool_samples);
      expect(m.pool_sampled_span_ms).toBeGreaterThan(0);
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

  // -------------------------------------------------------------------------
  // Modo: medir e barrar são coisas diferentes, e o comando tem que dizer qual
  // -------------------------------------------------------------------------

  describe('--mode', () => {
    it('o default é `gate` — esquecer a flag produz o julgamento ESTRITO', () => {
      expect(parseArgs([], 6).mode).toBe('gate');
      expect(parseArgs(['--mode', 'measure'], 6).mode).toBe('measure');
      expect(parseArgs(['--self-test'], 6).mode).toBe('self-test');
      expect(() => parseArgs(['--mode', 'quase-gate'], 6)).toThrow(/--mode inválido/);
      expect(() => parseArgs(['--self-test', '--mode', 'gate'], 6)).toThrow(/conflita/);
    });

    it('--write-baseline EXIGE --mode measure: gravar baseline não é rodar o gate', () => {
      // Sem isto, a mesma corrida que julga produz a referência contra a qual
      // ela seria julgada — e "medição absoluta" e "gate" voltam a ser a mesma
      // saída, que é a origem do achado.
      expect(() => parseArgs(['--write-baseline'], 6)).toThrow(/--mode measure/);
      expect(() => parseArgs(['--write-baseline', '--sustain-s', '60'], 6)).toThrow(/--mode measure/);
      expect(parseArgs(['--mode', 'measure', '--write-baseline'], 6).write_baseline).toBe(true);
    });

    it('--sample-ms é validado contra a JANELA que ele precisa resolver', () => {
      // Um período maior que a janela devolve zero amostras — e zero amostras
      // era lido como "o pool drenou".
      expect(() => parseArgs(['--sample-ms', '10000'], 6)).toThrow(/janela de saturação/);
      expect(() => parseArgs(['--sample-ms', '0'], 6)).toThrow(/inteiro ≥ 1/);
      expect(() => parseArgs(['--sample-ms', '2000', '--sustain-s', '10'], 6)).toThrow(
        /não resolve uma corrida de 10s/,
      );
      expect(parseArgs(['--sample-ms', '100', '--sustain-s', '60'], 6).sample_ms).toBe(100);
    });

    it('--self-test-baseline só existe dentro do autoteste', () => {
      expect(() => parseArgs(['--self-test-baseline', 'missing'], 6)).toThrow(/--self-test/);
      expect(() => parseArgs(['--self-test', '--self-test-baseline', 'nada'], 6)).toThrow(
        /--self-test-baseline inválido/,
      );
      expect(parseArgs(['--self-test', '--self-test-baseline', 'missing'], 6).self_test_baseline).toBe(
        'missing',
      );
    });
  });

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
