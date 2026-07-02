-- Revert 012 — organizational structure & multi-company foundation.
UPDATE roles
   SET permissions = array_remove(permissions, 'org:manage'), updated_at = NOW()
 WHERE key IN ('super_admin', 'admin');
UPDATE roles
   SET permissions = array_remove(permissions, 'companies:manage'), updated_at = NOW()
 WHERE key = 'super_admin';

ALTER TABLE users DROP COLUMN IF EXISTS org_unit_id;
ALTER TABLE users DROP COLUMN IF EXISTS company_id;

DROP TABLE IF EXISTS org_units;
DROP TABLE IF EXISTS companies;
