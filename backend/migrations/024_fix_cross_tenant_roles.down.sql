-- No-op rollback. This migration repairs authorization DATA (splitting a
-- cross-tenant custom role into per-company roles and reassigning users). That
-- repair is not safely reversible — dropping the per-company clones would
-- re-orphan users onto a role owned by another tenant, re-introducing the very
-- P1 defect. Rolling back is therefore intentionally a no-op; restore from a
-- backup if a full revert is ever required.
SELECT 1;
