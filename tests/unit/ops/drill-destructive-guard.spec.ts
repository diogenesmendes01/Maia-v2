import { describe, it, expect, beforeAll } from 'vitest';
import { TypedError } from '../../../src/lib/utils.js';

/**
 * Issue #536 — A GUARDA DESTRUTIVA.
 *
 * Um drill de restore é o único job que, por desenho, roda `CREATE DATABASE`,
 * `pg_restore -d …` e `DROP DATABASE … WITH (FORCE)` no MESMO cluster em que a
 * produção vive — é ali que o dump tem de aterrissar. A única coisa entre
 * "drill" e "incidente" é o nome do alvo.
 *
 * Antes desta fatia, o único portão era `assertSafeDatabaseName`, que responde
 * uma pergunta diferente e mais estreita: "esta string pode ser interpolada em
 * DDL sem levar uma aspa junto?". `assertSafeDatabaseName('maia')` PASSA, e
 * `maia` é produção. Um nome vindo de uma variável obsoleta, de uma linha lida
 * do banco ou de um refactor bastava para o `DROP DATABASE … WITH (FORCE)`
 * acertar o banco errado.
 *
 * ESTES TESTES BATEM NO PONTO DE CHAMADA REAL DE PRODUÇÃO. Eles importam
 * `createRestoreDrillPorts()` de `src/ops/backup/drill-adapters.ts` — o objeto
 * que o worker e o CLI usam — e chamam as portas destrutivas de verdade,
 * usando o `DATABASE_URL` real do processo como definição de "produção".
 * Nenhum banco é necessário: a recusa acontece ANTES de qualquer conexão, e é
 * exatamente essa ordem que estes testes fixam. Se a validação for afrouxada,
 * a chamada deixa de rejeitar e passa a tentar conectar — vermelho nos dois
 * casos, por motivos diferentes, o que também é a prova de que a guarda roda
 * antes do IO.
 */

type Ports = Awaited<
  ReturnType<typeof import('../../../src/ops/backup/drill-adapters.js')['createRestoreDrillPorts']>
>;

let ports: Ports;
let productionDatabase: string;
let productionUrl: string;
let assertDrillTarget: typeof import('../../../src/ops/backup/drill.js')['assertDrillTarget'];
let assertAdminTarget: typeof import('../../../src/ops/backup/drill.js')['assertAdminTarget'];
let drillDatabaseName: typeof import('../../../src/ops/backup/drill.js')['drillDatabaseName'];
let drillFailureCode: typeof import('../../../src/ops/backup/drill.js')['drillFailureCode'];

beforeAll(async () => {
  const adapters = await import('../../../src/ops/backup/drill-adapters.js');
  const drill = await import('../../../src/ops/backup/drill.js');
  const { config } = await import('../../../src/config/env.js');
  ports = adapters.createRestoreDrillPorts();
  productionUrl = config.DATABASE_URL;
  productionDatabase = new URL(config.DATABASE_URL).pathname.replace(/^\//, '');
  assertDrillTarget = drill.assertDrillTarget;
  assertAdminTarget = drill.assertAdminTarget;
  drillDatabaseName = drill.drillDatabaseName;
  drillFailureCode = drill.drillFailureCode;
  // Sanity: sem um nome de banco de produção legível, os testes abaixo estariam
  // provando o caso trivial em vez do caso perigoso.
  expect(productionDatabase.length).toBeGreaterThan(0);
});

async function refusal(op: Promise<unknown>): Promise<TypedError> {
  const err = await op.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) throw new Error('a operação destrutiva NÃO recusou — ela seguiu adiante');
  return err as TypedError;
}

describe('guarda destrutiva — o alvo é o banco de PRODUÇÃO', () => {
  it('dropDatabase recusa o banco configurado como produção, antes de qualquer conexão', async () => {
    const err = await refusal(ports.dropDatabase(productionDatabase));
    expect(err.code).toBe('drill_target_is_production');
  });

  it('createIsolatedDatabase recusa o banco de produção', async () => {
    const err = await refusal(ports.createIsolatedDatabase(productionDatabase));
    expect(err.code).toBe('drill_target_is_production');
  });

  it('restore recusa restaurar POR CIMA da produção, sem chegar ao pg_restore', async () => {
    // Se a guarda não estivesse no caminho, este `pg_restore -d <produção>`
    // seria lançado contra o banco vivo com um arquivo que nem existe: o
    // primeiro efeito seria a conexão, não um erro de arquivo.
    const err = await refusal(ports.restore(productionDatabase, '/nao/existe.dump'));
    expect(err.code).toBe('drill_target_is_production');
  });

  it('runProbes recusa abrir cliente contra a produção', async () => {
    const err = await refusal(ports.runProbes(productionDatabase, { drill_id: 'x' }));
    expect(err.code).toBe('drill_target_is_production');
  });

  it('databaseExists recusa consultar o catálogo em nome de um alvo de produção', async () => {
    // Read-only, mas o nome vem do mesmo lugar que os destrutivos; deixar esta
    // porta fora da guarda ensinaria que "o nome de produção é aceitável aqui".
    const err = await refusal(ports.databaseExists(productionDatabase));
    expect(err.code).toBe('drill_target_is_production');
  });
});

describe('guarda destrutiva — namespace', () => {
  it('recusa um nome digitado à mão que apenas CONTÉM o marcador', async () => {
    // `maia_drill_prod` passa em `assertSafeDatabaseName` e contém `_drill_`.
    // Só a forma completa que `drillDatabaseName` emite é aceita.
    const err = await refusal(ports.dropDatabase('maia_drill_prod'));
    expect(err.code).toBe('drill_target_not_namespaced');
  });

  it('recusa um nome de banco arbitrário do cluster', async () => {
    const err = await refusal(ports.dropDatabase('analytics'));
    expect(err.code).toBe('drill_target_not_namespaced');
  });

  it('recusa a maintenance database pelo que ela É, não pelo formato do nome', async () => {
    const err = await refusal(ports.dropDatabase('postgres'));
    expect(err.code).toBe('drill_target_is_reserved');
  });

  it('recusa os templates do cluster', async () => {
    for (const name of ['template0', 'template1']) {
      const err = await refusal(ports.dropDatabase(name));
      expect(err.code).toBe('drill_target_is_reserved');
    }
  });

  it('recusa um nome que nem é identificador legal', async () => {
    const err = await refusal(ports.dropDatabase('maia"; DROP DATABASE maia; --'));
    expect(err.code).toBe('unsafe_drill_database_name');
  });

  it('ACEITA o nome que o próprio módulo cunha — a guarda não é vacuosa', () => {
    const name = drillDatabaseName('maia', new Date('2026-08-24T03:00:00.000Z'), 'a1b2c3d4-e5f6');
    expect(assertDrillTarget(name, productionUrl)).toBe(name);
  });
});

describe('guarda destrutiva — falha fechado quando não dá para validar', () => {
  it('recusa quando o URL de produção não é parseável', () => {
    const name = drillDatabaseName('maia', new Date('2026-08-24T03:00:00.000Z'), 'a1b2c3d4');
    expect(() => assertDrillTarget(name, 'nao-e-uma-url')).toThrow(
      expect.objectContaining({ code: 'drill_target_unverifiable' }),
    );
  });

  it('recusa quando o URL de produção não carrega banco nenhum', () => {
    const name = drillDatabaseName('maia', new Date('2026-08-24T03:00:00.000Z'), 'a1b2c3d4');
    expect(() => assertDrillTarget(name, 'postgres://u:p@h:5432/')).toThrow(
      expect.objectContaining({ code: 'drill_target_unverifiable' }),
    );
  });

  it('recusa quando não há URL de produção nenhum', () => {
    const name = drillDatabaseName('maia', new Date('2026-08-24T03:00:00.000Z'), 'a1b2c3d4');
    expect(() => assertDrillTarget(name, undefined)).toThrow(
      expect.objectContaining({ code: 'drill_target_unverifiable' }),
    );
  });

  it('a ordem das checagens nomeia o pior fato verdadeiro sobre o alvo', () => {
    // `maia` é, ao mesmo tempo, "não cunhado por este módulo" e "o banco de
    // produção". O código registrado tem de ser o segundo — é ele que vai para
    // `restore_drills`, para o alerta e para o label da métrica.
    expect(() => assertDrillTarget('maia', 'postgres://u:p@h:5432/maia')).toThrow(
      expect.objectContaining({ code: 'drill_target_is_production' }),
    );
  });
});

describe('guarda destrutiva — a CONEXÃO em que o DDL roda', () => {
  it('recusa um host diferente do que este processo está configurado para usar', () => {
    expect(() =>
      assertAdminTarget('postgres://u:p@outro-host:5432/postgres', 'postgres://u:p@h:5432/maia'),
    ).toThrow(expect.objectContaining({ code: 'drill_admin_target_foreign_host' }));
  });

  it('recusa uma porta diferente no mesmo host', () => {
    expect(() =>
      assertAdminTarget('postgres://u:p@h:6432/postgres', 'postgres://u:p@h:5432/maia'),
    ).toThrow(expect.objectContaining({ code: 'drill_admin_target_foreign_host' }));
  });

  it('recusa rodar DDL numa conexão que aponta para o próprio banco de produção', () => {
    expect(() =>
      assertAdminTarget('postgres://u:p@h:5432/maia', 'postgres://u:p@h:5432/maia'),
    ).toThrow(expect.objectContaining({ code: 'drill_admin_target_not_maintenance' }));
  });

  it('recusa quando não dá para comparar as duas conexões', () => {
    expect(() => assertAdminTarget('postgres://u:p@h:5432/postgres', 'lixo')).toThrow(
      expect.objectContaining({ code: 'drill_admin_target_unverifiable' }),
    );
  });

  it('aceita a maintenance database no mesmo host', () => {
    const url = 'postgres://u:p@h:5432/postgres';
    expect(assertAdminTarget(url, 'postgres://u:p@h:5432/maia')).toBe(url);
  });
});

describe('guarda destrutiva — a recusa vira evidência, não morte anônima', () => {
  it('todo código da guarda mapeia para isolation_failed', () => {
    for (const code of [
      'drill_target_not_namespaced',
      'drill_target_unverifiable',
      'drill_target_is_production',
      'drill_target_is_reserved',
      'drill_admin_target_unverifiable',
      'drill_admin_target_foreign_host',
      'drill_admin_target_not_maintenance',
    ]) {
      expect(drillFailureCode(new TypedError(code, 'x'))).toBe('isolation_failed');
    }
  });

  it('a mensagem de recusa não carrega o URL de conexão', async () => {
    const err = await refusal(ports.dropDatabase(productionDatabase));
    expect(err.message).not.toContain('@');
    expect(JSON.stringify(err.details ?? {})).not.toContain('@');
  });
});
