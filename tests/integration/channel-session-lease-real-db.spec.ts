/**
 * #513 (fatia A) — a POSSE de uma sessão de canal contra Postgres real.
 *
 * Por que só um banco de verdade prova isto. As garantias aqui NÃO estão no
 * código TypeScript: estão na PK de `channel_session_leases`, no `WHERE` do
 * `ON CONFLICT DO UPDATE` e no `now()` do PostgreSQL. Um mock devolveria
 * exatamente o que eu mandasse devolver, e a pergunta que importa — "duas
 * réplicas de verdade, disputando de verdade, produzem UM dono?" — não seria
 * feita.
 *
 * As duas réplicas são simuladas por `owner_instance_id` distintos, que é
 * exatamente o que as distingue em produção. O relógio é sempre o do banco:
 * nenhum teste aqui mexe no relógio do processo, e a expiração é forçada
 * escrevendo `lease_expires_at` no passado — a mesma coisa que o tempo faria.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'i513-tenant';
const A = 'i513-agent';
/** Duas réplicas. Em produção o que as separa é este id, e nada mais. */
const REPLICA_1 = 'replica-um:1111';
const REPLICA_2 = 'replica-dois:2222';

let pool: pg.Pool;
let mod: typeof import('../../src/gateway/channel-lease.js');

async function seedChannel(linha: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, active)
     VALUES ($1, $2, 'whatsapp', $3, true) RETURNING id`,
    [T, A, linha],
  );
  return r.rows[0]!.id;
}

/** Força o vencimento pelo BANCO — o mesmo efeito que esperar o prazo. */
async function vencerLease(channelId: string): Promise<void> {
  await pool.query(
    `UPDATE channel_session_leases
        SET lease_expires_at = now() - interval '1 second',
            acquired_at = now() - interval '1 hour'
      WHERE channel_id = $1`,
    [channelId],
  );
}

const tokenNoBanco = async (channelId: string): Promise<number> => {
  const r = await pool.query<{ t: string }>(
    'SELECT fencing_token::text AS t FROM channel_session_leases WHERE channel_id = $1',
    [channelId],
  );
  return Number(r.rows[0]!.t);
};

d('#513 — channel_session_leases (Postgres real)', () => {
  let canal: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
      T,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
      [A, T],
    );
    mod = await import('../../src/gateway/channel-lease.js');
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    // `channel_session_leases` some junto pelo ON DELETE CASCADE da FK.
    await pool.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    canal = await seedChannel(`5511${Date.now() % 100000000}`);
  });

  const escopo = (): { tenant_id: string; agent_id: string; channel_id: string } => ({
    tenant_id: T,
    agent_id: A,
    channel_id: canal,
  });

  it('duas réplicas disputando a MESMA linha produzem exatamente um dono', async () => {
    // Disparadas juntas, sem coordenação entre elas — quem serializa é o
    // PostgreSQL, sob o lock da linha em conflito.
    const [r1, r2] = await Promise.all([
      mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 }),
      mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_2 }),
    ]);

    // Invariante ABSOLUTO, não delta: exatamente uma das duas ficou com a
    // linha. Contar "quantas a mais" sobre estado global seria lavável por um
    // retry; isto não é.
    const donas = [r1, r2].filter((r) => r.held);
    expect(donas.length, 'as duas réplicas acharam que eram donas da mesma linha').toBe(1);
    expect([r1, r2].filter((r) => !r.held).length).toBe(1);

    // E o banco concorda com quem ganhou — a posse não é uma opinião do
    // processo, é a linha gravada.
    const dono = await pool.query<{ owner_instance_id: string }>(
      'SELECT owner_instance_id FROM channel_session_leases WHERE channel_id = $1',
      [canal],
    );
    expect(dono.rowCount, 'o banco guardou mais de uma posse para o mesmo canal').toBe(1);
    const vencedora = donas[0]!;
    expect(vencedora.held).toBe(true);
    expect(dono.rows[0]!.owner_instance_id).toBe(
      (vencedora as { owner_instance_id: string }).owner_instance_id,
    );
  });

  it('com a lease VIVA, a outra réplica é recusada — não há takeover antecipado', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    expect(primeira.held).toBe(true);

    const segunda = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_2 });
    expect(segunda.held).toBe(false);
    expect((segunda as { result: string }).result).toBe('held_by_other');
    expect((segunda as { held_by: string | null }).held_by).toBe(REPLICA_1);

    // A recusa não pode ter mexido na posse da primeira.
    expect(await tokenNoBanco(canal)).toBe(1);
  });

  it('depois do vencimento há takeover, e o fence AUMENTA', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    expect(primeira.held).toBe(true);
    const tokenAntigo = (primeira as { fencing_token: number }).fencing_token;

    await vencerLease(canal);

    const segunda = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_2 });
    expect(segunda.held, 'a linha órfã não foi tomada').toBe(true);
    expect((segunda as { result: string }).result).toBe('taken_over');

    const tokenNovo = (segunda as { fencing_token: number }).fencing_token;
    // ESTRITAMENTE maior. É a única propriedade que faz o fence funcionar: um
    // dono antigo tem que ser reconhecível por apresentar um token MENOR.
    expect(tokenNovo).toBeGreaterThan(tokenAntigo);
  });

  it('o dono ANTIGO não consegue renovar depois do takeover — e não estende a lease do novo', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const tokenAntigo = (primeira as { fencing_token: number }).fencing_token;
    await vencerLease(canal);
    const segunda = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_2 });
    expect(segunda.held).toBe(true);

    const prazoDoNovo = await pool.query<{ e: Date }>(
      'SELECT lease_expires_at AS e FROM channel_session_leases WHERE channel_id = $1',
      [canal],
    );

    // A réplica 1 ainda acha que é dona e bate o heartbeat com o token velho.
    const r = await mod.heartbeatChannelLease(escopo(), tokenAntigo, {
      ownerInstanceId: REPLICA_1,
    });
    expect(r, 'o dono antigo conseguiu renovar uma posse que não é mais dele').not.toBe('renewed');
    expect(r).toBe('not_owner');

    // E a batida do zumbi NÃO pode ter mexido no prazo do dono legítimo — um
    // heartbeat alheio que estende a lease é pior que um que falha.
    const depois = await pool.query<{ e: Date }>(
      'SELECT lease_expires_at AS e FROM channel_session_leases WHERE channel_id = $1',
      [canal],
    );
    expect(depois.rows[0]!.e.getTime()).toBe(prazoDoNovo.rows[0]!.e.getTime());
  });

  it('o MESMO dono com um fence VELHO é recusado — o token, não só a identidade', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const tokenAntigo = (primeira as { fencing_token: number }).fencing_token;

    // A mesma réplica reinicia rápido, reencontra a linha vencida e a retoma:
    // é um dono NOVO do ponto de vista do fence, ainda que a identidade
    // coincida. O token velho, guardado por um envio em voo, tem que morrer.
    await vencerLease(canal);
    const retomada = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    expect(retomada.held).toBe(true);
    expect((retomada as { fencing_token: number }).fencing_token).toBeGreaterThan(tokenAntigo);

    const r = await mod.heartbeatChannelLease(escopo(), tokenAntigo, {
      ownerInstanceId: REPLICA_1,
    });
    expect(r).toBe('fence_rejected');

    // E o fence de ENVIO recusa o mesmo token.
    expect(await mod.assertChannelFence(escopo(), tokenAntigo, 'send', {
      ownerInstanceId: REPLICA_1,
    })).toBe(false);
  });

  it('renovar NÃO muda o fence — senão o dono invalidaria o próprio envio em voo', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const token = (primeira as { fencing_token: number }).fencing_token;

    expect(await mod.heartbeatChannelLease(escopo(), token, { ownerInstanceId: REPLICA_1 })).toBe(
      'renewed',
    );
    expect(await tokenNoBanco(canal)).toBe(token);

    // Um `acquire` do próprio dono com lease viva também é renovação, não nova
    // posse: é o caminho do reconciliador de boot.
    const renovada = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    expect(renovada.held).toBe(true);
    expect((renovada as { result: string }).result).toBe('renewed');
    expect((renovada as { fencing_token: number }).fencing_token).toBe(token);
  });

  it('devolver a linha a libera na hora, e o fence NÃO reinicia', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const tokenAntigo = (primeira as { fencing_token: number }).fencing_token;

    expect(await mod.releaseChannelLease(escopo(), tokenAntigo, { ownerInstanceId: REPLICA_1 })).toBe(
      true,
    );

    // Sem esperar o prazo vencer — este é o deploy ordenado.
    const segunda = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_2 });
    expect(segunda.held, 'a linha devolvida continuou presa até o prazo').toBe(true);

    // O ponto do teste: o contador NÃO voltou a 1. Se `release` fizesse
    // `DELETE`, voltaria — e o token velho da réplica 1 valeria de novo.
    const tokenNovo = (segunda as { fencing_token: number }).fencing_token;
    expect(tokenNovo).toBeGreaterThan(tokenAntigo);
    expect(await mod.assertChannelFence(escopo(), tokenAntigo, 'send', {
      ownerInstanceId: REPLICA_1,
    })).toBe(false);
  });

  it('quem não é dono não consegue DEVOLVER a linha do outro', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const token = (primeira as { fencing_token: number }).fencing_token;

    expect(
      await mod.releaseChannelLease(escopo(), token, { ownerInstanceId: REPLICA_2 }),
      'uma réplica devolveu a linha que pertencia a outra',
    ).toBe(false);

    // A posse da réplica 1 segue intacta e utilizável.
    expect(await mod.assertChannelFence(escopo(), token, 'send', { ownerInstanceId: REPLICA_1 })).toBe(
      true,
    );
  });

  it('quem tem a posse VENCIDA não passa no fence de envio, mesmo sendo o dono registrado', async () => {
    const primeira = await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    const token = (primeira as { fencing_token: number }).fencing_token;
    expect(await mod.assertChannelFence(escopo(), token, 'send', { ownerInstanceId: REPLICA_1 })).toBe(
      true,
    );

    // Ninguém tomou a linha: ela só VENCEU. O relógio que decide é o do banco.
    await vencerLease(canal);

    expect(
      await mod.assertChannelFence(escopo(), token, 'send', { ownerInstanceId: REPLICA_1 }),
      'uma lease vencida ainda autorizava envio — é a janela do split-brain',
    ).toBe(false);
    expect(await mod.heartbeatChannelLease(escopo(), token, { ownerInstanceId: REPLICA_1 })).toBe(
      'expired',
    );
  });

  it('a varredura cross-tenant enxerga a linha órfã, e só ela', async () => {
    const outroCanal = await seedChannel('5511000000001');
    await mod.acquireChannelLease(escopo(), { ownerInstanceId: REPLICA_1 });
    await mod.acquireChannelLease(
      { tenant_id: T, agent_id: A, channel_id: outroCanal },
      { ownerInstanceId: REPLICA_2 },
    );
    await vencerLease(canal);

    const orfas = await mod.listarLeasesOrfas(50);
    const meus = orfas.filter((o) => o.tenant_id === T);
    expect(meus.map((o) => o.channel_id)).toEqual([canal]);
    // Cada órfã carrega o próprio escopo — quem agir sobre ela reentra no
    // tenant certo em vez de herdar o de quem varreu.
    expect(meus[0]!.tenant_id).toBe(T);
    expect(meus[0]!.agent_id).toBe(A);
  });

  it('o literal `default` nunca é dono de linha — nem pelo guard, nem pelo banco', async () => {
    await expect(
      mod.acquireChannelLease(
        { tenant_id: 'default', agent_id: A, channel_id: canal },
        { ownerInstanceId: REPLICA_1 },
      ),
    ).rejects.toThrow(/default/);

    // E, se alguém contornasse o guard, o CHECK da migration 137 recusa.
    await expect(
      pool.query(
        `INSERT INTO channel_session_leases
           (channel_id, tenant_id, agent_id, owner_instance_id, lease_expires_at)
         VALUES ($1, 'default', $2, $3, now() + interval '30 seconds')`,
        [canal, A, REPLICA_1],
      ),
    ).rejects.toThrow(/channel_session_leases_sem_default_chk/);
  });
});
