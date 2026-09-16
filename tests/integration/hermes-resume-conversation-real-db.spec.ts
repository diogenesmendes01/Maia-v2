/**
 * P04.5a (spec §8.2.1 linha 2346, §8.2.5) — a RETOMADA `human → bot`.
 *
 * ─── O que a spec exige ────────────────────────────────────────────────────
 *
 * §8.2.1: "`human → bot` | Operador autorizado, comando `resume` | Exige epoch
 * corrente, pendências conciliadas e política explícita; **incrementa epoch**;
 * cria novo contexto/sessão derivada para o próximo turno."
 *
 * §8.2.5: "**V1: `resumePolicy='future_only'` obrigatório.** (…) Capturar
 * watermark de ingresso **sob lock** (…) O próximo inbound **após** watermark
 * pode criar execução nova."
 *
 * ─── Por que o epoch incrementa aqui e NÃO incrementa na reconciliação ─────
 *
 * São fatos diferentes. A reconciliação CONFIRMA a mesma tomada (§8.2.1 é
 * explícito: "não incrementa epoch novamente só por confirmar"); a retomada
 * DEVOLVE a autoridade ao bot, e o §8.2.2 exige incrementar nos dois extremos
 * justamente para derrotar o ABA — "um run iniciado no epoch antigo não recupera
 * autoridade só porque o modo voltou a `bot`". O caso 2 prende isso.
 *
 * ─── O par de auditoria, e por que são DUAS ações ──────────────────────────
 *
 * `conversation_resume_requested` e `conversation_automation_resumed` entraram
 * no vocabulário no U-P04.2 pela razão que o caso 9 cobra: o §8.3.2 manda o
 * resume "recusar enquanto houver efeitos/entregas não conciliados", logo existe
 * um estado real em que o operador PEDIU e a automação ainda NÃO voltou. Uma
 * ação só apagaria essa distância — foi exatamente o erro que o C24 registra.
 *
 * ─── A fixture popula a stream DE PROPÓSITO (C48) ──────────────────────────
 *
 * Neste banco há 10.611 turnos e ZERO com `first_ingress_seq`, porque todas as
 * fixtures da épica criam turno por INSERT cru sem stream. Um teste de watermark
 * montado sobre esse corpus compararia nulo com nulo e passaria sem medir nada.
 * Aqui a sequência é semeada com números ESCOLHIDOS, satisfazendo o
 * `agent_turns_stream_shadow_chk` (trio coerente, `first >= 1`, `last >= first`).
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { conversationControlRepo } from "@/db/repositories/conversation-control-repo.js";
import { withTx } from "@/db/client.js";
import { renderPrometheus, _resetForTests } from "@/lib/metrics.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "resume-tenant";
const AGENT = "resume-agent";
/** Os DOIS eixos do escopo, de saída — a regra que adotei no C41. */
const OUTRO_AGENTE = "resume-agent-2";
const OUTRO_TENANT = "resume-tenant-2";
const OPERADOR = "operador-1";

let pool: pg.Pool;

const noEscopo = <T>(
  fn: () => Promise<T>,
  tenant = TENANT,
  agente = AGENT,
): Promise<T> =>
  runWithTenantContext({ tenant_id: tenant, agent_id: agente }, fn);

async function seed(tenant = TENANT, agente = AGENT): Promise<void> {
  await pool.query(
    "INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING",
    [tenant],
  );
  await pool.query(
    "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
    [agente, tenant],
  );
}

/** Controle já DRENADO — o único estado de onde a retomada sai (§8.2.1). */
async function mkControleHumano(
  tenant = TENANT,
  agente = AGENT,
  stream_key = `stream-${randomUUID()}`,
): Promise<{ control_id: string; stream_key: string }> {
  const control_id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls
       (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id,
        mode, control_epoch, owner_app_user_id, paused_at, reason_code)
     VALUES ($1,$2,$3,$4,1,$5,'human',1,$6,now(),'operator_takeover')`,
    [control_id, tenant, agente, stream_key, randomUUID(), OPERADOR],
  );
  return { control_id, stream_key };
}

/**
 * Um turno RETIDO na stream, com sequência de ingresso ESCOLHIDA.
 *
 * Satisfaz o `agent_turns_stream_shadow_chk`: trio coerente, `first >= 1`,
 * `last >= first`. E semeia `agent_stream_sequences`, cuja PK é
 * `(tenant, agent, stream_key)` e cujo `scope_chk` recusa o literal `default`.
 */
async function mkTurnoRetido(
  stream_key: string,
  ingress_seq: number,
  status = "queued",
  tenant = TENANT,
  agente = AGENT,
): Promise<string> {
  await pool.query(
    `INSERT INTO agent_stream_sequences
       (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, agent_id, stream_key)
       DO UPDATE SET last_ingress_seq = GREATEST(
         agent_stream_sequences.last_ingress_seq, EXCLUDED.last_ingress_seq)`,
    [tenant, agente, stream_key, ingress_seq],
  );
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
     VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
    [mensagem_id, tenant, agente],
  );
  const turn_id = randomUUID();
  await pool.query(
    `INSERT INTO agent_turns
       (id, tenant_id, agent_id, status, representative_message_id,
        stream_key, stream_key_version, first_ingress_seq, last_ingress_seq)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7)`,
    [turn_id, tenant, agente, status, mensagem_id, stream_key, ingress_seq],
  );
  return turn_id;
}

async function lerTurno(
  id: string,
): Promise<{ status: string; outcome: string | null }> {
  const r = await pool.query(
    `SELECT status, outcome FROM agent_turns WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/**
 * Um run ABERTO (`phase <> 'closed'`) preso ao turno — a forma de efeito
 * pendente que `turnWithoutPendingEffectSql` enxerga. Vinte e quatro colunas
 * porque a 140 as exige NOT NULL; o que importa para o teste são `turn_id` e
 * `phase`.
 */
async function mkRunAberto(turn_id: string, control_id: string): Promise<void> {
  // O binding vem ANTES por FK (`engine_runs_binding_fk`): a 140 exige que todo
  // run aponte para um turno já vinculado a um motor. Sem esta linha o INSERT
  // seguinte falha — e falharia como "teste vermelho", escondendo que o defeito
  // era da fixture.
  await pool.query(
    `INSERT INTO engine_turn_bindings
       (tenant_id, agent_id, turn_id, engine, adapter_revision,
        configuration_digest, protocol_version, max_generations)
     VALUES ($1,$2,$3,'hermes','rev-1',$4,1,1)
     ON CONFLICT DO NOTHING`,
    [TENANT, AGENT, turn_id, "c".repeat(64)],
  );
  await pool.query(
    `INSERT INTO engine_runs
       (id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt,
        origin_claim_token, origin_worker_id, control_id, control_epoch, mode,
        manifest_digest, phase, request_key, remote_instance_id, request_json,
        request_hash, host_context_json, host_context_hash, deadline_at,
        reconcile_deadline_at)
     VALUES ($1,$2,$3,$4,1,1,$5,'w-1',$6,1,'live',$7,'running',$8,'inst-1',
             '{}'::jsonb,$7,'{}'::jsonb,$7, now()+interval '5 min',
             now()+interval '15 min')`,
    [
      randomUUID(),
      TENANT,
      AGENT,
      turn_id,
      randomUUID(),
      control_id,
      "d".repeat(64),
      randomUUID(),
    ],
  );
}

async function lerControle(id: string): Promise<{
  mode: string;
  control_epoch: string;
  resumed_at: Date | null;
  reason_code: string | null;
  resume_after_ingress_seq: string | null;
}> {
  const r = await pool.query(
    `SELECT mode, control_epoch::text AS control_epoch, resumed_at, reason_code,
            resume_after_ingress_seq::text AS resume_after_ingress_seq
       FROM conversation_controls WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function contarAuditoria(
  acao: string,
  control_id: string,
): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE acao = $1 AND metadata->>'control_id' = $2`,
    [acao, control_id],
  );
  return r.rows[0].n;
}

const pedido = (control_id: string, over: Record<string, unknown> = {}) => ({
  control_id,
  expected_epoch: "1",
  idempotency_key: randomUUID(),
  requested_by_app_user_id: OPERADOR,
  reason_code: "human_resolved" as const,
  resume_policy: "future_only" as const,
  request_payload: { nota: "atendimento concluído" },
  ...over,
});

d("resumeConversationTx — a devolução da automação", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seed();
    await seed(TENANT, OUTRO_AGENTE);
    await seed(OUTRO_TENANT, AGENT);
  });

  afterAll(async () => {
    // Guarda de poluição: o índice de outbox dos comandos é parcial e
    // CROSS-TENANT. Aposenta em vez de deletar (FK `ON DELETE RESTRICT`).
    if (pool) {
      await pool.query(
        `UPDATE conversation_control_commands
            SET drain_status = 'complete', updated_at = now()
          WHERE tenant_id = ANY($1::text[])
            AND status = 'accepted'
            AND drain_status IS DISTINCT FROM 'complete'`,
        [[TENANT, OUTRO_TENANT]],
      );
    }
    await pool?.end();
  });

  it("1. `human → bot`, com carimbo e motivo de RETOMADA", async () => {
    const { control_id } = await mkControleHumano();
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("bot");

    const c = await lerControle(control_id);
    expect(c.mode).toBe("bot");
    expect(c.resumed_at).not.toBeNull();
    // Os três motivos de retomada são outros que os de pausa — o CHECK da 140
    // aceita os sete, mas usar `operator_takeover` aqui mentiria sobre o fato.
    expect(c.reason_code).toBe("human_resolved");
  });

  it("2. o epoch INCREMENTA — é o outro extremo do ABA", async () => {
    // §8.2.2: incrementar no pause E no resume impede que um run iniciado no
    // epoch antigo recupere autoridade só porque o modo voltou a `bot`.
    // Contraste deliberado com a reconciliação, que NÃO incrementa.
    const { control_id } = await mkControleHumano();
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.epoch).toBe("2");
    expect((await lerControle(control_id)).control_epoch).toBe("2");
  });

  it("3. o watermark é o MAIOR ingresso retido, capturado sob lock", async () => {
    // `future_only`: o próximo inbound APÓS o watermark pode criar execução
    // nova; o que veio antes não é respondido automaticamente.
    const { control_id, stream_key } = await mkControleHumano();
    await mkTurnoRetido(stream_key, 7);
    await mkTurnoRetido(stream_key, 11);
    await mkTurnoRetido(stream_key, 9);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resume_after_ingress_seq).toBe("11");
    expect((await lerControle(control_id)).resume_after_ingress_seq).toBe("11");
  });

  it("4. sem turno retido, o watermark é o da stream — nunca inventado", async () => {
    // A coluna não tem CHECK (C48): quem garante o sentido é este caso. Sem
    // turno algum, o watermark vem do contador da stream, e um número
    // fabricado (0, ou o epoch) passaria no banco e mentiria.
    const { control_id, stream_key } = await mkControleHumano();
    await pool.query(
      `INSERT INTO agent_stream_sequences
         (tenant_id, agent_id, stream_key, stream_key_version, last_ingress_seq)
       VALUES ($1,$2,$3,1,42)`,
      [TENANT, AGENT, stream_key],
    );
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resume_after_ingress_seq).toBe("42");
  });

  it("5. retomar de `pausing` recusa — drenagem não confirmada", async () => {
    // §8.2.1 exige "pendências conciliadas". `pausing` é justamente o estado em
    // que elas ainda não foram.
    const control_id = randomUUID();
    await pool.query(
      `INSERT INTO conversation_controls
         (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id,
          mode, control_epoch, owner_app_user_id, paused_at, reason_code)
       VALUES ($1,$2,$3,$4,1,$5,'pausing',1,$6,now(),'operator_takeover')`,
      [control_id, TENANT, AGENT, `stream-${randomUUID()}`, randomUUID(), OPERADOR],
    );
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("mode_not_allowed");
    expect(r.current_mode).toBe("pausing");
  });

  it("6. retomar de `bot` recusa — não há automação a devolver", async () => {
    const control_id = randomUUID();
    await pool.query(
      `INSERT INTO conversation_controls
         (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [control_id, TENANT, AGENT, `stream-${randomUUID()}`, randomUUID()],
    );
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(
        pedido(control_id, { expected_epoch: "0" }),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("mode_not_allowed");
  });

  it("7. epoch obsoleto recusa e NÃO muta", async () => {
    const { control_id } = await mkControleHumano();
    const antes = await lerControle(control_id);
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(
        pedido(control_id, { expected_epoch: "0" }),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epoch_mismatch");
    expect(r.current_epoch).toBe("1");
    const depois = await lerControle(control_id);
    expect(depois.mode).toBe(antes.mode);
    expect(depois.control_epoch).toBe(antes.control_epoch);
  });

  it("8. o comando fica persistido como `resume`, aceito, com `result_epoch`", async () => {
    const { control_id } = await mkControleHumano();
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const cmd = await pool.query(
      `SELECT kind, status, outcome_code, expected_epoch::text AS e,
              result_epoch::text AS rr, request_hash
         FROM conversation_control_commands WHERE id = $1`,
      [r.command_id],
    );
    const row = cmd.rows[0];
    expect(row.kind).toBe("resume");
    expect(row.status).toBe("accepted");
    expect(row.outcome_code).toBeNull();
    expect(row.rr).toBe("2");
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("9. audita o PAR pedido/efeito — duas ações, não uma", async () => {
    // O §8.3.2 manda o resume recusar enquanto houver pendência, logo existe um
    // estado real em que o operador pediu e a automação não voltou. Colapsar as
    // duas ações apagaria essa distância — o erro que o C24 registra.
    const { control_id } = await mkControleHumano();
    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await contarAuditoria("conversation_resume_requested", control_id)).toBe(1);
    expect(await contarAuditoria("conversation_automation_resumed", control_id)).toBe(1);

    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE acao = 'conversation_automation_resumed'
          AND metadata->>'control_id' = $1`,
      [control_id],
    );
    expect(trilha.rows[0].metadata.epoch_before).toBe("1");
    expect(trilha.rows[0].metadata.epoch_after).toBe("2");
    expect(trilha.rows[0].metadata.resume_policy).toBe("future_only");
  });

  it("10. replay da mesma chave: mesmo comando, sem segundo epoch nem audit novo", async () => {
    const { control_id, stream_key } = await mkControleHumano();
    // Um turno retido de propósito: sem ele o replay descartaria 0 por não ter
    // o que descartar, e a asserção sobre `backlog_cancelled` seria vácua nos
    // DOIS lados. Com ele, o primeiro comando fecha 1 e o replay tem de fechar
    // 0 — que é a diferença entre "idempotente" e "repetido".
    await mkTurnoRetido(stream_key, 1);
    const p = pedido(control_id);
    const a = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(p),
    );
    const b = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(p),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.idempotent).toBe(true);
    expect(b.command_id).toBe(a.command_id);
    expect(a.backlog_cancelled).toBe(1);
    expect(b.backlog_cancelled).toBe(0);
    expect((await lerControle(control_id)).control_epoch).toBe("2");
    expect(await contarAuditoria("conversation_automation_resumed", control_id)).toBe(1);
  });

  it("11. mesma chave com payload divergente é conflito", async () => {
    const { control_id } = await mkControleHumano();
    const chave = randomUUID();
    await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(
        pedido(control_id, { idempotency_key: chave }),
      ),
    );
    const b = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(
        pedido(control_id, {
          idempotency_key: chave,
          request_payload: { nota: "OUTRA" },
        }),
      ),
    );
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe("payload_conflict");
  });

  it("12. a idempotência separa os DOIS eixos: tenant e agente", async () => {
    // Regra do C41, escrita antes da implementação.
    const chave = randomUUID();
    const a = await mkControleHumano(TENANT, AGENT);
    const b = await mkControleHumano(TENANT, OUTRO_AGENTE);
    const c = await mkControleHumano(OUTRO_TENANT, AGENT);

    const ra = await noEscopo(
      () => conversationControlRepo.resumeConversationTx(
        pedido(a.control_id, { idempotency_key: chave }),
      ), TENANT, AGENT);
    const rb = await noEscopo(
      () => conversationControlRepo.resumeConversationTx(
        pedido(b.control_id, { idempotency_key: chave }),
      ), TENANT, OUTRO_AGENTE);
    const rc = await noEscopo(
      () => conversationControlRepo.resumeConversationTx(
        pedido(c.control_id, { idempotency_key: chave }),
      ), OUTRO_TENANT, AGENT);

    expect(ra.ok && rb.ok && rc.ok).toBe(true);
    if (!ra.ok || !rb.ok || !rc.ok) return;
    expect(rb.idempotent).toBe(false);
    expect(rc.idempotent).toBe(false);
    expect(new Set([ra.command_id, rb.command_id, rc.command_id]).size).toBe(3);
  });

  it("14. sem a linha do CONTADOR, o watermark vem dos turnos retidos", async () => {
    // Este caso nasceu de um mutante SOBREVIVENTE, e a análise dele mudou a
    // minha conclusão. Remover o termo "maior turno retido" do watermark
    // passava na suíte inteira, e eu ia registrar como lacuna de fixture — mas
    // o raciocínio correto é outro: o contador É o alocador, então em produção
    // `contador >= maior ingresso de turno` sempre vale, e os dois lados do
    // GREATEST empatam. O termo do turno é defesa para quando a linha do
    // CONTADOR não existe — purgada, ou turno vindo de migração.
    //
    // É esse o caso que distingue os dois lados, e ele é realista: sem ele, o
    // watermark cairia para 0 e `future_only` reabriria todo o backlog.
    const { control_id, stream_key } = await mkControleHumano();
    await mkTurnoRetido(stream_key, 5);
    await mkTurnoRetido(stream_key, 9);
    await pool.query(
      `DELETE FROM agent_stream_sequences
        WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3`,
      [TENANT, AGENT, stream_key],
    );

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resume_after_ingress_seq).toBe("9");
  });

  it("13. turno SEM sequência de ingresso não quebra a captura (C50)", async () => {
    // `ensureTurnForMessage` — o caminho de backfill/compatibilidade — não
    // aceita stream, então turnos criados por ele nascem com ingresso NULO. O
    // watermark não consegue ordená-los, e a captura não pode falhar por isso.
    const { control_id, stream_key } = await mkControleHumano();
    await mkTurnoRetido(stream_key, 5);
    const mensagem_id = randomUUID();
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
       VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
      [mensagem_id, TENANT, AGENT],
    );
    await pool.query(
      `INSERT INTO agent_turns (id, tenant_id, agent_id, status, representative_message_id)
       VALUES ($1,$2,$3,'queued',$4)`,
      [randomUUID(), TENANT, AGENT, mensagem_id],
    );

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resume_after_ingress_seq).toBe("5");
  });

  // ─── P04.5b.2c — a FIAÇÃO: o resume descarta o backlog retido ────────────
  //
  // Até aqui `future_only` era promessa: o watermark era gravado e ninguém o
  // lia (C53), e os construtores do descarte existiam sem call site. Estes
  // casos são o que torna a política EXECUTADA em vez de declarada.

  it("15. o resume DESCARTA o backlog retido — `future_only` cumprido", async () => {
    const { control_id, stream_key } = await mkControleHumano();
    const a = await mkTurnoRetido(stream_key, 1);
    const b = await mkTurnoRetido(stream_key, 2);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backlog_cancelled).toBe(2);
    for (const id of [a, b]) {
      const t = await lerTurno(id);
      expect(t.status).toBe("ignored");
      expect(t.outcome).toBe("operator_cancelled");
    }
  });

  it("16. turno `running` NÃO é descartado, e o resume conclui mesmo assim", async () => {
    // O §8.2.5 é explícito: "turnos antes executados seguem conciliação
    // específica; não apagar seu resultado/efeito para fazê-los caber no
    // descarte do backlog". A recusa tem de ser por SELEÇÃO — o turno fica
    // fora do conjunto —, nunca por exceção que derrube a retomada.
    const { control_id, stream_key } = await mkControleHumano();
    const vivo = await mkTurnoRetido(stream_key, 1, "running");
    const morto = await mkTurnoRetido(stream_key, 2);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backlog_cancelled).toBe(1);
    expect((await lerTurno(vivo)).status).toBe("running");
    expect((await lerTurno(morto)).status).toBe("ignored");
  });

  it("17. turno com EFEITO pendente não é descartado", async () => {
    const { control_id, stream_key } = await mkControleHumano();
    const comEfeito = await mkTurnoRetido(stream_key, 1);
    const limpo = await mkTurnoRetido(stream_key, 2);
    await mkRunAberto(comEfeito, control_id);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backlog_cancelled).toBe(1);
    expect((await lerTurno(comEfeito)).status).toBe("queued");
    expect((await lerTurno(limpo)).status).toBe("ignored");
  });

  it("18. backlog de OUTRA stream do mesmo agente fica intacto", async () => {
    const { control_id, stream_key } = await mkControleHumano();
    const meu = await mkTurnoRetido(stream_key, 1);
    // Mesmo tenant, mesmo agente, outra conversa: o descarte é escopado pela
    // stream do CONTROLE, não pelo par tenant/agente.
    const alheio = await mkTurnoRetido(`v1:${randomUUID().replace(/-/g, "").repeat(2)}`, 1);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backlog_cancelled).toBe(1);
    expect((await lerTurno(meu)).status).toBe("ignored");
    expect((await lerTurno(alheio)).status).toBe("queued");
  });

  it("19. resume RECUSADO não descarta nada — o descarte é ATÔMICO com a retomada", async () => {
    // ⚠️ Este caso PASSA no vermelho, e isso está registrado de propósito: sem
    // implementação nada descarta, então a garantia vale trivialmente. Ele só
    // vira prova pela MUTAÇÃO — a que move o descarte para antes da checagem de
    // epoch tem de matá-lo. Contado como cobertura só depois disso.
    const { control_id, stream_key } = await mkControleHumano();
    const t = await mkTurnoRetido(stream_key, 1);

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(
        pedido(control_id, { expected_epoch: "999" }),
      ),
    );
    expect(r.ok).toBe(false);
    expect((await lerTurno(t)).status).toBe("queued");
    expect((await lerControle(control_id)).mode).toBe("human");
  });

  it("20. `...InTx` NÃO emite a métrica; a de transação própria emite", async () => {
    // Mesma assimetria de `completeRecoveredOutboundTurnInTx`: quem partilha a
    // transação do caller não pode publicar contador, porque o commit ainda não
    // aconteceu e um rollback faria a métrica contar descarte que não houve.
    _resetForTests();
    const um = await mkControleHumano();
    await mkTurnoRetido(um.stream_key, 1);
    await noEscopo(() =>
      withTx((tx) =>
        conversationControlRepo.resumeConversationInTx(tx, pedido(um.control_id)),
      ),
    );
    expect(await renderPrometheus()).not.toContain(
      'outcome="operator_cancelled"',
    );

    const dois = await mkControleHumano();
    await mkTurnoRetido(dois.stream_key, 1);
    await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(dois.control_id)),
    );
    expect(await renderPrometheus()).toContain('outcome="operator_cancelled"');
  });

  it("21. turno sem sequência de ingresso não é descartado (C50)", async () => {
    // O predicado exige `last_ingress_seq IS NOT NULL`. Um turno do caminho de
    // compatibilidade não é ordenável pelo watermark, e descartá-lo seria
    // decidir por ele sem critério — a regra que o C50 mandou não inventar.
    const { control_id, stream_key } = await mkControleHumano();
    const ordenavel = await mkTurnoRetido(stream_key, 3);
    const mensagem_id = randomUUID();
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
       VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
      [mensagem_id, TENANT, AGENT],
    );
    const semSeq = randomUUID();
    await pool.query(
      `INSERT INTO agent_turns (id, tenant_id, agent_id, status, representative_message_id)
       VALUES ($1,$2,$3,'queued',$4)`,
      [semSeq, TENANT, AGENT, mensagem_id],
    );

    const r = await noEscopo(() =>
      conversationControlRepo.resumeConversationTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backlog_cancelled).toBe(1);
    expect((await lerTurno(ordenavel)).status).toBe("ignored");
    expect((await lerTurno(semSeq)).status).toBe("queued");
  });
});
