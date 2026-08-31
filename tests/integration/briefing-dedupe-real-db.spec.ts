/**
 * O briefing só pode sair UMA vez por dono, por período, por dia — e o que
 * garante isso é a `dedup_key`, não um lock.
 *
 * Este spec existe porque a garantia estava indefesa. Quando a #506 tirou o
 * `sendText` direto de `src/workers/briefings.ts` e passou a comprometer cada
 * aviso em `outbox_messages`, a chave `briefing:<período>:<dia>:<pessoa>`
 * virou o CLAIM do job — é ela, sobre o índice único parcial
 * `idx_outbox_dedup`, que faz duas execuções renderem um aviso só.
 *
 * Só que nenhum teste olhava para ela. Eu descobri isso do jeito certo: ao
 * reclassificar `briefing_morning`/`evening`/`weekly` de "lacuna declarada"
 * para `row-claim` no contrato de schedulers (#513 §9), rodei a sonda que
 * quebra a chave — acrescentei `Date.now()` a ela, o que desliga a
 * idempotência inteira — e a suíte ficou VERDE. Uma declaração de guard que
 * nenhum teste sustenta é pior que nenhuma declaração: ela produz confiança
 * falsa exatamente onde o contrato promete garantia.
 *
 * A asserção é sobre o LEDGER, não sobre uma chamada mockada: conta linhas em
 * `outbox_messages`. É o artefato que o drain vai ler para entregar.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'ibrief-tenant';
const A = 'ibrief-agent';

let pool: pg.Pool;

d('o briefing sai uma vez por dono, por dia — a dedup_key é o claim', () => {
  let donoId: string;

  const limpar = async (): Promise<void> => {
    await pool.query('DELETE FROM outbox_messages WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
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
    // `listTenantAgentPairsWithActiveOwner` exige tipo dono/co_dono E status
    // 'ativa' — as duas condições, senão o dispatcher nem enumera este tenant.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1, $2, 'Dona', '+5511900000021', 'dono', 'ativa') RETURNING id`,
      [T, A],
    );
    donoId = p.rows[0]!.id;
    // Canal ÚNICO ativo: `enqueueProactiveNotice` resolve o canal do agente e
    // é fail-closed em ambiguidade.
    await pool.query(
      `INSERT INTO channels(tenant_id, agent_id, external_id, channel_type, active)
       VALUES ($1, $2, 'ibrief-canal', 'whatsapp', true)`,
      [T, A],
    );
  });

  const avisosDoDono = async (): Promise<Array<{ dedup_key: string }>> => {
    const r = await pool.query<{ dedup_key: string }>(
      'SELECT dedup_key FROM outbox_messages WHERE tenant_id = $1 ORDER BY dedup_key',
      [T],
    );
    return r.rows;
  };

  it('duas execuções do briefing matinal rendem UM aviso', async () => {
    const { runMorningBriefing } = await import('../../src/workers/briefings.js');

    await runMorningBriefing();
    const depoisDaPrimeira = await avisosDoDono();
    expect(depoisDaPrimeira.length, 'a primeira execução devia ter comprometido o aviso').toBe(1);

    // A segunda é a que importa: mesmo dia, mesmo dono, mesmo período. Sem a
    // chave estável, esta linha dobra a contagem.
    await runMorningBriefing();
    const depoisDaSegunda = await avisosDoDono();
    expect(
      depoisDaSegunda.length,
      `o dono teria recebido ${depoisDaSegunda.length} briefings matinais no mesmo dia`,
    ).toBe(1);

    // E a chave é a que o contrato de schedulers declara como claim.
    const hoje = new Date().toISOString().slice(0, 10);
    expect(depoisDaSegunda[0]!.dedup_key).toBe(`briefing:morning:${hoje}:${donoId}`);
  });

  it('CONTROLE: períodos diferentes NÃO se deduplicam entre si', async () => {
    // Sem este caso, uma chave constante — que nunca deixaria nada entrar
    // depois do primeiro aviso — passaria no teste acima. E o risco é real:
    // `briefing_morning` e `briefing_weekly` disparam no MESMO horário toda
    // segunda-feira, então o período PRECISA estar na chave.
    const { runMorningBriefing, runWeeklyBriefing } = await import(
      '../../src/workers/briefings.js'
    );

    await runMorningBriefing();
    await runWeeklyBriefing();

    const avisos = await avisosDoDono();
    expect(avisos.length, 'matinal e semanal são avisos distintos').toBe(2);
    const hoje = new Date().toISOString().slice(0, 10);
    expect(avisos.map((a) => a.dedup_key).sort()).toEqual(
      [`briefing:morning:${hoje}:${donoId}`, `briefing:weekly:${hoje}:${donoId}`].sort(),
    );
  });
});
