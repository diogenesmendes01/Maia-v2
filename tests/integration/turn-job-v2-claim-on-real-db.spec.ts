/**
 * Issue #504 — o caminho V2 nos DOIS regimes de `FEATURE_TURN_CLAIM`.
 *
 * `turn-job-v2-scope-real-db.spec.ts` cobre o regime OFF (o default de
 * produção hoje). Este arquivo é o mesmo par de casos com a flag LIGADA, e
 * existe porque as duas perguntas são independentes e nenhuma implica a outra:
 *
 *   - o RESOLVEDOR roda antes do claim, então a recusa cross-tenant não pode
 *     depender de uma flag de rollout para acontecer. Provar isso só com a flag
 *     OFF deixaria em aberto o cenário que o dono vai realmente ligar;
 *   - e o claim não pode passar a barrar um turno LEGÍTIMO só porque o payload
 *     virou V2 — o job novo tem de atravessar a exclusão mútua exatamente como
 *     o antigo.
 *
 * A flag é ligada por env ANTES de qualquer import içado, porque
 * `config/env.ts` congela o env no import — mesmo padrão (e mesmo motivo) de
 * `turn-claim-core-barrier-real-db.spec.ts`.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomInt } from 'node:crypto';

const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
    FEATURE_TURN_CLAIM: process.env.FEATURE_TURN_CLAIM,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  process.env.FEATURE_TURN_CLAIM = 'true';
  return prev;
});

vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));
vi.mock('../../src/gateway/queue.js', () => ({
  agentQueue: { add: vi.fn(), getJob: vi.fn() },
  startAgentWorker: vi.fn(),
  enqueueAgent: vi.fn(),
  shutdownQueue: vi.fn(),
}));
vi.mock('../../src/gateway/channel-resolver.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveChannel: async () => ({
    tenant_id: 'primary',
    agent_id: 'primary',
    channel_id: null,
  }),
}));
vi.mock('../../src/gateway/baileys.js', () => ({
  isBaileysConnected: () => false,
  getSocket: () => null,
  startBaileys: vi.fn(),
  shutdownBaileys: vi.fn(),
  triggerPairingCode: vi.fn(),
  isReactionStub: () => false,
  REACTION_STUB_TYPE: 67,
  MEDIA_ROOT: '/tmp/media',
  getLastDisconnectAt: () => null,
}));

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const VICTIM_T = 'primary';
const VICTIM_A = 'primary';
const SUFFIX = randomInt(0, 1e9).toString(36);
const ATTACKER_T = `t504v2c-${SUFFIX}`;
const ATTACKER_A = `a504v2c-${SUFFIX}`;

let pool: pg.Pool;
const mensagensCriadas: string[] = [];
const turnosCriados: string[] = [];

async function mkInbound(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, 'in', 'texto', 'oi', jsonb_build_object('whatsapp_id', $4::text), NULL)`,
    [id, tenant, agent, `WAID-504V2C-${randomInt(0, 1e9).toString(36)}`],
  );
  mensagensCriadas.push(id);
  return id;
}

async function mkTurn(args: {
  tenant: string;
  agent: string;
  representative_message_id: string;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, queued_at)
     VALUES ($1, $2, $3, $4, 'queued', now())`,
    [id, args.tenant, args.agent, args.representative_message_id],
  );
  turnosCriados.push(id);
  if (args.tenant === VICTIM_T && args.agent === VICTIM_A) {
    await pool.query(
      `INSERT INTO agent_turn_inputs (tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
       VALUES ($1, $2, $3, $4, 0) ON CONFLICT DO NOTHING`,
      [args.tenant, args.agent, id, args.representative_message_id],
    );
  }
  return id;
}

async function readProcessadaEm(mensagem_id: string): Promise<unknown> {
  const r = await pool.query(`SELECT processada_em FROM mensagens WHERE id = $1`, [mensagem_id]);
  return r.rows[0]?.processada_em ?? null;
}

async function readTurn(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

d('#504 — job V2 com FEATURE_TURN_CLAIM LIGADA (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, 'Tenant 504 V2C') ON CONFLICT (id) DO NOTHING`,
      [ATTACKER_T],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'Agent 504 V2C', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [ATTACKER_A, ATTACKER_T],
    );
  }, 30_000);

  afterAll(async () => {
    if (turnosCriados.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE alvo_id = ANY($1::uuid[])`, [turnosCriados]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE turn_id = ANY($1::uuid[])`, [
        turnosCriados,
      ]);
      await pool.query(`DELETE FROM agent_turns WHERE id = ANY($1::uuid[])`, [turnosCriados]);
    }
    if (mensagensCriadas.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
        mensagensCriadas,
      ]);
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [mensagensCriadas]);
    }
    await pool.query(`DELETE FROM agents WHERE id = $1`, [ATTACKER_A]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [ATTACKER_T]);
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  });

  it('CONTROLE: o job V2 atravessa o claim atômico e o turno recebe posse', async () => {
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    const mensagem_id = await mkInbound(VICTIM_T, VICTIM_A);
    const turn_id = await mkTurn({
      tenant: VICTIM_T,
      agent: VICTIM_A,
      representative_message_id: mensagem_id,
    });

    await runAgentTurnJob({ kind: 'v2', turn_id }, { received_at_ms: null });

    // O turno rodou de ponta a ponta, e a POSSE foi de fato tomada: sem o claim
    // o `attempt_count` ficaria em 0 e nunca teria existido `claimed_by`.
    expect(await readProcessadaEm(mensagem_id)).not.toBeNull();
    const turn = await readTurn(turn_id);
    expect(Number(turn.attempt_count)).toBe(1);
    expect(turn.claimed_by).not.toBeNull();
  }, 60_000);

  it('ADVERSARIAL: a recusa cross-tenant NÃO depende da flag — ela acontece antes do claim', async () => {
    const { runAgentTurnJob } = await import('../../src/runtime/turns/job-consumer.js');
    const { TurnScopeUnresolvedError } = await import(
      '../../src/runtime/turns/scope-resolver.js'
    );
    const vitima = await mkInbound(VICTIM_T, VICTIM_A);
    const turnoAtacante = await mkTurn({
      tenant: ATTACKER_T,
      agent: ATTACKER_A,
      representative_message_id: vitima,
    });

    const erro = await runAgentTurnJob(
      { kind: 'v2', turn_id: turnoAtacante },
      { received_at_ms: null },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(await readProcessadaEm(vitima)).toBeNull();
    expect(erro).toBeInstanceOf(TurnScopeUnresolvedError);
    expect((erro as { reason: string }).reason).toBe('scope_mismatch');
    // E o claim nem foi tentado: o turno do atacante segue intocado. É a
    // ordem que importa — o resolvedor é a PRIMEIRA porta, não a última.
    const turn = await readTurn(turnoAtacante);
    expect(Number(turn.attempt_count)).toBe(0);
    expect(turn.claim_token).toBeNull();
  }, 60_000);
});
