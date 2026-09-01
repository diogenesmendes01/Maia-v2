/**
 * Issue #700 — a SONDA VERMELHA da inclusão do `resolveScope` na medição.
 *
 * ## O que este arquivo prova, e por que ele não podia morar no spec do gate
 *
 * `tests/unit/scripts/turn-context-gate.spec.ts` prova o AVALIADOR: alimentado
 * com números sintéticos, `evaluateGate` reprova quando deve. Isso é
 * necessário e não é suficiente para a #700, porque o defeito que a #700
 * corrige não estava no avaliador — estava na MEDIÇÃO. `buildContext` fabricava
 * o escopo em memória e a massa não semeava `permissoes` nem
 * `permission_profiles`; um avaliador perfeito julgando números que ninguém
 * mediu continua carimbando.
 *
 * Então o critério aqui não é "o relatório menciona `resolveScope`", nem "a
 * flag `COBERTURA_DA_MEDICAO.resolve_scope_medido` está `true`". O critério é
 * uma asserção sobre o que foi **EXECUTADO**:
 *
 *   turno real (`runTurnOnce`) → `resolveScope` de PRODUÇÃO
 *     → repositórios ENVOLVIDOS pelo contador (`instrumentAll`)
 *       → frame do turno (`newTurnFrame`/`runInTurnFrame`, os mesmos de `runArm`)
 *         → `scopeMetricsFromSamples` (a mesma tradução que `runArm` usa)
 *           → `evaluateGate` → exit code
 *
 * Cada elo é o de produção. Se alguém voltar a fabricar o escopo em memória,
 * ou tirar as duas leituras do `instrumentAll`, ou o `resolveScope` deixar de
 * fazer exatamente dois round-trips, a cadeia devolve zero (ou outro número) e
 * os casos abaixo ficam VERMELHOS — em modo `gate`, com exit code 1.
 *
 * ## O que ele NÃO prova
 *
 * Que a MASSA do harness semeia as duas tabelas: isso é SQL contra Postgres, e
 * quem prova é a corrida (`npm run turn:bench`), cujo critério
 * "o escopo do turno veio do BANCO, nas cardinalidades 1/10/100" fica vermelho
 * com escopo vazio. Aqui o banco é um dublê — o que se prova é o CAMINHO.
 *
 * ## Por que os repositórios são dublês
 *
 * `@/db/repositories.js` abre o pool no import. A sonda precisa do
 * `resolveScope` REAL (é ele que decide quantas leituras o estágio faz), não
 * do Postgres; o dublê troca as linhas, não o caminho.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { moduloDeProducao } from '../../helpers/modulo-de-producao.js';
import {
  CARDINALITIES,
  SCOPE_READS_PER_TURN,
  SCOPE_SECTIONS,
  countScopeReads,
  evaluateGate,
  gateExitCode,
  instrumentAll,
  newTurnFrame,
  runInTurnFrame,
  runTurnOnce,
  scopeMetricsFromSamples,
  syntheticPassingArm,
  coberturaAtual,
  type ArmResult,
  type InstrumentableRepos,
  type Pair,
  type PairPerson,
  type ResolvedScope,
  type RunFingerprint,
  type Thresholds,
  type TurnStageDeps,
} from '../../../scripts/turn-context-benchmark.js';

// ---------------------------------------------------------------------------
// O banco de mentira: linhas de verdade em forma, contadas uma a uma
// ---------------------------------------------------------------------------

type Linha = Record<string, unknown>;

const banco = {
  permissoes: [] as Linha[],
  profiles: [] as Linha[],
  chamadas: { forPessoa: 0, byIds: 0 },
  /** O maior lote que o `profilesRepo.byIds` recebeu — o JOIN em batch. */
  maiorLoteDeProfiles: 0,
};

const permissoesRepo = {
  async forPessoa(_pessoa_id: string): Promise<Linha[]> {
    banco.chamadas.forPessoa++;
    return banco.permissoes;
  },
};
const profilesRepo = {
  async byIds(ids: string[], limit = 500): Promise<Linha[]> {
    banco.chamadas.byIds++;
    const distintos = Array.from(new Set(ids));
    banco.maiorLoteDeProfiles = Math.max(banco.maiorLoteDeProfiles, distintos.length);
    return banco.profiles.filter((p) => distintos.includes(p.id as string)).slice(0, limit);
  },
};

// A fábrica roda quando `@/governance/permissions.js` for importado (no
// `beforeAll`), depois de os `const` acima já existirem.
vi.mock('@/db/repositories.js', () => ({ permissoesRepo, profilesRepo, pessoasRepo: {} }));

const permissions = moduloDeProducao(() => import('@/governance/permissions.js'));

/** Semeia `n` permissões, cada uma com um profile DISTINTO — como a massa faz. */
function semear(n: number): { entidade_ids: string[] } {
  const entidade_ids = Array.from({ length: n }, (_, i) => `ent-${String(i).padStart(4, '0')}`);
  banco.profiles = entidade_ids.map((_, i) => ({
    id: `prof-${String(i).padStart(4, '0')}`,
    nome: 'perfil de sonda',
    acoes: ['read_balance'],
    limite_default: '200.00',
    tenant_id: 't0',
    agent_id: 'a0',
  }));
  banco.permissoes = entidade_ids.map((entidade_id, i) => ({
    id: `perm-${i}`,
    pessoa_id: 'p0',
    entidade_id,
    profile_id: `prof-${String(i).padStart(4, '0')}`,
    papel: 'operador',
    status: 'ativa',
    limites: {},
    tenant_id: 't0',
    agent_id: 'a0',
  }));
  return { entidade_ids };
}

// ---------------------------------------------------------------------------
// O par/pessoa que o harness monta, na forma mínima que o turno consome
// ---------------------------------------------------------------------------

function pessoaDe(entities: number): PairPerson {
  return {
    entities,
    pessoa_id: 'p0',
    conversa_id: 'c0',
    pessoa: { id: 'p0', status: 'ativa', tenant_id: 't0', agent_id: 'a0' },
    conversa: { id: 'c0' },
    inbound: { id: 'm0', conteudo: 'oi' },
  };
}

function parDe(person: PairPerson): Pair {
  return {
    tenant_id: 'bench525-t0',
    agent_id: 'bench525-a0',
    entidade_ids: [],
    profile_ids: [],
    people: [person],
  };
}

/** Os 13 repositórios que o turno NÃO exercita aqui — só precisam existir. */
function reposDoHarness(): InstrumentableRepos {
  const vazio = async (): Promise<unknown> => undefined;
  return {
    permissoesRepo,
    profilesRepo,
    operationalProfileVersionsRepo: { getActive: vazio },
    selfStateRepo: { getActive: vazio },
    mensagensRepo: { recentInConversation: vazio },
    entidadesRepo: { byIdsWithState: vazio },
    entityStatesRepo: { byIds: vazio },
    factsRepo: { listMentionableForScopes: vazio },
    rulesRepo: { listActive: vazio },
    memoryEntryRepo: { findRelevant: vazio },
    behavioralHintRepo: { findActiveForScopes: vazio },
    capabilitiesSkillRepo: { listAll: vazio },
    capabilityGapsRepo: { listByLevels: vazio },
    procedureExecutionsRepo: { findActiveForConversa: vazio },
    procedureDefinitionsRepo: { findById: vazio },
  } as unknown as InstrumentableRepos;
}

// `instrumentAll` MUTA os objetos: chamar por caso empilharia wrappers e cada
// leitura seria contada duas vezes. Uma vez por arquivo, como em `main()`.
beforeAll(() => {
  instrumentAll(reposDoHarness());
});

beforeEach(() => {
  banco.chamadas = { forPessoa: 0, byIds: 0 };
  banco.maiorLoteDeProfiles = 0;
});

/** Um turno medido: o frame REAL do harness, do jeito que `runArm` o abre. */
async function turnoMedido(
  person: PairPerson,
  deps: Partial<TurnStageDeps> = {},
): Promise<{
  reads: Array<{ section: string; ms: number }>;
  amostra: { entities: number; scope_entities: number; scope_ms: number; reads: Array<{ section: string }> };
  ctx: { scope: ResolvedScope } | null;
}> {
  let ctx: { scope: ResolvedScope } | null = null;
  const frame = newTurnFrame(0, 'bench525-t0', person.entities);
  const stage = await runInTurnFrame(frame, () =>
    runTurnOnce(parDe(person), person, {
      // O `resolveScope` de PRODUÇÃO. É ele quem decide quantas leituras o
      // estágio faz — fixar esse número no harness seria o gate concordando
      // consigo mesmo.
      resolveScope: (pessoa) =>
        permissions().resolveScope(pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0]) as Promise<ResolvedScope>,
      buildPrompt: async (c) => {
        ctx = c as { scope: ResolvedScope };
        return undefined;
      },
      runWithTenantContext: (_tenant, fn) => fn(),
      ...deps,
    }),
  );
  return {
    reads: frame.reads,
    amostra: {
      entities: person.entities,
      scope_entities: stage.scope_entities,
      scope_ms: stage.scope_ms,
      reads: frame.reads,
    },
    ctx,
  };
}

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

const FP: RunFingerprint = {
  pairs: 50,
  concurrency: 20,
  think_ms: 150,
  identity: 'profile',
  cardinalities: [...CARDINALITIES],
  pool_max: 10,
  max_concurrent_reads: 6,
  turns: 600,
  sustain_s: 60,
  cobertura: coberturaAtual(),
};

/** Um braço saudável cujos campos do ESTÁGIO vêm das amostras medidas. */
function bracoCom(metrics: ReturnType<typeof scopeMetricsFromSamples>): ArmResult[] {
  const arms = [syntheticPassingArm('cold', TH)];
  Object.assign(arms[0]!, metrics);
  return arms;
}

describe('#700 — o resolveScope está DENTRO da medição do turno', () => {
  it('o turno executa o resolveScope de produção, e o contador registra as DUAS leituras', async () => {
    semear(100);
    const { reads, amostra, ctx } = await turnoMedido(pessoaDe(100));

    // 1. As leituras aconteceram, na ordem em que o turno as faz, e são as
    //    duas seções que o gate cobra.
    expect(countScopeReads(reads)).toBe(SCOPE_READS_PER_TURN);
    expect(reads.map((r) => r.section)).toEqual([
      SCOPE_SECTIONS.permissoes,
      SCOPE_SECTIONS.profiles,
    ]);
    expect(banco.chamadas).toEqual({ forPessoa: 1, byIds: 1 });

    // 2. O `byIds` recebeu o LOTE inteiro: 100 perfis distintos num round-trip
    //    só. Um N+1 apareceria como 100 chamadas de lote 1.
    expect(banco.maiorLoteDeProfiles).toBe(100);

    // 3. O escopo que chegou ao `buildPrompt` é o RESOLVIDO — `permissao` e
    //    `profile` são as linhas do repositório, não literais do harness.
    expect(amostra.scope_entities).toBe(100);
    expect(ctx!.scope.byEntity.size).toBe(100);
    const resolvido = ctx!.scope.byEntity.get('ent-0000') as {
      permissao: { id: string };
      profile: { id: string };
    };
    expect(resolvido.permissao.id).toBe('perm-0');
    expect(resolvido.profile.id).toBe('prof-0000');
  });

  it('a cardinalidade do turno É o tamanho do escopo resolvido — 1, 10 e 100', async () => {
    // A armadilha da #700: `resolveScope(pessoa)` devolve TODAS as permissões
    // daquela pessoa, e não aceita parâmetro de cardinalidade. É por isso que
    // o harness semeia TRÊS pessoas por par, uma por cardinalidade.
    for (const n of CARDINALITIES) {
      semear(n);
      const { amostra } = await turnoMedido(pessoaDe(n));
      expect({ n, resolvido: amostra.scope_entities }).toEqual({ n, resolvido: n });
      expect(scopeMetricsFromSamples([amostra]).scope_cardinality_mismatches).toBe(0);
    }
  });

  it('VERMELHO se o escopo voltar a ser fabricado em memória: o contador zera e o gate REPROVA', async () => {
    semear(100);

    // A REGRESSÃO, encenada: um turno cujo escopo nasce pronto, em memória —
    // exatamente o que `buildContext` fazia antes da #700.
    const fabricado: ResolvedScope = {
      entidades: ['ent-0000'],
      byEntity: new Map([['ent-0000', { permissao: {}, profile: {}, effective_limits: {} }]]),
    };
    const regressao = await turnoMedido(pessoaDe(1), { resolveScope: async () => fabricado });

    expect(countScopeReads(regressao.reads)).toBe(0);
    expect(banco.chamadas).toEqual({ forPessoa: 0, byIds: 0 });

    const metricsRuins = scopeMetricsFromSamples([regressao.amostra]);
    expect(metricsRuins.scope_reads_per_turn_min).toBe(0);
    expect(metricsRuins.scope_reads_per_turn_max).toBe(0);

    // …e o veredicto, alimentado com o que o contador REALMENTE produziu.
    const ruins = evaluateGate(bracoCom(metricsRuins), TH, null, { mode: 'gate', fingerprint: FP });
    expect(gateExitCode(ruins, 'gate')).toBe(1);
    expect(
      ruins.filter((v) => !v.passed).map((v) => v.label),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('aceite completo do orçamento do turno'),
        expect.stringContaining('foi EXERCITADO'),
      ]),
    );

    // CONTROLE, no mesmo caso: o MESMO caminho, com o `resolveScope` de
    // produção, produz as duas leituras e os dois critérios passam. Sem este
    // controle o caso acima passaria por qualquer motivo.
    const medidos = [];
    for (const n of CARDINALITIES) {
      semear(n);
      medidos.push((await turnoMedido(pessoaDe(n))).amostra);
    }
    const metricsBons = scopeMetricsFromSamples(medidos);
    expect(metricsBons.scope_reads_per_turn_min).toBe(SCOPE_READS_PER_TURN);
    expect(metricsBons.scope_entities_min).toBe(1);
    expect(metricsBons.scope_entities_max).toBe(100);
    const bons = evaluateGate(bracoCom(metricsBons), TH, null, { mode: 'gate', fingerprint: FP });
    const falhasDoEscopo = bons
      .filter((v) => !v.passed)
      .filter(
        (v) =>
          v.label.includes('foi EXERCITADO') ||
          v.label.includes('veio do BANCO') ||
          v.label.includes('aceite completo'),
      );
    expect(falhasDoEscopo).toEqual([]);
  });

  it('VERMELHO se a massa deixar de semear permissoes/permission_profiles', async () => {
    // O outro modo de falha que a #700 nomeia: o caminho está certo, as duas
    // leituras acontecem — mas não há linha nenhuma para ler. O
    // `resolveScope` devolve escopo vazio, o turno renderiza um escopo que não
    // custa nada, e a cardinalidade 1/10/100 vira ficção.
    banco.permissoes = [];
    banco.profiles = [];
    const semMassa = await turnoMedido(pessoaDe(100));
    expect(semMassa.amostra.scope_entities).toBe(0);

    const metrics = scopeMetricsFromSamples([semMassa.amostra]);
    expect(metrics.scope_cardinality_mismatches).toBe(1);
    expect(metrics.scope_entities_max).toBe(0);

    const verdicts = evaluateGate(bracoCom(metrics), TH, null, { mode: 'gate', fingerprint: FP });
    expect(gateExitCode(verdicts, 'gate')).toBe(1);
    const v = verdicts.find((x) => x.label.includes('veio do BANCO'))!;
    expect(v.passed).toBe(false);
    expect(v.detail).toContain('escopo resolvido=0–0');

    // CONTROLE: com a massa de volta — nas TRÊS cardinalidades, que é o que o
    // critério cobra — o mesmo veredicto aprova.
    const comMassa = [];
    for (const n of CARDINALITIES) {
      semear(n);
      comMassa.push((await turnoMedido(pessoaDe(n))).amostra);
    }
    const bons = evaluateGate(bracoCom(scopeMetricsFromSamples(comMassa)), TH, null, {
      mode: 'gate',
      fingerprint: FP,
    });
    expect(bons.find((x) => x.label.includes('veio do BANCO'))!.passed).toBe(true);
  });

  it('VERMELHO se alguém tirar as leituras do escopo do `instrumentAll`', async () => {
    // A terceira forma de o instrumento voltar a ser cego: o turno resolve o
    // escopo no banco, mas as leituras não são atribuídas ao turno. Encenado
    // com repositórios NÃO instrumentados — o `resolveScope` é o mesmo, o que
    // muda é só o contador.
    const cru = {
      async forPessoa(): Promise<Linha[]> {
        return banco.permissoes;
      },
    };
    semear(10);
    const frame = newTurnFrame(0, 'bench525-t0', 10);
    await runInTurnFrame(frame, async () => {
      await cru.forPessoa();
    });
    expect(countScopeReads(frame.reads)).toBe(0);

    // CONTROLE: o MESMO método, envolvido pelo `instrumentAll` do harness,
    // registra a leitura na seção que o gate cobra.
    const instrumentado = newTurnFrame(0, 'bench525-t0', 10);
    await runInTurnFrame(instrumentado, async () => {
      await permissoesRepo.forPessoa('p0');
    });
    expect(instrumentado.reads.map((r) => r.section)).toEqual([SCOPE_SECTIONS.permissoes]);
  });

  it('as leituras do escopo NÃO inflam o pico de leituras simultâneas — elas são sequenciais', async () => {
    // O `resolveScope` roda ANTES do `ReadGate`, e suas duas leituras são
    // sequenciais entre si (`byIds` depende do resultado de `forPessoa`).
    // Logo elas somam 2 às LEITURAS POR TURNO e nada ao PICO — que é o que o
    // teto de 6 (`TURN_CONTEXT_MAX_CONCURRENT_READS`) mede.
    semear(100);
    const frame = newTurnFrame(0, 'bench525-t0', 100);
    await runInTurnFrame(frame, () =>
      runTurnOnce(parDe(pessoaDe(100)), pessoaDe(100), {
        resolveScope: (pessoa) =>
          permissions().resolveScope(pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0]) as Promise<ResolvedScope>,
        buildPrompt: async () => undefined,
        runWithTenantContext: (_t, fn) => fn(),
      }),
    );
    expect(frame.reads).toHaveLength(SCOPE_READS_PER_TURN);
    expect(frame.peak).toBe(1);
  });
});
