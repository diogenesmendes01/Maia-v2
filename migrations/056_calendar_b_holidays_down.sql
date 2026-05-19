BEGIN;
DROP TRIGGER IF EXISTS set_holidays_timestamp ON holidays;
DROP FUNCTION IF EXISTS trg_set_holidays_timestamp();
DROP INDEX IF EXISTS idx_holidays_pending;
DROP INDEX IF EXISTS idx_holidays_tenant_regional;
DROP INDEX IF EXISTS idx_holidays_tenant_date;
DROP TABLE IF EXISTS holidays;
COMMIT;
