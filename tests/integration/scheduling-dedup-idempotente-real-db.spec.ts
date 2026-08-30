/**
 * A idempotência do ledger de agendamento estava DESLIGADA, e o defeito era
 * invisível.
 *
 * Três `catch` em `src/scheduling/repos.ts` prometiam, em comentário, que uma
 * colisão de unique é sucesso idempotente — e testavam
 * `/duplicate key|unique constraint/i` contra `(err as Error).message`. O que
 * chega naqueles `catch` NÃO é o erro do `pg`: o driver do Drizzle embrulha a
 * falha num erro cuja `message` é `Failed query: insert into "..."` e pendura
 * o erro do `pg` em `cause`. Medido, contra o Postgres de verdade:
 *
 *   message           = 'Failed query: insert into "tenants" (...) values (...)'
 *   regex casa?       = false
 *   cause.message     = 'duplicate key value violates unique constraint "..."'
 *   cause.code        = '23505'
 *
 * Ou seja: a regex nunca dava verdadeiro, e o ramo idempotente era código
 * morto. Toda corrida rotineira — dois workers materializando a mesma
 * ocorrência, dois enfileiramentos com a mesma `dedup_key` — subia como
 * exceção para o chamador.
 *
 * Este spec exercita os três caminhos contra Postgres real. Unidade não
 * serviria: um store em memória fica verde com o índice derrubado.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'ischeddedup-tenant';
const A = 'ischeddedup-agent';

/** A entrada de `enqueue`, nomeada uma vez em vez de repetida em cada caso. */
type EntradaOutbox = Parameters<
  typeof import('../../src/scheduling/repos.js').outboxRepo.enqueue
>[0];

let pool: pg.Pool;

d('colisão de unique no ledger de agendamento é sucesso idempotente', () => {
  let seriesId: string;
  let pessoaId: string;

  const limpar = async (): Promise<void> => {
    await pool.query('DELETE FROM outbox_messages WHERE tenant_id = $1', [T]);
    await pool.query(
      'DELETE FROM tasks WHERE occurrence_id IN (SELECT id FROM occurrences WHERE tenant_id = $1)',
      [T],
    );
    await pool.query('DELETE FROM occurrences WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM series WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM pessoas WHERE tenant_id = $1', [T]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
      T,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
      [A, T],
    );
  });

  afterAll(async () => {
    await limpar();
    await pool?.end();
  });

  beforeEach(async () => {
    await limpar();
    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
       VALUES ($1, $2, 'Dono', '+5511900000009', 'dono') RETURNING id`,
      [T, A],
    );
    pessoaId = p.rows[0]!.id;
    const s = await pool.query<{ id: string }>(
      `INSERT INTO series(tenant_id, agent_id, tipo, status, version, owner_pessoa_id, rrule)
       VALUES ($1, $2, 'recurring_outreach', 'active', 1, $3, 'FREQ=MONTHLY') RETURNING id`,
      [T, A, pessoaId],
    );
    seriesId = s.rows[0]!.id;
  });

  const noEscopo = async <R>(fn: () => Promise<R>): Promise<R> => {
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    return runWithTenantContext({ tenant_id: T, agent_id: A }, fn);
  };

  it('`outboxRepo.enqueue` com a MESMA dedup_key devolve null — não estoura', async () => {
    const { outboxRepo } = await import('../../src/scheduling/repos.js');
    const dedup = 'dedup-' + Date.now();
    const entrada = {
      kind: 'email_alert',
      payload: { a: 1 },
      dedup_key: dedup,
    } as EntradaOutbox;

    const primeira = await noEscopo(() => outboxRepo.enqueue(entrada));
    expect(primeira, 'o primeiro enfileiramento devia ter gravado').not.toBeNull();

    // ANTES da correção esta linha REJEITAVA com o erro embrulhado do Drizzle.
    const segunda = await noEscopo(() => outboxRepo.enqueue(entrada));
    expect(segunda, 'a colisão de dedup_key devia ser sucesso idempotente').toBeNull();

    const n = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM outbox_messages WHERE tenant_id = $1 AND dedup_key = $2',
      [T, dedup],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('o enqueue TRANSACIONAL (`advanceWithTx`) também devolve null na colisão', async () => {
    // Caminho distinto do de cima: é o `txRepos` que o motor usa para deixar
    // outbox + task + ocorrência atômicos, e ele tinha a MESMA regex morta.
    const { advanceWithTx } = await import('../../src/scheduling/repos.js');
    const dedup = 'dedup-tx-' + Date.now();
    const entrada = {
      kind: 'email_alert',
      payload: { a: 1 },
      dedup_key: dedup,
    } as EntradaOutbox;

    const primeira = await noEscopo(() =>
      advanceWithTx(async (_tx, t) => t.outbox.enqueue(entrada)),
    );
    expect(primeira).not.toBeNull();

    const segunda = await noEscopo(() =>
      advanceWithTx(async (_tx, t) => t.outbox.enqueue(entrada)),
    );
    expect(segunda, 'a colisão dentro da transação devia ser idempotente').toBeNull();
  });

  it('duas materializações da MESMA ocorrência: a perdedora desiste, não estoura', async () => {
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const quando = new Date('2030-01-01T12:00:00Z');
    const entrada = {
      series_id: seriesId,
      expected_version: 1,
      scheduled_for: quando,
      contexto_snapshot: {} as never,
      tasks: [{ ordem: 1, kind: 'enviar_mensagem' as never }],
    };

    const vencedora = await noEscopo(() => seriesRepo.insertNextOccurrenceIfActive(entrada));
    expect(vencedora.occurrence, 'a primeira devia ter materializado').not.toBeNull();

    // ANTES da correção o perdedor da corrida ESTOURAVA, e a materialização da
    // próxima ocorrência falhava sempre que dois workers a disputavam.
    const perdedora = await noEscopo(() => seriesRepo.insertNextOccurrenceIfActive(entrada));
    expect(perdedora.occurrence, 'a perdedora devia ter desistido em silêncio').toBeNull();
    expect(perdedora.tasks).toEqual([]);

    const n = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM occurrences WHERE series_id = $1',
      [seriesId],
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it('CONTROLE: sem colisão, os três caminhos GRAVAM — o null não é incondicional', async () => {
    // Sem este caso, um `return null` fixo passaria nos três testes acima.
    const { outboxRepo, advanceWithTx, seriesRepo } = await import(
      '../../src/scheduling/repos.js'
    );
    const base = { kind: 'email_alert', payload: { a: 1 } };

    const a = await noEscopo(() =>
      outboxRepo.enqueue({ ...base, dedup_key: 'ctl-a' } as EntradaOutbox),
    );
    const b = await noEscopo(() =>
      advanceWithTx(async (_tx, t) =>
        t.outbox.enqueue({ ...base, dedup_key: 'ctl-b' } as EntradaOutbox),
      ),
    );
    expect(a, 'dedup_key inédita devia gravar').not.toBeNull();
    expect(b, 'dedup_key inédita devia gravar na transação também').not.toBeNull();

    const o1 = await noEscopo(() =>
      seriesRepo.insertNextOccurrenceIfActive({
        series_id: seriesId,
        expected_version: 1,
        scheduled_for: new Date('2030-02-01T12:00:00Z'),
        contexto_snapshot: {} as never,
        tasks: [{ ordem: 1, kind: 'enviar_mensagem' as never }],
      }),
    );
    const o2 = await noEscopo(() =>
      seriesRepo.insertNextOccurrenceIfActive({
        series_id: seriesId,
        expected_version: 1,
        scheduled_for: new Date('2030-03-01T12:00:00Z'),
        contexto_snapshot: {} as never,
        tasks: [{ ordem: 1, kind: 'enviar_mensagem' as never }],
      }),
    );
    expect(o1.occurrence, 'horário inédito devia materializar').not.toBeNull();
    expect(o2.occurrence, 'outro horário inédito devia materializar').not.toBeNull();
  });
});
