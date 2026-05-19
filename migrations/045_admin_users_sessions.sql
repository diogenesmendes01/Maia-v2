-- 045: app_users + app_sessions for NextAuth (P8.5 Admin UI)
-- Note: P0 may already provide users/sessions tables; verify before applying.
-- These tables specifically support the admin-ui authentication flow.

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('founder', 'compliance_officer', 'owner', 'analyst', 'viewer')),
  email_verified TIMESTAMPTZ,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS app_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL UNIQUE,
  expires TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_sessions_user_id_idx ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expires_idx ON app_sessions(expires);
CREATE INDEX IF NOT EXISTS app_users_tenant_idx ON app_users(tenant_id);
