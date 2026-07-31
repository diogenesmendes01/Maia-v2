# gateway

**Path:** `src/gateway/`

**Purpose** — Inbound + outbound channel adapter. Today, WhatsApp via Baileys. Handles connection lifecycle (pairing, reconnect, session restore), inbound message dedup / debounce / rate-limit / bot-detection, and outbound dispatch with presence indicators. The channel-resolver maps inbound metadata to `(tenant, agent, role)`; resolution fails loud on missing or `'default'` literals. New channels (SMS, Telegram, web chat) are sibling files, not extensions of `baileys.ts`.

## Key files

| File | Role |
|---|---|
| `src/gateway/baileys.ts` | WhatsApp connection lifecycle + in/out via Baileys |
| `src/gateway/jid-tenant-resolver.ts` | Parses the inbound WhatsApp JID (`@s.whatsapp.net`/`@c.us`/`@lid`) → E.164 phone, then delegates to `channel-resolver`. `@lid` recovery order: `senderPn`/`participantPn` key hints → injected LID→PN mapping-store lookup → fail-closed `lid_unmapped` (dropped, audited as `channel_resolution_skipped_lid_unmapped`, distinct from a real `channel_resolution_failed`) |
| `src/gateway/channel-resolver.ts` | Resolves `(channel_id, agent_id, role)` from inbound metadata; fails loud |
| `src/gateway/rate-limit.ts` | Per-channel rate-limit (Redis, tenant-prefixed keys) |
| `src/gateway/dedup.ts` | Inbound message dedup (Redis, tenant-keyed) |
| `src/gateway/debouncer.ts` | Phone-keyed debounce window with tenant prefix |
| `src/gateway/bot-detection.ts` | Heuristic bot detection (Redis, tenant-keyed) |
| `src/gateway/presence.ts` | Presence / typing indicator handling |
| `src/gateway/queue.ts` | BullMQ inbound queue producer |
| `src/gateway/line-sessions.ts` | Per-line Baileys sessions (multi-line routing phase 3) + **exclusive line ownership**: `acquireSessionLease` before opening a socket, `heartbeatLineOwnership()` fail-closed after |
| `src/gateway/line-session-manager.ts` | `LineTransport` registry — the seam between "which line" and "which socket" |
| `src/gateway/types.ts` | Shared gateway types |

### Exclusive line ownership (issue #513 §6, migration 115)

A line's socket lives in ONE process. Before #513 that was an assumption; now
it is enforced:

1. **Acquire before opening.** `startLineSession()` calls
   `acquireSessionLease()` and returns early unless it is granted. Granted when
   the line is unowned, its lease expired, or this instance already owns it.
2. **Fail-closed three ways.** Lease held by a live owner ⇒ do not open. DB
   error ⇒ do not open (ambiguous ownership is denied ownership). Heartbeat CAS
   failure ⇒ close the socket immediately.
3. **Fencing token.** Monotonic per channel, incremented on every acquisition
   by a different owner, never on renewal and never reset on release. It is what
   distinguishes "still the owner" from "lost it and re-took it" — comparing
   `session_owner_instance` alone misses the case where the SAME instance
   re-acquires after a long pause.
4. **DB clock.** Expiry is always evaluated with Postgres `now()`, never the
   process clock.

Why closing (rather than merely flagging) is the only defence: WhatsApp does
not know about fencing tokens, so there is no server-side rejection of a stale
owner's send. Checking the token *after* sending would prove nothing.

Ownership transitions are audited as `line_session_ownership_acquired`,
`_taken_over` (carries `previous_owner`) and `_lost`, under the ALS context of
the channel's own tenant/agent. The heartbeat runs inside the `channel_pairing`
cron, which #513 schedules only in the role that owns `whatsapp_session`.

Outbound still travels through the in-process `LineTransport`; making that a
durable boundary is issue #506.

## Patterns it follows

- [Channel/role/policy](../concerns/channel-policy.md) — channel-resolver is the single entry; failure-loud
- [Tenant isolation](../concerns/tenant-isolation.md) — every Redis key (rate-limit, dedup, debounce, bot-detect) carries `tenant_id + agent_id`

### Ingresso e o turno durável (issue #503)

O ingresso persiste a mensagem **antes** de enfileirar — sempre foi a ordem
correta, e agora ela também é diagnosticável. Com
`FEATURE_TURN_STATE_MACHINE` ligada, `mensagensRepo.createInbound(..., { withTurn: true })`
grava a mensagem e o turno `received` na **mesma transação PostgreSQL**; só
depois de o wake-up (BullMQ direto ou debouncer) ser confirmado o turno vai para
`queued`.

Commit atômico entre PostgreSQL e Redis é impossível, então o contrato é:

1. Postgres grava `received`.
2. O código tenta armar o job.
3. Enqueue confirmado ⇒ `received → queued`.
4. Processo morre em qualquer janela ⇒ o recovery reencontra `received`.
5. jobId determinístico (#504) garante que rearmar não duplica execução.

Uma duplicata (dedup por `whatsapp_id`) nunca chega a abrir a transação, logo
nunca cria turno órfão. Falha de enqueue **não** vira `retryable`: não houve
tentativa de execução, o turno fica em `received` para o sweep. Ver
[`runtime.md`](runtime.md) e [`docs/runbooks/turn-state-machine.md`](../../runbooks/turn-state-machine.md).

## How to extend

| Need | Where |
|---|---|
| Add a new channel adapter | New file under `src/gateway/<channel>.ts`; same lifecycle shape as `baileys.ts`; queue producer pushes to the shared inbound queue |
| Add a new gateway guard | New file under `src/gateway/`; same Redis key prefix convention; wire into the pipeline before queue insertion |
| Change rate-limit policy | Edit `rate-limit.ts`; keep tenant prefix; respect feature flags |

## Public surface

| Consumed by | What |
|---|---|
| `src/workers/` | Workers consume from the inbound queue and invoke `agent/core.ts` |
| `src/agent/output-dispatch.ts` | Dispatch outbound back through the channel adapter |
| `src/identity/resolver.ts` | Reads channel-side handle from gateway-emitted message |

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/gateway/rate-limit-tenant-scope.spec.ts` | Tenant-prefixed rate-limit keys |
| `tests/unit/gateway/dedup-tenant-scope.spec.ts` | Tenant-keyed dedup |
| `tests/unit/gateway/debouncer-tenant-scope.spec.ts` | Tenant-keyed debounce |
| `tests/unit/gateway/channel-resolver-fail-loud.spec.ts` (or similar) | Resolver rejects unresolved channels |
| `tests/integration/gateway/` | Baileys lifecycle |

## In-flight changes

At last verification (2026-05-28):

- Channel-resolver fail-loud on unresolved channel (#268 → #277 — open)
- Gateway debouncer tenant scope (#248 → #259 — open)
- Gateway rate-limit Redis key prefix (#245 → #258 — open)
- Gateway dedup tenant scope (#247 → #253 — open)
- Gateway bot-detection tenant prefix (#246 → #252 — open)

Verify: `gh pr list --state open --search "gateway OR baileys OR rate-limit OR dedup OR debouncer"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
