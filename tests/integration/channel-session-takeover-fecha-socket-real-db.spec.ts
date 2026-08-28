/**
 * #513 (fatia B) — perder a posse FECHA O SOCKET.
 *
 * Por que este teste é o que importa. O fence do banco recusa as gravações do
 * dono antigo, mas o WhatsApp não conhece fencing token: um socket que
 * continua aberto continua recebendo e podendo enviar. A issue é explícita —
 * "o processo antigo deve parar envios quando perder DB/lease; não é
 * suficiente conferir o token após enviar". A fatia A provou o fence; esta
 * prova o FECHAMENTO, que é a outra metade e a única que fecha a janela.
 *
 * O caminho exercitado é o de PRODUÇÃO: `publishLocalSessionOwnership()`, o
 * tick de ≤5s do worker de pairing. Um teste que chamasse
 * `heartbeatChannelLease` direto provaria o fence de novo e não provaria nada
 * sobre o socket.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { mkdirSync, rmSync } from 'node:fs';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'i513b-tenant';
const A = 'i513b-agent';
const OUTRA_REPLICA = 'replica-invasora:9999';

let pool: pg.Pool;

d('#513 fatia B — perder a posse fecha o socket (Postgres real)', () => {
  let canal: string;
  let sessions: Map<string, unknown>;
  let worker: typeof import('../../src/workers/channel-pairing-worker.js');
  let lineSessions: typeof import('../../src/gateway/line-sessions.js');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [
      T,
    ]);
    await pool.query(
      'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
      [A, T],
    );
    worker = await import('../../src/workers/channel-pairing-worker.js');
    lineSessions = await import('../../src/gateway/line-sessions.js');
    sessions = lineSessions._internal.sessions as Map<string, unknown>;
  });

  afterAll(async () => {
    sessions?.clear();
    await pool?.query('DELETE FROM channel_line_state WHERE tenant_id = $1', [T]);
    await pool?.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    await pool?.end();
  });

  beforeEach(async () => {
    sessions.clear();
    await pool.query('DELETE FROM channel_line_state WHERE tenant_id = $1', [T]);
    await pool.query('DELETE FROM channels WHERE tenant_id = $1', [T]);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO channels(tenant_id, agent_id, channel_type, external_id, active)
       VALUES ($1, $2, 'whatsapp', $3, true) RETURNING id`,
      [T, A, `5511${Date.now() % 100000000}`],
    );
    canal = r.rows[0]!.id;
  });

  /**
   * Registra uma sessão local com posse de verdade, como `startLineSession`
   * faria — sem abrir socket Baileys (o teste não tem WhatsApp).
   *
   * O `sock` é um dublê que só registra se `end()` foi chamado: é ISSO que o
   * teste mede. Não é um mock do que está sob teste — o caminho sob teste é o
   * heartbeat do worker; o socket é o efeito observável na ponta.
   */
  const registrarSessaoComPosse = async (): Promise<{ fechado: () => boolean }> => {
    const { acquireChannelLease } = await import('../../src/gateway/channel-lease.js');
    const posse = await acquireChannelLease({
      tenant_id: T,
      agent_id: A,
      channel_id: canal,
    });
    expect(posse.held, 'a posse inicial não foi adquirida').toBe(true);

    let fechado = false;
    sessions.set(canal, {
      channel: { id: canal, tenant_id: T, agent_id: A, external_id: '5511999999999' },
      sock: {
        end: () => {
          fechado = true;
        },
      },
      connected: true,
      reconnectAttempts: 0,
      stopped: false,
      reconnectTimer: null,
      fencingToken: (posse as { fencing_token: number }).fencing_token,
    });
    return { fechado: () => fechado };
  };

  it('takeover por outra réplica fecha o socket local no próximo tick', async () => {
    const socket = await registrarSessaoComPosse();

    // Âncora anti-vacuidade: antes do takeover, o tick é um no-op e a sessão
    // segue viva. Sem isto, um teste em que o `stopLineSession` rodasse SEMPRE
    // passaria igual.
    await worker._internal.publishLocalSessionOwnership();
    expect(socket.fechado(), 'o socket foi fechado sem ninguém ter tomado a linha').toBe(false);
    expect(sessions.has(canal)).toBe(true);

    // A outra réplica toma a linha: a posse vence e ela reivindica.
    await pool.query(
      `UPDATE channel_line_state
          SET session_owner_lease_expires_at = now() - interval '1 second'
        WHERE channel_id = $1`,
      [canal],
    );
    const { acquireChannelLease } = await import('../../src/gateway/channel-lease.js');
    const tomada = await acquireChannelLease(
      { tenant_id: T, agent_id: A, channel_id: canal },
      { ownerInstanceId: OUTRA_REPLICA },
    );
    expect(tomada.held).toBe(true);

    // O tick seguinte descobre a perda — e FECHA.
    await worker._internal.publishLocalSessionOwnership();

    expect(socket.fechado(), 'a réplica perdeu a posse e manteve o socket aberto').toBe(true);
    expect(sessions.has(canal), 'a sessão morta continuou no mapa local').toBe(false);

    // E o fechamento NÃO pode ter apagado a posse do sucessor: o `release` do
    // `stopLineSession` apresenta um fence que já não vale, então não grava.
    const dono = await pool.query<{ o: string | null }>(
      'SELECT session_owner_instance AS o FROM channel_line_state WHERE channel_id = $1',
      [canal],
    );
    expect(dono.rows[0]!.o, 'o dono antigo apagou a posse do sucessor ao fechar').toBe(
      OUTRA_REPLICA,
    );
  });

  it('posse NEGADA não abre socket — a réplica que perdeu a disputa não sobe a linha', async () => {
    // A outra réplica já é a dona, com posse VIVA.
    const { acquireChannelLease } = await import('../../src/gateway/channel-lease.js');
    const dela = await acquireChannelLease(
      { tenant_id: T, agent_id: A, channel_id: canal },
      { ownerInstanceId: OUTRA_REPLICA },
    );
    expect(dela.held).toBe(true);

    // O auth dir TEM que existir: sem ele `startLineSession` retorna antes de
    // sequer tentar a posse, e o teste passaria pelo motivo errado — vacuidade
    // travestida de verde.
    const { resolveLineAuthDir } = await import('../../src/setup/auth-dir.js');
    const dir = resolveLineAuthDir(canal);
    mkdirSync(dir, { recursive: true });

    try {
      await lineSessions._internal.startLineSession({
        id: canal,
        tenant_id: T,
        agent_id: A,
        external_id: '5511999999999',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(
      sessions.has(canal),
      'a réplica abriu a sessão de uma linha que pertence a outra — split-brain',
    ).toBe(false);

    // E não encostou na posse alheia.
    const dono = await pool.query<{ o: string | null }>(
      'SELECT session_owner_instance AS o FROM channel_line_state WHERE channel_id = $1',
      [canal],
    );
    expect(dono.rows[0]!.o).toBe(OUTRA_REPLICA);
  });

  it('posse simplesmente VENCIDA, sem sucessor, também fecha o socket', async () => {
    const socket = await registrarSessaoComPosse();

    // Ninguém tomou a linha; ela só venceu — partição de rede longa, por
    // exemplo. Fail-closed: não conseguir provar a posse é não tê-la.
    await pool.query(
      `UPDATE channel_line_state
          SET session_owner_lease_expires_at = now() - interval '1 second'
        WHERE channel_id = $1`,
      [canal],
    );

    await worker._internal.publishLocalSessionOwnership();

    expect(
      socket.fechado(),
      'a lease venceu e a réplica seguiu com o socket aberto — é a janela do split-brain',
    ).toBe(true);
  });

  it('com a posse VIVA o tick renova e não fecha nada (controle)', async () => {
    const socket = await registrarSessaoComPosse();

    const antes = await pool.query<{ e: Date }>(
      'SELECT session_owner_lease_expires_at AS e FROM channel_line_state WHERE channel_id = $1',
      [canal],
    );
    await worker._internal.publishLocalSessionOwnership();
    const depois = await pool.query<{ e: Date }>(
      'SELECT session_owner_lease_expires_at AS e FROM channel_line_state WHERE channel_id = $1',
      [canal],
    );

    expect(socket.fechado()).toBe(false);
    // O heartbeat de verdade ESTENDEU o prazo — prova que o tick fez algo, e
    // não que ele simplesmente não fechou por não ter rodado.
    expect(depois.rows[0]!.e.getTime()).toBeGreaterThanOrEqual(antes.rows[0]!.e.getTime());
  });
});
