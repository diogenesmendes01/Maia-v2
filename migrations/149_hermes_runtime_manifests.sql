-- Immutable per-run manifests. Synthetic evidence is NEVER release approval.
BEGIN;
CREATE TABLE hermes_runtime_manifests (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  run_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  evidence_class text NOT NULL CHECK (evidence_class = 'synthetic'),
  manifest_json jsonb NOT NULL CHECK (octet_length(manifest_json::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id, run_id),
  UNIQUE (tenant_id, agent_id, digest),
  FOREIGN KEY (tenant_id, agent_id, run_id) REFERENCES engine_runs(tenant_id,agent_id,id) ON DELETE RESTRICT,
  CHECK (tenant_id NOT IN ('','default','system') AND agent_id NOT IN ('','default','system')),
  CHECK (manifest_json->>'schema' = 'maia-hermes-runtime-manifest/v1'),
  CHECK ((manifest_json->>'run_id')::uuid = run_id)
);
CREATE FUNCTION hermes_runtime_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hermes runtime manifests are immutable';
END;
$$;
CREATE TRIGGER hermes_runtime_manifest_immutable BEFORE UPDATE ON hermes_runtime_manifests
FOR EACH ROW EXECUTE FUNCTION hermes_runtime_manifest_immutable();
COMMIT;
