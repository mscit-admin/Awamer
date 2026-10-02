# Conditions Closure Matrix

| Condition | Previous State | Current State | Evidence | Go-Live Blocking? |
|---|---|---|---|---|
| Version consistency | Open (backend 1.8.0 / desktop+Tauri 1.7.0 / UI 1.0.0 / compose default 1.6.0.1) | **CLOSED.** Single release 1.8.0 across 9 declarations; the About and login screens show the real release; CI gate | `RELEASE_VERSION_EVIDENCE.md`; `check-release-version.mjs` PASS | No |
| DB least privilege | Open (backend, helper and migrations all superuser) | **CLOSED.** `awamer_migrator` / `awamer_app` / `awamer_vpn_auth`; separate migrate job; runtime refuses privileged roles; upgrade and restore paths | `DATABASE_PRIVILEGE_MATRIX.md`; DBLP-001…007; startup NEG-1/2; catalog dump | No |
| VPN helper hardening | Open | **CLOSED (practical).** Dedicated DB role (was superuser); NET_ADMIN only on the helper; no docker socket or privileged mode; secrets minimised; re-validation on the privileged side. Read-only rootfs for the helper deferred (OR-04) | `VPN_HELPER_SECURITY_BOUNDARY.md`; compose contract tests | No |
| russh advisory | Open (russh 0.45, RUSTSEC-2026-0153/0154) | **CLOSED.** russh 0.63.3; `cargo audit` no longer reports it; live OpenSSH test | `DEPENDENCY_FINAL_STATUS.md`; SSH-LIVE-001…008 | No |
| Docker build | Unverified | **BLOCKED BY ENVIRONMENT** for the final images. Every application layer verified in `node:20-alpine` under the real runtime restrictions | `DOCKER_BUILD_EVIDENCE.md` | **Yes, operationally**: build plus the on-target smoke test required before traffic (OR-01) |
| Smoke test | Required | **DONE.** 60/60 (native production build) and 60/60 (commit `4e5d4bd`, hardened container); 4/4 startup refusals; About screen captured | `FINAL_TEST_RESULTS.md`; `evidence/` | No (repeat on the final image: OR-01) |
| Audit monitoring | Conditional | **CLOSED.** `audit_write_failures_total` on `/readyz` (0 before/after smoke); alert rule `> 0` per interval documented | `PRODUCTION_CONFIGURATION.md` | No (set the alert at deployment) |
| API docs production | Required | **CLOSED.** Production refuses `ENABLE_API_DOCS`; Swagger never loaded; `/docs` 404; nginx does not proxy it | PROD-CFG-002; NEG-3; smoke | No |
| Release traceability | Required | **CLOSED.** `/api/v1/version` (version/commit/build date only); OCI labels; tag guard; SBOMs | `RELEASE_TRACEABILITY.md`; `sbom/` | No |
| (new) VPN certificate serial defect | Found this phase | **CLOSED.** About 1 in 650 issued certificates were unparseable by OpenSSL/OpenVPN; serials now minimal DER | PKI-SERIAL-001/002 | No |
| (new) CI security gate | Advisory only | **CLOSED.** Release gate, critical-audit gate, build, live SSH, images job; lint step unbroken | `.github/workflows/ci.yml` | No |
| (carried) Post-upgrade compromise review | security-final C-7 | **Open (operational)** | `REMAINING_OPERATIONAL_RISKS.md` OR-02 | Yes, for upgrades of an existing deployment |
