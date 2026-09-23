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
import {
  computePayloadHash,
  deriveLogicalDedupeKey,
  deriveProviderIdempotencyKey,
  OUTBOUND_PAYLOAD_VERSION,
} from "@/runtime/outbound/contract.js";

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
       VALUES ($1,$2,$3,$4,$5,0,'fixture_echo','{}'::jsonb,$6,$7,'dispatching')`,
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
       VALUES ($1,$2,$3,$4,$5,0,'fixture_echo','{}'::jsonb,$6,$7,'handler_started',
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

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 29-33 (P03.4): `revokeRunCapabilities`.
  //
  // §5.6.3: "Revogação monotônica; ator dono/recovery/operador autorizado. Não
  // renova por callback ou poll." §5.7.2: lease perdida, prazo, shutdown ou
  // cancelamento autenticado revogam as capacidades.
  //
  // Decisão deliberada, com teste: a revogação **não** passa pelo gate de
  // controle da conversa. Revogar é justamente o que se quer quando um humano
  // assume — exigir `mode='bot'` aqui tornaria o botão de parada inútil na
  // única situação em que ele importa.
  // ══════════════════════════════════════════════════════════════════════════

  async function runRodandoParaRevogar(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
  }> {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );
    await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    return { run_id, turno };
  }

  it("29. o dono revoga: carimba `capabilities_revoked_at` e escreve o evento", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    const r = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "turn_owner", origin_claim_token: turno.claim_token },
        reason_code: "lease_lost",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.already).toBe(false);

    const row = await pool.query<{ capabilities_revoked_at: string | null }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.capabilities_revoked_at).not.toBeNull();

    const ev = await pool.query<{ event_type: string; actor_kind: string }>(
      "SELECT event_type, actor_kind FROM engine_run_events WHERE run_id = $1 ORDER BY sequence_no DESC LIMIT 1",
      [run_id],
    );
    expect(ev.rows[0]?.event_type).toBe("capabilities_revoked");
    expect(ev.rows[0]?.actor_kind).toBe("turn_owner");
  });

  it("30. revogação é MONOTÔNICA: a segunda não re-carimba", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    const args = {
      run_id,
      turn_id: turno.turn_id,
      actor: {
        kind: "turn_owner" as const,
        origin_claim_token: turno.claim_token,
      },
      reason_code: "lease_lost",
    };
    const primeira = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities(args),
    );
    expect(primeira.ok).toBe(true);

    const antes = await pool.query<{ capabilities_revoked_at: string }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );

    const segunda = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities(args),
    );
    expect(segunda.ok).toBe(true);
    // Idempotente e SEM re-carimbar: o instante da primeira revogação é o que
    // vale para quem for reconciliar.
    if (segunda.ok) expect(segunda.already).toBe(true);

    const depois = await pool.query<{ capabilities_revoked_at: string }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    // `::text` na query, e não anotação de tipo, é o que torna isto uma
    // comparação de STRING: o driver do Postgres devolve `timestamptz` como
    // `Date`, e dois `Date` do mesmo instante falham em `toBe` (Object.is) com
    // a mensagem mais confusa que existe — "expected X to be X". Anotar a
    // coluna como `string` no genérico não muda o que vem do banco; só mente
    // para o compilador.
    expect(depois.rows[0]?.capabilities_revoked_at).toBe(
      antes.rows[0]?.capabilities_revoked_at,
    );
  });

  it("31. dono com token errado não revoga", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    const r = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "turn_owner", origin_claim_token: randomUUID() },
        reason_code: "lease_lost",
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");

    const row = await pool.query<{ capabilities_revoked_at: string | null }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.capabilities_revoked_at).toBeNull();
  });

  it("32. recovery revoga SEM o token de origem — é outro ator, legítimo", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    // O turno foi re-reivindicado: o dono antigo sumiu. Quem reconcilia precisa
    // conseguir revogar, senão as capacidades ficam vivas para sempre.
    await pool.query(
      `UPDATE agent_turns SET claim_token = $2, attempt_count = attempt_count + 1
        WHERE id = $1`,
      [turno.turn_id, randomUUID()],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        reason_code: "lease_lost",
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ capabilities_revoked_at: string | null }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.capabilities_revoked_at).not.toBeNull();

    const ev = await pool.query<{ actor_kind: string }>(
      "SELECT actor_kind FROM engine_run_events WHERE run_id = $1 ORDER BY sequence_no DESC LIMIT 1",
      [run_id],
    );
    expect(ev.rows[0]?.actor_kind).toBe("recovery");
  });

  it("33. revogação MORDE: depois dela o submit é recusado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "operator", actor_ref: "operador-1" },
        reason_code: "operator_stop",
      }),
    );

    const submit = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    expect(submit.ok).toBe(false);
    if (!submit.ok) expect(submit.reason).toBe("capabilities_revoked");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 34-35: fecham dois mutantes que a varredura mostrou SOBREVIVENDO.
  //
  // O caso 31 passa um token aleatório, então `lockTurnAndCheckFence` recusa
  // ANTES de a checagem de origem do run rodar — ela nunca era exercida. E o
  // retorno antecipado de "já revogado" era coberto só pelo caso 30, onde a
  // guarda `IS NULL` do UPDATE também recusa.
  // ══════════════════════════════════════════════════════════════════════════

  it("34. dono do TURNO que não é a origem do RUN não revoga", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    // Re-claim: o turno agora tem dono novo e legítimo. Ele passa no fence do
    // turno — e é exatamente por isso que este caso isola a checagem de origem.
    const novoToken = randomUUID();
    await pool.query(
      `UPDATE agent_turns SET claim_token = $2, attempt_count = attempt_count + 1
        WHERE id = $1`,
      [turno.turn_id, novoToken],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "turn_owner", origin_claim_token: novoToken },
        reason_code: "lease_lost",
      }),
    );
    expect(r.ok).toBe(false);
    // NÃO é `stale_claim`: quem chamou é dono do turno. O que falta é ser a
    // origem do run — e a razão não promete estado de turno que não foi lido.
    if (!r.ok) expect(r.reason).toBe("not_run_origin");

    const row = await pool.query<{ capabilities_revoked_at: string | null }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.capabilities_revoked_at).toBeNull();
  });

  it("35. carimbo posto por outro escritor: o retorno antecipado devolve o instante ORIGINAL", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    // Alguém revogou por fora (outro processo, um incidente no psql). O UPDATE
    // com `IS NULL` casaria zero linhas de qualquer jeito; quem responde aqui é
    // a leitura antecipada — e ela tem de devolver o carimbo que já existe.
    await pool.query(
      "UPDATE engine_runs SET capabilities_revoked_at = now() - interval '1 hour' WHERE id = $1",
      [run_id],
    );
    const antes = await pool.query<{ capabilities_revoked_at: string }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "turn_owner", origin_claim_token: turno.claim_token },
        reason_code: "lease_lost",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.already).toBe(true);
      expect(r.revoked_at).toBe(antes.rows[0]?.capabilities_revoked_at);
    }

    const depois = await pool.query<{ capabilities_revoked_at: string }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(depois.rows[0]?.capabilities_revoked_at).toBe(
      antes.rows[0]?.capabilities_revoked_at,
    );
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 36-42 (P03.5): `markRunBlocked` e `resolveBlockedRun`.
  //
  // Contrato normativo mínimo (ver C17): §5.6.3 "guarda evidência, auditoria e
  // decisão humana; nenhuma liberação automática por TTL"; §5.7.2 "operador
  // apresenta decisão/evidência suficiente → closed/manual_resolved; só então
  // replay explicitamente autorizado".
  //
  // A regra que dá sentido a `blocked`: ela PRESERVA a trava contra nova
  // geração (§5.6.2 invariante 7) — um run bloqueado continua ocupando a unique
  // parcial, então ninguém abre outra deliberação no mesmo turno por baixo.
  //
  // Os casos 41 e 42 são cirúrgicos DE SAÍDA, escritos antes da varredura: o
  // cenário "resolver duas vezes" moveria fase e versão juntas, que é como
  // BM3/BM4, CM7 e EM3 sobreviveram.
  // ══════════════════════════════════════════════════════════════════════════

  it("36. bloqueia um run aberto, guardando o motivo e o evento", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    const r = await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { call_id: `${run_id}:0`, motivo: "handler sem resultado" },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ phase: string; last_error_code: string }>(
      "SELECT phase, last_error_code FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.phase).toBe("blocked");
    expect(row.rows[0]?.last_error_code).toBe("effect_unreconciled");

    const ev = await pool.query<{ event_type: string; actor_kind: string }>(
      "SELECT event_type, actor_kind FROM engine_run_events WHERE run_id = $1 ORDER BY sequence_no DESC LIMIT 1",
      [run_id],
    );
    expect(ev.rows[0]?.event_type).toBe("reconcile_decision");
    expect(ev.rows[0]?.actor_kind).toBe("recovery");
  });

  it("37. `blocked` PRESERVA a trava: nenhuma geração nova no mesmo turno", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "efeito incerto" },
      }),
    );

    // A unique parcial da 140 cobre `phase <> 'closed'`, e `blocked` não é
    // `closed` — é isso que impede abrir outra deliberação por baixo.
    const control_id = await mkControle();
    const outro = await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(
        pedido(randomUUID(), turno, control_id),
      ),
    );
    expect(outro.ok).toBe(false);
    if (!outro.ok) expect(outro.reason).toBe("run_already_open");
  });

  it("38. resolver EXIGE decisão e evidência do operador — sem elas, recusa", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "efeito incerto" },
      }),
    );

    const semDecisao = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "",
        decision: "manual_resolved",
        evidence: { conferido: true },
      }),
    );
    expect(semDecisao.ok).toBe(false);
    if (!semDecisao.ok) expect(semDecisao.reason).toBe("operator_required");

    const semEvidencia = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: {},
      }),
    );
    expect(semEvidencia.ok).toBe(false);
    if (!semEvidencia.ok) expect(semEvidencia.reason).toBe("evidence_required");

    // Nada de liberação por tempo: o run segue bloqueado.
    const row = await pool.query<{ phase: string }>(
      "SELECT phase FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.phase).toBe("blocked");
  });

  it("39. com operador e evidência, fecha em `manual_resolved` — e a 140 exige revogação junto", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "efeito incerto" },
      }),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: { conferido_em: "destino", resultado: "efeito confirmado" },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{
      phase: string;
      closed_reason: string | null;
      closed_at: string | null;
      capabilities_revoked_at: string | null;
    }>(
      `SELECT phase, closed_reason, closed_at::text AS closed_at,
              capabilities_revoked_at::text AS capabilities_revoked_at
         FROM engine_runs WHERE id = $1`,
      [run_id],
    );
    expect(row.rows[0]?.phase).toBe("closed");
    expect(row.rows[0]?.closed_reason).toBe("manual_resolved");
    // O CHECK da 140 exige os três juntos: fechar sem revogar é impossível.
    expect(row.rows[0]?.closed_at).not.toBeNull();
    expect(row.rows[0]?.capabilities_revoked_at).not.toBeNull();
  });

  it("40. resolver um run que NÃO está bloqueado é recusado", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    const r = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: { conferido: true },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("phase_conflict");
  });

  it("41. fase errada com a versão CERTA: só a guarda de FASE recusa", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "x" },
      }),
    );
    const v = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_runs WHERE id = $1",
      [run_id],
    );

    // Sai de `blocked` SEM mexer em `row_version`.
    await pool.query(
      "UPDATE engine_runs SET phase = 'reconciling' WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: { conferido: true },
        expected_row_version: Number(v.rows[0]?.row_version),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("phase_conflict");
  });

  it("42. versão errada com a fase CERTA: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "x" },
      }),
    );
    const v = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_runs WHERE id = $1",
      [run_id],
    );

    await pool.query(
      "UPDATE engine_runs SET row_version = row_version + 1 WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: { conferido: true },
        expected_row_version: Number(v.rows[0]?.row_version),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(Number(v.rows[0]?.row_version) + 1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 43-45: os três mutantes que a varredura mostrou SOBREVIVENDO — e os
  // três eram caminho SEM TESTE, não redundância.
  // ══════════════════════════════════════════════════════════════════════════

  /** Bloqueia e resolve, deixando o run em `closed`. */
  async function runFechadoPorOperador(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
  }> {
    const { run_id, turno } = await runRodandoParaRevogar();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "efeito incerto" },
      }),
    );
    const r = await noEscopo(() =>
      engineRunsRepo.resolveBlockedRun({
        run_id,
        turn_id: turno.turn_id,
        operator_ref: "operador-1",
        decision: "manual_resolved",
        evidence: { conferido: true },
      }),
    );
    if (!r.ok) throw new Error("setup: resolveBlockedRun falhou");
    return { run_id, turno };
  }

  it("43. run já FECHADO não volta a ser bloqueado", async () => {
    const { run_id, turno } = await runFechadoPorOperador();

    const r = await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "operator", actor_ref: "operador-2" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "tentativa tardia" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already_closed");

    // Reabrir a trava depois do fechamento inventaria uma geração encerrada.
    const row = await pool.query<{ phase: string; closed_reason: string }>(
      "SELECT phase, closed_reason FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.phase).toBe("closed");
    expect(row.rows[0]?.closed_reason).toBe("manual_resolved");
  });

  it("44. evidência acima do teto é recusada TIPADA, não estourando a TX", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();

    // `engine_run_events.metadata_json` tem CHECK de 16 KiB na 140. Sem o teto
    // na operação, isto viraria violação de CHECK DENTRO da transação — recusa
    // tipada trocada por exceção, o mesmo defeito que o hash do receipt tinha.
    const enorme = { dump: "x".repeat(9000) };

    const r = await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: enorme,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("evidence_too_large");

    const row = await pool.query<{ phase: string }>(
      "SELECT phase FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.phase).not.toBe("blocked");
  });

  it("45. bloquear AVANÇA `row_version` — é o que invalida um CAS em voo", async () => {
    const { run_id, turno } = await runRodandoParaRevogar();
    const antes = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_runs WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "recovery", actor_ref: "scanner-1" },
        error_code: "effect_unreconciled",
        evidence: { motivo: "efeito incerto" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row_version).toBe(Number(antes.rows[0]?.row_version) + 1);
    }

    // O ponto não é contabilidade: quem estava com a versão velha em voo tem de
    // perder o CAS depois que o run foi bloqueado embaixo dele.
    const casEmVoo = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: Number(antes.rows[0]?.row_version),
      }),
    );
    expect(casEmVoo.ok).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 46-52 (P03.6a): `adoptTerminalResult`.
  //
  // O `engine_runs_adopted_chk` diz no próprio comentário o que está em jogo:
  // entregar ou concluir sem resposta exige terminal E dono que adotou — "é o
  // que impede 'fechei o run' virar sinônimo de 'alguém decidiu o desfecho'".
  //
  // A ASSIMETRIA que distingue esta operação de `revokeRunCapabilities`: adotar
  // é do dono ATUAL, não da origem do run. O §5.8.2 é explícito na linha
  // "terminal externo persistido, sem output" — o novo owner valida
  // política/calls/contexto e adota, em vez de pagar outra deliberação. Por isso
  // `adopted_by_turn_attempt` existe: registra QUAL tentativa adotou.
  //
  // Os casos 51 e 52 são cirúrgicos, escritos antes da varredura.
  // ══════════════════════════════════════════════════════════════════════════

  /** Run em `result_ready`, com terminal aceito — o estado de onde se adota. */
  async function runComTerminal(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
    p: ReturnType<typeof pedido>;
  }> {
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
    const r = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: {
          version: 1,
          run_id,
          request_key: p.request_key,
          stop: { kind: "reply", raw_text: "resposta" },
          iterations: 1,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cost_microusd: null,
            source: "engine_reported",
          },
        },
      }),
    );
    if (!r.ok) throw new Error("setup: recordTerminalProposal falhou");
    return { run_id, turno, p };
  }

  const preparacao = { texto: "resposta", canal: "whatsapp" };

  it("adoption rejects the live owner of a DIFFERENT turn in the same scope", async () => {
    const { run_id } = await runComTerminal();
    const other = await mkTurnoVivo();
    const result = await noEscopo(() => engineRunsRepo.adoptTerminalResult({
      run_id, turn_id: other.turn_id, claim_token: other.claim_token,
      output_preparation: preparacao,
    }));
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    const row = await pool.query("SELECT output_preparation_json FROM engine_runs WHERE id=$1", [run_id]);
    expect(row.rows[0].output_preparation_json).toBeNull();
  });

  it("adoption rejects an ABA control epoch change after the terminal", async () => {
    const { run_id, turno, p } = await runComTerminal();
    await pool.query("UPDATE conversation_controls SET control_epoch=control_epoch+2 WHERE id=$1", [p.control_id]);
    const result = await noEscopo(() => engineRunsRepo.adoptTerminalResult({
      run_id, turn_id: turno.turn_id, claim_token: turno.claim_token,
      output_preparation: preparacao,
    }));
    expect(result).toMatchObject({ ok: false, reason: "control_epoch_changed" });
    const row = await pool.query("SELECT output_preparation_json FROM engine_runs WHERE id=$1", [run_id]);
    expect(row.rows[0].output_preparation_json).toBeNull();
  });

  it("adoption preserves frozen output bytes on retry and rejects replacement", async () => {
    const { run_id, turno } = await runComTerminal();
    const input = { run_id, turn_id: turno.turn_id, claim_token: turno.claim_token, output_preparation: preparacao };
    const first = await noEscopo(() => engineRunsRepo.adoptTerminalResult(input));
    expect(first.ok).toBe(true);
    const changed = await noEscopo(() => engineRunsRepo.adoptTerminalResult({ ...input, output_preparation: { texto: "changed" } }));
    expect(changed).toMatchObject({ ok: false, reason: "preparation_conflict" });
    const same = await noEscopo(() => engineRunsRepo.adoptTerminalResult(input));
    expect(same).toEqual(first);
    const row = await pool.query("SELECT output_preparation_json FROM engine_runs WHERE id=$1", [run_id]);
    expect(row.rows[0].output_preparation_json).toEqual(preparacao);
  });

  it("close refuses evidence from another turn in the same scope", async () => {
    const { run_id } = await runComTerminal();
    const other = await mkTurnoVivo();
    const result = await noEscopo(() => engineRunsRepo.closeRunAfterHandoff({
      run_id, turn_id: other.turn_id, decision: "safe_to_retry",
      actor: { kind: "recovery", actor_ref: "synthetic-recovery" },
    }));
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect((await pool.query("SELECT phase FROM engine_runs WHERE id=$1", [run_id])).rows[0].phase).toBe("result_ready");
  });

  it("46. o dono atual adota: registra a tentativa e a preparação", async () => {
    const { run_id, turno } = await runComTerminal();

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: preparacao,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.adopted_by_turn_attempt).toBe(turno.attempt);

    const row = await pool.query<{
      adopted_by_turn_attempt: number | null;
      output_preparation_json: unknown;
      phase: string;
    }>(
      "SELECT adopted_by_turn_attempt, output_preparation_json, phase FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(Number(row.rows[0]?.adopted_by_turn_attempt)).toBe(turno.attempt);
    expect(row.rows[0]?.output_preparation_json).toEqual(preparacao);
    // Adotar NÃO fecha o run: fechar é outra operação, com outra prova.
    expect(row.rows[0]?.phase).toBe("result_ready");
  });

  it("47. o NOVO dono adota — é a assimetria contra `revokeRunCapabilities`", async () => {
    const { run_id, turno } = await runComTerminal();

    // Re-claim: o worker antigo morreu e o turno tem dono novo. §5.8.2 manda
    // adotar o terminal já persistido em vez de pagar outra deliberação.
    const novoToken = randomUUID();
    await pool.query(
      `UPDATE agent_turns SET claim_token = $2, attempt_count = attempt_count + 1,
              lease_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [turno.turn_id, novoToken],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: novoToken,
        output_preparation: preparacao,
      }),
    );
    expect(r.ok).toBe(true);
    // Registra a tentativa que ADOTOU (a nova), não a que originou o run.
    if (r.ok) expect(r.adopted_by_turn_attempt).toBe(turno.attempt + 1);

    const row = await pool.query<{ adopted_by_turn_attempt: number }>(
      "SELECT adopted_by_turn_attempt FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(Number(row.rows[0]?.adopted_by_turn_attempt)).toBe(
      turno.attempt + 1,
    );
  });

  it("48. sem posse viva do turno não se adota", async () => {
    const { run_id, turno } = await runComTerminal();
    await pool.query(
      "UPDATE agent_turns SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [turno.turn_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: preparacao,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");

    const row = await pool.query<{ adopted_by_turn_attempt: number | null }>(
      "SELECT adopted_by_turn_attempt FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.adopted_by_turn_attempt).toBeNull();
  });

  it("49. adotar exige `result_ready` — sem terminal não há o que adotar", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    await noEscopo(() =>
      engineRunsRepo.pinEngineAndPrepareRun(pedido(run_id, turno, control_id)),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: preparacao,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("phase_conflict");
  });

  it("50. adotar NÃO reautoriza callbacks antigos: a revogação continua de pé", async () => {
    const { run_id, turno } = await runComTerminal();
    await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: { kind: "turn_owner", origin_claim_token: turno.claim_token },
        reason_code: "deadline",
      }),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: preparacao,
      }),
    );
    expect(r.ok).toBe(true);

    // §5.6.3: "sem reautorizar callbacks antigos". Adotar o RESULTADO não
    // devolve autoridade de tool a ninguém.
    const row = await pool.query<{ capabilities_revoked_at: string | null }>(
      "SELECT capabilities_revoked_at::text AS capabilities_revoked_at FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.capabilities_revoked_at).not.toBeNull();
  });

  it("51. preparação acima do teto da coluna é recusada TIPADA, não estoura o CHECK", async () => {
    const { run_id, turno } = await runComTerminal();

    // `output_preparation_json` tem CHECK de 256 KiB na 140. Sem teto na
    // operação, isto viraria violação dentro da TX.
    const enorme = { dump: "x".repeat(300_000) };

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: enorme,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("preparation_too_large");

    const row = await pool.query<{ adopted_by_turn_attempt: number | null }>(
      "SELECT adopted_by_turn_attempt FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.adopted_by_turn_attempt).toBeNull();
  });

  it("52. versão errada com a fase CERTA: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno } = await runComTerminal();
    const v = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_runs WHERE id = $1",
      [run_id],
    );
    await pool.query(
      "UPDATE engine_runs SET row_version = row_version + 1 WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: preparacao,
        expected_row_version: Number(v.rows[0]?.row_version),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(Number(v.rows[0]?.row_version) + 1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 53-72: `closeRunAfterHandoff` (P03.6b) — §5.6.3, §5.7.2, §5.7.3.
  //
  // Fechar é a ÚNICA operação do módulo que exige prova EXTERNA ao journal. O
  // §5.7.2 admite `handed_to_outbox` só com "commit outbound comprovado", e o
  // invariante 7 admite `safe_to_retry` só com "ausência de outbound e de
  // efeitos não reconciliados". O C18 decidiu o que conta como prova, e a
  // decisão tem DOIS níveis que os casos 58/59/61 separam:
  //
  //   RESOLVIDO = `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES`. `delivered` está
  //   deliberadamente FORA: libera a próxima parte, mas não fechou histórico,
  //   então não prova convergência.
  //   SUCESSO   = `completed`. Um artefato `cancelled` está resolvido e NÃO é
  //   entrega — fechar `handed_to_outbox` sobre ele afirmaria uma saída que
  //   não houve.
  //
  // Os casos 54 e 55 são cirúrgicos, escritos ANTES da varredura: isolam a
  // guarda de FASE da guarda de VERSÃO, que um cenário realista move junto (a
  // lição recorrente de M2/NM1/AM7/BM3-BM4/CM7/EM3).
  // ══════════════════════════════════════════════════════════════════════════

  /** Run em `result_ready`, com terminal aceito E adotado — de onde se fecha. */
  async function runAdotado(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
  }> {
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
    const t = await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: {
          version: 1,
          run_id,
          request_key: p.request_key,
          stop: { kind: "reply", raw_text: "resposta" },
          iterations: 1,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cost_microusd: null,
            source: "engine_reported",
          },
        },
      }),
    );
    if (!t.ok) throw new Error("setup: recordTerminalProposal falhou");
    const a = await noEscopo(() =>
      engineRunsRepo.adoptTerminalResult({
        run_id,
        turn_id: turno.turn_id,
        claim_token: turno.claim_token,
        output_preparation: { texto: "resposta" },
      }),
    );
    if (!a.ok) throw new Error("setup: adoptTerminalResult falhou");
    return { run_id, turno };
  }

  /**
   * Saída durável do MESMO turno.
   *
   * O `outbound_messages_durable_row_complete_check` exige o tuplo INTEIRO
   * assim que `turn_id` existe. As duas chaves são DERIVADAS pelo contrato, não
   * literais: não há CHECK de formato nelas, então um literal passaria no banco
   * e mentiria sobre a identidade — exatamente o tipo de fixture que faz um
   * teste verde afirmar o que o código não garante.
   */
  async function mkOutbound(
    turn_id: string,
    status: string,
    sequence_in_turn = 0,
  ): Promise<void> {
    const payload = { type: "text" as const, text: "resposta" };
    const payload_hash = computePayloadHash(payload);
    const identidade = {
      tenant_id: TENANT,
      agent_id: AGENT,
      turn_id,
      sequence_in_turn,
      payload_hash,
    };
    const id = randomUUID();
    await pool.query(
      `INSERT INTO outbound_messages
         (id, tenant_id, agent_id, idempotency_key, conversa_id, in_reply_to, channel,
          status, turn_id, sequence_in_turn, payload_version, payload_type, payload_json,
          payload_hash, logical_dedupe_key, provider_idempotency_key, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,'text',$7,$8,$9,$10,'text',$11::jsonb,$12,$13,$14, now())`,
      [
        id,
        TENANT,
        AGENT,
        `idem-${id}`,
        randomUUID(),
        randomUUID(),
        status,
        turn_id,
        sequence_in_turn,
        OUTBOUND_PAYLOAD_VERSION,
        JSON.stringify(payload),
        payload_hash,
        deriveLogicalDedupeKey(identidade),
        deriveProviderIdempotencyKey(identidade, "whatsapp"),
      ],
    );
  }

  /**
   * Call por SQL CRU, deliberadamente.
   *
   * O caminho normal IMPEDE este estado: `recordTerminalProposal` recusa
   * terminal com chamada pendente. Construí-lo à mão é o que prova que o
   * fechamento tem guarda PRÓPRIA, em vez de herdar a do terminal — se um dia
   * alguém relaxar aquela guarda, esta continua de pé.
   */
  async function mkCallCrua(
    run_id: string,
    turn_id: string,
    state: string,
    effect_evidence: string,
    ordinal = 0,
  ): Promise<void> {
    const conciliada = [
      "completed",
      "denied",
      "approval_required",
      "effect_unknown",
      "cancelled",
    ].includes(state);
    // `engine_tool_calls_handler_chk`: o marcador de handler só é válido com os
    // TRÊS campos juntos. Sem eles o INSERT violaria o CHECK e o caso falharia
    // por erro de fixture — um vermelho que não mede o que o teste afirma medir.
    const precisaMarcador = state === "handler_started";
    await pool.query(
      `INSERT INTO engine_tool_calls (tenant_id, agent_id, turn_id, run_id, call_id, ordinal,
          tool_name, args_json, args_hash, request_id, state, effect_evidence, finished_at, result_json,
          handler_started_at, dispatch_token, reservation_token)
       VALUES ($1,$2,$3,$4,$5,$6,'fixture_echo','{}'::jsonb,$7,$8,$9,$10,
               ${conciliada ? "now()" : "NULL"}, ${conciliada ? "'{}'::jsonb" : "NULL"},
               ${precisaMarcador ? "now()" : "NULL"},
               ${precisaMarcador ? "gen_random_uuid()" : "NULL"},
               ${precisaMarcador ? "'res-fixture'" : "NULL"})`,
      [
        TENANT,
        AGENT,
        turn_id,
        run_id,
        `${run_id}:${ordinal}`,
        ordinal,
        SHA,
        randomUUID(),
        state,
        effect_evidence,
      ],
    );
  }

  const donoDe = (turno: { claim_token: string }) =>
    ({ kind: "turn_owner", origin_claim_token: turno.claim_token }) as const;

  async function contaEventosClosed(run_id: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM engine_run_events WHERE run_id = $1 AND event_type = 'closed'",
      [run_id],
    );
    return r.rows[0]?.n ?? 0;
  }

  it("53. `handed_to_outbox` com artefato `completed`: fecha e registra o evento", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.already_closed).toBe(false);

    const row = await pool.query<{
      phase: string;
      closed_reason: string | null;
      closed_at: string | null;
      capabilities_revoked_at: string | null;
    }>(
      `SELECT phase, closed_reason, closed_at::text AS closed_at,
              capabilities_revoked_at::text AS capabilities_revoked_at
         FROM engine_runs WHERE id = $1`,
      [run_id],
    );
    expect(row.rows[0]?.phase).toBe("closed");
    expect(row.rows[0]?.closed_reason).toBe("handed_to_outbox");
    // A 140 exige os três juntos em toda linha `closed`.
    expect(row.rows[0]?.closed_at).not.toBeNull();
    expect(row.rows[0]?.capabilities_revoked_at).not.toBeNull();
    expect(await contaEventosClosed(run_id)).toBe(1);
  });

  it("54. fase errada com tudo o mais certo: só a guarda de FASE recusa", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");
    // Volta a fase sem tocar em mais nada: prova externa intacta, adoção
    // intacta, versão intacta. Só a fase diverge.
    await pool.query("UPDATE engine_runs SET phase = 'running' WHERE id = $1", [
      run_id,
    ]);

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "phase_conflict") {
      expect(r.current_phase).toBe("running");
    } else if (!r.ok) {
      throw new Error(`esperado phase_conflict, veio ${r.reason}`);
    }
  });

  it("55. versão errada com a fase CERTA: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");
    const v = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_runs WHERE id = $1",
      [run_id],
    );
    await pool.query(
      "UPDATE engine_runs SET row_version = row_version + 1 WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
        expected_row_version: Number(v.rows[0]?.row_version),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(Number(v.rows[0]?.row_version) + 1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  it("56. re-fechar com a MESMA razão após crash: ok, sem segundo evento", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");
    const entrada = {
      run_id,
      turn_id: turno.turn_id,
      decision: "handed_to_outbox" as const,
      actor: donoDe(turno),
    };
    const primeiro = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff(entrada),
    );
    expect(primeiro.ok).toBe(true);

    // "pode ser repetido após crash" (§5.6.3). Repetir é SUCESSO, não conflito.
    const segundo = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff(entrada),
    );
    expect(segundo.ok).toBe(true);
    if (segundo.ok) expect(segundo.already_closed).toBe(true);
    // O evento é o que não pode duplicar: o journal é append-only e um segundo
    // `closed` contaria a mesma decisão duas vezes.
    expect(await contaEventosClosed(run_id)).toBe(1);
  });

  it("57. re-fechar com razão DIFERENTE é conflito, não idempotência", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");
    await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "completed_no_reply",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "close_reason_conflict") {
      expect(r.current_closed_reason).toBe("handed_to_outbox");
    } else if (!r.ok) {
      throw new Error(`esperado close_reason_conflict, veio ${r.reason}`);
    }
  });

  it("58. outbound só `pending` NÃO é prova: artefato não resolvido", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "pending");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("artifacts_unresolved");
  });

  it("59. `delivered` NÃO é convergência: artefato não resolvido (C18)", async () => {
    const { run_id, turno } = await runAdotado();
    // O caso que a CORREÇÃO do C18 produziu: `delivered` é intermediário que um
    // CAS promove, e está deliberadamente fora de
    // OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES. Fechar aqui declararia handoff
    // sobre linha que a casa ainda considera em voo.
    await mkOutbound(turno.turn_id, "delivered");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("artifacts_unresolved");
  });

  it("60. `handed_to_outbox` sem outbound nenhum: prova ausente", async () => {
    const { run_id, turno } = await runAdotado();

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outbound_proof_missing");
  });

  it("61. artefato RESOLVIDO mas `cancelled` não é entrega: prova ausente", async () => {
    const { run_id, turno } = await runAdotado();
    // `cancelled` está em OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES — resolvido.
    // Mas resolvido é a pergunta "convergiu?", e SUCESSO é outra pergunta.
    // Este caso separa as duas: sem ele, um único predicado de "resolvido"
    // passaria por prova de handoff.
    await mkOutbound(turno.turn_id, "cancelled");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outbound_proof_missing");
  });

  it("62. `completed_no_reply` sem outbound: fecha", async () => {
    const { run_id, turno } = await runAdotado();

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "completed_no_reply",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ closed_reason: string | null }>(
      "SELECT closed_reason FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.closed_reason).toBe("completed_no_reply");
  });

  it("63. `completed_no_reply` COM outbound é contradição: recusa", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "completed_no_reply",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outbound_present");
  });

  it("64. `safe_to_retry` com outbound: recusa (invariante 7, condição A)", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "safe_to_retry",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outbound_present");
  });

  it("65. `safe_to_retry` com call NÃO conciliada: recusa (condição B)", async () => {
    const { run_id, turno } = await runAdotado();
    // Sem outbound: a condição A está satisfeita.
    //
    // `effect_evidence` é `none` DE PROPÓSITO, e esta linha é a correção de um
    // defeito que a varredura expôs: a primeira versão usava `possible`, o que
    // movia DUAS variáveis de uma vez. Com evidência `possible`, desligar o
    // predicado de ESTADO deixava o de evidência recusar sozinho, o teste
    // continuava verde e o mutante EM9 sobrevivia — o caso provava a garantia
    // sem provar QUAL predicado a sustenta. Com `none`, só a não-conciliação do
    // estado pode recusar. É legal na 140: `engine_tool_calls_unknown_chk` só
    // amarra evidência a `effect_unknown`, e uma tool `abort_safe` fica mesmo
    // `handler_started` sem evidência nenhuma.
    await mkCallCrua(run_id, turno.turn_id, "handler_started", "none");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "safe_to_retry",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("effect_unreconciled");
  });

  it("66. `safe_to_retry` com call conciliada mas efeito `committed`: recusa", async () => {
    const { run_id, turno } = await runAdotado();
    // A call ESTÁ conciliada (`completed`, com `finished_at`), então o predicado
    // de estado sozinho a aprovaria. O que impede o retry é a EVIDÊNCIA: um
    // efeito comprometido significa que repetir o turno repetiria o efeito.
    // Isolado do 65 de propósito — dois predicados, dois casos.
    await mkCallCrua(run_id, turno.turn_id, "completed", "committed");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "safe_to_retry",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("effect_unreconciled");
  });

  it("67. `safe_to_retry` sem outbound e sem efeito: fecha", async () => {
    const { run_id, turno } = await runAdotado();
    await mkCallCrua(run_id, turno.turn_id, "completed", "none");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "safe_to_retry",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ closed_reason: string | null }>(
      "SELECT closed_reason FROM engine_runs WHERE id = $1",
      [run_id],
    );
    expect(row.rows[0]?.closed_reason).toBe("safe_to_retry");
  });

  it("68. fechar sem adoção recusa TIPADO, antes de o CHECK da 140 estourar", async () => {
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
    await noEscopo(() =>
      engineRunsRepo.recordTerminalProposal({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        proposal: {
          version: 1,
          run_id,
          request_key: p.request_key,
          stop: { kind: "reply", raw_text: "resposta" },
          iterations: 1,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cost_microusd: null,
            source: "engine_reported",
          },
        },
      }),
    );
    // Terminal SIM, adoção NÃO. O `engine_runs_adopted_chk` recusaria no banco;
    // o ponto é que a recusa tem de ser TIPADA (§5.6.4), não uma exceção de
    // constraint escapando da transação.
    await mkOutbound(turno.turn_id, "completed");

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("adoption_required");
  });

  it("69. run `blocked` não fecha por esta porta (só `resolveBlockedRun`)", async () => {
    const { run_id, turno } = await runAdotado();
    await noEscopo(() =>
      engineRunsRepo.markRunBlocked({
        run_id,
        turn_id: turno.turn_id,
        actor: donoDe(turno),
        error_code: "efeito_incerto",
        evidence: { nota: "fixture" },
      }),
    );
    await mkOutbound(turno.turn_id, "completed");

    // Fechar um `blocked` por aqui burlaria a exigência de operador + evidência
    // do §5.6.3 ("nenhuma liberação automática por TTL").
    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "phase_conflict") {
      expect(r.current_phase).toBe("blocked");
    } else if (!r.ok) {
      throw new Error(`esperado phase_conflict, veio ${r.reason}`);
    }
  });

  it("70. fechar PRESERVA o carimbo de revogação de P03.4", async () => {
    const { run_id, turno } = await runAdotado();
    await noEscopo(() =>
      engineRunsRepo.revokeRunCapabilities({
        run_id,
        turn_id: turno.turn_id,
        actor: donoDe(turno),
        reason_code: "lease_perdida",
      }),
    );
    const antes = await pool.query<{ t: string }>(
      "SELECT capabilities_revoked_at::text AS t FROM engine_runs WHERE id = $1",
      [run_id],
    );
    await mkOutbound(turno.turn_id, "completed");

    await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );

    const depois = await pool.query<{ t: string }>(
      "SELECT capabilities_revoked_at::text AS t FROM engine_runs WHERE id = $1",
      [run_id],
    );
    // COALESCE, não sobrescrita: a monotonicidade de P03.4 vale também aqui.
    expect(depois.rows[0]?.t).toBe(antes.rows[0]?.t);
  });

  it("71. dono ATUAL que não é a origem do run: `not_run_origin`", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");
    // CIRÚRGICO: um token aleatório pararia em `stale_claim` no fence do turno e
    // nunca exercitaria esta guarda. Re-reivindicar dá um dono com posse VIVA e
    // turno `running` — ele ATRAVESSA o fence e só então esbarra em não ser a
    // origem deste run. É o único jeito de isolar o predicado.
    const novoToken = await reivindicarDeNovo(turno.turn_id);

    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: { kind: "turn_owner", origin_claim_token: novoToken },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "not_run_origin") {
      expect(r.run_origin_claim_token).toBe(turno.claim_token);
    } else if (!r.ok) {
      throw new Error(`esperado not_run_origin, veio ${r.reason}`);
    }
  });

  it("72. `recovery` fecha SEM token de origem (§5.7.3 item 5)", async () => {
    const { run_id, turno } = await runAdotado();
    await mkOutbound(turno.turn_id, "completed");

    // A assimetria de P03.4 repetida: o cenário que mais precisa de fechamento
    // é justamente aquele em que o dono sumiu. Exigir o token dele deixaria
    // órfãos para sempre — que é o caso que o §5.7.3 manda o scanner resolver.
    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: { kind: "recovery", actor_ref: "scanner-1" },
      }),
    );
    expect(r.ok).toBe(true);

    const ev = await pool.query<{ actor_kind: string }>(
      "SELECT actor_kind FROM engine_run_events WHERE run_id = $1 AND event_type = 'closed'",
      [run_id],
    );
    expect(ev.rows[0]?.actor_kind).toBe("recovery");
  });

  /** Run parado em `submitting`: pin + intenção de start, sem aceite. */
  async function runSubmetendo(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
  }> {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = randomUUID();
    const p = pedido(run_id, turno, control_id);
    await noEscopo(() => engineRunsRepo.pinEngineAndPrepareRun(p));
    const s = await noEscopo(() =>
      engineRunsRepo.markSubmitting({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        expected_row_version: 0,
      }),
    );
    if (!s.ok) throw new Error("setup: markSubmitting falhou");
    return { run_id, turno };
  }

  it("73. `safe_to_retry` fecha a partir de `submitting` (§5.7.2)", async () => {
    const { run_id, turno } = await runSubmetendo();
    // Sem terminal e sem adoção — `safe_to_retry` não os exige. É a linha
    // "rejeição comprovadamente anterior a aceite" do §5.7.2, e o
    // `engine_runs_adopted_chk` só constrange as DUAS razões de desfecho.
    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "safe_to_retry",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{
      phase: string;
      closed_reason: string | null;
    }>("SELECT phase, closed_reason FROM engine_runs WHERE id = $1", [run_id]);
    expect(row.rows[0]?.phase).toBe("closed");
    expect(row.rows[0]?.closed_reason).toBe("safe_to_retry");
  });

  it("74. `handed_to_outbox` NÃO fecha a partir de `submitting`", async () => {
    const { run_id, turno } = await runSubmetendo();
    // O PAR do 73: mesma fase, decisão diferente, resultado oposto. É isto que
    // prende que cada decisão consulta o SEU conjunto de fases — um conjunto
    // único passaria nos dois casos isolados e só falharia aqui.
    const r = await noEscopo(() =>
      engineRunsRepo.closeRunAfterHandoff({
        run_id,
        turn_id: turno.turn_id,
        decision: "handed_to_outbox",
        actor: donoDe(turno),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "phase_conflict") {
      expect(r.current_phase).toBe("submitting");
    } else if (!r.ok) {
      throw new Error(`esperado phase_conflict, veio ${r.reason}`);
    }
  });
});
