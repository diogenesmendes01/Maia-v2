import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

/**
 * #519 — a rota `POST /setup/bootstrap` contra Fastify e Postgres REAIS.
 *
 * POR QUE NÃO É JORNADA DO CONSOLE. `scripts/admin-ui-e2e.sh` sobe apenas o
 * artefato `standalone` do admin-ui (porta 4000); o Fastify do app não sobe
 * nesse job. Uma jornada Playwright em `tests/admin-ui/e2e/` não alcançaria
 * esta rota — é o MESMO bloqueio que mantém `channel-lines-pairing` fora sob
 * `@pendente-runtime` ("o QR e o código vêm do worker do RUNTIME e o job do CI
 * sobe só o console"). Levantar o app naquele job resolveria as duas de uma
 * vez, e é trabalho à parte.
 *
 * O que ESTE arquivo cobre é o contrato HTTP inteiro contra o banco de
 * verdade: os códigos de status, o bloqueio permanente e o founder criado.
 * As asserções são sobre o ESTADO NO BANCO, não sobre o corpo da resposta —
 * um handler que devolvesse 200 sem gravar nada passaria por qualquer
 * asserção que só lesse o JSON.
 */

const d = process.env.TEST_DB_URL ? describe : describe.skip;

const CRED = '11111111111111111111111111111111';

d('#519 — POST /setup/bootstrap (Fastify + Postgres reais)', () => {
  let pool: pg.Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    app = Fastify();
    const { registerSetupRoutes } = await import('../../src/setup/index.js');
    await registerSetupRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    // Ordem importa: `bootstrap_completions` referencia `bootstrap_credentials`.
    await pool.query('DELETE FROM bootstrap_completions');
    await pool.query('DELETE FROM bootstrap_credentials');
  });

  /**
   * Semeia uma credencial com o hash do segredo dado.
   *
   * Para a variante EXPIRADA, `created_at` é recuado junto: a CHECK
   * `bootstrap_credentials_expira_depois_de_criada` exige `expires_at >
   * created_at`, então uma credencial só pode estar vencida se tiver NASCIDO
   * antes ainda. Recuar só o vencimento produziria uma linha que o banco
   * recusa — e que, portanto, nunca existe em produção.
   */
  const semear = async (segredo: string, opts: { expirada?: boolean } = {}): Promise<string> => {
    const { hashSecret } = await import('../../src/onboarding/bootstrap.js');
    const id = randomBytes(16).toString('hex');
    await pool.query(
      opts.expirada
        ? `INSERT INTO bootstrap_credentials (id, secret_hash, created_by, created_at, expires_at)
           VALUES ($1, $2, 'teste', now() - interval '2 hours', now() - interval '1 hour')`
        : `INSERT INTO bootstrap_credentials (id, secret_hash, created_by, expires_at)
           VALUES ($1, $2, 'teste', now() + interval '1 hour')`,
      [id, hashSecret(segredo)],
    );
    return id;
  };

  const chamar = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/setup/bootstrap', payload: body });

  const corpoValido = (extra: Record<string, unknown> = {}) => ({
    secret: CRED,
    tenant_id: `t${randomBytes(4).toString('hex')}`,
    tenant_nome: 'ACME',
    email: `op-${randomBytes(4).toString('hex')}@example.com`,
    idempotency_key: randomBytes(8).toString('hex'),
    ...extra,
  });

  it('credencial válida cria o tenant e o founder, e grava o marcador', async () => {
    await semear(CRED);
    const corpo = corpoValido();
    const r = await chamar(corpo);

    expect(r.statusCode, r.body).toBe(200);

    // Evidência NO BANCO — não no corpo da resposta.
    const u = await pool.query<{ role: string; tenant_id: string }>(
      `SELECT role, tenant_id FROM app_users WHERE email = $1`,
      [corpo.email],
    );
    expect(u.rowCount).toBe(1);
    // O papel é FORÇADO pelo backend: o corpo nem o mandou.
    expect(u.rows[0]!.role).toBe('founder');
    expect(u.rows[0]!.tenant_id).toBe(corpo.tenant_id);

    const m = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM bootstrap_completions',
    );
    expect(Number(m.rows[0]!.n), 'o marcador de conclusão não foi gravado').toBe(1);

    // A credencial foi CONSUMIDA — não pode continuar viva.
    const c = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM bootstrap_credentials WHERE consumed_at IS NULL',
    );
    expect(Number(c.rows[0]!.n), 'a credencial continuou viva após o uso').toBe(0);
  });

  it('a segunda chamada é recusada com 409, para sempre', async () => {
    await semear(CRED);
    const primeiro = corpoValido();
    expect((await chamar(primeiro)).statusCode).toBe(200);

    // Mesmo semeando uma credencial NOVA e válida, o bloqueio persiste: quem
    // decide é `bootstrap_completions`, não a credencial.
    await semear(CRED);
    const segundo = corpoValido();
    const r2 = await chamar(segundo);
    expect(r2.statusCode).toBe(409);
    expect(JSON.parse(r2.body).error).toBe('bootstrap_already_completed');

    // A contagem é ESCOPADA aos dois tenants desta chamada, não global: o banco
    // de teste é compartilhado com os outros specs de integração, e um
    // `count(*)` de todos os founders mediria o resíduo deles, não este caso.
    const founders = async (tenant: string): Promise<number> => {
      const q = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app_users WHERE tenant_id = $1 AND role = 'founder'",
        [tenant],
      );
      return Number(q.rows[0]!.n);
    };
    expect(await founders(primeiro.tenant_id), 'o primeiro founder sumiu').toBe(1);
    expect(await founders(segundo.tenant_id), 'a chamada recusada criou um founder').toBe(0);
  });

  it('segredo errado é recusado com 403 e NÃO cria nada', async () => {
    await semear(CRED);
    const r = await chamar(corpoValido({ secret: '2'.repeat(32) }));
    expect(r.statusCode).toBe(403);

    const m = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM bootstrap_completions',
    );
    expect(Number(m.rows[0]!.n)).toBe(0);
  });

  it('credencial expirada é recusada, mesmo com o segredo CERTO', async () => {
    await semear(CRED, { expirada: true });
    const r = await chamar(corpoValido());
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toBe('bootstrap_credential_expired');
  });

  it('campo obrigatório ausente é 400, antes de tocar na credencial', async () => {
    await semear(CRED);
    const { tenant_id: _omitido, ...semTenant } = corpoValido();
    const r = await chamar(semTenant);
    expect(r.statusCode).toBe(400);

    // A credencial NÃO pode ter sido consumida por um pedido malformado.
    const c = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM bootstrap_credentials WHERE consumed_at IS NULL',
    );
    expect(Number(c.rows[0]!.n), 'pedido malformado consumiu a credencial').toBe(1);
  });

  it('a resposta NUNCA ecoa o segredo nem o e-mail', async () => {
    await semear(CRED);
    const corpo = corpoValido();
    const r = await chamar(corpo);
    expect(r.body).not.toContain(CRED);
    expect(r.body).not.toContain(corpo.email);
  });
});
