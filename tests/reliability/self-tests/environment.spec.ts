/**
 * Issue #510 — self-tests do `ReliabilityEnvironment`, com foco na TRANCA da
 * faxina.
 *
 * ─── Por que a tranca é a parte que precisa de teste ─────────────────────────
 *
 * `DROP DATABASE` e `DEL` em massa são as duas operações deste repositório com
 * potencial de destruir trabalho alheio: ~60 worktrees compartilham o MESMO
 * Postgres e o MESMO Redis. Um bug no alvo da faxina não aparece como teste
 * vermelho — aparece como a rodada de outro agente sumindo no meio.
 *
 * ─── Por que estes casos rodam SEM Postgres ──────────────────────────────────
 *
 * A tranca é uma função pura sobre a URL e o prefixo. Isso é deliberado: a
 * garantia mais perigosa do harness fica provável numa máquina sem infra
 * nenhuma, e a prova roda na lane padrão (`npm test`), em todo PR — não só no
 * job que tem banco.
 *
 * O ciclo de vida COM banco (criar, migrar, semear, derrubar) fica no bloco
 * final, condicionado a `TEST_DB_URL`. Sem banco ele é `skip` — e `pulado` não
 * é `passou`.
 */
import { describe, expect, it } from 'vitest';
import {
  AlvoDestrutivoInvalidoError,
  HOSTS_PERMITIDOS_ENV,
  MARCADOR_DE_BANCO,
  PREFIXO_DE_FILA,
  ReliabilityEnvironment,
  assertAlvoDestrutivo,
  nomeDeBancoDaSuite,
  prefixoDeFilaDaSuite,
  resolverAlvoDaSuite,
  suiteSlug,
} from '../harness/environment.js';
import { assertIntegrationDeps } from '../../helpers/integrationSetup.js';

const ALVO_VALIDO = {
  databaseUrl: 'postgres://maia_test:test1234@localhost:5432/maia_test_wt_x_fi_selftest',
  queuePrefix: 'fi_selftest',
};

describe('#510 harness — nomes de banco e prefixo de fila', () => {
  it('o slug reduz a [a-z0-9_] e recusa nome sem caractere utilizável', () => {
    expect(suiteSlug('FI-04 corrida de claim')).toBe('fi_04_corrida_de_claim');
    expect(() => suiteSlug('---')).toThrow(/sem caractere utilizável/);
  });

  it('o nome do banco carrega o marcador e cabe no limite de 63 bytes do Postgres', () => {
    const nome = nomeDeBancoDaSuite('maia_test', 'fi-04');
    expect(nome).toBe(`maia_test${MARCADOR_DE_BANCO}fi_04`);
    expect(nome).toMatch(/^[a-z0-9_]+$/);

    // Um identificador acima de 63 bytes o Postgres TRUNCA em silêncio — e um
    // nome truncado pode perder o marcador, que é justamente o que a tranca
    // exige. Truncamos nós, com o marcador preservado.
    const longo = nomeDeBancoDaSuite('a'.repeat(80), 'fi-25-isolamento-adversar');
    expect(longo.length).toBeLessThanOrEqual(63);
    expect(longo).toContain(MARCADOR_DE_BANCO);
  });

  it('o prefixo de fila é `fi_<slug>`', () => {
    expect(prefixoDeFilaDaSuite('FI-10 fifo')).toBe(`${PREFIXO_DE_FILA}fi_10_fifo`);
  });

  it('resolver o alvo da suíte não toca em nada e é consistente consigo mesmo', () => {
    const a = resolverAlvoDaSuite('fi-self');
    const b = resolverAlvoDaSuite('fi-self');
    expect(a).toEqual(b);
    expect(a.databaseName).toContain(MARCADOR_DE_BANCO);
    expect(a.queuePrefix).toBe('fi_fi_self');
    expect(a.databaseUrl).toContain(a.databaseName);
    // E o alvo que ele resolve passa na tranca — senão o harness criaria um
    // banco que a própria faxina não conseguiria derrubar.
    expect(() =>
      assertAlvoDestrutivo(
        { databaseUrl: a.databaseUrl, queuePrefix: a.queuePrefix },
        { NODE_ENV: 'test' },
      ),
    ).not.toThrow();
  });
});

describe('#510 harness — a faxina VALIDA database e queue prefix antes de agir', () => {
  it('aceita o alvo legítimo (CONTROLE)', () => {
    // Sem este caso, "recusa" passaria também numa tranca que recusa tudo.
    expect(() => assertAlvoDestrutivo(ALVO_VALIDO, { NODE_ENV: 'test' })).not.toThrow();
  });

  it('RECUSA banco sem o marcador do harness', () => {
    // O caso perigoso de verdade: o banco compartilhado da worktree, que é
    // exatamente o que uma variável de ambiente mal resolvida entregaria.
    const erro = capturar(() =>
      assertAlvoDestrutivo(
        { databaseUrl: 'postgres://u:p@localhost:5432/maia_test_wt_outro', queuePrefix: 'fi_x' },
        { NODE_ENV: 'test' },
      ),
    );
    expect(erro).toBeInstanceOf(AlvoDestrutivoInvalidoError);
    expect((erro as Error).message).toContain(MARCADOR_DE_BANCO);
    expect((erro as AlvoDestrutivoInvalidoError).motivos.join(' ')).toContain('marcador');
  });

  it('RECUSA os bancos que nunca são alvo, mesmo que alguém fabrique o marcador', () => {
    for (const nome of ['postgres', 'maia', 'maia_prod', 'template1']) {
      expect(() =>
        assertAlvoDestrutivo(
          { databaseUrl: `postgres://u:p@localhost:5432/${nome}`, queuePrefix: 'fi_x' },
          { NODE_ENV: 'test' },
        ),
      ).toThrow(AlvoDestrutivoInvalidoError);
    }
  });

  it('RECUSA host fora da lista, e a lista é ampliável por env de prefixo neutro', () => {
    const remoto = {
      databaseUrl: 'postgres://u:p@db.producao.interno:5432/qualquer_fi_x',
      queuePrefix: 'fi_x',
    };
    expect(() => assertAlvoDestrutivo(remoto, { NODE_ENV: 'test' })).toThrow(/não está na lista/);
    expect(() =>
      assertAlvoDestrutivo(remoto, {
        NODE_ENV: 'test',
        [HOSTS_PERMITIDOS_ENV]: 'db.producao.interno',
      }),
    ).not.toThrow();
  });

  it('RECUSA prefixo de fila largo — a faxina do Redis é por prefixo', () => {
    // Um prefixo largo (`bull`, `maia`, vazio) apagaria a fila de outra árvore
    // no MESMO db lógico do Redis. Este é o incidente que o `vitest.config.ts`
    // já documenta ter acontecido com resíduo de `bull:agent:*`.
    for (const prefixo of ['', 'bull', 'maia', 'fi', 'fi-x', 'FI_X', '*']) {
      const erro = capturar(() =>
        assertAlvoDestrutivo({ ...ALVO_VALIDO, queuePrefix: prefixo }, { NODE_ENV: 'test' }),
      );
      expect(erro, `prefixo "${prefixo}" deveria ter sido recusado`).toBeInstanceOf(
        AlvoDestrutivoInvalidoError,
      );
      expect((erro as Error).message).toContain('prefixo de fila');
    }
  });

  it('RECUSA em perfil de produção, sem opt-out', () => {
    for (const producao of [{ MAIA_ENV: 'production' }, { NODE_ENV: 'production' }]) {
      expect(() => assertAlvoDestrutivo(ALVO_VALIDO, producao)).toThrow(/perfil de produção/);
    }
  });

  it('a mensagem de recusa acumula TODOS os motivos, não só o primeiro', () => {
    // Corrigir um motivo de cada vez, com uma rodada de teste entre eles, é
    // como um alvo errado passa despercebido.
    const erro = capturar(() =>
      assertAlvoDestrutivo(
        { databaseUrl: 'postgres://u:p@db.remoto:5432/producao', queuePrefix: 'bull' },
        { MAIA_ENV: 'production' },
      ),
    ) as AlvoDestrutivoInvalidoError;
    expect(erro.motivos.length).toBeGreaterThanOrEqual(3);
  });

  it('RECUSA URL ilegível em vez de assumir default', () => {
    expect(() =>
      assertAlvoDestrutivo({ databaseUrl: 'nao-e-url', queuePrefix: 'fi_x' }, { NODE_ENV: 'test' }),
    ).toThrow(/não é uma URL válida/);
  });
});

const TEM_BANCO = !!process.env.TEST_DB_URL;
const d = TEM_BANCO ? describe : describe.skip;

d('#510 harness — ciclo de vida do ambiente (exige Postgres + Redis)', () => {
  it('cria, migra, semeia tenants explícitos e derruba de forma IDEMPOTENTE', async () => {
    await assertIntegrationDeps();
    const ambiente = await ReliabilityEnvironment.criar({ suite: 'fi-selftest-ciclo' });
    try {
      expect(ambiente.estado.databaseName).toContain(MARCADOR_DE_BANCO);
      expect(ambiente.estado.queuePrefix).toMatch(/^fi_/);
      // Tenants EXPLÍCITOS e distintos — nenhum cenário depende do literal
      // `default`, que os caminhos de produção rejeitam.
      expect(ambiente.estado.tenants).toHaveLength(2);
      expect(ambiente.estado.tenants[0]?.tenantId).not.toBe(ambiente.estado.tenants[1]?.tenantId);
      for (const t of ambiente.estado.tenants) {
        expect(t.tenantId).not.toBe('default');
        expect(t.agentId).not.toBe('default');
      }

      const pg = (await import('pg')).default;
      const cliente = new pg.Client({ connectionString: ambiente.estado.databaseUrl });
      await cliente.connect();
      try {
        const { rows } = await cliente.query(
          'SELECT id FROM tenants WHERE id = ANY($1::text[]) ORDER BY id',
          [ambiente.estado.tenants.map((t) => t.tenantId)],
        );
        expect(rows).toHaveLength(2);
        const { rows: migrations } = await cliente.query('SELECT count(*)::int AS n FROM schema_migrations');
        expect(migrations[0].n).toBeGreaterThan(50);
      } finally {
        await cliente.end();
      }

      // O env que o filho recebe aponta para ESTE ambiente, não para o da
      // worktree — senão dois cenários dividiriam banco.
      const envFilho = ambiente.envDoFilho();
      expect(envFilho.DATABASE_URL).toBe(ambiente.estado.databaseUrl);
      expect(envFilho.TEST_RELIABILITY_QUEUE_PREFIX).toBe(ambiente.estado.queuePrefix);
    } finally {
      await ambiente.derrubar();
      // Teardown IDEMPOTENTE: a segunda chamada é no-op, não erro.
      await expect(ambiente.derrubar()).resolves.toBeUndefined();
    }
  }, 300_000);
});

function capturar(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}
