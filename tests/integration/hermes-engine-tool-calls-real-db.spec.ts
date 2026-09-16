/**
 * P03.3a (spec §5.7.4 itens 3-5, §5.6.3) — ADMISSÃO de tool call, contra
 * Postgres REAL.
 *
 * Arquivo separado do journal de start porque a pergunta é outra: lá era "de
 * quem é este run"; aqui é "esta chamada pode entrar, e o que se responde a
 * quem já perguntou antes".
 *
 * As quatro regras que estes casos prendem:
 *
 *  1. **Redelivery não repete handler** (§5.7.4 item 3). Mesmo `call_id` com o
 *     mesmo `args_hash` devolve o que já existe — resultado persistido se a
 *     chamada já foi conciliada, `in_progress` se o vencedor ainda está em voo.
 *     Executar de novo seria repetir o efeito (T26).
 *  2. **Mesmo id com outros args é `payload_conflict`** e bloqueia o protocolo;
 *     nenhum handler é chamado (T27).
 *  3. **Ordem sequencial** (item 4): no máximo UMA chamada pendente por run, e
 *     `ordinal` só pode ser o próximo ou um redelivery. O UNIQUE de `ordinal`
 *     da 140 impede duplicata, mas não impõe ORDEM — duas calls fora de ordem
 *     têm ordinais distintos e passariam por ele.
 *  4. **Callback adiantado** (item 5): o engine pode pedir tool antes de o
 *     aceite do start estar persistido. Em `submitting`/`submission_unknown` a
 *     chamada é admitida como `received` e a resposta é `in_progress` — nunca
 *     execução. `result_ready`, `cancelling`, `reconciling`, `blocked` e
 *     `closed` não liberam chamada nova.
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { engineRunsRepo } from "@/db/repositories/engine-repos.js";
import { canonicalDigest } from "@/integrations/hermes/canonical-json.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "hermes-calls-tenant";
const AGENT = "hermes-calls-agent";
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

async function mkTurnoVivo(): Promise<{
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
     VALUES ($1,$2,$3,$4,'running',$5,'worker-1',1, now() + interval '5 minutes')`,
    [turn_id, TENANT, AGENT, mensagem_id, claim_token],
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

d("engine-repos — admissão de tool call contra Postgres real", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant();
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Run em `submitting` (start marcado, aceite ainda não observado). */
  async function runSubmetendo(
    turno: { turn_id: string; claim_token: string; attempt: number },
    control_id: string,
  ): Promise<string> {
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
    return run_id;
  }

  /** Run em `running` — o único estado que libera o dispatcher. */
  async function runRodando(
    turno: { turn_id: string; claim_token: string; attempt: number },
    control_id: string,
  ): Promise<string> {
    const run_id = await runSubmetendo(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.recordStartObservation({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        observation: { kind: "accepted", remote_run_id: `w-${randomUUID()}` },
      }),
    );
    return run_id;
  }

  function chamada(
    run_id: string,
    over: Partial<{
      call_seq: number;
      name: string;
      args: Record<string, unknown>;
      iteration: number | null;
    }> = {},
  ) {
    const call_seq = over.call_seq ?? 0;
    return {
      run_id,
      turn_id: "",
      origin_claim_token: "",
      request_id: randomUUID(),
      call: {
        call_id: `${run_id}:${call_seq}`,
        ordinal: call_seq,
        iteration: over.iteration ?? 1,
        name: over.name ?? "maia_fixture_echo",
        args: over.args ?? { texto: "oi" },
      },
    };
  }

  it("1. admite a primeira chamada do run como `received`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);

    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("admitted");

    const row = await pool.query<{ state: string; ordinal: number }>(
      "SELECT state, ordinal FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(row.rows[0]?.state).toBe("received");
    expect(Number(row.rows[0]?.ordinal)).toBe(0);
  });

  it("2. T26 — redelivery do MESMO id com os MESMOS args, ainda em voo, devolve `in_progress`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = {
      ...chamada(run_id),
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
    };

    await noEscopo(() => engineRunsRepo.admitToolCall(args));
    const redelivery = await noEscopo(() => engineRunsRepo.admitToolCall(args));

    expect(redelivery.ok).toBe(true);
    if (redelivery.ok) expect(redelivery.kind).toBe("in_progress");

    // E não nasceu uma segunda linha: redelivery não é chamada nova.
    const n = await pool.query<{ c: string }>(
      "SELECT count(*) AS c FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(Number(n.rows[0]?.c)).toBe(1);
  });

  it("3. T26 — redelivery de chamada JÁ CONCILIADA devolve o resultado persistido", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const args = {
      ...chamada(run_id),
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
    };
    await noEscopo(() => engineRunsRepo.admitToolCall(args));

    await pool.query(
      `UPDATE engine_tool_calls
          SET state = 'completed', finished_at = now(),
              result_json = '{"ok":true,"eco":"oi"}'::jsonb
        WHERE run_id = $1`,
      [run_id],
    );

    const r = await noEscopo(() => engineRunsRepo.admitToolCall(args));
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "receipt") {
      expect(r.state).toBe("completed");
      expect(r.result).toEqual({ ok: true, eco: "oi" });
    } else if (r.ok) {
      throw new Error(`esperado receipt, veio ${r.kind}`);
    }
  });

  it("4. T27 — MESMO id com args DIFERENTES é `payload_conflict`, e nada muda no journal", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    const base = {
      ...chamada(run_id),
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
    };
    await noEscopo(() => engineRunsRepo.admitToolCall(base));

    const hashAntes = await pool.query<{ args_hash: string }>(
      "SELECT args_hash FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );

    const conflitante = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...base,
        call: { ...base.call, args: { texto: "OUTRA COISA" } },
      }),
    );
    expect(conflitante.ok).toBe(false);
    if (!conflitante.ok) expect(conflitante.reason).toBe("payload_conflict");

    const hashDepois = await pool.query<{ args_hash: string }>(
      "SELECT args_hash FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(hashDepois.rows[0]?.args_hash).toBe(hashAntes.rows[0]?.args_hash);
  });

  it("5. ordem: um `ordinal` que não é o próximo nem redelivery é recusado", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);

    // Pular de 0 para 2. O UNIQUE de ordinal não impede isto — ordinais
    // distintos passam por ele. Só a checagem de ORDEM impede.
    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id, { call_seq: 2 }),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ordinal_out_of_order");
  });

  it("6. piloto sequencial: com uma chamada pendente, outra NOVA é recusada", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);

    await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id, { call_seq: 0 }),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );

    const segunda = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id, { call_seq: 1 }),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) expect(segunda.reason).toBe("call_pending");
  });

  it("7. callback adiantado: em `submitting` a chamada entra como `received` e a resposta é `in_progress`", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runSubmetendo(turno, control_id);

    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("in_progress");

    // Journalada, mas NÃO liberada: quem executa é o dispatcher, e ele só age
    // com `phase=running`.
    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(row.rows[0]?.state).toBe("received");
  });

  it("8. `result_ready` não libera chamada nova", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    await pool.query(
      `UPDATE engine_runs
          SET phase = 'result_ready', terminal_json = '{"version":1}'::jsonb,
              terminal_hash = $2, row_version = row_version + 1
        WHERE id = $1`,
      [run_id, "b".repeat(64)],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("run_not_authorized");
  });

  it("9. depois de re-claim, o novo dono não admite chamada no run do dono antigo", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);

    const novoToken = randomUUID();
    await pool.query(
      `UPDATE agent_turns
          SET claim_token = $2, attempt_count = attempt_count + 1,
              lease_expires_at = now() + interval '5 minutes'
        WHERE id = $1`,
      [turno.turn_id, novoToken],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: novoToken,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");

    const n = await pool.query<{ c: string }>(
      "SELECT count(*) AS c FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(Number(n.rows[0]?.c)).toBe(0);
  });

  it("10. token rotacionado SEM avançar a tentativa: a admissão tem fence de ORIGEM próprio", async () => {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);

    // O caso 9 é o re-claim REALISTA: troca token e tentativa na mesma UPDATE.
    // Por isso ele não consegue dizer QUAL predicado recusou — a varredura
    // mostrou o mutante do fence de origem sobrevivendo contra este arquivo.
    // Aqui só o TOKEN muda: `attempt_count` continua 1, igual ao
    // `origin_turn_attempt` do run, então o predicado de tentativa passa limpo
    // e o de origem fica sozinho.
    //
    // O predicado é o mesmo `checarFenceDoRun` que o caminho de start usa, e o
    // spec do journal já o isola — mas a admissão não pode depender de um caso
    // que mora em outro arquivo: basta alguém dar a ela um fence próprio para a
    // garantia sumir sem nenhum teste reclamar.
    const soToken = randomUUID();
    await pool.query("UPDATE agent_turns SET claim_token = $2 WHERE id = $1", [
      turno.turn_id,
      soToken,
    ]);

    const r = await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: soToken,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");

    const n = await pool.query<{ c: string }>(
      "SELECT count(*) AS c FROM engine_tool_calls WHERE run_id = $1",
      [run_id],
    );
    expect(Number(n.rows[0]?.c)).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 11-16 (P03.3b): `markToolDispatching` e `freezeToolIdentity`.
  //
  // `markToolDispatching` existe porque o §5.6.4 EXIGE `state='dispatching'` com
  // `dispatch_token` igual como pré-condição de `markToolHandlerStarted` — e a
  // tabela do §5.6.3 nunca nomeou quem atribui esse token (ver C14). É também
  // onde entram as duas recusas que o §5.6.4 manda fazer ANTES de chegar ao
  // marcador de handler: classe nula e orçamento insuficiente.
  // ══════════════════════════════════════════════════════════════════════════

  /** Admite a call 0 e devolve o run pronto para despachar. */
  async function runComCallAdmitida(): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
    call_id: string;
  }> {
    const turno = await mkTurnoVivo();
    const control_id = await mkControle();
    const run_id = await runRodando(turno, control_id);
    await noEscopo(() =>
      engineRunsRepo.admitToolCall({
        ...chamada(run_id),
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
      }),
    );
    return { run_id, turno, call_id: `${run_id}:0` };
  }

  const classificacao = {
    side_effect: "write" as const,
    effect_class: "non_interruptible" as const,
    sensitive: false,
    legacy_irreversible_invoked: false,
  };

  it("11. `received` → `dispatching`: atribui dispatch_token e persiste a classificação do registry", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    const r = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dispatch_token).toMatch(/^[0-9a-f-]{36}$/);

    const row = await pool.query<{
      state: string;
      dispatch_token: string | null;
      side_effect: string | null;
      effect_class: string | null;
      effect_evidence: string;
    }>(
      "SELECT state, dispatch_token, side_effect, effect_class, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("dispatching");
    expect(row.rows[0]?.dispatch_token).not.toBeNull();
    expect(row.rows[0]?.side_effect).toBe("write");
    expect(row.rows[0]?.effect_class).toBe("non_interruptible");
    // Ainda NÃO há evidência de efeito: o handler nem foi chamado.
    expect(row.rows[0]?.effect_evidence).toBe("none");
  });

  it("12. `effect_class` nulo é recusado — classe nula nunca autoriza handler", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    const r = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: { ...classificacao, effect_class: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("effect_class_required");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("received");
  });

  it("13. prazo abaixo do mínimo da classe é recusado ANTES de despachar", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    // `non_interruptible` exige 250 + 1500 = 1750ms. Deixar 300ms de prazo: o
    // run ainda não venceu (o fence passa), mas não há orçamento para começar
    // algo que pode não ter repetição segura.
    await pool.query(
      "UPDATE engine_runs SET deadline_at = clock_timestamp() + interval '300 milliseconds' WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("insufficient_budget");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("received");
  });

  it("14. uma call não pode entrar em `dispatching` duas vezes", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    const args = {
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      call_id,
      expected_row_version: 0,
      classification: classificacao,
    };
    const primeiro = await noEscopo(() =>
      engineRunsRepo.markToolDispatching(args),
    );
    expect(primeiro.ok).toBe(true);

    const segundo = await noEscopo(() =>
      engineRunsRepo.markToolDispatching(args),
    );
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.reason).toBe("state_conflict");
  });

  it("15. congela a identidade, e o que fica gravado REPRODUZ o `args_hash`", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        idempotency_key: "k-" + "0".repeat(60),
        idempotency_payload_hash: "v2:" + "c".repeat(64),
        normalized_args: { texto: "oi" },
      }),
    );
    expect(r.ok).toBe(true);

    // A invariante do C15: o objeto gravado é a forma canônica sobre a qual o
    // `args_hash` foi computado. Redigerir tem de reproduzir o hash.
    const row = await pool.query<{
      args_hash: string;
      normalized_args_json: unknown;
      idempotency_key: string;
    }>(
      "SELECT args_hash, normalized_args_json, idempotency_key FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.idempotency_key).toBe("k-" + "0".repeat(60));
    expect(canonicalDigest(row.rows[0]?.normalized_args_json)).toBe(
      row.rows[0]?.args_hash,
    );
  });

  it("16. identidade NÃO muda em replay: igual é idempotente, diferente é conflito", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    const identidade = {
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      call_id,
      idempotency_key: "k-" + "1".repeat(60),
      idempotency_payload_hash: "v2:" + "d".repeat(64),
      normalized_args: { texto: "oi" },
    };
    const primeiro = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity(identidade),
    );
    expect(primeiro.ok).toBe(true);

    const replay = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity(identidade),
    );
    expect(replay.ok).toBe(true);

    const outra = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        ...identidade,
        idempotency_key: "k-" + "9".repeat(60),
      }),
    );
    expect(outra.ok).toBe(false);
    if (!outra.ok) expect(outra.reason).toBe("identity_conflict");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 17-20: CIRÚRGICOS, um predicado por vez — de novo.
  //
  // O caso 14 chama `markToolDispatching` duas vezes com a MESMA
  // `expected_row_version`. Depois do primeiro sucesso a linha está em
  // `dispatching` E com `row_version` 1, então as duas guardas do CAS recusam a
  // segunda chamada. Apagar qualquer uma delas deixa a outra recusando, e a
  // varredura mostrou as DUAS sobrevivendo. Mesmo padrão dos casos 25-28 do
  // spec do journal: cenário realista prova a garantia, não prova qual
  // predicado a sustenta.
  //
  // Os casos 19 e 20 são outra coisa: cobrem caminhos que NENHUM teste tocava
  // (a invariante do C15 e a exigência de `dispatching` no freeze).
  // ══════════════════════════════════════════════════════════════════════════

  it("17. estado diferente de `received` com a MESMA versão: só a guarda de ESTADO recusa", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    // Estado muda por fora SEM mexer em `row_version`. A 140 permite: só
    // `handler_chk` e `terminal_chk` exigem colunas extras, e `dispatching` não
    // está em nenhum dos dois.
    await pool.query(
      "UPDATE engine_tool_calls SET state = 'dispatching', dispatch_token = gen_random_uuid() WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("state_conflict");
  });

  it("18. ainda em `received` com a versão MOVIDA: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    await pool.query(
      "UPDATE engine_tool_calls SET row_version = row_version + 1 WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  it("19. `normalized_args` que não reproduz o `args_hash` é recusado, e nada é gravado", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );

    const r = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        idempotency_key: "k-" + "2".repeat(60),
        idempotency_payload_hash: "v2:" + "e".repeat(64),
        // Não é a forma canônica sobre a qual o `args_hash` foi computado.
        normalized_args: { texto: "OUTRA COISA" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("normalized_args_mismatch");

    const row = await pool.query<{
      idempotency_key: string | null;
      normalized_args_json: unknown;
    }>(
      "SELECT idempotency_key, normalized_args_json FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.idempotency_key).toBeNull();
    expect(row.rows[0]?.normalized_args_json).toBeNull();
  });

  it("20. congelar identidade antes de `dispatching` é recusado", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();

    // A call está em `received`: o dispatcher nem foi cogitado ainda. Os args
    // batem com o hash de propósito — o que tem de recusar aqui é o ESTADO.
    const r = await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        idempotency_key: "k-" + "3".repeat(60),
        idempotency_payload_hash: "v2:" + "f".repeat(64),
        normalized_args: { texto: "oi" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("state_conflict");

    const row = await pool.query<{ idempotency_key: string | null }>(
      "SELECT idempotency_key FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.idempotency_key).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 21-28 (P03.3c): `markToolHandlerStarted` — o UPDATE do §5.6.4 linha
  // 1190. É o marcador que separa "não começou" de "pode ter começado", e por
  // isso a 140 exige `handler_started_at`, `dispatch_token` e
  // `reservation_token` juntos.
  //
  // Os casos 27 e 28 são cirúrgicos DE PROPÓSITO, escritos antes da varredura:
  // "não pode começar duas vezes" aciona a guarda de estado E a de versão ao
  // mesmo tempo, que é exatamente como BM3/BM4 sobreviveram em P03.3b. Repetir
  // o mesmo erro uma terceira vez seria não ter aprendido nada.
  // ══════════════════════════════════════════════════════════════════════════

  /** Call em `dispatching` com identidade já congelada — pronta para o marcador. */
  async function callPronta(
    effect_class: "abort_safe" | "non_interruptible" = "non_interruptible",
  ): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
    call_id: string;
    dispatch_token: string;
    row_version: number;
  }> {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    const disp = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: { ...classificacao, effect_class },
      }),
    );
    if (!disp.ok) throw new Error("setup: markToolDispatching falhou");
    await noEscopo(() =>
      engineRunsRepo.freezeToolIdentity({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        idempotency_key: "k-" + randomUUID(),
        idempotency_payload_hash: "v2:" + "a".repeat(64),
        normalized_args: { texto: "oi" },
      }),
    );
    const row = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    return {
      run_id,
      turno,
      call_id,
      dispatch_token: disp.dispatch_token,
      row_version: Number(row.rows[0]?.row_version),
    };
  }

  it("21. marca `handler_started` com os tokens, e eleva `effect_evidence` a `possible`", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta("non_interruptible");
    const reservation_token = randomUUID();

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token,
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{
      state: string;
      handler_started_at: string | null;
      reservation_token: string | null;
      effect_evidence: string;
    }>(
      "SELECT state, handler_started_at, reservation_token, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("handler_started");
    expect(row.rows[0]?.handler_started_at).not.toBeNull();
    expect(row.rows[0]?.reservation_token).toBe(reservation_token);
    // Classe com efeito: a partir daqui um cancelamento tardio é
    // `effect_unknown`, então a evidência sobe ANTES de o handler rodar.
    expect(row.rows[0]?.effect_evidence).toBe("possible");
  });

  it("22. `abort_safe` NÃO eleva a evidência de efeito", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta("abort_safe");

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ state: string; effect_evidence: string }>(
      "SELECT state, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("handler_started");
    // Abortar uma leitura não deixa nada para reconciliar.
    expect(row.rows[0]?.effect_evidence).toBe("none");
  });

  it("23. uma call não pode COMEÇAR duas vezes", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta();
    const args = {
      run_id,
      turn_id: turno.turn_id,
      origin_claim_token: turno.claim_token,
      call_id,
      expected_row_version: row_version,
      dispatch_token,
      reservation_token: randomUUID(),
      approval_claim_token: null,
    };
    const primeiro = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted(args),
    );
    expect(primeiro.ok).toBe(true);

    const segundo = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted(args),
    );
    expect(segundo.ok).toBe(false);
  });

  it("24. `dispatch_token` divergente é recusado, e nada é marcado", async () => {
    const { run_id, turno, call_id, row_version } = await callPronta();

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token: randomUUID(),
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dispatch_token_mismatch");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("dispatching");
  });

  it("25. sem identidade congelada o marcador é recusado", async () => {
    const { run_id, turno, call_id } = await runComCallAdmitida();
    const disp = await noEscopo(() =>
      engineRunsRepo.markToolDispatching({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 0,
        classification: classificacao,
      }),
    );
    if (!disp.ok) throw new Error("setup falhou");

    // Sem `freezeToolIdentity`: o §5.6.4 exige chave/hash presentes.
    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: 1,
        dispatch_token: disp.dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("identity_not_frozen");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("dispatching");
  });

  it("26. capacidades revogadas impedem o marcador", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta();
    await pool.query(
      "UPDATE engine_runs SET capabilities_revoked_at = now() WHERE id = $1",
      [run_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("dispatching");
  });

  it("27. estado errado com a versão CERTA: só a guarda de ESTADO recusa", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta();

    // Volta para `received` sem mexer em `row_version`.
    await pool.query(
      "UPDATE engine_tool_calls SET state = 'received' WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("state_conflict");
  });

  it("28. versão errada com o estado CERTO: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta();

    await pool.query(
      "UPDATE engine_tool_calls SET row_version = row_version + 1 WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(row_version + 1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  it("29. marcador JÁ carimbado: não recomeça, e o motivo diz exatamente isso", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callPronta();

    // Estado e versão INTACTOS; só o carimbo existe. A 140 permite: o
    // `handler_chk` só exige o trio (carimbo + dispatch + reservation) quando o
    // estado é `handler_started`. É o único input que isola a guarda
    // `handler_started_at IS NULL` — o caso 23 move estado, versão e carimbo de
    // uma vez, então qualquer uma das três recusa sozinha.
    await pool.query(
      "UPDATE engine_tool_calls SET handler_started_at = now() WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    expect(r.ok).toBe(false);
    // NÃO pode ser `version_conflict`: a versão pedida é a versão corrente.
    if (!r.ok) expect(r.reason).toBe("already_started");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Casos 30-37 (P03.3d): `settleToolCall`.
  //
  // §5.7.4 item 8: exige fence do turno ATUAL além do `dispatch_token` — o token
  // da call sozinho não autoriza adotar resultado tardio.
  // §5.7.4 item 9: cancelamento depois do handler segue `classifyToolCancellation`
  // — `abort_safe` pode ficar `cancelled`, as demais viram `effect_unknown`, e
  // uma call `effect_unknown` continua bloqueadora mesmo com HTTP 200 depois.
  //
  // Os casos 36 e 37 são cirúrgicos DE SAÍDA, escritos antes da varredura: o
  // cenário "liquidar duas vezes" moveria estado e versão juntos, que é como
  // BM3/BM4 e CM7 sobreviveram.
  // ══════════════════════════════════════════════════════════════════════════

  /** Call com handler já iniciado — o estado de onde se liquida. */
  async function callIniciada(
    effect_class: "abort_safe" | "non_interruptible" = "non_interruptible",
  ): Promise<{
    run_id: string;
    turno: { turn_id: string; claim_token: string; attempt: number };
    call_id: string;
    dispatch_token: string;
    row_version: number;
  }> {
    const base = await callPronta(effect_class);
    const r = await noEscopo(() =>
      engineRunsRepo.markToolHandlerStarted({
        run_id: base.run_id,
        turn_id: base.turno.turn_id,
        origin_claim_token: base.turno.claim_token,
        call_id: base.call_id,
        expected_row_version: base.row_version,
        dispatch_token: base.dispatch_token,
        reservation_token: randomUUID(),
        approval_claim_token: null,
      }),
    );
    if (!r.ok) throw new Error("setup: markToolHandlerStarted falhou");
    const row = await pool.query<{ row_version: string }>(
      "SELECT row_version FROM engine_tool_calls WHERE call_id = $1",
      [base.call_id],
    );
    return { ...base, row_version: Number(row.rows[0]?.row_version) };
  }

  it("30. `completed` grava resultado e receipt, e a evidência vira `committed`", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada("non_interruptible");

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: {
          kind: "completed",
          result: { ok: true, eco: "oi" },
          receipt: { json: { recibo: 1 }, hash: "d".repeat(64) },
        },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{
      state: string;
      finished_at: string | null;
      result_json: unknown;
      receipt_hash: string | null;
      effect_evidence: string;
    }>(
      "SELECT state, finished_at, result_json, receipt_hash, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("completed");
    expect(row.rows[0]?.finished_at).not.toBeNull();
    expect(row.rows[0]?.result_json).toEqual({ ok: true, eco: "oi" });
    expect(row.rows[0]?.receipt_hash).toBe("d".repeat(64));
    // Efeito aconteceu e sabemos disso: a evidência sobe de `possible`.
    expect(row.rows[0]?.effect_evidence).toBe("committed");
  });

  it("31. `cancelled` é permitido para `abort_safe`", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada("abort_safe");

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "cancelled", result: { cancelado: true } },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ state: string; effect_evidence: string }>(
      "SELECT state, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("cancelled");
    expect(row.rows[0]?.effect_evidence).toBe("none");
  });

  it("32. `cancelled` é RECUSADO para classe com efeito — tem de ser `effect_unknown`", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada("non_interruptible");

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "cancelled", result: { cancelado: true } },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("cancellation_not_allowed");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("handler_started");
  });

  it("33. `effect_unknown` força a evidência para `unknown`", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada("non_interruptible");

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "effect_unknown", result: { erro: "timeout" } },
      }),
    );
    expect(r.ok).toBe(true);

    const row = await pool.query<{ state: string; effect_evidence: string }>(
      "SELECT state, effect_evidence FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("effect_unknown");
    // A 140 exige essa coerência; aqui ela é imposta pela operação também.
    expect(row.rows[0]?.effect_evidence).toBe("unknown");
  });

  it("34. `dispatch_token` divergente não liquida nada", async () => {
    const { run_id, turno, call_id, row_version } = await callIniciada();

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token: randomUUID(),
        outcome: { kind: "completed", result: { ok: true }, receipt: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dispatch_token_mismatch");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("handler_started");
  });

  it("35. fence do turno ATUAL: o token da call sozinho não adota resultado tardio", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada();

    // Só o token do turno gira — a tentativa fica igual, isolando o fence de
    // origem (§5.7.4 item 8: `dispatch_token` correto NÃO basta).
    const soToken = randomUUID();
    await pool.query("UPDATE agent_turns SET claim_token = $2 WHERE id = $1", [
      turno.turn_id,
      soToken,
    ]);

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: soToken,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "completed", result: { ok: true }, receipt: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale_claim");

    const row = await pool.query<{ state: string }>(
      "SELECT state FROM engine_tool_calls WHERE call_id = $1",
      [call_id],
    );
    expect(row.rows[0]?.state).toBe("handler_started");
  });

  it("36. estado errado com a versão CERTA: só a guarda de ESTADO recusa", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada();

    await pool.query(
      "UPDATE engine_tool_calls SET state = 'dispatching', handler_started_at = NULL WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "completed", result: { ok: true }, receipt: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("state_conflict");
  });

  it("37. versão errada com o estado CERTO: só a guarda de VERSÃO recusa", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada();

    await pool.query(
      "UPDATE engine_tool_calls SET row_version = row_version + 1 WHERE call_id = $1",
      [call_id],
    );

    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: { kind: "completed", result: { ok: true }, receipt: null },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "version_conflict") {
      expect(r.current_row_version).toBe(row_version + 1);
    } else if (!r.ok) {
      throw new Error(`esperado version_conflict, veio ${r.reason}`);
    }
  });

  it("38. receipt com hash malformado é recusado, e nada é gravado", async () => {
    const { run_id, turno, call_id, dispatch_token, row_version } =
      await callIniciada();

    // A varredura de mutação mostrou esta validação SOBREVIVENDO: ela existe no
    // código e nenhum caso a exercitava. Sem ela, o `receipt_chk` da 140
    // (`receipt_hash ~ '^[0-9a-f]{64}$'` quando há `receipt_json`) ainda barra —
    // mas transformando uma recusa TIPADA numa transação que estoura. O banco é
    // a rede de segurança, não a primeira linha.
    const r = await noEscopo(() =>
      engineRunsRepo.settleToolCall({
        run_id,
        turn_id: turno.turn_id,
        origin_claim_token: turno.claim_token,
        call_id,
        expected_row_version: row_version,
        dispatch_token,
        outcome: {
          kind: "completed",
          result: { ok: true },
          receipt: { json: { recibo: 1 }, hash: "nao-e-um-sha256" },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_receipt");

    const row = await pool.query<{
      state: string;
      receipt_hash: string | null;
    }>("SELECT state, receipt_hash FROM engine_tool_calls WHERE call_id = $1", [
      call_id,
    ]);
    expect(row.rows[0]?.state).toBe("handler_started");
    expect(row.rows[0]?.receipt_hash).toBeNull();
  });
});
