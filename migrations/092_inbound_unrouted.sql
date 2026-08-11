-- 092 — Staging durável de inbound não-roteado (spec roteamento Draft v4
-- §1.4, modo strict). O envelope chega ANTES de existir tenant resolvido —
-- exceção consciente documentada em governance-observability: payload
-- CIFRADO em aplicação (AES-256-GCM, keyring), TTL 72h, acesso restrito ao
-- worker de re-resolução.
CREATE TABLE IF NOT EXISTS inbound_unrouted (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_external_id text NOT NULL,
  whatsapp_message_id text NOT NULL,
  envelope bytea NOT NULL,
  enc_key_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  handed_off_at timestamptz,
  CONSTRAINT inbound_unrouted_status_chk
    CHECK (status IN ('pending', 'handed_off', 'expired'))
);

-- Idempotência pré-resolução (review v4): retries do evento Baileys não
-- duplicam o staging; o insert usa ON CONFLICT DO NOTHING + re-arma o job.
CREATE UNIQUE INDEX IF NOT EXISTS inbound_unrouted_line_msg_uq
  ON inbound_unrouted (line_external_id, whatsapp_message_id);

-- Varreduras do worker (re-resolução de pending; TTL sweep).
CREATE INDEX IF NOT EXISTS idx_inbound_unrouted_pending
  ON inbound_unrouted (received_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inbound_unrouted_expiry
  ON inbound_unrouted (expires_at) WHERE status = 'pending';
