/**
 * P04.1 (spec §8.2.3 passo 2, §8.2.4) — CARACTERIZAÇÃO de
 * `conversation_control_commands` contra Postgres REAL.
 *
 * A migration 141 cria a linha do COMANDO de pause/resume. O estado já morava
 * em `conversation_controls` (140); o que faltava era onde guardar o resultado
 * de um comando para poder DEVOLVÊ-LO. Sem isso, "retry da mesma chave devolve
 * o mesmo resultado, sem novo incremento de epoch" (§8.2.1) seria promessa que
 * o código não consegue cumprir — ele não saberia que já viu aquela chave.
 *
 * O que estes casos prendem, e que nenhum compilador prende:
 *
 *   1. a idempotência é do BANCO, escopada por tenant+agent — duas chamadas
 *      simultâneas com a mesma chave produzem UMA linha;
 *   2. `request_hash` separa REDELIVERY de CONFLITO. Guardar só a chave
 *      transformaria "mesma chave, payload diferente" em última-escrita-vence,
 *      que é o que o §8.2.4 proíbe;
 *   3. `barrier_committed` e `drain_status` são CAMPOS DIFERENTES, porque são
 *      fatos diferentes: o §8.2.3 diz em letras que `barrierCommitted=true` não
 *      significa `drainStatus='complete'`;
 *   4. desfecho é tipado nos DOIS sentidos — recusa exige motivo, aceite não
 *      inventa um;
 *   5. o escopo é fail-closed contra o literal `default`, como na 133 e na 140.
 *
 * Testes de CARACTERIZAÇÃO: registram a linha de base sem falha artificial
 * (§4). A proteção contra caso vazio é `expectPgError`, que LANÇA se a operação
 * passar, somada à asserção por SQLSTATE — "deu erro" não prova nada, porque um
 * typo no INSERT também dá erro.
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T_A = "hermes-cmd-tenant-a";
const G_A = "hermes-cmd-agent-a";
const T_B = "hermes-cmd-tenant-b";
const G_B = "hermes-cmd-agent-b";
const SHA = "a".repeat(64);

let pool: pg.Pool;

async function ensureTenantAgent(tenant: string, agent: string): Promise<void> {
  await pool.query(
    "INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING",
    [tenant],
  );
  await pool.query(
    "INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING",
    [agent, tenant],
  );
}

/** Controle em `bot` — o estado de onde um `pause` parte. */
async function mkControl(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [id, tenant, agent, `stream-${id}`, randomUUID()],
  );
  return id;
}

type CmdOver = Partial<{
  kind: string;
  idempotency_key: string;
  request_hash: string;
  expected_epoch: number;
  result_epoch: number | null;
  requested_by_app_user_id: string;
  status: string;
  outcome_code: string | null;
  barrier_committed: boolean;
  drain_status: string | null;
  summary_json: string;
  claimed_by: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
}>;

async function mkCommand(
  tenant: string,
  agent: string,
  control_id: string,
  over: CmdOver = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_control_commands
       (tenant_id, agent_id, control_id, kind, idempotency_key, request_hash,
        expected_epoch, result_epoch, requested_by_app_user_id, status, outcome_code,
        barrier_committed, drain_status, summary_json, claimed_by, claim_token, lease_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)`,
    [
      tenant,
      agent,
      control_id,
      over.kind ?? "pause",
      over.idempotency_key ?? randomUUID(),
      over.request_hash ?? SHA,
      over.expected_epoch ?? 0,
      over.result_epoch ?? null,
      over.requested_by_app_user_id ?? "operador-1",
      over.status ?? "pending",
      over.outcome_code ?? null,
      over.barrier_committed ?? false,
      over.drain_status ?? null,
      over.summary_json ?? "{}",
      over.claimed_by ?? null,
      over.claim_token ?? null,
      over.lease_expires_at ?? null,
    ],
  );
}

/** Erro do Postgres com `code`, para asserção por SQLSTATE e não por mensagem. */
async function expectPgError(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? "", message: e.message ?? "" };
  }
  throw new Error("esperava erro do Postgres, mas a operação passou");
}

d("conversation_control_commands — caracterização contra Postgres real", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await ensureTenantAgent(T_A, G_A);
    await ensureTenantAgent(T_B, G_B);
  });

  afterAll(async () => {
    // VAZAMENTO ESTANCADO — descoberto depois, medindo, não por leitura.
    //
    // `conversation_control_commands_outbox_idx` é PARCIAL e CROSS-TENANT:
    // `(lease_expires_at, tenant_id, agent_id) WHERE status='accepted' AND
    // drain_status IS DISTINCT FROM 'complete'`. A coluna líder é o prazo, não
    // o tenant — a mesma forma dos varredores das migrations 114/131/140.
    //
    // Este spec cria 2 comandos `accepted` por rodada e não os retirava: cinco
    // execuções deixaram 10 linhas na fila, e a contagem só parou de crescer
    // quando eu a atribuí (os specs de P04.3b, escritos depois com a guarda,
    // estavam em ZERO com 420 comandos criados). Um varredor de outbox futuro
    // herdaria esse lixo como trabalho pendente real.
    //
    // APOSENTA em vez de apagar: a FK do comando para o controle é
    // `ON DELETE RESTRICT`, e marcar `drain_status='complete'` é o que tira a
    // linha do predicado parcial. O histórico fica; o que sai é a fila.
    if (pool) {
      await pool.query(
        `UPDATE conversation_control_commands
            SET drain_status = 'complete', updated_at = now()
          WHERE tenant_id = ANY($1::text[])
            AND status = 'accepted'
            AND drain_status IS DISTINCT FROM 'complete'`,
        [[T_A, T_B]],
      );
    }
    await pool?.end();
  });

  it("1. `kind` fora do vocabulário é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    // Só `pause` e `resume` são comandos de OPERADOR. `pausing → human` é do
    // reconciliador Maia (§8.2.1) e não é pedido de ninguém.
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { kind: "confirm_drain" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("2. `status` fora do vocabulário é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { status: "quase" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("3. `request_hash` fora do formato sha256 é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { request_hash: "ABC123" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("4. a MESMA chave de idempotência duas vezes no escopo é recusada", async () => {
    const c = await mkControl(T_A, G_A);
    const chave = randomUUID();
    await mkCommand(T_A, G_A, c, { idempotency_key: chave });
    // É isto que faz "retry devolve o mesmo comando" ser possível: o banco
    // recusa a segunda linha, e o chamador lê a primeira.
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { idempotency_key: chave }),
    );
    expect(erro.code).toBe("23505");
  });

  it("5. a mesma chave em OUTRO escopo convive (complemento do 4)", async () => {
    const chave = randomUUID();
    const cA = await mkControl(T_A, G_A);
    const cB = await mkControl(T_B, G_B);
    await mkCommand(T_A, G_A, cA, { idempotency_key: chave });
    // Sem este caso, a unique poderia ser GLOBAL e o caso 4 seguiria verde —
    // e uma conta leria o resultado do comando de outra.
    await mkCommand(T_B, G_B, cB, { idempotency_key: chave });
    const r = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM conversation_control_commands WHERE idempotency_key = $1",
      [chave],
    );
    expect(Number(r.rows[0]?.n)).toBe(2);
  });

  it("6. a FK composta não alcança controle de OUTRO tenant", async () => {
    const alheio = await mkControl(T_B, G_B);
    const erro = await expectPgError(() => mkCommand(T_A, G_A, alheio));
    expect(erro.code).toBe("23503");
  });

  it("7. escopo `default` é recusado (fail-closed, como 133 e 140)", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      pool.query(
        `INSERT INTO conversation_control_commands
           (tenant_id, agent_id, control_id, kind, idempotency_key, request_hash,
            expected_epoch, requested_by_app_user_id)
         VALUES ('default', $1, $2, 'pause', $3, $4, 0, 'op')`,
        [G_A, c, randomUUID(), SHA],
      ),
    );
    // Um comando sob o literal `default` seria comando GLOBAL disfarçado.
    expect(["23514", "23503"]).toContain(erro.code);
  });

  it("8. `accepted` SEM `result_epoch` é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { status: "accepted", result_epoch: null }),
    );
    expect(erro.code).toBe("23514");
  });

  it("9. `accepted` COM `result_epoch` é válido (complemento do 8)", async () => {
    const c = await mkControl(T_A, G_A);
    await mkCommand(T_A, G_A, c, { status: "accepted", result_epoch: 1 });
    const r = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM conversation_control_commands WHERE control_id = $1",
      [c],
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });

  it("10. recusa SEM motivo é recusada", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { status: "conflict", outcome_code: null }),
    );
    expect(erro.code).toBe("23514");
  });

  it("11. aceite COM motivo também é recusado (o outro sentido do 10)", async () => {
    const c = await mkControl(T_A, G_A);
    // O par importa: um CHECK que só exigisse motivo na recusa deixaria um
    // `accepted` carregar `epoch_mismatch` e a leitura ficaria contraditória.
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, {
        status: "accepted",
        result_epoch: 1,
        outcome_code: "epoch_mismatch",
      }),
    );
    expect(erro.code).toBe("23514");
  });

  it("12. claim PARCIAL do outbox é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { claimed_by: "worker-1", claim_token: null }),
    );
    expect(erro.code).toBe("23514");
  });

  it("13. claim COMPLETO é válido (complemento do 12)", async () => {
    const c = await mkControl(T_A, G_A);
    await mkCommand(T_A, G_A, c, {
      claimed_by: "worker-1",
      claim_token: randomUUID(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const r = await pool.query<{ claimed_by: string }>(
      "SELECT claimed_by FROM conversation_control_commands WHERE control_id = $1",
      [c],
    );
    expect(r.rows[0]?.claimed_by).toBe("worker-1");
  });

  it("14. `barrier_committed` e `drain_status` são INDEPENDENTES (§8.2.3)", async () => {
    const c = await mkControl(T_A, G_A);
    // A combinação que o §8.2.3 manda ser expressável: barreira commitada E
    // drenagem ainda pendente. Se o schema os colapsasse num campo só, esta
    // linha seria inexprimível — e a UI passaria a afirmar que nenhuma mensagem
    // chega depois do clique, que é exatamente o que a spec proíbe prometer.
    await mkCommand(T_A, G_A, c, {
      status: "accepted",
      result_epoch: 1,
      barrier_committed: true,
      drain_status: "pending",
    });
    const r = await pool.query<{
      barrier_committed: boolean;
      drain_status: string;
    }>(
      "SELECT barrier_committed, drain_status FROM conversation_control_commands WHERE control_id = $1",
      [c],
    );
    expect(r.rows[0]?.barrier_committed).toBe(true);
    expect(r.rows[0]?.drain_status).toBe("pending");
  });

  it("15. `drain_status` fora do vocabulário é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, {
        status: "accepted",
        result_epoch: 1,
        drain_status: "quase_drenado",
      }),
    );
    expect(erro.code).toBe("23514");
  });

  it("16. `expected_epoch` negativo é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { expected_epoch: -1 }),
    );
    expect(erro.code).toBe("23514");
  });

  it("17. `summary_json` acima de 16 KiB é recusado", async () => {
    const c = await mkControl(T_A, G_A);
    const enorme = JSON.stringify({ x: "a".repeat(20_000) });
    const erro = await expectPgError(() =>
      mkCommand(T_A, G_A, c, { summary_json: enorme }),
    );
    // Resumo "sem conteúdo" (§8.2.4) tem teto: a linha é evidência, não log.
    expect(erro.code).toBe("23514");
  });
});
