-- _down.sql files are NOT auto-wrapped in transactions. Wrap explicitly.
BEGIN;
ALTER TABLE entidades DROP COLUMN IF EXISTS cidade;
ALTER TABLE entidades DROP COLUMN IF EXISTS uf;
COMMIT;
