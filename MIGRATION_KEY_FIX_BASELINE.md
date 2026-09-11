# AWM-MIG-002 — Migration Role-Key Length Compatibility — Baseline

**Branch:** `claude/nifty-johnson-u2dwye` · **Head at baseline:** `4b923a9`
**Finding:** P2 — migration `024_fix_cross_tenant_roles` generates cloned custom
role keys that can exceed the API's `max(48)` role-key limit. The DB accepts them
(`roles.key` is `TEXT`, no length limit), but the admin / org / roles REST APIs
reject any role key longer than 48 characters, so a migrated user can hold a role
that admins can no longer re-assign or manage through the API.

## Evidence

### 1. The defect — `backend/migrations/024_fix_cross_tenant_roles.up.sql:62`

```sql
clone_key := left(rec.key, 40) || '__c' || replace(comp.cid::text, '-', '');
```

Length budget:

| Segment | Source | Max chars |
| --- | --- | --- |
| `left(rec.key, 40)` | up to 40 of the source key | 40 |
| `'__c'` | literal | 3 |
| `replace(comp.cid::text, '-', '')` | company UUID, dashes stripped | 32 |
| **Total** | | **75** |

A cloned key is therefore up to **75 chars** — 27 over the API limit.

### 2. The API ceiling is 48 (three call sites, all `max(48)`)

- `backend/src/routes/organization.ts:179` —
  `PUT /users/:id/assignment` body: `role: z.string().min(1).max(48).optional()`.
- `backend/src/routes/admin.ts:92` — create user: `role: z.string().min(1).max(48)`.
- `backend/src/routes/admin.ts:154` — patch user: `role: z.string().min(1).max(48).optional()`.
- `backend/src/routes/roles.ts:37` — `slugify(...).slice(0, 48)`; create/update role
  `name: z.string().min(2).max(48)`. (API-created role keys are already ≤48.)

So any custom role key `> 48` chars can only originate from migration `024`, and
once a user holds it, every API path that names the role key (re-assign, org move,
admin patch/create) fails validation with `400 validation_failed`.

### 3. `roles.key` DB constraints — `007_custom_roles.up.sql:12`

```sql
key TEXT NOT NULL UNIQUE
```

No length limit → the DB silently accepts the 75-char key. The only referencing
FK is `users.role` (`007_custom_roles.up.sql:37`):

```sql
ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(key) ON UPDATE CASCADE;
```

`ON UPDATE CASCADE` means renaming a role's `key` automatically rewrites every
`users.role` that referenced it — so a corrective rename is safe and needs no
manual user reassignment. A repo-wide grep confirms **no other** table references
`roles.key`.

### 4. Built-in role keys are all short (unaffected)

`super_admin` (11), `admin` (5), `user` (4), `readonly` (8), `auditor` (7) — none
approach 48, and built-ins are never cloned by `024` (it filters
`is_builtin = FALSE`). Only custom cloned roles can be over-length.

## Immutability decision

Migration `024` is already **shipped** (committed at `59adeca`, and applied in the
production environment during deploy). Per project rule *"never edit a shipped
migration; add a new `NNN_*` pair"*, `024` is treated as **immutable**. The fix is
therefore a **new migration `025`** that repairs any over-length custom-role key,
which corrects all three cases with one artifact:

- **Fresh install:** `024` briefly creates 75-char keys → `025` shortens them (no
  API is serving during migration, so the transient state is never observable).
- **Environment that already ran `024`:** `025` shortens the existing long keys.
- **Environment that runs both now:** `024` then `025` in sequence → clean keys.

## Fix design (deterministic, collision-resistant, ≤48)

```
new_key := left(key, 34) || '__' || substr(md5(key), 1, 12)
```

| Segment | Chars |
| --- | --- |
| `left(key, 34)` (always exactly 34 for a key >48) | 34 |
| `'__'` | 2 |
| `substr(md5(key), 1, 12)` (12 hex nibbles = 48 bits) | 12 |
| **Total** | **48** |

- **Deterministic:** pure function of the old key.
- **Collision-resistant:** `md5()` is a PostgreSQL built-in (no extension); the old
  key is `UNIQUE`, so hash inputs are distinct; a clash needs a 48-bit md5 prefix
  collision between two roles (≈ N²/2⁴⁹ — negligible). `025` additionally
  **RAISES** if a generated key would collide with a different existing role,
  matching `024`'s fail-fast philosophy rather than shipping a broken state.
- **Preserves everything:** only the `key` column is rewritten; `name`,
  `description`, `permissions`, `company_id`, `is_builtin` stay on the same row, and
  `users.role` follows via `ON UPDATE CASCADE`.
- **Idempotent:** re-running finds no key `> 48` → no-op.
- **Permanent guard:** after repair, `025` adds
  `CHECK (char_length(key) <= 48)` on `roles`, aligning the DB with the API ceiling
  (all built-in and API-slugified keys already satisfy it).

## Baseline test state (carried from prior cycle, to be re-verified)

```
Backend unit:         Passed 81   Failed 0   Skipped 0
Backend integration:  Passed 49   Failed 0   Skipped 0   (real PostgreSQL)
Frontend (vitest):    Passed 16   Failed 0   Skipped 0
DB invariants:        custom-role/company mismatch = 0; org-unit/company = 0
```

New this cycle (planned): `repos/roleKeyLength.itest.ts` (MIG-KEY-001..010),
migration `025_shorten_role_keys.{up,down}.sql`.
