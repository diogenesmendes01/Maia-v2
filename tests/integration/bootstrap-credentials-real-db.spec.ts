import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

/**
 * Issue #519 — as garantias do bootstrap global, provadas contra PostgreSQL
 * DE VERDADE.
 *
 * POR QUE INTEGRAÇÃO E NÃO UNITÁRIO. Nenhuma das quatro garantias abaixo mora
 * em TypeScript. Todas são do banco:
 *
 *   - "no máximo uma credencial viva"  -> unique parcial
 *   - "invalidação atômica"            -> compare-and-swap (rowCount)
 *   - "bloqueio definitivo"            -> PK de `singleton`
 *   - "nada de tenant `default`"       -> CHECK
 *
 * Um mock de driver aprovaria as quatro sem que nenhuma existisse — é o caso
 * clássico do teste que reconstrói o call site com o próprio arreio. Aqui as
 * asserções são sobre o ERRO QUE O POSTGRES DEVOLVE, com o nome da constraint.
 */
const d = process.env.TEST_DB_URL ? describe : describe.skip;

d('#519 — garantias do bootstrap global no banco', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bootstrap_completions');
    await pool.query('DELETE FROM bootstrap_credentials');
  });

  const novaCredencial = (id: string, hash = 'h_' + id) =>
    pool.query(
      `INSERT INTO bootstrap_credentials (id, secret_hash, created_by, expires_at)
       VALUES ($1, $2, 'operador', now() + interval '1 hour')`,
      [id, hash],
    );

  it('recusa uma SEGUNDA credencial viva — o unique parcial é quem recusa', async () => {
    await novaCredencial('c1');
    await expect(novaCredencial('c2')).rejects.toMatchObject({
      code: '23505',
      constraint: 'bootstrap_credentials_unconsumed_uq',
    });
  });

  it('consumir libera a próxima E preserva o histórico (o unique é PARCIAL)', async () => {
    await novaCredencial('c1');
    await pool.query(`UPDATE bootstrap_credentials SET consumed_at = now() WHERE id = 'c1'`);

    await expect(novaCredencial('c2')).resolves.toBeTruthy();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM bootstrap_credentials');
    // 2, não 1: a credencial consumida continua existindo como evidência.
    expect(rows[0].n).toBe(2);
  });

  it('duas transações com o segredo certo produzem UM consumo e um perdedor', async () => {
    await novaCredencial('c1');

    const consumir = async () => {
      const cx = await pool.connect();
      try {
        await cx.query('BEGIN');
        await cx.query('SELECT pg_sleep(0.2)');
        const r = await cx.query(
          `UPDATE bootstrap_credentials SET consumed_at = now()
             WHERE id = 'c1' AND consumed_at IS NULL`,
        );
        await cx.query('COMMIT');
        return r.rowCount ?? 0;
      } finally {
        cx.release();
      }
    };

    const [a, b] = await Promise.all([consumir(), consumir()]);

    // A asserção é ABSOLUTA, não delta: exatamente um venceu. Um delta sobre
    // estado mutável passaria verde na segunda tentativa do `retry: 1` do
    // vitest, que herdaria a mutação como linha de base.
    expect(a + b).toBe(1);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM bootstrap_credentials WHERE consumed_at IS NOT NULL',
    );
    expect(rows[0].n).toBe(1);
  });

  it('recusa um SEGUNDO bootstrap — a PK de singleton é quem recusa', async () => {
    await novaCredencial('c1');
    await pool.query(
      `INSERT INTO bootstrap_completions (credential_id, tenant_id, founder_user_id)
       VALUES ('c1', 'acme', 'u1')`,
    );

    await expect(
      pool.query(
        `INSERT INTO bootstrap_completions (credential_id, tenant_id, founder_user_id)
         VALUES ('c1', 'outro-tenant', 'u2')`,
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'bootstrap_completions_pkey' });
  });

  it.each([['default'], ['']])(
    'recusa tenant_id %j — o CHECK é quem recusa, com singleton VÁLIDO',
    async (tenant) => {
      await novaCredencial('c1');
      // `singleton` fica no default (true) de propósito: passar `false` violaria
      // DOIS checks ao mesmo tempo e o Postgres reportaria um deles, deixando
      // ambíguo qual garantia foi exercida.
      await expect(
        pool.query(
          `INSERT INTO bootstrap_completions (credential_id, tenant_id, founder_user_id)
           VALUES ('c1', $1, 'u1')`,
          [tenant],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'bootstrap_completions_sem_tenant_default',
      });
    },
  );
});
