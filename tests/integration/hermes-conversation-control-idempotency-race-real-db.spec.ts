/**
 * Entregas CONCORRENTES do mesmo comando de controle (spec §8.2.1, §8.2.3) —
 * achado de revisão da PR #766, contra Postgres REAL.
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * Pausa e retomada consultam a chave de idempotência ANTES de trancar o
 * controle (§8.2.3 passo 2). Duas entregas simultâneas do mesmo comando passam
 * pela consulta vazias — o `FOR UPDATE` não tranca linha que ainda não existe —
 * e disputam o lock do controle. A vencedora incrementa o epoch e grava o
 * comando. A outra, ao ganhar o lock, via o epoch novo e respondia
 * `epoch_mismatch` (na pausa, com auditoria de conflito) a um comando que tinha
 * sido ACEITO. A correção relê a chave depois do lock.
 *
 * ─── Por que a intercalação é determinística ───────────────────────────────
 *
 * Nada aqui dorme torcendo pelo escalonador. Um terceiro (ou a própria primeira
 * transação) segura o lock do controle, e o teste só solta depois que o
 * Postgres CONFIRMA, por `pg_blocking_pids`, quantas sessões estão esperando
 * nele — seguindo a cadeia, porque a segunda espera atrás da primeira, não do
 * dono do lock. O mesmo padrão de `channel-line-state-real-db`.
 *
 * Skipped sem `TEST_DB_URL`, como os irmãos.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { withTx } from "@/db/client.js";
import { conversationControlRepo } from "@/db/repositories/conversation-control-repo.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "ctl-idem-race-tenant";
const AGENT = "ctl-idem-race-agent";
const OPERADOR = "operador-1";

let pool: pg.Pool;

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);

async function mkControle(mode: "bot" | "human" = "bot"): Promise<{
  control_id: string;
  stream_key: string;
}> {
  const control_id = randomUUID();
  const stream_key = `stream-${control_id}`;
  if (mode === "bot") {
    await pool.query(
      `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [control_id, TENANT, AGENT, stream_key, randomUUID()],
    );
  } else {
    await pool.query(
      `INSERT INTO conversation_controls
         (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id,
          mode, control_epoch, owner_app_user_id, paused_at, reason_code)
       VALUES ($1,$2,$3,$4,1,$5,'human',1,$6,now(),'operator_takeover')`,
      [control_id, TENANT, AGENT, stream_key, randomUUID(), OPERADOR],
    );
  }
  return { control_id, stream_key };
}

async function mkTurnoRetido(stream_key: string, ingress_seq: number): Promise<string> {
  await pool.query(
    `INSERT INTO agent_stream_sequences
       (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, agent_id, stream_key)
       DO UPDATE SET last_ingress_seq = GREATEST(
         agent_stream_sequences.last_ingress_seq, EXCLUDED.last_ingress_seq)`,
    [TENANT, AGENT, stream_key, ingress_seq],
  );
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, TENANT, AGENT],
  );
  const turn_id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns
       (id, tenant_id, agent_id, status, representative_message_id,
        stream_key, stream_key_version, first_ingress_seq, last_ingress_seq)
     VALUES ($1,$2,$3,'queued',$4,$5,1,$6,$6)`,
    [turn_id, TENANT, AGENT, mensagem_id, stream_key, ingress_seq],
  );
  return turn_id;
}

const pedidoPausa = (control_id: string, over: Record<string, unknown> = {}) => ({
  control_id,
  expected_epoch: "0",
  idempotency_key: randomUUID(),
  requested_by_app_user_id: OPERADOR,
  reason_code: "operator_takeover" as const,
  request_payload: { note: "cliente pediu atendente" },
  ...over,
});

const pedidoRetomada = (control_id: string, over: Record<string, unknown> = {}) => ({
  control_id,
  expected_epoch: "1",
  idempotency_key: randomUUID(),
  requested_by_app_user_id: OPERADOR,
  reason_code: "human_resolved" as const,
  resume_policy: "future_only" as const,
  request_payload: { nota: "atendimento concluído" },
  ...over,
});

/**
 * Espera até `quantas` sessões estarem bloqueadas, direta ou indiretamente,
 * pela de `holderPid`. A segunda entrega espera o tuple lock da primeira, então
 * contar só `holderPid = ANY(pg_blocking_pids(pid))` subcontaria.
 */
async function esperarBloqueadas(holderPid: number, quantas: number, timeoutMs = 10_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const r = await pool.query<{ n: number }>(
      `WITH RECURSIVE bloqueadas(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a
           JOIN bloqueadas b ON b.pid = ANY (pg_blocking_pids(a.pid))
       )
       SELECT count(*)::int AS n FROM bloqueadas`,
      [holderPid],
    );
    if (r.rows[0]!.n >= quantas) return;
    if (Date.now() > limite) {
      throw new Error(
        `esperava ${quantas} sessões bloqueadas pelo pid ${holderPid}, vi ${r.rows[0]!.n} — ` +
          "as entregas não chegaram a disputar o lock do controle",
      );
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Tranca o controle numa conexão à parte; devolve o pid e quem solta. */
async function segurarControle(control_id: string): Promise<{ pid: number; soltar: () => Promise<void> }> {
  const c = await pool.connect();
  await c.query("BEGIN");
  const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  await c.query("SELECT id FROM conversation_controls WHERE id = $1 FOR UPDATE", [control_id]);
  return {
    pid,
    soltar: async () => {
      try {
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    },
  };
}

async function comandosDaChave(chave: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM conversation_control_commands
      WHERE tenant_id = $1 AND agent_id = $2 AND idempotency_key = $3`,
    [TENANT, AGENT, chave],
  );
  return r.rows[0].n;
}

async function auditorias(acao: string, control_id: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE acao = $1 AND metadata->>'control_id' = $2`,
    [acao, control_id],
  );
  return r.rows[0].n;
}

async function epochDe(control_id: string): Promise<{ mode: string; control_epoch: string }> {
  const r = await pool.query(
    "SELECT mode, control_epoch::text AS control_epoch FROM conversation_controls WHERE id = $1",
    [control_id],
  );
  return r.rows[0];
}

/** Um sinal que o teste abre quando quer. */
function portao(): { aberto: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const aberto = new Promise<void>((r) => (abrir = r));
  return { aberto, abrir };
}

d("comandos de controle — entregas concorrentes da mesma chave", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 6 });
    await pool.query(
      "INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING",
      [TENANT],
    );
    await pool.query(
      "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
      [AGENT, TENANT],
    );
  });

  afterEach(async () => {
    // Turnos com stream contam na fairness GLOBAL — nada vivo fica para trás.
    for (const tabela of ["agent_turn_inputs", "agent_turns", "agent_stream_sequences", "mensagens"]) {
      await pool.query(`DELETE FROM ${tabela} WHERE tenant_id = $1`, [TENANT]);
    }
  });

  afterAll(async () => {
    // O índice de outbox dos comandos é parcial e cross-tenant: aposenta os
    // aceitos não drenados (a FK para o controle é RESTRICT, não se apaga).
    if (pool) {
      await pool.query(
        `UPDATE conversation_control_commands
            SET drain_status = 'complete', updated_at = now()
          WHERE tenant_id = $1 AND status = 'accepted'
            AND drain_status IS DISTINCT FROM 'complete'`,
        [TENANT],
      );
    }
    await pool?.end();
  });

  it("1. pausa: as duas entregas recebem o MESMO comando, e só uma o executou", async () => {
    const { control_id } = await mkControle();
    const pedido = pedidoPausa(control_id);
    const dono = await segurarControle(control_id);

    const a = noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));
    const b = noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));
    await esperarBloqueadas(dono.pid, 2);
    // As duas passaram pela consulta da chave e acharam nada.
    expect(await comandosDaChave(pedido.idempotency_key)).toBe(0);
    await dono.soltar();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(rb.command_id).toBe(ra.command_id);
    expect([ra.epoch, rb.epoch]).toEqual(["1", "1"]);
    expect([ra.idempotent, rb.idempotent].sort()).toEqual([false, true]);
    expect((await epochDe(control_id)).control_epoch).toBe("1");
    expect(await comandosDaChave(pedido.idempotency_key)).toBe(1);
    expect(await auditorias("conversation_pause_requested", control_id)).toBe(1);
    // A reentrega não é conflito: nenhuma trilha falsa de `epoch_mismatch`.
    expect(await auditorias("conversation_control_conflict", control_id)).toBe(0);
  });

  it("2. pausa na transação de quem chama: a espera termina no COMMIT dela, como replay", async () => {
    const { control_id } = await mkControle();
    const pedido = pedidoPausa(control_id);
    const segurar = portao();
    let pidDaPrimeira = 0;

    const a = noEscopo(() =>
      withTx(async (tx) => {
        const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        pidDaPrimeira = Number((pid.rows[0] as { pid: number }).pid);
        const r = await conversationControlRepo.pauseConversationInTx(tx, pedido);
        await segurar.aberto;
        return r;
      }),
    );
    for (let i = 0; pidDaPrimeira === 0 && i < 500; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    // A primeira já tem o controle trancado e o comando inserido, sem commit.
    for (let i = 0; (await comandosDaChaveVisivel(pidDaPrimeira)) === false && i < 500; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const b = noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));
    await esperarBloqueadas(pidDaPrimeira, 1);
    segurar.abrir();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.idempotent).toBe(false);
    expect(rb.idempotent).toBe(true);
    expect(rb.command_id).toBe(ra.command_id);
    expect(await auditorias("conversation_control_conflict", control_id)).toBe(0);
  });

  it("3. retomada: mesmo comando, epoch uma vez só, backlog descartado uma vez só", async () => {
    const { control_id, stream_key } = await mkControle("human");
    await mkTurnoRetido(stream_key, 1);
    const pedido = pedidoRetomada(control_id);
    const dono = await segurarControle(control_id);

    const a = noEscopo(() => conversationControlRepo.resumeConversationTx(pedido));
    const b = noEscopo(() => conversationControlRepo.resumeConversationTx(pedido));
    await esperarBloqueadas(dono.pid, 2);
    await dono.soltar();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(rb.command_id).toBe(ra.command_id);
    expect([ra.epoch, rb.epoch]).toEqual(["2", "2"]);
    expect([ra.backlog_cancelled, rb.backlog_cancelled].sort()).toEqual([0, 1]);
    expect((await epochDe(control_id)).control_epoch).toBe("2");
    expect(await auditorias("conversation_automation_resumed", control_id)).toBe(1);
  });

  it("4. mesma chave com payload DIVERGENTE, concorrentes: a perdedora é conflito, não `epoch_mismatch`", async () => {
    const { control_id } = await mkControle();
    const chave = randomUUID();
    const dono = await segurarControle(control_id);

    const a = noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(control_id, { idempotency_key: chave })),
    );
    const b = noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(control_id, { idempotency_key: chave, request_payload: { note: "OUTRA" } }),
      ),
    );
    await esperarBloqueadas(dono.pid, 2);
    await dono.soltar();

    const resultados = await Promise.all([a, b]);
    const aceitas = resultados.filter((r) => r.ok);
    const recusadas = resultados.filter((r) => !r.ok);
    expect(aceitas).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect(recusadas[0]).toMatchObject({ ok: false, reason: "payload_conflict" });
    expect((await epochDe(control_id)).control_epoch).toBe("1");
  });

  // ─── Controles: o que a releitura NÃO pode mudar ──────────────────────────

  it("5. chaves DIFERENTES no mesmo controle continuam corrida legítima: uma aceita, outra `epoch_mismatch`", async () => {
    const { control_id } = await mkControle();
    const dono = await segurarControle(control_id);

    const a = noEscopo(() => conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)));
    const b = noEscopo(() => conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)));
    await esperarBloqueadas(dono.pid, 2);
    await dono.soltar();

    const resultados = await Promise.all([a, b]);
    expect(resultados.filter((r) => r.ok)).toHaveLength(1);
    expect(resultados.find((r) => !r.ok)).toMatchObject({ ok: false, reason: "epoch_mismatch" });
    expect((await epochDe(control_id)).control_epoch).toBe("1");
  });

  it("6. se a primeira faz ROLLBACK, a que esperava é aceita como operação nova", async () => {
    const { control_id } = await mkControle();
    const pedido = pedidoPausa(control_id);
    const segurar = portao();
    let pidDaPrimeira = 0;

    const a = noEscopo(() =>
      withTx(async (tx) => {
        const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        pidDaPrimeira = Number((pid.rows[0] as { pid: number }).pid);
        await conversationControlRepo.pauseConversationInTx(tx, pedido);
        await segurar.aberto;
        throw new Error("rollback proposital");
      }),
    ).catch((e: Error) => e);
    for (let i = 0; (await comandosDaChaveVisivel(pidDaPrimeira)) === false && i < 500; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const b = noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));
    await esperarBloqueadas(pidDaPrimeira, 1);
    segurar.abrir();

    expect(await a).toBeInstanceOf(Error);
    const rb = await b;
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    expect(rb.idempotent).toBe(false);
    expect(rb.epoch).toBe("1");
    expect(await comandosDaChave(pedido.idempotency_key)).toBe(1);
  });

  it("7. residual caracterizado: mesma chave em controles DIFERENTES, concorrentes, falha FECHADA", async () => {
    // A releitura não cobre este caso: o lock é de outro controle, então a
    // segunda não espera a primeira no lock, e sim na unique da 141. Quando a
    // primeira comita, a segunda falha com 23505 e a transação dela desfaz tudo.
    // Não é desfecho tipado — é o limite registrado — mas o controle dela fica
    // intacto e nada é aceito duas vezes.
    const x = await mkControle();
    const y = await mkControle();
    const chave = randomUUID();
    const segurar = portao();
    let pidDaPrimeira = 0;

    const a = noEscopo(() =>
      withTx(async (tx) => {
        const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        pidDaPrimeira = Number((pid.rows[0] as { pid: number }).pid);
        const r = await conversationControlRepo.pauseConversationInTx(
          tx,
          pedidoPausa(x.control_id, { idempotency_key: chave }),
        );
        await segurar.aberto;
        return r;
      }),
    );
    for (let i = 0; (await comandosDaChaveVisivel(pidDaPrimeira)) === false && i < 500; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const b = noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(y.control_id, { idempotency_key: chave }),
      ),
    ).catch((e: { cause?: { code?: string } }) => e);
    await esperarBloqueadas(pidDaPrimeira, 1);
    segurar.abrir();

    const ra = await a;
    expect(ra.ok).toBe(true);
    const rb = (await b) as { cause?: { code?: string } };
    expect(rb.cause?.code).toBe("23505");
    expect(await epochDe(y.control_id)).toEqual({ mode: "bot", control_epoch: "0" });
    expect(await comandosDaChave(chave)).toBe(1);
  });
});

/**
 * Se a transação `pid` já inseriu o comando (ainda sem commit). Lê
 * `pg_locks`: o INSERT deixa a transação com lock `RowExclusiveLock` na tabela
 * de comandos, o que só acontece depois do lock do controle e do UPDATE.
 */
async function comandosDaChaveVisivel(pid: number): Promise<boolean> {
  if (pid === 0) return false;
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE l.pid = $1 AND c.relname = 'conversation_control_commands'
        AND l.mode = 'RowExclusiveLock' AND l.granted`,
    [pid],
  );
  return r.rows[0]!.n > 0;
}
