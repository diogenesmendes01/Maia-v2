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
  SCOPE_READS_PER_TURN_MIN,
  SCOPE_SECTIONS,
  countScopeReads,
  evaluateGate,
  gateExitCode,
  instrumentAll,
  measureTurn,
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
  chamadas: { forPessoa: 0, byIds: 0, forPessoaComProfile: 0 },
  /** O maior lote que o `profilesRepo.byIds` recebeu — o JOIN em batch. */
  maiorLoteDeProfiles: 0,
  /**
   * Atraso por leitura, em ms. Serve a um caso só: fazer o estágio do escopo
   * DOMINAR o relógio do turno, para que a fronteira do cronômetro possa ser
   * afirmada com relógio real, sem dublê de tempo.
   */
  atraso_ms: 0,
};

const dormir = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const permissoesRepo = {
  async forPessoa(_pessoa_id: string): Promise<Linha[]> {
    banco.chamadas.forPessoa++;
    await dormir(banco.atraso_ms);
    return banco.permissoes;
  },
  // A leitura FUNDIDA da #693: o JOIN `permissoes ⋈ permission_profiles` numa
  // ida só. É ela que o `resolveScope` de produção chama nesta árvore; o fake
  // emula o join sobre as mesmas linhas que os dois métodos antigos servem.
  async forPessoaComProfile(_pessoa_id: string): Promise<Array<{ permissao: Linha; profile: Linha }>> {
    banco.chamadas.forPessoaComProfile++;
    await dormir(banco.atraso_ms);
    return banco.permissoes.flatMap((permissao) => {
      const profile = banco.profiles.find((pr) => pr.id === permissao.profile_id);
      return profile ? [{ permissao, profile }] : [];
    });
  },
};
const profilesRepo = {
  async byIds(ids: string[], limit = 500): Promise<Linha[]> {
    banco.chamadas.byIds++;
    await dormir(banco.atraso_ms);
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
  banco.chamadas = { forPessoa: 0, byIds: 0, forPessoaComProfile: 0 };
  banco.maiorLoteDeProfiles = 0;
  banco.atraso_ms = 0;
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
  relative_margin: 0.1,
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
  it('o turno executa o resolveScope de produção, e o contador registra a leitura FUNDIDA', async () => {
    semear(100);
    const { reads, amostra, ctx } = await turnoMedido(pessoaDe(100));

    // 1. A leitura aconteceu, e é UMA: a composição MEDIDA do `resolveScope`
    //    desta árvore é a fusão da #693 (`forPessoaComProfile`, o JOIN numa ida
    //    só) — um fato da árvore, não um critério do gate: desde a decisão da
    //    #525 o gate cobra o piso (≥1) e reporta a contagem.
    expect(countScopeReads(reads)).toBe(1);
    expect(countScopeReads(reads)).toBeGreaterThanOrEqual(SCOPE_READS_PER_TURN_MIN);
    expect(reads.map((r) => r.section)).toEqual([SCOPE_SECTIONS.permissoes_com_profile]);
    expect(banco.chamadas).toEqual({ forPessoa: 0, byIds: 0, forPessoaComProfile: 1 });

    // 2. O JOIN devolveu o LOTE inteiro numa ida: os dois métodos antigos
    //    ficaram intocados (contadores acima em zero) e nenhum N+1 de profiles
    //    existe para aparecer — o guardrail O(1) do gate cobre o caso geral.

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
    expect(banco.chamadas).toEqual({ forPessoa: 0, byIds: 0, forPessoaComProfile: 0 });

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
    // produção, produz a leitura fundida e os critérios passam. Sem este
    // controle o caso acima passaria por qualquer motivo.
    const medidos = [];
    for (const n of CARDINALITIES) {
      semear(n);
      medidos.push((await turnoMedido(pessoaDe(n))).amostra);
    }
    const metricsBons = scopeMetricsFromSamples(medidos);
    expect(metricsBons.scope_reads_per_turn_min).toBe(1);
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

  it('a leitura FUNDIDA da #693 conta como leitura de escopo — o harness mede as duas formas do estágio', async () => {
    // A decisão da #525 exige que o gate afirme a PROPRIEDADE ("o escopo foi
    // resolvido no banco, dentro do relógio") sem fixar a implementação. A
    // prova: um repositório com `forPessoaComProfile` (a fusão da #693),
    // envolvido pelo MESMO `instrumentAll`, aparece no contador como leitura
    // de escopo — e a evidência resultante SATISFAZ o gate com 1 leitura por
    // turno.
    semear(10);
    // Objetos NOVOS de ponta a ponta: `reposDoHarness()` reutiliza os
    // `permissoesRepo`/`profilesRepo` compartilhados do arquivo, e
    // instrumentá-los de novo empilharia wrapper sobre wrapper — cada leitura
    // contaria duas vezes nos outros testes.
    const vazio = async (): Promise<unknown> => undefined;
    const fundido = {
      permissoesRepo: {
        forPessoaComProfile: async (): Promise<unknown> =>
          banco.permissoes.map((p, i) => ({ permissao: p, profile: banco.profiles[i] })),
      },
      profilesRepo: {},
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
    instrumentAll(fundido);

    const frame = newTurnFrame(0, 'bench525-t0', 10);
    await runInTurnFrame(frame, async () => {
      await (
        fundido.permissoesRepo as unknown as { forPessoaComProfile: (id: string) => Promise<unknown> }
      ).forPessoaComProfile('p0');
    });
    expect(frame.reads.map((r) => r.section)).toEqual([SCOPE_SECTIONS.permissoes_com_profile]);
    expect(countScopeReads(frame.reads)).toBe(1);

    // …e o veredicto aceita a forma fundida: 1 leitura por turno, cardinalidade
    // batendo — nenhum critério do escopo reprova.
    const amostras = [...CARDINALITIES].map((n) => ({
      entities: n,
      scope_entities: n,
      scope_ms: 1,
      reads: [{ section: SCOPE_SECTIONS.permissoes_com_profile }],
    }));
    const metrics = scopeMetricsFromSamples(amostras);
    expect(metrics.scope_reads_per_turn_min).toBe(1);
    expect(metrics.scope_reads_per_turn_max).toBe(1);
    const verdicts = evaluateGate(bracoCom(metrics), TH, null, { mode: 'gate', fingerprint: FP });
    const falhasDoEscopo = verdicts
      .filter((v) => !v.passed)
      .filter(
        (v) =>
          v.label.includes('foi EXERCITADO') ||
          v.label.includes('veio do BANCO') ||
          v.label.includes('aceite completo'),
      );
    expect(falhasDoEscopo).toEqual([]);

    // CONTROLE NEGATIVO no mesmo `it`: sem leitura nenhuma o mesmo veredicto
    // reprova — a aceitação da forma fundida não abriu a porta da vacuidade.
    const vazias = amostras.map((a) => ({ ...a, reads: [] }));
    const ruins = evaluateGate(bracoCom(scopeMetricsFromSamples(vazias)), TH, null, {
      mode: 'gate',
      fingerprint: FP,
    });
    expect(ruins.some((v) => !v.passed && v.label.includes('foi EXERCITADO'))).toBe(true);
  });

  it('as leituras do escopo NÃO inflam o pico de leituras simultâneas — elas são sequenciais', async () => {
    // O `resolveScope` roda ANTES do `ReadGate`, e suas duas leituras são
    // sequenciais entre si (`byIds` depende do resultado de `forPessoa`).
    // Na árvore fundida a leitura do escopo é UMA — ela soma 1 às LEITURAS
    // POR TURNO e nada além de 1 ao PICO, que é o que o teto de 6
    // (`TURN_CONTEXT_MAX_CONCURRENT_READS`) mede.
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
    expect(frame.reads).toHaveLength(1);
    expect(frame.peak).toBe(1);
  });

  // -------------------------------------------------------------------------
  // A FRONTEIRA DO RELÓGIO
  //
  // Achado da review da #721: os casos acima provam que o `resolveScope` é
  // EXECUTADO e CONTADO — e nenhum deles prova que ele está DENTRO do
  // cronômetro. A mutação
  //
  //     const ms = now() - t0;   →   const ms = now() - t0 - stage.scope_ms;
  //
  // restaura a cobertura antiga (`buildPrompt-sem-resolveScope`) em silêncio:
  // flag `true`, duas leituras contadas, cardinalidade batendo, `scope_p95_ms`
  // reportado — e o número que o gate JULGA volta a medir meio orçamento. A
  // suíte inteira passava, e o `--self-test` saía 0.
  //
  // Uma fronteira defendida só pela ESTRUTURA do código já falhou uma vez
  // aqui: é o defeito que a #700 corrige. Estes casos a defendem por
  // ARITMÉTICA, sobre `measureTurn` — que passou a ser o único lugar do
  // harness onde a duração do turno é calculada.
  // -------------------------------------------------------------------------

  describe('o relógio do turno CONTÉM o estágio do escopo', () => {
    it('com relógio injetado, a aritmética é exata: turno = escopo + prompt', async () => {
      semear(10);
      // Um relógio determinístico: cada etapa avança um número conhecido, então
      // não há aproximação nem folga onde uma subtração possa se esconder.
      let agora = 1_000;
      const person = pessoaDe(10);
      const frame = newTurnFrame(0, 'bench525-t0', 10);

      const sample = await measureTurn(
        parDe(person),
        10,
        frame,
        {
          resolveScope: async (pessoa) => {
            agora += 50; // o estágio custa 50
            return permissions().resolveScope(
              pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0],
            ) as Promise<ResolvedScope>;
          },
          buildPrompt: async () => {
            agora += 5; // o prompt custa 5
            return undefined;
          },
          runWithTenantContext: (_t, fn) => fn(),
        },
        () => agora,
      );

      expect(sample.scope_ms).toBe(50);
      // O NÚMERO QUE O GATE JULGA. 55 = 50 do escopo + 5 do prompt. Com a
      // subtração do estágio ele seria 5 — a cobertura antiga de volta.
      expect(sample.ms).toBe(55);
      expect(sample.ms - sample.scope_ms).toBe(5);
    });

    it('com relógio REAL, o turno não pode ser menor que o estágio que ele contém', async () => {
      // O mesmo, sem dublê de tempo: o estágio DOMINA o turno (duas leituras de
      // 30 ms; o `buildPrompt` é imediato). Se o relógio do turno excluísse o
      // estágio, `ms` cairia para perto de zero enquanto `scope_ms` ficaria em
      // ~60 — e a relação `ms ≥ scope_ms` se inverte.
      semear(10);
      banco.atraso_ms = 30;
      const person = pessoaDe(10);
      const frame = newTurnFrame(0, 'bench525-t0', 10);

      const sample = await measureTurn(parDe(person), 10, frame, {
        resolveScope: (pessoa) =>
          permissions().resolveScope(
            pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0],
          ) as Promise<ResolvedScope>,
        buildPrompt: async () => undefined,
        runWithTenantContext: (_t, fn) => fn(),
      });

      // A leitura fundida do escopo custou ~30 ms (um atraso injetado).
      expect(sample.scope_ms).toBeGreaterThanOrEqual(25);
      // …e o relógio do turno a CONTÉM.
      expect(sample.ms).toBeGreaterThanOrEqual(sample.scope_ms);
      expect(sample.ms).toBeGreaterThanOrEqual(25);

      // CONTROLE, no mesmo caso: sem atraso, o mesmo caminho mede um turno
      // barato — a asserção acima não passou por o número ser grande sempre.
      banco.atraso_ms = 0;
      const rapido = await measureTurn(
        parDe(person),
        10,
        newTurnFrame(1, 'bench525-t0', 10),
        {
          resolveScope: (pessoa) =>
            permissions().resolveScope(
              pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0],
            ) as Promise<ResolvedScope>,
          buildPrompt: async () => undefined,
          runWithTenantContext: (_t, fn) => fn(),
        },
      );
      expect(rapido.ms).toBeLessThan(50);
      expect(rapido.ms).toBeGreaterThanOrEqual(rapido.scope_ms);
    });

    it('a amostra que o braço arquiva é a que `measureTurn` devolveu — com as duas leituras dentro', async () => {
      // Fecha a volta: a MESMA amostra que carrega o relógio do turno é a que
      // alimenta `scopeMetricsFromSamples` e, dali, o veredicto. Não há um
      // segundo lugar onde `ms` seja recalculado.
      const medidos = [];
      // Um atraso pequeno por leitura faz o estágio DOMINAR o turno também
      // aqui: sem ele, `ms` e `scope_ms` são ambos ruído de sub-milissegundo e
      // a asserção `ms ≥ scope_ms` deixaria de ser um detector confiável da
      // subtração — passaria ou falharia por acaso.
      banco.atraso_ms = 10;
      for (const n of CARDINALITIES) {
        semear(n);
        medidos.push(await measureTurn(parDe(pessoaDe(n)), n, newTurnFrame(0, 'bench525-t0', n), {
          resolveScope: (pessoa) =>
            permissions().resolveScope(
              pessoa as Parameters<ReturnType<typeof permissions>['resolveScope']>[0],
            ) as Promise<ResolvedScope>,
          buildPrompt: async () => undefined,
          runWithTenantContext: (_t, fn) => fn(),
        }));
      }
      for (const m of medidos) {
        expect(countScopeReads(m.reads)).toBe(1);
        // Uma leitura × 10 ms de atraso injetado; a folga é para timer coarse.
        expect(m.scope_ms).toBeGreaterThanOrEqual(8);
        expect(m.ms).toBeGreaterThanOrEqual(m.scope_ms);
      }
      const metrics = scopeMetricsFromSamples(medidos);
      expect(metrics.scope_reads_per_turn_min).toBe(1);
      expect(metrics.scope_cardinality_mismatches).toBe(0);
      const verdicts = evaluateGate(bracoCom(metrics), TH, null, { mode: 'gate', fingerprint: FP });
      expect(verdicts.find((v) => v.label.includes('aceite completo'))!.passed).toBe(true);
    });
  });
});
