/**
 * A TRAVA DE EXECUÇÃO do drill da #705.
 *
 * A regra que este arquivo prende é uma só, e é dura: **nada em
 * `scripts/drill-migration-705.ts` pode abrir conexão sem um alvo DECLARADO.**
 * Não "não deveria" — não pode, e a impossibilidade é medida aqui, não
 * prometida num comentário.
 *
 * O modo de falha concreto: um script que lê `DATABASE_URL` do ambiente e roda,
 * num terminal onde alguém exportou staging meia hora antes por outro motivo.
 * O desenho certo é o oposto — alvo declarado, sem default, recusa fail-closed
 * quando ausente — e é isso que os casos abaixo fixam:
 *
 *   - a lista de obrigatórios é fixada INTEIRA (`['--fase','--alvo','--dsn-env']`).
 *     Dar default a qualquer um deles encurta a lista e reprova aqui;
 *   - `criarPool` é injetado e CONTADO. Toda recusa exige `chamadas === 0`:
 *     não basta sair não-zero, tem de sair sem ter conectado;
 *   - há um CONTROLE POSITIVO (`criarPool` chamado exatamente uma vez quando o
 *     alvo está declarado). Sem ele, um script que nunca conecta passaria em
 *     todos os outros casos e a suíte seria decorativa;
 *   - a matriz de ambiente poluído roda os mesmos casos com `DATABASE_URL`,
 *     `POSTGRES_URL`, `TEST_DB_URL` e `PGHOST` apontando para um "staging",
 *     porque é exatamente esse ambiente que o desenho tem de ignorar.
 *
 * Nada aqui abre socket: o pool é falso e o `fetch` é falso. Nenhum caso deste
 * arquivo tem como tocar staging, o que é o ponto.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ALVOS,
  FASES,
  FASES_QUE_ESCREVEM,
  NOMES_DE_ENV_AMBIENTE,
  AlvoIncoerenteError,
  AmbienteRecusadoError,
  RequiredArgsError,
  SegredoAusenteError,
  main,
  parseDrillArgs,
  resolverDsn,
  textoDoRoteiro,
  verificarCoerenciaDeAlvo,
  type DrillDeps,
  type PoolDoDrill,
} from '../../../scripts/drill-migration-705.js';

const RAIZ = process.cwd();

/** Um DSN que PARECE staging. Sintético — não aponta para nada que exista. */
const DSN_REMOTO = 'postgres://operador:trocar-isto@db.staging.invalido:5432/maia';
const DSN_LOCAL = 'postgres://maia:trocar-isto@127.0.0.1:5432/maia_drill';

interface Bancada {
  readonly deps: DrillDeps;
  readonly saida: string[];
  readonly erros: string[];
  readonly poolsCriados: () => number;
}

function bancada(env: Record<string, string | undefined> = {}): Bancada {
  const saida: string[] = [];
  const erros: string[] = [];
  let pools = 0;

  const poolFalso: PoolDoDrill = {
    connect: async () => ({
      query: async <R>() => ({ rows: [] as R[] }),
      release: () => undefined,
    }),
    end: async () => undefined,
  };

  const deps: DrillDeps = {
    env,
    log: (l) => saida.push(l),
    erro: (l) => erros.push(l),
    criarPool: () => {
      pools += 1;
      return poolFalso;
    },
    agora: () => new Date('2026-01-01T00:00:00.000Z'),
    raizDoRepo: RAIZ,
    baseTmp: '/tmp',
    buscar: async () => {
      throw new Error('o teste da trava nunca faz rede');
    },
  };

  return { deps, saida, erros, poolsCriados: () => pools };
}

/**
 * Os ambientes que este script tem de IGNORAR. Cada um simula um terminal de
 * operador que já apontava para algum lugar por outro motivo.
 */
const AMBIENTES_POLUIDOS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['limpo', {}],
  ['DATABASE_URL exportada', { DATABASE_URL: DSN_REMOTO }],
  ['POSTGRES_URL exportada', { POSTGRES_URL: DSN_REMOTO }],
  ['TEST_DB_URL exportada', { TEST_DB_URL: DSN_REMOTO }],
  ['PGHOST/PGDATABASE exportadas', { PGHOST: 'db.staging.invalido', PGDATABASE: 'maia' }],
  ['todas de uma vez', {
    DATABASE_URL: DSN_REMOTO,
    POSTGRES_URL: DSN_REMOTO,
    TEST_DB_URL: DSN_REMOTO,
    PGHOST: 'db.staging.invalido',
  }],
];

describe('drill #705 — o alvo é declarado, nunca herdado', () => {
  it('sem argumento nenhum, cobra os TRÊS obrigatórios — a lista inteira', () => {
    let capturado: RequiredArgsError | null = null;
    try {
      parseDrillArgs([]);
    } catch (err) {
      capturado = err as RequiredArgsError;
    }
    expect(capturado).toBeInstanceOf(RequiredArgsError);
    expect(capturado?.code).toBe('MISSING_REQUIRED_ARGS');
    // A lista é fixada INTEIRA de propósito. Um default em `--alvo` (ou em
    // qualquer um dos outros) encurta este array e reprova aqui — que é
    // exatamente o que a trava existe para pegar.
    expect(capturado?.missing).toEqual(['--fase', '--alvo', '--dsn-env']);
  });

  describe.each(AMBIENTES_POLUIDOS)('ambiente: %s', (_nome, env) => {
    it('sem --alvo e sem --dsn-env: sai 2 e NÃO cria pool', async () => {
      const b = bancada({ ...env });
      await expect(main([], b.deps)).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
    });

    it('com --fase e --alvo, mas sem --dsn-env: sai 2 e NÃO cria pool', async () => {
      const b = bancada({ ...env });
      await expect(main(['--fase=contexto', '--alvo=staging'], b.deps)).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
    });

    /**
     * O caso que um default em `--alvo` derruba de verdade: tudo o mais está
     * declarado e resolvível, então um default faria a corrida ACONTECER —
     * contra o alvo que o autor do default escolheu, não contra o que o
     * operador declarou.
     */
    it('com --fase e --dsn-env resolvíveis, mas SEM --alvo: sai 2 e NÃO cria pool', async () => {
      const b = bancada({ ...env, DRILL_705_DSN: DSN_REMOTO });
      await expect(
        main(['--fase=contexto', '--dsn-env=DRILL_705_DSN'], b.deps),
      ).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
    });

    /** O simétrico, para um default em `--dsn-env`. */
    it('com --fase e --alvo, mas SEM --dsn-env: sai 2 e NÃO cria pool, mesmo com DSNs no ambiente', async () => {
      const b = bancada({ ...env, DRILL_705_DSN: DSN_REMOTO });
      await expect(main(['--fase=contexto', '--alvo=staging'], b.deps)).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
    });

    it('com --dsn-env nomeando uma variável AUSENTE: sai 2 e NÃO cria pool', async () => {
      const b = bancada({ ...env });
      await expect(
        main(['--fase=contexto', '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps),
      ).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
      expect(b.erros.join('\n')).toContain('não está definida');
    });
  });

  it.each(NOMES_DE_ENV_AMBIENTE)('recusa --dsn-env=%s (nome ambiental)', async (nome) => {
    const b = bancada({ [nome]: DSN_REMOTO });
    await expect(
      main(['--fase=contexto', '--alvo=staging', `--dsn-env=${nome}`], b.deps),
    ).resolves.toBe(2);
    expect(b.poolsCriados()).toBe(0);
    expect(b.erros.join('\n')).toContain('variável AMBIENTAL');
  });

  it('recusa nome ambiental mesmo em caixa diferente', () => {
    expect(() => resolverDsn('database_url', { database_url: DSN_REMOTO })).toThrow(
      AmbienteRecusadoError,
    );
  });

  it('resolverDsn nunca cai em outra variável quando a declarada falta', () => {
    expect(() =>
      resolverDsn('DRILL_705_DSN', { DATABASE_URL: DSN_REMOTO, POSTGRES_URL: DSN_REMOTO }),
    ).toThrow(SegredoAusenteError);
  });

  it('resolverDsn recusa valor vazio (fail-closed, não "string vazia serve")', () => {
    expect(() => resolverDsn('DRILL_705_DSN', { DRILL_705_DSN: '   ' })).toThrow(
      SegredoAusenteError,
    );
  });
});

describe('drill #705 — o rótulo declarado tem de bater com o host', () => {
  it('--alvo=local apontando para fora desta máquina: sai 3, sem pool', async () => {
    const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
    await expect(
      main(['--fase=contexto', '--alvo=local', '--dsn-env=DRILL_705_DSN'], b.deps),
    ).resolves.toBe(3);
    expect(b.poolsCriados()).toBe(0);
  });

  it('--alvo=staging apontando para esta máquina: sai 3, sem pool', async () => {
    const b = bancada({ DRILL_705_DSN: DSN_LOCAL });
    await expect(
      main(['--fase=contexto', '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps),
    ).resolves.toBe(3);
    expect(b.poolsCriados()).toBe(0);
  });

  it('a coerência é checada nos DOIS sentidos', () => {
    expect(() => verificarCoerenciaDeAlvo('local', 'db.staging.invalido')).toThrow(
      AlvoIncoerenteError,
    );
    expect(() => verificarCoerenciaDeAlvo('staging', 'localhost')).toThrow(AlvoIncoerenteError);
    expect(() => verificarCoerenciaDeAlvo('local', '127.0.0.1')).not.toThrow();
    expect(() => verificarCoerenciaDeAlvo('staging', 'db.staging.invalido')).not.toThrow();
  });
});

describe('drill #705 — escrever exige autorização explícita', () => {
  it.each(FASES_QUE_ESCREVEM)('a fase "%s" sem --executar: sai 2, sem pool', async (fase) => {
    const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
    await expect(
      main([`--fase=${fase}`, '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps),
    ).resolves.toBe(2);
    expect(b.poolsCriados()).toBe(0);
  });

  it.each(FASES_QUE_ESCREVEM)(
    'a fase "%s" em staging com --executar mas sem --janela: sai 2, sem pool',
    async (fase) => {
      const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
      await expect(
        main(
          [`--fase=${fase}`, '--alvo=staging', '--dsn-env=DRILL_705_DSN', '--executar'],
          b.deps,
        ),
      ).resolves.toBe(2);
      expect(b.poolsCriados()).toBe(0);
    },
  );

  it('as fases que escrevem são exatamente `quebrar` e `reparar`', () => {
    expect([...FASES_QUE_ESCREVEM]).toEqual(['quebrar', 'reparar']);
    for (const fase of FASES_QUE_ESCREVEM) expect(FASES).toContain(fase);
  });
});

describe('drill #705 — controle positivo e sigilo do alvo', () => {
  /**
   * Sem este caso, um script que NUNCA conecta passaria em todos os anteriores.
   * Ele é o que impede a suíte de virar decoração.
   */
  it('com o alvo declarado, a fase de leitura ABRE exatamente um pool', async () => {
    const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
    const codigo = await main(
      [
        '--fase=contexto',
        '--alvo=staging',
        '--dsn-env=DRILL_705_DSN',
        `--saida=${join('/tmp', 'drill-705-spec-saida')}`,
      ],
      b.deps,
    );
    expect(codigo).toBe(0);
    expect(b.poolsCriados()).toBe(1);
  });

  it('a fase `roteiro` não abre pool nenhum, mesmo com o alvo declarado', async () => {
    const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
    await expect(
      main(['--fase=roteiro', '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps),
    ).resolves.toBe(0);
    expect(b.poolsCriados()).toBe(0);
    expect(b.saida.join('\n')).toContain('Ordem de execução da janela');
  });

  it('nenhuma saída ecoa o valor do DSN — nem o roteiro, nem as recusas', async () => {
    const b = bancada({ DRILL_705_DSN: DSN_REMOTO });
    await main(['--fase=roteiro', '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps);
    await main(['--fase=quebrar', '--alvo=staging', '--dsn-env=DRILL_705_DSN'], b.deps);
    const tudo = [...b.saida, ...b.erros].join('\n');
    expect(tudo).not.toContain('trocar-isto');
    expect(tudo).not.toContain(DSN_REMOTO);
    // o NOME da variável pode (e deve) aparecer; é o valor que não pode
    expect(tudo).toContain('DRILL_705_DSN');
  });

  it('o roteiro é texto, não execução: nada nele resolve o DSN', () => {
    const args = parseDrillArgs(['--fase=roteiro', '--alvo=staging', '--dsn-env=DRILL_705_DSN']);
    const linhas = textoDoRoteiro(args).join('\n');
    expect(linhas).not.toContain('trocar-isto');
    expect(linhas).toContain('--alvo=staging');
    expect(linhas).toContain('--dsn-env=DRILL_705_DSN');
  });
});

describe('drill #705 — o código-fonte não tem porta dos fundos', () => {
  it('não lê nenhuma variável de ambiente ambiental por nome próprio', async () => {
    const fonte = await readFile(join(RAIZ, 'scripts', 'drill-migration-705.ts'), 'utf8');
    // As únicas ocorrências permitidas destes nomes são a DENYLIST e a prosa que
    // a explica — nunca um `process.env.X` ou `env.X`.
    for (const nome of NOMES_DE_ENV_AMBIENTE) {
      expect(fonte).not.toMatch(new RegExp(`process\\.env\\.${nome}\\b`));
      expect(fonte).not.toMatch(new RegExp(`process\\.env\\[['"\`]${nome}`));
      expect(fonte).not.toMatch(new RegExp(`\\benv\\.${nome}\\b`));
      expect(fonte).not.toMatch(new RegExp(`\\benv\\[['"\`]${nome}`));
    }
  });

  it('os alvos e as fases são listas FECHADAS', () => {
    expect([...ALVOS]).toEqual(['local', 'staging']);
    expect([...FASES]).toEqual([
      'roteiro',
      'contexto',
      'quebrar',
      'verificar',
      'reparar',
      'sanitizar',
    ]);
  });
});
