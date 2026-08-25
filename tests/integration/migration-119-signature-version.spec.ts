/**
 * Migration 119 (`signature_version`) contra Postgres REAL — issue #535.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo guarda
 * ─────────────────────────────────────────────────────────────────────────
 * 1. **O DEFAULT é 1, não 2.** Toda linha escrita antes desta migration foi
 *    assinada com o conjunto de campos da v1. Um DEFAULT 2 mandaria o verifier
 *    recomputar a material v2 sobre uma assinatura v1 e devolveria `invalid`
 *    para evidência íntegra — apagando a distinção entre "adulterado" e
 *    "assinado por um escritor anterior". Aferido com uma linha inserida SEM a
 *    coluna, que é como um escritor antigo insere.
 *
 * 2. **A CHECK fecha o conjunto.** Uma versão desconhecida precisa falhar na
 *    ESCRITA, não virar um `rejected_version` silencioso na leitura meses
 *    depois.
 *
 * 3. **O `_down` é tudo-ou-nada E recusa enquanto houver linha v2.** Reverter
 *    com envelopes v2 no banco não os corrompe — só os torna ilegíveis: sem a
 *    coluna, o verifier revertido recomputa a material v1 e reporta evidência
 *    válida como adulterada. O procedimento canônico de rollback
 *    (`docs/runbooks/migrations.md`) roda downs com `psql -v ON_ERROR_STOP=1
 *    -f`, statement a statement — sem o envelope `BEGIN`/`COMMIT` o `DROP
 *    INDEX` commitaria antes da recusa e a reversão "que falha de propósito"
 *    deixaria a tabela mutilada. Aqui se afere o erro E o estado da tabela,
 *    porque só o primeiro passaria com o índice já derrubado.
 *
 * 4. **O índice novo serve o predicado do `listAttempts()`.** `EXPLAIN` sobre
 *    (tenant_id, root_trace_id, turno_id) precisa escolher
 *    `runtime_trace_env_attempt_turn_idx`, senão a defesa em profundidade
 *    virou um filtro pós-scan.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que NÃO se monta o SQL aqui dentro
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha é o espelho: um teste que escreve o próprio `ALTER TABLE` afere a
 * si mesmo e continua verde com o arquivo entregue quebrado. TODO o SQL vem de
 * `migrations/` pelo discovery de produção (`src/migrations/discover.ts`),
 * inclusive o estado inicial (052 + 107 REAIS).
 *
 * Isolamento: schema dedicado por execução (`search_path`), como
 * `migration-115-constraint-swap.spec.ts`. As tabelas reais da base de teste —
 * compartilhada entre worktrees — nunca são tocadas.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import {
  discoverMigrations,
  downSiblingOf,
  splitTopLevelStatements,
} from '@/migrations/discover.js';
import type { MigrationArtifact } from '@/migrations/types.js';

/**
 * Mesmo portão de todo spec de banco real daqui: `TEST_DB_URL` e nada mais.
 * `DATABASE_URL` não serve de fallback — `tests/setup.ts` o define
 * incondicionalmente, e a suíte só-unit tentaria conectar.
 */
const DB_URL = process.env.TEST_DB_URL;
const d = DB_URL ? describe : describe.skip;

const CREATE_ID = '052_p10b_runtime_trace_envelopes.sql';
const GROUPING_ID = '107_runtime_trace_attempt_grouping.sql';
const UP_ID = '119_runtime_trace_signature_v2.sql';
const DOWN_ID = downSiblingOf(UP_ID);

const SCHEMA = `maia_mig119_${Math.random().toString(36).slice(2, 10)}`;

const TENANT = 'tenant-A';
const ROOT = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';
const TURNO = '99999999-8888-4777-8666-555555555555';

let admin: pg.Pool;
let pool: pg.Pool;
let artifact: MigrationArtifact;
/** Conteúdo do `_down` REAL, lido do disco — o artefato só indexa os forward. */
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
): Promise<{ ok: true } | { ok: false; index: number; message: string }> {
  const stmts = splitTopLevelStatements(sql);
  for (let i = 0; i < stmts.length; i++) {
    try {
      await client.query(stmts[i]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, index: i, message: (err as Error).message };
    }
  }
  return { ok: true };
}

function sqlOf(id: string): string {
  const m = artifact.byId.get(id);
  if (!m) throw new Error(`migration ${id} não encontrada pelo discovery de produção`);
  return m.sql;
}

/** Reconstrói a tabela no estado "pré-119": 052 + 107, dos arquivos REAIS. */
async function seedPre119(client: pg.PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${SCHEMA}.runtime_trace_envelopes CASCADE`);
  for (const id of [CREATE_ID, GROUPING_ID]) {
    const r = await runLikePsql(client, sqlOf(id));
    if (!r.ok) throw new Error(`seed ${id} falhou no statement ${r.index}: ${r.message}`);
  }
}

async function insertEnvelope(
  client: pg.PoolClient | pg.Pool,
  over: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    trace_id: '3f1a9d2e-4c5b-4a7e-9f0d-1b2c3d4e5f60',
    tenant_id: TENANT,
    agent_id: 'agent-a',
    turno_id: TURNO,
    root_trace_id: ROOT,
    attempt: 1,
    decision: 'allow',
    side_effect_level: 'medium',
    envelope_hmac: 'assinatura-de-teste',
    hmac_key_version: 1,
    ...over,
  } as Record<string, unknown>;
  const cols = Object.keys(row);
  await client.query(
    `INSERT INTO ${SCHEMA}.runtime_trace_envelopes (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  );
}

d('migration 119 — signature_version contra Postgres real (#535)', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB_URL, max: 2 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new pg.Pool({
      connectionString: DB_URL,
      max: 4,
      options: `-c search_path=${SCHEMA},public`,
    });
    artifact = await discoverMigrations(join(process.cwd(), 'migrations'));
    // O `_down` precisa EXISTIR e ser o irmão que o discovery de produção
    // resolve — AGENTS.md §4 regra 6.
    expect(artifact.byId.get(UP_ID)?.hasDownSibling).toBe(true);
    downSql = await readFile(join(process.cwd(), 'migrations', DOWN_ID), 'utf8');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    const c = await pool.connect();
    try {
      await seedPre119(c);
      const r = await runLikePsql(c, sqlOf(UP_ID));
      expect(r).toEqual({ ok: true });
    } finally {
      c.release();
    }
  });

  it('a coluna nasce NOT NULL com DEFAULT 1 — o passado é v1, não v2', async () => {
    const meta = await pool.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'runtime_trace_envelopes'
          AND column_name = 'signature_version'`,
      [SCHEMA],
    );
    expect(meta.rowCount).toBe(1);
    expect(meta.rows[0]!.is_nullable).toBe('NO');
    expect(meta.rows[0]!.column_default).toContain('1');

    // Um escritor antigo insere SEM a coluna. O banco precisa chamá-la de v1.
    await insertEnvelope(pool);
    const got = await pool.query<{ signature_version: number }>(
      `SELECT signature_version FROM ${SCHEMA}.runtime_trace_envelopes`,
    );
    expect(got.rows[0]!.signature_version).toBe(1);
  });

  it('a CHECK recusa uma versão fora do conjunto — falha na escrita, não na leitura', async () => {
    await expect(insertEnvelope(pool, { signature_version: 3 })).rejects.toThrow(
      /runtime_trace_env_signature_version_chk|check constraint/i,
    );
    await expect(insertEnvelope(pool, { signature_version: 0 })).rejects.toThrow(
      /runtime_trace_env_signature_version_chk|check constraint/i,
    );
    // E aceita as duas que existem.
    await insertEnvelope(pool, {
      trace_id: '00000000-0000-4000-8000-000000000001',
      signature_version: 1,
    });
    await insertEnvelope(pool, {
      trace_id: '00000000-0000-4000-8000-000000000002',
      signature_version: 2,
    });
  });

  it('o índice do agrupamento por turno existe e serve o predicado do listAttempts()', async () => {
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'runtime_trace_env_attempt_turn_idx'`,
      [SCHEMA],
    );
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0]!.indexdef).toMatch(/tenant_id.*root_trace_id.*turno_id.*attempt/s);

    // Com a tabela vazia o planner escolhe seq scan por custo. Popula o
    // suficiente para o índice ganhar, e desabilita seq scan para tornar a
    // pergunta "o índice COBRE o predicado?" em vez de "o planner gostou dele?".
    for (let i = 0; i < 200; i++) {
      await insertEnvelope(pool, {
        trace_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        attempt: (i % 5) + 1,
      });
    }
    await pool.query(`ANALYZE ${SCHEMA}.runtime_trace_envelopes`);
    const c = await pool.connect();
    try {
      await c.query('SET LOCAL enable_seqscan = off');
      const plan = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT trace_id FROM ${SCHEMA}.runtime_trace_envelopes
          WHERE tenant_id = $1 AND root_trace_id = $2 AND turno_id = $3
          ORDER BY attempt, created_at LIMIT 50`,
        [TENANT, ROOT, TURNO],
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('runtime_trace_env_attempt_turn_idx');
    } finally {
      c.release();
    }
  });

  it('o `_down` RECUSA enquanto houver envelope v2, e não mutila a tabela', async () => {
    await insertEnvelope(pool, { signature_version: 2 });
    const c = await pool.connect();
    try {
      const r = await runLikePsql(c, downSql);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.message).toMatch(/down de 119 recusado/i);
    } finally {
      c.release();
    }

    // O ponto do envelope `BEGIN`/`COMMIT`: a recusa é TOTAL. Sem ele, o
    // `DROP INDEX` teria commitado antes da exceção e a reversão que "falha de
    // propósito" teria removido o índice do agrupamento em silêncio.
    const idx = await pool.query(
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'runtime_trace_env_attempt_turn_idx'`,
      [SCHEMA],
    );
    expect(idx.rowCount).toBe(1);
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'runtime_trace_envelopes'
          AND column_name = 'signature_version'`,
      [SCHEMA],
    );
    expect(col.rowCount).toBe(1);
  });

  it('o `_down` reverte limpo quando só há linhas v1', async () => {
    await insertEnvelope(pool, { signature_version: 1 });
    const c = await pool.connect();
    try {
      const r = await runLikePsql(c, downSql);
      expect(r).toEqual({ ok: true });
    } finally {
      c.release();
    }
    const col = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'runtime_trace_envelopes'
          AND column_name = 'signature_version'`,
      [SCHEMA],
    );
    expect(col.rowCount).toBe(0);
    // E a linha continua lá — o down remove a interpretação, nunca a evidência.
    const rows = await pool.query(`SELECT 1 FROM ${SCHEMA}.runtime_trace_envelopes`);
    expect(rows.rowCount).toBe(1);
  });

  it('o par `_up`/`_down` que o discovery de produção resolve é o desta migration', () => {
    expect(DOWN_ID).toBe('119_runtime_trace_signature_v2_down.sql');
  });
});
