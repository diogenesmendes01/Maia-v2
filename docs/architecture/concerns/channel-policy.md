# Channel, Role, Policy

> How messages enter the system and reach the right agent. Spans `gateway`, `channels`, `roles`, `channel_policies`, and `runtime/decision/agent-selector`.

## 1. The invariant

**A message is delivered to exactly one `(tenant, agent, role)` triple, and that triple is decided by owner-defined policy — not by the LLM, the gateway, or the agent itself.** If policy is missing or ambiguous, the message is rejected; the system does not guess.

Concretely:

- The **channel** is the surface (`whatsapp`, future others).
- The **agent** is selected by `channel_policy` for that channel + tenant.
- The **role** the agent adopts for the turn is selected by `role-selector` (LLM suggests, policy decides).
- All three are persistent attributes of the conversation, not per-turn improvisation.

## 2. Why it matters

In a multi-agent platform, "which agent answers" is the most consequential routing decision the system makes. If it's wrong, a user thinks they're talking to their finance assistant but reaches their customer-service agent — and every audit row, every memory, every learned skill from that turn is attributed to the wrong identity.

Channel/role/policy is also where the platform becomes **multi-channel by design without yet being multi-channel in production**. The schema and resolver chain are channel-agnostic; adding a second channel (SMS, Telegram, web chat) is wiring a gateway adapter, not refactoring the cognitive stack.

## 3. Where it lives in code

### Gateway (`src/gateway/`)

| File | Role |
|---|---|
| `src/gateway/baileys.ts` | WhatsApp ingress / egress via Baileys; pairing, reconnect, session state |
| `src/gateway/channel-resolver.ts` | Resolves `(channel_id, agent_id, role)` from inbound metadata. Fails loud on unresolved channel. |
| `src/gateway/rate-limit.ts` | Per-channel rate-limit (Redis, tenant-prefixed keys) |
| `src/gateway/dedup.ts` | Inbound message dedup (Redis, tenant-keyed) |
| `src/gateway/debouncer.ts` | Phone-keyed debounce window with tenant prefix |
| `src/gateway/bot-detection.ts` | Heuristic bot detection (Redis, tenant-keyed) |
| `src/gateway/queue.ts` | Inbound queue producer (BullMQ) |
| `src/gateway/presence.ts` | Presence / typing indicator handling |
| `src/gateway/types.ts` | Shared gateway types |

### Channel/role/policy (schema + runtime)

| File | Role |
|---|---|
| `migrations/*p6*` | Schema for `channels`, `channel_policies`, `roles` |
| `src/runtime/decision/agent-selector.ts` | Selects agent for the turn (current: no-op returning policy's `default_agent_id`; `MULTI_AGENT_SELECTOR_V2` flag reserved for dynamic selection) |
| `src/cognition/role-selector/engine.ts` | Role selection entry — LLM suggests, policy decides |
| `src/cognition/role-selector/llm-suggester.ts` | LLM suggestion phase |
| `src/cognition/role-selector/deterministic-classifier.ts` | Deterministic scoring of the suggestion |
| `src/cognition/role-selector/policy-decider.ts` | Policy gate over the suggestion |
| `src/cognition/role-selector/oscillation-tracker.ts` | Anti-oscillation: rejects rapid role switches in `by_context` mode |
| `src/control-plane/policy/policy-rules-repo.ts` | Persistent storage of policy rules |
| `src/control-plane/policy/policy-cache.ts` | In-process policy cache with per-tenant Redis pubsub invalidation |
| `src/control-plane/policy/policy-descriptor-resolver.ts` | String descriptor → active policy ID resolution |

### Identity (post-channel, pre-cognition)

| File | Role |
|---|---|
| `src/identity/resolver.ts` | Resolves `pessoa_id` from the channel-side handle (e.g., WhatsApp JID) |
| `src/identity/quarantine.ts` | Quarantines new/unknown identities until governance approves |
| `src/identity/voice-modifier.ts` | Adjusts voice/tone per resolved interlocutor |
| `src/identity/proposal-generator.ts` | Generates identity proposals (e.g., role membership) for owner approval |
| `src/identity/profile-renderer.ts` | Renders the operational profile slice for context packet |

## 4. Patterns

### 4.1 Channel ingest → dedup/debounce/rate-limit → identity → cognitive graph

The inbound pipeline (`src/gateway/baileys.ts` → `src/gateway/dedup.ts` → `src/gateway/debouncer.ts` → `src/gateway/rate-limit.ts` → `src/gateway/queue.ts` → worker → `src/identity/resolver.ts` → cognitive graph) is the same shape regardless of channel. Each step has a single responsibility and a single Redis key prefix (tenant-scoped — see [`tenant-isolation.md`](tenant-isolation.md)).

### 4.2 Policy is a string descriptor, resolved to active policy at use

`policy-descriptor-resolver.ts` maps string descriptors (e.g., `"finance_role_policy"`) to active policy IDs. This lets call sites carry stable string names while the underlying policy versions can roll forward. Combined with per-tenant pubsub invalidation in `policy-cache.ts`, a policy change propagates to in-flight workers without restart.

### 4.3 Role selection: LLM suggests, policy decides, oscillation tracker guards

The role selector chain:

```
inbound turn
  → llm-suggester      (LLM proposes a role)
  → deterministic-classifier   (scores the suggestion against deterministic rules)
  → policy-decider     (policy accepts/rejects)
  → oscillation-tracker  (in by_context mode, rejects rapid switches)
  → result: final role (or fallback to previous role)
```

The LLM never declares the final role. If policy says no, the turn proceeds in the previously-active role.

### 4.4 Fail-loud on unresolved channel, no fallback to default

`channel-resolver.ts` rejects messages where `(channel_id, tenant_id)` cannot be resolved to an active `channel_policy`. There is no "default channel" fallback in production — the literal `'default'` is only valid at bootstrap (see [`tenant-isolation.md`](tenant-isolation.md) §4.4). Channels not in the policy table are not served.

### 4.5 Single agent per channel today; multi via `MULTI_AGENT_SELECTOR_V2`

The current runtime is single-agent: `agent-selector.ts` returns `channel_policy.default_agent_id` and does not yet route based on turn content. The `MULTI_AGENT_SELECTOR_V2` feature flag is reserved for dynamic selection (e.g., the LLM proposes which sibling agent to hand off to, policy decides).

## 5. Anti-patterns

| Pattern | Why it's wrong |
|---|---|
| Reading channel state from `gateway/` outside `channel-resolver.ts` | Channel resolution is centralized; bypassing it skips policy gates. |
| Hard-coded `agent_id` in a worker | Tomorrow there are N agents per tenant; hardcoded paths leak across them. Resolve via `channel_policy`. |
| Role decided inside the agent's prompt | The agent does not pick its own role. The role-selector chain does. |
| Inbound message accepted without rate-limit / dedup / debounce | These three are non-negotiable for any new channel. Reusing the gateway pipeline is the only supported path. |
| Adding a new channel by extending `baileys.ts` | New channel = new file under `src/gateway/`. `baileys.ts` is WhatsApp-specific. |
| Direct write to `channel_policies` from runtime code | Channel/role/policy state is owner-controlled (via admin-ui). Runtime reads; doesn't write. |

## 6. Tests

| Test path | What it proves |
|---|---|
| `tests/unit/gateway/channel-resolver-fail-loud.spec.ts` (or similar) | Resolver rejects unresolved channels |
| `tests/unit/gateway/rate-limit-tenant-scope.spec.ts` | Rate-limit keys carry tenant |
| `tests/unit/gateway/dedup-tenant-scope.spec.ts` | Dedup keys carry tenant |
| `tests/unit/gateway/debouncer-tenant-scope.spec.ts` | Debounce keys carry tenant |
| `tests/unit/role-selector/` | Role selector chain: suggester / classifier / decider / oscillation |
| `tests/unit/identity/resolver.spec.ts` | Identity resolution |
| `tests/integration/p6-channel-role-policy.spec.ts` (if present) | End-to-end channel/role/policy routing |

## 7. Known gaps

Re-verify at read time.

To find current gaps:

```bash
gh pr list --state open --search "channel OR role OR policy OR gateway"
```

At last verification:

- Multi-channel architecture is in schema; gateways beyond WhatsApp not implemented
- Multi-agent runtime selector is gated by `MULTI_AGENT_SELECTOR_V2`; the active runtime is single-agent-per-channel via policy
- Admin UI provisioning of new tenants still being iterated

See `README.md` § Estado atual for runtime feature-flag state.

## 8. In-flight changes

At last verification (2026-05-28):

- Channel-resolver fail-loud on unresolved channel, drop `default/default` fallback (#268 → #277 — open)
- Policy pubsub per-tenant channel (#249 → #264 — open)
- Gateway debouncer tenant scope (#248 → #259 — open)
- Gateway rate-limit Redis key prefix (#245 → #258 — open)
- Gateway dedup tenant scope (#247 → #253 — open)
- Gateway bot-detection tenant prefix (#246 → #252 — open)
- Tenant-context whitespace validation (#283 → #293 — open)
- Default-resolver fixture-only + reject `'default'` literal in ALS (#282 → #296 — open)
- Decision-engine F1 Phase 0/1 — engine coexistence + selector intent matching (merged)

Verify with `gh pr list --state open --search "channel OR role OR policy OR gateway"`.

## 9. Key decisions

- **Channel resolution is centralized in `channel-resolver.ts`** — every inbound message goes through it. No side-door.
- **Fail-loud on unresolved channel** — no `'default'` fallback in production paths.
- **Role-selector chain over single-step decision** — LLM suggests, deterministic classifier scores, policy decides, oscillation tracker guards. Each link has a narrow contract.
- **Policy via string descriptor + per-tenant pubsub invalidation** — allows policy versions to roll forward without rewriting call sites.
- **`MULTI_AGENT_SELECTOR_V2` as the gate for dynamic agent selection** — current runtime is single-agent-per-channel via policy. Dynamic selection lives behind a flag until validated.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
| Re-verify when | Older than 30 days; OR a new channel adapter lands in `src/gateway/`; OR `MULTI_AGENT_SELECTOR_V2` flips on; OR the role-selector chain in `src/cognition/role-selector/` changes its links |
