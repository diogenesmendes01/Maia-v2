export type WhatsAppInbound = {
  whatsapp_id: string;
  remote_jid: string;
  is_group: boolean;
  pushname: string | null;
  timestamp_ms: number;
  type: 'texto' | 'audio' | 'imagem' | 'documento' | 'sistema';
  content: string | null;
  media_local_path: string | null;
  media_mime: string | null;
  media_sha256: string | null;
};

/** Campos de correlação comuns às duas versões do payload (#514 §1). */
type JobCorrelation = {
  /**
   * Issue #514 §1 — root trace id of the turn, carried across the queue
   * boundary so ingress, worker, LLM, tool and outbound all correlate.
   *
   * OPTIONAL on purpose: jobs armed by an older process (rolling deploy) or by
   * a path that has not adopted the contract yet still process normally — the
   * consumer re-derives the id deterministically from the job identity via
   * `deriveTraceId()`, which yields the SAME value. The field is therefore an
   * optimisation + explicit contract, never a correctness dependency.
   */
  trace_id?: string;
  /** Epoch ms when the job was armed. Feeds the queue-wait SLI. */
  enqueued_at_ms?: number;
  /** Epoch ms of `mensagens.created_at`. Feeds the inbound→delivered SLI. */
  received_at_ms?: number;
};

/**
 * Payload LEGADO (V1). A identidade do trabalho era a mensagem inbound.
 *
 * Continua sendo aceito pelo consumidor durante a janela de rollout de #504 —
 * um job armado por um processo antigo tem de processar normalmente. O critério
 * de remoção é mensurável e está em `LEGACY_JOB_REMOVAL_CRITERION`
 * (`src/runtime/turns/claim.ts`).
 */
export type AgentJobV1 = JobCorrelation & {
  mensagem_id: string;
};

/**
 * Payload V2 (issue #504): SÓ a identidade durável do turno.
 *
 * Tudo o mais — tenant, agent, conversa, canal, mensagens — é RELIDO do
 * PostgreSQL depois que o worker vence o claim. Um job pode ficar horas em
 * Redis, ser redelivered, ou ter sido armado por outra versão do processo:
 * qualquer campo replicado nele é uma cópia que pode divergir da row, e um
 * `tenant_id` divergente é exatamente a classe de bug que a invariante 1 do
 * AGENTS.md existe para impedir.
 */
export type AgentTurnJobV2 = JobCorrelation & {
  version: 2;
  turn_id: string;
};

/**
 * O que trafega na fila `agent`. União DISCRIMINADA — o consumidor decide por
 * `parseAgentJob` (`src/runtime/turns/claim.ts`), que é fail-closed: payload
 * que não casa com nenhuma das versões não vira execução.
 */
export type AgentJob = AgentJobV1 | AgentTurnJobV2;

/** Type guard do payload V2. */
export function isAgentTurnJobV2(job: AgentJob): job is AgentTurnJobV2 {
  return (job as AgentTurnJobV2).version === 2;
}

export type WAQuotedContext = {
  key: { remoteJid: string; id: string; fromMe: boolean };
  message: { conversation: string };
};

export type OutboundParams = {
  pessoa_id_destino: string;
  conversa_id: string | null;
  type: 'texto' | 'imagem' | 'documento';
  content: string;
  media_local_path?: string;
  metadata?: Record<string, unknown>;
};
