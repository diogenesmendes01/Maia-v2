/**
 * P03.8a (spec §5.6.2, capítulo 10 linha 2625) — CARACTERIZAÇÃO de
 * `engine_projections` contra Postgres REAL.
 *
 * **Por que este arquivo existe:** a tabela nasceu na migration 140 junto com as
 * três irmãs do journal, mas — ao contrário delas — `grep` em `tests/` devolvia
 * ZERO. `engine_runs`, `engine_tool_calls` e `engine_run_events` ganharam
 * caracterização no P03.1; as projeções ficaram sem uma única asserção, e o
 * capítulo 10 lista "projeções" como escopo do P03. Isto fecha a lacuna.
 *
 * Não confundir com o adiamento registrado no P03.6b, que continua de pé e é
 * outra coisa: PROCESSAR projeções (criá-las no fechamento, executá-las) é a
 * costura do aprendizado governado, P08/P09. O que se caracteriza aqui são os
 * INVARIANTES DE SCHEMA, que já existem e hoje ninguém verifica.
 *
 * Testes de CARACTERIZAÇÃO: registram a linha de base sem falha artificial. A
 * proteção contra caso vazio é `expectPgError`, que LANÇA se a operação passar,
 * somada à asserção por SQLSTATE — "deu erro" não seria prova de nada, porque
 * um typo no INSERT também dá erro.
 *
 * Arquivo PRÓPRIO, e não apêndice de `hermes-runs-real-db.spec.ts`, por um
 * motivo mecânico: aquele arquivo reprova em `prettier --check` (o gate da casa
 * é `npm run format` = `prettier --write src`, que NÃO cobre `tests/`), então
 * acrescentar casos lá e formatar reescreveria 461 linhas preexistentes e o
 * commit deixaria de conter apenas as alterações desta tarefa.
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

const T_A = "hermes-proj-tenant-a";
const G_A = "hermes-proj-agent-a";
const T_B = "hermes-proj-tenant-b";
const G_B = "hermes-proj-agent-b";
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

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

async function mkTurn(
  tenant: string,
  agent: string,
): Promise<{ turn_id: string; claim: string }> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, now())`,
    [mensagem_id, tenant, agent],
  );
  const turn_id = randomUUID();
  const claim = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns (id, tenant_id, agent_id, representative_message_id, status, claim_token, attempt_count)
     VALUES ($1, $2, $3, $4, 'running', $5, 1)`,
    [turn_id, tenant, agent, mensagem_id, claim],
  );
  return { turn_id, claim };
}

async function mkControl(tenant: string, agent: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1, $2, $3, $4, 1, $5)`,
    [id, tenant, agent, `stream-${id}`, randomUUID()],
  );
  return id;
}

async function mkBinding(
  tenant: string,
  agent: string,
  turn_id: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO engine_turn_bindings (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest, protocol_version, max_generations)
     VALUES ($1, $2, $3, 'hermes', 'adapter-0.1.0', $4, 1, 3)`,
    [tenant, agent, turn_id, SHA],
  );
}

/** Run `running` pronto para pendurar projeções. */
async function mkRun(tenant: string, agent: string): Promise<string> {
  const { turn_id, claim } = await mkTurn(tenant, agent);
  await mkBinding(tenant, agent, turn_id);
  const control_id = await mkControl(tenant, agent);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO engine_runs (
       id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt, origin_claim_token,
       origin_worker_id, control_id, control_epoch, mode, manifest_digest, phase, request_key,
       remote_instance_id, remote_run_id, request_json, request_hash, host_context_json,
       host_context_hash, deadline_at, reconcile_deadline_at)
     VALUES ($1,$2,$3,$4,1,1,$5,'worker-1',$6,0,'live',$7,'running',$8,'inst-1',NULL,
             '{"version":1}'::jsonb,$9,'{"version":1}'::jsonb,$10,
             now() + interval '5 minutes', now() + interval '30 minutes')`,
    [
      id,
      tenant,
      agent,
      turn_id,
      claim,
      control_id,
      SHA,
      randomUUID(),
      SHA,
      SHA2,
    ],
  );
  return id;
}

type ProjOver = Partial<{
  projection: string;
  state: string;
  anchor_message_id: string | null;
  finished_at: string | null;
  last_error_code: string | null;
}>;

async function mkProjection(
  tenant: string,
  agent: string,
  run_id: string,
  over: ProjOver = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO engine_projections
       (tenant_id, agent_id, run_id, projection, state, anchor_message_id, finished_at, last_error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      tenant,
      agent,
      run_id,
      over.projection ?? "event_history",
      over.state ?? "pending",
      over.anchor_message_id ?? null,
      over.finished_at ?? null,
      over.last_error_code ?? null,
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

d("engine_projections — caracterização contra Postgres real", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await ensureTenantAgent(T_A, G_A);
    await ensureTenantAgent(T_B, G_B);
  });

  /**
   * APOSENTA os runs que este spec criou — mesma lição que o spec de varredura
   * me ensinou da pior maneira, aplicada aqui ANTES de causar o estrago.
   *
   * `mkRun` insere em `phase = 'running'` e não toca `next_poll_at`, que assume
   * o default `now()` da 140. Toda linha destas nasce, portanto, VENCIDA — e
   * `enumerateDueScopes` é cross-tenant, então cada rodada deste arquivo
   * empurraria ~15 escopos novos para o conjunto que o caso 5 daquele spec
   * pagina. Foi assim que a suíte se envenenou uma vez e o baseline da
   * varredura de mutação ficou vermelho depois de 254 escopos acumulados.
   *
   * Empurrar o agendamento, e não apagar: o journal é imutável por projeto
   * (`engine_run_events` tem trigger append-only e a FK RESTRICT prende
   * `engine_runs`), e desativar essa proteção para limpar teste seria contornar
   * a invariante que o próprio P03.1 verificou.
   */
  afterAll(async () => {
    if (pool) {
      await pool.query(
        `UPDATE engine_runs
            SET next_poll_at = clock_timestamp() + interval '100 years'
          WHERE tenant_id = ANY($1::text[])`,
        [[T_A, T_B]],
      );
      await pool.end();
    }
  });

  it("1. `projection` fora do vocabulário é recusada", async () => {
    const run = await mkRun(T_A, G_A);
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, { projection: "resumo_inventado" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("2. `state` fora do vocabulário é recusado", async () => {
    const run = await mkRun(T_A, G_A);
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, { state: "quase_pronto" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("3. `completed` sem `finished_at` é recusado", async () => {
    const run = await mkRun(T_A, G_A);
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, { state: "completed" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("4. `uncertain` TAMBÉM exige `finished_at`", async () => {
    const run = await mkRun(T_A, G_A);
    // `uncertain` é o estado que a 140 criou porque "começou e não sei se
    // terminou" é fato diferente de "falhou". Exigir `finished_at` nele impede
    // um `uncertain` eterno sem carimbo de quando se soube.
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, { state: "uncertain" }),
    );
    expect(erro.code).toBe("23514");
  });

  it("5. `started` SEM `finished_at` é válido (complemento de 3 e 4)", async () => {
    const run = await mkRun(T_A, G_A);
    // Sem este caso, o CHECK poderia ser "sempre exige finished_at" e os casos
    // 3 e 4 continuariam verdes — provariam a recusa sem provar a fronteira.
    await mkProjection(T_A, G_A, run, { state: "started" });
    const r = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM engine_projections WHERE run_id = $1",
      [run],
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });

  it("6. `anchor_message_id` fora de `event_history` é recusado", async () => {
    const run = await mkRun(T_A, G_A);
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, {
        projection: "postturn_graph",
        anchor_message_id: randomUUID(),
      }),
    );
    expect(erro.code).toBe("23514");
  });

  it("7. `anchor_message_id` em `event_history` é válido (complemento de 6)", async () => {
    const run = await mkRun(T_A, G_A);
    await mkProjection(T_A, G_A, run, {
      projection: "event_history",
      anchor_message_id: randomUUID(),
    });
    const r = await pool.query<{ anchor_message_id: string | null }>(
      "SELECT anchor_message_id FROM engine_projections WHERE run_id = $1",
      [run],
    );
    // Referência FORENSE sem FK (a 140 é explícita); o escopo é validado na
    // mesma TX de criação, não pelo banco.
    expect(r.rows[0]?.anchor_message_id).not.toBeNull();
  });

  it("8. a PK composta impede a MESMA projeção duas vezes no run", async () => {
    const run = await mkRun(T_A, G_A);
    await mkProjection(T_A, G_A, run, { projection: "gap_reflection" });
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, { projection: "gap_reflection" }),
    );
    expect(erro.code).toBe("23505");
  });

  it("9. a mesma projeção convive em runs DIFERENTES (complemento de 8)", async () => {
    const r1 = await mkRun(T_A, G_A);
    const r2 = await mkRun(T_A, G_A);
    await mkProjection(T_A, G_A, r1, { projection: "gap_reflection" });
    await mkProjection(T_A, G_A, r2, { projection: "gap_reflection" });
    const r = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM engine_projections WHERE run_id = ANY($1::uuid[])",
      [[r1, r2]],
    );
    expect(Number(r.rows[0]?.n)).toBe(2);
  });

  it("10. a FK composta não alcança run de OUTRO tenant", async () => {
    const alheio = await mkRun(T_B, G_B);
    // O id existe, mas não sob o meu escopo: a FK é (tenant, agent, run).
    const erro = await expectPgError(() => mkProjection(T_A, G_A, alheio));
    expect(erro.code).toBe("23503");
  });

  it("11. RESTRICT: run com projeção não pode ser apagado", async () => {
    const run = await mkRun(T_A, G_A);
    await mkProjection(T_A, G_A, run);
    const erro = await expectPgError(() =>
      pool.query("DELETE FROM engine_runs WHERE id = $1", [run]),
    );
    // Purga exige ordem autorizada (projections/events/calls/runs/binding),
    // §5.6.2 item 9 — o banco recusa a ordem errada.
    expect(erro.code).toBe("23503");
  });

  it("12. `last_error_code` acima de 64 caracteres é recusado", async () => {
    const run = await mkRun(T_A, G_A);
    const erro = await expectPgError(() =>
      mkProjection(T_A, G_A, run, {
        state: "failed",
        finished_at: new Date().toISOString(),
        last_error_code: "x".repeat(65),
      }),
    );
    expect(erro.code).toBe("23514");
  });

  it("13. o estado AVANÇA por UPDATE — ausência de trigger é deliberada", async () => {
    const run = await mkRun(T_A, G_A);
    await mkProjection(T_A, G_A, run);

    // As três irmãs do journal têm trigger (`engine_runs_immutable_trg`,
    // `engine_tool_calls_immutable_trg`, `engine_run_events_append_only_trg`).
    // `engine_projections` NÃO tem, e a assimetria é correta: uma projeção
    // caminha `pending → started → completed`. Este caso existe para que a
    // ausência fique registrada como DECISÃO — quem "consertar" a assimetria
    // acrescentando um trigger quebra aqui, e não em produção.
    await pool.query(
      "UPDATE engine_projections SET state = 'started', started_at = now() WHERE run_id = $1",
      [run],
    );
    await pool.query(
      "UPDATE engine_projections SET state = 'completed', finished_at = now() WHERE run_id = $1",
      [run],
    );

    const r = await pool.query<{ state: string; row_version: string }>(
      "SELECT state, row_version FROM engine_projections WHERE run_id = $1",
      [run],
    );
    expect(r.rows[0]?.state).toBe("completed");
    // `row_version` NÃO é incrementado pelo banco: quem versiona é a aplicação.
    // Registrado para que ninguém presuma versionamento automático.
    expect(Number(r.rows[0]?.row_version)).toBe(0);
  });
});
