/**
 * P04.4 (spec §8.2.1 linha 2345, §8.2.3) — a RECONCILIAÇÃO `pausing → human`.
 *
 * ─── O que a spec exige, em letras ─────────────────────────────────────────
 *
 * "`pausing → human` | Reconciliador Maia | Confirma que não há novo I/O
 * autorizado em aberto. Se restam efeitos sem desfecho, expõe
 * `reconciliation_required` e **não finge drenagem concluída**. **Não
 * incrementa epoch novamente** só por confirmar a mesma tomada."
 *
 * E o §8.2.3 fecha a porta do atalho: "só marcar `human` plenamente drenado
 * após essa prova; um lease vencido sozinho não prova que um processo remoto
 * deixou de enviar".
 *
 * ─── A evidência é COMPOSTA, e isso é declarado (C42) ──────────────────────
 *
 * O §8.2.3 apoia a prova num "NOVO journal de efeitos/admissão"
 * (`prepared/started/confirmed/unknown/cancelled`) que **não existe** — varri o
 * catálogo e `migrations/`. O que existe, e que esta unidade compõe:
 *
 *   1. `engine_runs.phase <> 'closed'` — a definição de "run aberto" do próprio
 *      banco, materializada em `engine_runs_one_open_turn_uq`;
 *   2. `engine_tool_calls.state` nos quatro estados do índice parcial
 *      `engine_tool_calls_unsettled_idx` — a definição de "não liquidada" que o
 *      P03 já usa em `ESTADOS_CONCILIADOS`, reusada em vez de reinventada;
 *   3. `effect_evidence = 'unknown'` — evidência DURÁVEL e monotônica (a 140
 *      tem trigger que proíbe regressão para `none`);
 *   4. artefato de saída fora de `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (C18).
 *
 * ─── E o que a contagem NÃO prova (C43) ────────────────────────────────────
 *
 * `outbound_messages` alcança o TURNO, não o controle, e nem ela nem
 * `agent_turns` têm `control_id`/`control_epoch` — medido no catálogo. Logo a
 * drenagem escopada por controle enxerga apenas egresso de turnos COM run de
 * engine, e é por construção um **limite inferior**. O caso 9 prende que o
 * resultado declara isso, em vez de afirmar "não há efeito em aberto".
 *
 * Skipped sem `TEST_DB_URL`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { conversationControlRepo } from "@/db/repositories/conversation-control-repo.js";
/**
 * As duas chaves de saída são DERIVADAS pelo contrato, nunca literais. Não há
 * CHECK de formato nelas, então um literal passaria no banco e mentiria sobre a
 * identidade — o tipo de fixture que faz um teste verde afirmar o que o código
 * não garante. O comentário é do spec do P03, e a razão vale igual aqui.
 */
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

const TENANT = "reconcile-tenant";
const AGENT = "reconcile-agent";
/**
 * Segundo agente DENTRO do mesmo tenant, e segundo tenant. Os dois existem por
 * causa da regra que adotei no C41: o escopo desta casa tem DOIS eixos, e uma
 * fixture que varia só um deixa o outro sem prova. Escrevi isso ANTES da
 * implementação de propósito — nas três unidades anteriores eu descobri o eixo
 * faltando pela mutação sobrevivente, e a regra existe para não haver a quarta.
 */
const OUTRO_AGENTE = "reconcile-agent-2";
const OUTRO_TENANT = "reconcile-tenant-2";
const OPERADOR = "operador-1";
const SHA = "a".repeat(64);

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

/** Um controle já PAUSADO — o estado de partida da reconciliação. */
async function mkControlePausado(
  tenant = TENANT,
  agente = AGENT,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation_controls
       (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id,
        mode, control_epoch, owner_app_user_id, paused_at, reason_code)
     VALUES ($1,$2,$3,$4,1,$5,'pausing',1,$6,now(),'operator_takeover')`,
    [id, tenant, agente, `stream-${id}`, randomUUID(), OPERADOR],
  );
  return id;
}

async function lerControle(
  id: string,
): Promise<{ mode: string; control_epoch: string }> {
  const r = await pool.query(
    `SELECT mode, control_epoch::text AS control_epoch
       FROM conversation_controls WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

const pedido = (control_id: string, over: Record<string, unknown> = {}) => ({
  control_id,
  expected_epoch: "1",
  idempotency_key: randomUUID(),
  requested_by_app_user_id: OPERADOR,
  ...over,
});

d("reconcilePauseTx — `pausing → human` só com prova", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
    await seed();
    // Os DOIS eixos do escopo, semeados de saída (regra do C41).
    await seed(TENANT, OUTRO_AGENTE);
    await seed(OUTRO_TENANT, AGENT);
  });

  afterAll(async () => {
    // Mesma guarda do spec de pausa: o índice de outbox dos comandos é parcial
    // e CROSS-TENANT, então aposento em vez de deletar (FK `ON DELETE RESTRICT`).
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

  it("1. sem nada em aberto: `pausing → human`, drenagem completa", async () => {
    const control_id = await mkControlePausado();
    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("human");
    expect(r.drain_status).toBe("complete");
    expect(r.inflight_effects).toBe(0);
    expect(r.unknown_deliveries).toBe(0);
  });

  it("2. o epoch NÃO incrementa — confirmar a tomada não é nova tomada", async () => {
    // A cláusula literal do §8.2.1: "não incrementa epoch novamente só por
    // confirmar a mesma tomada". Incrementar aqui invalidaria claims que a
    // própria pausa já havia fenceado, e faria a barreira parecer nova.
    const control_id = await mkControlePausado();
    const antes = await lerControle(control_id);
    await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );
    const depois = await lerControle(control_id);

    expect(antes.control_epoch).toBe("1");
    expect(depois.control_epoch).toBe("1");
    expect(depois.mode).toBe("human");
  });

  it("3. run ABERTO segura a drenagem, e o modo fica em `pausing`", async () => {
    const control_id = await mkControlePausado();
    await mkRunAberto(control_id, "running");

    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // NÃO finge drenagem concluída — a frase é da spec.
    expect(r.drain_status).toBe("reconciliation_required");
    expect(r.mode).toBe("pausing");
    expect((await lerControle(control_id)).mode).toBe("pausing");
  });

  it("4. chamada NÃO LIQUIDADA conta como efeito em voo", async () => {
    // Os quatro estados são os do índice parcial `engine_tool_calls_unsettled_idx`,
    // que é a definição que o P03 já usa — reusada, não reinventada.
    // `engine_tool_calls_unknown_chk` EXIGE `effect_evidence='unknown'` quando o
    // estado é `effect_unknown`; passar `'none'` violaria o CHECK e o caso
    // falharia por erro de fixture — um vermelho que não mede o que o teste
    // afirma medir. A evidência acompanha o estado, como o banco manda.
    for (const [estado, evidencia] of [
      ["received", "none"],
      ["dispatching", "none"],
      ["handler_started", "possible"],
      ["effect_unknown", "unknown"],
    ] as const) {
      const control_id = await mkControlePausado();
      const { run_id, turn_id } = await mkRunAberto(control_id, "closed");
      await mkToolCall(run_id, turn_id, estado, evidencia);

      const r = await noEscopo(() =>
        conversationControlRepo.reconcilePauseTx(pedido(control_id)),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.drain_status, `estado ${estado}`).toBe("reconciliation_required");
      expect(r.inflight_effects, `estado ${estado}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("5. `approval_required` NÃO conta como em voo — decisão do C44", async () => {
    // Uma chamada parada esperando humano não tem I/O AUTORIZADO em aberto.
    // Contá-la prenderia em `pausing` toda conversa com aprovação pendente,
    // transformando o gate de aprovação em impedimento de tomada humana.
    const control_id = await mkControlePausado();
    const { run_id, turn_id } = await mkRunAberto(control_id, "closed");
    // `approval_chk` exige `approval_request_id` não nulo neste estado.
    await mkToolCall(
      run_id,
      turn_id,
      "approval_required",
      "none",
      await mkApproval(),
    );

    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inflight_effects).toBe(0);
    expect(r.drain_status).toBe("complete");
  });

  it("6. `effect_evidence='unknown'` é ENTREGA DESCONHECIDA, não efeito em voo", async () => {
    // São contadores DIFERENTES no modelo do §8.2.3, e a distinção é o
    // INV-06: timeout não prova ausência de efeito.
    const control_id = await mkControlePausado();
    const { run_id, turn_id } = await mkRunAberto(control_id, "closed");
    await mkToolCall(run_id, turn_id, "effect_unknown", "unknown");

    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknown_deliveries).toBeGreaterThanOrEqual(1);
    expect(r.drain_status).toBe("reconciliation_required");
  });

  it("7. artefato de saída NÃO RESOLVIDO segura; resolvido não segura", async () => {
    // RESOLVIDO é `OUTBOUND_TURN_FINAL_ARTIFACT_STATUSES` (C18), e `delivered`
    // está deliberadamente FORA: ele libera a próxima parte, não fecha o histórico.
    const pendente = await mkControlePausado();
    const a = await mkRunAberto(pendente, "closed");
    await mkOutbound(a.turn_id, "delivered");
    const r1 = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(pendente)),
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.drain_status).toBe("reconciliation_required");

    const limpo = await mkControlePausado();
    const b = await mkRunAberto(limpo, "closed");
    await mkOutbound(b.turn_id, "completed");
    const r2 = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(limpo)),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.drain_status).toBe("complete");
  });

  it("8. reconciliar de novo é idempotente e não duplica auditoria", async () => {
    const control_id = await mkControlePausado();
    const p = pedido(control_id);
    const primeira = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(p),
    );
    const segunda = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(p),
    );
    expect(primeira.ok).toBe(true);
    expect(segunda.ok).toBe(true);
    if (!primeira.ok || !segunda.ok) return;
    expect(segunda.idempotent).toBe(true);

    const n = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'conversation_control_acquired'
          AND metadata->>'control_id' = $1`,
      [control_id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("9. a ação auditada é `conversation_control_acquired`, e o limite é DECLARADO", async () => {
    // A tomada é fato DIFERENTE do comando de pausa — autores e efeitos
    // distintos (§8.2.1). E o resultado precisa dizer que a contagem cobre só
    // egresso de origem engine: `outbound_messages` não tem `control_id` (C43),
    // então afirmar "não há efeito em aberto" seria afirmar mais do que a
    // consulta prova.
    const control_id = await mkControlePausado();
    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drain_scope).toBe("engine_originated_only");

    // O limite tem de estar na TRILHA, não só no retorno. A varredura por
    // mutação provou que a asserção acima sozinha não bastava: remover
    // `drain_scope` do `metadata` do `auditTx` deixava a suíte inteira verde,
    // porque nada olhava para a linha de auditoria. Quem lê a trilha depois —
    // console, alerta, auditoria — é justamente quem precisa saber que a
    // contagem cobriu só egresso de origem engine (C43).
    const trilha = await pool.query(
      `SELECT metadata FROM audit_log
        WHERE acao = 'conversation_control_acquired'
          AND metadata->>'control_id' = $1`,
      [control_id],
    );
    expect(trilha.rows).toHaveLength(1);
    expect(trilha.rows[0].metadata.drain_scope).toBe("engine_originated_only");
    expect(trilha.rows[0].metadata.epoch).toBe("1");

    const a = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE acao = 'conversation_pause_requested'
          AND metadata->>'control_id' = $1`,
      [control_id],
    );
    expect(a.rows[0].n).toBe(0);
  });

  it("11. a drenagem é escopada nos DOIS eixos: tenant e agente", async () => {
    // Escrito ANTES da implementação, pela regra do C41. Nas três unidades
    // anteriores eu só descobri o eixo faltante quando um mutante sobreviveu —
    // no U-P04.2 o caso era vacuoso, no U-P04.3a afirmava presença em vez de
    // estrutura, e no U-P04.3b variava só o tenant. Aqui os dois eixos entram
    // de saída.
    //
    // O controle a reconciliar está LIMPO. O ruído — run aberto com chamada não
    // liquidada — vive em outro AGENTE do mesmo tenant e em outro TENANT. Se a
    // consulta de drenagem perder qualquer um dos dois predicados, ela conta o
    // ruído alheio e a drenagem deixa de completar.
    const limpo = await mkControlePausado(TENANT, AGENT);

    const doOutroAgente = await mkControlePausado(TENANT, OUTRO_AGENTE);
    const a = await mkRunAberto(doOutroAgente, "running", TENANT, OUTRO_AGENTE);
    await mkToolCall(a.run_id, a.turn_id, "received", "none", null, TENANT, OUTRO_AGENTE);

    const doOutroTenant = await mkControlePausado(OUTRO_TENANT, AGENT);
    const b = await mkRunAberto(doOutroTenant, "running", OUTRO_TENANT, AGENT);
    await mkToolCall(b.run_id, b.turn_id, "received", "none", null, OUTRO_TENANT, AGENT);

    const r = await noEscopo(
      () => conversationControlRepo.reconcilePauseTx(pedido(limpo)),
      TENANT,
      AGENT,
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inflight_effects).toBe(0);
    expect(r.unknown_deliveries).toBe(0);
    expect(r.drain_status).toBe("complete");
    expect(r.mode).toBe("human");
  });

  it("13. duas gerações no mesmo turno NÃO dobram a contagem", async () => {
    // `outbound_messages` junta a `engine_runs` por `(tenant, agent, turn_id)`,
    // e `engine_runs_one_open_turn_uq` só restringe as gerações ABERTAS — um
    // turno acumula gerações fechadas. Sem `DISTINCT`, o mesmo artefato seria
    // contado uma vez por geração, e a drenagem reportaria mais entregas
    // desconhecidas do que existem.
    //
    // Todas as fixtures anteriores criam UM run por turno, então nenhuma delas
    // exercita isto: o defeito passou pelo verde de 11 casos.
    const control_id = await mkControlePausado();
    const g1 = await mkRunAberto(control_id, "closed");
    await mkRunAberto(control_id, "closed", TENANT, AGENT, {
      turn_id: g1.turn_id,
      generation_no: 2,
    });
    // UM artefato, não resolvido.
    await mkOutbound(g1.turn_id, "delivered");

    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(pedido(control_id)),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unknown_deliveries).toBe(1);
    expect(r.drain_status).toBe("reconciliation_required");
  });

  it("12. epoch obsoleto recusa, e NÃO muta o controle", async () => {
    // A primeira versão da implementação declarava `epoch_mismatch` no tipo de
    // retorno e nunca o produzia — vocabulário sem emissor, o defeito que o C24
    // registra contra mim e que o próprio `audit-actions.ts` descreve em
    // `llm_circuit_opened/closed`. Este caso é o que passa a exigir o emissor.
    //
    // Por que importa aqui: reconciliar sobre uma visão obsoleta do epoch é
    // confirmar uma tomada que talvez já não seja a vigente. O §8.2.3 passo 3
    // lista o epoch entre o que se confere, e o epoch é o marcador de
    // AUTORIDADE — fato diferente de "a transição não se aplica a este modo".
    const control_id = await mkControlePausado();
    const antes = await lerControle(control_id);

    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(
        pedido(control_id, { expected_epoch: "0" }),
      ),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("epoch_mismatch");
    expect(r.current_epoch).toBe("1");
    expect(r.current_mode).toBe("pausing");

    const depois = await lerControle(control_id);
    expect(depois.mode).toBe(antes.mode);
    expect(depois.control_epoch).toBe(antes.control_epoch);
  });

  it("10. controle em `bot` não se reconcilia", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO conversation_controls
         (id, tenant_id, agent_id, stream_key, stream_key_version, channel_id)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [id, TENANT, AGENT, `stream-${id}`, randomUUID()],
    );
    const r = await noEscopo(() =>
      conversationControlRepo.reconcilePauseTx(
        pedido(id, { expected_epoch: "0" }),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("mode_not_allowed");
  });

  // ── helpers de fixture ────────────────────────────────────────────────────

  async function mkRunAberto(
    control_id: string,
    phase: string,
    tenant = TENANT,
    agente = AGENT,
    /**
     * Quando fornecido, REUSA o turno e cria outra GERAÇÃO de run sobre ele —
     * o que torna observável a multiplicação de contagem por join de turno.
     * Sem isto toda fixture teria um run por turno e o defeito ficaria
     * invisível, que é como ele quase passou.
     */
    existente?: { turn_id: string; generation_no: number },
  ): Promise<{ run_id: string; turn_id: string }> {
    if (existente) {
      const run_id = randomUUID();
      await pool.query(
        `INSERT INTO engine_runs
           (id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt,
            origin_claim_token, origin_worker_id, control_id, control_epoch, mode,
            manifest_digest, phase, request_key, remote_instance_id, request_json,
            request_hash, host_context_json, host_context_hash, deadline_at,
            reconcile_deadline_at, closed_at, closed_reason, capabilities_revoked_at)
         VALUES ($1,$2,$3,$4,$9,1,$5,'w-1',$6,1,'live',$7,'closed',$8,'inst-1','{}'::jsonb,
                 $7,'{}'::jsonb,$7, now()+interval '5 min', now()+interval '15 min',
                 now(),'discarded',now())`,
        // Nove parâmetros, nove referências. Um parâmetro suprido e não
        // referenciado faz o Postgres recusar o bind inteiro ("supplies 10
        // parameters, but prepared statement requires 9") — erro de fixture que
        // apareceria como falha do teste.
        [
          run_id,
          tenant,
          agente,
          existente.turn_id,
          randomUUID(),
          control_id,
          SHA,
          randomUUID(),
          existente.generation_no,
        ],
      );
      return { run_id, turn_id: existente.turn_id };
    }
    // `agent_turns.representative_message_id` tem FK para `mensagens`: um uuid
    // solto seria violação, não fixture. A mensagem vem primeiro, como no
    // `mkTurnoVivo` do spec do P03.
    // Os TRÊS inserts abaixo usam o escopo RECEBIDO, não o constante. Numa
    // versão anterior deste helper só o `engine_runs` era parametrizado, e o
    // `engine_runs_binding_fk` — que é composto por (tenant, agent, turn) —
    // recusava: o binding nascia num escopo e o run noutro. O FK composto pegou
    // o erro, e é por isso que ele é composto.
    const mensagem_id = randomUUID();
    await pool.query(
      `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, created_at)
       VALUES ($1,$2,$3,NULL,'in','texto','oi','{}'::jsonb, now())`,
      [mensagem_id, tenant, agente],
    );
    const turn_id = randomUUID();
    await pool.query(
      `INSERT INTO agent_turns (id, tenant_id, agent_id, status, representative_message_id)
       VALUES ($1,$2,$3,'running',$4)`,
      [turn_id, tenant, agente, mensagem_id],
    );
    // `protocol_version` é NOT NULL sem default e o CHECK exige o inteiro 1 —
    // não confundir com `maia.hermes.worker.v1`, que é o protocolo do IPC.
    await pool.query(
      `INSERT INTO engine_turn_bindings (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest, protocol_version, max_generations)
       VALUES ($1,$2,$3,'hermes','adapter-0.1.0',$4,1,3)`,
      [tenant, agente, turn_id, SHA],
    );
    const run_id = randomUUID();
    // `engine_runs_closed_chk` (migration 140, registrado no C17): um run
    // `closed` exige `closed_at`, `closed_reason` E `capabilities_revoked_at`
    // JUNTOS; qualquer outra fase exige os dois primeiros NULOS. `discarded` é
    // o motivo mais barato — `handed_to_outbox` e `completed_no_reply`
    // arrastariam `terminal_json` e `adopted_by_turn_attempt` pelo
    // `engine_runs_adopted_chk`.
    const fechado = phase === "closed";
    await pool.query(
      `INSERT INTO engine_runs
         (id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt,
          origin_claim_token, origin_worker_id, control_id, control_epoch, mode,
          manifest_digest, phase, request_key, remote_instance_id, request_json,
          request_hash, host_context_json, host_context_hash, deadline_at,
          reconcile_deadline_at, closed_at, closed_reason, capabilities_revoked_at)
       VALUES ($1,$2,$3,$4,1,1,$5,'w-1',$6,1,'live',$7,$8,$9,'inst-1','{}'::jsonb,
               $7,'{}'::jsonb,$7, now()+interval '5 min', now()+interval '15 min',
               ${fechado ? "now()" : "NULL"},
               ${fechado ? "'discarded'" : "NULL"},
               ${fechado ? "now()" : "NULL"})`,
      [
        run_id,
        tenant,
        agente,
        turn_id,
        randomUUID(),
        control_id,
        SHA,
        phase,
        randomUUID(),
      ],
    );
    return { run_id, turn_id };
  }

  /**
   * Call por SQL CRU — molde copiado do `mkCallCrua` do spec do P03, que já
   * satisfaz os quatro CHECKs que governam o estado:
   *
   *   - `terminal_chk`: os cinco estados conciliados exigem `finished_at` E
   *     `result_json`; os demais exigem `finished_at` NULO;
   *   - `handler_chk`: `handler_started` só é válido com os TRÊS campos juntos;
   *   - `unknown_chk`: `effect_unknown` exige `effect_evidence='unknown'`;
   *   - `approval_chk`: `approval_required` exige `approval_request_id`.
   *
   * Errar qualquer um faz o caso falhar por violação de constraint — um
   * vermelho que não mede o que o teste afirma medir.
   */
  async function mkToolCall(
    run_id: string,
    turn_id: string,
    state: string,
    effect_evidence = "none",
    approval_request_id: string | null = null,
    tenant = TENANT,
    agente = AGENT,
  ): Promise<void> {
    const conciliada = [
      "completed",
      "denied",
      "approval_required",
      "effect_unknown",
      "cancelled",
    ].includes(state);
    const precisaMarcador = state === "handler_started";
    await pool.query(
      `INSERT INTO engine_tool_calls (tenant_id, agent_id, turn_id, run_id, call_id, ordinal,
          tool_name, args_json, args_hash, request_id, state, effect_evidence,
          approval_request_id, finished_at, result_json,
          handler_started_at, dispatch_token, reservation_token)
       VALUES ($1,$2,$3,$4,$5,0,'ferramenta_x','{}'::jsonb,$6,$7,$8,$9,$10,
               ${conciliada ? "now()" : "NULL"}, ${conciliada ? "'{}'::jsonb" : "NULL"},
               ${precisaMarcador ? "now()" : "NULL"},
               ${precisaMarcador ? "gen_random_uuid()" : "NULL"},
               ${precisaMarcador ? "'res-fixture'" : "NULL"})`,
      [
        tenant,
        agente,
        turn_id,
        run_id,
        `${run_id}:0`,
        SHA,
        randomUUID(),
        state,
        effect_evidence,
        approval_request_id,
      ],
    );
  }

  /** Aprovação pendente — barata: a tabela não tem FK alguma. */
  async function mkApproval(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO approval_requests (
         id, tenant_id, agent_id, requester_pessoa_id, tool, operation_type,
         intent_payload, intent_hash, approval_class, required_approvals, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,'tool_x','create','{}'::jsonb,$5,'single_confirmation',1,$6,
               now() + interval '1 hour')`,
      [id, TENANT, AGENT, randomUUID(), SHA, `fp-${id}`],
    );
    return id;
  }

  /**
   * Saída durável do MESMO turno. O `outbound_messages_durable_row_complete_check`
   * exige o tuplo INTEIRO assim que `turn_id` existe, e as duas chaves são
   * DERIVADAS pelo contrato: não há CHECK de formato nelas, então um literal
   * passaria no banco e mentiria sobre a identidade.
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
});
