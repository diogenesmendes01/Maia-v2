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
| `src/gateway/types.ts` | Shared gateway types |

## Patterns it follows

- [Channel/role/policy](../concerns/channel-policy.md) — channel-resolver is the single entry; failure-loud
- [Tenant isolation](../concerns/tenant-isolation.md) — every Redis key (rate-limit, dedup, debounce, bot-detect) carries `tenant_id + agent_id`

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
