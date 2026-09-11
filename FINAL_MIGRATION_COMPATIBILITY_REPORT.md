# Awamer — Final Migration Role-Key Compatibility Gate Report (AWM-MIG-002)

**Branch:** `claude/nifty-johnson-u2dwye`
**Scope:** AWM-MIG-002 — migrated custom-role keys can exceed the API's `max(48)`
ceiling. Fix the key generation to a deterministic, collision-resistant ≤48-char
form; add a corrective migration to repair already-migrated environments; add
MIG-KEY tests; re-run the full RBAC / migration / security regression.
**Verification:** all backend suites executed against a **real migrated
PostgreSQL 16** (dedicated fresh DBs for the migration tests); frontend built +
tested; DB invariants executed on the migrated database.

## Gate dashboard

| Gate | Result |
| --- | --- |
| Role-key length ≤ 48 after migration | **PASS** (0 keys > 48) |
| Deterministic key generation | **PASS** (MIG-KEY-006) |
| Collision resistance (same-prefix clones stay distinct) | **PASS** (MIG-KEY-007) |
| Permissions / name / tenant preserved across rename | **PASS** (MIG-KEY-008) |
| User assignments follow (ON UPDATE CASCADE, no orphans) | **PASS** (MIG-KEY-006/010) |
| Short keys (1/13/14/47/48) untouched | **PASS** (MIG-KEY-001..005) |
| DB ceiling constraint present + enforced | **PASS** (MIG-KEY-009) |
| Migration idempotent | **PASS** (MIG-KEY-009) |
| Generated key accepted by real org-assignment API | **PASS** (MIG-KEY-010) |
| Cross-tenant custom-role invariant | **PASS** (0 rows) |
| Historical role migration (024) | **PASS** (MIG-RBAC-001..006) |
| User company-move role integrity | **PASS** (MOVE-RBAC-001..008) |
| Role permission ceiling / `companies:manage` | **PASS** (RBAC-001..008) |
| Tenant isolation + explicit sharing | **PASS** (tenantIsolation, tenantShares, SHARE) |
| Logout revocation / WebSocket auth / browser refresh | **PASS** (LOGOUT, WS, BROWSER-AUTH) |
| Legacy refresh-token cleanup | **PASS** (BROWSER-LEGACY-001) |
| Backend build (tsc) | **PASS** |
| Frontend build (vite) | **PASS** |
| Unit tests | **PASS** (81) |
| Integration tests | **PASS** (55, deterministic ×6) |
| Frontend tests | **PASS** (16) |

## Actual test counts (re-run, not carried over)

```
Backend unit:         Passed 81   Failed 0   Skipped 0
Backend integration:  Passed 55   Failed 0   Skipped 0   (real PostgreSQL, 6 consecutive green runs)
Frontend (vitest):    Passed 16   Failed 0   Skipped 0
```
New this cycle: `repos/roleKeyLength.itest.ts` (MIG-KEY-001..010, 6 test groups).

## The finding — AWM-MIG-002 (P2) — FIXED

- **Defect:** `backend/migrations/024_fix_cross_tenant_roles.up.sql:62`
  ```sql
  clone_key := left(rec.key, 40) || '__c' || replace(comp.cid::text, '-', '');
  ```
  produces keys up to `40 + 3 + 32 = 75` chars. The role-key inputs at
  `routes/organization.ts:179`, `routes/admin.ts:92,154` and the slug in
  `routes/roles.ts:37` all cap at **48**. `roles.key` is `TEXT UNIQUE` (no length
  bound — `007_custom_roles.up.sql:12`), so the DB stored the over-length key but
  the API rejected any later re-assignment/management of a user holding it.
- **Immutability:** `024` is shipped (committed `59adeca`, applied in production).
  Per project rule it is **not edited**; the fix is a new migration.
- **Fix — `backend/migrations/025_shorten_role_keys.{up,down}.sql`:**
  - Rewrites every custom-role key with `char_length(key) > 48` to
    `left(key,34) || '__' || substr(md5(key),1,12)` (exactly 48 chars).
  - Deterministic (pure function of the key) and collision-resistant (`md5()` is
    a PG built-in; the source key is `UNIQUE`; a clash needs a 48-bit md5-prefix
    collision). **RAISES** if a generated key would collide with a different
    existing role — fail-fast rather than ship a broken authorization state,
    matching `024`.
  - Preserves `name`, `description`, `permissions`, `company_id`, `is_builtin`;
    `users.role` follows via the `users_role_fkey ON UPDATE CASCADE` (the only FK
    referencing `roles.key`). Built-in keys are all short and untouched.
  - Idempotent (a re-run finds no key > 48). After repair, adds
    `CHECK (char_length(key) <= 48)` (guarded) so the DB permanently matches the
    API ceiling.
  - `.down.sql` drops only the CHECK (the renames are not losslessly reversible;
    restoring 75-char keys would re-break the API — restore from backup for a
    full revert).
  - Fixes all three cases with one artifact: fresh install (024 makes long keys →
    025 shortens, no API serving between migrations); already-024'd environment
    (025 shortens existing); runs-both-now (024 then 025 in order).
- **Regression test:** `repos/roleKeyLength.itest.ts` (MIG-KEY-001..010).
- **Test command:** `DATABASE_URL=… npx tsx --test src/repos/roleKeyLength.itest.ts`
- **Result:** 6/6 groups PASS.

## §30 — keyring doc-comment corrected (documentation only)

`desktop/src/shared/lib/keyring.ts` header comment updated: browser refresh token
lives in an **HttpOnly cookie**, not localStorage; the legacy
`netsphere.refresh_token` entry is purged at startup (SEC-019A); the wrapper is
used in the browser only for non-refresh per-tab conveniences. **No auth behaviour
changed** — `cleanupLegacyBrowserAuth`, `secure*`, and `main.tsx` are unchanged;
frontend tsc + 16 tests + build stay green.

## Database evidence (on the migrated DB)

```
custom-role/company mismatch = 0
org-unit/company mismatch     = 0
custom role keys > 48         = 0
any role keys > 48            = 0
duplicate role keys           = 0
roles_key_len_chk present     = 1
```

## Test-infra hardening (no assertion changes)

The two dedicated-DB migration tests provision fresh databases and run in
parallel under the node:test file runner, which produced an intermittent
`CREATE DATABASE` contention + idle-client `terminating connection` uncaught
error. Added `recreateDatabase` / `dropDatabaseQuiet` (retry with backoff) in
`src/test/db.ts` and pool `error` listeners in both migration itests. Confirmed
deterministic: the two migration tests green ×12 in parallel, and the full
integration suite green ×6. No assertions were weakened, skipped, or removed.

## Findings

```
P0 remaining: 0
P1 remaining: 0
P2 remaining: 0
P3 remaining: 0

Fixed:            AWM-MIG-002 (migration 025 + MIG-KEY-001..010)
Partially fixed:  none
Unresolved:       none
False positives:  none
Not verified:     none for this scope (all suites ran against real PostgreSQL 16)
```

## Preserved controls — regression-tested green

Cross-tenant custom-role split (024), user company-move role integrity (SEC-020),
permission ceiling + `companies:manage` protection, host/note tenant isolation +
explicit sharing, logout revocation + logout-all, WebSocket channel auth (no
secret in any WS URL), browser HttpOnly refresh cookie, legacy token cleanup,
PostgreSQL readiness, SSH host-key verification — all covered by the 81 unit + 55
integration suite that passes in full.

---

## Decision

# APPROVED FOR PRODUCTION

**P0 = 0, P1 = 0, P2 = 0.** AWM-MIG-002 is fixed by immutable-safe migration `025`:
every custom-role key is now ≤ 48 chars (DB evidence: 0 keys > 48, constraint
present), the transform is deterministic and collision-resistant, and every
migrated key is accepted by the real org-assignment API (MIG-KEY-010). All prior
RBAC, tenant-isolation, session, and browser controls remain green, the
cross-tenant invariant is 0, and **no mandatory test is skipped, not-verified, or
failing** — all ran against a real PostgreSQL 16.
