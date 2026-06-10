-- 089 — MCP externo v1 (issue #478, spec docs/superpowers/specs/2026-06-10-mcp-external-tools-design.md)
--
-- mcp_servers: conexões first-party registradas pelo owner (credencial via
-- SECRET REF — nunca o token). Os campos *_requested_at/last_* implementam a
-- ponte admin-ui→runtime (Postgres-as-queue por flags): o console pede
-- teste/sync; o worker mcp_sync executa e grava o resultado.
--
-- mcp_server_tools: estado de governança POR TOOL — fonte do "ver" no console
-- e do fail-closed: sync que detecta schema_hash diferente em tool aprovada
-- rebaixa para 'suspended' até nova aprovação. Writes (is_read_only=false)
-- são recusados no bridge na v1 mesmo se aprovados (flag de fase, spec §4).

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  url text NOT NULL,
  transport text NOT NULL DEFAULT 'streamable_http'
    CHECK (transport IN ('streamable_http')),
  -- Nome da env var no runtime que carrega o bearer (ex.: MCP_SERVER_ERP_TOKEN).
  auth_secret_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL,
  test_requested_at timestamptz,
  last_test_at timestamptz,
  last_test_result jsonb,
  sync_requested_at timestamptz,
  last_sync_at timestamptz,
  last_sync_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX mcp_servers_tenant_idx ON mcp_servers (tenant_id, status);

CREATE TABLE mcp_server_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  tool_name text NOT NULL,
  description text,
  input_schema jsonb NOT NULL DEFAULT '{}',
  schema_hash text NOT NULL,
  -- Owner declara na aprovação; v1 só executa is_read_only=true.
  is_read_only boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'approved', 'suspended', 'rejected')),
  risk_class text NOT NULL DEFAULT 'critical'
    CHECK (risk_class IN ('low', 'medium', 'high', 'critical')),
  approved_by text,
  approved_at timestamptz,
  decision_comment text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, tool_name)
);

CREATE INDEX mcp_server_tools_tenant_idx ON mcp_server_tools (tenant_id, status);
CREATE INDEX mcp_server_tools_server_idx ON mcp_server_tools (server_id, status);
