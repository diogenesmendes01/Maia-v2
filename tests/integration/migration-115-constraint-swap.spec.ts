/**
 * Migration 115 (`pending_race_lost`) contra Postgres REAL — as duas garantias
 * que os arquivos SQL afirmam, aferidas nos arquivos DE VERDADE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo guarda
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **O `_down` é tudo-ou-nada.** Ele declara que FALHA quando já existe turno
 *    com `outcome = 'pending_race_lost'` — e falhar é o comportamento certo.
 *    Mas a versão anterior era `DROP CONSTRAINT` + `ADD CONSTRAINT` soltos, e o
 *    procedimento canônico de rollback (`docs/runbooks/migrations.md`) roda
 *    downs com `psql -v ON_ERROR_STOP=1 -f`, statement a statement. O `DROP`
 *    commitava, o `ADD` falhava, e o rollback que "falha de propósito" deixava
 *    `agent_turns` SEM `agent_turns_status_outcome_chk`: falhar removendo em
 *    silêncio a compatibilidade estado/outcome é pior que não falhar. Aqui se
 *    afere o exit code E a constraint (`pg_get_constraintdef`), porque só o
 *    primeiro passaria com a tabela desprotegida.
 *
 * 2. **A validação do `_up` não corre sob ACCESS EXCLUSIVE.** O comentário da
 *    primeira versão prometia isso (`ADD … NOT VALID` + `VALIDATE`) e não
 *    entregava: sem marker o arquivo roda no modo `runner`, que envolve o
 *    arquivo INTEIRO num `BEGIN`/`COMMIT` — o ACCESS EXCLUSIVE do `DROP` fica
 *    retido e a varredura do `VALIDATE` acontece debaixo dele. Aqui a garantia
 *    é aferida do único jeito que não é opinião: um SEGUNDO cliente tenta
 *    ESCREVER em `agent_turns` no exato momento em que a validação está em
 *    curso, com `lock_timeout` — se a sessão da migration estiver segurando
 *    ACCESS EXCLUSIVE, essa escrita morre em `55P03` (`lock_not_available`).
 *    Determinístico: `lock_timeout` é um prazo duro, não uma janela de sorte.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que NÃO se monta o SQL aqui dentro
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha é o espelho: um teste que escreve o próprio `ALTER TABLE` afere a
 * si mesmo e continua verde com o arquivo entregue quebrado. Então TODO o SQL
 * vem de `migrations/` pelo `discoverMigrations` de produção
 * (`src/migrations/discover.ts`), inclusive o estado inicial da tabela — a
 * constraint estreita da 097 é instalada rodando o `_down` REAL, não uma cópia.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que statement a statement, e nunca `client.query(arquivoInteiro)`
 * ─────────────────────────────────────────────────────────────────────────
 * `node-postgres` envolve um `query()` multi-statement num BEGIN/COMMIT
 * IMPLÍCITO. Mandar o `_down` inteiro numa chamada só o tornaria atômico mesmo
 * SEM `BEGIN`/`COMMIT` no arquivo — o defeito ficaria invisível e o teste,
 * verde pela razão errada. `psql -f` não faz isso: manda um statement por vez.
 * `runLikePsql` reproduz exatamente esse protocolo, usando o tokenizador de
 * produção (`splitTopLevelStatements`, que entende comentários, literais e
 * corpos `$$…$$`) e parando no primeiro erro, que é o `ON_ERROR_STOP=1`.
 *
 * Isolamento: schema dedicado por execução (`search_path`), como
 * `migrations-runner-real-db.spec.ts`. O `agent_turns` real da base de teste —
 * compartilhada entre worktrees — nunca é tocado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  discoverMigrations,
  downSiblingOf,
  splitNoTxStatements,
  splitTopLevelStatements,
} from '@/migrations/discover.js';
import { terminalLedgerStatusFor } from '@/migrations/runner.js';
import type { DiscoveredMigration, MigrationArtifact } from '@/migrations/types.js';

/**
 * Mesmo portão de todo spec de banco real daqui: `TEST_DB_URL` e nada mais.
 * `DATABASE_URL` não serve de fallback — `tests/setup.ts` o define
 * incondicionalmente, e a suíte só-unit tentaria conectar.
 */
const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

const UP_ID = '115_agent_turns_pending_race_lost.sql';
/** Derivado pela função de produção — o par `_up`/`_down` é regra, não convenção local. */
const DOWN_ID = downSiblingOf(UP_ID);
const CHK = 'agent_turns_status_outcome_chk';
const CHK_TMP = 'agent_turns_status_outcome_chk_v115';

/** Schema único por execução, para workers paralelos não colidirem. */
const SCHEMA = `maia_mig115_${Math.random().toString(36).slice(2, 10)}`;

let admin: pg.Pool;
let pool: pg.Pool;
let artifact: MigrationArtifact;
let up: DiscoveredMigration;
/** Conteúdo do `_down` REAL, lido do disco pelo mesmo discovery. */
let downSql: string;

/**
 * `psql -v ON_ERROR_STOP=1 -f <arquivo>`: um statement por vez, na MESMA
 * conexão (para que um `BEGIN;` do arquivo valha para os seguintes), parando no
 * primeiro erro. Devolve o erro em vez de lançar, para o teste poder afirmar
 * sobre ele.
 */
async function runLikePsql(
  client: pg.PoolClient,
  sql: string,
): Promise<{ ok: true } | { ok: false; index: number; message: string; code: string | null }> {
  const stmts = splitTopLevelStatements(sql);
  for (let i = 0; i < stmts.length; i++) {
    try {
      await client.query(stmts[i]!);
    } catch (err) {
      // `psql` para aqui. A sessão fica em transação abortada quando o arquivo
      // tinha `BEGIN;` — desfaz, que é o que o operador faria (e o que o
      // `\q` do psql faz por ele) antes de olhar o banco.
      await client.query('ROLLBACK').catch(() => undefined);
      return {
        ok: false,
        index: i,
        message: (err as Error).message,
        code: ((err as { code?: string }).code ?? null) as string | null,
      };
    }
  }
  return { ok: true };
}

/** Constraints CHECK de `<SCHEMA>.agent_turns`, como o banco as vê. */
async function constraints(
  client: pg.PoolClient | pg.Pool,
): Promise<{ name: string; validated: boolean; def: string }[]> {
  const r = await client.query<{ conname: string; convalidated: boolean; def: string }>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND contype = 'c'
      ORDER BY conname`,
    [`${SCHEMA}.agent_turns`],
  );
  return r.rows.map((x) => ({ name: x.conname, validated: x.convalidated, def: x.def }));
}

/** Só a constraint canônica, ou `null` — o que o achado nº 1 quer olhar. */
async function canonical(
  client: pg.PoolClient | pg.Pool,
): Promise<{ name: string; validated: boolean; def: string } | null> {
  return (await constraints(client)).find((c) => c.name === CHK) ?? null;
}

/**
 * Estado inicial: a tabela mínima que as constraints da 115 tocam, com a
 * constraint ESTREITA da 097 instalada rodando o `_down` REAL. Assim nem o
 * ponto de partida é escrito à mão aqui.
 */
async function seedNarrow(client: pg.PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.agent_turns`);
  await client.query(
    `CREATE TABLE ${SCHEMA}.agent_turns (
       id bigserial PRIMARY KEY,
       status text NOT NULL,
       outcome text
     )`,
  );
  const res = await runLikePsql(client, downSql);
  if (!res.ok) throw new Error(`seed pelo _down falhou no statement ${res.index}: ${res.message}`);
}

type ValidateProbe = {
  /** Modo de transação DESCOBERTO no arquivo — decide como ele é executado. */
  mode: DiscoveredMigration['transactionMode'];
  /** Locks que a sessão da migration segurava em `agent_turns` no `VALIDATE`. */
  locks: string[];
  /** `'ok'` = a escrita concorrente passou; senão o SQLSTATE que a matou. */
  concurrent_write: string;
};

/**
 * Aplica o `_up` REAL **do jeito que o runner aplicaria** — é isso que faz a
 * sonda morder: se o marker `maia:no-transaction` sumir, o modo vira `runner`,
 * o arquivo inteiro passa a rodar dentro de um `BEGIN` e a escrita concorrente
 * morre no `lock_timeout`.
 *
 * No modo `none` o `VALIDATE` roda em autocommit e seus locks somem antes de
 * qualquer observação ser possível, então ele — e só ele — é envolvido num
 * `BEGIN` explícito. Isso não muda os locks que o `VALIDATE` toma; só os
 * mantém visíveis pelo tempo da medição. O que a sonda mede é o que a sessão
 * segurava ALÉM deles, vindo dos statements anteriores.
 */
async function applyUpObservingValidate(
  a: pg.PoolClient,
  w: pg.PoolClient,
): Promise<ValidateProbe> {
  const mode = up.transactionMode;
  const stmts = mode === 'none' ? splitNoTxStatements(up.sql) : splitTopLevelStatements(up.sql);
  const pid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let probe: Omit<ValidateProbe, 'mode'> | null = null;

  if (mode !== 'none') await a.query('BEGIN');
  for (const stmt of stmts) {
    const isValidate = /VALIDATE\s+CONSTRAINT/i.test(stmt);
    if (isValidate && mode === 'none') await a.query('BEGIN');
    await a.query(stmt);
    if (isValidate) {
      const locks = (
        await w.query<{ mode: string }>(
          `SELECT mode FROM pg_locks
            WHERE pid = $1 AND relation = to_regclass($2)
            ORDER BY mode`,
          [pid, `${SCHEMA}.agent_turns`],
        )
      ).rows.map((r) => r.mode);

      // A prova. SHARE UPDATE EXCLUSIVE (o lock do VALIDATE) NÃO conflita com
      // ROW EXCLUSIVE (o lock de um INSERT); ACCESS EXCLUSIVE conflita com
      // tudo. Então esta escrita passa se, e só se, a varredura não estiver
      // acontecendo debaixo do lock forte.
      let concurrent_write = 'ok';
      try {
        await w.query(`SET lock_timeout = '2s'`);
        await w.query(
          `INSERT INTO ${SCHEMA}.agent_turns(status, outcome) VALUES ('completed', 'reply_delivered')`,
        );
      } catch (err) {
        concurrent_write = ((err as { code?: string }).code ?? 'unknown') as string;
      } finally {
        await w.query(`SET lock_timeout = 0`).catch(() => undefined);
      }
      probe = { locks, concurrent_write };
      if (mode === 'none') await a.query('COMMIT');
    }
  }
  if (mode !== 'none') await a.query('COMMIT');

  if (!probe) throw new Error('nenhum statement de VALIDATE CONSTRAINT no _up — sonda cega');
  return { mode, ...probe };
}

d('migration 115 — troca de CHECK em agent_turns (#570)', () => {
  beforeAll(async () => {
    artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    const found = artifact.byId.get(UP_ID);
    if (!found) throw new Error(`${UP_ID} não está em migrations/`);
    up = found;
    // O artefato prova que o par existe (AGENTS.md §4 regra 6), mas não carrega
    // o conteúdo do `_down`: o runner nunca o executa. Então este é o único
    // ponto onde um arquivo é lido direto — ainda do repositório, nunca de uma
    // cópia embutida aqui.
    expect(up.hasDownSibling, `${UP_ID} sem sibling _down`).toBe(true);
    downSql = await readFile(join(process.cwd(), 'migrations', DOWN_ID), 'utf8');

    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 4,
      options: `-c search_path=${SCHEMA}`,
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await seedNarrow(c);
    } finally {
      c.release();
    }
  });

  // ── Achado nº 2 — a garantia de lock que o comentário afirma ───────────────

  it('o _up declara maia:no-transaction, e é isso que separa as fases em commits', () => {
    // Sem o marker o runner envolve o arquivo INTEIRO num BEGIN/COMMIT
    // (`src/migrations/runner.ts`, modo `runner`) e as três fases voltam a ser
    // uma transação só — que é exatamente o defeito do achado nº 2.
    expect(up.transactionMode, `${UP_ID}: modo de transação`).toBe('none');
    expect(up.noTransaction).toBe(true);
    // E o diagnóstico do runner segue honesto: uma falha limpa num arquivo
    // `none` é `dirty` (nunca reaplicada sozinha), não `failed` (auto-retry).
    expect(terminalLedgerStatusFor(up)).toBe('dirty');
  });

  it('a validação do _up NÃO segura ACCESS EXCLUSIVE: escrita concorrente passa', async () => {
    const a = await pool.connect();
    const w = await pool.connect();
    try {
      const probe = await applyUpObservingValidate(a, w);
      expect(
        probe,
        'A varredura do VALIDATE estava correndo com a tabela sob ACCESS EXCLUSIVE — ' +
          'exatamente o que o comentário do arquivo diz ter evitado. Em `agent_turns`, ' +
          'documentada como tabela quente, isso bloqueia escrita pelo tempo inteiro da ' +
          'validação. `concurrent_write` traz o SQLSTATE que matou a escrita ' +
          '(55P03 = lock_not_available, o `lock_timeout` de 2s estourando) e `locks` traz ' +
          'os locks que a sessão da migration segurava naquele instante.',
      ).toEqual({
        mode: 'none',
        locks: ['ShareUpdateExclusiveLock'],
        concurrent_write: 'ok',
      });
    } finally {
      a.release();
      w.release();
    }
  });

  it('o _up termina com a constraint canônica, válida e aceitando pending_race_lost', async () => {
    const c = await pool.connect();
    try {
      const stmts = splitNoTxStatements(up.sql);
      for (const s of stmts) await c.query(s);

      const cs = await constraints(c);
      // O nome temporário da fase 1 não pode sobreviver: quem lê `pg_constraint`
      // depois do deploy tem que achar UMA constraint, com o nome de sempre.
      expect(cs.map((x) => x.name)).toEqual([CHK]);
      expect(cs[0]!.validated, 'a fase 2 tem que ter validado').toBe(true);
      expect(cs[0]!.def).toContain('pending_race_lost');

      await expect(
        c.query(
          `INSERT INTO ${SCHEMA}.agent_turns(status, outcome) VALUES ('ignored','pending_race_lost')`,
        ),
      ).resolves.toBeTruthy();
    } finally {
      c.release();
    }
  });

  it('o _up é reaplicável: rodar de novo dá o mesmo estado final', async () => {
    const c = await pool.connect();
    try {
      const stmts = splitNoTxStatements(up.sql);
      for (const s of stmts) await c.query(s);
      const first = await constraints(c);
      for (const s of stmts) await c.query(s);
      expect(await constraints(c)).toEqual(first);
      expect(first.map((x) => x.name)).toEqual([CHK]);
    } finally {
      c.release();
    }
  });

  // ── Achado nº 1 — o `_down` é tudo-ou-nada ────────────────────────────────

  it('com uma row pending_race_lost o _down FALHA e a constraint continua presente', async () => {
    const c = await pool.connect();
    try {
      for (const s of splitNoTxStatements(up.sql)) await c.query(s);
      await c.query(
        `INSERT INTO ${SCHEMA}.agent_turns(status, outcome) VALUES ('ignored','pending_race_lost')`,
      );
      const antes = await canonical(c);
      expect(antes, 'pré-condição: a constraint ampliada tem que estar lá').not.toBeNull();

      const res = await runLikePsql(c, downSql);

      expect(res.ok, 'o _down tinha que RECUSAR com a evidência no banco').toBe(false);

      // O CORAÇÃO DO ACHADO Nº 1, e por isso vem ANTES da asserção sobre a
      // mensagem: o exit code sozinho não distingue "recusou e não mexeu em
      // nada" de "recusou depois de commitar o DROP" — e o segundo deixa
      // `agent_turns` sem a compatibilidade estado/outcome, em silêncio.
      const depois = await canonical(c);
      expect(
        depois,
        'O _down falhou DEPOIS de derrubar a constraint: `agent_turns` ficou sem ' +
          `\`${CHK}\`. É a falha "de propósito" removendo justamente a garantia que ela ` +
          'deveria preservar — qualquer par estado/outcome incompatível passa a entrar ' +
          'na tabela sem ninguém perceber.',
      ).not.toBeNull();
      expect(depois).toEqual(antes);
      // E o nome temporário da fase 1 também não pode ter aparecido.
      expect((await constraints(c)).map((x) => x.name)).toEqual([CHK]);

      // A recusa é NOMEADA — vem da preflight, antes de qualquer DDL. Sem ela o
      // operador recebe um 23514 cru ("violates check constraint"), que descreve
      // o sintoma e não a decisão.
      expect(res.ok === false && res.message).toMatch(/down de 115 recusado/i);
    } finally {
      c.release();
    }
  });

  it('sem rows pending_race_lost o _down volta ao vocabulário fechado da 097', async () => {
    const c = await pool.connect();
    try {
      for (const s of splitNoTxStatements(up.sql)) await c.query(s);
      await c.query(
        `INSERT INTO ${SCHEMA}.agent_turns(status, outcome) VALUES ('completed','reply_delivered')`,
      );

      const res = await runLikePsql(c, downSql);
      expect(res, 'sem a evidência na tabela, o rollback tem que passar').toEqual({ ok: true });

      const cs = await constraints(c);
      expect(cs.map((x) => x.name)).toEqual([CHK]);
      expect(cs[0]!.def).not.toContain('pending_race_lost');
      // E o CHECK estreito volta a MORDER: é o que prova que o down reverteu de
      // fato, e não só trocou o texto da definição.
      await expect(
        c.query(
          `INSERT INTO ${SCHEMA}.agent_turns(status, outcome) VALUES ('ignored','pending_race_lost')`,
        ),
      ).rejects.toThrow(/violates check constraint/i);
    } finally {
      c.release();
    }
  });

  it('o _down também limpa o nome temporário deixado por um _up interrompido', async () => {
    // Quarto estado de crash do `_up`: morreu entre os dois statements da fase 3
    // (a antiga já caiu, `_v115` ficou com o nome errado). O rollback tem que
    // sair daí também, e não deixar a constraint temporária para trás.
    const c = await pool.connect();
    try {
      const stmts = splitNoTxStatements(up.sql);
      for (const s of stmts.slice(0, stmts.length - 1)) await c.query(s);
      expect((await constraints(c)).map((x) => x.name)).toEqual([CHK_TMP]);

      const res = await runLikePsql(c, downSql);
      expect(res).toEqual({ ok: true });
      expect((await constraints(c)).map((x) => x.name)).toEqual([CHK]);
    } finally {
      c.release();
    }
  });
});
