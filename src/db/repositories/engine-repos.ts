/**
 * P03.2 (spec Maia+Hermes §5.6.3, §5.6.4, §5.7.2, §5.7.3) — o repositório do
 * JOURNAL DE EXECUÇÃO do motor.
 *
 * A migration 140 já torna estados impossíveis *impossíveis* (imutabilidade,
 * um run aberto por turno, `remote_run_id` atribuído uma vez). Este módulo é a
 * outra metade: as operações que precisam ser ATÔMICAS e FENCED, e o que elas
 * devolvem quando a corrida é perdida.
 *
 * As quatro regras que o módulo existe para tornar difíceis de violar:
 *
 *  1. **Escopo vem do ALS, nunca do argumento.** Todo WHERE carrega
 *     `tenant_id + agent_id` de `scope()`. Nenhuma operação move um run entre
 *     tenants — e nenhuma aceita `tenant_id` livre de quem chamou.
 *  2. **Posse é verificada antes de estado.** O fence (claim_token, attempt,
 *     lease viva) é checado ANTES de status/versão, e a recusa é
 *     `stale_claim`, não `state_mismatch`. A distinção é a mesma de
 *     `turn-repos.ts` e pela mesma razão: `state_mismatch` diz "o turno andou"
 *     (releia e talvez tente de novo); `stale_claim` diz "você não é mais o
 *     dono" (PARE — outro worker assumiu, insistir duplica trabalho).
 *  3. **Zero rows é resultado TIPADO.** Nenhuma operação devolve `false` ou
 *     lança para significar "perdi a corrida": devolve `{ ok: false, reason }`
 *     com o estado corrente, que é o que o chamador precisa para decidir.
 *  4. **Nenhuma TX é mantida durante I/O.** As TX daqui terminam antes de
 *     qualquer start/observe/cancel (§5.7.1). É por isso que `markSubmitting`
 *     e `recordStartObservation` são operações SEPARADAS: entre as duas roda a
 *     chamada externa, fora de transação e sem conexão reservada.
 *
 * ORDEM DE LOCKS (§5.6.3), sem caminho inverso: `conversation_controls` →
 * `agent_turns` → `engine_runs` → `engine_tool_calls`.
 *
 * Auditoria NÃO acontece aqui — o repositório é puro-DB, como os irmãos. Quem
 * audita é a camada de runtime (§5.6.3), único chamador de produção.
 *
 * ESCOPO DESTE ARQUIVO HOJE: o caminho de START (preparar, submeter, observar
 * o aceite) e a admissão do terminal. As demais operações da tabela §5.6.3
 * (`admitToolCall`, `freezeToolIdentity`, `markToolHandlerStarted`,
 * `settleToolCall`, `revokeRunCapabilities`, `adoptTerminalResult`,
 * `closeRunAfterHandoff`, varredura e manutenção, `markRunBlocked`/
 * `resolveBlockedRun`) entram nas unidades seguintes.
 *
 * ADIADO E NOMEADO (senão vira omissão silenciosa): `pinEngineAndPrepareRun`
 * confere ausência de outro run ABERTO, mas ainda não confere ausência de
 * OUTBOUND do mesmo turno, que o §5.6.3 pede na mesma frase. A metade outbound
 * depende de `closeRunAfterHandoff` e da regra de `safe_to_retry` (§5.6.2,
 * invariante 7), que chegam com as operações de fechamento.
 */
import { sql } from "drizzle-orm";
import { canonicalDigest } from "@/integrations/hermes/canonical-json.js";
import { incCounter } from "@/lib/metrics.js";
import type {
  EngineKind,
  EngineRunPhaseV1,
  EngineTerminalProposalV1,
  EngineToolCallStateV1,
  Json,
} from "@/runtime/engines/contracts.js";
import { engineTerminalProposalV1Schema } from "@/runtime/engines/schemas.js";
import {
  classifyToolCancellation,
  minimumBudgetMs,
  type ToolEffectClass,
} from "@/tools/effect-class.js";
import { db, withTx } from "../client.js";
import {
  agent_turns,
  conversation_controls,
  engine_run_events,
  engine_runs,
  engine_tool_calls,
  engine_turn_bindings,
} from "../schema.js";
import { getCurrentAgent, getCurrentTenant } from "../tenant-context.js";

type Executor = typeof db;

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

/** `db.execute` devolve um cursor-like; a casa materializa assim. */
function linhas<T>(res: { rows: unknown }): T[] {
  return Array.from(res.rows as unknown as T[]);
}

// ---------------------------------------------------------------------------
// Snapshot do run
// ---------------------------------------------------------------------------

export type EngineRunSnapshot = {
  id: string;
  phase: EngineRunPhaseV1;
  generation_no: number;
  row_version: number;
  submit_count: number;
  remote_run_id: string | null;
  request_key: string;
};

/** Consultas de run são single-table; nomes nus são inequívocos. */
const SNAPSHOT_COLS = sql`id, phase, generation_no, row_version, submit_count, remote_run_id, request_key`;

type RunSnapshotRow = {
  id: string;
  phase: string;
  generation_no: number | string;
  row_version: number | string;
  submit_count: number | string;
  remote_run_id: string | null;
  request_key: string;
};

/**
 * As colunas do FENCE DO RUN — distintas das do snapshot porque respondem a
 * outra pergunta. O snapshot diz em que estado o run está; estas dizem **de
 * quem ele é**.
 *
 * Existem porque a revisão independente (V-018) achou o buraco: verificar que
 * quem chama é dono do TURNO não é verificar que ele é a ORIGEM DESTE RUN.
 * Depois de um re-claim o turno tem dono novo e legítimo — e esse dono não
 * pode autorizar um run que outra tentativa iniciou (§5.7.1: pode consultar,
 * cancelar e reconciliar; não pode adotar o run em voo como nova autoridade).
 */
const FENCE_COLS = sql`origin_claim_token::text AS origin_claim_token, origin_turn_attempt, control_epoch::text AS run_control_epoch, terminal_hash`;

type RunFenceRow = {
  origin_claim_token: string;
  origin_turn_attempt: number | string;
  run_control_epoch: string;
  terminal_hash: string | null;
};

/**
 * `row_version`, `generation_no` e `submit_count` chegam como STRING do driver
 * quando a coluna é `bigint`. Converter na borda evita que um `===` numérico
 * do chamador falhe silenciosamente contra `'1'`.
 */
function snapshot(row: RunSnapshotRow): EngineRunSnapshot {
  return {
    id: row.id,
    phase: row.phase as EngineRunPhaseV1,
    generation_no: Number(row.generation_no),
    row_version: Number(row.row_version),
    submit_count: Number(row.submit_count),
    remote_run_id: row.remote_run_id,
    request_key: row.request_key,
  };
}

// ---------------------------------------------------------------------------
// Conflitos tipados
// ---------------------------------------------------------------------------

/** Recusa pelo FENCE do turno ou pelo estado dele. Ver regra 2 no cabeçalho. */
export type TurnFenceConflict = {
  ok: false;
  reason: "stale_claim" | "state_mismatch";
  current_status: string;
  current_state_version: number;
};

/** O controle humano da conversa recusou a operação (§5.5, aprofundado em P04). */
export type ControlConflict =
  | { ok: false; reason: "control_not_bot"; control_mode: string }
  | {
      ok: false;
      reason: "control_epoch_changed";
      current_control_epoch: string;
    };

export type NotFound = { ok: false; reason: "not_found" };

type EventoTipo =
  | "prepared"
  | "submit_started"
  | "submit_observed"
  | "tool_state"
  | "terminal_observed"
  | "capabilities_revoked"
  | "reconcile_decision"
  | "output_handoff"
  | "closed"
  | "projection";

// ---------------------------------------------------------------------------
// Helpers de lock e fence
// ---------------------------------------------------------------------------

type ControleRow = { id: string; mode: string; control_epoch: string };

/**
 * PRIMEIRO na ordem de locks. Duas formas: por `control_id` (quando o run
 * ainda não existe) e pelo run (quando existe), como no SQL do §5.6.4.
 */
async function lockControl(
  tx: Executor,
  alvo: { control_id: string } | { run_id: string },
): Promise<ControleRow | null> {
  const { tenant_id, agent_id } = scope();
  const res =
    "control_id" in alvo
      ? await tx.execute(sql`
          SELECT c.id, c.mode, c.control_epoch::text AS control_epoch
            FROM ${conversation_controls} c
           WHERE c.tenant_id = ${tenant_id} AND c.agent_id = ${agent_id}
             AND c.id = ${alvo.control_id}
           FOR UPDATE`)
      : await tx.execute(sql`
          SELECT c.id, c.mode, c.control_epoch::text AS control_epoch
            FROM ${conversation_controls} c
            JOIN ${engine_runs} r
              ON r.tenant_id = c.tenant_id AND r.agent_id = c.agent_id AND r.control_id = c.id
           WHERE r.tenant_id = ${tenant_id} AND r.agent_id = ${agent_id} AND r.id = ${alvo.run_id}
           FOR UPDATE OF c`);
  return linhas<ControleRow>(res)[0] ?? null;
}

type TurnoRow = {
  status: string;
  state_version: number | string;
  claim_token: string | null;
  attempt_count: number | string;
  lease_viva: boolean;
};

type FenceVeredicto =
  | { ok: true; turno: TurnoRow }
  | TurnFenceConflict
  | NotFound;

/**
 * SEGUNDO na ordem de locks. A classificação segue a prioridade do §5.6.4 —
 * perda de posse ANTES de divergência de estado.
 *
 * `lease_expires_at` é avaliado com `clock_timestamp()` (e não `now()`) de
 * propósito: `now()` é o instante do INÍCIO da transação, congelado antes da
 * espera pelo lock. Uma lease que venceu enquanto esperávamos pelo lock tem de
 * aparecer como vencida.
 */
async function lockTurnAndCheckFence(
  tx: Executor,
  args: {
    turn_id: string;
    origin_claim_token: string;
    origin_turn_attempt?: number;
  },
): Promise<FenceVeredicto> {
  const { tenant_id, agent_id } = scope();
  const rows = linhas<TurnoRow>(
    await tx.execute(sql`
      SELECT t.status, t.state_version, t.claim_token::text AS claim_token, t.attempt_count,
             (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > clock_timestamp()) AS lease_viva
        FROM ${agent_turns} t
       WHERE t.tenant_id = ${tenant_id} AND t.agent_id = ${agent_id} AND t.id = ${args.turn_id}
       FOR UPDATE`),
  );
  const turno = rows[0];
  if (!turno) return { ok: false, reason: "not_found" };

  const posse =
    turno.claim_token === args.origin_claim_token &&
    turno.lease_viva === true &&
    (args.origin_turn_attempt === undefined ||
      Number(turno.attempt_count) === args.origin_turn_attempt);

  if (!posse) {
    return {
      ok: false,
      reason: "stale_claim",
      current_status: turno.status,
      current_state_version: Number(turno.state_version),
    };
  }
  if (turno.status !== "running") {
    return {
      ok: false,
      reason: "state_mismatch",
      current_status: turno.status,
      current_state_version: Number(turno.state_version),
    };
  }
  return { ok: true, turno };
}

/**
 * O fence DO RUN, sob a linha já travada por `FOR UPDATE` (V-018, BLOCKERs 1 e 2).
 *
 * Três perguntas que `lockTurnAndCheckFence` não responde:
 *
 *  1. **Você é a origem deste run?** `origin_claim_token` é imutável por
 *     trigger (140), então deixar outra tentativa escrever aqui não só autoriza
 *     quem não devia: grava no journal que quem escreveu foi o dono ANTIGO.
 *  2. **Sua tentativa ainda é a do run?** É o `t.attempt_count =
 *     r.origin_turn_attempt` normativo do §5.6.4.
 *  3. **A conversa ainda é do bot, no mesmo epoch?** §5.6.2 é explícito: os
 *     exemplos de SQL focados em lease não dispensam o predicado de
 *     controle/epoch/modo. O epoch existe para derrotar o ABA.
 */
function checarFenceDoRun(args: {
  run: RunFenceRow;
  turno: TurnoRow;
  origin_claim_token: string;
  controle: ControleRow;
}): TurnFenceConflict | ControlConflict | null {
  if (args.run.origin_claim_token !== args.origin_claim_token) {
    return {
      ok: false,
      reason: "stale_claim",
      current_status: args.turno.status,
      current_state_version: Number(args.turno.state_version),
    };
  }
  if (
    Number(args.run.origin_turn_attempt) !== Number(args.turno.attempt_count)
  ) {
    return {
      ok: false,
      reason: "stale_claim",
      current_status: args.turno.status,
      current_state_version: Number(args.turno.state_version),
    };
  }
  if (args.controle.mode !== "bot") {
    return {
      ok: false,
      reason: "control_not_bot",
      control_mode: args.controle.mode,
    };
  }
  if (args.controle.control_epoch !== args.run.run_control_epoch) {
    return {
      ok: false,
      reason: "control_epoch_changed",
      current_control_epoch: args.controle.control_epoch,
    };
  }
  return null;
}

/** Eventos são append-only; a sequência vem do `last_event_sequence` do run. */
async function appendEvent(
  tx: Executor,
  args: {
    run_id: string;
    sequence_no: number;
    dedupe_key: string;
    event_type: EventoTipo;
    actor_kind: "turn_owner" | "recovery" | "operator";
    actor_turn_attempt: number | null;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const { tenant_id, agent_id } = scope();
  await tx.execute(sql`
    INSERT INTO ${engine_run_events}
      (tenant_id, agent_id, run_id, sequence_no, dedupe_key, event_type, actor_kind,
       actor_turn_attempt, metadata_json)
    VALUES (${tenant_id}, ${agent_id}, ${args.run_id}, ${args.sequence_no}, ${args.dedupe_key},
            ${args.event_type}, ${args.actor_kind}, ${args.actor_turn_attempt},
            ${JSON.stringify(args.metadata)}::jsonb)`);
}

function conta(op: string, result: string): void {
  incCounter("maia_engine_run_ops_total", { op, result });
}

// ---------------------------------------------------------------------------
// pinEngineAndPrepareRun
// ---------------------------------------------------------------------------

export type PrepareRunInput = {
  run_id: string;
  turn_id: string;
  origin_claim_token: string;
  origin_turn_attempt: number;
  origin_worker_id: string;
  control_id: string;
  /** `bigint` do banco; trafega como string para não perder precisão. */
  control_epoch: string;
  mode: "live" | "shadow";
  manifest_digest: string;
  engine: EngineKind;
  adapter_revision: string;
  configuration_digest: string;
  max_generations: number;
  request_key: string;
  remote_instance_id: string;
  request_json: Json;
  request_hash: string;
  host_context_json: Json;
  host_context_hash: string;
  deadline_ms: number;
  reconcile_deadline_ms: number;
};

export type PrepareRunResult =
  | { ok: true; run: EngineRunSnapshot }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | {
      ok: false;
      reason: "run_already_open";
      open_run_id: string;
      open_phase: EngineRunPhaseV1;
    }
  | {
      ok: false;
      reason: "pin_conflict";
      current_pin: {
        engine: string;
        adapter_revision: string;
        configuration_digest: string;
      };
    }
  | { ok: false; reason: "generations_exhausted"; max_generations: number };

// ---------------------------------------------------------------------------
// markSubmitting
// ---------------------------------------------------------------------------

export type MarkSubmittingResult =
  | { ok: true; run: EngineRunSnapshot }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "capabilities_revoked" }
  | { ok: false; reason: "deadline_exceeded" }
  | {
      ok: false;
      reason: "version_conflict";
      current_row_version: number;
      current_phase: EngineRunPhaseV1;
    };

// ---------------------------------------------------------------------------
// recordStartObservation
// ---------------------------------------------------------------------------

/**
 * O que o dono OBSERVOU ao tentar o start.
 *
 * `rejected` (rejeição comprovadamente anterior ao aceite) NÃO entra aqui
 * ainda: o destino dela depende da política de efeitos/retry do §5.8.3, que é
 * unidade posterior. Aceitar o valor agora e tratá-lo como `unknown` seria
 * fingir uma capacidade — e é justamente a diferença entre "não iniciou" e
 * "não sei se iniciou" que o §5.7.1 proíbe borrar.
 */
export type StartObservation =
  | { kind: "accepted"; remote_run_id: string }
  | { kind: "unknown"; code: string };

export type StartObservationResult =
  | { ok: true; run: EngineRunSnapshot }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | {
      ok: false;
      reason: "remote_id_conflict";
      current_remote_run_id: string;
      observed_remote_run_id: string;
    }
  | { ok: false; reason: "phase_conflict"; current_phase: EngineRunPhaseV1 };

// ---------------------------------------------------------------------------
// recordTerminalProposal
// ---------------------------------------------------------------------------

export type TerminalProposalResult =
  | { ok: true; run: EngineRunSnapshot }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "invalid_proposal"; detail: string }
  | { ok: false; reason: "request_key_mismatch" }
  | { ok: false; reason: "phase_conflict"; current_phase: EngineRunPhaseV1 }
  | { ok: false; reason: "calls_unsettled"; unsettled_call_ids: string[] }
  | {
      ok: false;
      reason: "observed_calls_mismatch";
      missing: string[];
      extra: string[];
    }
  /**
   * Outro terminal, com hash DIFERENTE, já foi aceito para esta execução.
   * Distinto de `phase_conflict`: aqui não é "o run andou", é "há dois
   * terminais divergentes para a mesma execução" — conflito a reconciliar,
   * nunca substituição (§5.6.2, invariante do terminal imutável).
   */
  | { ok: false; reason: "terminal_conflict"; current_terminal_hash: string };

/** Estados em que a chamada já foi CONCILIADA (a 140 exige `finished_at` neles). */
const ESTADOS_CONCILIADOS = new Set([
  "completed",
  "denied",
  "approval_required",
  "effect_unknown",
  "cancelled",
]);

/** Fases em que um terminal ainda pode ser admitido (§5.7.2). */
const FASES_QUE_ACEITAM_TERMINAL = new Set<EngineRunPhaseV1>([
  "running",
  "cancelling",
  "reconciling",
  "submission_unknown",
]);

// ---------------------------------------------------------------------------
// Admissão de tool call (§5.7.4 itens 3-5)
// ---------------------------------------------------------------------------

/**
 * Fases em que uma call pode ser ADMITIDA no journal.
 *
 * `running` é a única que libera o dispatcher. `submitting` e
 * `submission_unknown` entram por causa do **callback adiantado** (§5.7.4 item
 * 5): o engine pode pedir tool antes de o aceite do start estar persistido, e a
 * resposta certa é journalar `received` e devolver `in_progress` — não executar
 * e não pedir deliberação nova. `result_ready`, `cancelling`, `reconciling`,
 * `blocked` e `closed` nunca liberam chamada nova.
 */
const FASES_QUE_ADMITEM_CALL = new Set<EngineRunPhaseV1>([
  "running",
  "submitting",
  "submission_unknown",
]);

/**
 * Estados que OCUPAM a vaga sequencial do piloto (§5.7.4 item 4: no máximo uma
 * chamada pendente por run). É exatamente o conjunto do índice parcial
 * `engine_tool_calls_unsettled_idx` da 140 — `effect_unknown` entra porque uma
 * call com efeito incerto continua bloqueadora (§5.7.4 item 9).
 */
const ESTADOS_QUE_OCUPAM_A_VAGA = new Set([
  "received",
  "dispatching",
  "handler_started",
  "effect_unknown",
]);

export type ToolCallAdmission =
  /** Chamada nova journalada em `received`, com o run já em `running`. */
  | { ok: true; kind: "admitted"; call_id: string; ordinal: number }
  /** Vencedor ainda em voo, ou callback adiantado: journalado, não liberado. */
  | { ok: true; kind: "in_progress"; call_id: string }
  /** Já conciliada: devolve o que está persistido, sem repetir handler. */
  | {
      ok: true;
      kind: "receipt";
      call_id: string;
      state: EngineToolCallStateV1;
      result: Json;
    }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "payload_conflict"; current_args_hash: string }
  | { ok: false; reason: "ordinal_out_of_order"; expected_ordinal: number }
  | { ok: false; reason: "call_pending"; pending_call_id: string }
  | {
      ok: false;
      reason: "run_not_authorized";
      current_phase: EngineRunPhaseV1;
    };

/** Classificação que vem do registry Maia — nunca do modelo (§5.7.4 item 5). */
export type ToolClassification = {
  side_effect: "none" | "read" | "write" | "communication";
  /** `null` NUNCA autoriza handler (§4.1); a operação recusa. */
  effect_class: ToolEffectClass | null;
  sensitive: boolean;
  legacy_irreversible_invoked: boolean;
};

export type ToolDispatchingResult =
  | { ok: true; dispatch_token: string; row_version: number }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "run_not_authorized"; current_phase: EngineRunPhaseV1 }
  /** Sem classe não se chega ao UPDATE de handler (§5.6.4). */
  | { ok: false; reason: "effect_class_required" }
  /** Prazo restante abaixo do mínimo que a CLASSE exige para começar. */
  | {
      ok: false;
      reason: "insufficient_budget";
      required_ms: number;
      remaining_ms: number;
    }
  | { ok: false; reason: "state_conflict"; current_state: string }
  | { ok: false; reason: "version_conflict"; current_row_version: number };

export type FreezeIdentityResult =
  /** `frozen: false` = já estava congelada com os MESMOS valores (replay). */
  | { ok: true; frozen: boolean }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "state_conflict"; current_state: string }
  /** A identidade não muda em replay (§5.6.3). */
  | { ok: false; reason: "identity_conflict"; current_idempotency_key: string }
  /** Invariante C15: o objeto gravado tem de reproduzir o `args_hash`. */
  | {
      ok: false;
      reason: "normalized_args_mismatch";
      expected_args_hash: string;
    };

export type HandlerStartedResult =
  | { ok: true; effect_evidence: "none" | "possible"; row_version: number }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "run_not_authorized"; current_phase: EngineRunPhaseV1 }
  | { ok: false; reason: "capabilities_revoked" }
  | { ok: false; reason: "deadline_exceeded" }
  | { ok: false; reason: "state_conflict"; current_state: string }
  /** O token da call não é o que foi atribuído no `dispatching`. */
  | { ok: false; reason: "dispatch_token_mismatch" }
  /** §5.6.4 exige `idempotency_key`/`payload_hash` presentes ANTES do marcador. */
  | { ok: false; reason: "identity_not_frozen" }
  /**
   * A call JÁ tem carimbo de início. Distinto de `version_conflict`: ali o
   * chamador está com snapshot velho e reler resolve; aqui o handler pode já ter
   * rodado, e "começar de novo" é justamente o que não se pode fazer. Devolver
   * `version_conflict` para este caso convidaria à reação errada.
   */
  | { ok: false; reason: "already_started" }
  | { ok: false; reason: "version_conflict"; current_row_version: number };

/**
 * Desfecho de uma call, na forma que a 140 aceita.
 *
 * `cancelled` NÃO é oferecido como escolha livre: o §5.7.4 item 9 manda seguir
 * `classifyToolCancellation`, e só `abort_safe` pode terminar cancelada. Para as
 * demais classes a resposta honesta é `effect_unknown` — e a operação recusa a
 * tentativa em vez de aceitar uma afirmação de ausência de efeito.
 */
export type ToolSettlement =
  | {
      kind: "completed";
      result: Json;
      receipt: { json: Json; hash: string } | null;
    }
  | { kind: "denied"; result: Json }
  | { kind: "cancelled"; result: Json }
  | { kind: "effect_unknown"; result: Json };

export type SettleToolCallResult =
  | {
      ok: true;
      state: EngineToolCallStateV1;
      effect_evidence: string;
      row_version: number;
    }
  | TurnFenceConflict
  | ControlConflict
  | NotFound
  | { ok: false; reason: "state_conflict"; current_state: string }
  | { ok: false; reason: "dispatch_token_mismatch" }
  | { ok: false; reason: "version_conflict"; current_row_version: number }
  /** §5.7.4 item 9: só `abort_safe` pode terminar `cancelled`. */
  | {
      ok: false;
      reason: "cancellation_not_allowed";
      effect_class: string | null;
      required_outcome: "effect_unknown";
    }
  /** Receipt é par: ou os dois campos, ou nenhum (140). */
  | { ok: false; reason: "invalid_receipt" };

/**
 * Quem revoga (§5.6.3: "ator dono/recovery/operador autorizado").
 *
 * O dono prova posse pelo `origin_claim_token` DO RUN. `recovery` e `operator`
 * NÃO provam — e é proposital: o cenário em que mais se precisa revogar é
 * justamente aquele em que o dono sumiu e o turno foi re-reivindicado. Exigir o
 * token de origem deles deixaria capacidades vivas para sempre.
 */
export type RevokeActor =
  | { kind: "turn_owner"; origin_claim_token: string }
  | { kind: "recovery" | "operator"; actor_ref: string };

export type RevokeCapabilitiesResult =
  /** `already: true` = já estava revogado; o carimbo original é preservado. */
  | { ok: true; revoked_at: string; already: boolean }
  | TurnFenceConflict
  | NotFound
  /**
   * Quem chamou é dono do TURNO, mas não é a origem DESTE run.
   *
   * Razão própria, e não `stale_claim`, por um motivo de honestidade: o
   * `TurnFenceConflict` promete `current_status`/`current_state_version` do
   * turno, e neste caminho não há turno lido para `recovery`/`operator` — a
   * versão anterior preenchia esses campos com `"unknown"` e `0`, que é estado
   * INVENTADO apresentado como leitura. Um motivo que não promete o que não
   * mediu é melhor que um motivo bonito com campos falsos.
   */
  | {
      ok: false;
      reason: "not_run_origin";
      run_origin_claim_token: string;
    };

/** Quem bloqueia: dono, recuperador ou operador (mesmo vocabulário dos eventos). */
export type BlockActor =
  | { kind: "turn_owner"; origin_claim_token: string }
  | { kind: "recovery" | "operator"; actor_ref: string };

/**
 * Teto da evidência serializada. `engine_run_events.metadata_json` tem CHECK de
 * 16 KiB na 140, e a evidência vem de fora — sem este limite, uma evidência
 * grande viraria violação de CHECK dentro da TX, trocando recusa TIPADA por
 * exceção. Mesmo raciocínio do hash do receipt em P03.3d.
 */
const EVIDENCIA_MAX_BYTES = 8192;

export type MarkRunBlockedResult =
  | { ok: true; row_version: number; already_blocked: boolean }
  | TurnFenceConflict
  | NotFound
  | { ok: false; reason: "already_closed" }
  | { ok: false; reason: "evidence_too_large"; max_bytes: number };

export type ResolveBlockedRunResult =
  | { ok: true; row_version: number }
  | NotFound
  | { ok: false; reason: "phase_conflict"; current_phase: EngineRunPhaseV1 }
  | { ok: false; reason: "version_conflict"; current_row_version: number }
  /** §5.6.3: decisão HUMANA. Sem identidade do operador não se resolve. */
  | { ok: false; reason: "operator_required" }
  /** §5.7.2: "operador apresenta decisão/evidência suficiente". Vazio não é. */
  | { ok: false; reason: "evidence_required" }
  | { ok: false; reason: "evidence_too_large"; max_bytes: number };

/**
 * Teto de `output_preparation_json` — a 140 tem CHECK de 256 KiB na coluna.
 * Recusar aqui mantém a resposta TIPADA; deixar passar trocaria recusa por
 * transação estourada, o mesmo defeito que o hash do receipt e o teto de
 * evidência já corrigiram.
 */
const PREPARACAO_MAX_BYTES = 262_144;

export type AdoptTerminalResultResult =
  | { ok: true; adopted_by_turn_attempt: number; row_version: number }
  | TurnFenceConflict
  | NotFound
  | { ok: false; reason: "phase_conflict"; current_phase: EngineRunPhaseV1 }
  | { ok: false; reason: "version_conflict"; current_row_version: number }
  | { ok: false; reason: "preparation_too_large"; max_bytes: number };

export const engineRunsRepo = {
  /**
   * TX A do §5.7.3: fixa o motor no turno e cria o run `prepared`.
   *
   * Não faz I/O e não decide start — só deixa durável o pedido que o start vai
   * usar. O `request_key` nasce aqui porque reenvio precisa manter os MESMOS
   * bytes (§5.6.2, invariante 3).
   */
  async pinEngineAndPrepareRun(
    input: PrepareRunInput,
  ): Promise<PrepareRunResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<PrepareRunResult> => {
      const controle = await lockControl(tx, { control_id: input.control_id });
      if (!controle) {
        conta("prepare", "not_found");
        return { ok: false, reason: "not_found" };
      }
      if (controle.mode !== "bot") {
        conta("prepare", "control_not_bot");
        return {
          ok: false,
          reason: "control_not_bot",
          control_mode: controle.mode,
        };
      }
      if (controle.control_epoch !== input.control_epoch) {
        conta("prepare", "control_epoch_changed");
        return {
          ok: false,
          reason: "control_epoch_changed",
          current_control_epoch: controle.control_epoch,
        };
      }

      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
        origin_turn_attempt: input.origin_turn_attempt,
      });
      if (!fence.ok) {
        conta("prepare", fence.reason);
        return fence;
      }

      // Um run ABERTO por turno. O unique parcial da 140 também impede, mas
      // quem chama precisa do MOTIVO, não de uma violação de constraint.
      const abertos = linhas<{ id: string; phase: string }>(
        await tx.execute(sql`
          SELECT id, phase FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND turn_id = ${input.turn_id} AND phase <> 'closed'
           FOR UPDATE`),
      );
      const aberto = abertos[0];
      if (aberto) {
        conta("prepare", "run_already_open");
        return {
          ok: false,
          reason: "run_already_open",
          open_run_id: aberto.id,
          open_phase: aberto.phase as EngineRunPhaseV1,
        };
      }

      // PIN: insere se ausente, confere se existente. Nunca sobrescreve —
      // trocar de motor no meio do turno é o cenário proibido do §5.8.2.
      await tx.execute(sql`
        INSERT INTO ${engine_turn_bindings}
          (tenant_id, agent_id, turn_id, engine, adapter_revision, configuration_digest,
           protocol_version, max_generations)
        VALUES (${tenant_id}, ${agent_id}, ${input.turn_id}, ${input.engine},
                ${input.adapter_revision}, ${input.configuration_digest}, 1,
                ${input.max_generations})
        ON CONFLICT (tenant_id, agent_id, turn_id) DO NOTHING`);

      const pins = linhas<{
        engine: string;
        adapter_revision: string;
        configuration_digest: string;
        max_generations: number | string;
      }>(
        await tx.execute(sql`
          SELECT engine, adapter_revision, configuration_digest, max_generations
            FROM ${engine_turn_bindings}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND turn_id = ${input.turn_id}`),
      );
      const pin = pins[0];
      if (!pin) {
        conta("prepare", "not_found");
        return { ok: false, reason: "not_found" };
      }
      if (
        pin.engine !== input.engine ||
        pin.adapter_revision !== input.adapter_revision ||
        pin.configuration_digest !== input.configuration_digest
      ) {
        conta("prepare", "pin_conflict");
        return {
          ok: false,
          reason: "pin_conflict",
          current_pin: {
            engine: pin.engine,
            adapter_revision: pin.adapter_revision,
            configuration_digest: pin.configuration_digest,
          },
        };
      }

      // GERAÇÃO: conta TODOS os runs do turno, inclusive fechados — o teto é
      // de deliberações novas no turno, não de runs simultâneos.
      const gen = linhas<{ proxima: number | string }>(
        await tx.execute(sql`
          SELECT COALESCE(MAX(generation_no), 0) + 1 AS proxima FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND turn_id = ${input.turn_id}`),
      );
      const geracao = Number(gen[0]?.proxima ?? 1);
      const teto = Number(pin.max_generations);
      if (geracao > teto) {
        conta("prepare", "generations_exhausted");
        return {
          ok: false,
          reason: "generations_exhausted",
          max_generations: teto,
        };
      }

      const inserido = linhas<RunSnapshotRow>(
        await tx.execute(sql`
          INSERT INTO ${engine_runs} (
            id, tenant_id, agent_id, turn_id, generation_no, origin_turn_attempt,
            origin_claim_token, origin_worker_id, control_id, control_epoch, mode,
            manifest_digest, phase, row_version, request_key, remote_instance_id,
            request_json, request_hash, host_context_json, host_context_hash,
            deadline_at, reconcile_deadline_at, last_event_sequence)
          VALUES (
            ${input.run_id}, ${tenant_id}, ${agent_id}, ${input.turn_id}, ${geracao},
            ${input.origin_turn_attempt}, ${input.origin_claim_token}::uuid,
            ${input.origin_worker_id}, ${input.control_id}, ${input.control_epoch},
            ${input.mode}, ${input.manifest_digest}, 'prepared', 0, ${input.request_key}::uuid,
            ${input.remote_instance_id}, ${JSON.stringify(input.request_json)}::jsonb,
            ${input.request_hash}, ${JSON.stringify(input.host_context_json)}::jsonb,
            ${input.host_context_hash},
            clock_timestamp() + make_interval(secs => ${input.deadline_ms} / 1000.0),
            clock_timestamp() + make_interval(secs => ${input.reconcile_deadline_ms} / 1000.0),
            1)
          RETURNING ${SNAPSHOT_COLS}`),
      );
      const run = inserido[0];
      if (!run) {
        conta("prepare", "not_found");
        return { ok: false, reason: "not_found" };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: 1,
        dedupe_key: "prepared",
        event_type: "prepared",
        actor_kind: "turn_owner",
        actor_turn_attempt: input.origin_turn_attempt,
        metadata: {
          generation_no: geracao,
          engine: input.engine,
          mode: input.mode,
          request_hash: input.request_hash,
        },
      });

      conta("prepare", "ok");
      return { ok: true, run: snapshot(run) };
    });
  },

  /**
   * TX B do §5.7.3: registra a INTENÇÃO de start antes de qualquer I/O.
   *
   * Existe separada de `recordStartObservation` porque o `submit_count` tem de
   * estar durável ANTES da chamada externa: se o processo morrer entre as
   * duas, o run fica em `submitting` e a recuperação sabe que pode ter havido
   * aceite — que é exatamente o que "timeout não é negativo de efeito"
   * (§5.7.1) significa na prática.
   */
  async markSubmitting(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    expected_row_version: number;
  }): Promise<MarkSubmittingResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<MarkSubmittingResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("submitting", "not_found");
        return { ok: false, reason: "not_found" };
      }
      if (controle.mode !== "bot") {
        conta("submitting", "control_not_bot");
        return {
          ok: false,
          reason: "control_not_bot",
          control_mode: controle.mode,
        };
      }

      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("submitting", fence.reason);
        return fence;
      }

      const atualizado = linhas<
        RunSnapshotRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET phase = 'submitting',
                 submit_count = submit_count + 1,
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND turn_id = ${input.turn_id} AND id = ${input.run_id}
             AND row_version = ${input.expected_row_version}
             AND phase = 'prepared'
             AND origin_claim_token = ${input.origin_claim_token}::uuid
             AND origin_turn_attempt = ${Number(fence.turno.attempt_count)}
             AND capabilities_revoked_at IS NULL
             AND deadline_at > clock_timestamp()
             AND EXISTS (
               SELECT 1 FROM ${conversation_controls} c
                WHERE c.tenant_id = ${tenant_id} AND c.agent_id = ${agent_id}
                  AND c.id = ${engine_runs}.control_id
                  AND c.control_epoch = ${engine_runs}.control_epoch
                  AND c.mode = 'bot')
           RETURNING ${SNAPSHOT_COLS}, last_event_sequence`),
      );
      const run = atualizado[0];
      if (!run) {
        const conflito = await classificarConflitoDeRun(tx, {
          run_id: input.run_id,
          origin_claim_token: input.origin_claim_token,
          turno: fence.turno,
        });
        conta("submitting", conflito.reason);
        return conflito;
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(run.last_event_sequence),
        dedupe_key: `submit_started:${Number(run.submit_count)}`,
        event_type: "submit_started",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: { submit_count: Number(run.submit_count) },
      });

      conta("submitting", "ok");
      return { ok: true, run: snapshot(run) };
    });
  },

  /**
   * TX C do §5.7.3: registra o que o start OBSERVOU, depois do I/O.
   *
   * Lê o run sob lock antes de decidir em vez de tentar um UPDATE condicional:
   * o caso idempotente (redelivery do MESMO aceite) e o caso de conflito
   * (aceite com OUTRO `remote_run_id`) são indistinguíveis por "zero linhas", e
   * confundi-los é o bug que o invariante 3 do §5.6.2 existe para impedir.
   */
  async recordStartObservation(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    observation: StartObservation;
  }): Promise<StartObservationResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<StartObservationResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("start_observation", "not_found");
        return { ok: false, reason: "not_found" };
      }

      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("start_observation", fence.reason);
        return fence;
      }

      const rows = linhas<
        RunSnapshotRow & RunFenceRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS}, last_event_sequence FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const atual = rows[0];
      if (!atual) {
        conta("start_observation", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run: atual,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("start_observation", recusa.reason);
        return recusa;
      }
      const attempt = Number(fence.turno.attempt_count);

      if (input.observation.kind === "unknown") {
        const marcado = linhas<
          RunSnapshotRow & { last_event_sequence: string | number }
        >(
          await tx.execute(sql`
            UPDATE ${engine_runs}
               SET phase = 'submission_unknown',
                   row_version = row_version + 1,
                   last_event_sequence = last_event_sequence + 1,
                   last_observed_at = clock_timestamp(),
                   last_error_code = ${input.observation.code},
                   updated_at = clock_timestamp()
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
               AND phase = 'submitting'
             RETURNING ${SNAPSHOT_COLS}, last_event_sequence`),
        );
        const run = marcado[0];
        if (!run) {
          conta("start_observation", "phase_conflict");
          return {
            ok: false,
            reason: "phase_conflict",
            current_phase: atual.phase as EngineRunPhaseV1,
          };
        }
        await appendEvent(tx, {
          run_id: input.run_id,
          sequence_no: Number(run.last_event_sequence),
          dedupe_key: `submit_observed:${Number(run.submit_count)}:unknown`,
          event_type: "submit_observed",
          actor_kind: "turn_owner",
          actor_turn_attempt: attempt,
          metadata: { kind: "unknown", code: input.observation.code },
        });
        conta("start_observation", "submission_unknown");
        return { ok: true, run: snapshot(run) };
      }

      const observado = input.observation.remote_run_id;

      // Já existe locator. Mesmo id = redelivery (nada a fazer). Id diferente =
      // duas execuções remotas disputando o mesmo registro: BLOQUEIA.
      if (atual.remote_run_id !== null) {
        if (atual.remote_run_id === observado) {
          conta("start_observation", "idempotent");
          return { ok: true, run: snapshot(atual) };
        }
        const bloqueado = linhas<
          RunSnapshotRow & { last_event_sequence: string | number }
        >(
          await tx.execute(sql`
            UPDATE ${engine_runs}
               SET phase = 'blocked',
                   row_version = row_version + 1,
                   last_event_sequence = last_event_sequence + 1,
                   last_error_code = 'remote_id_conflict',
                   last_observed_at = clock_timestamp(),
                   updated_at = clock_timestamp()
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
               AND phase <> 'closed'
             RETURNING ${SNAPSHOT_COLS}, last_event_sequence`),
        );
        const run = bloqueado[0];
        if (run) {
          await appendEvent(tx, {
            run_id: input.run_id,
            sequence_no: Number(run.last_event_sequence),
            // DIGEST, não o id cru: `remote_run_id` aceita 512 chars e
            // `dedupe_key` só 256 (140). Concatenar o id estouraria o CHECK e
            // transformaria justamente o `remote_id_conflict` — o caminho em
            // que o chamador MAIS precisa de resposta tipada — numa exceção.
            dedupe_key: `submit_observed:conflict:${canonicalDigest(observado).slice(0, 32)}`,
            event_type: "submit_observed",
            actor_kind: "turn_owner",
            actor_turn_attempt: attempt,
            metadata: {
              kind: "remote_id_conflict",
              current_remote_run_id: atual.remote_run_id,
              observed_remote_run_id: observado,
            },
          });
        }
        conta("start_observation", "remote_id_conflict");
        return {
          ok: false,
          reason: "remote_id_conflict",
          current_remote_run_id: atual.remote_run_id,
          observed_remote_run_id: observado,
        };
      }

      const aceito = linhas<
        RunSnapshotRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET phase = 'running',
                 remote_run_id = ${observado},
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 last_observed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
             AND remote_run_id IS NULL
             AND phase IN ('submitting', 'submission_unknown')
           RETURNING ${SNAPSHOT_COLS}, last_event_sequence`),
      );
      const run = aceito[0];
      if (!run) {
        conta("start_observation", "phase_conflict");
        return {
          ok: false,
          reason: "phase_conflict",
          current_phase: atual.phase as EngineRunPhaseV1,
        };
      }
      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(run.last_event_sequence),
        dedupe_key: `submit_observed:${Number(run.submit_count)}:accepted`,
        event_type: "submit_observed",
        actor_kind: "turn_owner",
        actor_turn_attempt: attempt,
        metadata: { kind: "accepted", remote_run_id: observado },
      });
      conta("start_observation", "accepted");
      return { ok: true, run: snapshot(run) };
    });
  },

  /**
   * Admite a PROPOSTA terminal do motor — antes de qualquer saída (§5.6.3).
   *
   * "Proposta" é literal: nada aqui autoriza entrega. O que esta operação
   * garante é que o terminal só entra quando TODAS as chamadas do run já foram
   * conciliadas e quando o que o motor AFIRMA ter chamado bate com o journal.
   * Aceitar um terminal com chamada em voo seria adotar o resultado de um turno
   * cujo efeito ninguém sabe qual foi.
   */
  async recordTerminalProposal(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    proposal: EngineTerminalProposalV1;
  }): Promise<TerminalProposalResult> {
    const { tenant_id, agent_id } = scope();

    const parsed = engineTerminalProposalV1Schema.safeParse(input.proposal);
    if (!parsed.success) {
      conta("terminal", "invalid_proposal");
      return {
        ok: false,
        reason: "invalid_proposal",
        detail: parsed.error.issues[0]?.message ?? "schema",
      };
    }
    const proposta = parsed.data;
    if (proposta.run_id !== input.run_id) {
      conta("terminal", "invalid_proposal");
      return {
        ok: false,
        reason: "invalid_proposal",
        detail: "run_id divergente",
      };
    }

    return withTx(async (tx): Promise<TerminalProposalResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("terminal", "not_found");
        return { ok: false, reason: "not_found" };
      }

      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("terminal", fence.reason);
        return fence;
      }

      const rows = linhas<
        RunSnapshotRow & RunFenceRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS}, last_event_sequence FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const atual = rows[0];
      if (!atual) {
        conta("terminal", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run: atual,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("terminal", recusa.reason);
        return recusa;
      }
      if (atual.request_key !== proposta.request_key) {
        conta("terminal", "request_key_mismatch");
        return { ok: false, reason: "request_key_mismatch" };
      }

      // REDELIVERY antes do gate de fase — e tem de ser antes, porque
      // `result_ready` não está entre as fases que aceitam terminal. §5.7.4:
      // "Mesmo ID/hash já terminal retorna resultado persistido". Queda entre o
      // COMMIT e a continuação do chamador é caminho de recuperação rotineiro,
      // não erro. Hash DIFERENTE é outra coisa: dois terminais distintos para a
      // mesma execução é conflito a reconciliar, nunca substituição.
      const terminal_hash = canonicalDigest(proposta);
      if (atual.terminal_hash !== null) {
        if (atual.terminal_hash === terminal_hash) {
          conta("terminal", "idempotent");
          return { ok: true, run: snapshot(atual) };
        }
        conta("terminal", "terminal_conflict");
        return {
          ok: false,
          reason: "terminal_conflict",
          current_terminal_hash: atual.terminal_hash,
        };
      }

      if (!FASES_QUE_ACEITAM_TERMINAL.has(atual.phase as EngineRunPhaseV1)) {
        conta("terminal", "phase_conflict");
        return {
          ok: false,
          reason: "phase_conflict",
          current_phase: atual.phase as EngineRunPhaseV1,
        };
      }

      const calls = linhas<{ call_id: string; state: string }>(
        await tx.execute(sql`
          SELECT call_id, state FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND run_id = ${input.run_id}
           FOR UPDATE`),
      );

      // 1. Conciliação ANTES de conferência de conjunto: uma chamada em voo é
      //    um efeito desconhecido, e nenhuma comparação de ids muda isso.
      const emVoo = calls
        .filter((c) => !ESTADOS_CONCILIADOS.has(c.state))
        .map((c) => c.call_id);
      if (emVoo.length > 0) {
        conta("terminal", "calls_unsettled");
        return {
          ok: false,
          reason: "calls_unsettled",
          unsettled_call_ids: emVoo,
        };
      }

      // 2. O que o motor AFIRMA ter chamado contra o que o journal registrou.
      const noJournal = new Set(calls.map((c) => c.call_id));
      const afirmados = new Set(proposta.observed_tool_call_ids);
      const missing = [...noJournal].filter((id) => !afirmados.has(id));
      const extra = [...afirmados].filter((id) => !noJournal.has(id));
      if (missing.length > 0 || extra.length > 0) {
        conta("terminal", "observed_calls_mismatch");
        return { ok: false, reason: "observed_calls_mismatch", missing, extra };
      }

      const aceito = linhas<
        RunSnapshotRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET phase = 'result_ready',
                 terminal_json = ${JSON.stringify(proposta)}::jsonb,
                 terminal_hash = ${terminal_hash},
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 last_observed_at = clock_timestamp(),
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
             AND terminal_hash IS NULL
           RETURNING ${SNAPSHOT_COLS}, last_event_sequence`),
      );
      const run = aceito[0];
      if (!run) {
        // Terminal já aceito: a 140 recusa substituir. Não é erro do chamador
        // quando o hash é o MESMO — é redelivery.
        conta("terminal", "phase_conflict");
        return {
          ok: false,
          reason: "phase_conflict",
          current_phase: atual.phase as EngineRunPhaseV1,
        };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(run.last_event_sequence),
        dedupe_key: `terminal_observed:${terminal_hash}`,
        event_type: "terminal_observed",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: {
          stop_kind: proposta.stop.kind,
          iterations: proposta.iterations,
          observed_calls: proposta.observed_tool_call_ids.length,
          usage_source: proposta.usage.source,
        },
      });

      conta("terminal", "ok");
      return { ok: true, run: snapshot(run) };
    });
  },

  /**
   * Admite — ou RECONHECE — uma chamada de ferramenta (§5.7.4 itens 3-5).
   *
   * Nada aqui executa coisa alguma: a operação decide se a chamada entra no
   * journal e o que se responde a quem já perguntou antes. As três respostas
   * positivas são diferentes de propósito:
   *
   *   * `admitted`   — chamada nova, run em `running`: o dispatcher pode agir;
   *   * `in_progress`— vencedor ainda em voo OU callback adiantado: journalada,
   *                    NÃO liberada. Repetir a MESMA `call_id` é o protocolo;
   *   * `receipt`    — já conciliada: devolve o resultado persistido. Repetir o
   *                    handler aqui repetiria o EFEITO, que é o que o item 3
   *                    proíbe.
   *
   * `args_hash` é derivado aqui (`canonicalDigest`), não transportado: o wire
   * não tem campo de hash, então não há acordo entre linguagens a manter. Ver
   * C13 nos checkpoints.
   */
  async admitToolCall(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    request_id: string;
    call: {
      call_id: string;
      ordinal: number;
      iteration: number | null;
      name: string;
      args: Json;
    };
  }): Promise<ToolCallAdmission> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<ToolCallAdmission> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("admit_call", "not_found");
        return { ok: false, reason: "not_found" };
      }

      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("admit_call", fence.reason);
        return fence;
      }

      const rows = linhas<
        RunSnapshotRow & RunFenceRow & { last_event_sequence: string | number }
      >(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS}, last_event_sequence FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("admit_call", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("admit_call", recusa.reason);
        return recusa;
      }
      const fase = run.phase as EngineRunPhaseV1;
      if (!FASES_QUE_ADMITEM_CALL.has(fase)) {
        conta("admit_call", "run_not_authorized");
        return { ok: false, reason: "run_not_authorized", current_phase: fase };
      }

      const args_hash = canonicalDigest(input.call.args);

      // REDELIVERY primeiro: a identidade é `(tenant, agent, run_id, call_id)`.
      const existentes = linhas<{
        call_id: string;
        ordinal: number | string;
        iteration: number | string | null;
        tool_name: string;
        args_hash: string;
        state: string;
        result_json: Json | null;
      }>(
        await tx.execute(sql`
          SELECT call_id, ordinal, iteration, tool_name, args_hash, state, result_json
            FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call.call_id}
           FOR UPDATE`),
      );
      const existente = existentes[0];
      if (existente) {
        // O §5.7.4 item 3 manda comparar hash, nome, ordinal E iteration.
        // Seguir isso à risca significa que um redelivery com `iteration`
        // diferente vira conflito — é mais estrito do que tratar `iteration`
        // como telemetria, e é o que o texto normativo pede.
        const mesmo =
          existente.args_hash === args_hash &&
          existente.tool_name === input.call.name &&
          Number(existente.ordinal) === input.call.ordinal &&
          (existente.iteration === null
            ? input.call.iteration === null
            : Number(existente.iteration) === input.call.iteration);
        if (!mesmo) {
          conta("admit_call", "payload_conflict");
          return {
            ok: false,
            reason: "payload_conflict",
            current_args_hash: existente.args_hash,
          };
        }
        if (
          ESTADOS_CONCILIADOS.has(existente.state) &&
          existente.result_json !== null
        ) {
          conta("admit_call", "receipt");
          return {
            ok: true,
            kind: "receipt",
            call_id: existente.call_id,
            state: existente.state as EngineToolCallStateV1,
            result: existente.result_json,
          };
        }
        conta("admit_call", "in_progress");
        return { ok: true, kind: "in_progress", call_id: existente.call_id };
      }

      // Chamada NOVA: vaga sequencial antes da ordem, porque uma call pendente
      // torna qualquer ordinal irrelevante.
      const pendentes = linhas<{ call_id: string; state: string }>(
        await tx.execute(sql`
          SELECT call_id, state FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id}
             AND state IN ('received', 'dispatching', 'handler_started', 'effect_unknown')
           ORDER BY ordinal
           FOR UPDATE`),
      );
      const ocupando = pendentes.find((c) =>
        ESTADOS_QUE_OCUPAM_A_VAGA.has(c.state),
      );
      if (ocupando) {
        conta("admit_call", "call_pending");
        return {
          ok: false,
          reason: "call_pending",
          pending_call_id: ocupando.call_id,
        };
      }

      const proximo = linhas<{ esperado: number | string }>(
        await tx.execute(sql`
          SELECT COALESCE(MAX(ordinal) + 1, 0) AS esperado FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id}`),
      );
      const esperado = Number(proximo[0]?.esperado ?? 0);
      if (input.call.ordinal !== esperado) {
        // O UNIQUE de `ordinal` da 140 impede DUPLICATA, não desordem: dois
        // ordinais distintos passam por ele sem reclamar (§5.7.4 item 4).
        conta("admit_call", "ordinal_out_of_order");
        return {
          ok: false,
          reason: "ordinal_out_of_order",
          expected_ordinal: esperado,
        };
      }

      await tx.execute(sql`
        INSERT INTO ${engine_tool_calls}
          (tenant_id, agent_id, turn_id, run_id, call_id, ordinal, iteration,
           tool_name, args_json, args_hash, request_id, state)
        VALUES (${tenant_id}, ${agent_id}, ${input.turn_id}, ${input.run_id},
                ${input.call.call_id}, ${input.call.ordinal}, ${input.call.iteration},
                ${input.call.name}, ${JSON.stringify(input.call.args)}::jsonb,
                ${args_hash}, ${input.request_id}::uuid, 'received')`);

      // `last_event_sequence` anda; `row_version` NÃO — ele é o token de CAS
      // das transições do RUN, e admitir uma call não é transição de run.
      const seq = linhas<{ last_event_sequence: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           RETURNING last_event_sequence`),
      );
      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(seq[0]?.last_event_sequence ?? 1),
        dedupe_key: `tool_state:${input.call.call_id}:received`,
        event_type: "tool_state",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: {
          call_id: input.call.call_id,
          ordinal: input.call.ordinal,
          tool_name: input.call.name,
          state: "received",
          admitted_under_phase: fase,
        },
      });

      // Callback adiantado: journalado, mas não liberado.
      if (fase !== "running") {
        conta("admit_call", "early_callback");
        return { ok: true, kind: "in_progress", call_id: input.call.call_id };
      }
      conta("admit_call", "admitted");
      return {
        ok: true,
        kind: "admitted",
        call_id: input.call.call_id,
        ordinal: input.call.ordinal,
      };
    });
  },

  /**
   * `received` → `dispatching` (§5.7.4 item 5), a transição que a tabela do
   * §5.6.3 não nomeia mas o §5.6.4 pressupõe: o UPDATE de `markToolHandlerStarted`
   * exige `state='dispatching'` com `dispatch_token` IGUAL, e alguém tem de ter
   * atribuído esse token. Ver C14 nos checkpoints.
   *
   * Duas recusas acontecem AQUI, antes de o dispatcher existir na história:
   *
   *   * `effect_class` nulo — "null NUNCA autoriza handler" (§4.1). Uma tool sem
   *     classificação confiável fica fora da coorte; não vira `read` por default;
   *   * prazo restante abaixo de `minimumBudgetMs(classe)` — §5.6.4 é explícito:
   *     "sem orçamento mínimo da classe, não chegar a esse UPDATE". Começar algo
   *     `non_interruptible` com 300ms de prazo é fabricar um efeito incerto.
   */
  async markToolDispatching(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    classification: ToolClassification;
  }): Promise<ToolDispatchingResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<ToolDispatchingResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("dispatching", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("dispatching", fence.reason);
        return fence;
      }

      const rows = linhas<
        RunSnapshotRow & RunFenceRow & { restante_ms: string | number }
      >(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS},
                 EXTRACT(EPOCH FROM (deadline_at - clock_timestamp())) * 1000 AS restante_ms
            FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("dispatching", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("dispatching", recusa.reason);
        return recusa;
      }
      const fase = run.phase as EngineRunPhaseV1;
      if (fase !== "running") {
        // Só `running` libera dispatcher. O callback adiantado pode ter
        // journalado `received`, mas despachar exige o aceite persistido.
        conta("dispatching", "run_not_authorized");
        return { ok: false, reason: "run_not_authorized", current_phase: fase };
      }

      const classe = input.classification.effect_class;
      if (classe === null) {
        conta("dispatching", "effect_class_required");
        return { ok: false, reason: "effect_class_required" };
      }
      const exigido = minimumBudgetMs(classe);
      const restante = Number(run.restante_ms);
      if (restante < exigido) {
        conta("dispatching", "insufficient_budget");
        return {
          ok: false,
          reason: "insufficient_budget",
          required_ms: exigido,
          remaining_ms: Math.trunc(restante),
        };
      }

      const atualizado = linhas<{
        dispatch_token: string;
        row_version: string | number;
      }>(
        await tx.execute(sql`
          UPDATE ${engine_tool_calls}
             SET state = 'dispatching',
                 dispatch_token = gen_random_uuid(),
                 side_effect = ${input.classification.side_effect},
                 effect_class = ${classe},
                 sensitive = ${input.classification.sensitive},
                 legacy_irreversible_invoked = ${input.classification.legacy_irreversible_invoked},
                 row_version = row_version + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
             AND state = 'received'
             AND row_version = ${input.expected_row_version}
           RETURNING dispatch_token::text AS dispatch_token, row_version`),
      );
      const call = atualizado[0];
      if (!call) {
        const atual = linhas<{ state: string; row_version: string | number }>(
          await tx.execute(sql`
            SELECT state, row_version FROM ${engine_tool_calls}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
               AND run_id = ${input.run_id} AND call_id = ${input.call_id}`),
        );
        const linha = atual[0];
        if (!linha) {
          conta("dispatching", "not_found");
          return { ok: false, reason: "not_found" };
        }
        if (linha.state !== "received") {
          conta("dispatching", "state_conflict");
          return {
            ok: false,
            reason: "state_conflict",
            current_state: linha.state,
          };
        }
        conta("dispatching", "version_conflict");
        return {
          ok: false,
          reason: "version_conflict",
          current_row_version: Number(linha.row_version),
        };
      }

      const seq = linhas<{ last_event_sequence: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           RETURNING last_event_sequence`),
      );
      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(seq[0]?.last_event_sequence ?? 1),
        dedupe_key: `tool_state:${input.call_id}:dispatching`,
        event_type: "tool_state",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: {
          call_id: input.call_id,
          state: "dispatching",
          side_effect: input.classification.side_effect,
          effect_class: classe,
          sensitive: input.classification.sensitive,
          // O que a classe implica para um cancelamento tardio — registrado no
          // journal para quem for reconciliar não ter de reinferir.
          cancellation_outcome: classifyToolCancellation(classe).outcome,
        },
      });

      conta("dispatching", "ok");
      return {
        ok: true,
        dispatch_token: call.dispatch_token,
        row_version: Number(call.row_version),
      };
    });
  },

  /**
   * Congela a identidade de idempotência ANTES de o dispatcher usá-la
   * (§5.6.3, §5.7.4 item 6). "Não muda em replay" é literal: um segundo freeze
   * com os mesmos valores é no-op; com valores diferentes é conflito.
   *
   * A invariante do C15 é VERIFICADA, não assumida: `normalized_args_json` tem
   * de ser a forma canônica sobre a qual o `args_hash` foi computado. Confiar
   * no chamador aqui deixaria o journal com um objeto que não corresponde ao
   * hash ao lado dele — e quem reconcilia não teria como saber qual dos dois
   * está certo.
   */
  async freezeToolIdentity(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    idempotency_key: string;
    idempotency_payload_hash: string;
    normalized_args: Json;
  }): Promise<FreezeIdentityResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<FreezeIdentityResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("freeze_identity", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("freeze_identity", fence.reason);
        return fence;
      }
      const rows = linhas<RunSnapshotRow & RunFenceRow>(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS} FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("freeze_identity", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("freeze_identity", recusa.reason);
        return recusa;
      }

      const calls = linhas<{
        state: string;
        args_hash: string;
        idempotency_key: string | null;
        idempotency_payload_hash: string | null;
      }>(
        await tx.execute(sql`
          SELECT state, args_hash, idempotency_key, idempotency_payload_hash
            FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
           FOR UPDATE`),
      );
      const call = calls[0];
      if (!call) {
        conta("freeze_identity", "not_found");
        return { ok: false, reason: "not_found" };
      }
      if (call.state !== "dispatching") {
        conta("freeze_identity", "state_conflict");
        return {
          ok: false,
          reason: "state_conflict",
          current_state: call.state,
        };
      }

      // C15, verificado: redigerir o que vai ser gravado reproduz o hash.
      if (canonicalDigest(input.normalized_args) !== call.args_hash) {
        conta("freeze_identity", "normalized_args_mismatch");
        return {
          ok: false,
          reason: "normalized_args_mismatch",
          expected_args_hash: call.args_hash,
        };
      }

      if (call.idempotency_key !== null) {
        const igual =
          call.idempotency_key === input.idempotency_key &&
          call.idempotency_payload_hash === input.idempotency_payload_hash;
        if (!igual) {
          conta("freeze_identity", "identity_conflict");
          return {
            ok: false,
            reason: "identity_conflict",
            current_idempotency_key: call.idempotency_key,
          };
        }
        conta("freeze_identity", "replay");
        return { ok: true, frozen: false };
      }

      await tx.execute(sql`
        UPDATE ${engine_tool_calls}
           SET idempotency_key = ${input.idempotency_key},
               idempotency_payload_hash = ${input.idempotency_payload_hash},
               normalized_args_json = ${JSON.stringify(input.normalized_args)}::jsonb,
               row_version = row_version + 1,
               updated_at = clock_timestamp()
         WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
           AND run_id = ${input.run_id} AND call_id = ${input.call_id}
           AND idempotency_key IS NULL`);

      conta("freeze_identity", "ok");
      return { ok: true, frozen: true };
    });
  },

  /**
   * O MARCADOR do §5.6.4 (linha 1190): o que separa "não começou" de "pode ter
   * começado". Depois desta TX commitar, nenhuma recuperação tem direito de
   * afirmar ausência de efeito para uma classe que carrega efeito.
   *
   * `effect_evidence` sobe para `possible` ANTES de o handler rodar, e a decisão
   * vem do contrato de classes (`classifyToolCancellation`), não de um
   * `!== 'abort_safe'` escrito à mão: se amanhã uma classe nova entrar no
   * vocabulário, ela herda o comportamento conservador sozinha, e um valor fora
   * do vocabulário já é tratado como efeito desconhecido.
   *
   * O limite que este protocolo NÃO resolve, e que o §5.6.4 manda não fingir que
   * resolve: entre o COMMIT deste marcador e a chamada física pode-se perder a
   * lease. Segurar TX durante o handler não é a solução — a evidência marcada
   * aqui é.
   */
  async markToolHandlerStarted(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    reservation_token: string;
    approval_claim_token?: string | null;
  }): Promise<HandlerStartedResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<HandlerStartedResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("handler_started", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("handler_started", fence.reason);
        return fence;
      }

      const rows = linhas<
        RunSnapshotRow &
          RunFenceRow & { revogado: boolean; deadline_vencido: boolean }
      >(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS},
                 (capabilities_revoked_at IS NOT NULL) AS revogado,
                 (deadline_at <= clock_timestamp()) AS deadline_vencido
            FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("handler_started", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("handler_started", recusa.reason);
        return recusa;
      }
      const fase = run.phase as EngineRunPhaseV1;
      if (fase !== "running") {
        conta("handler_started", "run_not_authorized");
        return { ok: false, reason: "run_not_authorized", current_phase: fase };
      }
      if (run.revogado) {
        conta("handler_started", "capabilities_revoked");
        return { ok: false, reason: "capabilities_revoked" };
      }
      if (run.deadline_vencido) {
        conta("handler_started", "deadline_exceeded");
        return { ok: false, reason: "deadline_exceeded" };
      }

      const calls = linhas<{ effect_class: string | null }>(
        await tx.execute(sql`
          SELECT effect_class FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
           FOR UPDATE`),
      );
      const call = calls[0];
      if (!call) {
        conta("handler_started", "not_found");
        return { ok: false, reason: "not_found" };
      }
      // Classe fora do vocabulário cai no ramo conservador do contrato.
      const evidencia =
        classifyToolCancellation(call.effect_class as ToolEffectClass)
          .outcome === "effect_unknown"
          ? "possible"
          : "none";

      const atualizado = linhas<{ row_version: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_tool_calls}
             SET state = 'handler_started',
                 handler_started_at = clock_timestamp(),
                 reservation_token = ${input.reservation_token},
                 approval_claim_token = ${input.approval_claim_token ?? null},
                 effect_evidence = ${evidencia},
                 row_version = row_version + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
             AND state = 'dispatching'
             AND dispatch_token = ${input.dispatch_token}::uuid
             AND handler_started_at IS NULL
             AND idempotency_key IS NOT NULL
             AND idempotency_payload_hash IS NOT NULL
             AND row_version = ${input.expected_row_version}
           RETURNING row_version`),
      );
      const marcado = atualizado[0];
      if (!marcado) {
        const atual = linhas<{
          state: string;
          row_version: string | number;
          dispatch_token: string | null;
          idempotency_key: string | null;
          handler_started_at: string | null;
        }>(
          await tx.execute(sql`
            SELECT state, row_version, dispatch_token::text AS dispatch_token,
                   idempotency_key, handler_started_at
              FROM ${engine_tool_calls}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
               AND run_id = ${input.run_id} AND call_id = ${input.call_id}`),
        );
        const linha = atual[0];
        if (!linha) {
          conta("handler_started", "not_found");
          return { ok: false, reason: "not_found" };
        }
        if (linha.state !== "dispatching") {
          conta("handler_started", "state_conflict");
          return {
            ok: false,
            reason: "state_conflict",
            current_state: linha.state,
          };
        }
        if (linha.dispatch_token !== input.dispatch_token) {
          conta("handler_started", "dispatch_token_mismatch");
          return { ok: false, reason: "dispatch_token_mismatch" };
        }
        if (linha.idempotency_key === null) {
          conta("handler_started", "identity_not_frozen");
          return { ok: false, reason: "identity_not_frozen" };
        }
        if (linha.handler_started_at !== null) {
          // Estado, token e identidade batem: o que sobra é que o marcador JÁ
          // existe. Sem esta checagem o caso cairia em `version_conflict` com a
          // versão IGUAL à pedida — um motivo que não explica nada e sugere
          // "releia e tente de novo" onde a resposta é "não recomece".
          conta("handler_started", "already_started");
          return { ok: false, reason: "already_started" };
        }
        conta("handler_started", "version_conflict");
        return {
          ok: false,
          reason: "version_conflict",
          current_row_version: Number(linha.row_version),
        };
      }

      const seq = linhas<{ last_event_sequence: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           RETURNING last_event_sequence`),
      );
      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(seq[0]?.last_event_sequence ?? 1),
        dedupe_key: `tool_state:${input.call_id}:handler_started`,
        event_type: "tool_state",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: {
          call_id: input.call_id,
          state: "handler_started",
          effect_class: call.effect_class,
          effect_evidence: evidencia,
          approval_claimed: input.approval_claim_token != null,
        },
      });

      conta("handler_started", "ok");
      return {
        ok: true,
        effect_evidence: evidencia,
        row_version: Number(marcado.row_version),
      };
    });
  },

  /**
   * Liquida a call (§5.6.3, §5.7.4 itens 8-9).
   *
   * Duas regras que esta operação existe para impor, e que o `dispatch_token`
   * sozinho NÃO garante:
   *
   *  1. **Fence do turno ATUAL** (§5.7.4 item 8). O token da call não autoriza
   *     adotar resultado tardio: quem perdeu a posse do turno não liquida. Um
   *     reconciliador autorizado usa operação separada, com o próprio
   *     claim/row_version — não esta.
   *  2. **`cancelled` só para `abort_safe`** (item 9). Para as demais classes,
   *     cancelar depois do handler é afirmar ausência de efeito sobre algo que
   *     pode ter acontecido; a resposta honesta é `effect_unknown`, e a call
   *     continua bloqueadora mesmo que um HTTP 200 chegue depois.
   *
   * LIMITE CONHECIDO (C16): o completion de idempotência NÃO é ligado
   * atomicamente ao receipt aqui. `markCompletedWithEffect` abre a própria
   * `withTx`, e chamá-la daqui pegaria outra conexão — "atômico" seria falso. O
   * §5.7.4 item 8 contempla esse estado: até a ligação existir, recovery pode
   * ler o cache com chave/hash exatos, mas não inferir segurança de uma row
   * expirada. O helper com executor de TX é unidade própria.
   */
  async settleToolCall(input: {
    run_id: string;
    turn_id: string;
    origin_claim_token: string;
    call_id: string;
    expected_row_version: number;
    dispatch_token: string;
    outcome: ToolSettlement;
  }): Promise<SettleToolCallResult> {
    const { tenant_id, agent_id } = scope();

    if (input.outcome.kind === "completed") {
      const r = input.outcome.receipt;
      if (r !== null && !/^[0-9a-f]{64}$/.test(r.hash)) {
        conta("settle", "invalid_receipt");
        return { ok: false, reason: "invalid_receipt" };
      }
    }

    return withTx(async (tx): Promise<SettleToolCallResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("settle", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.origin_claim_token,
      });
      if (!fence.ok) {
        conta("settle", fence.reason);
        return fence;
      }
      const rows = linhas<RunSnapshotRow & RunFenceRow>(
        await tx.execute(sql`
          SELECT ${SNAPSHOT_COLS}, ${FENCE_COLS} FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("settle", "not_found");
        return { ok: false, reason: "not_found" };
      }
      const recusa = checarFenceDoRun({
        run,
        turno: fence.turno,
        origin_claim_token: input.origin_claim_token,
        controle,
      });
      if (recusa) {
        conta("settle", recusa.reason);
        return recusa;
      }

      const calls = linhas<{ effect_class: string | null; state: string }>(
        await tx.execute(sql`
          SELECT effect_class, state FROM ${engine_tool_calls}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
           FOR UPDATE`),
      );
      const call = calls[0];
      if (!call) {
        conta("settle", "not_found");
        return { ok: false, reason: "not_found" };
      }

      const classe = call.effect_class as ToolEffectClass;
      const veredito = classifyToolCancellation(classe);
      if (
        input.outcome.kind === "cancelled" &&
        veredito.outcome !== "cancelled"
      ) {
        conta("settle", "cancellation_not_allowed");
        return {
          ok: false,
          reason: "cancellation_not_allowed",
          effect_class: call.effect_class,
          required_outcome: "effect_unknown",
        };
      }

      // A evidência NUNCA regride (a 140 tem trigger para isso): `completed`
      // numa classe com efeito sobe para `committed`; `effect_unknown` vai para
      // `unknown`, que o CHECK da tabela exige; `abort_safe` fica onde está.
      const comEfeito = veredito.outcome === "effect_unknown";
      const evidencia =
        input.outcome.kind === "effect_unknown"
          ? "unknown"
          : input.outcome.kind === "completed" && comEfeito
            ? "committed"
            : comEfeito
              ? "possible"
              : "none";

      const receipt =
        input.outcome.kind === "completed" ? input.outcome.receipt : null;

      const atualizado = linhas<{ row_version: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_tool_calls}
             SET state = ${input.outcome.kind},
                 finished_at = clock_timestamp(),
                 result_json = ${JSON.stringify(input.outcome.result)}::jsonb,
                 receipt_json = ${receipt === null ? null : JSON.stringify(receipt.json)}::jsonb,
                 receipt_hash = ${receipt === null ? null : receipt.hash},
                 effect_evidence = ${evidencia},
                 row_version = row_version + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND run_id = ${input.run_id} AND call_id = ${input.call_id}
             AND state = 'handler_started'
             AND dispatch_token = ${input.dispatch_token}::uuid
             AND row_version = ${input.expected_row_version}
           RETURNING row_version`),
      );
      const liquidada = atualizado[0];
      if (!liquidada) {
        const atual = linhas<{
          state: string;
          row_version: string | number;
          dispatch_token: string | null;
        }>(
          await tx.execute(sql`
            SELECT state, row_version, dispatch_token::text AS dispatch_token
              FROM ${engine_tool_calls}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
               AND run_id = ${input.run_id} AND call_id = ${input.call_id}`),
        );
        const linha = atual[0];
        if (!linha) {
          conta("settle", "not_found");
          return { ok: false, reason: "not_found" };
        }
        if (linha.state !== "handler_started") {
          conta("settle", "state_conflict");
          return {
            ok: false,
            reason: "state_conflict",
            current_state: linha.state,
          };
        }
        if (linha.dispatch_token !== input.dispatch_token) {
          conta("settle", "dispatch_token_mismatch");
          return { ok: false, reason: "dispatch_token_mismatch" };
        }
        conta("settle", "version_conflict");
        return {
          ok: false,
          reason: "version_conflict",
          current_row_version: Number(linha.row_version),
        };
      }

      const seq = linhas<{ last_event_sequence: string | number }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           RETURNING last_event_sequence`),
      );
      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(seq[0]?.last_event_sequence ?? 1),
        dedupe_key: `tool_state:${input.call_id}:${input.outcome.kind}`,
        event_type: "tool_state",
        actor_kind: "turn_owner",
        actor_turn_attempt: Number(fence.turno.attempt_count),
        metadata: {
          call_id: input.call_id,
          state: input.outcome.kind,
          effect_class: call.effect_class,
          effect_evidence: evidencia,
          has_receipt: receipt !== null,
          // Quem reconcilia precisa da estratégia sem reinferir a classe.
          reconciliation:
            veredito.outcome === "effect_unknown"
              ? veredito.reconciliation
              : null,
        },
      });

      conta("settle", input.outcome.kind);
      return {
        ok: true,
        state: input.outcome.kind as EngineToolCallStateV1,
        effect_evidence: evidencia,
        row_version: Number(liquidada.row_version),
      };
    });
  },

  /**
   * Revoga as capacidades do run (§5.6.3, §5.7.2).
   *
   * Três propriedades, e cada uma existe por um motivo:
   *
   *  1. **Monotônica.** O `UPDATE` só age com `capabilities_revoked_at IS NULL`.
   *     Repetir é no-op que devolve `already: true` com o carimbo ORIGINAL —
   *     porque quem reconcilia precisa saber quando as capacidades morreram, e
   *     re-carimbar apagaria esse instante. Nenhum caminho aqui desfaz a
   *     revogação: "não renova por callback ou poll" é literal.
   *  2. **Ator assimétrico.** O dono prova posse; `recovery`/`operator` não. O
   *     cenário que mais precisa de revogação é o do dono que sumiu — exigir o
   *     token dele ali deixaria as capacidades vivas indefinidamente.
   *  3. **Não passa pelo gate de controle da conversa.** Revogar é exatamente o
   *     que se quer quando um humano assume; exigir `mode='bot'` tornaria o
   *     botão de parada inútil na única situação em que ele importa. O lock do
   *     controle continua sendo tomado — a ordem de locks não muda —, mas o
   *     modo/epoch dele não decide nada aqui.
   *
   * `row_version` NÃO é incrementado: revogar não é transição de fase, e mexer
   * na versão transformaria `capabilities_revoked` em `version_conflict` para
   * quem estivesse com um CAS em voo — trocando a causa real por uma genérica.
   */
  async revokeRunCapabilities(input: {
    run_id: string;
    turn_id: string;
    actor: RevokeActor;
    reason_code: string;
  }): Promise<RevokeCapabilitiesResult> {
    const { tenant_id, agent_id } = scope();
    return withTx(async (tx): Promise<RevokeCapabilitiesResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("revoke", "not_found");
        return { ok: false, reason: "not_found" };
      }

      let actor_turn_attempt: number | null = null;
      if (input.actor.kind === "turn_owner") {
        const fence = await lockTurnAndCheckFence(tx, {
          turn_id: input.turn_id,
          origin_claim_token: input.actor.origin_claim_token,
        });
        if (!fence.ok) {
          conta("revoke", fence.reason);
          return fence;
        }
        actor_turn_attempt = Number(fence.turno.attempt_count);
      }

      const rows = linhas<
        RunFenceRow & { capabilities_revoked_at: string | null }
      >(
        await tx.execute(sql`
          SELECT ${FENCE_COLS}, capabilities_revoked_at::text AS capabilities_revoked_at
            FROM ${engine_runs}
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}
           FOR UPDATE`),
      );
      const run = rows[0];
      if (!run) {
        conta("revoke", "not_found");
        return { ok: false, reason: "not_found" };
      }

      // O dono precisa ser a ORIGEM deste run, não só dono do turno.
      if (
        input.actor.kind === "turn_owner" &&
        run.origin_claim_token !== input.actor.origin_claim_token
      ) {
        conta("revoke", "not_run_origin");
        return {
          ok: false,
          reason: "not_run_origin",
          run_origin_claim_token: run.origin_claim_token,
        };
      }

      if (run.capabilities_revoked_at !== null) {
        conta("revoke", "already");
        return {
          ok: true,
          revoked_at: run.capabilities_revoked_at,
          already: true,
        };
      }

      const revogado = linhas<{ capabilities_revoked_at: string }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET capabilities_revoked_at = clock_timestamp(),
                 last_event_sequence = last_event_sequence + 1,
                 last_error_code = ${input.reason_code},
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND id = ${input.run_id}
             AND capabilities_revoked_at IS NULL
           RETURNING capabilities_revoked_at::text AS capabilities_revoked_at,
                     last_event_sequence`),
      );
      const linha = revogado[0] as
        | {
            capabilities_revoked_at: string;
            last_event_sequence: string | number;
          }
        | undefined;
      if (!linha) {
        // Corrida: outro ator revogou entre a leitura e o UPDATE. Monotônico
        // significa que isso é sucesso, não conflito.
        const relido = linhas<{ capabilities_revoked_at: string | null }>(
          await tx.execute(sql`
            SELECT capabilities_revoked_at::text AS capabilities_revoked_at
              FROM ${engine_runs}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}`),
        );
        const agora = relido[0]?.capabilities_revoked_at ?? null;
        if (agora === null) {
          conta("revoke", "not_found");
          return { ok: false, reason: "not_found" };
        }
        conta("revoke", "already");
        return { ok: true, revoked_at: agora, already: true };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(linha.last_event_sequence),
        dedupe_key: `capabilities_revoked:${input.run_id}`,
        event_type: "capabilities_revoked",
        actor_kind: input.actor.kind,
        actor_turn_attempt,
        metadata: {
          reason_code: input.reason_code,
          actor_ref:
            input.actor.kind === "turn_owner" ? null : input.actor.actor_ref,
        },
      });

      conta("revoke", "ok");
      return {
        ok: true,
        revoked_at: linha.capabilities_revoked_at,
        already: false,
      };
    });
  },

  /**
   * Bloqueia o run (§5.7.2: "efeito, submit ou resultado não reconciliável").
   *
   * O que `blocked` faz que `closed` não faria: **preserva a trava**. A unique
   * parcial da 140 cobre `phase <> 'closed'`, então um run bloqueado continua
   * ocupando a vaga do turno e ninguém abre outra deliberação por baixo — é o
   * invariante 7 do §5.6.2, e vale mesmo se o turno já foi para dead letter.
   *
   * `row_version` É incrementado aqui, ao contrário da revogação: bloquear É
   * transição de fase, e invalidar o CAS de quem estava em voo é justamente o
   * efeito desejado.
   */
  async markRunBlocked(input: {
    run_id: string;
    turn_id: string;
    actor: BlockActor;
    error_code: string;
    evidence: Record<string, Json>;
  }): Promise<MarkRunBlockedResult> {
    const { tenant_id, agent_id } = scope();

    const evidenciaJson = JSON.stringify(input.evidence);
    if (Buffer.byteLength(evidenciaJson, "utf8") > EVIDENCIA_MAX_BYTES) {
      conta("block", "evidence_too_large");
      return {
        ok: false,
        reason: "evidence_too_large",
        max_bytes: EVIDENCIA_MAX_BYTES,
      };
    }

    return withTx(async (tx): Promise<MarkRunBlockedResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("block", "not_found");
        return { ok: false, reason: "not_found" };
      }

      let actor_turn_attempt: number | null = null;
      if (input.actor.kind === "turn_owner") {
        const fence = await lockTurnAndCheckFence(tx, {
          turn_id: input.turn_id,
          origin_claim_token: input.actor.origin_claim_token,
        });
        if (!fence.ok) {
          conta("block", fence.reason);
          return fence;
        }
        actor_turn_attempt = Number(fence.turno.attempt_count);
      }

      const atualizado = linhas<{
        row_version: string | number;
        last_event_sequence: string | number;
      }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET phase = 'blocked',
                 last_error_code = ${input.error_code},
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND id = ${input.run_id}
             AND phase <> 'closed'
           RETURNING row_version, last_event_sequence`),
      );
      const linha = atualizado[0];
      if (!linha) {
        const atual = linhas<{ phase: string }>(
          await tx.execute(sql`
            SELECT phase FROM ${engine_runs}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}`),
        );
        if (!atual[0]) {
          conta("block", "not_found");
          return { ok: false, reason: "not_found" };
        }
        // Um run fechado não volta a ser bloqueado: reabrir a trava depois do
        // fechamento inventaria uma geração que já foi encerrada.
        conta("block", "already_closed");
        return { ok: false, reason: "already_closed" };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(linha.last_event_sequence),
        dedupe_key: `reconcile_decision:blocked:${Number(linha.row_version)}`,
        event_type: "reconcile_decision",
        actor_kind: input.actor.kind,
        actor_turn_attempt,
        metadata: {
          decision: "blocked",
          error_code: input.error_code,
          actor_ref:
            input.actor.kind === "turn_owner" ? null : input.actor.actor_ref,
          evidence: input.evidence,
        },
      });

      conta("block", "ok");
      return {
        ok: true,
        row_version: Number(linha.row_version),
        already_blocked: false,
      };
    });
  },

  /**
   * A PORTA OPERACIONAL (§5.7.2: "operador apresenta decisão/evidência
   * suficiente → closed/manual_resolved; só então replay explicitamente
   * autorizado").
   *
   * Não existe liberação por TTL, e isso é estrutural: não há parâmetro de
   * tempo nesta assinatura e nenhum caminho fecha sem `operator_ref` e
   * `evidence` não-vazios. "Nenhuma liberação automática por TTL" (§5.6.3) vira
   * impossibilidade de escrever a chamada, não convenção de runbook.
   *
   * `capabilities_revoked_at` entra por `COALESCE`: a 140 exige a coluna
   * preenchida em toda linha `closed`, e o COALESCE preserva o carimbo original
   * de quem já tinha revogado (P03.4) em vez de sobrescrevê-lo.
   */
  async resolveBlockedRun(input: {
    run_id: string;
    turn_id: string;
    operator_ref: string;
    decision: "manual_resolved";
    evidence: Record<string, Json>;
    expected_row_version?: number;
  }): Promise<ResolveBlockedRunResult> {
    const { tenant_id, agent_id } = scope();

    // As duas recusas acontecem ANTES de qualquer lock: não faz sentido tomar
    // lock de controle para descobrir que ninguém assinou a decisão.
    if (input.operator_ref.trim().length === 0) {
      conta("resolve_blocked", "operator_required");
      return { ok: false, reason: "operator_required" };
    }
    const evidenciaJson = JSON.stringify(input.evidence);
    if (Object.keys(input.evidence).length === 0) {
      conta("resolve_blocked", "evidence_required");
      return { ok: false, reason: "evidence_required" };
    }
    if (Buffer.byteLength(evidenciaJson, "utf8") > EVIDENCIA_MAX_BYTES) {
      conta("resolve_blocked", "evidence_too_large");
      return {
        ok: false,
        reason: "evidence_too_large",
        max_bytes: EVIDENCIA_MAX_BYTES,
      };
    }

    return withTx(async (tx): Promise<ResolveBlockedRunResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("resolve_blocked", "not_found");
        return { ok: false, reason: "not_found" };
      }

      const versaoEsperada =
        input.expected_row_version === undefined
          ? sql`TRUE`
          : sql`row_version = ${input.expected_row_version}`;

      const fechado = linhas<{
        row_version: string | number;
        last_event_sequence: string | number;
      }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET phase = 'closed',
                 closed_at = clock_timestamp(),
                 closed_reason = ${input.decision},
                 capabilities_revoked_at = COALESCE(capabilities_revoked_at, clock_timestamp()),
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND id = ${input.run_id}
             AND phase = 'blocked'
             AND ${versaoEsperada}
           RETURNING row_version, last_event_sequence`),
      );
      const linha = fechado[0];
      if (!linha) {
        const atual = linhas<{ phase: string; row_version: string | number }>(
          await tx.execute(sql`
            SELECT phase, row_version FROM ${engine_runs}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}`),
        );
        const row = atual[0];
        if (!row) {
          conta("resolve_blocked", "not_found");
          return { ok: false, reason: "not_found" };
        }
        if (row.phase !== "blocked") {
          conta("resolve_blocked", "phase_conflict");
          return {
            ok: false,
            reason: "phase_conflict",
            current_phase: row.phase as EngineRunPhaseV1,
          };
        }
        conta("resolve_blocked", "version_conflict");
        return {
          ok: false,
          reason: "version_conflict",
          current_row_version: Number(row.row_version),
        };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(linha.last_event_sequence),
        dedupe_key: `closed:${input.decision}:${Number(linha.row_version)}`,
        event_type: "closed",
        actor_kind: "operator",
        actor_turn_attempt: null,
        metadata: {
          decision: input.decision,
          operator_ref: input.operator_ref,
          evidence: input.evidence,
        },
      });

      conta("resolve_blocked", "ok");
      return { ok: true, row_version: Number(linha.row_version) };
    });
  },

  /**
   * O dono ATUAL adota o resultado terminal (§5.6.3, §5.8.2).
   *
   * **A assimetria que distingue esta operação de todas as anteriores:** aqui o
   * fence é do turno ATUAL, não da origem do run. Todo o resto deste módulo
   * exige `origin_claim_token` porque autoriza EFEITO — despachar tool, marcar
   * handler, liquidar. Adotar não autoriza efeito nenhum: pega um terminal que
   * já está persistido e diz quem assume a saída. O §5.8.2 é explícito na linha
   * "terminal externo persistido, sem output": o novo owner valida
   * política/calls/contexto e adota, em vez de pagar outra deliberação por um
   * worker ter sido reenfileirado. `adopted_by_turn_attempt` existe justamente
   * para registrar QUAL tentativa assumiu.
   *
   * O que adotar NÃO faz, e o `engine_runs_adopted_chk` explica por quê ("é o
   * que impede 'fechei o run' virar sinônimo de 'alguém decidiu o desfecho'"):
   *
   *   * não fecha o run — fechar é `closeRunAfterHandoff`, com prova própria;
   *   * não reautoriza callbacks antigos: `capabilities_revoked_at` não é
   *     tocado (§5.6.3, e o caso 50 prende isso);
   *   * não transiciona `agent_turns` — o §5.7.2 lembra que `phase` não
   *     substitui `status`, e um run fechado convive com turno
   *     `outbound_pending`.
   */
  async adoptTerminalResult(input: {
    run_id: string;
    turn_id: string;
    claim_token: string;
    output_preparation: Record<string, Json>;
    expected_row_version?: number;
  }): Promise<AdoptTerminalResultResult> {
    const { tenant_id, agent_id } = scope();

    const preparacaoJson = JSON.stringify(input.output_preparation);
    if (Buffer.byteLength(preparacaoJson, "utf8") > PREPARACAO_MAX_BYTES) {
      conta("adopt", "preparation_too_large");
      return {
        ok: false,
        reason: "preparation_too_large",
        max_bytes: PREPARACAO_MAX_BYTES,
      };
    }

    return withTx(async (tx): Promise<AdoptTerminalResultResult> => {
      const controle = await lockControl(tx, { run_id: input.run_id });
      if (!controle) {
        conta("adopt", "not_found");
        return { ok: false, reason: "not_found" };
      }

      // Fence do turno ATUAL: posse viva e `running`. Sem `origin_turn_attempt`
      // de propósito — quem adota pode ser uma tentativa posterior.
      const fence = await lockTurnAndCheckFence(tx, {
        turn_id: input.turn_id,
        origin_claim_token: input.claim_token,
      });
      if (!fence.ok) {
        conta("adopt", fence.reason);
        return fence;
      }
      const attempt = Number(fence.turno.attempt_count);

      const versaoEsperada =
        input.expected_row_version === undefined
          ? sql`TRUE`
          : sql`row_version = ${input.expected_row_version}`;

      const adotado = linhas<{
        row_version: string | number;
        last_event_sequence: string | number;
      }>(
        await tx.execute(sql`
          UPDATE ${engine_runs}
             SET adopted_by_turn_attempt = ${attempt},
                 output_preparation_json = ${preparacaoJson}::jsonb,
                 row_version = row_version + 1,
                 last_event_sequence = last_event_sequence + 1,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id}
             AND id = ${input.run_id}
             AND phase = 'result_ready'
             AND ${versaoEsperada}
           RETURNING row_version, last_event_sequence`),
      );
      const linha = adotado[0];
      if (!linha) {
        const atual = linhas<{ phase: string; row_version: string | number }>(
          await tx.execute(sql`
            SELECT phase, row_version FROM ${engine_runs}
             WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${input.run_id}`),
        );
        const row = atual[0];
        if (!row) {
          conta("adopt", "not_found");
          return { ok: false, reason: "not_found" };
        }
        if (row.phase !== "result_ready") {
          conta("adopt", "phase_conflict");
          return {
            ok: false,
            reason: "phase_conflict",
            current_phase: row.phase as EngineRunPhaseV1,
          };
        }
        conta("adopt", "version_conflict");
        return {
          ok: false,
          reason: "version_conflict",
          current_row_version: Number(row.row_version),
        };
      }

      await appendEvent(tx, {
        run_id: input.run_id,
        sequence_no: Number(linha.last_event_sequence),
        dedupe_key: `output_handoff:adopted:${attempt}`,
        event_type: "output_handoff",
        actor_kind: "turn_owner",
        actor_turn_attempt: attempt,
        metadata: {
          adopted_by_turn_attempt: attempt,
          preparation_bytes: Buffer.byteLength(preparacaoJson, "utf8"),
        },
      });

      conta("adopt", "ok");
      return {
        ok: true,
        adopted_by_turn_attempt: attempt,
        row_version: Number(linha.row_version),
      };
    });
  },
};

/**
 * Zero linhas num CAS de run NÃO é sucesso silencioso nem exceção: é leitura
 * sob o escopo para dizer POR QUE (§5.6.4).
 */
async function classificarConflitoDeRun(
  tx: Executor,
  args: { run_id: string; origin_claim_token: string; turno: TurnoRow },
): Promise<
  | NotFound
  | TurnFenceConflict
  | { ok: false; reason: "capabilities_revoked" }
  | { ok: false; reason: "deadline_exceeded" }
  | {
      ok: false;
      reason: "version_conflict";
      current_row_version: number;
      current_phase: EngineRunPhaseV1;
    }
> {
  const { tenant_id, agent_id } = scope();
  const rows = linhas<{
    phase: string;
    row_version: string | number;
    origin_claim_token: string;
    origin_turn_attempt: number | string;
    revogado: boolean;
    deadline_vencido: boolean;
  }>(
    await tx.execute(sql`
      SELECT phase, row_version,
             origin_claim_token::text AS origin_claim_token, origin_turn_attempt,
             (capabilities_revoked_at IS NOT NULL) AS revogado,
             (deadline_at <= clock_timestamp()) AS deadline_vencido
        FROM ${engine_runs}
       WHERE tenant_id = ${tenant_id} AND agent_id = ${agent_id} AND id = ${args.run_id}`),
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };

  // PERDA DE POSSE ANTES DE TUDO (§5.6.4). Devolver `version_conflict` para
  // quem não é mais dono convida exatamente a reação errada: reler e tentar de
  // novo. Quem perdeu a posse tem de PARAR — e o CAS acima pode ter falhado
  // por token/tentativa, não só por versão (achado 6 da V-018).
  if (
    row.origin_claim_token !== args.origin_claim_token ||
    Number(row.origin_turn_attempt) !== Number(args.turno.attempt_count)
  ) {
    return {
      ok: false,
      reason: "stale_claim",
      current_status: args.turno.status,
      current_state_version: Number(args.turno.state_version),
    };
  }
  if (row.revogado) return { ok: false, reason: "capabilities_revoked" };
  if (row.deadline_vencido) return { ok: false, reason: "deadline_exceeded" };
  return {
    ok: false,
    reason: "version_conflict",
    current_row_version: Number(row.row_version),
    current_phase: row.phase as EngineRunPhaseV1,
  };
}
