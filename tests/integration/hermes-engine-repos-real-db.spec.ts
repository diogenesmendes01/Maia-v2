/**
 * P03.2 (spec §5.6.3, §5.7.2, §5.7.3) — REPOSITÓRIO do journal, contra Postgres
 * REAL.
 *
 * O DDL da migration 140 já impede estados impossíveis. O que este arquivo mede
 * é a outra metade: as OPERAÇÕES que a spec exige serem atômicas e fenced, e o
 * que elas devolvem quando a corrida é perdida.
 *
 * As quatro regras que os casos abaixo prendem:
 *
 *  1. **Preparar um run exige posse VIVA do turno.** Claim divergente, tentativa
 *     divergente, lease vencida ou turno fora de `running` recusam — com motivo
 *     TIPADO, nunca zero-rows silencioso (§5.6.4: "Zero rows é resultado tipado").
 *  2. **Transição é compare-and-swap.** `markSubmitting` exige fase e
 *     `row_version` esperadas; perder a corrida devolve conflito com a versão
 *     corrente, não sobrescreve.
 *  3. **`remote_run_id` é atribuído UMA vez.** Aceite repetido com o mesmo id é
 *     idempotente; id diferente é conflito que leva o run a `blocked` — nunca
 *     "última escrita vence" (§5.6.2, invariante 3).
 *  4. **Terminal só entra com todas as chamadas conciliadas.** Uma tool em voo
 *     impede `result_ready`: adotar um terminal com chamada pendente é aceitar
 *     resultado de um turno cujo efeito ninguém sabe qual foi (§5.3.4).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { engineRunsRepo } from "@/db/repositories/engine-repos.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "hermes-repos-tenant";
const AGENT = "hermes-repos-agent";
const SHA = "a".repeat(64);

let pool: pg.Pool;

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, fn);

async function seedTenant(): Promise<void> {
  await pool.query(
    "INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING",
    [TENANT],
  );
  await pool.query(
    "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
    [AGENT, TENANT],
  );
}

/**
 * Turno `running` com lease viva — o único estado que autoriza preparar um run.
 *
 * `conversa_id` NULL é deliberado e é o que o inbound cru realmente parece: a
 * mensagem é persistida ANTES da resolução de identidade (ver o comentário da
 * 097 sobre `conversa_id`), então exigir uma `conversas` aqui inventaria um
 * pré-requisito que a produção não tem.
 */
async function mkTurnoVivo(
  opts: { leaseSeconds?: number; status?: string } = {},
): Promise<{
  turn_id: string;
  claim_token: string;
  attempt: number;
}> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, TENANT, AGENT],
  );
  const turn_id = randomUUID();
  const claim_token = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status,
        claim_token, claimed_by, attempt_count, lease_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'worker-1',1, now() + make_interval(secs => $7))`,
    [
      turn_id,
      TENANT,
      AGENT,
      mensagem_id,
      opts.status ?? "running",
      claim_token,
      opts.leaseSeconds ?? 300,
    ],
  );
  return { turn_id, claim_token, attempt: 1 };
}

async function mkControle(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [id, TENANT, AGENT, `stream-${id}`, randomUUID()],
  );
  return id;
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

d("engine-repos — journal de execução contra Postgres real", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("1. prepara o run sob posse viva, fixa o pin e aloca a geração 1", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();

    const r = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.phase).toBe("prepared");
    expect(r.run.generation_no).toBe(1);
    expect(r.run.row_version).toBe(0);

    const eventos = await pool.query(
      "SELECT event_type, actor_kind FROM engine_run_events WHERE run_id=$1 ORDER BY sequence_no",
      [run_id],
    );
    expect(
      eventos.rows.map((e: { event_type: string }) => e.event_type),
    ).toEqual(["prepared"]);
    expect(eventos.rows[0]?.actor_kind).toBe("turn_owner");
  });

  it("2. claim divergente, tentativa divergente e lease vencida recusam com motivo TIPADO", async () => {
    const control_id = await mkControle();

    const comClaimErrado = await mkTurnoVivo();
    const a = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun({
        ...pedido(randomUUID(), comClaimErrado, control_id),
        origin_claim_token: randomUUID(),
      }),
    );
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("stale_claim");

    const comAttemptErrado = await mkTurnoVivo();
    const b = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun({
        ...pedido(randomUUID(), comAttemptErrado, control_id),
        origin_turn_attempt: 7,
      }),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("stale_claim");

    const leaseVencida = await mkTurnoVivo({ leaseSeconds: -60 });
    const c = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(
        pedido(randomUUID(), leaseVencida, control_id),
      ),
    );
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe("stale_claim");

    const naoRodando = await mkTurnoVivo({ status: "queued" });
    const e = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(
        pedido(randomUUID(), naoRodando, control_id),
      ),
    );
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.reason).toBe("state_mismatch");
  });

  it("3. um segundo run aberto no mesmo turno é recusado pelo repositório, não pelo banco", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(
        pedido(randomUUID(), turno, control_id),
      ),
    );

    const segundo = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(
        pedido(randomUUID(), turno, control_id),
      ),
    );
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.reason).toBe("run_already_open");
  });

  it("4. markSubmitting é compare-and-swap: versão obsoleta devolve conflito com a versão corrente", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    const primeiro = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(primeiro.ok).toBe(true);
    if (primeiro.ok) {
      expect(primeiro.run.phase).toBe("submitting");
      expect(primeiro.run.submit_count).toBe(1);
      expect(primeiro.run.row_version).toBe(1);
    }

    const obsoleto = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(obsoleto.ok).toBe(false);
    if (!obsoleto.ok) {
      expect(obsoleto.reason).toBe("version_conflict");
      expect(obsoleto.current_row_version).toBe(1);
    }
  });

  it("5. aceite atribui remote_run_id uma vez; repetir o MESMO é idempotente, outro vira blocked", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );
    const sub = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(sub.ok).toBe(true);

    const remoto = `w-${randomUUID()}`;
    const aceite = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: remoto },
      }),
    );
    expect(aceite.ok).toBe(true);
    if (aceite.ok) expect(aceite.run.phase).toBe("running");

    // Redelivery do MESMO aceite: idempotente.
    const repetido = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: remoto },
      }),
    );
    expect(repetido.ok).toBe(true);

    // Outro id para a MESMA chave: conflito que BLOQUEIA, nunca sobrescrita.
    const divergente = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(divergente.ok).toBe(false);
    if (!divergente.ok) expect(divergente.reason).toBe("remote_id_conflict");

    const fase = await pool.query<{ phase: string }>(
      "SELECT phase FROM engine_runs WHERE id=$1",
      [run_id],
    );
    expect(fase.rows[0]?.phase).toBe("blocked");
  });

  it("6. submit sem prova de aceite vira submission_unknown, e a MESMA request_key é preservada", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));
    await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );

    const incerto = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "unknown", code: "transport" },
      }),
    );
    expect(incerto.ok).toBe(true);
    if (incerto.ok) expect(incerto.run.phase).toBe("submission_unknown");

    const row = await pool.query<{
      request_key: string;
      remote_run_id: string | null;
    }>("SELECT request_key, remote_run_id FROM engine_runs WHERE id=$1", [
      run_id,
    ]);
    expect(row.rows[0]?.request_key).toBe(p.request_key);
    expect(row.rows[0]?.remote_run_id).toBeNull();
  });

  it("7. terminal exige TODAS as chamadas conciliadas", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));
    await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );

    // Uma chamada EM VOO (`dispatching`): o terminal não pode ser aceito.
    await pool.query(
      `INSERT INTO engine_tool_calls (tenant_id, agent_id, turn_id, run_id, call_id, ordinal,
          tool_name, args_json, args_hash, request_id, state)
       VALUES ($1,$2,$3,$4,$5,0,'maia_fixture_echo','{}'::jsonb,$6,$7,'dispatching')`,
      [TENANT, AGENT, turno.turn_id, run_id, `${run_id}:0`, SHA, randomUUID()],
    );

    const terminal = {
      version: 1 as const,
      run_id,
      request_key: p.request_key,
      stop: { kind: "reply" as const, raw_text: "candidato" },
      iterations: 1,
      observed_tool_call_ids: [`${run_id}:0`],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cost_microusd: null,
        source: "engine_reported" as const,
      },
    };

    const emVoo = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: terminal,
      }),
    );
    expect(emVoo.ok).toBe(false);
    if (!emVoo.ok) expect(emVoo.reason).toBe("calls_unsettled");

    // Conciliada a chamada, o terminal entra e o run fica `result_ready`.
    await pool.query(
      `UPDATE engine_tool_calls SET state='completed', finished_at=now(), result_json='{"ok":true}'::jsonb
        WHERE run_id=$1`,
      [run_id],
    );
    const aceito = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: terminal,
      }),
    );
    expect(aceito.ok).toBe(true);
    if (aceito.ok) expect(aceito.run.phase).toBe("result_ready");
  });

  it("8. terminal que alega uma chamada que não existe no journal é erro de protocolo", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));
    await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );

    const mentiroso = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: {
          version: 1,
          run_id,
          request_key: p.request_key,
          stop: { kind: "reply", raw_text: "x" },
          iterations: 1,
          observed_tool_call_ids: [`${run_id}:99`],
          usage: {
            input_tokens: null,
            output_tokens: null,
            cost_microusd: null,
            source: "unavailable",
          },
        },
      }),
    );
    expect(mentiroso.ok).toBe(false);
    if (!mentiroso.ok) expect(mentiroso.reason).toBe("observed_calls_mismatch");
  });

  it("9. cross-tenant: o run de outro escopo é invisível para as operações", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    const deOutroTenant = await runWithTenantContext(
      { tenant_id: "hermes-repos-outro", agent_id: "hermes-repos-outro" },
      () =>
        engineRunsRepo.markSubmitting({
          run_id,
          turn_id: turno.turn_id,
          origin_claim_token: turno.claim_token,
          expected_row_version: 0,
        }),
    );
    expect(deOutroTenant.ok).toBe(false);
    if (!deOutroTenant.ok) expect(deOutroTenant.reason).toBe("not_found");
  });

  /**
   * Este caso existe por causa de uma MUTAÇÃO SOBREVIVENTE: trocar
   * `row_version = <esperada>` por `row_version >= 0` no CAS de `markSubmitting`
   * não quebrava nenhum teste, porque o caso 4 era carregado inteiro pela
   * guarda de fase (depois do primeiro submit a fase já não é `prepared`).
   * Ou seja: `expected_row_version` não estava sendo exercido por ninguém.
   *
   * O cenário em que a guarda de fase NÃO basta é este: alguém reserva o
   * próximo poll — `row_version` anda, a fase continua `prepared`. Quem leu o
   * run antes disso está com snapshot obsoleto, e deixá-lo vencer o CAS é
   * submeter com base em estado que já mudou (§5.6.4 exige a versão no WHERE).
   */
  it("10. CAS de versão: snapshot obsoleto é recusado mesmo com a fase ainda em `prepared`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    await pool.query(
      `UPDATE engine_runs
          SET poll_count = poll_count + 1,
              next_poll_at = now() + interval '30 seconds',
              row_version = row_version + 1,
              updated_at = now()
        WHERE id = $1`,
      [run_id],
    );

    const obsoleto = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(obsoleto.ok).toBe(false);
    if (!obsoleto.ok && obsoleto.reason === "version_conflict") {
      expect(obsoleto.current_row_version).toBe(1);
      expect(obsoleto.current_phase).toBe("prepared");
    } else if (!obsoleto.ok) {
      throw new Error(`esperado version_conflict, veio ${obsoleto.reason}`);
    }

    // E nada foi submetido: a recusa não pode ter avançado a fase nem o contador.
    const depois = await pool.query<{ phase: string; submit_count: number }>(
      "SELECT phase, submit_count FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(depois.rows[0]?.phase).toBe("prepared");
    expect(Number(depois.rows[0]?.submit_count)).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 11-17: vieram da REVISÃO INDEPENDENTE (V-018). Os dez primeiros
  // passavam, os gates estáticos passavam e a varredura de mutação dizia "sem
  // sobreviventes" — e duas operações ainda aceitavam escrita de quem não era
  // dono do run. Suíte verde não é evidência de fence.
  // ══════════════════════════════════════════════════════════════════════════

  /** Re-claim como o recovery faz: token novo, tentativa nova, lease viva. */
  async function reivindicarDeNovo(turn_id: string): Promise<string> {
    const novo = randomUUID();
    await pool.query(
      `UPDATE agent_turns
          SET claim_token = $2, attempt_count = attempt_count + 1,
              lease_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [turn_id, novo],
    );
    return novo;
  }

  async function prepararESubmeter(
    turno: { turn_id: string; claim_token: string; attempt: number },
    control_id: string,
  ): Promise<{ run_id: string; p: ReturnType<typeof pedido> }> {
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));
    await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    return { run_id, p };
  }

  function propostaDe(
    run_id: string,
    request_key: string,
    texto = "candidato",
  ) {
    return {
      version: 1 as const,
      run_id,
      request_key,
      stop: { kind: "reply" as const, raw_text: texto },
      iterations: 1,
      observed_tool_call_ids: [] as string[],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cost_microusd: null,
        source: "engine_reported" as const,
      },
    };
  }

  it("11. re-claim: o NOVO dono do turno não aceita o start do run do dono ANTIGO", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    const novoToken = await reivindicarDeNovo(turno.turn_id);

    const novoDono = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: novoToken,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(novoDono.ok).toBe(false);
    if (!novoDono.ok) expect(novoDono.reason).toBe("stale_claim");

    // E, sobretudo: nada foi escrito no run do dono antigo.
    const row = await pool.query<{
      phase: string;
      remote_run_id: string | null;
    }>("SELECT phase, remote_run_id FROM engine_runs WHERE id = $1", [run_id]);
    expect(row.rows[0]?.remote_run_id).toBeNull();
    expect(row.rows[0]?.phase).toBe("submitting");
  });

  it("12. re-claim: o NOVO dono não grava terminal no run do dono ANTIGO", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id, p } = await prepararESubmeter(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );

    const novoToken = await reivindicarDeNovo(turno.turn_id);

    const usurpado = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: novoToken,
        proposal: propostaDe(run_id, p.request_key),
      }),
    );
    expect(usurpado.ok).toBe(false);
    if (!usurpado.ok) expect(usurpado.reason).toBe("stale_claim");

    const row = await pool.query<{
      phase: string;
      terminal_hash: string | null;
    }>("SELECT phase, terminal_hash FROM engine_runs WHERE id = $1", [run_id]);
    expect(row.rows[0]?.terminal_hash).toBeNull();
    expect(row.rows[0]?.phase).toBe("running");
  });

  it("13. controle humano: com a conversa tomada, start e terminal são recusados", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id, p } = await prepararESubmeter(turno, control_id);

    // Operador assume: modo humano e epoch NOVO (o epoch é o que derrota o ABA).
    await pool.query(
      `UPDATE conversation_controls
          SET mode = 'human', control_epoch = control_epoch + 1,
              owner_app_user_id = 'operador-1', paused_at = now(),
              reason_code = 'operator_takeover', updated_at = now()
        WHERE id = $1`,
      [control_id],
    );

    const start = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(start.ok).toBe(false);

    const terminal = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: propostaDe(run_id, p.request_key),
      }),
    );
    expect(terminal.ok).toBe(false);

    // O que não pode ter acontecido: chegar em `result_ready`, que é o estado
    // que a adoção consome para produzir texto de saída.
    const row = await pool.query<{ phase: string }>(
      "SELECT phase FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.phase).not.toBe("result_ready");
  });

  it("14. prioridade: turno fora de `running` E com claim vencido é `stale_claim`, não `state_mismatch`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    // As DUAS condições ao mesmo tempo — é o único input que distingue a ordem
    // dos testes. Perda de posse tem prioridade (§5.6.4).
    await pool.query(
      `UPDATE agent_turns SET status = 'queued', claim_token = $2 WHERE id = $1`,
      [turno.turn_id, randomUUID()],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 1,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");
  });

  it("15. redelivery de terminal IDÊNTICO é idempotente (não conflito)", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id, p } = await prepararESubmeter(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    const proposta = propostaDe(run_id, p.request_key);
    const args = {
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      proposal: proposta,
    };

    const primeiro = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal(args),
    );
    expect(primeiro.ok).toBe(true);

    // §5.7.4: "Mesmo ID/hash já terminal retorna resultado persistido." Queda
    // entre o COMMIT e o retorno é caminho de recuperação ROTINEIRO.
    const redelivery = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal(args),
    );
    expect(redelivery.ok).toBe(true);
    if (redelivery.ok) expect(redelivery.run.phase).toBe("result_ready");
  });

  it("16. `handler_started` NÃO é chamada conciliada: o terminal é recusado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id, p } = await prepararESubmeter(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );

    // `handler_started` é exatamente o estado que a 140 define como "separa
    // 'não começou' de 'pode ter começado'". Tratá-lo como conciliado admite
    // terminal enquanto um efeito pode estar sendo cometido.
    await pool.query(
      `INSERT INTO engine_tool_calls (tenant_id, agent_id, turn_id, run_id, call_id, ordinal,
          tool_name, args_json, args_hash, request_id, state,
          handler_started_at, dispatch_token, reservation_token)
       VALUES ($1,$2,$3,$4,$5,0,'maia_fixture_echo','{}'::jsonb,$6,$7,'handler_started',
               now(), $8, 'res-1')`,
      [
        TENANT,
        AGENT,
        turno.turn_id,
        run_id,
        `${run_id}:0`,
        SHA,
        randomUUID(),
        randomUUID(),
      ],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: {
          ...propostaDe(run_id, p.request_key),
          observed_tool_call_ids: [`${run_id}:0`],
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("calls_unsettled");
  });

  it("17. isolamento por AGENTE dentro do mesmo tenant", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    const outroAgente = "hermes-repos-agent-2";
    await pool.query(
      "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
      [outroAgente, TENANT],
    );

    // MESMO tenant, agente diferente: o caso 9 troca os dois de uma vez e por
    // isso nunca exercitou o predicado de agent_id sozinho.
    const doOutroAgente = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: outroAgente },
      () =>
        engineRunsRepo.markSubmitting({
          run_id,
          turn_id: turno.turn_id,
          origin_claim_token: turno.claim_token,
          expected_row_version: 1,
        }),
    );
    expect(doOutroAgente.ok).toBe(false);
    if (!doOutroAgente.ok) expect(doOutroAgente.reason).toBe("not_found");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 18-24: os MUTANTES SOBREVIVENTES que a revisão listou (V-018,
  // achado 5). Nenhum destes é um defeito: a produção já fazia a coisa certa
  // em todos. Eles sobreviviam porque ninguém os testava — que é exatamente o
  // estado em que uma regra vira letra morta no próximo refactor.
  // ══════════════════════════════════════════════════════════════════════════

  /** Fecha o run respeitando o CHECK de coerência da 140. */
  async function fecharRun(run_id: string): Promise<void> {
    await pool.query(
      `UPDATE engine_runs
          SET phase = 'closed', closed_at = now(), closed_reason = 'discarded',
              capabilities_revoked_at = now(), row_version = row_version + 1,
              updated_at = now()
        WHERE id = $1`,
      [run_id],
    );
  }

  async function runRodando(
    turno: { turn_id: string; claim_token: string; attempt: number },
    control_id: string,
  ): Promise<{ run_id: string; p: ReturnType<typeof pedido> }> {
    const { run_id, p } = await prepararESubmeter(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    return { run_id, p };
  }

  it("18. terminal com `request_key` de outra execução é recusado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await runRodando(turno, control_id);

    const r = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: propostaDe(run_id, randomUUID()),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("request_key_mismatch");
  });

  it("19. terminal vindo de um run que nunca começou (`prepared`) é recusado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));

    const r = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: propostaDe(run_id, p.request_key),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("phase_conflict");
  });

  it("20. o pin do motor não muda no turno: outro adapter é `pin_conflict`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);
    await fecharRun(run_id);

    const outroMotor = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun({
        ...pedido(randomUUID(), turno, control_id),
        adapter_revision: "adapter-9.9.9",
      }),
    );
    expect(outroMotor.ok).toBe(false);
    if (!outroMotor.ok) expect(outroMotor.reason).toBe("pin_conflict");
  });

  it("21. o teto de gerações do binding é respeitado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const primeiro = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun({
        ...pedido(primeiro, turno, control_id),
        max_generations: 1,
      }),
    );
    await fecharRun(primeiro);

    const segunda = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun({
        ...pedido(randomUUID(), turno, control_id),
        max_generations: 1,
      }),
    );
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) {
      expect(segunda.reason).toBe("generations_exhausted");
      if (segunda.reason === "generations_exhausted") {
        expect(segunda.max_generations).toBe(1);
      }
    }
  });

  it("22. observação `unknown` só vale a partir de `submitting`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await runRodando(turno, control_id);

    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "unknown", code: "transport" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("phase_conflict");
  });

  it("23. capacidades revogadas impedem o submit", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );
    await pool.query(
      "UPDATE engine_runs SET capabilities_revoked_at = now() WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("capabilities_revoked");
  });

  it("24. `remote_run_id` longo no conflito devolve conflito TIPADO, não exceção", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await runRodando(turno, control_id);

    // A 140 aceita `remote_run_id` de até 512 chars, mas `dedupe_key` só 256.
    // Concatenar o id cru no dedupe estouraria o CHECK e transformaria o
    // conflito tipado numa exceção — justo no caminho que mais precisa de
    // resposta estruturada.
    const idLongo = `w-${"x".repeat(400)}`;
    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: idLongo },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("remote_id_conflict");

    const ev = await pool.query<{ dedupe_key: string }>(
      "SELECT dedupe_key FROM engine_run_events WHERE run_id = $1 AND event_type = 'submit_observed' ORDER BY sequence_no DESC LIMIT 1",
      [run_id],
    );
    expect((ev.rows[0]?.dedupe_key ?? "").length).toBeLessThanOrEqual(256);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 25-28: CIRÚRGICOS, um predicado por vez.
  //
  // Os casos 11, 12 e 13 são cenários REALISTAS — re-claim (que troca token E
  // tentativa na mesma UPDATE) e takeover (que muda modo E epoch juntos). Eles
  // provam a garantia de ponta a ponta, mas não provam QUAL predicado a
  // sustenta: removendo qualquer um dos dois, o outro ainda recusa, e a
  // varredura de mutação mostrou os quatro SOBREVIVENDO.
  //
  // Um teste que muda duas coisas ao mesmo tempo não consegue dizer qual delas
  // importou. Estes quatro mudam UMA variável cada, e é o que impede a regra de
  // apodrecer em silêncio no próximo refactor.
  // ══════════════════════════════════════════════════════════════════════════

  it("25. token rotacionado SEM avançar a tentativa: só o fence de ORIGEM recusa", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    // `attempt_count` continua 1 — igual ao `origin_turn_attempt` do run. O
    // predicado de tentativa não cobre este caso; o de origem fica sozinho.
    const soToken = randomUUID();
    await pool.query("UPDATE agent_turns SET claim_token = $2 WHERE id = $1", [
      turno.turn_id,
      soToken,
    ]);

    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: soToken,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");
  });

  it("26. tentativa avança SEM trocar o token: só o fence de TENTATIVA recusa", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    // O token continua o mesmo, então o predicado de origem passa limpo.
    await pool.query(
      "UPDATE agent_turns SET attempt_count = attempt_count + 1 WHERE id = $1",
      [turno.turn_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");
  });

  it("27. modo humano com o MESMO epoch: só o gate de MODO recusa", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    // Epoch INTACTO de propósito: o gate de epoch não cobre este caso.
    await pool.query(
      `UPDATE conversation_controls
          SET mode = 'human', owner_app_user_id = 'operador-1', paused_at = now(),
              reason_code = 'operator_takeover', updated_at = now()
        WHERE id = $1`,
      [control_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_not_bot");
  });

  it("28. epoch avança com o modo ainda `bot`: só o gate de EPOCH recusa", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const { run_id } = await prepararESubmeter(turno, control_id);

    // Modo segue `bot` — é o caso ABA que o epoch existe para derrotar: a
    // conversa foi pausada e retomada, e o run em voo é de antes.
    await pool.query(
      "UPDATE conversation_controls SET control_epoch = control_epoch + 1, updated_at = now() WHERE id = $1",
      [control_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("control_epoch_changed");
  });
});
