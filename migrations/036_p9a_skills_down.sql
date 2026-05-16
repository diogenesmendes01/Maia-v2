-- Down de 036: drop integral.

DROP INDEX IF EXISTS idx_skills_proposed;
DROP INDEX IF EXISTS idx_skills_one_active_uq;
DROP INDEX IF EXISTS idx_skills_version_uq;
DROP INDEX IF EXISTS idx_skills_tenant_category_active;
DROP INDEX IF EXISTS idx_skills_tenant_active;
DROP TABLE IF EXISTS skills CASCADE;
