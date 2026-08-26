/**
 * Issue #504 §"Retry, recovery e DLQ" — "deve existir comando/runbook para
 * inspeção e rearmamento manual seguro".
 *
 * ─── O defeito que esta suíte fecha ─────────────────────────────────────────
 *
 * `replayDeadLetteredTurn` (`src/runtime/turns/lifecycle.ts`) existia desde a
 * PR #567 SEM UM ÚNICO CALL SITE: nem CLI, nem rota, nem teste. Uma transição
 * `dead_letter -> queued` auditada que ninguém podia disparar é o mesmo que não
 * ter caminho de recuperação — o operador acabaria fazendo `UPDATE agent_turns`
 * à mão, que é exatamente o que a máquina de estados existe para impedir.
 *
 * O sujeito aqui é `replayTurnByOperator` (`src/ops/turn-replay.ts`), a operação
 * de produção que `scripts/dlq.ts replay-turn` invoca. O script é só parse de
 * flags e impressão; a sequência fail-closed dos três passos mora no módulo, e
 * é ela que está sob teste. Postgres e Redis são REAIS — o rearme do job é
 * metade da operação, e um mock da BullMQ não provaria que ele acontece.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomInt } from 'node:crypto';

const envAnterior = vi.hoisted(() => {
  const prev = { FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  return prev;
});

import { agentQueue, shutdownQueue } from '@/gateway/queue.js';
import { agentTurnJobId } from '@/runtime/turns/job.js';
import { replayTurnByOperator } from '@/ops/turn-replay.js';
import { TurnScopeUnresolvedError } from '@/runtime/turns/scope-resolver.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const SUFFIX = randomInt(0, 1e9).toString(36);
const T = `t504dlq-${SUFFIX}`;
const A = `a504dlq-${SUFFIX}`;
/** O par baseline, para construir o ponteiro que atravessa a fronteira. */
const OTHER_T = 'primary';
const OTHER_A = 'primary';

let pool: pg.Pool;
const mensagens: string[] = [];
const turnos: string[] = [];
const armed: string[] = [];

/**
 * A mensagem e o turno nascem na MESMA transação — ver a mesma nota em
 * `turn-job-v2-scope-real-db.spec.ts`: uma janela entre os dois INSERTs é uma
 * janela em que o `backfillBatch` de outra suíte adota a NOSSA mensagem.
 */
async function comTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Inbound + turno numa transação só. `turn_tenant`/`turn_agent` são declarados
 * à parte para permitir o ponteiro que ATRAVESSA a fronteira (o último caso
 * desta suíte); quando coincidem com os da mensagem, a row de
 * `agent_turn_inputs` também entra.
 */
async function mkInboundComTurno(args: {
  msg_tenant: string;
  msg_agent: string;
  turn_tenant: string;
  turn_agent: string;
  status: 'received' | 'dead_letter';
}): Promise<{ mensagem_id: string; turn_id: string }> {
  const mensagem_id = randomUUID();
  const turn_id = randomUUID();
  const terminal = args.status === 'dead_letter';
  mensagens.push(mensagem_id);
  turnos.push(turn_id);
  await comTx(async (c) => {
    await c.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, direcao, tipo, conteudo, metadata, processada_em)
       VALUES ($1, $2, $3, 'in', 'texto', 'oi', jsonb_build_object('whatsapp_id', $4::text), NULL)`,
      [mensagem_id, args.msg_tenant, args.msg_agent, `WAID-504DLQ-${randomInt(0, 1e9).toString(36)}`],
    );
    await c.query(
      `INSERT INTO agent_turns
         (id, tenant_id, agent_id, representative_message_id, status, outcome, attempt_count,
          dead_lettered_at, last_error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        turn_id,
        args.turn_tenant,
        args.turn_agent,
        mensagem_id,
        args.status,
        terminal ? 'retry_exhausted' : null,
        terminal ? 3 : 0,
        terminal ? new Date() : null,
        terminal ? 'reasoner_failed' : null,
      ],
    );
    if (args.turn_tenant === args.msg_tenant && args.turn_agent === args.msg_agent) {
      await c.query(
        `INSERT INTO agent_turn_inputs (tenant_id, agent_id, turn_id, mensagem_id, ingress_seq)
         VALUES ($1, $2, $3, $4, 0)`,
        [args.turn_tenant, args.turn_agent, turn_id, mensagem_id],
      );
    }
  });
  return { mensagem_id, turn_id };
}

async function readTurn(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`SELECT * FROM agent_turns WHERE id = $1`, [id]);
  return r.rows[0] as Record<string, unknown>;
}

async function countAudit(alvo_id: string, acao: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM audit_log WHERE alvo_id = $1 AND acao = $2`,
    [alvo_id, acao],
  );
  return Number(r.rows[0]?.c ?? '0');
}

d('#504 — replay manual de turno em dead_letter (Postgres + Redis reais)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(
      `INSERT INTO tenants(id, nome) VALUES ($1, 'Tenant 504 DLQ') ON CONFLICT (id) DO NOTHING`,
      [T],
    );
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome, status) VALUES ($1, $2, 'Agent 504 DLQ', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [A, T],
    );
  }, 30_000);

  afterAll(async () => {
    for (const id of armed) {
      await agentQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    if (turnos.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE alvo_id = ANY($1::uuid[])`, [turnos]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE turn_id = ANY($1::uuid[])`, [turnos]);
      await pool.query(`DELETE FROM agent_turns WHERE id = ANY($1::uuid[])`, [turnos]);
    }
    if (mensagens.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [mensagens]);
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [mensagens]);
    }
    await pool.query(`DELETE FROM agents WHERE id = $1`, [A]);
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await shutdownQueue();
    await pool.end();
  });

  it('um turno em dead_letter volta a `queued`, é AUDITADO e o job é REARMADO', async () => {
    const { turn_id } = await mkInboundComTurno({
      msg_tenant: T,
      msg_agent: A,
      turn_tenant: T,
      turn_agent: A,
      status: 'dead_letter',
    });
    armed.push(agentTurnJobId(turn_id));

    // O operador digita só o `turn_id`. Ele NÃO informa tenant: deixar o
    // operador escolher o escopo é deixar um erro de digitação virar escrita
    // cross-tenant. O par sai da linha, pelo resolvedor.
    const outcome = await replayTurnByOperator({
      turn_id,
      actor: 'teste-operador',
      reason: 'validação #504',
    });

    expect(outcome.replayed).toBe(true);
    const turn = await readTurn(turn_id);
    expect(turn.status).toBe('queued');
    expect(turn.outcome).toBeNull();
    expect(Number(turn.attempt_count)).toBe(4);
    expect(await countAudit(turn_id, 'turn_replayed')).toBe(1);

    // O rearme do TRANSPORTE. Sem ele o turno voltaria a `queued` e ficaria
    // lá: com `FEATURE_TURN_STATE_AUTHORITATIVE` desligada — o default hoje —
    // nada mais o rearmaria.
    const job = await agentQueue.getJob(agentTurnJobId(turn_id));
    expect(job, 'o job determinístico do turno deveria ter sido armado').toBeTruthy();
  }, 60_000);

  it('um turno VIVO não é replayado, e NENHUM job é armado (fail-closed)', async () => {
    const { turn_id } = await mkInboundComTurno({
      msg_tenant: T,
      msg_agent: A,
      turn_tenant: T,
      turn_agent: A,
      status: 'received',
    });
    armed.push(agentTurnJobId(turn_id));

    const outcome = await replayTurnByOperator({
      turn_id,
      actor: 'teste-operador',
      reason: 'não deveria passar',
    });

    expect(outcome.replayed).toBe(false);
    const turn = await readTurn(turn_id);
    expect(turn.status).toBe('received');
    expect(Number(turn.attempt_count)).toBe(0);
    // A ordem é a garantia: rearmar antes de olhar o resultado do CAS armaria
    // um job para um turno que outro worker pode estar executando.
    expect(await agentQueue.getJob(agentTurnJobId(turn_id))).toBeFalsy();
    expect(await countAudit(turn_id, 'turn_replayed')).toBe(0);
  }, 60_000);

  it('um turno cujo ponteiro atravessa a fronteira é RECUSADO antes de qualquer escrita', async () => {
    // Turno do par sintético apontando para a mensagem do par baseline.
    const { turn_id } = await mkInboundComTurno({
      msg_tenant: OTHER_T,
      msg_agent: OTHER_A,
      turn_tenant: T,
      turn_agent: A,
      status: 'dead_letter',
    });

    const erro = await replayTurnByOperator({
      turn_id,
      actor: 'teste-operador',
      reason: 'ponteiro cruzado',
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(TurnScopeUnresolvedError);
    expect((erro as { reason: string }).reason).toBe('scope_mismatch');
    // NADA foi escrito: o turno segue morto e nenhum job foi armado.
    expect((await readTurn(turn_id)).status).toBe('dead_letter');
    expect(await agentQueue.getJob(agentTurnJobId(turn_id))).toBeFalsy();
  }, 60_000);
});
