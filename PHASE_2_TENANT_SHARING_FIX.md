# Phase 2 — AWM-SEC-015 Cross-company explicit sharing (P0)

**Status:** FIXED · **Tests:** TEST-TENANT-SHARE-001..008 PASS (integration, real PG)

## Root cause
`HostRepository.setShares` / `NotesRepository.setShares` inserted
`host_shares` / `note_shares` for any user UUID with no company check. The
Phase-2 (SEC-003) read scoping had only company-scoped the `is_shared = TRUE`
branch — the `EXISTS(host_shares … user_id=$viewer)` branch was **not**
company-scoped — so an explicit cross-company share bypassed tenant isolation
for both visibility and shared-host credential-backed connect.

## Fix (write validation + read scoping — defense in depth)
- **Write (`setShares`, host + notes):** load the resource's `company_id`, then
  require **every** recipient to satisfy `users.company_id IS NOT DISTINCT FROM
  resource.company_id`. If any recipient is foreign or missing, throw
  `cross_company_share` and roll back — **the entire operation is rejected, no
  partial share**. Host route maps it to 403; notes route propagates to the 403
  global handler.
- **Read (visibility predicate, `hosts.list/getById/touch`, `notes.list`):** the
  shared branch is now `(is_shared OR EXISTS(<shares>)) AND resource.company_id =
  (SELECT company_id FROM users WHERE id = viewer)`. So even a **stale**
  pre-existing cross-company share row is denied on read.

## Affected files
`repos/sessionRepos.ts`, `repos/notesRepo.ts`, `domain/session.ts`
(`CrossCompanyShare` error), `routes/sessionRoutes.ts`, `server.ts`
(`cross_company_share` → 403).

## Evidence
| Test | Assertion | Result |
| --- | --- | --- |
| SHARE-001 | host share → foreign user denied, nothing persisted | PASS |
| SHARE-002 | same-company host share succeeds | PASS |
| SHARE-003 | note share → foreign user denied | PASS |
| SHARE-004 | same-company note share succeeds | PASS |
| SHARE-005 | mixed [valid, foreign] → whole op denied, no partial | PASS |
| SHARE-006 | stale cross-company share row still denied on read (get/list/touch) | PASS |
| SHARE-007 | same-company recipient reads; foreign cannot | PASS |
| SHARE-008 | foreign user cannot reach shared-host credential path (getById denies) | PASS |

Full suite after phase: backend **73 unit / 25 integration**, tsc clean.

## Database hardening note
A DB-level invariant (a trigger/constraint asserting recipient tenant ==
resource tenant) was considered. Because `host_shares`/`note_shares` carry no
`company_id` of their own and would need a cross-table subquery, a CHECK
constraint is not expressible; the atomic application check inside the sharing
transaction (all-or-nothing) plus the company-scoped read predicate is the
enforced control. A trigger is recorded as an optional future addition.

## Regression risk
Medium. Same-company sharing verified still works (SHARE-002/004/007); full
suite green. Predicate change is a tightening (adds a company match), never a
relaxation.
