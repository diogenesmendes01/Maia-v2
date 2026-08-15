/**
 * Issue #519 — o backlog do `onboarding_expirer` como sinal de SCRAPE.
 *
 * As três propriedades que este coletor precisa ter, e que os casos abaixo
 * exigem uma a uma:
 *
 *   1. as duas séries existem no `/metrics` com os nomes da taxonomia e o valor
 *      lido da fonte;
 *   2. uma leitura que FALHA vira `NaN`, nunca `0` — "métrica ausente não é
 *      interpretada como zero saudável" (#514). Zero aqui diria "a fila está
 *      vazia" com base numa leitura que não aconteceu;
 *   3. um scrape faz UMA leitura, não uma por série.
 *
 * O caso que fecha o desenho é o último: o valor NÃO pode vir do worker. Uma
 * fila publicada por quem a drena congela no último número quando ele para, que
 * é exatamente a falha que a série existe para pegar.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerOnboardingExpiryGauges,
  _resetOnboardingExpiryCollectorForTests,
  type OnboardingExpiryBacklog,
} from '@/observability/onboarding-expiry-collector.js';
import { METRIC } from '@/observability/taxonomy.js';
import { _resetForTests, renderPrometheus } from '@/lib/metrics.js';
import { _resetLabelGuardForTests } from '@/observability/labels.js';
import { logger } from '@/lib/logger.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(logger.debug).mockClear();
  _resetForTests();
  _resetLabelGuardForTests();
  _resetOnboardingExpiryCollectorForTests();
});

/** Valor exposto para uma série SEM rótulo, como estas duas são. */
async function value(name: string): Promise<string | undefined> {
  for (const line of (await renderPrometheus()).split('\n')) {
    if (line.startsWith(`${name} `)) return line.slice(name.length + 1);
  }
  return undefined;
}

describe('issue #519 — coletor de backlog do onboarding_expirer', () => {
  it('expõe contagem e idade da mais atrasada com os nomes da taxonomia', async () => {
    registerOnboardingExpiryGauges(async () => ({ backlog: 240, oldest_age_seconds: 3600 }));

    expect(await value(METRIC.ONBOARDING_EXPIRY_BACKLOG)).toBe('240');
    expect(await value(METRIC.ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS)).toBe('3600');
  });

  it('fila vazia é 0 nas duas séries — e as séries continuam existindo', async () => {
    // Zero AQUI é um fato medido ("não há run vencida esperando"), e é
    // diferente do zero proibido do caso seguinte, que seria um fato NÃO
    // medido. Por isso as séries são sempre emitidas: uma série ausente e uma
    // fila vazia são indistinguíveis para o Prometheus.
    registerOnboardingExpiryGauges(async () => ({ backlog: 0, oldest_age_seconds: 0 }));

    expect(await value(METRIC.ONBOARDING_EXPIRY_BACKLOG)).toBe('0');
    expect(await value(METRIC.ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS)).toBe('0');
  });

  it('leitura que falha vira NaN, NUNCA 0', async () => {
    registerOnboardingExpiryGauges(async () => {
      throw new Error('connection terminated');
    });

    expect(await value(METRIC.ONBOARDING_EXPIRY_BACKLOG)).toBe('NaN');
    expect(await value(METRIC.ONBOARDING_EXPIRY_OLDEST_AGE_SECONDS)).toBe('NaN');
  });

  it('uma falha DERRUBA o valor anterior — não re-serve um backlog velho', async () => {
    // Diferença deliberada em relação a `turn-state-collector.ts`: uma CONTAGEM
    // velha de turnos é só velha; um backlog velho afirma ativamente "a fila
    // está sob controle" com números de antes do incidente.
    let fail = false;
    const source = async (): Promise<OnboardingExpiryBacklog> => {
      if (fail) throw new Error('connection terminated');
      return { backlog: 5, oldest_age_seconds: 60 };
    };
    registerOnboardingExpiryGauges(source);
    expect(await value(METRIC.ONBOARDING_EXPIRY_BACKLOG)).toBe('5');

    fail = true;
    // Reinstala a fonte com a janela zerada (o TTL do snapshot é curto em
    // produção; aqui o reset é o que torna o caso determinístico).
    _resetOnboardingExpiryCollectorForTests();
    registerOnboardingExpiryGauges(source);

    expect(await value(METRIC.ONBOARDING_EXPIRY_BACKLOG)).toBe('NaN');
  });

  /**
   * ANTI-ESPELHO. Todo caso acima registra o coletor por conta própria, então
   * todos continuariam VERDES se a fiação de produção sumisse — é a mesma
   * armadilha do teste que monta o próprio scheduler em vez de disparar pela
   * entrada do registry. Este caso passa por `registerRuntimeObservability()`,
   * o ponto único que `server.ts` chama no boot, e exige que as duas séries
   * existam depois. Apague a chamada de `src/observability/register.ts` e ele
   * fica vermelho.
   *
   * Vale COM ou SEM banco: o provider nunca lança, e uma leitura que falha
   * produz `NaN` — a série existe do mesmo jeito, que é justamente o contrato.
   */
  it('é fiado a partir de registerRuntimeObservability, o ponto de boot', async () => {
    _resetForTests();
    _resetOnboardingExpiryCollectorForTests();

    const { registerRuntimeObservability } = await import('@/observability/register.js');
    await registerRuntimeObservability();

    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_onboarding_expiry_backlog (\d+|NaN)$/m);
    expect(body).toMatch(/^maia_onboarding_expiry_oldest_age_seconds (\d+|NaN)$/m);
  }, 30_000);

  it('um scrape faz UMA leitura, mesmo com duas séries registradas', async () => {
    const source = vi.fn(async () => ({ backlog: 3, oldest_age_seconds: 30 }));
    registerOnboardingExpiryGauges(source);

    await renderPrometheus();

    // Duas gauges, uma query. Sem a janela compartilhada, cada provider
    // consultaria o banco por scrape.
    expect(source).toHaveBeenCalledTimes(1);
  });

  /**
   * Achado do review da PR #560. A janela do snapshot era
   * `snapshot !== null && ...`, ou seja, só valia no caminho FELIZ. Com a fonte
   * fora do ar o primeiro provider deixava `snapshot = null`, e como
   * `renderPrometheus()` avalia as gauges em sequência, o segundo entrava em
   * `refresh()` e consultava o banco DE NOVO — no mesmo scrape, duas queries
   * que já se sabiam condenadas. O caso "um scrape faz UMA leitura" acima não
   * pegava isso porque só exercitava sucesso.
   *
   * O ponto operacional: é durante a indisponibilidade do Postgres que a
   * amplificação dói mais.
   */
  it('um scrape que FALHA também faz UMA leitura só — a janela vale nos dois desfechos', async () => {
    const source = vi.fn(async (): Promise<OnboardingExpiryBacklog> => {
      throw new Error('connection terminated');
    });
    registerOnboardingExpiryGauges(source);

    const body = await renderPrometheus();

    expect(source).toHaveBeenCalledTimes(1);
    // E o fail-closed continua: a janela segura `NaN`, não um zero saudável.
    expect(body).toMatch(/^maia_onboarding_expiry_backlog NaN$/m);
    expect(body).toMatch(/^maia_onboarding_expiry_oldest_age_seconds NaN$/m);
  });

  /**
   * Achado do review da PR #560, e a razão é #533: este repositório já vazou
   * `DATABASE_URL` por stderr cru. A mensagem de uma falha de conexão carrega a
   * DSN inteira, e habilitar `debug` para investigar Postgres é EXATAMENTE
   * quando ela seria escrita.
   */
  /**
   * Round 2 do review da PR #560. A ordem das guardas em `refresh()` estava
   * invertida — TTL antes de `inFlight` —, então um scrape que chegasse com a
   * consulta do anterior ainda pendente via o TTL fresco e voltava na hora,
   * publicando o snapshot ANTERIOR (ou `NaN`, na primeira leitura) enquanto a
   * leitura corrente ainda corria.
   *
   * O caso exige as duas coisas que o desenho promete: UMA consulta, e o mesmo
   * resultado NOVO nas duas respostas. Sem a segunda asserção, uma
   * implementação que simplesmente devolvesse cedo também passaria.
   */
  it('dois scrapes CONCORRENTES fazem uma leitura só, e concordam no valor novo', async () => {
    let libera!: (v: OnboardingExpiryBacklog) => void;
    const pendente = new Promise<OnboardingExpiryBacklog>((resolve) => {
      libera = resolve;
    });
    const source = vi.fn(() => pendente);
    registerOnboardingExpiryGauges(source);

    // Os dois entram ANTES de a fonte responder — é essa janela que o defeito
    // atravessava.
    const a = renderPrometheus();
    const b = renderPrometheus();
    await Promise.resolve();
    libera({ backlog: 42, oldest_age_seconds: 900 });

    const [corpoA, corpoB] = await Promise.all([a, b]);

    expect(source, 'o segundo scrape furou o single-flight e consultou de novo').toHaveBeenCalledTimes(1);
    expect(
      corpoA,
      'o scrape A não enxergou a leitura que ele mesmo esperou',
    ).toMatch(/^maia_onboarding_expiry_backlog 42$/m);
    expect(
      corpoB,
      'o scrape B publicou valor velho (ou NaN) enquanto a leitura corrente ainda corria',
    ).toMatch(/^maia_onboarding_expiry_backlog 42$/m);
  });

  it('a falha logada não carrega credencial — DSN sai censurada', async () => {
    registerOnboardingExpiryGauges(async () => {
      throw new Error(
        'connect ECONNREFUSED postgres://maia_test:test1234@localhost:5432/maia_test',
      );
    });

    await renderPrometheus();

    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).not.toContain('test1234');
    expect(logged).not.toContain('postgres://');
    expect(logged).toContain('[REDACTED_URL]');
  });
});
