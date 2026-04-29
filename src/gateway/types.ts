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
