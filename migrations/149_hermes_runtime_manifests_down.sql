BEGIN;
LOCK TABLE hermes_runtime_manifests IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM hermes_runtime_manifests) THEN
    RAISE EXCEPTION 'refusing to discard persisted manifest evidence';
  END IF;
END $$;
DROP TABLE hermes_runtime_manifests;
DROP FUNCTION hermes_runtime_manifest_immutable();
COMMIT;
