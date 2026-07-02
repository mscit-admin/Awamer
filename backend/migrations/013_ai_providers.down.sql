-- Revert 013 — AI provider management.
UPDATE roles SET permissions = array_remove(permissions, 'ai:manage'), updated_at = NOW()
 WHERE key IN ('super_admin','admin');
UPDATE roles SET permissions = array_remove(permissions, 'ai:use_personal'), updated_at = NOW()
 WHERE key IN ('super_admin','admin','user');
UPDATE roles SET permissions = array_remove(permissions, 'ai:use'), updated_at = NOW()
 WHERE key IN ('super_admin','admin','user');

DROP TABLE IF EXISTS ai_providers;
