/**
 * Migration 116 (`mensagens.tipo` admite 'evento') contra Postgres REAL — as
 * três garantias que os arquivos SQL afirmam, aferidas nos arquivos DE VERDADE.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo guarda
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **A validação do `_up` não corre sob ACCESS EXCLUSIVE.** A primeira versão
 *    do arquivo era `DROP CONSTRAINT` + `ADD CONSTRAINT` soltos, sem marker:
 *    no modo `runner` o arquivo INTEIRO vira uma transação só, o ACCESS
 *    EXCLUSIVE do `DROP` fica retido, e a varredura que o `ADD` faz para
 *    validar todas as linhas de `mensagens` acontece debaixo dele. `mensagens`
 *    é a tabela de entrada/saída: isso bloqueia inbound e outbound pelo tempo
 *    inteiro da varredura. O smoke da versão antiga ficou verde porque aplicou
 *    numa base VAZIA em 2 ms — não mede nada disso. Aqui a garantia é aferida
 *    do único jeito que não é opinião: um SEGUNDO cliente tenta ESCREVER em
 *    `mensagens` no exato momento em que a validação está em curso, com
 *    `lock_timeout` — se a sessão da migration estiver segurando ACCESS
 *    EXCLUSIVE, essa escrita morre em `55P03` (`lock_not_available`).
 *    Determinístico: `lock_timeout` é um prazo duro, não uma janela de sorte.
 *
 * 2. **O `_down` é tudo-ou-nada.** Ele declara que uma row `tipo='evento'` de
 *    origem desconhecida deve fazê-lo FALHAR em vez de apagar dado alheio. Mas
 *    a versão anterior não tinha `BEGIN`/`COMMIT`, e o procedimento canônico de
 *    rollback (`docs/runbooks/migrations.md`) roda downs com
 *    `psql -v ON_ERROR_STOP=1 -f`, em autocommit por statement: o `DELETE` e o
 *    `DROP CONSTRAINT` já estavam confirmados quando o `ADD CONSTRAINT` falhava.
 *    O fail-closed do comentário era fail-open na execução — perdia os
 *    placeholders conhecidos E deixava `mensagens.tipo` sem CHECK nenhum. Aqui
 *    se afere o exit code E os dados E a constraint, porque só o primeiro
 *    passaria com a tabela desprotegida.
 *
 * 3. **O recorte do `DELETE` não é mais largo que o contrato declarado.** O
 *    arquivo promete apagar só o formato que o flush produz; o predicado tem
 *    que testar esse formato INTEIRO (`conteudo=''`, `flush_reason` no
 *    vocabulário fechado, e os demais marcadores). Uma row que carregue só os
 *    três marcadores antigos (`tipo`/`direcao`/`event_only`) é de outra origem
 *    e tem que SOBREVIVER — e, por sobreviver, derrubar o down.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que NÃO se monta o SQL aqui dentro
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha é o espelho: um teste que escreve o próprio `ALTER TABLE` afere a
 * si mesmo e continua verde com o arquivo entregue quebrado. Então TODO o SQL
 * vem de `migrations/` pelo `discoverMigrations` de produção
 * (`src/migrations/discover.ts`), inclusive o estado inicial da tabela — a
 * constraint estreita da 001 é instalada rodando o `_down` REAL, não uma cópia.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que statement a statement, e nunca `client.query(arquivoInteiro)`
 * ─────────────────────────────────────────────────────────────────────────
 * `node-postgres` envolve um `query()` multi-statement num BEGIN/COMMIT
 * IMPLÍCITO. Mandar o `_down` inteiro numa chamada só o tornaria atômico mesmo
 * SEM `BEGIN`/`COMMIT` no arquivo — o defeito ficaria invisível e o teste,
 * verde pela razão errada. `psql -f` não faz isso: manda um statement por vez.
 * `runLikePsql` reproduz exatamente esse protocolo, usando o tokenizador de
 * produção (`splitTopLevelStatements`) e parando no primeiro erro, que é o
 * `ON_ERROR_STOP=1`.
 *
 * Isolamento: schema dedicado por execução (`search_path`), como
 * `migration-115-constraint-swap.spec.ts`. O `mensagens` real da base de teste —
 * compartilhada entre worktrees — nunca é tocado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  analyzeTransactionEnvelope,
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

const UP_ID = '116_mensagens_tipo_evento.sql';
/** Derivado pela função de produção — o par `_up`/`_down` é regra, não convenção local. */
const DOWN_ID = downSiblingOf(UP_ID);
const CHK = 'mensagens_tipo_check';
const CHK_TMP = 'mensagens_tipo_check_v116';

/** Schema único por execução, para workers paralelos não colidirem. */
const SCHEMA = `maia_mig116_${Math.random().toString(36).slice(2, 10)}`;

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
      // tinha `BEGIN;` — desfaz, que é o que o operador faria antes de olhar o
      // banco.
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

/** Constraints CHECK de `<SCHEMA>.mensagens`, como o banco as vê. */
async function constraints(
  client: pg.PoolClient | pg.Pool,
): Promise<{ name: string; validated: boolean; def: string }[]> {
  const r = await client.query<{ conname: string; convalidated: boolean; def: string }>(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND contype = 'c'
      ORDER BY conname`,
    [`${SCHEMA}.mensagens`],
  );
  return r.rows.map((x) => ({ name: x.conname, validated: x.convalidated, def: x.def }));
}

/** Só a constraint canônica, ou `null`. */
async function canonical(
  client: pg.PoolClient | pg.Pool,
): Promise<{ name: string; validated: boolean; def: string } | null> {
  return (await constraints(client)).find((c) => c.name === CHK) ?? null;
}

/** Ids das rows `tipo='evento'` que ainda existem, para afirmar sobre perda de dado. */
async function eventoRowIds(client: pg.PoolClient): Promise<string[]> {
  const r = await client.query<{ marca: string }>(
    `SELECT marca FROM ${SCHEMA}.mensagens WHERE tipo = 'evento' ORDER BY marca`,
  );
  return r.rows.map((x) => x.marca);
}

/**
 * Estado inicial: a tabela mínima que a constraint e o predicado do `_down`
 * tocam, com a constraint ESTREITA da 001 instalada rodando o `_down` REAL.
 * Assim nem o ponto de partida é escrito à mão aqui.
 */
async function seedNarrow(client: pg.PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.mensagens`);
  await client.query(
    `CREATE TABLE ${SCHEMA}.mensagens (
       id bigserial PRIMARY KEY,
       marca text NOT NULL,
       direcao text NOT NULL,
       tipo text NOT NULL,
       conteudo text,
       midia_url text,
       metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
       ferramentas_chamadas jsonb NOT NULL DEFAULT '[]'::jsonb
     )`,
  );
  const res = await runLikePsql(client, downSql);
  if (!res.ok) throw new Error(`seed pelo _down falhou no statement ${res.index}: ${res.message}`);
}

/** A row EXATA que `flushUnconfirmedToolSummaries()` grava hoje. */
async function inserirRowDoFlush(client: pg.PoolClient, marca: string): Promise<void> {
  await client.query(
    `INSERT INTO ${SCHEMA}.mensagens
       (marca, direcao, tipo, conteudo, midia_url, metadata, ferramentas_chamadas)
     VALUES ($1, 'out', 'evento', '', NULL,
             jsonb_build_object('in_reply_to', '00000000-0000-0000-0000-000000000001',
                                'event_only', true,
                                'flush_reason', 'iteration_cap'),
             '[{"tool_name":"listar_transacoes","status":"success"}]'::jsonb)`,
    [marca],
  );
}

type ValidateProbe = {
  /** Modo de transação DESCOBERTO no arquivo — decide como ele é executado. */
  mode: DiscoveredMigration['transactionMode'];
  /** Locks que a sessão da migration segurava em `mensagens` no `VALIDATE`. */
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
 * `BEGIN` explícito. Isso não muda os locks que o `VALIDATE` toma; só os mantém
 * visíveis pelo tempo da medição. O que a sonda mede é o que a sessão segurava
 * ALÉM deles, vindo dos statements anteriores.
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
          [pid, `${SCHEMA}.mensagens`],
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
          `INSERT INTO ${SCHEMA}.mensagens (marca, direcao, tipo, conteudo)
           VALUES ('inbound-concorrente', 'in', 'texto', 'oi')`,
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

d('migration 116 — troca de CHECK em mensagens (#593)', () => {
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

  // ── Achado nº 1 — a troca de constraint não pode ser uma transação só ──────

  it('o _up declara maia:no-transaction, e é isso que separa as fases em commits', () => {
    // Sem o marker o runner envolve o arquivo INTEIRO num BEGIN/COMMIT
    // (`src/migrations/runner.ts`, modo `runner`) e as três fases voltam a ser
    // uma transação só — que é exatamente o defeito do achado nº 1.
    expect(up.transactionMode, `${UP_ID}: modo de transação`).toBe('none');
    expect(up.noTransaction).toBe(true);
    // E o diagnóstico do runner segue honesto: uma falha limpa num arquivo
    // `none` é `dirty` (nunca reaplicada sozinha), não `failed` (auto-retry).
    expect(terminalLedgerStatusFor(up)).toBe('dirty');
  });

  it('a validação do _up NÃO segura ACCESS EXCLUSIVE: escrita concorrente em mensagens passa', async () => {
    const a = await pool.connect();
    const w = await pool.connect();
    try {
      const probe = await applyUpObservingValidate(a, w);
      expect(
        probe,
        'A varredura do VALIDATE estava correndo com `mensagens` sob ACCESS EXCLUSIVE. ' +
          '`mensagens` é a tabela de entrada/saída: enquanto a varredura durar, TODO ' +
          'inbound e TODO outbound ficam bloqueados. `concurrent_write` traz o SQLSTATE ' +
          'que matou a escrita (55P03 = lock_not_available, o `lock_timeout` de 2s ' +
          'estourando) e `locks` traz os locks que a sessão da migration segurava ' +
          'naquele instante.',
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

  it('o _up termina com a constraint canônica, válida e aceitando tipo=evento', async () => {
    const c = await pool.connect();
    try {
      for (const s of splitNoTxStatements(up.sql)) await c.query(s);

      const cs = await constraints(c);
      // O nome temporário da fase 1 não pode sobreviver: quem lê `pg_constraint`
      // depois do deploy tem que achar UMA constraint, com o nome de sempre.
      expect(cs.map((x) => x.name)).toEqual([CHK]);
      expect(cs[0]!.validated, 'a fase 2 tem que ter validado').toBe(true);
      expect(cs[0]!.def).toContain('evento');

      await expect(inserirRowDoFlush(c, 'flush-1')).resolves.toBeUndefined();
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

  // ── Achado nº 2 — o `_down` é tudo-ou-nada ────────────────────────────────

  it('o _down é UM envelope de transação completo — a garantia, separada do comportamento', () => {
    // Mesmo predicado que o repositório usa para migrations `self`
    // (`analyzeTransactionEnvelope`, `src/migrations/discover.ts`): o arquivo
    // abre transação no primeiro statement de topo, fecha no último, e não tem
    // nada fora dela. É o que faz a recusa ser tudo-ou-nada para QUALQUER
    // statement que venha a falhar aqui, não só para o `ADD CONSTRAINT`.
    expect(analyzeTransactionEnvelope(downSql).envelope).toBe('single_complete');
  });

  it('com uma row evento de origem desconhecida o _down FALHA sem perder dado nem constraint', async () => {
    const c = await pool.connect();
    try {
      for (const s of splitNoTxStatements(up.sql)) await c.query(s);
      // Uma row do flush (que o DELETE alcança) e uma FORA do recorte (que ele
      // não alcança). Sem o envelope, a primeira some e a constraint cai.
      await inserirRowDoFlush(c, 'flush-conhecida');
      await c.query(
        `INSERT INTO ${SCHEMA}.mensagens (marca, direcao, tipo, conteudo, metadata)
         VALUES ('evento-de-outra-origem', 'in', 'evento', 'telemetria do gateway',
                 '{"origem":"desconhecida"}'::jsonb)`,
      );
      const antes = await canonical(c);
      expect(antes, 'pré-condição: a constraint de seis valores tem que estar lá').not.toBeNull();
      expect(await eventoRowIds(c)).toEqual(['evento-de-outra-origem', 'flush-conhecida']);

      const res = await runLikePsql(c, downSql);

      expect(res.ok, 'o _down tinha que RECUSAR com a row desconhecida no banco').toBe(false);
      // A recusa vem do `ADD CONSTRAINT`, que é o juiz único do recorte.
      expect(res.ok === false && res.code).toBe('23514');

      // (b) OS DADOS e (c) A CONSTRAINT, na MESMA asserção: o exit code sozinho
      // não distingue "recusou e não mexeu em nada" de "recusou depois de
      // commitar o DELETE e o DROP". Sem o envelope os dois quebram juntos, e
      // um diff só mostra os dois estragos de uma vez.
      expect(
        {
          eventos: await eventoRowIds(c),
          constraint: (await canonical(c))?.def ?? null,
        },
        'O _down falhou DEPOIS de commitar o DELETE e/ou o DROP. `eventos` faltando ' +
          'significa que os placeholders do flush foram apagados por um rollback que ' +
          `RECUSOU; \`constraint: null\` significa que \`mensagens\` ficou sem \`${CHK}\` e ` +
          'qualquer valor de `tipo` passa a entrar sem ninguém perceber. Fail-closed no ' +
          'comentário, fail-open na execução.',
      ).toEqual({
        eventos: ['evento-de-outra-origem', 'flush-conhecida'],
        constraint: antes!.def,
      });
      expect(antes!.def).toContain('evento');
      // E o nome temporário da fase 1 também não pode ter aparecido.
      expect((await constraints(c)).map((x) => x.name)).toEqual([CHK]);
    } finally {
      c.release();
    }
  });

  it('sem rows de origem desconhecida o _down apaga só o flush e volta ao vocabulário da 001', async () => {
    const c = await pool.connect();
    try {
      for (const s of splitNoTxStatements(up.sql)) await c.query(s);
      await inserirRowDoFlush(c, 'flush-1');
      await inserirRowDoFlush(c, 'flush-2');
      await c.query(
        `INSERT INTO ${SCHEMA}.mensagens (marca, direcao, tipo, conteudo)
         VALUES ('conversa', 'out', 'texto', 'ola')`,
      );

      const res = await runLikePsql(c, downSql);
      expect(res, 'sem origem desconhecida, o rollback tem que passar').toEqual({ ok: true });

      expect(await eventoRowIds(c)).toEqual([]);
      const sobrou = await c.query<{ marca: string }>(
        `SELECT marca FROM ${SCHEMA}.mensagens ORDER BY marca`,
      );
      expect(
        sobrou.rows.map((r) => r.marca),
        'nenhuma mensagem de conversa pode ser levada junto',
      ).toEqual(['conversa']);

      const cs = await constraints(c);
      expect(cs.map((x) => x.name)).toEqual([CHK]);
      expect(cs[0]!.def).not.toContain('evento');
      // E o CHECK estreito volta a MORDER: é o que prova que o down reverteu de
      // fato, e não só trocou o texto da definição.
      await expect(inserirRowDoFlush(c, 'flush-3')).rejects.toThrow(
        /violates check constraint/i,
      );
    } finally {
      c.release();
    }
  });

  // ── Achado nº 3 — o recorte do DELETE é o formato completo, não três marcadores ──

  it.each([
    {
      caso: 'conteudo com texto (o flush sempre grava vazio)',
      sql: `'conteudo real', NULL,
            jsonb_build_object('in_reply_to','x','event_only',true,'flush_reason','iteration_cap'),
            '[{"tool_name":"t"}]'::jsonb`,
    },
    {
      caso: 'flush_reason fora do vocabulário de ReActExitReason',
      sql: `'', NULL,
            jsonb_build_object('in_reply_to','x','event_only',true,'flush_reason','housekeeping'),
            '[{"tool_name":"t"}]'::jsonb`,
    },
    {
      caso: 'sem flush_reason nenhum — só os três marcadores da versão antiga',
      sql: `'', NULL, jsonb_build_object('event_only', true), '[]'::jsonb`,
    },
    {
      caso: 'ferramentas_chamadas vazio (o flush retorna cedo nesse caso)',
      sql: `'', NULL,
            jsonb_build_object('in_reply_to','x','event_only',true,'flush_reason','iteration_cap'),
            '[]'::jsonb`,
    },
    {
      caso: 'midia_url preenchido — o placeholder do flush nunca tem mídia',
      sql: `'', 'file:///tmp/x.pdf',
            jsonb_build_object('in_reply_to','x','event_only',true,'flush_reason','iteration_cap'),
            '[{"tool_name":"t"}]'::jsonb`,
    },
  ])(
    'row evento com $caso NÃO é do flush: sobrevive e derruba o _down',
    async ({ sql }) => {
      const c = await pool.connect();
      try {
        for (const s of splitNoTxStatements(up.sql)) await c.query(s);
        await c.query(
          `INSERT INTO ${SCHEMA}.mensagens
             (marca, direcao, tipo, conteudo, midia_url, metadata, ferramentas_chamadas)
           VALUES ('outra-origem', 'out', 'evento', ${sql})`,
        );
        const antes = await canonical(c);

        const res = await runLikePsql(c, downSql);

        expect(
          res.ok,
          'O predicado do DELETE alcançou uma row que NÃO tem o formato do flush. O ' +
            'arquivo promete apagar só o que `flushUnconfirmedToolSummaries()` cria e ' +
            'declara que origem desconhecida deve fazê-lo FALHAR — um predicado mais ' +
            'largo que esse contrato apaga dado alheio em silêncio.',
        ).toBe(false);
        expect({
          eventos: await eventoRowIds(c),
          constraint: (await canonical(c))?.def ?? null,
        }).toEqual({ eventos: ['outra-origem'], constraint: antes!.def });
      } finally {
        c.release();
      }
    },
  );

  it('o _down também limpa o nome temporário deixado por um _up interrompido', async () => {
    // Quarto estado de crash do `_up`: morreu entre os dois statements da fase 3
    // (a antiga já caiu, `_v116` ficou com o nome errado). O rollback tem que
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
