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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  });
  afterAll(async () => {
    await pool.end();
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
    for (let i = 0; i < 200; i++) {
      const pagina = await engineRunsRepo.enumerateDueScopes({
        limit: limite,
        cursor,
      });
      tudo.push(...pagina.scopes);
      if (!pagina.next_cursor) return tudo;
      cursor = pagina.next_cursor;
    }
    throw new Error("paginação não terminou em 200 páginas");
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
});
