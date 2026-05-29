-- Drop the legacy `dashboard_sessions` table.
--
-- `dashboard_sessions` backed a Fastify-served `/dashboard` flow (the page
-- in `src/dashboard/index.ts`) that documented a "send 'login dashboard'
-- on WhatsApp to get a magic link" UX but whose WhatsApp-side handler was
-- never wired. The admin-ui (`src/admin-ui/`, Next.js + NextAuth) is the
-- canonical web UI now — sign-in lives in `app_users` + `app_sessions`
-- (migration 045) and the routes are reached at `admin.${DOMAIN}` (Coolify
-- subdomain split).
--
-- Drop semantics:
--   * `IF EXISTS` so re-running the migration on a partially-rolled-back
--     environment is a no-op.
--   * `CASCADE` is NOT used — no other migration references
--     dashboard_sessions, no FK depends on it, and an unexpected dependency
--     should fail loudly rather than be silently dropped.
--
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

DROP TABLE IF EXISTS dashboard_sessions;
