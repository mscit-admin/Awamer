# Phase 2 Report — Authorization & Tenant Isolation

**Branch:** `claude/nifty-johnson-u2dwye`
**Addresses:** SEC-003 (P0) + systematic IDOR/BOLA sweep
**Verification DB:** real PostgreSQL 16 (migrated), all suites run against it.

---

## AWM-SEC-003 — Cross-company access to shared resources

- **Severity:** P0 · **Status:** FIXED (verified end-to-end)
- **Affected components:** hosts, notes (the only resources with an
  installation-wide `is_shared` flag).
- **Affected files:** `backend/migrations/020_tenant_scope_shared.{up,down}.sql`,
  `backend/src/repos/sessionRepos.ts`, `backend/src/repos/notesRepo.ts`,
  `backend/src/repos/backupRepo.ts`, `backend/src/repos/userRepo.ts`.
- **Root cause:** `hosts`/`notes` predate the multi-company model (migration
  012) and carry no `company_id`. Their visibility predicate was
  `user_id = $1 OR is_shared = TRUE OR <explicit share>` — the `is_shared`
  branch had no tenant scope, so a resource shared by Company A was visible to
  every user on the installation. Because a shared host resolves the **owner's**
  linked credential server-side, a Company B user could open SSH/SFTP/VNC/Telnet
  sessions against Company A's servers with Company A's secrets.
- **Fix implemented:**
  1. **Migration 020** adds `company_id` (FK → `companies`, `ON DELETE SET
     NULL`) to `hosts` and `notes`, backfills it from each row's owner
     (`users.company_id`), and adds a partial index on shared rows. Idempotent
     (`IF NOT EXISTS`), rollback-safe (`020…down.sql`), lock/statement timeouts
     like migration 012.
  2. **Scoped every shared-visibility query** so the `is_shared` branch requires
     `company_id = (SELECT company_id FROM users WHERE id = <viewer>)`:
     `HostRepository.list` / `getById` / `touch`, `NotesRepository.list`. The
     predicate **fails closed** — a NULL viewer/resource company never matches.
     Private (`user_id`) and explicit-share (`host_shares`/`note_shares`) paths
     are unchanged; explicit shares are already company-bounded because the
     user-picker lists only same-company users.
  3. **Population on write:** `HostRepository.create`, `NotesRepository.create`
     and the backup-restore insert set `company_id` from the owner via subquery
     (no signature changes).
  4. **Anti-drift:** `UserRepository.setOrg` cascades the new `company_id` onto
     the user's owned hosts/notes, so a shared resource follows its owner when
     they change companies instead of remaining visible to the old tenant.
- **Reproduction (before) / verification (after):** integration test
  `backend/src/repos/tenantIsolation.itest.ts` creates Company A + B and users
  in each, shares a host/note in A, and asserts:
  - same-company user sees the shared host/note (list + `getById`);
  - **cross-company user does NOT** see it (list omits it; `getById` and `touch`
    raise `host_not_found` — a non-disclosing 404, not a 403);
  - moving the owner to Company B makes the shared host visible to B and hidden
    from A.
- **Tests added:** `tenantIsolation.itest.ts` (3 cases). **Test result:** PASS
  (3/3). Full integration suite **8/8**, unit suite **68/68**.
- **Regression risk:** Low–Medium. All existing host/note tests pass; the change
  is additive (new column, tightened predicate). Behaviour for a single-company
  install (the common case, all users in one company) is unchanged.
- **Data-migration note (per section 19):** existing rows are tagged with their
  current owner's company; post-012 every user has a company (seeded "Default"),
  so nothing is left unscoped in practice. No tenant is ever guessed/assigned
  randomly — `company_id` is derived from the owning user only.

---

## Systematic IDOR / BOLA sweep

Swept every by-id query in `backend/src/repos/*` and the routes that expose
`/:id`:

| Resource | Scoping | Verdict |
| --- | --- | --- |
| hosts, notes | owner **or** company-scoped shared (now) | FIXED |
| credentials + fields/totp/attachments | `user_id` (attachments chained via `credential_id AND user_id`) | OK — user-scoped |
| folders, tags | `id = $1 AND user_id = $2` | OK |
| vpn_profiles, vpn_servers, vpn_server_clients | `id AND user_id` / `id AND server_id` | OK |
| mfa_devices | `id AND user_id` | OK |
| ai_providers | route `guardOwn`: org → `companyId === caller.company AND ai:manage`; user → self; chat restricted to caller's `available` set | OK — company + RBAC scoped |
| users, roles, companies, org_units | admin routes gated by `requireRole`/`requirePermission` + `sameCompany`/super-admin scope; privilege-escalation guard on role grant | OK — RBAC + tenant scoped |

No additional cross-tenant or cross-user object-access hole was found beyond
SEC-003. Mutating routes are additionally gated by `requireWrite`
(`resources:write`).

---

## Phase 2 verification summary

| Check | Result |
| --- | --- |
| Migration 020 apply (real PG 16) | ✅ PASS (column + partial index + FK present) |
| Backend `tsc --noEmit` | ✅ PASS |
| Backend unit (`npm test`) | ✅ PASS (68/68) |
| Backend integration (`*.itest.ts`, real PG) | ✅ PASS (8/8, incl. 3 new tenant tests) |
| Cross-company GET/list/connect(touch) denied | ✅ verified |

No unresolved P0 remains. Cleared to proceed to Phase 3.
