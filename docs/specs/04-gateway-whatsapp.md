# Spec 04 — Gateway: WhatsApp / Baileys

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 01, 02

---

## 1. Purpose

Define how WhatsApp messages enter and leave Maia. This spec covers the Baileys integration, message normalization, deduplication, queueing into BullMQ, group-chat handling, reconnection logic, and graceful degradation when WhatsApp is unreachable.

The gateway is the **only** way humans send messages to Maia in Phase 1. It must never lose a message and never act on a duplicate.

## 2. Goals

- Single Baileys session bound to Maia's dedicated WhatsApp number.
- Persist every inbound message **before** any processing.
- Deduplicate by WhatsApp message id at the earliest possible point.
- Queue normalized messages into BullMQ for the agent worker to consume.
- Handle reconnection automatically; alert out-of-band when offline > 5 min.
- Reject group chats and unknown numbers per policy.

## 3. Non-goals

- Multi-session / multi-number support.
- WhatsApp Business API (Meta Cloud API). Baileys is the chosen path.
- Outbound mass messaging. Outbound proactive messages go through spec 12.

## 4. Architecture

```
WhatsApp client (user phone)
       │
       │   end-to-end encrypted
       ▼
Baileys socket  ────────► Auth dir (.baileys-auth volume)
       │
       │ on message
       ▼
[Step 1] Normalize  ──► WhatsAppMessage object
       │
       ▼
[Step 2] Dedup gate ──► drop if whatsapp_id seen
       │
       ▼
[Step 3] Persist    ──► INSERT into mensagens (direcao='in', processada_em=NULL)
       │
       ▼
[Step 4] Enqueue    ──► BullMQ job: { mensagem_id }
       │
       ▼
[Step 5] ACK        ──► socket ack to WhatsApp (delivered)

Outbound path (sendMessage):
caller passes (mensagem_id_origem, conversa_id, content, type)
       │
       ▼
INSERT mensagens (direcao='out', processada_em=now())
       │
       ▼
Baileys.sendMessage() with retry policy
       │
       ▼
Socket ack handled, mensagens.metadata.whatsapp_id updated when known
```

## 5. Schemas

### 5.1 Normalized inbound shape

```typescript
type WhatsAppInbound = {
  whatsapp_id: string;           // unique per message; from msg.key.id
  remote_jid: string;            // sender chat id; e.g. '5511999999999@s.whatsapp.net'
  is_group: boolean;
  pushname: string | null;
  timestamp_ms: number;
  type: 'texto' | 'audio' | 'imagem' | 'documento' | 'sistema';
  content: string | null;        // text content for text messages
  media_local_path: string | null; // saved into media volume for audio/image/document
  media_mime: string | null;
  media_sha256: string | null;   // computed at save time; used for idempotency on attachment ops
  raw: unknown;                  // original Baileys message; not serialized to logs (PII)
};
```

### 5.2 BullMQ job payload

```typescript
type AgentJob = {
  mensagem_id: string;           // UUID from mensagens row
  tentativa: number;             // BullMQ-managed retry counter
};
```

The job carries only the `mensagem_id`. The worker reloads the row and the related conversa context. This keeps the queue small and avoids stale data.

## 6. Inbound pipeline — detailed

### 6.1 Step 1 — Normalize

Map Baileys' raw message into `WhatsAppInbound`. Audio, image, and document attachments are downloaded to `BAILEYS_AUTH_DIR/../media/<yyyy-mm>/<sha256>.<ext>`; we store **content-addressed** to support attachment dedup (spec 09). The path is recorded in `media_local_path`.

### 6.2 Step 2 — Deduplication gate

Two-tier check, both backed by spec 09 layer 1:

1. **Redis bloom-style cache** of last 1,000 `whatsapp_id`s with TTL 24h. Hit → drop.
2. On miss, query `SELECT 1 FROM mensagens WHERE metadata->>'whatsapp_id' = ?`. Hit → drop, update Redis cache.

Drop behavior: write `audit_log` with `acao='duplicate_message_dropped'`, return early. **Do not** ACK to Baileys differently — the user need not know.

### 6.3 Step 3 — Persist

Single transactional insert:

```sql
INSERT INTO mensagens (id, conversa_id, direcao, tipo, conteudo, midia_url, metadata)
VALUES (
  uuid_generate_v4(),
  $conversa_id,           -- resolved later if NULL — see spec 05
  'in',
  $tipo,
  $conteudo,
  $media_local_path,
  jsonb_build_object('whatsapp_id', $whatsapp_id, 'remote_jid', $remote_jid,
                     'pushname', $pushname, 'media_sha256', $media_sha256)
);
```

If `conversa_id` cannot be resolved yet (new pessoa, quarantine flow), the row is inserted with `conversa_id = NULL` and the identity-resolver fills it later. The persistence MUST succeed before queue enqueue.

### 6.4 Step 4 — Enqueue

```typescript
agentQueue.add('process-message', { mensagem_id }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600 * 24 },        // 1 day
  removeOnFail: false,                          // keep failed jobs for inspection
});
```

Failed jobs after exhausted retries are routed to DLQ via BullMQ's `failed` event (spec 17).

### 6.5 Step 5 — ACK

Baileys auto-ACKs on receive. We confirm receipt by replying within 30s where applicable; if processing takes longer, the worker emits a typing indicator using `socket.sendPresenceUpdate('composing', remote_jid)`.

## 7. Outbound pipeline

### 7.1 Function signature

```typescript
async function sendOutbound(params: {
  conversa_id: string;
  in_reply_to_mensagem_id?: string;
  pessoa_id_destino: string;
  type: 'texto' | 'imagem' | 'documento';
  content: string;                  // text or caption
  media_local_path?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ mensagem_id: string; whatsapp_id: string | null }>;
```

### 7.2 Steps

1. Resolve destination JID from `pessoas.telefone_whatsapp`.
2. Insert into `mensagens` with `direcao='out'`, `processada_em=now()`.
3. Call `socket.sendMessage(jid, payload)` with timeout 15s, retry 2x with backoff.
4. On success, store the returned WhatsApp message id into `mensagens.metadata.whatsapp_id`.
5. On exhausted retries, **do not throw**. Insert into DLQ with payload + last error; alert via spec 17 channels.

### 7.3 Backpressure

A user cooldown (spec 03 §9) may cause a deliberate delay. Outbound respects this: if the recipient just received a high-volume burst, throttle to maximum 1 outbound per 800ms.

## 8. Group-chat detection

Maia is **not** designed for group chats. If `is_group === true`:

- Drop without processing.
- Write `audit_log` `acao='group_message_ignored'`.
- If `pushname` matches a known `dono` or `co_dono`, alert that owner via Telegram: "Te adicionaram em grupo X. Saio sozinha?"
- Optionally, leave the group automatically if `FEATURE_AUTO_LEAVE_GROUPS=true` (default false; behavior can be intrusive in early days).

## 9. Unknown number handling

If `remote_jid` does not match any row in `pessoas`:

- Persist the message row with `conversa_id=NULL` (no conversation created).
- Do **not** reply.
- Write `audit_log` `acao='unknown_number_message_received'` with the phone.
- Notify the owner via Telegram: "Mensagem de número desconhecido +55XX..."

The owner can later cadastra the person, after which the existing row will be linked into a new conversation.

## 10. Reconnection policy

Baileys sockets disconnect for many reasons (server-side timeouts, network blips, account challenge). The gateway monitors:

```
on('connection.update', (update) => {
  if (update.connection === 'close') {
    handleDisconnect(update.lastDisconnect);
  }
});
```

`handleDisconnect` logic:

| `DisconnectReason` | Action |
|---|---|
| `restartRequired` | Recreate socket immediately |
| `connectionLost`, `timedOut` | Backoff retry: 5s, 10s, 30s, 60s, 60s, ... cap at 60s |
| `loggedOut` | **Stop reconnecting**; alert owner urgently — re-pair required |
| Other | Backoff retry |

If the socket is `down` for more than `WHATSAPP_RECONNECT_ALERT_MIN` (default 5 min):

- Write `system_health_events` row.
- Trigger spec 17 alert pipeline (email + Telegram).
- After reconnection, post a status message to the owner: "Voltei. Fiquei offline X min."

The auth state lives in `BAILEYS_AUTH_DIR` and is mounted as a Docker volume. **Never delete** this directory; it implies re-pairing.

## 11. LLM Boundaries

The LLM is not part of the gateway. Specifically:

- The LLM does not see raw Baileys payloads.
- The LLM does not decide whether to ACK.
- The LLM cannot cause an outbound to be sent except through the `send_proactive_message` tool, which itself goes through governance (spec 09).
- The LLM cannot bypass the dedup gate.

## 12. Behavior & Rules

### 12.1 Multi-message bursts

Users may send several messages in quick succession ("lança", then "R$ 50", then "mercado", then "ah, foi ontem"). The gateway does **not** combine these. Each is processed individually by the worker, which has access to `mensagens` ordered by `created_at` for the same `conversa`. Conversational coherence is the agent's job (spec 06).

### 12.2 Typing indicator on long processing

If the agent has been processing a message for > 3s and has not yet replied, the gateway sends `composing` presence. This refreshes every 8s until the reply is sent or 30s pass.

### 12.3 Read receipts

Maia marks messages as read **only after** persisting and enqueuing, never before. Baileys `readReceipts` is emitted explicitly.

### 12.4 Ordering guarantees

Per `(pessoa_id, conversa_id)`, processing is FIFO. BullMQ's queue is not strictly per-conversation, so the worker must check `mensagens.created_at` ordering and refuse to process out-of-order. The worker uses an advisory lock keyed on `conversa_id` to serialize.

## 13. Error cases

| Failure | Behavior |
|---|---|
| Baileys returns malformed message | Log, drop, audit `malformed_message_dropped` |
| Persisting `mensagens` fails (DB down) | Do not ACK to Baileys (allow redelivery); enter Redis-down policy if Redis is also affected |
| Enqueue fails (Redis down) | Switch to **synchronous degraded mode**: process inline if action is in allowed-list (spec 17 §Redis-down policy); otherwise enqueue to a local file-backed retry log and alert |
| Outbound `sendMessage` exhausts retries | Insert to DLQ; alert; user does not know — owner is informed and can ask Maia to retry manually |
| Auth state corrupted | Treat as `loggedOut`; require manual re-pair (CLI `npm run baileys:pair`) |

## 14. Acceptance criteria

- [ ] Sending the same message twice from a real WhatsApp client results in exactly one row in `transacoes` (verified by manual smoke test).
- [ ] Killing Redis mid-message leaves `mensagens` row intact and re-processes when Redis returns.
- [ ] Disconnecting the WhatsApp account (e.g., logging out from phone settings) triggers the urgent alert and stops reconnect attempts.
- [ ] Group-chat invites do not produce conversations or replies; an alert is fired.
- [ ] Unknown-number messages produce an audit row and an owner alert.
- [ ] Long-running messages emit `composing` indicator and update it.

## 15. Open questions

- Should we send a polite "I cannot help in groups" message when added to a group, or stay silent? Default: stay silent. Revisit if owners feel rude.

## 16. References

- Spec 02 — `mensagens`, `system_health_events`, `dead_letter_jobs`
- Spec 05 — identity resolver, conversation creation
- Spec 09 — governance (Redis-down policy)
- Spec 17 — observability, alerts, DLQ
