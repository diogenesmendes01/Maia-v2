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

export type AgentJob = {
  mensagem_id: string;
  /**
   * Issue #514 §1 — root trace id of the turn, carried across the queue
   * boundary so ingress, worker, LLM, tool and outbound all correlate.
   *
   * OPTIONAL on purpose: jobs armed by an older process (rolling deploy) or by
   * a path that has not adopted the contract yet still process normally — the
   * consumer re-derives the id deterministically from `mensagem_id` via
   * `deriveTraceId()`, which yields the SAME value. The field is therefore an
   * optimisation + explicit contract, never a correctness dependency.
   */
  trace_id?: string;
  /** Epoch ms when the job was armed. Feeds the queue-wait SLI. */
  enqueued_at_ms?: number;
  /** Epoch ms of `mensagens.created_at`. Feeds the inbound→delivered SLI. */
  received_at_ms?: number;
};

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
