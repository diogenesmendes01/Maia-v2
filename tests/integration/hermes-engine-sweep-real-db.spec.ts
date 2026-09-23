/**
 * P03.7a (spec §5.6.3, §5.8.4) — VARREDURA do journal, contra Postgres REAL.
 *
 * Duas operações com naturezas opostas, e a oposição é o ponto:
 *
 *  1. `enumerateDueScopes` roda **CROSS-TENANT, sem ALS**. É a única função
 *     deste módulo que não chama `scope()` — e não pode chamar, porque
 *     `getCurrentTenant()` LANÇA fora de contexto. A pergunta "quem tem
 *     trabalho vencido?" não tem tenant para ser feita dentro, exatamente como
 *     a varredura de lease vencida da 114 e `reclaimExpiredTaskLeases`. Em
 *     troca, ela não devolve conteúdo: só o par e o cursor (§5.6.3 linha 1137).
 *  2. `listDueRuns` roda **sob ALS** e vê um tenant só. O isolamento que a
 *     primeira abre mão de ter, a segunda tem de garantir.
 *
 * O mundo é POLUÍDO de propósito: o banco local acumula runs de todas as
 * rodadas anteriores (4 escopos, milhares de linhas vencidas) e `tests/setup.ts`
 * não trunca nada. Por isso as asserções cross-tenant são de INCLUSÃO e de
 * INVARIANTE DE PAGINAÇÃO — jamais de igualdade de conjunto, que passaria ou
 * falharia por acaso conforme o lixo do dia. Ver C19.
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { engineRunsRepo } from "@/db/repositories/engine-repos.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const SHA = "a".repeat(64);

let pool: pg.Pool;

/** Escopo NOVO por caso: a visão sob ALS precisa ser limpa para ser afirmável. */
function novoEscopo(): { tenant_id: string; agent_id: string } {
  const id = randomUUID().slice(0, 8);
  return { tenant_id: `sweep-t-${id}`, agent_id: `sweep-a-${id}` };
}

const sob = <T>(
  e: { tenant_id: string; agent_id: string },
  fn: () => Promise<T>,
): Promise<T> => runWithTenantContext(e, fn);

/**
 * Tudo que este spec semeou, para o `afterAll` aposentar depois.
 *
 * Registrar na criação (e não varrer por prefixo no fim) mantém a limpeza
 * restrita ao que ESTA execução fez: um prefixo alcançaria fixtures de uma
 * rodada concorrente e apagaria trabalho alheio.
 */
const escoposCriados: Array<{ tenant_id: string; agent_id: string }> = [];

async function seedEscopo(e: {
  tenant_id: string;
  agent_id: string;
}): Promise<void> {
  await pool.query(
    "INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING",
    [e.tenant_id],
  );
  await pool.query(
    "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
    [e.agent_id, e.tenant_id],
  );
  escoposCriados.push({ tenant_id: e.tenant_id, agent_id: e.agent_id });
}

async function mkControle(e: {
  tenant_id: string;
  agent_id: string;
}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [id, e.tenant_id, e.agent_id, `stream-${id}`, randomUUID()],
  );
  return id;
}

async function mkTurnoVivo(e: {
  tenant_id: string;
  agent_id: string;
}): Promise<{ turn_id: string; claim_token: string; attempt: number }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, e.tenant_id, e.agent_id],
  );
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status,
        claim_token, claimed_by, attempt_count, lease_expires_at)
     VALUES ($1,$2,$3,$4,'running',$5,'worker-1',1, now() + interval '5 minutes')`,
    [turn_id, e.tenant_id, e.agent_id, mensagem_id, claim_token],
  );
  return { turn_id, claim_token, attempt: 1 };
}

function pedido(
  run_id: string,
  turno: { turn_id: string; claim_token: string; attempt: number },
  control_id: string,
) {
  return {
    run_id,
    turn_id: turno.turn_id,
    origin_claim_token: turno.claim_token,
    origin_turn_attempt: turno.attempt,
    origin_worker_id: "worker-1",
    control_id,
    control_epoch: "0",
    mode: "live" as const,
    manifest_digest: SHA,
    engine: "hermes" as const,
    adapter_revision: "adapter-0.1.0",
    configuration_digest: SHA,
    max_generations: 3,
    request_key: randomUUID(),
    remote_instance_id: "inst-1",
    request_json: { version: 1 },
    request_hash: SHA,
    host_context_json: { version: 1 },
    host_context_hash: SHA,
    deadline_ms: 300_000,
    reconcile_deadline_ms: 900_000,
  };
}

/**
 * Run `prepared` e VENCIDO. `next_poll_at` não é tocado por ninguém no módulo,
 * então vale o default `now()` da 140 — todo run nasce devido.
 *
 * `statusDoTurnoDepois` reproduz o cenário do §5.8.4: o turno ANDA (vai para
 * `outbound_pending` ou termina) enquanto o run continua aberto. O turno tem de
 * nascer `running`, porque `pinEngineAndPrepareRun` exige posse viva — mover
 * depois é a sequência real, não um atalho de teste.
 */
async function criarRunDevido(
  e: { tenant_id: string; agent_id: string },
  opts: { statusDoTurnoDepois?: string; outcome?: string } = {},
): Promise<{ run_id: string; turn_id: string }> {
  const turno = await mkTurnoVivo(e);
  const control_id = await mkControle(e);
  const run_id = randomUUID();
  const r = await sob(e, () =>
    engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
  );
  if (!r.ok) throw new Error(`setup: prepare falhou (${r.reason})`);
  if (opts.statusDoTurnoDepois) {
    await pool.query(
      "UPDATE agent_turns SET status = $2, outcome = $3 WHERE id = $1",
      [turno.turn_id, opts.statusDoTurnoDepois, opts.outcome ?? null],
    );
  }
  return { run_id, turn_id: turno.turn_id };
}

d("engine-repos — varredura do journal contra Postgres real", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await import('@/workers/engine-recovery.js');
  });
  /**
   * REMOVE o que este spec criou.
   *
   * Não é higiene opcional: sem isto o spec VAZA ~20 escopos por rodada, e como
   * `enumerateDueScopes` é cross-tenant, o conjunto que o caso 5 pagina cresce
   * monotonicamente. Descobri isso da pior maneira — o baseline da varredura de
   * mutação ficou vermelho quando os escopos vencidos passaram de 254, e o caso
   * 5 estourou o teto de páginas. Um teste que envenena o próprio ambiente a
   * cada execução é um teste que um dia falha por motivo nenhum.
   *
   * A ordem segue as FKs (`ON DELETE RESTRICT` em toda a cadeia do journal) e o
   * alvo é SÓ o que `seedEscopo` registrou — tenants de outras specs não são
   * tocados, e a poluição ALHEIA continua existindo, que é justamente o que os
   * casos cross-tenant precisam enfrentar.
   */
  afterAll(async () => {
    // APOSENTA o que este spec criou, em vez de APAGAR.
    //
    // Apagar é impossível por projeto, e a primeira versão desta limpeza morreu
    // provando isso: `engine_run_events` tem trigger append-only ("spec 5.6.2")
    // que recusa DELETE, e a FK RESTRICT dos eventos prende `engine_runs`
    // junto. O journal é imutável de propósito — desativar o gatilho para
    // limpar seria contornar exatamente a invariante que o P03.1 verificou.
    //
    // O AGENDAMENTO, porém, não é imutável: empurrar `next_poll_at` tira a
    // linha do conjunto "vencido", que é o que poluía `enumerateDueScopes`. O
    // journal fica inteiro e auditável; só deixa de pedir trabalho.
    //
    // Sem isto o spec vazava ~20 escopos VENCIDOS por rodada, e o caso 5 —
    // cross-tenant, paginando o mundo — começou a estourar o teto de páginas
    // depois de 254 escopos acumulados. Um teste que envenena o próprio
    // ambiente a cada execução falha um dia por motivo nenhum.
    for (const e of escoposCriados) {
      await pool.query(
        `UPDATE engine_runs
            SET next_poll_at = clock_timestamp() + interval '100 years'
          WHERE tenant_id = $1 AND agent_id = $2`,
        [e.tenant_id, e.agent_id],
      );
    }
    await pool.end();
  });

  it.each(['owner_alive', 'close_failure'])("R1 progresses beyond a persistent %s prefix across ticks and scopes", async (scenario) => {
    const { createEngineRecoveryRunner } = await import('@/workers/engine-recovery.js');
    const runEngineRecovery = createEngineRecoveryRunner();
    const close = await import('@/runtime/engines/recover-synthetic-output.js');
    const prefixes: string[] = [];
    const targets: string[] = [];
    for (let s = 0; s < 2; s++) {
      const e = novoEscopo();
      await seedEscopo(e);
      for (let i = 0; i < 4; i++) {
        const f = await criarRunDevido(e);
        await pool.query("UPDATE engine_runs SET next_poll_at=$2 WHERE id=$1", [f.run_id, `1800-01-0${i + 1}`]);
        if (i < 3) prefixes.push(f.run_id);
        else {
          targets.push(f.run_id);
          await matarLease(f.turn_id);
        }
      }
    }
    const failingTurns = (await pool.query('SELECT turn_id FROM engine_runs WHERE id=ANY($1::uuid[])', [prefixes])).rows.map(r => r.turn_id);
    const original = close.closeSyntheticHermesHandoff;
    const fault = scenario === 'close_failure' ? vi.spyOn(close, 'closeSyntheticHermesHandoff').mockImplementation(async turn => {
      if (failingTurns.includes(turn)) throw new Error('persistent close failure');
      return original(turn);
    }) : null;
    const pages = vi.spyOn(engineRunsRepo, 'listDueRuns');
    try {
      for (let tick = 0; tick < 8; tick++) {
        pages.mockClear();
        await runEngineRecovery({ scopeLimit: 1, runLimit: 2, maxPages: 1 });
        expect(pages.mock.calls.length).toBeLessThanOrEqual(1);
      }
      expect((await pool.query('SELECT phase FROM engine_runs WHERE id=ANY($1::uuid[])', [targets])).rows.map(r => r.phase)).toEqual(['blocked', 'blocked']);
      expect((await pool.query('SELECT phase,poll_count FROM engine_runs WHERE id=ANY($1::uuid[])', [prefixes])).rows).toEqual(prefixes.map(() => ({phase: 'prepared', poll_count: 0})));
    } finally {
      fault?.mockRestore();
      pages.mockRestore();
      await pool.query("UPDATE engine_runs SET next_poll_at=now()+interval '100 years' WHERE id=ANY($1::uuid[])", [[...prefixes, ...targets]]);
    }
  });

  it('R2 bounded transport allows later DB maintenance and closes sockets before returning', async () => {
    const queueModule = await import('@/gateway/queue.js');

    const { recoveryRedisTransport } = await import('../helpers/recovery-redis-transport.js');
    const transport = await recoveryRedisTransport(process.env.REDIS_URL!);
    const original = queueModule.enqueueAgentForRecovery;
    const producer = vi.spyOn(queueModule, 'enqueueAgentForRecovery').mockImplementation(data => original(data, {redisUrl: transport.url, timeoutMs: 150}));
    const e = novoEscopo();
    await seedEscopo(e);
    const first = await criarRunDevido(e);
    const later = await criarRunDevido(e);
    await matarLease(first.turn_id);
    await matarLease(later.turn_id);
    await pool.query("UPDATE engine_runs SET phase='result_ready',terminal_json='{}',terminal_hash=$2,next_poll_at='1700-01-01' WHERE id=$1", [first.run_id, SHA]);
    await pool.query("UPDATE engine_runs SET next_poll_at='1700-01-02' WHERE id=$1", [later.run_id]);
    const { createEngineRecoveryRunner } = await import('@/workers/engine-recovery.js');
    let finished = false;
    const scan = createEngineRecoveryRunner()({scopeLimit: 1,runLimit: 3,maxPages: 1}).then(() => { finished = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(transport.accepted).toBeGreaterThan(0);
      expect(finished, 'Redis wait must not retain scheduler inflight/drain').toBe(true);
      expect(transport.sockets, 'deadline must cancel actual TCP IO').toBe(0);
      expect((await pool.query('SELECT phase FROM engine_runs WHERE id=$1', [later.run_id])).rows[0].phase).toBe('blocked');
      expect((await pool.query('SELECT phase,closed_reason FROM engine_runs WHERE id=$1', [first.run_id])).rows[0]).toEqual({phase: 'result_ready',closed_reason: null});
    } finally {
      await scan;
      producer.mockRestore();
      await transport.close();
      await pool.query("UPDATE engine_runs SET next_poll_at=now()+interval '100 years' WHERE id=ANY($1::uuid[])", [[first.run_id,later.run_id]]);
    }
  });

  it("scheduler durável bloqueia submission_unknown sem replay e preserva request", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const f = await criarRunDevido(e);
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.turn_id],
    );
    await pool.query(
      "UPDATE engine_runs SET phase='submission_unknown', next_poll_at='1900-01-01' WHERE id=$1",
      [f.run_id],
    );
    const before = (
      await pool.query("SELECT request_key,request_hash FROM engine_runs WHERE id=$1", [f.run_id])
    ).rows[0];
    const { JOBS } = await import("@/workers/index.js");
    const job = JOBS.find((j) => j.name === "engine_recovery");
    expect(job, "production scheduler caller").toBeDefined();
    await (job!.fn as (options: { scopeLimit: number; maxPages: number }) => Promise<void>)({
      scopeLimit: 1,
      maxPages: 1,
    });
    const after = (
      await pool.query(
        "SELECT phase,capabilities_revoked_at,request_key,request_hash FROM engine_runs WHERE id=$1",
        [f.run_id],
      )
    ).rows[0];
    expect(after).toMatchObject({ ...before, phase: "blocked" });
    expect(after.capabilities_revoked_at).not.toBeNull();
    expect(
      (await pool.query("SELECT attempt_count FROM agent_turns WHERE id=$1", [f.turn_id])).rows[0]
        .attempt_count,
    ).toBe(1);
  });

  it.each([
    "prepared",
    "submitting",
    "running",
    "cancelling",
    "reconciling",
    "revoked_terminal",
    "effect_unknown",
  ])("maintenance failclosed: %s", async (scenario) => {
    const e = novoEscopo();
    await seedEscopo(e);
    const f = await criarRunDevido(e);
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.turn_id],
    );
    if (scenario === "revoked_terminal" || scenario === "effect_unknown") {
      await pool.query(
        "UPDATE engine_runs SET phase='result_ready',terminal_json='{}',terminal_hash=$2 WHERE id=$1",
        [f.run_id, SHA],
      );
      if (scenario === "revoked_terminal")
        await sob(e, () =>
          engineRunsRepo.revokeRunCapabilities({
            run_id: f.run_id,
            turn_id: f.turn_id,
            actor: { kind: "recovery", actor_ref: "g03-test" },
            reason_code: "test",
          }),
        );
      else
        await pool.query(
          `INSERT INTO engine_tool_calls(tenant_id,agent_id,turn_id,run_id,call_id,ordinal,tool_name,args_json,args_hash,request_id,state,effect_evidence,finished_at,result_json)
        VALUES($1,$2,$3,$4,'call-1',0,'synthetic_tool','{}',$5,$6,'effect_unknown','unknown',now(),'{}')`,
          [e.tenant_id, e.agent_id, f.turn_id, f.run_id, SHA, randomUUID()],
        );
    } else await pool.query("UPDATE engine_runs SET phase=$2 WHERE id=$1", [f.run_id, scenario]);
    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id: f.run_id,
        window_ms: 60000,
        actor: { kind: "recovery", actor_ref: "g03-test" },
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(
      await sob(e, () =>
        engineRunsRepo.reconcileReservedRun({
          run_id: f.run_id,
          reserved_row_version: r.reserved_row_version,
        }),
      ),
    ).toEqual({ kind: "blocked" });
    const row = (
      await pool.query(
        "SELECT phase,closed_reason,capabilities_revoked_at FROM engine_runs WHERE id=$1",
        [f.run_id],
      )
    ).rows[0];
    expect(row).toMatchObject({ phase: "blocked", closed_reason: null });
    expect(row.capabilities_revoked_at).not.toBeNull();
  });

  it("reserva perdida sobrevive restart; CAS atrasado e outros escopos não conciliam", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const f = await criarRunDevido(e);
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.turn_id],
    );
    const reserve = () =>
      sob(e, () =>
        engineRunsRepo.reserveMaintenanceObservation({
          run_id: f.run_id,
          window_ms: 60000,
          actor: { kind: "recovery", actor_ref: "g03-test" },
        }),
      );
    const reservations = await Promise.all([reserve(), reserve()]);
    expect(reservations.filter((r) => r.ok)).toHaveLength(1);
    const old = reservations.find((r) => r.ok)!;
    if (!old.ok) throw new Error("reservation missing");
    // Simulated process loss AFTER committed reservation, no local retry state.
    await pool.query("UPDATE engine_runs SET next_poll_at=now()-interval '1 second' WHERE id=$1", [
      f.run_id,
    ]);
    const newer = await reserve();
    if (!newer.ok) throw new Error("takeover missing");
    expect(
      await sob(e, () =>
        engineRunsRepo.reconcileReservedRun({
          run_id: f.run_id,
          reserved_row_version: old.reserved_row_version,
        }),
      ),
    ).toEqual({ kind: "stale" });
    for (const foreign of [
      { ...e, agent_id: "other-agent" },
      { ...e, tenant_id: "other-tenant" },
    ]) {
      expect(
        await sob(foreign, () =>
          engineRunsRepo.reconcileReservedRun({
            run_id: f.run_id,
            reserved_row_version: newer.reserved_row_version,
          }),
        ),
      ).toEqual({ kind: "stale" });
    }
    // A new normal owner between reservation and settlement wins.
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [f.turn_id],
    );
    expect(
      await sob(e, () =>
        engineRunsRepo.reconcileReservedRun({
          run_id: f.run_id,
          reserved_row_version: newer.reserved_row_version,
        }),
      ),
    ).toEqual({ kind: "owner_alive" });
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.turn_id],
    );
    expect(
      await sob(e, () =>
        engineRunsRepo.reconcileReservedRun({
          run_id: f.run_id,
          reserved_row_version: newer.reserved_row_version,
        }),
      ),
    ).toEqual({ kind: "blocked" });
    expect(
      await sob(e, () =>
        engineRunsRepo.reconcileReservedRun({
          run_id: f.run_id,
          reserved_row_version: newer.reserved_row_version,
        }),
      ),
    ).toEqual({ kind: "stale" });
  });

  it("terminal agenda o mesmo job BullMQ real, persistido após substituir conexão", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const f = await criarRunDevido(e);
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.turn_id],
    );
    // Transport-only fixture: core must still validate the terminal before output.
    await pool.query(
      "UPDATE engine_runs SET phase='result_ready',terminal_json='{}',terminal_hash=$2,next_poll_at='1900-01-01' WHERE id=$1",
      [f.run_id, SHA],
    );
    const { createEngineRecoveryRunner } = await import("@/workers/engine-recovery.js");
    const { agentQueue } = await import("@/gateway/queue.js");
    const { agentTurnJobId } = await import("@/runtime/turns/job.js");
    const id = agentTurnJobId(f.turn_id);
    try {
      await Promise.all([
        createEngineRecoveryRunner()({ scopeLimit: 1, maxPages: 1 }),
        createEngineRecoveryRunner()({ scopeLimit: 1, maxPages: 1 }),
      ]);
      const job = await agentQueue.getJob(id);
      expect(job?.data).toMatchObject({ turn_id: f.turn_id });
      expect(await job?.getState()).toBe("waiting");
      const { Queue } = await import("bullmq");
      const replacement = new Queue(agentQueue.name, { connection: agentQueue.opts.connection });
      try {
        expect((await replacement.getJob(id))?.data).toEqual(job?.data);
      } finally {
        await replacement.close();
      }
      expect(
        (await pool.query("SELECT phase,submit_count FROM engine_runs WHERE id=$1", [f.run_id]))
          .rows[0],
      ).toEqual({ phase: "result_ready", submit_count: 0 });
    } finally {
      await (await agentQueue.getJob(id))?.remove();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // enumerateDueScopes — CROSS-TENANT, sem ALS, sem conteúdo
  // ══════════════════════════════════════════════════════════════════════════

  /** Percorre TODAS as páginas. É o que permite afirmar algo num mundo sujo. */
  async function todosOsEscopos(
    limite = 50,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const tudo: Array<{ tenant_id: string; agent_id: string }> = [];
    let cursor = null as Awaited<
      ReturnType<typeof engineRunsRepo.enumerateDueScopes>
    >["next_cursor"];
    // O teto é ANTI-LOOP-INFINITO, não um limite de tamanho do mundo: com
    // `limite = 1` o número de páginas é o número de escopos vencidos do banco
    // INTEIRO, que não está sob controle deste spec. Um teto apertado
    // transforma "o vizinho tem muitos escopos" em falha deste teste — foi
    // exatamente o que aconteceu com 200. A mensagem diz o que foi visto, para
    // que a próxima falha seja diagnóstico e não adivinhação.
    const TETO_DE_PAGINAS = 5000;
    for (let i = 0; i < TETO_DE_PAGINAS; i++) {
      const pagina = await engineRunsRepo.enumerateDueScopes({
        limit: limite,
        cursor,
      });
      tudo.push(...pagina.scopes);
      if (!pagina.next_cursor) return tudo;
      cursor = pagina.next_cursor;
    }
    throw new Error(
      `paginação não terminou em ${TETO_DE_PAGINAS} páginas (limite=${limite}, vistos=${tudo.length})`,
    );
  }

  it("1. enumera o par com trabalho vencido (inclusão, mundo poluído)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    await criarRunDevido(e);

    const escopos = await todosOsEscopos();
    expect(
      escopos.some(
        (s) => s.tenant_id === e.tenant_id && s.agent_id === e.agent_id,
      ),
    ).toBe(true);
  });

  it("2. devolve SÓ o par — nenhum conteúdo do run (§5.6.3)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    await criarRunDevido(e);

    const escopos = await todosOsEscopos();
    const meu = escopos.find((s) => s.tenant_id === e.tenant_id);
    expect(meu).toBeDefined();
    // Chaves EXATAS: um `request_json` ou `turn_id` que vazasse aqui seria
    // conteúdo de um tenant atravessando uma varredura cross-tenant.
    expect(Object.keys(meu ?? {}).sort()).toEqual(["agent_id", "tenant_id"]);
  });

  it("3. run FECHADO não torna o par devido (fora do índice parcial)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e);
    await pool.query(
      `UPDATE engine_runs SET phase='closed', closed_at=now(), closed_reason='discarded',
              capabilities_revoked_at=now() WHERE id=$1`,
      [run_id],
    );

    const escopos = await todosOsEscopos();
    expect(escopos.some((s) => s.tenant_id === e.tenant_id)).toBe(false);
  });

  it("4. `next_poll_at` no FUTURO não é trabalho vencido", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e);
    await pool.query(
      "UPDATE engine_runs SET next_poll_at = now() + interval '1 hour' WHERE id=$1",
      [run_id],
    );

    const escopos = await todosOsEscopos();
    expect(escopos.some((s) => s.tenant_id === e.tenant_id)).toBe(false);
  });

  it("5. paginação não duplica nem pula: meu par aparece UMA vez", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    await criarRunDevido(e);
    await criarRunDevido(e);

    // Página de 1 força o cursor a trabalhar de verdade.
    const escopos = await todosOsEscopos(1);
    const meus = escopos.filter((s) => s.tenant_id === e.tenant_id);
    expect(meus).toHaveLength(1);
  });

  it("6. respeita o `limit` pedido", async () => {
    const pagina = await engineRunsRepo.enumerateDueScopes({ limit: 2 });
    expect(pagina.scopes.length).toBeLessThanOrEqual(2);
  });

  it("7. roda FORA de ALS — não chama `scope()` (cirúrgico)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    await criarRunDevido(e);

    // Sem `runWithTenantContext`. Se a implementação chamar `scope()`, isto
    // lança `MissingTenantContextError` — que é precisamente o defeito: uma
    // varredura que exige tenant não consegue descobrir tenants.
    const pagina = await engineRunsRepo.enumerateDueScopes({ limit: 50 });
    expect(Array.isArray(pagina.scopes)).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // listDueRuns — sob ALS, um tenant só
  // ══════════════════════════════════════════════════════════════════════════

  it("8. EXIGE ALS — o contraste exato do caso 7", async () => {
    await expect(engineRunsRepo.listDueRuns({ limit: 10 })).rejects.toThrow();
  });

  it("9. vê apenas o tenant corrente", async () => {
    const meu = novoEscopo();
    const outro = novoEscopo();
    await seedEscopo(meu);
    await seedEscopo(outro);
    const { run_id } = await criarRunDevido(meu);
    const alheio = await criarRunDevido(outro);

    const r = await sob(meu, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    const ids = r.runs.map((x) => x.run_id);
    expect(ids).toContain(run_id);
    expect(ids).not.toContain(alheio.run_id);
  });

  it("10. turno `outbound_pending` marca `maintenance_only` (§5.8.4 item 1)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });

    const r = await sob(e, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    const meu = r.runs.find((x) => x.run_id === run_id);
    expect(meu?.maintenance_only).toBe(true);
  });

  it("11. turno TERMINAL marca `maintenance_only`", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    // `completed` exige `outcome` de um subconjunto próprio
    // (`agent_turns_status_outcome_chk`) — inventar o valor violaria o CHECK.
    const { run_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "completed",
      outcome: "reply_delivered",
    });

    const r = await sob(e, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    expect(r.runs.find((x) => x.run_id === run_id)?.maintenance_only).toBe(
      true,
    );
  });

  it("12. turno `running` NÃO marca `maintenance_only`", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e);

    // O par dos casos 10/11: mesma consulta, turno recuperável, resultado
    // oposto. É o que prende que o marcador vem do COMPLEMENTO de
    // `RECOVERABLE_TURN_STATUSES`, e não de um literal solto.
    const r = await sob(e, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    expect(r.runs.find((x) => x.run_id === run_id)?.maintenance_only).toBe(
      false,
    );
  });

  it("13. exclui run fechado", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e);
    await pool.query(
      `UPDATE engine_runs SET phase='closed', closed_at=now(), closed_reason='discarded',
              capabilities_revoked_at=now() WHERE id=$1`,
      [run_id],
    );

    const r = await sob(e, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    expect(r.runs.map((x) => x.run_id)).not.toContain(run_id);
  });

  it("15. `next_poll_at` no futuro também não é devido SOB ALS", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id } = await criarRunDevido(e);
    await pool.query(
      "UPDATE engine_runs SET next_poll_at = now() + interval '1 hour' WHERE id=$1",
      [run_id],
    );

    // O par do caso 4, do outro lado da fronteira de ALS. Escrito ANTES da
    // varredura: sem ele, apagar a guarda de vencimento daqui não seria morto
    // por caso nenhum — o 4 cobre só a varredura cross-tenant, e as duas
    // operações têm predicados SEPARADOS que ninguém obriga a concordar.
    const r = await sob(e, () => engineRunsRepo.listDueRuns({ limit: 100 }));
    expect(r.runs.map((x) => x.run_id)).not.toContain(run_id);
  });

  it("14. pagina por `(next_poll_at, run_id)` sem duplicar", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const a = await criarRunDevido(e);
    const b = await criarRunDevido(e);
    const c = await criarRunDevido(e);

    const vistos: string[] = [];
    let cursor = null as Awaited<
      ReturnType<typeof engineRunsRepo.listDueRuns>
    >["next_cursor"];
    for (let i = 0; i < 20; i++) {
      const pagina = await sob(e, () =>
        engineRunsRepo.listDueRuns({ limit: 1, cursor }),
      );
      vistos.push(...pagina.runs.map((x) => x.run_id));
      if (!pagina.next_cursor) break;
      cursor = pagina.next_cursor;
    }
    expect(new Set(vistos).size).toBe(vistos.length);
    expect(vistos).toEqual(
      expect.arrayContaining([a.run_id, b.run_id, c.run_id]),
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 16-28: MANUTENÇÃO (P03.7b) — §5.8.4 itens 2 e 4.
  //
  // A assimetria que define esta metade: `recordStartObservation` carimba
  // observação SEMPRE no caminho do DONO, com fence de turno. A manutenção é o
  // oposto — o §5.8.4 existe justamente para quando o turno JÁ NÃO É
  // REIVINDICÁVEL, então exigir fence de turno tornaria a operação impossível
  // no único cenário em que ela serve. O fence dela é a `row_version`
  // RESERVADA, que "não é claim token de turno" (item 2, literal).
  //
  // E a reserva não precisa de coluna nova: empurrar `next_poll_at` para a
  // frente É o mecanismo de exclusão — quem vier depois vê a linha fora da
  // janela e não reserva. Os casos 17/18 prendem isso.
  // ══════════════════════════════════════════════════════════════════════════

  const JANELA_MS = 30_000;

  async function matarLease(turn_id: string): Promise<void> {
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [turn_id],
    );
  }

  it("16. reserva devolve a versão, empurra a janela e conta o poll", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{
      row_version: string;
      poll_count: number;
      vencida: boolean;
    }>(
      `SELECT row_version, poll_count, (next_poll_at <= clock_timestamp()) AS vencida
         FROM engine_runs WHERE id = $1`,
      [run_id],
    );
    if (r.ok)
      expect(Number(row.rows[0]?.row_version)).toBe(r.reserved_row_version);
    expect(row.rows[0]?.poll_count).toBe(1);
    // A janela empurrada é o que tira a linha do conjunto "vencido".
    expect(row.rows[0]?.vencida).toBe(false);
  });

  it("17. a linha reservada SAI da varredura (a janela é a exclusão)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);
    await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );

    const lista = await sob(e, () =>
      engineRunsRepo.listDueRuns({ limit: 100 }),
    );
    expect(lista.runs.map((x) => x.run_id)).not.toContain(run_id);
  });

  it("18. segunda reserva dentro da janela é recusada", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);
    const ator = { kind: "recovery" as const, actor_ref: "scanner-1" };
    await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: ator,
      }),
    );

    const segunda = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-2" },
      }),
    );
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) expect(segunda.reason).toBe("not_due");
  });

  it("19. run FECHADO não reserva", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e);
    await matarLease(turn_id);
    await pool.query(
      `UPDATE engine_runs SET phase='closed', closed_at=now(), closed_reason='discarded',
              capabilities_revoked_at=now() WHERE id=$1`,
      [run_id],
    );

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "phase_conflict") {
      expect(r.current_phase).toBe("closed");
    } else if (!r.ok) {
      throw new Error(`esperado phase_conflict, veio ${r.reason}`);
    }
  });

  it("20. DONO VIVO: adia em vez de disputar (§5.8.4 item 2)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    // Turno `running` com lease VIVA — o dono está em operação.
    const { run_id } = await criarRunDevido(e);

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("owner_alive");
  });

  it("21. lease MORTA com turno recuperável: reserva (cirúrgico do 20)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e);
    // Só a LEASE muda em relação ao caso 20. O status segue `running`.
    await matarLease(turn_id);

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("22. lease VIVA mas turno `outbound_pending`: reserva (a outra metade)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    // Só o STATUS muda em relação ao caso 20; a lease continua VIVA. Quem manda
    // num turno `outbound_pending` é o delivery worker, não o reasoner — então
    // não há "dono em operação" disputando o JOURNAL. Este par com o 21 separa
    // as duas metades do predicado; um cenário só provaria a garantia sem dizer
    // qual delas a sustenta.
    const { run_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });

    const r = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("23. grava a observação com a reserva vigente, e journala o evento", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);
    const reserva = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    if (!reserva.ok) throw new Error("setup: reserva falhou");

    const r = await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id,
        reserved_row_version: reserva.reserved_row_version,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        observation: { code: "outbox_confirmado", detail: { artefatos: 1 } },
      }),
    );
    expect(r.ok).toBe(true);

    const ev = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM engine_run_events
        WHERE run_id = $1 AND event_type = 'reconcile_decision' AND actor_kind = 'recovery'`,
      [run_id],
    );
    expect(ev.rows[0]?.n).toBe(1);
  });

  it("24. manutenção ATRASADA não sobrescreve outra (§5.8.4 item 4)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);
    const primeira = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    if (!primeira.ok) throw new Error("setup: reserva falhou");
    // Alguém mexeu na linha entre a reserva e a gravação.
    await pool.query(
      "UPDATE engine_runs SET row_version = row_version + 1 WHERE id = $1",
      [run_id],
    );

    const r = await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id,
        reserved_row_version: primeira.reserved_row_version,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        observation: { code: "tarde_demais", detail: {} },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "reservation_stale") {
      expect(r.current_row_version).toBe(primeira.reserved_row_version + 1);
    } else if (!r.ok) {
      throw new Error(`esperado reservation_stale, veio ${r.reason}`);
    }
  });

  it("25. gravar NÃO transiciona o turno (só metadata do journal)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);
    const antes = await pool.query<{ status: string; state_version: string }>(
      "SELECT status, state_version FROM agent_turns WHERE id = $1",
      [turn_id],
    );
    const reserva = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    if (!reserva.ok) throw new Error("setup: reserva falhou");
    await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id,
        reserved_row_version: reserva.reserved_row_version,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        observation: { code: "ok", detail: {} },
      }),
    );

    const depois = await pool.query<{ status: string; state_version: string }>(
      "SELECT status, state_version FROM agent_turns WHERE id = $1",
      [turn_id],
    );
    // "qualquer transição de negócio de `agent_turns` permanece na porta atual
    // autorizada" — a manutenção altera observação, nunca o turno.
    expect(depois.rows[0]?.status).toBe(antes.rows[0]?.status);
    expect(depois.rows[0]?.state_version).toBe(antes.rows[0]?.state_version);
  });

  it("26. reservar NÃO revoga capacidades (revogar é operação própria)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);

    await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );

    const row = await pool.query<{ t: string | null }>(
      "SELECT capabilities_revoked_at::text AS t FROM engine_runs WHERE id = $1",
      [run_id],
    );
    // O §5.8.4 item 3 manda revogar, mas como operação SEPARADA e monotônica
    // (P03.4). Embutir aqui esconderia a revogação dentro de uma reserva.
    expect(row.rows[0]?.t).toBeNull();
  });

  it("27. run inexistente: `not_found` tipado nas duas operações", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const fantasma = randomUUID();

    const a = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id: fantasma,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("not_found");

    const b = await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id: fantasma,
        reserved_row_version: 1,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        observation: { code: "x", detail: {} },
      }),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("not_found");
  });

  it("28. reserva de OUTRO escopo é invisível (isolamento sob ALS)", async () => {
    const meu = novoEscopo();
    const outro = novoEscopo();
    await seedEscopo(meu);
    await seedEscopo(outro);
    const alheio = await criarRunDevido(outro, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(alheio.turn_id);

    // Tentar reservar o run do vizinho ESTANDO no meu escopo tem de ser
    // `not_found`, não sucesso: o id existe, mas não para mim.
    const r = await sob(meu, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id: alheio.run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("29. gravar CARIMBA `last_observed_at` (era nulo antes)", async () => {
    const e = novoEscopo();
    await seedEscopo(e);
    const { run_id, turn_id } = await criarRunDevido(e, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(turn_id);

    // `criarRunDevido` para no prepare, e só `recordStartObservation` carimbaria
    // — então aqui a coluna nasce NULA e a transição NULL → carimbo é atribuível
    // a esta operação e a mais nenhuma.
    const antes = await pool.query<{ t: string | null }>(
      "SELECT last_observed_at::text AS t FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(antes.rows[0]?.t).toBeNull();

    const reserva = await sob(e, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    if (!reserva.ok) throw new Error("setup: reserva falhou");
    await sob(e, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id,
        reserved_row_version: reserva.reserved_row_version,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        observation: { code: "ok", detail: {} },
      }),
    );

    const depois = await pool.query<{ t: string | null }>(
      "SELECT last_observed_at::text AS t FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(depois.rows[0]?.t).not.toBeNull();
  });

  it("30. GRAVAR em outro escopo é invisível (o par do caso 28)", async () => {
    const meu = novoEscopo();
    const outro = novoEscopo();
    await seedEscopo(meu);
    await seedEscopo(outro);
    const alheio = await criarRunDevido(outro, {
      statusDoTurnoDepois: "outbound_pending",
    });
    await matarLease(alheio.turn_id);
    // Reserva LEGÍTIMA, no escopo dono — para que a versão exista de verdade e
    // o caso meça isolamento, não uma versão inventada.
    const reserva = await sob(outro, () =>
      engineRunsRepo.reserveMaintenanceObservation({
        run_id: alheio.run_id,
        window_ms: JANELA_MS,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    if (!reserva.ok) throw new Error("setup: reserva falhou");

    // O caso 28 cobre a metade que LÊ; esta é a metade que ESCREVE. Duas
    // consultas distintas, dois predicados de escopo distintos — um só caso
    // deixaria o segundo sem prova.
    const r = await sob(meu, () =>
      engineRunsRepo.recordMaintenanceObservation({
        run_id: alheio.run_id,
        reserved_row_version: reserva.reserved_row_version,
        actor: { kind: "recovery", actor_ref: "intruso" },
        observation: { code: "x", detail: {} },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });
});
