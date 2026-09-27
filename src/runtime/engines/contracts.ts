/**
 * P02 (spec §5.3) — CONTRATOS DA PORTA DE ENGINE.
 *
 * `AgentEnginePortV1` é a fronteira entre o turno da Maia e um motor de
 * raciocínio. Dois motores a implementam: o local (`maia_react`, extração do
 * ReAct atual) e o remoto (`hermes`, adapter sobre o worker privado).
 *
 * ─── O que a porta É ────────────────────────────────────────────────────────
 *
 * `start` aceita trabalho ou reporta incerteza. `observe` consulta. `cancel`
 * pede cancelamento. **Nenhum dos três conclui um turno**: quem decide desfecho,
 * efeito e entrega é a Maia, depois, com o journal na mão (§5.3.1).
 *
 * São métodos TypeScript internos — NÃO endpoints HTTP (§4.1). A V1 não expõe
 * `/v1/runs` nem qualquer rota de lifecycle.
 *
 * ─── O que a porta NÃO é ────────────────────────────────────────────────────
 *
 * Não é canal de autoridade. A proposta terminal do motor não pode declarar
 * entrega, efeito, aprovação ou identidade: `dispatched`, `persistUnknown`,
 * `sideEffectsCommitted`, destinatário, grants e claim token são estruturas
 * exclusivamente da Maia (§5.3.3), e os schemas em `./schemas.js` recusam esses
 * campos em vez de ignorá-los.
 *
 * Não é transporte. `EngineIOV1` carrega `AbortSignal` e função — objetos
 * LOCAIS, que nunca são serializados.
 */
import type { LLMMessage, ToolSchema } from '@/lib/llm/types.js';
import type { ToolExecutionSummary } from '@/agent/tool-execution-summary.js';
/**
 * Mídia DURÁVEL no sentido do contrato de outbound (§5.9): `local_path` ou
 * `storage_object`, nunca uma URL assinada. Reutilizado aqui em vez de um tipo
 * paralelo — dois tipos para o mesmo fato divergiriam na primeira mudança.
 */
import type { MediaRef } from '@/runtime/outbound/contract.js';

/** Representações textuais. A restrição real é dos validadores Zod. */
export type UUID = string;
export type IsoInstant = string;
export type Sha256Hex = string;
/** Inteiro decimal não negativo em string. Dinheiro nunca em float (§5.3.1). */
export type DecimalUint = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type EngineKind = 'maia_react' | 'hermes';

/** Fases DURÁVEIS do run (§5.6.2). Não confundir com `agent_turns.status`. */
export type EngineRunPhaseV1 =
  | 'prepared'
  | 'submitting'
  | 'submission_unknown'
  | 'running'
  | 'cancelling'
  | 'reconciling'
  | 'result_ready'
  | 'blocked'
  | 'closed';

export type EngineToolCallStateV1 =
  | 'received'
  | 'dispatching'
  | 'handler_started'
  | 'completed'
  | 'denied'
  | 'approval_required'
  | 'effect_unknown'
  | 'cancelled';

export type EngineCloseReasonV1 =
  | 'handed_to_outbox'
  | 'completed_no_reply'
  | 'safe_to_retry'
  | 'discarded'
  | 'manual_resolved';

export interface EnginePinV1 {
  engine: EngineKind;
  /** Versão da implementação implantada. */
  adapter_revision: string;
  /** Digest da configuração NÃO secreta. */
  configuration_digest: Sha256Hex;
  protocol_version: 1;
}

/**
 * Contexto do host. **Exclusivamente Maia**: persistido como contexto
 * protegido, nunca usado como autenticação (§5.3.1). O `claim_token` do turno
 * fica só no banco (§5.6.1) — por isso ele não aparece aqui, e os schemas
 * recusam quem tentar acrescentá-lo.
 */
export interface HostContextSnapshotV1 {
  version: 1;
  tenant_id: string;
  agent_id: string;
  turn_id: UUID;
  pessoa_id: UUID;
  conversa_id: UUID;
  channel_id: UUID;
  representative_message_id: UUID;
  input_message_ids: UUID[];
  stream_key: string;
  control_id: UUID;
  /** `bigint` do Postgres serializado como decimal — não cabe em `number`. */
  control_epoch: DecimalUint;
  /** JID original autorizado, inclusive LID. */
  remote_jid: string;
  trace_id: string;
  active_role_id: UUID | null;
  active_execution_id: UUID | null;
  outbound_prefix: string | null;
  allowed_entity_ids: UUID[];
  /** Resultado PÓS-reduções do turno, não o registry inteiro. */
  allowed_tool_names: string[];
  policy_digest: Sha256Hex;
  source_versions: Array<{ kind: string; id: string; version: string | null }>;
}

export interface EngineRequestV1 {
  version: 1;
  /** Atribuído pela Maia ANTES de qualquer start. */
  run_id: UUID;
  /** Estável em TODAS as retentativas de start (§5.6.1). */
  request_key: UUID;
  task: 'reasoner';
  isolation: 'one_run_no_shared_memory';
  context: {
    system: string;
    /** Cópia profunda validada como JSON — o array do caller não é referenciado. */
    messages: LLMMessage[];
    /** Subconjunto exato autorizado; sem executáveis nem segredos. */
    tools: ToolSchema[];
  };
  limits: {
    max_iterations: number;
    max_output_tokens_per_call: number;
    max_tool_calls: number;
    /** Absoluto; diferente do horizonte móvel da lease (§5.8.1). */
    deadline_at: IsoInstant;
    max_cost_microusd: DecimalUint;
  };
}

export interface ReportedUsageV1 {
  input_tokens: number | null;
  output_tokens: number | null;
  /** `null` = desconhecido. Nunca zero fabricado por timeout (§5.3.4). */
  cost_microusd: DecimalUint | null;
  source: 'provider_accounted' | 'engine_reported' | 'unavailable';
}

export type EngineStopV1 =
  | { kind: 'reply'; raw_text: string }
  | { kind: 'no_reply'; reason: 'empty_final_text' | 'iteration_cap' }
  | { kind: 'failed'; code: 'reasoner_failed' | 'deadline_exceeded' | 'protocol_error' }
  | { kind: 'cancelled'; reason: 'ownership_lost' | 'operator' | 'shutdown' };

/**
 * Proposta terminal do motor. **Não autoritativa**: nem efeitos nem entrega são
 * admitidos no schema. `observed_tool_call_ids` é o que o motor AFIRMA ter
 * chamado — o assembler confronta com o journal e recusa divergência (§5.3.4).
 */
export interface EngineTerminalProposalV1 {
  version: 1;
  run_id: UUID;
  request_key: UUID;
  stop: EngineStopV1;
  iterations: number;
  observed_tool_call_ids: string[];
  usage: ReportedUsageV1;
}

export interface EngineRunLocatorV1 {
  run_id: UUID;
  request_key: UUID;
  /** Implantação/configuração registrada, nunca URL livre. */
  remote_instance_id: string;
  /** Ausente enquanto o submit é desconhecido. */
  remote_run_id: string | null;
}

export type EngineObservationV1 =
  | { kind: 'running'; remote_run_id: string }
  | { kind: 'terminal'; remote_run_id: string; proposal: EngineTerminalProposalV1 }
  /**
   * `definitely_not_accepted` exige garantia comprovada pelo adapter; a ausência
   * de registro depois de reinício é `inconclusive`, nunca prova (§5.3.1).
   */
  | { kind: 'not_found'; proof: 'definitely_not_accepted' | 'inconclusive' }
  | { kind: 'unavailable'; code: 'timeout' | 'transport' | 'unauthorized' | 'unsupported' };

export type EngineStartResultV1 =
  | { kind: 'accepted'; remote_run_id: string }
  | { kind: 'rejected'; definitely_not_accepted: true; code: string }
  | { kind: 'unknown'; code: string };

export interface EngineToolCallV1 {
  version: 1;
  run_id: UUID;
  /** Imutável e estável nos retries do motor. Derivado por `deriveCallId`. */
  call_id: string;
  /** 0-based por run, sem lacunas no piloto. */
  ordinal: number;
  /** Telemetria opcional; `null` quando não verificável (§4.1). */
  iteration: number | null;
  name: string;
  args: Json;
}

export type EngineToolReplyV1 =
  | { kind: 'result'; call_id: string; result: Json; is_error: boolean }
  | { kind: 'in_progress'; call_id: string; retry_after_ms: number }
  | {
      kind: 'refused';
      call_id: string;
      code:
        | 'run_not_authorized'
        | 'tool_not_allowed'
        | 'payload_conflict'
        | 'budget_exhausted'
        | 'effect_unknown'
        | 'protocol_error';
    };

// ─── §5.3.2 — chamada de ferramenta e evidência produzida pela Maia ─────────
//
// Estes tipos são EXCLUSIVAMENTE da Maia. Nenhum deles atravessa o wire: o
// `EngineToolReplyV1` acima é o único que o motor vê, e ele não tem campo para
// receipt, evidência de efeito, classificação ou token. É a mesma fronteira de
// `EngineTerminalProposalV1`: o motor AFIRMA, a Maia REGISTRA.

/** Efeito declarado no registry da casa. `'none'` é valor REAL, não ausência. */
export type SideEffect = 'none' | 'read' | 'write' | 'communication';

/** As mesmas quatro classes de `src/tools/effect-class.ts` (§5.7.4 item 9). */
export type ToolEffectClassV1 =
  | 'abort_safe'
  | 'idempotent'
  | 'non_interruptible'
  | 'compensatable';

/**
 * Quanto se sabe sobre o efeito no momento do receipt.
 *
 * `possible`/`unknown` NUNCA regridem para `none` (§5.6.2, T13): uma vez que o
 * marcador de início existe, "não houve efeito" deixa de ser uma afirmação
 * disponível. `committed` exige prova de ledger/outbox — uma resposta de handler
 * não é prova, porque o handler pode ter emitido o efeito e falhado ao gravar.
 */
export type ToolEffectEvidenceV1 = 'none' | 'possible' | 'committed' | 'unknown';

/**
 * A aprovação HUMANA que uma chamada exigiu. `ref` é o identificador de UX
 * (`AP-xxxxxxxx`), truncado e NÃO autorizador; quem autoriza é o `request_id`
 * completo, que é o que o journal persiste.
 */
export interface ApprovalBindingV1 {
  request_id: UUID;
  ref: string;
  intent_hash: string;
  approval_class: 'single_confirmation' | 'requester_plus_one_owner' | 'two_distinct_owners';
}

/**
 * O receipt de uma chamada: o que a Maia GRAVOU ao despachar, não o que o
 * motor relatou.
 *
 * `result` é o resultado protegido do backend (o passo pós-turno consome este);
 * `result_for_engine` é a PROJEÇÃO que pode ser devolvida ao motor — sem caminho
 * de arquivo, sem segredo, sem metadado interno. Os dois campos existem porque
 * são dois destinatários com autorizações diferentes.
 *
 * `side_effect`/`effect_class` são `null` APENAS em recusa anterior à resolução
 * do registry: sem spec conhecida não há classe, e inventar `abort_safe` para
 * uma ferramenta desconhecida seria afirmar ausência de efeito sobre o
 * desconhecido.
 */
export interface ToolReceiptV1 {
  call_id: string;
  ordinal: number;
  name: string;
  /** Resultado backend protegido, serializável. */
  result: Json;
  /** Projeção para o motor: sem paths, segredos ou metadados internos. */
  result_for_engine: Json;
  status: 'success' | 'error';
  side_effect: SideEffect | null;
  effect_class: ToolEffectClassV1 | null;
  legacy_irreversible_invoked: boolean;
  effect_evidence: ToolEffectEvidenceV1;
  sensitive: boolean;
  started_at: IsoInstant | null;
  finished_at: IsoInstant;
  summary: ToolExecutionSummary;
  approval: ApprovalBindingV1 | null;
  pending_question_id: UUID | null;
  report: {
    media: MediaRef;
    file_name: string;
    mimetype: string;
    tipo: 'extrato' | 'comparativo';
  } | null;
}

/**
 * A classificação CONGELADA no journal, entregue ao caminho durável.
 *
 * Ela mora no control porque é o próprio journal que a congela
 * (`markToolDispatching`) e porque o receipt precisa dela para não ter de
 * reclassificar a ferramenta com uma regra que pode ter mudado desde a
 * admissão. Estruturalmente idêntica a `ToolClassification` de
 * `engine-repos.ts`, sem criar dependência de `runtime/engines` para `db`.
 */
export type ToolClassificationSnapshotV1 = {
  side_effect: SideEffect;
  effect_class: ToolEffectClassV1 | null;
  sensitive: boolean;
  legacy_irreversible_invoked: boolean;
};

/**
 * Desfecho do caminho durável (§5.3.2).
 *
 * `journal_unavailable` existe para o caso em que o journal pode não ter
 * registrado o início: sem essa informação o run não pode ser fechado nem o
 * resultado devolvido — `handler_may_have_started` diz se há efeito a
 * reconciliar.
 */
export type DurableDispatchResultV1 =
  | { kind: 'settled'; receipt: ToolReceiptV1 }
  | { kind: 'ownership_lost' }
  | { kind: 'journal_unavailable'; handler_may_have_started: boolean };

/**
 * Controle LOCAL do dispatcher durável. Nunca aceito de args HTTP — o
 * §5.3.2 é explícito sobre isso: o engine não fornece identidade.
 *
 * Três métodos e três momentos, cada um no ponto em que a informação existe:
 *
 *   `freezeIdentity`  — antes de lookup/aprovação/reserva. Persiste a chave e o
 *     hash atuais e, no replay, devolve os JÁ PERSISTIDOS: recalcular a chave
 *     depois de uma virada de bucket produziria uma identidade diferente para a
 *     mesma intenção, que é o defeito que o congelamento existe para impedir.
 *   `recordApproval`  — imediatamente ao conhecer o UUID/claim real. Depois do
 *     claim não há outro momento: ou a evidência é gravada aqui, ou o humano
 *     aprova de novo uma chamada que já consumiu o "sim".
 *   `beforeHandler`   — imediatamente antes de `tool.handler`. Marca
 *     `handler_started` e persiste reserva/aprovação em TX curta, fenced. Falha
 *     aqui significa que o handler NÃO começa.
 *
 * `call_id`/`call_ordinal`: o §5.3.2 esboça `call_row_id`, mas a API de
 * journal desta casa é endereçada por `call_id` (texto estável do wire) — e é
 * ela que o receipt precisa publicar. Ver a nota em `engine-repos.ts`.
 */
export interface DurableDispatchControlV1 {
  /** Chave de identidade da chamada no journal (`engine_tool_calls.call_id`). */
  call_id: string;
  /** `ordinal` 0-based do run, o mesmo que o receipt publica. */
  call_ordinal: number;
  /** Token do `dispatching`; o fence de TODA transição da chamada. */
  dispatch_token: string;
  /** Classificação congelada no journal, para o receipt. */
  classification: ToolClassificationSnapshotV1;
  freezeIdentity(candidate: {
    key: string;
    payload_hash: string;
    normalized_args: Json;
  }): Promise<{ key: string; payload_hash: string }>;
  recordApproval(input: {
    approval: ApprovalBindingV1;
    state: 'pending' | 'claimed';
    claim_token: string | null;
  }): Promise<void>;
  beforeHandler(input: {
    reservation_token: string;
    approval_request_id: UUID | null;
    approval_claim_token: string | null;
  }): Promise<void>;
}

/** Objetos LOCAIS: nunca serializar `signal` nem função (§5.3.1). */
export interface EngineIOV1 {
  signal: AbortSignal;
  invokeTool(call: EngineToolCallV1): Promise<EngineToolReplyV1>;
}

export interface AgentEnginePortV1 {
  readonly pin: EnginePinV1;
  start(request: EngineRequestV1, io: EngineIOV1): Promise<EngineStartResultV1>;
  observe(locator: EngineRunLocatorV1, signal: AbortSignal): Promise<EngineObservationV1>;
  cancel(
    locator: EngineRunLocatorV1,
    signal: AbortSignal,
  ): Promise<{ kind: 'requested' | 'already_terminal' | 'unsupported' | 'unknown' }>;
}
