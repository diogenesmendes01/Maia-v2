/**
 * Decisão 14 (issue #519/#534) — o backlog do onboarding alerta por IDADE e
 * CADÊNCIA, não por contagem.
 *
 * Texto do dono: "Não alertar apenas por backlog > N. Usar idade e cadência:
 * warning quando backlog > 0 e o item mais antigo estiver atrasado há mais de
 * 10 minutos, sustentado por 5 minutos; critical acima de 30 minutos."
 *
 * O critical NÃO leva `for`: a decisão diz "acima de 30 minutos", e os
 * 1800s já são a sustentação. Ver o caso que trava isso abaixo.
 *
 * ## Os dois casos que separam a regra nova da antiga
 *
 * Uma regra `backlog > N` erra nos dois sentidos, e são exatamente os dois
 * casos abaixo:
 *
 *   - **backlog GRANDE e FRESCO** — 5.000 runs que venceram há 30 segundos.
 *     `backlog > 100` já está gritando; o expirer vai drenar isso em minutos e
 *     nada está errado. Alerta falso, e alerta falso treina o plantão a ignorar.
 *   - **UM ÚNICO item parado há 12 minutos** — `backlog > 100` fica em silêncio
 *     para sempre. Mas uma run que não sai é uma run PRESA (um `FOR UPDATE`
 *     que ninguém solta, uma linha que o predicado pega e a escrita não), e é a
 *     falha que importa.
 *
 * Estes dois são `it()`s próprios abaixo, avaliados contra a `expr` real.
 *
 * ## Por que isto AVALIA a expressão em vez de fazer `grep`
 *
 * `grep '> 600'` passa numa regra que trocou `and` por `or`, que comparou a
 * série errada, ou que inverteu o operador. O que este arquivo faz é ler a
 * `expr` do YAML de produção e EXECUTÁ-LA (`tests/helpers/promql-instant.ts`)
 * contra séries sintéticas. Deletar a regra, mudar 600 para 60, ou trocar
 * `oldest_age_seconds` por `backlog` reprova aqui.
 *
 * ## O que este arquivo NÃO prova, e onde isso é provado
 *
 * `for: 5m` é temporal: nenhum avaliador instantâneo o demonstra. Aqui o `for:`
 * é lido do YAML e conferido como literal. A prova de comportamento está em
 * `monitoring/alerts/tests/onboarding.rules.test.yml`, um caso de
 * `promtool test rules` de verdade (linha do tempo, `pending` → `firing`), que
 * é a fonte de verdade da semântica reproduzida pelo avaliador deste
 * repositório. Ele RODA NO CI, no job `alert-rules` (`.github/workflows/ci.yml`,
 * `/bin/promtool` da imagem oficial do Prometheus); `promtool` não é
 * dependência instalada do projeto — o cabeçalho daquele arquivo traz o
 * comando `docker run` para reproduzir localmente na mesma versão.
 *
 * ## O alcance do `MetricsAbsent`, fixado aqui (review da PR #590)
 *
 * `absent()` é um teste de FROTA INTEIRA, não por réplica. Os dois `it()`s no
 * fim deste arquivo travam a limitação que isso implica — uma réplica que pare
 * de publicar a série enquanto outra saudável continua NÃO é detectada — e o
 * contraste que a torna aceitável: a réplica que publica `NaN` (o que o
 * collector faz quando a leitura falha) É detectada, pelo ramo `x != x`, com o
 * `instance` dela preservado.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { evalInstant, fires, type SeriesDb } from '../../helpers/promql-instant.js';
import { METRIC } from '../../../src/observability/taxonomy.js';

const ROOT = resolve(__dirname, '../../..');
const RULES_PATH = resolve(ROOT, 'monitoring/alerts/onboarding.rules.yml');
const PROMTOOL_TEST_PATH = resolve(ROOT, 'monitoring/alerts/tests/onboarding.rules.test.yml');
const RUNBOOK_PATH = resolve(ROOT, 'docs/runbooks/onboarding-saga.md');

const WARNING = 'MaiaOnboardingExpiryBacklogStaleWarning';
const CRITICAL = 'MaiaOnboardingExpiryBacklogStaleCritical';
const ABSENT = 'MaiaOnboardingExpiryMetricsAbsent';

const BACKLOG = METRIC.ONBOARDING_EXPIRY_BACKLOG;
const OLDEST = METRIC.ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS;

interface RuleDoc {
  groups?: Array<{
    name?: string;
    interval?: string;
    rules?: Array<{
      alert?: string;
      expr?: string;
      for?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    }>;
  }>;
}

const rulesText = existsSync(RULES_PATH) ? readFileSync(RULES_PATH, 'utf8') : '';

function alerts(): Map<string, NonNullable<NonNullable<RuleDoc['groups']>[number]['rules']>[number]> {
  const doc = (rulesText ? parseYaml(rulesText) : null) as RuleDoc | null;
  const out = new Map<string, NonNullable<NonNullable<RuleDoc['groups']>[number]['rules']>[number]>();
  for (const g of doc?.groups ?? []) {
    for (const r of g.rules ?? []) if (r.alert) out.set(r.alert, r);
  }
  return out;
}

/** A `expr` REAL do alerta — a única fonte das avaliações abaixo. */
function expr(name: string): string {
  const rule = alerts().get(name);
  expect(rule, `alerta ${name} não existe em monitoring/alerts/onboarding.rules.yml`).toBeDefined();
  const e = rule!.expr;
  expect(e, `alerta ${name} não tem \`expr\``).toBeTruthy();
  return e!;
}

/** Uma réplica só, sem rótulo de tenant — o formato real destas duas gauges. */
function replica(backlog: number, oldestAgeSeconds: number, instance = 'maia-0:3000'): SeriesDb {
  const labels = { instance, job: 'maia' };
  return {
    [BACKLOG]: [{ labels, value: backlog }],
    [OLDEST]: [{ labels, value: oldestAgeSeconds }],
  };
}

describe('decisão 14 — o alerta de backlog do onboarding', () => {
  it('o arquivo de regras existe e é YAML válido com os três alertas', () => {
    expect(
      existsSync(RULES_PATH),
      'monitoring/alerts/onboarding.rules.yml não existe',
    ).toBe(true);
    const names = [...alerts().keys()].sort();
    expect(names).toEqual([CRITICAL, ABSENT, WARNING].sort());
  });

  // -------------------------------------------------------------------------
  // Os dois casos decisivos, avaliados contra a `expr` de produção.
  // -------------------------------------------------------------------------

  it('backlog GRANDE mas FRESCO não alerta', () => {
    // 5.000 runs vencidas há 30s. Uma regra `backlog > 100` estaria gritando.
    const fresh = replica(5000, 30);
    expect(fires(expr(WARNING), fresh), 'warning disparou com backlog fresco').toBe(false);
    expect(fires(expr(CRITICAL), fresh), 'critical disparou com backlog fresco').toBe(false);
  });

  it('UM ÚNICO item parado há mais de 10 minutos alerta', () => {
    // Uma run só, atrasada há 12 minutos. Uma regra por contagem nunca vê isto.
    const stuck = replica(1, 12 * 60);
    expect(fires(expr(WARNING), stuck), 'warning não viu a run presa').toBe(true);
    expect(fires(expr(CRITICAL), stuck), 'critical não deveria disparar a 12min').toBe(false);
  });

  // -------------------------------------------------------------------------
  // Limiares, avaliados — não procurados com `grep`.
  // -------------------------------------------------------------------------

  it('warning: a fronteira é 600s, exclusiva', () => {
    expect(fires(expr(WARNING), replica(3, 600)), '600s exatos não é "mais de 10 minutos"').toBe(
      false,
    );
    expect(fires(expr(WARNING), replica(3, 601))).toBe(true);
  });

  it('critical: a fronteira é 1800s, exclusiva', () => {
    expect(fires(expr(CRITICAL), replica(3, 1800))).toBe(false);
    expect(fires(expr(CRITICAL), replica(3, 1801))).toBe(true);
  });

  it('critical implica warning — a escalada não tem buraco', () => {
    const bad = replica(3, 3600);
    expect(fires(expr(CRITICAL), bad)).toBe(true);
    expect(fires(expr(WARNING), bad), 'critical sem warning: o par escalaria torto').toBe(true);
  });

  it('backlog zerado não alerta, por mais que a idade seja lida como 0', () => {
    const empty = replica(0, 0);
    expect(fires(expr(WARNING), empty)).toBe(false);
    expect(fires(expr(CRITICAL), empty)).toBe(false);
  });

  it('a IDADE é condição, não decoração: backlog alto com idade baixa é silêncio', () => {
    // O guard contra a regressão para `backlog > N`: se alguém apagar o termo
    // da idade, esta asserção e a de "backlog grande e fresco" caem juntas.
    expect(fires(expr(WARNING), replica(100000, 5))).toBe(false);
  });

  it('a CONTAGEM é condição: idade alta com backlog zerado é silêncio', () => {
    // Estado impossível pelo repositório (`snapshotExpiryBacklog` devolve
    // idade 0 quando o backlog é 0), montado à mão porque é o que prova que o
    // termo `backlog > 0` está na expressão e é avaliado.
    expect(fires(expr(WARNING), replica(0, 5000))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Postura de falha: `NaN` não é zero saudável (#514).
  // -------------------------------------------------------------------------

  it('`NaN` nas duas séries não dispara backlog — e não é lido como fila vazia', () => {
    const blind = replica(Number.NaN, Number.NaN);
    expect(fires(expr(WARNING), blind)).toBe(false);
    expect(fires(expr(CRITICAL), blind)).toBe(false);
    // …e é o guarda de ausência que fala, senão a leitura cega vira silêncio.
    expect(fires(expr(ABSENT), blind), '`NaN` sustentado não acorda ninguém').toBe(true);
  });

  it('scrape que sumiu por completo dispara o guarda de ausência', () => {
    expect(fires(expr(ABSENT), {})).toBe(true);
  });

  it('leitura saudável não dispara o guarda de ausência', () => {
    expect(fires(expr(ABSENT), replica(0, 0))).toBe(false);
  });

  // A metade que o primeiro corte deixou de fora: o guarda olhava SÓ o
  // backlog. Backlog finito com a idade ilegível cega os dois alertas de
  // atraso exatamente igual — a condição deles é conjunção, e `max(NaN) > 600`
  // é falso — e o guarda ficava calado. Cobrir metade da entrada de um alerta
  // de cegueira é o mesmo defeito que ele existe para corrigir.

  it('SÓ a idade em `NaN`: os de atraso ficam cegos, e o guarda fala', () => {
    const meia = replica(7, Number.NaN);
    expect(fires(expr(WARNING), meia), 'backlog finito e idade ilegível não pode alertar atraso').toBe(false);
    expect(fires(expr(CRITICAL), meia)).toBe(false);
    expect(fires(expr(ABSENT), meia), 'idade ilegível com backlog são é cegueira, e ninguém a reportava').toBe(true);
  });

  it('SÓ a idade AUSENTE do scrape: mesmo veredito', () => {
    const soBacklog: SeriesDb = { [BACKLOG]: [{ labels: { instance: 'maia-0:3000', job: 'maia' }, value: 7 }] };
    expect(fires(expr(WARNING), soBacklog)).toBe(false);
    expect(fires(expr(ABSENT), soBacklog)).toBe(true);
  });

  it('SÓ o backlog em `NaN`, idade legível: o guarda continua falando', () => {
    // O caso simétrico, que o corte original já cobria — mantido para que a
    // ampliação da expressão não regrida o lado que funcionava.
    expect(fires(expr(ABSENT), replica(Number.NaN, 900))).toBe(true);
  });

  it('uma réplica cega não silencia a que enxerga', () => {
    // As duas gauges são lidas no SCRAPE do MESMO Postgres: toda réplica
    // reporta o mesmo número, e uma que falhou publica `NaN`. Se o `NaN` de uma
    // réplica apagasse o alerta, bastaria uma instância doente para cegar a
    // frota inteira durante o incidente.
    const labelsA = { instance: 'maia-0:3000', job: 'maia' };
    const labelsB = { instance: 'maia-1:3000', job: 'maia' };
    const mixed: SeriesDb = {
      [BACKLOG]: [
        { labels: labelsA, value: Number.NaN },
        { labels: labelsB, value: 1 },
      ],
      [OLDEST]: [
        { labels: labelsA, value: Number.NaN },
        { labels: labelsB, value: 900 },
      ],
    };
    expect(fires(expr(WARNING), mixed)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // O ALCANCE do guarda de ausência, fixado. Espelha
  // `monitoring/alerts/tests/onboarding.rules.test.yml` ("gauge ausente em
  // UMA replica nao dispara" e o contraste com `NaN`). Estes dois provam o
  // comportamento DOCUMENTADO, não o desejado: um teste que fixa a limitação
  // é o que impede alguém de "consertar" o comentário em vez do alerta.
  // ---------------------------------------------------------------------

  it('gauge AUSENTE em uma réplica, com outra saudável, NÃO dispara o guarda', () => {
    // `maia-0` está de pé e é scrapeada, mas não publica nenhuma das duas
    // gauges — nem `NaN`, nada. `maia-1` publica as duas, saudáveis.
    //
    // Nenhum ramo alcança isso, e é aritmética de conjunto, não bug:
    // `absent()` é FROTA INTEIRA e o seletor casa a série de `maia-1`, logo
    // devolve vazio; `x != x` é por réplica mas só vê quem PUBLICA, e uma
    // série ausente não é `NaN`. A frota inteira parece saudável enquanto
    // metade dela não está sendo lida.
    //
    // Quem cobre esse estado é o `up`/target health do Prometheus — ver o
    // comentário de ALCANCE DOS RAMOS em monitoring/alerts/onboarding.rules.yml
    // e docs/runbooks/onboarding-saga.md §5.1. `unless on(instance, job) up`
    // foi considerado e recusado: `prometheus.yml` não é versionado aqui e um
    // `job` errado faria o alerta nunca disparar — fail-open no alerta de
    // cegueira.
    const soUmaReplicaPublica: SeriesDb = {
      [BACKLOG]: [{ labels: { instance: 'maia-1:3000', job: 'maia' }, value: 0 }],
      [OLDEST]: [{ labels: { instance: 'maia-1:3000', job: 'maia' }, value: 0 }],
    };
    expect(
      fires(expr(ABSENT), soUmaReplicaPublica),
      'se este caso passar a disparar, a regra mudou de semântica e a documentação (regra + runbook) precisa mudar junto',
    ).toBe(false);
    // ...e os de atraso leem `max()` sobre a única réplica que publica.
    expect(fires(expr(WARNING), soUmaReplicaPublica)).toBe(false);
    expect(fires(expr(CRITICAL), soUmaReplicaPublica)).toBe(false);
  });

  it('a MESMA réplica publicando `NaN` já dispara, e só com o `instance` dela', () => {
    // O contraste que dá sentido ao caso acima: a diferença é entre "a leitura
    // falhou" (o collector publica `NaN` — `onboarding-expiry-collector.ts`,
    // "postura de falha" — e isso é detectável por réplica) e "a réplica sumiu
    // do /metrics" (não é, por esta regra).
    const cegaPublicaNaN: SeriesDb = {
      [BACKLOG]: [
        { labels: { instance: 'maia-0:3000', job: 'maia' }, value: Number.NaN },
        { labels: { instance: 'maia-1:3000', job: 'maia' }, value: 0 },
      ],
      [OLDEST]: [
        { labels: { instance: 'maia-0:3000', job: 'maia' }, value: Number.NaN },
        { labels: { instance: 'maia-1:3000', job: 'maia' }, value: 0 },
      ],
    };
    const out = evalInstant(expr(ABSENT), cegaPublicaNaN);
    expect(out, 'a réplica que publica `NaN` tem de acordar o guarda').toHaveLength(1);
    expect(out[0]!.labels.instance, 'o alerta tem de apontar a réplica cega, não a saudável').toBe(
      'maia-0:3000',
    );
  });

  // -------------------------------------------------------------------------
  // Cadência e escopo.
  // -------------------------------------------------------------------------

  it('warning é sustentado por 5 minutos', () => {
    expect(alerts().get(WARNING)?.for).toBe('5m');
  });

  it('critical NÃO tem `for` — os 1800s já são a sustentação', () => {
    // Decisão do dono, contra a interpretação que o primeiro corte trouxe. A
    // idade é monotônica enquanto a run não sai da fila, então "passou de
    // 1800s" só é alcançável por uma condição que durou 30 minutos: um `for`
    // aqui não filtra ruído, empurra o page para ~35m30s e faz a regra mentir
    // sobre o próprio nome. O tempo em que o WARNING já estava firing não
    // conta — são dois alertas independentes.
    expect(alerts().get(CRITICAL)?.for).toBeUndefined();
  });

  it('as severidades são as decididas', () => {
    expect(alerts().get(WARNING)?.labels?.severity).toBe('warning');
    expect(alerts().get(CRITICAL)?.labels?.severity).toBe('critical');
    expect(alerts().get(ABSENT)?.labels?.severity).toBe('warning');
  });

  it('nenhum alerta inventa rótulo de tenant/agente que a série não tem', () => {
    // `snapshotExpiryBacklog` é um agregado GLOBAL de housekeeping e devolve
    // SÓ números — nenhum `tenant_id`, nenhum `agent_id` atravessa a fronteira
    // (`src/db/repositories/onboarding-repos.ts`, e o mesmo desenho de
    // `maia_scheduler_backlog{queue}`). Um `by (tenant_id)` aqui referenciaria
    // um rótulo inexistente: a consulta devolve vazio e o alerta nunca dispara.
    for (const name of [WARNING, CRITICAL, ABSENT]) {
      expect(expr(name), `${name} referencia tenant_id`).not.toContain('tenant_id');
      expect(expr(name), `${name} referencia agent_id`).not.toContain('agent_id');
    }
  });

  it('nenhuma agregação SOMA as réplicas — isso multiplicaria o backlog', () => {
    // Mesma nota multi-réplica de `monitoring/alerts/slo.rules.yml`: gauge lida
    // no scrape sobre backend COMPARTILHADO agrega com `max`, nunca com `sum`.
    for (const name of [WARNING, CRITICAL, ABSENT]) {
      expect(expr(name), `${name} usa sum() sobre gauge compartilhada`).not.toMatch(/\bsum\s*\(/);
      expect(expr(name), `${name} usa avg() sobre gauge compartilhada`).not.toMatch(/\bavg\s*\(/);
    }
  });

  it('duas réplicas concordantes rendem UM alerta, não um por réplica', () => {
    const labelsA = { instance: 'maia-0:3000', job: 'maia' };
    const labelsB = { instance: 'maia-1:3000', job: 'maia' };
    const both: SeriesDb = {
      [BACKLOG]: [
        { labels: labelsA, value: 7 },
        { labels: labelsB, value: 7 },
      ],
      [OLDEST]: [
        { labels: labelsA, value: 900 },
        { labels: labelsB, value: 900 },
      ],
    };
    expect(evalInstant(expr(WARNING), both)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // O artefato não fica órfão.
  // -------------------------------------------------------------------------

  it('todo alerta aponta para um runbook e o runbook o nomeia', () => {
    const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
    for (const name of [WARNING, CRITICAL, ABSENT]) {
      const a = alerts().get(name)!;
      const text = JSON.stringify(a.annotations ?? {});
      expect(text, `${name} não aponta runbook`).toContain('docs/runbooks/');
      expect(runbook, `${name} não é narrado em docs/runbooks/onboarding-saga.md`).toContain(name);
    }
  });

  it('a prova temporal do `for:` está commitada e aponta para este arquivo', () => {
    // Sem isto, a afirmação "o `for:` é provado pelo promtool" seria um
    // comentário sem lastro: o arquivo poderia sumir e nada reprovaria.
    expect(
      existsSync(PROMTOOL_TEST_PATH),
      'monitoring/alerts/tests/onboarding.rules.test.yml não existe',
    ).toBe(true);
    const t = readFileSync(PROMTOOL_TEST_PATH, 'utf8');
    expect(t).toContain('onboarding.rules.yml');
    for (const name of [WARNING, CRITICAL]) expect(t).toContain(name);
  });
});

/**
 * O avaliador é infraestrutura de teste, e um avaliador errado é falso verde.
 * Este bloco fixa as três semânticas de que as asserções acima dependem,
 * conferidas contra `promtool test rules` v2.53.0.
 */
describe('promql-instant — as semânticas de que a suíte acima depende', () => {
  const l = { instance: 'i', job: 'j' };

  it('`max()` ignora `NaN` enquanto houver amostra finita', () => {
    const db: SeriesDb = { m: [{ labels: l, value: Number.NaN }, { labels: { instance: 'k', job: 'j' }, value: 4 }] };
    expect(evalInstant('max(m)', db)).toEqual([{ labels: {}, value: 4 }]);
  });

  it('comparação com `NaN` é falsa, e `x != x` é verdadeira', () => {
    const db: SeriesDb = { m: [{ labels: l, value: Number.NaN }] };
    expect(fires('m > 0', db)).toBe(false);
    expect(fires('m != m', db)).toBe(true);
  });

  it('`and` casa por conjunto de rótulos e devolve o lado esquerdo', () => {
    const db: SeriesDb = { a: [{ labels: l, value: 9 }], b: [{ labels: l, value: 2 }] };
    expect(evalInstant('a > 0 and b > 1', db)).toEqual([{ labels: l, value: 9 }]);
    expect(fires('a > 0 and b > 5', db)).toBe(false);
  });

  it('lança — em vez de devolver vazio — no que está fora do subconjunto', () => {
    // A propriedade que impede "não sei calcular" de virar "não disparou".
    expect(() => evalInstant('rate(m[5m]) > 0', {})).toThrow();
    expect(() => evalInstant('sum by (tenant_id) (m) > 0', {})).toThrow();
  });
});
