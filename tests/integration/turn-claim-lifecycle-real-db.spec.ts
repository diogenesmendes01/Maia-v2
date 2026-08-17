/**
 * Issue #504 — o claim visto pela FACHADA DE PRODUÇÃO, contra Postgres real.
 *
 * `turn-claim-real-db.spec.ts` prova as primitivas do repositório. Esta suíte
 * existe para uma razão diferente e complementar: provar que a fachada que o
 * runtime realmente chama — `beginTurnExecution` / `concludeTurn` de
 * `src/runtime/turns/lifecycle.ts`, o mesmo par que `src/agent/core.ts` usa —
 * está LIGADA às primitivas.
 *
 * Sem esta suíte, alguém poderia apagar a chamada de `acquireTurnLease` dentro
 * da fachada e a suíte de primitivas continuaria inteira verde: as garantias
 * existiriam no repositório e não estariam plugadas no caminho por onde o turno
 * passa. É a diferença entre "o cadeado funciona" e "o cadeado está na porta".
 *
 * A flag `FEATURE_TURN_CLAIM` é ligada por injeção no módulo de config, que é o
 * único jeito de exercitar o regime ON sem um segundo processo.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { config } from '@/config/env.js';
import { renderPrometheus } from '@/lib/metrics.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'claimlc504-tenant';
const A = 'claimlc504-agent';

let pool: pg.Pool;
const createdMensagens: string[] = [];

const inT = <T2>(fn: () => Promise<T2>): Promise<T2> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function mkTurn(): Promise<{ turn_id: string; mensagem_id: string }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [mensagem_id, T, A],
  );
  createdMensagens.push(mensagem_id);
  const { agentTurnsRepo } = await import('../../src/db/repositories.js');
  const turn = await inT(() =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: T,
      agent_id: A,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return { turn_id: turn.id, mensagem_id };
}

/**
 * Soma TODAS as séries de `maia_turn_fence_rejected_total`, qualquer que seja o
 * label.
 *
 * Somar é o ponto: um SLO e um alerta leem um counter por `sum()`, e era
 * justamente aí que a contagem dupla aparecia — as duas camadas incrementavam
 * com `operation` diferente (`to_completed` e `conclude_reply_delivered`), então
 * nenhuma série individual parecia errada e o total valia o dobro.
 *
 * Medimos DELTA em vez de zerar o registro: `_resetForTests()` também limparia
 * os gauge providers registrados no import, e uma suíte não deve derrubar a
 * observabilidade das outras que dividem o processo.
 */
async function fenceRejectedTotal(): Promise<number> {
  const text = await renderPrometheus();
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('maia_turn_fence_rejected_total')) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/** Snapshot das colunas que uma escrita sem fence corromperia. */
async function snapshotTurn(turn_id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(
    `SELECT status, outcome, state_version, attempt_count, claim_token, claimed_by,
            next_attempt_at, last_error_code
       FROM agent_turns WHERE id = $1`,
    [turn_id],
  );
  return r.rows[0] as Record<string, unknown>;
}

/** Handle como `ensureTurnHandle` o produziria para um turno recém-criado. */
function handleFor(turn_id: string) {
  return {
    turn_id,
    status: 'received' as const,
    state_version: 0,
    attempt_count: 0,
    conversa_id: null,
  };
}

d('#504 — claim ligado à fachada de ciclo de vida (DB real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [T]);
    await pool.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [A, T],
    );
    // A fachada lê as flags do `config` importado; espioná-lo é o que permite
    // exercitar o regime ON e o OFF no mesmo processo.
    vi.spyOn(config, 'FEATURE_TURN_STATE_MACHINE', 'get').mockReturnValue(true);
    vi.spyOn(config, 'FEATURE_TURN_CLAIM', 'get').mockReturnValue(true);
    // TTL curto o bastante para o teste, longo o bastante para não vencer
    // durante a própria asserção. O heartbeat respeita a razão de 1/3.
    vi.spyOn(config, 'TURN_LEASE_TTL_MS', 'get').mockReturnValue(30_000);
    vi.spyOn(config, 'TURN_LEASE_HEARTBEAT_MS', 'get').mockReturnValue(10_000);
  }, 30_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (createdMensagens.length > 0) {
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
      await pool.query(`DELETE FROM mensagens WHERE id = ANY($1::uuid[])`, [createdMensagens]);
    }
    // A auditoria de `turn_lease_lost`/`turn_fence_rejected` referencia o agente
    // por FK, então ela sai ANTES — do contrário o DELETE dos agentes viola a
    // constraint e o `afterAll` deixa a base suja exatamente como não devia.
    await pool.query(`DELETE FROM audit_log WHERE tenant_id = ANY($1::text[])`, [
      [T, 'claimlc504-outro'],
    ]);
    // Mesma razão da suíte irmã: outras suítes enumeram agentes, e um agente de
    // teste esquecido vira falha em suíte alheia.
    await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [
      [A, 'claimlc504-outro-agent'],
    ]);
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [
      [T, 'claimlc504-outro'],
    ]);
    await pool.end();
  });

  it('duas execuções concorrentes do MESMO turno: só uma recebe started:true', async () => {
    const { beginTurnExecution } = await import('@/runtime/turns/lifecycle.js');
    const { turn_id } = await mkTurn();

    // Duas réplicas acordando com o mesmo trabalho — cada uma com seu handle,
    // como aconteceria em dois processos.
    const [a, b] = await Promise.all([
      inT(() => beginTurnExecution(handleFor(turn_id))),
      inT(() => beginTurnExecution(handleFor(turn_id))),
    ]);

    const started = [a, b].filter((r) => r.started);
    expect(started, 'exatamente uma execução pode começar').toHaveLength(1);
    const blocked = [a, b].find((r) => !r.started)!;
    expect(blocked.started).toBe(false);
    // Não é erro: é a resposta correta de quem chegou depois.
    expect(!blocked.started && blocked.reason).toBe('not_claimed');

    const row = await pool.query(`SELECT status, attempt_count, claim_token FROM agent_turns WHERE id=$1`, [
      turn_id,
    ]);
    expect(row.rows[0].status).toBe('running');
    // UMA tentativa, não duas: o claim conta, o `markRunning` não recontabiliza.
    expect(Number(row.rows[0].attempt_count)).toBe(1);
    expect(row.rows[0].claim_token).toBeTruthy();
  }, 30_000);

  it('a conclusão do DONO passa; a do zumbi é recusada pelo fence', async () => {
    const { beginTurnExecution, concludeTurn } = await import('@/runtime/turns/lifecycle.js');
    const { turn_id, mensagem_id } = await mkTurn();

    const zombieHandle = handleFor(turn_id);
    const start = await inT(() => beginTurnExecution(zombieHandle));
    expect(start.started).toBe(true);
    expect(zombieHandle.lease?.token).toBeTruthy();

    // O worker "trava": a lease vence e outra réplica assume pela mesma porta.
    await pool.query(
      `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [turn_id],
    );
    const successorHandle = handleFor(turn_id);
    const takeover = await inT(() => beginTurnExecution(successorHandle));
    expect(takeover.started, 'o sucessor deveria conseguir assumir a lease vencida').toBe(true);
    expect(successorHandle.lease?.token).not.toBe(zombieHandle.lease?.token);

    // O zumbi acorda e tenta concluir com o handle antigo. É a linha que a
    // issue existe para tornar impossível.
    await inT(() => concludeTurn(zombieHandle, 'reply_delivered'));
    const afterZombie = await pool.query(
      `SELECT status, outcome FROM agent_turns WHERE id=$1`,
      [turn_id],
    );
    expect(afterZombie.rows[0].status, 'o zumbi NÃO pode concluir o turno').not.toBe('completed');
    // E a lease dele foi cancelada localmente, para o heartbeat parar de tentar.
    expect(zombieHandle.lease?.alive ?? true).toBe(false);

    // A projeção legada também não foi carimbada — se fosse, o early-return de
    // `core.ts` daria o turno por processado.
    const proj = await pool.query(`SELECT processada_em FROM mensagens WHERE id=$1`, [mensagem_id]);
    expect(proj.rows[0].processada_em).toBeNull();

    // O sucessor conclui normalmente.
    await inT(() => concludeTurn(successorHandle, 'reply_delivered'));
    const done = await pool.query(
      `SELECT status, outcome, claim_token FROM agent_turns WHERE id=$1`,
      [turn_id],
    );
    expect(done.rows[0].status).toBe('completed');
    expect(done.rows[0].outcome).toBe('reply_delivered');
    expect(done.rows[0].claim_token).toBeNull();
  }, 30_000);

  /**
   * ─── Achado P1 nº 1 da review ─────────────────────────────────────────────
   *
   * Perder a lease SEM takeover é o caso que o desenho anterior tratava pior, e
   * é o mais fácil de acontecer: o heartbeat falha duas vezes seguidas (blip de
   * rede, banco em failover), `markLost()` dispara, e o banco volta ANTES de
   * qualquer outro worker assumir. Nesse instante a linha ainda tem o NOSSO
   * `claim_token`, a lease ainda está viva no relógio do Postgres e o
   * `state_version` não andou.
   *
   * Com o fence colapsando `null` em `{}`, a conclusão seguia SEM
   * `expected_claim_token` — sobrava o CAS por `state_version`, que casava — e o
   * worker que já sabia ter perdido a posse marcava `completed`. O caminho que
   * DETECTAVA a perda era o mesmo que a tornava inofensiva.
   *
   * A asserção é sobre a LINHA, não sobre o valor de retorno: `concludeTurn` e
   * `failTurnRetryable` devolvem `void` nos dois regimes, então só o banco
   * distingue "recusou" de "gravou".
   */
  it('lease MARCADA COMO PERDIDA sem takeover: conclude/fail não alteram a linha', async () => {
    const { beginTurnExecution, concludeTurn, failTurnRetryable } = await import(
      '@/runtime/turns/lifecycle.js'
    );
    const { turn_id, mensagem_id } = await mkTurn();

    const h = handleFor(turn_id);
    expect((await inT(() => beginTurnExecution(h))).started).toBe(true);

    // A perda é LOCAL: ninguém assumiu, e o banco continua exatamente como o
    // nosso próprio claim o deixou. É o estado em que o CAS por state_version
    // ainda casaria.
    h.lease?.markLost('heartbeat_failed');
    expect(h.lease?.alive).toBe(false);
    const antes = await snapshotTurn(turn_id);
    expect(antes.status).toBe('running');
    expect(antes.claim_token, 'sem takeover, o token no banco ainda é o nosso').toBe(
      h.lease?.claim.claim_token,
    );

    await inT(() => concludeTurn(h, 'reply_delivered', { mensagem_id }));
    expect(
      await snapshotTurn(turn_id),
      'concluir depois de saber que a posse acabou é gravar sem fence',
    ).toEqual(antes);

    await inT(() => failTurnRetryable(h, { code: 'teste', mensagem_id }));
    expect(
      await snapshotTurn(turn_id),
      'agendar retry também é escrever no turno de outra tentativa',
    ).toEqual(antes);

    // E a projeção legada segue limpa — se fosse carimbada, o early-return de
    // `core.ts` daria o turno por processado para quem tem a posse.
    const proj = await pool.query(`SELECT processada_em FROM mensagens WHERE id=$1`, [mensagem_id]);
    expect(proj.rows[0].processada_em).toBeNull();
  }, 30_000);

  /**
   * A outra metade do mesmo achado: `release()` (shutdown gracioso) também
   * devolve `token === null`. Aqui a lease É vencida no banco de propósito —
   * para que um sucessor reivindique já —, então a asserção é contra o snapshot
   * TIRADO DEPOIS do release: dali em diante nada mais pode mudar por nossa
   * conta.
   */
  it('lease LIBERADA sem takeover: conclude/fail não alteram a linha', async () => {
    const { beginTurnExecution, concludeTurn, failTurnRetryable } = await import(
      '@/runtime/turns/lifecycle.js'
    );
    const { turn_id, mensagem_id } = await mkTurn();

    const h = handleFor(turn_id);
    expect((await inT(() => beginTurnExecution(h))).started).toBe(true);
    await inT(() => h.lease!.release());
    expect(h.lease?.alive).toBe(false);

    const antes = await snapshotTurn(turn_id);
    await inT(() => concludeTurn(h, 'reply_delivered', { mensagem_id }));
    expect(await snapshotTurn(turn_id), 'depois de devolver a posse não se escreve').toEqual(antes);

    await inT(() => failTurnRetryable(h, { code: 'teste', mensagem_id }));
    expect(await snapshotTurn(turn_id)).toEqual(antes);

    // Ninguém assumiu, mas o turno tem de continuar RECUPERÁVEL: a lease
    // vencida é o que permite ao sucessor reivindicá-lo no próximo tick.
    const sucessor = handleFor(turn_id);
    expect((await inT(() => beginTurnExecution(sucessor))).started).toBe(true);
    await inT(() => sucessor.lease!.release());
  }, 30_000);

  /**
   * ─── Achado P2 nº 4 da review ─────────────────────────────────────────────
   *
   * Uma escrita recusada = UM incremento. As duas camadas contavam a mesma
   * rejeição com labels diferentes, então `sum(maia_turn_fence_rejected_total)`
   * — a forma como um SLO e um alerta leem o counter — via duas rejeições para
   * um CAS recusado.
   *
   * Os dois caminhos de recusa entram no mesmo caso, de propósito: o do BANCO
   * (zumbi contra um sucessor real) e o LOCAL (a tentativa já sabe que perdeu a
   * lease e nem chega ao SQL). Se alguém devolver o incremento ao repositório,
   * o primeiro fica em 2; se alguém tirar o da camada de runtime, o segundo
   * fica em 0.
   */
  it('uma escrita recusada pelo fence = UM incremento da métrica', async () => {
    const { beginTurnExecution, concludeTurn } = await import('@/runtime/turns/lifecycle.js');

    // (a) recusa vinda do BANCO: takeover real, zumbi tenta concluir.
    const a = await mkTurn();
    const zumbi = handleFor(a.turn_id);
    expect((await inT(() => beginTurnExecution(zumbi))).started).toBe(true);
    await pool.query(
      `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [a.turn_id],
    );
    const sucessor = handleFor(a.turn_id);
    expect((await inT(() => beginTurnExecution(sucessor))).started).toBe(true);

    const antesBanco = await fenceRejectedTotal();
    await inT(() => concludeTurn(zumbi, 'reply_delivered', { mensagem_id: a.mensagem_id }));
    expect(
      (await fenceRejectedTotal()) - antesBanco,
      'um CAS recusado pelo fence tem de valer exatamente um incremento',
    ).toBe(1);
    await inT(() => sucessor.lease!.release());

    // (b) recusa LOCAL: a tentativa já sabe que a lease morreu e não vai ao SQL.
    const b = await mkTurn();
    const perdido = handleFor(b.turn_id);
    expect((await inT(() => beginTurnExecution(perdido))).started).toBe(true);
    perdido.lease?.markLost('heartbeat_failed');

    const antesLocal = await fenceRejectedTotal();
    await inT(() => concludeTurn(perdido, 'reply_delivered', { mensagem_id: b.mensagem_id }));
    expect(
      (await fenceRejectedTotal()) - antesLocal,
      'a recusa local é uma escrita recusada como qualquer outra — e uma só',
    ).toBe(1);
  }, 30_000);

  it('turno de outro escopo não é reivindicável pela fachada', async () => {
    const { beginTurnExecution } = await import('@/runtime/turns/lifecycle.js');
    const { turn_id } = await mkTurn();
    const other = await runWithTenantContext(
      { tenant_id: 'claimlc504-outro', agent_id: 'claimlc504-outro-agent' },
      async () => {
        await pool.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
          'claimlc504-outro',
        ]);
        await pool.query(
          `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
          ['claimlc504-outro-agent', 'claimlc504-outro'],
        );
        return beginTurnExecution(handleFor(turn_id));
      },
    );
    expect(other.started).toBe(false);
    const row = await pool.query(`SELECT claim_token, attempt_count FROM agent_turns WHERE id=$1`, [
      turn_id,
    ]);
    expect(row.rows[0].claim_token).toBeNull();
    expect(Number(row.rows[0].attempt_count)).toBe(0);
  }, 30_000);
});
