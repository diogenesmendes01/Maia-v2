/**
 * Issue #536 (migration 118) — o TTL do export contra Postgres DE VERDADE.
 *
 * Os testes unitários provam a DECISÃO (plano, guarda, ordem, contagens) com
 * portas falsas. O que só o banco pode provar, e que este arquivo cobre:
 *
 *  1. o CHECK novo recusa um pedido que se declare varrido sem nunca ter tido
 *     artefato — a coluna é evidência de uma REMOÇÃO, e uma remoção sem alvo
 *     não aconteceu;
 *  2. a fila do varredor (`listExpiredExportArtifacts`) traz o que venceu, na
 *     ordem do mais exposto primeiro, e NÃO traz o que já foi varrido nem o
 *     que ainda está dentro do prazo;
 *  3. o `UPDATE … WHERE export_purged_at IS NULL RETURNING id` é uma transição
 *     de VENCEDOR ÚNICO — é dela que a não-duplicação da auditoria depende, e
 *     um fake não consegue provar isso;
 *  4. o índice parcial da fila existe e é PARCIAL (um índice completo sobre
 *     `privacy_requests` responderia a mesma pergunta pagando manutenção em
 *     toda linha);
 *  5. a fila continua respeitando o escopo: um pedido de outro tenant não
 *     entra na varredura de ninguém por acidente.
 *
 * Skipped sem TEST_DB_URL (a lane unit-only passa sem Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

// Ids NAMESPACED: tenants.id/agents.id são PK GLOBAIS.
const T_A = 'ttl536-tenant-a';
const A_A = 'ttl536-agent-a';
const T_B = 'ttl536-tenant-b';
const A_B = 'ttl536-agent-b';

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
    tenant,
  ]);
  await pool.query(
    'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
    [agent, tenant],
  );
}

async function insertRequest(over: {
  tenant?: string;
  agent?: string;
  subject_ref?: string;
  locator?: string | null;
  expires_at?: string | null;
  purged_at?: string | null;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO privacy_requests
       (tenant_id, agent_id, type, subject_ref, status,
        identity_verified_by, identity_verified_at,
        export_locator, export_expires_at, export_purged_at)
     VALUES ($1, $2, 'access_export', $3, 'completed', 'op', now(), $4, $5, $6)
     RETURNING id`,
    [
      over.tenant ?? T_A,
      over.agent ?? A_A,
      over.subject_ref ?? `subj-${randomUUID()}`,
      over.locator === undefined ? randomUUID() : over.locator,
      over.expires_at === undefined ? "2020-01-01T00:00:00Z" : over.expires_at,
      over.purged_at ?? null,
    ],
  );
  return res.rows[0]!.id;
}

/** A MESMA query da fila do varredor (`listExpiredExportArtifacts`). */
async function queue(limit = 100): Promise<{ id: string; expires: string }[]> {
  const res = await pool.query<{ id: string; export_expires_at: string }>(
    `SELECT id, export_expires_at::text AS export_expires_at
       FROM privacy_requests
      WHERE export_locator IS NOT NULL
        AND export_purged_at IS NULL
        AND export_expires_at IS NOT NULL
        AND export_expires_at <= now()
      ORDER BY export_expires_at ASC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ id: r.id, expires: r.export_expires_at }));
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  await ensureTenantAgent(T_A, A_A);
  await ensureTenantAgent(T_B, A_B);
});

beforeEach(async () => {
  if (!SHOULD_RUN) return;
  await pool.query('DELETE FROM privacy_requests WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
});

afterAll(async () => {
  if (!SHOULD_RUN) return;
  await pool.query('DELETE FROM privacy_requests WHERE tenant_id IN ($1, $2)', [T_A, T_B]);
  await pool.end();
});

d('migration 118 — o CHECK do varredor', () => {
  it('recusa um pedido que se declare varrido sem nunca ter tido artefato', async () => {
    await expect(
      insertRequest({ locator: null, expires_at: null, purged_at: '2026-08-24T00:00:00Z' }),
    ).rejects.toThrow(/privacy_requests_export_purge_chk/);
  });

  it('aceita varrido COM artefato', async () => {
    const id = await insertRequest({ purged_at: '2026-08-24T00:00:00Z' });
    expect(id).toBeTruthy();
  });

  it('o CHECK de expiração da 102 continua valendo', async () => {
    await expect(insertRequest({ expires_at: null })).rejects.toThrow(
      /privacy_requests_export_expiry_chk/,
    );
  });
});

d('a fila do varredor', () => {
  it('traz o vencido, do mais exposto para o menos', async () => {
    const velho = await insertRequest({ expires_at: '2020-01-01T00:00:00Z' });
    const novo = await insertRequest({ expires_at: '2024-01-01T00:00:00Z' });
    const q = await queue();
    expect(q.map((r) => r.id)).toEqual([velho, novo]);
  });

  it('não traz o que ainda está dentro do prazo', async () => {
    await insertRequest({ expires_at: '2099-01-01T00:00:00Z' });
    expect(await queue()).toEqual([]);
  });

  it('não traz o que já foi varrido — é isso que impede a segunda auditoria', async () => {
    await insertRequest({ purged_at: '2026-08-24T00:00:00Z' });
    expect(await queue()).toEqual([]);
  });

  it('não traz pedido sem artefato', async () => {
    await insertRequest({ locator: null, expires_at: null });
    expect(await queue()).toEqual([]);
  });

  it('o LIMIT recorta sem perder a ordem', async () => {
    await insertRequest({ expires_at: '2020-01-01T00:00:00Z' });
    await insertRequest({ expires_at: '2021-01-01T00:00:00Z' });
    await insertRequest({ expires_at: '2022-01-01T00:00:00Z' });
    const q = await queue(2);
    expect(q).toHaveLength(2);
    expect(new Date(q[0].expires).getTime()).toBeLessThan(new Date(q[1].expires).getTime());
  });

  it('enxerga os dois tenants — o passe é manutenção cross-tenant', async () => {
    const a = await insertRequest({ tenant: T_A, agent: A_A });
    const b = await insertRequest({ tenant: T_B, agent: A_B });
    const ids = (await queue()).map((r) => r.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });
});

d('a marcação é uma transição de vencedor único', () => {
  /**
   * O CORAÇÃO DA IDEMPOTÊNCIA, e a única parte que um fake não prova: dois
   * UPDATEs condicionais concorrentes sobre a mesma linha — só um devolve
   * `RETURNING id`, e só esse audita.
   */
  it('duas marcações concorrentes: só uma devolve a linha', async () => {
    const id = await insertRequest({});
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      const first = await a.query(
        `UPDATE privacy_requests SET export_purged_at = now()
          WHERE id = $1::uuid AND export_purged_at IS NULL RETURNING id`,
        [id],
      );
      expect(first.rowCount).toBe(1);

      // O segundo bloqueia até o commit do primeiro, e então NÃO vê mais a
      // linha elegível — é o `WHERE export_purged_at IS NULL` reavaliado sobre
      // a versão commitada.
      const pending = b.query(
        `UPDATE privacy_requests SET export_purged_at = now()
          WHERE id = $1::uuid AND export_purged_at IS NULL RETURNING id`,
        [id],
      );
      await a.query('COMMIT');
      const second = await pending;
      expect(second.rowCount).toBe(0);
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }

    const q = await queue();
    expect(q.map((r) => r.id)).not.toContain(id);
  });
});

d('os índices da 118', () => {
  it('a fila tem índice PARCIAL, não completo', async () => {
    const res = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'privacy_requests'
          AND indexname = 'privacy_requests_export_sweep_idx'`,
    );
    expect(res.rowCount).toBe(1);
    const def = res.rows[0]!.indexdef;
    expect(def).toContain('export_expires_at');
    // PARCIAL: a cláusula WHERE é o que mantém o índice pequeno numa tabela
    // majoritariamente sem artefato.
    expect(def).toMatch(/WHERE .*export_locator IS NOT NULL/);
    expect(def).toMatch(/export_purged_at IS NULL/);
  });

  it('o passe interrompido tem índice próprio', async () => {
    const res = await pool.query(
      `SELECT 1 FROM pg_indexes
        WHERE tablename = 'privacy_requests'
          AND indexname = 'privacy_requests_export_purge_open_idx'`,
    );
    expect(res.rowCount).toBe(1);
  });
});
