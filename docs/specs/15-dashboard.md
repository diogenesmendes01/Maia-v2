# Spec 15 — Dashboard (Stub for Phase 5)

**Status:** Phase 5 (placeholder) • **Depends on:** 00, 02, 03

---

## 1. Purpose

Reserve the design space for a **read-only web dashboard** the owner may want for visualizing data that is awkward to consume on WhatsApp (long lists, charts, long-period comparisons). Out of scope for Phases 1–4; this spec exists to prevent decisions in earlier phases from foreclosing the future implementation.

## 2. Phase 5 goals (deferred)

- Read-only access to the same data Maia exposes via WhatsApp, but with charts and tables.
- Personal use only — single user (the owner). Optional spouse access.
- Filters by entity, date range, category, contraparte.
- Audit trail viewer.
- Pending questions / workflows / alerts overview.

## 3. Phase 5 non-goals

- Editing data (owner edits via WhatsApp; the dashboard never writes).
- Public access. Always behind authentication.
- Multi-tenant. Single-tenant per main system principle.

## 4. Design principles (carved in stone now)

These are recorded **now** so that Phase 1–4 specs do not contradict them:

1. **Read-only:** the dashboard issues `SELECT` only. No mutations. No tools called.
2. **Strict scope filter:** every query passes through the same `EntityScope` resolution as the agent. The owner sees all entities; the spouse sees only those granted.
3. **Single deployment:** dashboard runs in the **same** Node process and Postgres as Maia. No separate infrastructure.
4. **Authentication:** session cookie tied to a magic-link sent over WhatsApp by Maia. No passwords. Requesting access via the dashboard sends a one-time link to the requester's WhatsApp; click → session.
5. **No new permission profiles:** existing `permission_profiles` are sufficient. Dashboard exposes data that the profile already authorizes via `acoes_permitidas` (read_*).
6. **Audit:** dashboard sessions are logged in `audit_log` with `acao='dashboard_session_*'`. Dashboard reads do not flood the audit log; only session lifecycle events.

## 5. Indicative tech (subject to revision)

- **Framework:** Next.js (App Router). Mounted under `/dashboard` of the same Fastify server, or as a sibling under reverse-proxy.
- **DB access:** the same Drizzle repositories as the agent, scoped via the resolved session pessoa.
- **Charts:** lightweight (e.g., `Recharts`) or HTML+CSS only.
- **Style:** dense, utilitarian, no pixel-pushing.

## 6. Schemas (forecasted, not built)

```sql
CREATE TABLE dashboard_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pessoa_id       UUID NOT NULL REFERENCES pessoas(id),
  token_hash      TEXT NOT NULL,
  expira_em       TIMESTAMPTZ NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_dashboard_sessions_active
  ON dashboard_sessions (pessoa_id) WHERE revoked_at IS NULL AND expira_em > now();
```

## 7. Authentication flow (forecasted)

```
[1] Owner navigates to https://maia.example.com/dashboard
[2] Page asks: "Manda 'login dashboard' pra Maia"
[3] Owner messages "login dashboard" to Maia
[4] Maia generates token, persists hash with TTL 5min, sends magic link
[5] Owner clicks link → backend verifies token, marks used_at, sets cookie (TTL 8h)
[6] Subsequent requests carry cookie; dashboard renders
```

Spouse can use the same flow if `co_dono`. No other access in Phase 5 v1.

## 8. LLM Boundaries

The LLM is not involved in the dashboard. Period. Dashboard backend is pure Drizzle queries.

## 9. Acceptance criteria for Phase 5 (when work begins)

- [ ] Owner can log in via magic link in < 60 seconds end-to-end.
- [ ] Dashboard never writes to any business table.
- [ ] Spouse session sees only her allowed entities.
- [ ] Session revocation via Maia command "Maia, encerra sessão dashboard" works in < 5 seconds.
- [ ] Dashboard uses the same connection pool — no extra Postgres credentials.

## 10. Open questions (Phase 5)

- Hosting: same VPS or dedicated subdomain? Likely same.
- TLS: Caddy / Cloudflare tunnel / direct LE? Decide at Phase 5 start.
- Mobile-friendly view? Probably yes.

## 11. References

- Spec 02 — read-only DB queries via repositories
- Spec 03 — permission profiles already cover dashboard reads
- Spec 09 — audit on session lifecycle
