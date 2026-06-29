UPDATE roles
   SET permissions = array_remove(permissions, 'command_history:read'),
       updated_at = NOW()
 WHERE key IN ('super_admin', 'admin', 'user');
