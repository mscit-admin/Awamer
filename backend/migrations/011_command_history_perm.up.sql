-- =====================================================================
-- 011 — Add the command_history:read permission to built-in roles
-- =====================================================================
-- Command history now has its own RBAC permission. Grant it to the built-in
-- roles that previously accessed it via sessions:connect (admins + user).

UPDATE roles
   SET permissions = array_append(permissions, 'command_history:read'),
       updated_at = NOW()
 WHERE key IN ('super_admin', 'admin', 'user')
   AND NOT ('command_history:read' = ANY(permissions));
