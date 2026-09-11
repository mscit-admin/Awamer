-- No-op rollback. This migration only RE-ASSERTS columns whose lifecycle is
-- owned by 020_tenant_scope_shared; rolling 023 back must NOT drop
-- hosts.company_id / notes.company_id (that is 020's down migration's job).
SELECT 1;
