-- Reverse of 062_global_settings.sql.
--
-- Safe to drop: no other table FKs into global_settings, and the only
-- caller (llmSettingsRouter + getCurrent*Model fallback) tolerates the
-- table being absent — getByKey returns null on error and the env-var
-- default takes over.
DROP TABLE IF EXISTS global_settings;
