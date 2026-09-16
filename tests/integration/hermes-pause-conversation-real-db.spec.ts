/**
 * P04.3b (spec §8.2.1, §8.2.3) — `pauseConversationTx` contra Postgres REAL.
 *
 * ─── Por que este spec é de INTEGRAÇÃO, e não unitário ─────────────────────
 *
 * A unidade inteira É a transação. O §8.2.3 passo 3 manda "trancar a row de
 * controle" e o passo 4 manda gravar "comando e auditoria durável na MESMA
 * transação"; o §8.2.3 ainda diz, sobre o fence, que "não confundir SELECT com
 * fence atômico" porque `if (epochMatches) await handler()` tem janela de
 * corrida. Nada disso é observável sem banco: um teste com repositório fingido
 * provaria que eu sei chamar as funções que escrevi, não que o PostgreSQL
 * recusa o que tem de recusar.
 *
 * ─── O que estes casos prendem ─────────────────────────────────────────────
 *
 *   1. a pausa é uma TRANSIÇÃO COMPLETA: `bot → pausing`, epoch incrementado,
 *      dono e carimbo preenchidos. Os CHECKs `conversation_controls_owner_chk`
 *      e `_paused_chk` tornam impossível sair de `bot` sem os dois, então uma
 *      implementação que esquecesse qualquer um deles não "passaria com um
 *      campo nulo" — ela quebraria. O caso 1 afirma os três juntos;
 *   2. **idempotência de comando**: mesma chave e mesmo payload devolvem o
 *      MESMO comando, sem segundo incremento de epoch — a cláusula literal do
 *      §8.2.1 ("retry da mesma chave devolve o resultado do mesmo comando, sem
 *      novo incremento/audit");
 *   3. e o corolário que a casa já fixou em `requestCommandWithAuditInTx`:
 *      **replay não gera linha de auditoria nova**, porque a operação não
 *      aconteceu de novo;
 *   4. `request_hash` separa REDELIVERY de CONFLITO. Guardar só a chave faria
 *      "mesma chave, payload diferente" virar última-escrita-vence, que o
 *      §8.2.4 proíbe;
 *   5. recusa NÃO MUTA. Epoch obsoleto, modo incompatível e controle
 *      inexistente devolvem desfecho tipado e deixam o controle intacto —
 *      um comando recusado que mexesse no estado seria o pior dos mundos;
 *   6. a unique de idempotência é ESCOPADA: a mesma chave em outro tenant
 *      convive. Uma unique global deixaria uma conta ler o comando da outra;
 *   7. a auditoria cai na MESMA transação e carrega o vínculo do §8.6.1
 *      (`command_id` no metadata), com `conversa_id` nulo — a coluna tem FK
 *      para `conversas`, e o controle desta fixture não tem conversa ligada.
 *
 * Skipped sem `TEST_DB_URL`, como os irmãos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { conversationControlRepo } from "@/db/repositories/conversation-control-repo.js";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "pause-conv-tenant";
const AGENT = "pause-conv-agent";
const OUTRO_TENANT = "pause-conv-tenant-2";
/**
 * Segundo agente DENTRO do mesmo tenant. Existe porque o escopo desta casa tem
 * DOIS eixos, e um teste que varia só o tenant deixa o outro sem prova — foi
 * exatamente assim que a mutação "idempotência sem `agent_id`" sobreviveu à
 * primeira varredura desta unidade.
 */
const OUTRO_AGENTE = "pause-conv-agent-2";
const OPERADOR = "operador-1";

let pool: pg.Pool;

const noEscopo = <T>(
  fn: () => Promise<T>,
  tenant = TENANT,
  agente = AGENT,
): Promise<T> =>
  runWithTenantContext({ tenant_id: tenant, agent_id: agente }, fn);

async function seedTenant(id: string, agente = AGENT): Promise<void> {
  await pool.query(
    "INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING",
    [id],
  );
  await pool.query(
    "INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING",
    [agente, id],
  );
}

async function mkControle(
  tenant = TENANT,
  agente = AGENT,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
     VALUES ($1,$2,$3,$4,1,$5)`,
    [id, tenant, agente, `stream-${id}`, randomUUID()],
  );
  return id;
}

async function lerControle(id: string): Promise<{
  mode: string;
  control_epoch: string;
  owner_app_user_id: string | null;
  paused_at: Date | null;
  reason_code: string | null;
}> {
  const r = await pool.query(
    `SELECT mode, control_epoch::text AS control_epoch, owner_app_user_id, paused_at, reason_code
       FROM conversation_controls WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function contarAuditoria(command_id: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE acao = 'conversation_pause_requested'
        AND metadata->>'command_id' = $1`,
    [command_id],
  );
  return r.rows[0].n;
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

d("pauseConversationTx — a barreira do controle humano", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seedTenant(TENANT);
    await seedTenant(OUTRO_TENANT);
    await seedTenant(TENANT, OUTRO_AGENTE);
  });

  afterAll(async () => {
    // POLUIÇÃO PRE-EMPTADA, não remediada depois — a lição do P03.8a.
    //
    // `conversation_control_commands_outbox_idx` é PARCIAL e CROSS-TENANT:
    // `(lease_expires_at, tenant_id, agent_id) WHERE status='accepted' AND
    // drain_status IS DISTINCT FROM 'complete'`. A coluna líder é o prazo, não
    // o tenant — mesma forma dos varredores das migrations 114/131/140. Cada
    // rodada deste spec deixa ~9 comandos aceitos e não drenados; sem isto,
    // eles se acumulam e o primeiro varredor de outbox que existir herda o
    // lixo, do jeito que a varredura do journal quebrou em P03.7b.
    //
    // APOSENTA em vez de apagar: a FK do comando para o controle é
    // `ON DELETE RESTRICT`, e marcar `drain_status='complete'` é justamente o
    // que tira a linha do predicado parcial — o índice deixa de vê-la. O
    // histórico fica; o que sai é a fila.
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

  it("1. pausa: `bot → pausing`, epoch +1, dono e carimbo — os três juntos", async () => {
    const control_id = await mkControle();
    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotent).toBe(false);
    expect(r.mode).toBe("pausing");
    expect(r.epoch).toBe("1");
    // `barrierCommitted=true` NÃO significa drenagem concluída — o §8.2.3 é
    // explícito, e por isso são campos diferentes.
    expect(r.barrier_committed).toBe(true);
    expect(r.drain_status).toBe("pending");

    const c = await lerControle(control_id);
    expect(c.mode).toBe("pausing");
    expect(c.control_epoch).toBe("1");
    expect(c.owner_app_user_id).toBe(OPERADOR);
    expect(c.paused_at).not.toBeNull();
    expect(c.reason_code).toBe("operator_takeover");
  });

  it("2. o comando fica persistido como `accepted`, com `result_epoch`", async () => {
    const control_id = await mkControle();
    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const cmd = await pool.query(
      `SELECT kind, status, outcome_code, expected_epoch::text AS expected_epoch,
              result_epoch::text AS result_epoch, request_hash, barrier_committed, drain_status
         FROM conversation_control_commands WHERE id = $1`,
      [r.command_id],
    );
    const row = cmd.rows[0];
    expect(row.kind).toBe("pause");
    expect(row.status).toBe("accepted");
    // `_outcome_chk`: aceite NÃO inventa motivo; `_resolved_chk`: aceite EXIGE
    // `result_epoch`. Os dois CHECKs vivem na 141.
    expect(row.outcome_code).toBeNull();
    expect(row.result_epoch).toBe("1");
    // `_request_hash_check` exige 64 hex puros — `computePayloadHash`, que
    // devolve `v2:<hex>`, REPROVARIA. Tem de ser o digest canônico (C13).
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("3. a auditoria cai na MESMA transação, com o vínculo do §8.6.1", async () => {
    const control_id = await mkControle();
    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await contarAuditoria(r.command_id)).toBe(1);

    const a = await pool.query(
      `SELECT tenant_id, agent_id, conversa_id, metadata
         FROM audit_log
        WHERE acao = 'conversation_pause_requested'
          AND metadata->>'command_id' = $1`,
      [r.command_id],
    );
    expect(a.rows[0].tenant_id).toBe(TENANT);
    expect(a.rows[0].agent_id).toBe(AGENT);
    // FK para `conversas`: o controle desta fixture não tem conversa ligada,
    // então a coluna fica nula e os ids viajam no metadata.
    expect(a.rows[0].conversa_id).toBeNull();
    expect(a.rows[0].metadata.control_id).toBe(control_id);
    expect(a.rows[0].metadata.epoch_before).toBe("0");
    expect(a.rows[0].metadata.epoch_after).toBe("1");
    // Nada de conteúdo: nem texto, nem telefone, nem `stream_key`.
    expect(JSON.stringify(a.rows[0].metadata)).not.toMatch(/stream-/);
  });

  it("4. replay da MESMA chave devolve o mesmo comando, sem segundo epoch", async () => {
    const control_id = await mkControle();
    const pedido = pedidoPausa(control_id);

    const primeira = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido),
    );
    const segunda = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido),
    );

    expect(primeira.ok).toBe(true);
    expect(segunda.ok).toBe(true);
    if (!primeira.ok || !segunda.ok) return;

    expect(segunda.idempotent).toBe(true);
    expect(segunda.command_id).toBe(primeira.command_id);
    expect(segunda.epoch).toBe(primeira.epoch);
    // O epoch NÃO andou duas vezes — é a cláusula literal do §8.2.1.
    expect((await lerControle(control_id)).control_epoch).toBe("1");
  });

  it("5. replay NÃO gera linha de auditoria nova", async () => {
    // A operação não aconteceu de novo. Mesma régua de
    // `requestCommandWithAuditInTx`, que só audita quando `!result.idempotent`.
    const control_id = await mkControle();
    const pedido = pedidoPausa(control_id);
    const primeira = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido),
    );
    expect(primeira.ok).toBe(true);
    if (!primeira.ok) return;

    await noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));
    await noEscopo(() => conversationControlRepo.pauseConversationTx(pedido));

    expect(await contarAuditoria(primeira.command_id)).toBe(1);
  });

  it("6. mesma chave com payload DIVERGENTE é conflito, não última-escrita-vence", async () => {
    const control_id = await mkControle();
    const chave = randomUUID();
    const a = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(control_id, { idempotency_key: chave }),
      ),
    );
    expect(a.ok).toBe(true);

    const b = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(control_id, {
          idempotency_key: chave,
          request_payload: { note: "OUTRA coisa" },
        }),
      ),
    );

    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.reason).toBe("payload_conflict");
    // O controle não se mexeu por causa da segunda chamada.
    expect((await lerControle(control_id)).control_epoch).toBe("1");
  });

  it("7. epoch obsoleto recusa e NÃO muta", async () => {
    const control_id = await mkControle();
    await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(control_id)),
    );
    const antes = await lerControle(control_id);

    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(control_id, { expected_epoch: "0" }),
      ),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epoch_mismatch");
    expect(r.current_epoch).toBe("1");
    const depois = await lerControle(control_id);
    expect(depois.control_epoch).toBe(antes.control_epoch);
    expect(depois.mode).toBe(antes.mode);
  });

  it("8. pausar o que já está em `human` é `mode_not_allowed`", async () => {
    const control_id = await mkControle();
    await pool.query(
      `UPDATE conversation_controls
          SET mode='human', control_epoch=control_epoch+1, owner_app_user_id=$2,
              paused_at=now(), reason_code='operator_takeover', updated_at=now()
        WHERE id=$1`,
      [control_id, "outro-operador"],
    );

    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(
        pedidoPausa(control_id, { expected_epoch: "1" }),
      ),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("mode_not_allowed");
    expect(r.current_mode).toBe("human");
    // O dono anterior continua sendo o dono — a recusa não rouba a posse.
    expect((await lerControle(control_id)).owner_app_user_id).toBe(
      "outro-operador",
    );
  });

  it("9. controle inexistente é `control_not_found`, sem criar nada", async () => {
    const fantasma = randomUUID();
    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedidoPausa(fantasma)),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("control_not_found");

    const cmd = await pool.query(
      "SELECT count(*)::int AS n FROM conversation_control_commands WHERE control_id = $1",
      [fantasma],
    );
    expect(cmd.rows[0].n).toBe(0);
  });

  it("12. a idempotência também separa AGENTES do mesmo tenant", async () => {
    // O caso 10 varia o TENANT; este varia o AGENTE. Os dois eixos existem na
    // unique `(tenant_id, agent_id, idempotency_key)`, e testar só um deixa o
    // outro sem prova: a varredura por mutação mostrou que remover `agent_id`
    // do `WHERE` sobrevivia à suíte inteira, porque nenhuma fixture tinha dois
    // agentes. Este caso é o que mata aquele mutante.
    const chave = randomUUID();
    const a = await mkControle(TENANT, AGENT);
    const b = await mkControle(TENANT, OUTRO_AGENTE);

    const ra = await noEscopo(
      () =>
        conversationControlRepo.pauseConversationTx(
          pedidoPausa(a, { idempotency_key: chave }),
        ),
      TENANT,
      AGENT,
    );
    const rb = await noEscopo(
      () =>
        conversationControlRepo.pauseConversationTx(
          pedidoPausa(b, { idempotency_key: chave }),
        ),
      TENANT,
      OUTRO_AGENTE,
    );

    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    // Sem o eixo do agente, a segunda chamada leria o comando da primeira e
    // voltaria como replay — o agente B herdaria a decisão do agente A.
    expect(rb.idempotent).toBe(false);
    expect(rb.command_id).not.toBe(ra.command_id);
    expect(rb.control_id).toBe(b);
  });

  it("11. comando guardado NÃO aceito devolve o desfecho PERSISTIDO", async () => {
    // O ramo que a primeira versão da implementação respondia com
    // `payload_conflict` — mentindo sobre a causa, porque o payload batia. O
    // desfecho correto é o que está na linha, e o `_outcome_chk` da 141
    // garante que status `conflict`/`failed` tem `outcome_code` não nulo.
    //
    // Esta fatia só escreve `accepted`, então a linha é montada à mão: é
    // exatamente o que uma fatia futura (resume, reconciliação) vai escrever.
    const control_id = await mkControle();
    const chave = randomUUID();
    const pedido = pedidoPausa(control_id, { idempotency_key: chave });
    const hash = await pool
      .query(
        `INSERT INTO conversation_control_commands
           (id, tenant_id, agent_id, control_id, kind, idempotency_key, request_hash,
            expected_epoch, requested_by_app_user_id, status, outcome_code)
         VALUES ($1,$2,$3,$4,'pause',$5,$6,0,$7,'conflict','reconciliation_required')
         RETURNING request_hash`,
        [
          randomUUID(),
          TENANT,
          AGENT,
          control_id,
          chave,
          // O mesmo digest canônico que a implementação deriva do payload.
          "0".repeat(64),
          OPERADOR,
        ],
      )
      .then((r) => r.rows[0].request_hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const r = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Hash diferente ⇒ o conflito de payload ganha, e é a resposta certa aqui.
    expect(r.reason).toBe("payload_conflict");

    // Agora a MESMA linha, com o hash que a implementação de fato derivaria:
    // aí o desfecho persistido tem de aparecer, e não `payload_conflict`.
    const chave2 = randomUUID();
    const pedido2 = pedidoPausa(control_id, { idempotency_key: chave2 });
    const real = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido2),
    );
    expect(real.ok).toBe(true);
    if (!real.ok) return;
    await pool.query(
      `UPDATE conversation_control_commands
          SET status='conflict', outcome_code='reconciliation_required', result_epoch=NULL
        WHERE id=$1`,
      [real.command_id],
    );

    const depois = await noEscopo(() =>
      conversationControlRepo.pauseConversationTx(pedido2),
    );
    expect(depois.ok).toBe(false);
    if (depois.ok) return;
    expect(depois.reason).toBe("reconciliation_required");
    expect(depois.command_id).toBe(real.command_id);
  });

  it("10. a idempotência é ESCOPADA: a mesma chave convive em outro tenant", async () => {
    // Uma unique global deixaria uma conta ler o resultado do comando da outra.
    const chave = randomUUID();
    const a = await mkControle(TENANT);
    const b = await mkControle(OUTRO_TENANT);

    const ra = await noEscopo(
      () =>
        conversationControlRepo.pauseConversationTx(
          pedidoPausa(a, { idempotency_key: chave }),
        ),
      TENANT,
    );
    const rb = await noEscopo(
      () =>
        conversationControlRepo.pauseConversationTx(
          pedidoPausa(b, { idempotency_key: chave }),
        ),
      OUTRO_TENANT,
    );

    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(rb.command_id).not.toBe(ra.command_id);
    expect(rb.idempotent).toBe(false);
  });
});
